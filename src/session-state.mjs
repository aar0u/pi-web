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

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && "thinking" in part && typeof part.thinking === "string") return part.thinking;
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

function contentParts(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text) parts.push({ type: "text", text: part.text });
    else if (typeof part.thinking === "string" && part.thinking) parts.push({ type: "text", text: part.thinking });
    else if (typeof part.name === "string") {
      const details = shortJson(part.input ?? part.arguments ?? part.args);
      parts.push({ type: "tool", name: part.name, call: details, results: [], error: false });
    }
  }
  return parts;
}

function chatTurns(entries, toMessage) {
  const turns = [];
  let assistant = null;
  const pendingTools = [];
  const ensureAssistant = () => {
    if (!assistant) {
      assistant = { role: "assistant", ids: [], parts: [], error: false };
      turns.push(assistant);
    }
    return assistant;
  };

  for (const entry of entries) {
    const message = entry.message;
    if (message.role === "user") {
      assistant = null;
      pendingTools.length = 0;
      turns.push({ role: "user", message: toMessage(entry) });
      continue;
    }

    if (message.role === "assistant" && assistant?.error) {
      assistant = null;
      pendingTools.length = 0;
    }

    const turn = ensureAssistant();
    turn.ids.push(entry.id);
    if (message.role === "assistant") {
      turn.error = turn.error || Boolean(message.errorMessage || message.isError);
      for (const part of contentParts(message.content)) {
        part.error = part.error || Boolean(message.errorMessage || message.isError);
        turn.parts.push(part);
        if (part.type === "tool") pendingTools.push(part);
      }
      if (message.errorMessage && !turn.parts.length) turn.parts.push({ type: "text", text: message.errorMessage });
      continue;
    }

    const part = pendingTools.shift() || { type: "tool", name: message.toolName || message.role || "tool", call: "", results: [], error: false };
    if (!turn.parts.includes(part)) turn.parts.push(part);
    part.name = message.toolName || part.name;
    part.error = part.error || Boolean(message.errorMessage || message.isError);
    part.results.push(textOfContent(message.content) || message.errorMessage || "(no output)");
  }

  for (const turn of turns) {
    if (turn.role === "assistant" && !turn.parts.length) turn.parts.push({ type: "text", text: "" });
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
    text: textOfContent(entry.message?.content),
    error: entry.message?.errorMessage,
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
    systemPrompt: systemPromptOf(session),
    messages: activeEntries.map((entry) => toMessage(entry)),
    turns: chatTurns(activeEntries, toMessage),
    tree: treeItems(roots, activeLeafId, activeIds),
  };
}

