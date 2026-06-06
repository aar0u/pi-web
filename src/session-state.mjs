function shortJson(value) {
  if (value === undefined) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolPartText(part) {
  const details = shortJson(part.input ?? part.arguments ?? part.args);
  return details ? `[tool: ${part.name}] ${details}` : `[tool: ${part.name}]`;
}

function bashExecutionText(message) {
  let text = `Ran \`${message.command || "bash"}\`\n`;
  text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
  if (message.cancelled) text += "\n\n(command cancelled)";
  else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) text += `\n\nCommand exited with code ${message.exitCode}`;
  if (message.truncated && message.fullOutputPath) text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  return text;
}

function messageText(message = {}) {
  if (message.role === "bashExecution") return bashExecutionText(message);
  if (typeof message.display === "string" && message.display) return message.display;
  if (typeof message.content === "string") return message.content;
  return textOfContent(message.content);
}

function isToolPart(part) {
  return part && typeof part === "object" && typeof part.name === "string";
}

function isThinkingPart(part) {
  if (!part || typeof part !== "object") return false;
  if (isToolPart(part)) return false;
  return (part.type === "thinking" || !("type" in part)) && typeof part.thinking === "string" && Boolean(part.thinking);
}

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && "name" in part && typeof part.name === "string") return toolPartText(part);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function systemPromptOf(session) {
  const state = session.agent?.state ?? session.state;
  return state && "systemPrompt" in state ? (state.systemPrompt ?? "") : null;
}

function modelPayload(model) {
  if (!model) return null;
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: model.contextWindow,
  };
}

function treeItems(roots, activeLeafId, activeIds) {
  const itemOf = (node) => {
    const entry = node.entry;
    return {
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      type: entry.type,
      message: entry.message,
      active: activeIds.has(entry.id),
      current: entry.id === activeLeafId,
      children: (node.children || []).map(itemOf),
    };
  };
  return roots.map(itemOf);
}

function contentBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (isToolPart(part)) {
      const input = part.input ?? part.arguments ?? part.args;
      blocks.push({ type: "tool", name: part.name, input, call: shortJson(input), results: [], error: false });
      continue;
    }
    if (isThinkingPart(part)) blocks.push({ type: "thinking", text: part.thinking, error: false });
  }
  return blocks;
}

function problemStopReason(reason) {
  return typeof reason === "string" && /abort|cancel|error|fail/i.test(reason);
}

function messageErrorDetail(message) {
  return message.errorMessage || (problemStopReason(message.stopReason) ? message.stopReason : "") || (message.isError ? "Error" : "");
}

function chatTurns(entries, toMessage) {
  const turns = [];
  let assistant = null;
  const pendingTools = [];
  const ensureAssistant = () => {
    if (!assistant) {
      assistant = { role: "assistant", ids: [], timestamp: null, blocks: [], error: false, errorDetail: "" };
      turns.push(assistant);
    }
    return assistant;
  };

  for (const entry of entries) {
    const message = entry.message;
    if (["user", "bashExecution", "custom"].includes(message.role)) {
      assistant = null;
      pendingTools.length = 0;
      turns.push({ role: message.role, message: toMessage(entry) });
      continue;
    }

    if (message.role === "assistant" && assistant?.error) {
      assistant = null;
      pendingTools.length = 0;
    }

    const turn = ensureAssistant();
    turn.ids.push(entry.id);
    if (!turn.timestamp) turn.timestamp = entry.timestamp;
    if (message.role === "assistant") {
      const detail = messageErrorDetail(message);
      turn.error = turn.error || Boolean(detail);
      if (detail && !turn.errorDetail) turn.errorDetail = detail;
      for (const block of contentBlocks(message.content)) {
        block.error = block.error || Boolean(detail);
        turn.blocks.push(block);
        if (block.type === "tool") pendingTools.push(block);
      }
      if (message.errorMessage && !turn.blocks.length) turn.blocks.push({ type: "text", text: message.errorMessage });
      continue;
    }

    const block = pendingTools.shift() || { type: "tool", name: message.toolName || message.role || "tool", call: "", results: [], error: false };
    if (!turn.blocks.includes(block)) turn.blocks.push(block);
    block.name = message.toolName || block.name;
    const detail = messageErrorDetail(message);
    block.error = block.error || Boolean(detail);
    block.results.push(textOfContent(message.content) || message.errorMessage || "(no output)");
  }

  for (const turn of turns) {
    if (turn.role === "assistant" && !turn.blocks.length) turn.blocks.push({ type: "text", text: "" });
  }
  return turns;
}

export function sessionPayload(runtime) {
  const session = runtime.session;
  const sm = session.sessionManager;
  const activeBranch = sm.getBranch();
  const activeLeafId = sm.getLeafId?.() ?? activeBranch[activeBranch.length - 1]?.id ?? null;
  const activeEntries = activeBranch.filter((entry) => entry.type === "message" && entry.message);
  const activeIds = new Set(activeBranch.map((entry) => entry.id));
  const toMessage = (entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    role: entry.message?.role ?? "assistant",
    text: messageText(entry.message),
    error: entry.message?.errorMessage,
    errorDetail: messageErrorDetail(entry.message ?? {}),
    stopReason: entry.message?.stopReason,
    toolName: entry.message?.toolName,
    isError: entry.message?.isError,
  });

  const roots = sm.getTree();

  return {
    cwd: runtime.cwd,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    sessionName: sm.getSessionName?.(),
    leafId: activeLeafId,
    isStreaming: session.isStreaming,
    model: modelPayload(session.model),
    thinkingLevel: session.thinkingLevel,
    stats: session.getSessionStats?.() ?? null,
    systemPrompt: systemPromptOf(session),
    messages: activeEntries.map((entry) => toMessage(entry)),
    turns: chatTurns(activeEntries, toMessage),
    tree: treeItems(roots, activeLeafId, activeIds),
  };
}

