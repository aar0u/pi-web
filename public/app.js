import { BACKEND_OFFLINE_MESSAGE, api, isNetworkError, responseError } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { apiAuthHeaders, installApiTokenFromHash, readNdjsonStream, STREAM_AWARENESS_TIMEOUT_MS } from "./stream.js";
import { createFileSidebar } from "./sidebar-files.js";
import { createSessionSidebar } from "./sidebar-sessions.js";
import { $, compactText, compactUserRequest, formatDuration, icon, setIcon } from "./ui.js";

installApiTokenFromHash();

const state = { data: null, streaming: false, composing: false, abortController: null, abortRequested: false, autoScroll: true, backendOffline: false, filePath: ".", cwdChoices: [], slashCommands: [], slashIndex: 0, inspector: null, status: { persistent: null, flash: null }, detailFoldOverrides: new Map() };
let loadFiles;
let loadSessions;

const BACKEND_CHECK_INTERVAL_MS = 5_000;

function messageText(m) {
  if (m.error) return m.error;
  if (m.text) return m.text;
  return m.role === "assistant" ? "waiting…" : "";
}

function shortJson(value) {
  if (value === undefined) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textOfTreeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && typeof part.name === "string") {
        const details = shortJson(part.input ?? part.arguments ?? part.args);
        return details ? `[tool: ${part.name}] ${details}` : `[tool: ${part.name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isInternalOnlyTreeContent(content) {
  if (!Array.isArray(content) || !content.length) return false;
  let hasInternal = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim()) return false;
    if ((typeof part.thinking === "string" && part.thinking.trim()) || (typeof part.name === "string" && part.name)) hasInternal = true;
  }
  return hasInternal;
}

function shouldShowTreeItem(item) {
  if (item.type !== "message" || !item.message) return false;
  const role = item.message.role || "assistant";
  if (role === "user") return true;
  if (role !== "assistant") return false;
  if (item.message.errorMessage || item.message.isError) return true;
  return !isInternalOnlyTreeContent(item.message.content);
}

function treeItemText(item) {
  if (item.type !== "message" || !item.message) return item.type || "entry";
  const text = textOfTreeContent(item.message.content) || item.message.errorMessage || item.message.toolName || "";
  return text.replace(/\s+/g, " ").trim();
}

function canCollapse(m) {
  return m.role === "user" || m.role === "assistant" || m.role === "toolResult" || m.role === "bashExecution" || m.role === "custom";
}

function messageSummary(m) {
  return compactText(messageText(m));
}

function assistantTurnSummary(messages) {
  const text = messages
    .map((m) => messageText(m))
    .join(" ")
    .replace(/^\s*\[tool: ([^\]]+)\].*$/gm, "tool: $1");
  return compactText(text);
}

function messageErrorDetail(m) {
  if (!m) return "";
  if (!m.errorDetail && !m.error && !m.isError) return "";
  return compactText(m.errorDetail || m.error || "Error");
}

function assistantTurnErrorDetail(messages) {
  return messageErrorDetail(messages.find((m) => m.role === "assistant" && messageErrorDetail(m)));
}

function setHeaderDetail(head, detail) {
  const text = compactText(detail);
  if (!text) return;
  const existing = head.querySelector(".msg-summary, .msg-detail");
  const detailEl = existing || document.createElement("span");
  detailEl.className = "msg-detail";
  detailEl.textContent = text;
  if (!existing) head.insertBefore(detailEl, head.children[1] || null);
}

function focusPrompt() {
  $("prompt")?.focus();
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function insertPromptText(text, replace = false) {
  const prompt = $("prompt");
  if (!prompt) return;
  if (replace) {
    prompt.value = text;
  } else {
    const prefix = prompt.value && !/\s$/.test(prompt.value) ? " " : "";
    prompt.value += `${prefix}${text}`;
  }
  prompt.focus();
  prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
}

function installComposerResize() {
  const handle = $("composerResize");
  const prompt = $("prompt");
  if (!handle || !prompt) return;

  const minHeight = () => Number.parseFloat(getComputedStyle(prompt).minHeight) || 84;
  const maxHeight = () => Math.round(window.innerHeight * 0.52);
  const setPromptHeight = (height) => {
    const nextHeight = Math.min(maxHeight(), Math.max(minHeight(), height));
    prompt.style.setProperty("--prompt-height", `${nextHeight}px`);
    handle.setAttribute("aria-valuenow", String(Math.round(nextHeight)));
  };

  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    const startY = ev.clientY;
    const startHeight = prompt.getBoundingClientRect().height;

    const resize = (moveEv) => setPromptHeight(startHeight + startY - moveEv.clientY);
    const stop = () => {
      handle.removeEventListener("pointermove", resize);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };

    handle.addEventListener("pointermove", resize);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });

  handle.addEventListener("keydown", (ev) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(ev.key)) return;
    ev.preventDefault();
    const currentHeight = prompt.getBoundingClientRect().height;
    const step = ev.shiftKey ? 40 : 12;
    if (ev.key === "Home") setPromptHeight(minHeight());
    else if (ev.key === "End") setPromptHeight(maxHeight());
    else setPromptHeight(currentHeight + (ev.key === "ArrowUp" ? step : -step));
  });
}

function setStreamingUi(streaming) {
  const send = $("send");
  setIcon(send, streaming ? "stop" : "send");
  send.title = streaming ? "Abort" : "Send";
  send.setAttribute("aria-label", streaming ? "Abort" : "Send");
}

function abortPrompt() {
  if (!state.streaming || !state.abortController) return;
  state.abortRequested = true;
  setStatus("Aborting…", "warning", { busy: true });
  state.abortController.abort();
}

function isNearChatBottom() {
  const chat = $("chat");
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

function scrollChatToBottom(force = false) {
  if (force || state.autoScroll) $("chat").scrollTop = $("chat").scrollHeight;
}

function messageFoldKey(el) {
  return el.dataset.ids || el.dataset.id || "";
}

function turnBlockFoldKey(ids, index) {
  return ids?.length ? `${ids.join(" ")}::${index}` : "";
}

// Folding defaults live here so the three render paths stay consistent:
// - message: standalone/legacy chat entries such as toolResult or bashExecution.
// - turn block: finalized assistant transcript blocks inside one response box.
// - stream part: temporary frontend-only blocks while a response is streaming.
// Live streaming tools are open until done so users can see active work; finalized tools are closed.
function defaultMessageCollapsed(message) {
  return message.role === "toolResult" || message.role === "bashExecution";
}

function defaultTurnBlockOpen() {
  return false;
}

function defaultStreamPartOpen(part) {
  return part.phase !== "done";
}

function setDetailsFoldState(el, key, defaultOpen, overrides = state.detailFoldOverrides) {
  if (key) el.dataset.foldKey = key;
  el.open = key && overrides?.has(key) ? overrides.get(key) : defaultOpen;
}

function rememberDetailsFoldState(el, key, overrides = state.detailFoldOverrides) {
  if (key && overrides) overrides.set(key, el.open);
}

function trackDetailsFoldState(summary, details, key, overrides) {
  const remember = () => requestAnimationFrame(() => rememberDetailsFoldState(details, key, overrides));
  summary.addEventListener("click", (ev) => {
    if (!(ev.target instanceof Element && ev.target.closest("button"))) remember();
  });
  summary.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") remember();
  });
}

function foldingState() {
  const messages = new Map();
  const details = new Map(state.detailFoldOverrides);
  for (const el of $("chat").querySelectorAll(".msg")) {
    const key = messageFoldKey(el);
    if (key) messages.set(key, el.classList.contains("collapsed"));
  }
  return { messages, details };
}

function restoreFoldingState(folding) {
  if (!folding) return;
  for (const el of $("chat").querySelectorAll(".msg")) {
    const key = messageFoldKey(el);
    if (key && folding.messages.has(key)) setMessageCollapsed(el, folding.messages.get(key));
  }
  state.detailFoldOverrides = new Map(folding.details);
  for (const el of $("chat").querySelectorAll("details[data-fold-key]")) {
    setDetailsFoldState(el, el.dataset.foldKey, el.open, folding.details);
  }
}

function renderState(data, opts = {}) {
  const chat = $("chat");
  const prevScrollTop = chat.scrollTop;
  const prevScrollHeight = chat.scrollHeight;
  const collapsed = opts.preserveFolding ? foldingState() : null;
  if (!opts.preserveFolding) state.detailFoldOverrides = new Map();
  updateChrome(data);
  chat.innerHTML = "";
  if (data.turns) renderChatTurns(data.turns, chat);
  else renderMessageRuns(data.messages || [], chat);
  restoreFoldingState(collapsed);
  updateResponsesFoldToggle();
  if (opts.preserveScroll) {
    chat.scrollTop = prevScrollTop + (chat.scrollHeight - prevScrollHeight);
  } else {
    state.autoScroll = true;
    scrollChatToBottom(true);
  }
}

function renderChatTurns(turns, container) {
  for (const turn of turns) {
    if (turn.role === "assistant") addAssistantTurnFromBlocks(turn, { container });
    else addMessage(turn.message, { container });
  }
}

function renderMessageRuns(messages, container) {
  let assistantRun = [];
  const flushAssistant = () => {
    if (!assistantRun.length) return;
    addAssistantTurn(assistantRun, { container });
    assistantRun = [];
  };
  for (const m of messages) {
    if (m.role === "user") {
      flushAssistant();
      addMessage(m, { container });
    } else {
      assistantRun.push(m);
    }
  }
  flushAssistant();
}

function splitAssistantParts(text) {
  const parts = [];
  const re = /^\s*\[tool: ([^\]]+)\](?:\s+([^\n]+))?\s*$/gm;
  let last = 0;
  let match;
  while ((match = re.exec(text || ""))) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "tool", name: match[1], call: match[2] || match[0].trim(), results: [], error: false });
    last = match.index + match[0].length;
  }
  const rest = (text || "").slice(last).trim();
  if (rest) parts.push({ type: "text", text: rest });
  return parts;
}

function thinkingPreview(text) {
  const firstLine = String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
  return firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^__(.*?)__$/, "$1")
    .trim();
}

function toolPreview(command, name) {
  return (command || "")
    .replace(new RegExp(`^[✓▶…]\\s*${name || ""}\\s*(queued|running|done|update)?\\s*`, "i"), "")
    .trim();
}

function blockCommandText(block) {
  if (block?.type === "thinking") return thinkingPreview(block.text) || "thinking";
  return block?.call || block?.name || "tool";
}

function blockResultText(block) {
  if (block?.type === "thinking") return block.text || "";
  return block?.results?.length ? block.results.join("\n\n") : "(no output)";
}

function blockSummaryText(block) {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return "thinking";
  return `tool: ${block.name || "tool"}`;
}

function appendToolSummary(summary, label, command, name) {
  const title = document.createElement("span");
  title.className = "turn-tool-name";
  title.textContent = label;
  const preview = document.createElement("span");
  preview.className = "turn-tool-preview";
  preview.textContent = toolPreview(command, name);
  preview.title = preview.textContent;
  summary.append(title, preview);
}

function legacyTurnBlocks(messages) {
  const blocks = [];
  const pendingTools = [];
  for (const m of messages) {
    const text = messageText(m);
    if (m.role === "assistant") {
      const detail = messageErrorDetail(m);
      for (const block of splitAssistantParts(text)) {
        block.error = block.error || Boolean(detail);
        blocks.push(block);
        if (block.type === "tool") pendingTools.push(block);
      }
      continue;
    }

    const block = pendingTools.shift() || { type: "tool", name: m.toolName || m.role || "tool", call: "", results: [], error: false };
    if (!blocks.includes(block)) blocks.push(block);
    block.name = m.toolName || block.name;
    block.error = block.error || Boolean(messageErrorDetail(m));
    block.results.push(text || m.error || "(no output)");
  }
  return blocks;
}

function setMessageCollapsed(el, collapsed) {
  el.classList.toggle("collapsed", collapsed);
  const indicator = el.firstElementChild?.querySelector(".collapse-indicator");
  if (indicator) setIcon(indicator, collapsed ? "chevron-down" : "chevron-up");
}

function updateResponsesFoldToggle() {
  const button = $("responsesFoldToggle");
  const responses = [...$("chat").querySelectorAll(".msg.assistant")];
  const canFold = responses.some((el) => !el.classList.contains("collapsed"));
  button.disabled = !responses.length;
  button.textContent = canFold || !responses.length ? "Fold" : "Unfold";
  button.title = canFold || !responses.length ? "Fold all responses" : "Unfold all responses";
}

function toggleAllResponses() {
  const responses = [...$("chat").querySelectorAll(".msg.assistant")];
  if (!responses.length) return;
  const collapse = responses.some((el) => !el.classList.contains("collapsed"));
  for (const el of responses) setMessageCollapsed(el, collapse);
  updateResponsesFoldToggle();
}

function messageActions(target, kind) {
  if (!target) return null;
  let actions = target.nextElementSibling?.matches?.(`.msg-actions.${kind}-actions`) ? target.nextElementSibling : null;
  if (!actions) {
    actions = document.createElement("div");
    actions.className = `msg-actions ${kind}-actions`;
    target.insertAdjacentElement("afterend", actions);
  }
  return actions;
}

function addMessageAction(target, kind, label, iconName, onClick) {
  if (!target || !onClick) return;
  const actions = messageActions(target, kind);
  const button = document.createElement("button");
  button.className = "msg-action";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  if (iconName) button.append(icon(iconName), label);
  else button.textContent = label;
  button.onclick = (ev) => {
    ev.stopPropagation();
    onClick(ev);
  };
  actions.append(button);
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatMessageTime(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function addMessageTime(target, kind, timestamp) {
  const text = formatMessageTime(timestamp);
  if (!text) return;
  const actions = messageActions(target, kind);
  const existing = actions.querySelector(".msg-time");
  if (existing) existing.remove();
  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = text;
  time.title = String(timestamp);
  actions.append(time);
}

function debugContext() {
  return {
    sessionId: state.data?.sessionId || null,
    sessionName: state.data?.sessionName || null,
    leafId: state.data?.leafId || null,
    cwd: state.data?.cwd || null,
    sessionFile: state.data?.sessionFile || null,
    model: state.data?.model || null,
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    flashStatus("Debug info copied");
  } catch (err) {
    flashStatus(errorMessage(err), "error");
  }
}

function showDebugInspector(title, payload) {
  const panel = $("systemPanel");
  const debugInfo = JSON.stringify({ title, timestamp: new Date().toISOString(), context: debugContext(), ...payload }, null, 2);
  state.inspector = "debug";
  panel.hidden = false;
  panel.classList.remove("empty");
  $("systemToggle").classList.remove("active");
  $("treeToggle").classList.remove("active");
  panel.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "debug-toolbar";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.onclick = () => void copyText(debugInfo);
  toolbar.append(heading, copy);

  const pre = document.createElement("pre");
  pre.className = "debug-json";
  pre.textContent = debugInfo;
  panel.append(toolbar, pre);
  panel.scrollTop = 0;
}

function addToolInspect(summary, title, data) {
  const inspect = document.createElement("button");
  inspect.className = "tool-inspect";
  inspect.type = "button";
  inspect.textContent = "Inspect";
  inspect.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showDebugInspector(title, data);
  };
  summary.append(inspect);
}

function showRequestInspector(title, text) {
  const panel = $("systemPanel");
  state.inspector = "request";
  panel.hidden = false;
  panel.classList.remove("empty");
  $("systemToggle").classList.remove("active");
  $("treeToggle").classList.remove("active");
  panel.textContent = `${title}\n\n${text}`;
  panel.scrollTop = 0;
}

function renderUserRequest(body, text) {
  const compact = compactUserRequest(text, state.slashCommands);
  if (!compact) {
    renderMarkdown(text, body);
    return;
  }

  const meta = document.createElement("div");
  meta.className = "request-meta";
  const chip = document.createElement("span");
  chip.className = "request-chip";
  chip.textContent = compact.command;
  const view = document.createElement("button");
  view.className = "request-view";
  view.type = "button";
  view.textContent = "View expanded request";
  view.onclick = (ev) => {
    ev.stopPropagation();
    showRequestInspector(compact.command, compact.hiddenText);
  };
  meta.append(chip, view);
  body.append(meta);

  if (compact.visibleText) renderMarkdown(compact.visibleText, body);
}

function renderTurnBlock(block, body, ids, index) {
  if (block.type === "text") {
    if (!block.text) return;
    const section = document.createElement("div");
    section.className = "turn-text";
    renderMarkdown(block.text, section);
    body.append(section);
    return;
  }

  const tool = document.createElement("details");
  tool.className = `${block.type === "thinking" ? "turn-thinking" : "turn-tool"} ${block.error ? "error" : ""}`;
  const foldKey = turnBlockFoldKey(ids, index);
  setDetailsFoldState(tool, foldKey, defaultTurnBlockOpen(block));
  const summary = document.createElement("summary");
  trackDetailsFoldState(summary, tool, foldKey);
  const label = block.type === "thinking" ? "thinking" : (block.name || "tool");
  appendToolSummary(summary, label, blockCommandText(block), block.name || block.type);
  addToolInspect(summary, `${block.type === "thinking" ? "Thinking" : "Tool"}: ${label}`, { type: block.type, ids, block });
  const content = document.createElement("div");
  content.className = "turn-tool-body";
  const command = document.createElement("div");
  command.className = "turn-tool-command";
  command.textContent = blockCommandText(block);
  const result = document.createElement("div");
  result.className = "turn-tool-result";
  result.textContent = blockResultText(block);
  content.append(command, result);
  tool.append(summary, content);
  body.append(tool);
}

function addAssistantTurnFromBlocks(turn, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg assistant turn ${turn.error ? "error" : ""}`;
  const ids = turn.ids || [];
  if (ids.length) {
    el.dataset.id = ids[ids.length - 1];
    el.dataset.ids = ids.join(" ");
  }
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = "assistant";
  const summaryText = document.createElement("span");
  const detail = turn.errorDetail || turn.detail || "";
  summaryText.className = detail ? "msg-detail" : "msg-summary";
  const blocks = turn.blocks || turn.parts || [];
  summaryText.textContent = detail ? compactText(detail) : compactText(blocks.map(blockSummaryText).join(" "));
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, summaryText, spacer, indicator);
  head.title = "Collapse/expand";
  head.onclick = () => {
    setMessageCollapsed(el, !el.classList.contains("collapsed"));
    updateResponsesFoldToggle();
  };

  const body = document.createElement("div");
  body.className = "msg-body turn-body";
  blocks.forEach((block, index) => renderTurnBlock(block, body, ids, index));
  if (!body.childElementCount) body.textContent = "";

  el.append(head, body);
  target.append(el);
  const forkEntry = ids[ids.length - 1];
  if (forkEntry) addMessageAction(el, "assistant", "Fork from here", "fork", () => doFork(forkEntry));
  addMessageAction(el, "assistant", "Inspect", null, () => showDebugInspector("Assistant response", { type: "assistant-turn", ids, turn }));
  addMessageTime(el, "assistant", turn.timestamp);
  if (target === $("chat")) scrollChatToBottom();
  return { el, body };
}

function addAssistantTurn(messages, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg assistant turn ${assistantTurnErrorDetail(messages) ? "error" : ""}`;
  const ids = messages.map((m) => m.id).filter(Boolean);
  if (ids.length) {
    el.dataset.id = ids[ids.length - 1];
    el.dataset.ids = ids.join(" ");
  }
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = "assistant";
  const summaryText = document.createElement("span");
  const detail = assistantTurnErrorDetail(messages);
  summaryText.className = detail ? "msg-detail" : "msg-summary";
  summaryText.textContent = detail || assistantTurnSummary(messages);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, summaryText, spacer, indicator);
  head.title = "Collapse/expand";
  head.onclick = () => {
    setMessageCollapsed(el, !el.classList.contains("collapsed"));
    updateResponsesFoldToggle();
  };

  const body = document.createElement("div");
  body.className = "msg-body turn-body";
  legacyTurnBlocks(messages).forEach((block, index) => renderTurnBlock(block, body, ids, index));

  el.append(head, body);
  target.append(el);
  const forkEntry = [...messages].reverse().find((m) => m.id)?.id;
  if (forkEntry) addMessageAction(el, "assistant", "Fork from here", "fork", () => doFork(forkEntry));
  addMessageAction(el, "assistant", "Inspect", null, () => showDebugInspector("Assistant response", { type: "assistant-run", ids, messages }));
  addMessageTime(el, "assistant", messages.find((m) => m.timestamp)?.timestamp);
  if (target === $("chat")) scrollChatToBottom();
  return { el, body };
}

function addMessage(m, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg ${m.role || "assistant"} ${m.error || m.isError ? "error" : ""}`;
  el.dataset.id = m.id || "";
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  const roleLabel = m.role === "bashExecution" ? "shell" : (m.role || "assistant");
  role.textContent = m.toolName ? `${roleLabel}: ${m.toolName}` : roleLabel;
  const summaryText = document.createElement("span");
  const detail = messageErrorDetail(m);
  const userRequest = m.role === "user" ? compactUserRequest(messageText(m), state.slashCommands) : null;
  summaryText.className = detail ? "msg-detail" : "msg-summary";
  summaryText.textContent = detail || (userRequest ? compactText([userRequest.command, userRequest.visibleText].filter(Boolean).join(" ")) : messageSummary(m));
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(role, summaryText, spacer);
  if (canCollapse(m)) {
    const defaultCollapsed = defaultMessageCollapsed(m);
    if (defaultCollapsed) el.classList.add("collapsed");
    const indicator = document.createElement("span");
    indicator.className = "collapse-indicator";
    indicator.append(icon(defaultCollapsed ? "chevron-down" : "chevron-up"));
    head.append(indicator);
    head.title = "Collapse/expand";
    head.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      setMessageCollapsed(el, !el.classList.contains("collapsed"));
      updateResponsesFoldToggle();
    };
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  if (m.role === "user") renderUserRequest(body, messageText(m));
  else renderMarkdown(messageText(m), body);
  if (opts.pending) {
    const p = document.createElement("span");
    p.className = "pending";
    p.textContent = " pending…";
    body.append(p);
  }
  el.append(head, body);
  target.append(el);
  if (m.role === "user" && m.id) addMessageAction(el, "user", "Edit from here", "navigate", () => doEditHere(m.id));
  if (m.role === "assistant" && m.id) addMessageAction(el, "assistant", "Fork from here", "fork", () => doFork(m.id));
  if (opts.inspect !== false) addMessageAction(el, m.role || "assistant", "Inspect", null, () => showDebugInspector("Message", { type: "message", message: m }));
  addMessageTime(el, m.role || "assistant", m.timestamp);
  if (target === $("chat")) {
    updateResponsesFoldToggle();
    scrollChatToBottom();
  }
  return { el, head, body };
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function formatCount(value) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function formatCost(value) {
  return Number.isFinite(value) && value > 0 ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : "";
}

function contextStatusText(contextUsage) {
  if (!contextUsage) return "context ?";
  const windowText = formatCount(contextUsage.contextWindow);
  if (contextUsage.tokens === null || contextUsage.tokens === undefined) return `context ?/${windowText}`;
  const percent = Number.isFinite(contextUsage.percent) ? ` ${Math.round(contextUsage.percent)}%` : "";
  return `context ${formatCount(contextUsage.tokens)}/${windowText}${percent}`;
}

function updatePromptStatus(data = state.data) {
  const status = $("promptStatus");
  if (!status) return;
  status.innerHTML = "";
  if (!data) return;

  const addItem = (kind, text, title = text) => {
    if (!text) return;
    const item = document.createElement("span");
    item.className = `composer-status-item ${kind}`;
    item.textContent = text;
    item.title = title;
    status.append(item);
  };

  const stats = data.stats || {};
  const tokens = stats.tokens || {};
  const contextUsage = stats.contextUsage || (data.model?.contextWindow ? { tokens: null, contextWindow: data.model.contextWindow, percent: null } : null);
  addItem("model", data.model?.id || data.model?.name || "model ?", data.model?.provider ? `${data.model.provider}: ${data.model.id}` : undefined);
  addItem("context", contextStatusText(contextUsage));
  addItem("messages", `${stats.totalMessages ?? (data.messages?.length ?? 0)} msg`);

  const tokenText = [tokens.input ? `in ${formatCount(tokens.input)}` : "", tokens.output ? `out ${formatCount(tokens.output)}` : "", tokens.cacheRead ? `cache ${formatCount(tokens.cacheRead)}` : ""].filter(Boolean).join(" / ");
  addItem("tokens", tokenText);
  addItem("cost", formatCost(stats.cost));
  if (data.thinkingLevel && data.thinkingLevel !== "off") addItem("thinking", `thinking ${data.thinkingLevel}`);
  addItem("error", stats.error ? `stats error` : "", stats.error);

  status.title = [...status.children].map((el) => el.title || el.textContent).filter(Boolean).join(" · ");
}

const STATUS_CLASSES = ["status-busy", "status-flash", "status-notice", "status-warning", "status-error"];

function renderStatus() {
  const status = $("status");
  const current = state.status.flash || state.status.persistent;
  status.classList.remove(...STATUS_CLASSES, "backend-offline");
  if (!current) {
    status.textContent = state.data?.sessionId || "new session";
    return;
  }

  status.textContent = current.message;
  status.classList.add(`status-${current.kind || "notice"}`);
  if (current.busy) status.classList.add("status-busy");
  if (current.backendOffline) status.classList.add("backend-offline");
}

function clearStatus(token) {
  if (!token || state.status.persistent?.token === token) {
    state.status.persistent = null;
    renderStatus();
  }
}

function setStatus(message, kind = "notice", opts = {}) {
  const token = Symbol("status");
  state.status.persistent = { message, kind, busy: Boolean(opts.busy), backendOffline: Boolean(opts.backendOffline), token };
  renderStatus();
  return token;
}

function markBackendOffline() {
  state.backendOffline = true;
  setStatus(BACKEND_OFFLINE_MESSAGE, "error", { backendOffline: true });
}

function stateFingerprint(data) {
  const messages = data?.messages || [];
  const last = messages[messages.length - 1] || null;
  return [data?.sessionFile || "", data?.leafId || "", messages.length, last?.id || "", last?.timestamp || ""].join("|");
}

async function checkBackend() {
  if (state.streaming) return;
  try {
    const data = await api("/api/state");
    const wasOffline = state.backendOffline;
    const changed = stateFingerprint(data) !== stateFingerprint(state.data);
    state.backendOffline = false;
    await loadSessions().catch(() => {});
    if (changed) {
      renderState(data, { preserveFolding: true, preserveScroll: !state.autoScroll });
      return;
    }
    if (wasOffline) updateChrome(data);
  } catch (err) {
    markBackendOffline();
  }
}

async function runAction(action, message = "Working…") {
  const token = setStatus(message, "warning", { busy: true });
  try {
    await action();
  } catch (err) {
    flashStatus(errorMessage(err), "error");
  } finally {
    clearStatus(token);
  }
}

function flashStatus(message, kind = "notice") {
  const token = Symbol("status-flash");
  state.status.flash = { message, kind, token };
  renderStatus();
  const status = $("status");
  void status.offsetWidth;
  status.classList.add("status-flash");
  setTimeout(() => {
    if (state.status.flash?.token !== token) return;
    state.status.flash = null;
    renderStatus();
  }, 1100);
}

function locateMessage(entryId) {
  if (!entryId) return false;
  const chat = $("chat");
  const target = chat.querySelector(`[data-id="${CSS.escape(entryId)}"], [data-ids~="${CSS.escape(entryId)}"]`);
  chat.querySelectorAll(".located").forEach((el) => el.classList.remove("located"));
  if (!target) return false;
  target.classList.add("located");
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  setTimeout(() => target.classList.remove("located"), 1600);
  return true;
}

function locateTreeItem(item) {
  if (!item?.id) return;
  if (item.active && locateMessage(item.id)) return;
  flashStatus("This tree node is off the active chat path. Use Fork to open it without rewinding the current session.", "warning");
}

function treeNodeButton(item) {
  const row = document.createElement("div");
  row.className = "tree-row";

  const node = document.createElement("button");
  const textValue = treeItemText(item);
  node.type = "button";
  node.className = `tree-node ${item.active ? "active" : "off-branch"} ${item.current ? "current" : ""}`;
  node.title = textValue || item.id;
  node.onclick = () => locateTreeItem(item);
  const marker = document.createElement("span");
  marker.className = `tree-marker ${item.message?.role || "entry"}`;
  marker.title = item.message?.role || item.type || "entry";
  marker.textContent = item.current ? "●" : (item.message?.role === "user" ? "→" : "");
  const text = document.createElement("span");
  text.className = "tree-text";
  text.textContent = textValue || item.id;
  const id = document.createElement("span");
  id.className = "tree-id";
  id.textContent = item.id;
  node.append(marker, text, id);
  row.append(node);

  if (item.message?.role === "assistant") {
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    const fork = document.createElement("button");
    fork.className = "tree-action";
    fork.type = "button";
    fork.title = "Fork from here";
    fork.setAttribute("aria-label", "Fork from here");
    fork.append(icon("fork"));
    fork.onclick = () => void doFork(item.id);
    actions.append(fork);
    row.append(actions);
  }

  return row;
}

function hasVisibleTreeItem(item) {
  if (shouldShowTreeItem(item)) return true;
  return (item.children || []).some(hasVisibleTreeItem);
}

function visibleChildBranches(item) {
  return (item.children || []).filter(hasVisibleTreeItem);
}

function appendTreeItem(container, item) {
  const visible = shouldShowTreeItem(item);
  const childBranches = visibleChildBranches(item);
  let childContainer = container;
  if (visible) {
    const group = document.createElement("div");
    group.className = "tree-group";
    group.append(treeNodeButton(item));
    if (childBranches.length > 1) {
      childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      group.append(childContainer);
    }
    container.append(group);
  }
  for (const child of childBranches) appendTreeItem(childContainer, child);
}

async function renderTasksPanel() {
  const panel = $("systemPanel");
  panel.innerHTML = "Loading tasks…";
  panel.classList.add("empty");
  try {
    const data = await api("/api/tasks");
    panel.classList.remove("empty");
    panel.innerHTML = "";
    const root = document.createElement("div");
    root.className = "tasks-view";

    const hint = document.createElement("div");
    hint.className = "small";
    hint.textContent = "Create tasks from chat with /schedule, then manage them here.";
    root.append(hint);

    if (!data.tasks?.length) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.textContent = "No scheduled tasks yet.";
      root.append(empty);
    }

    for (const task of data.tasks || []) {
      const row = document.createElement("div");
      row.className = "task-row";
      const head = document.createElement("div");
      head.className = "task-head";
      const id = document.createElement("span");
      id.className = "task-id";
      id.textContent = task.id;
      const status = document.createElement("span");
      status.className = "task-status";
      status.textContent = `${task.confirmed ? task.status : "pending"} · ${task.cron}`;
      head.append(id, status);
      const promptText = document.createElement("div");
      promptText.className = "task-prompt";
      promptText.textContent = task.prompt;
      const meta = document.createElement("div");
      meta.className = "task-meta";
      meta.textContent = `session ${task.sessionName || task.sessionId || "unbound"} · next ${task.nextRunAt || "—"} · last ${task.lastRunAt || "—"}${task.lastResult?.summary ? ` · ${task.lastResult.summary}` : ""}`;
      const actions = document.createElement("div");
      actions.className = "task-actions";
      const patch = (body) => api("/api/tasks", { method: "PATCH", body: JSON.stringify({ id: task.id, ...body }) });
      const actionButton = (label, fn) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.onclick = async () => { await fn(); await renderTasksPanel(); };
        return button;
      };
      if (task.confirmed) {
        actions.append(actionButton(task.status === "enabled" ? "Disable" : "Enable", () => patch({ status: task.status === "enabled" ? "disabled" : "enabled" })));
      } else {
        actions.append(actionButton("Confirm", () => patch({ confirmed: true, status: "enabled" })));
      }
      actions.append(actionButton("Delete", () => api(`/api/tasks?id=${encodeURIComponent(task.id)}`, { method: "DELETE" })));
      row.append(head, promptText, meta, actions);
      root.append(row);
    }
    panel.append(root);
  } catch (err) {
    panel.classList.add("empty");
    panel.textContent = errorMessage(err);
  }
}

function renderTreePanel(data = state.data) {
  const panel = $("systemPanel");
  panel.innerHTML = "";
  const items = data?.tree || [];
  panel.classList.toggle("empty", !items.length);
  if (!items.length) {
    panel.textContent = "No tree entries yet.";
    return;
  }

  const tree = document.createElement("div");
  tree.className = "tree-view";
  for (const item of items) appendTreeItem(tree, item);
  if (!tree.querySelector(".tree-node")) {
    panel.textContent = "No message nodes in this tree.";
  } else {
    panel.append(tree);
    tree.querySelector(".tree-node.current")?.scrollIntoView({ block: "center" });
  }
}

function updateInspectorPanel(data = state.data) {
  const panel = $("systemPanel");
  if (!panel || panel.hidden) return;
  if (state.inspector === "tree") {
    renderTreePanel(data);
    return;
  }
  if (state.inspector === "tasks") {
    void renderTasksPanel();
    return;
  }
  if (state.inspector === "request" || state.inspector === "debug") return;
  const prompt = data?.systemPrompt;
  panel.classList.toggle("empty", !prompt);
  panel.textContent = prompt || (prompt === "" ? "System prompt is empty." : "Send a message to load the system prompt.");
  panel.scrollTop = 0;
}

function renderCwdMenu() {
  const menu = $("cwdMenu");
  if (!menu) return;
  menu.innerHTML = "";
  for (const cwd of state.cwdChoices) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = cwd;
    item.title = cwd;
    item.onclick = () => void runAction(() => switchCwd(cwd), "Switching directory…");
    menu.append(item);
  }
  menu.hidden = !state.cwdChoices.length;
}

function hideCwdMenuSoon() {
  setTimeout(() => {
    const active = document.activeElement;
    if (active?.closest?.("#cwdForm")) return;
    $("cwdMenu").hidden = true;
  }, 120);
}

async function loadCwdOptions() {
  state.cwdChoices = await api("/api/cwds");
  if (!$("cwdMenu")?.hidden) renderCwdMenu();
}

async function loadSlashCommands() {
  const commands = await api("/api/commands");
  state.slashCommands = [
    { name: "schedule", description: "Create a scheduled task from natural language", source: "pi-hub" },
    ...commands.filter((command) => command.name !== "schedule"),
  ];
  renderSlashMenu();
}

function slashQuery() {
  const prompt = $("prompt");
  const beforeCursor = prompt.value.slice(0, prompt.selectionStart ?? prompt.value.length);
  const match = beforeCursor.match(/^\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

function slashMatches() {
  const query = slashQuery();
  if (query === null) return [];
  return state.slashCommands
    .filter((command) => command.name.toLowerCase().includes(query))
    .slice(0, 12);
}

function insertSlashCommand(command) {
  const prompt = $("prompt");
  prompt.value = `/${command.name} `;
  prompt.focus();
  prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
  hideSlashMenu();
}

function hideSlashMenu() {
  const menu = $("slashMenu");
  if (menu) menu.hidden = true;
}

function renderSlashMenu() {
  const menu = $("slashMenu");
  if (!menu) return;
  const matches = slashMatches();
  state.slashIndex = Math.min(state.slashIndex, Math.max(0, matches.length - 1));
  menu.innerHTML = "";
  for (const [index, command] of matches.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = index === state.slashIndex ? "active" : "";
    item.title = command.description || command.name;
    item.onmousedown = (ev) => ev.preventDefault();
    item.onclick = () => insertSlashCommand(command);

    const name = document.createElement("span");
    name.className = "slash-name";
    name.textContent = `/${command.name}`;

    const desc = document.createElement("span");
    desc.className = "slash-desc";
    desc.textContent = command.description || "";

    const source = document.createElement("span");
    source.className = "slash-source";
    source.textContent = command.source || "";

    item.append(name, desc, source);
    menu.append(item);
  }
  menu.hidden = !matches.length;
}

function moveSlashSelection(delta) {
  const matches = slashMatches();
  if (!matches.length) return;
  state.slashIndex = (state.slashIndex + delta + matches.length) % matches.length;
  renderSlashMenu();
}

function acceptSlashSelection() {
  const command = slashMatches()[state.slashIndex];
  if (command) insertSlashCommand(command);
}

function updateChrome(data) {
  const previousCwd = state.data?.cwd;
  state.data = data;
  if (previousCwd !== data.cwd) state.filePath = ".";
  $("cwd").value = data.cwd || "";
  if (!state.backendOffline) state.status.persistent = null;
  renderStatus();
  updatePromptStatus(data);
  updateInspectorPanel(data);
}

async function updateSidebarData(opts = {}) {
  const tasks = [loadSessions(), loadCwdOptions(), loadSlashCommands()];
  if (opts.loadFiles !== false) tasks.push(loadFiles());
  await Promise.all(tasks);
}

async function refresh(opts = {}) {
  renderState(await api("/api/state"), opts);
  await updateSidebarData();
}

async function syncStateWithoutRerender() {
  updateChrome(await api("/api/state"));
  await updateSidebarData();
}

async function sessionAction(endpoint, entryId) {
  try {
    const data = await api(endpoint, { method: "POST", body: JSON.stringify({ entryId }) });
    renderState(data);
    await updateSidebarData();
    return data;
  } catch (err) {
    flashStatus(errorMessage(err), "error");
    await refresh();
    return null;
  }
}

const doFork = (entryId) => sessionAction("/api/fork", entryId);
const doEditHere = async (entryId) => {
  const data = await sessionAction("/api/navigate-tree", entryId);
  if (typeof data?.navigation?.editorText === "string") insertPromptText(data.navigation.editorText, true);
};

loadFiles = createFileSidebar({ state, api, $, errorMessage, insertPromptText });
loadSessions = createSessionSidebar({ state, api, $, icon, runAction, refresh, renderState, updateSidebarData });

function scheduleRequestText(text) {
  const match = text.match(/^\/schedule\s+([\s\S]+)$/i);
  return match?.[1]?.trim() || "";
}

function unsupportedSlashCommand(text) {
  if (!text.startsWith("/")) return false;
  const name = text.match(/^\/([^\s]+)/)?.[1]?.toLowerCase();
  if (!name) return false;
  return !state.slashCommands.some((command) => command.name.toLowerCase() === name);
}

async function sendScheduleRequest(text) {
  state.streaming = true;
  state.abortRequested = false;
  setStreamingUi(true);
  const token = setStatus("Asking pi to create a scheduled task…", "warning", { busy: true });
  try {
    const result = await api("/api/tasks", { method: "POST", body: JSON.stringify({ text }) });
    if (result.state) renderState(result.state, { preserveFolding: true });
    if (result.task) flashStatus("pi created a pending task. Confirm it in Tasks to enable.", "notice");
    else flashStatus(result.proposal?.question || "pi needs more information.", "warning");
    await updateSidebarData();
  } catch (err) {
    flashStatus(errorMessage(err), "error");
    await syncStateWithoutRerender().catch(() => markBackendOffline());
  } finally {
    clearStatus(token);
    state.streaming = false;
    setStreamingUi(false);
  }
}

function waitingText(startedAt = Date.now()) {
  const dots = ".".repeat((Math.floor((Date.now() - startedAt) / 500) % 3) + 1);
  return `waiting ${dots}`;
}

async function sendPrompt(text) {
  state.streaming = true;
  state.abortRequested = false;
  state.autoScroll = true;
  setStreamingUi(true);
  addMessage({ role: "user", text });
  const startTime = Date.now();
  const assistant = addMessage({ role: "assistant", text: waitingText(startTime) }, { inspect: false });
  assistant.el.classList.add("streaming-waiting");
  addMessageAction(assistant.el, "assistant", "Inspect stream", null, () => showDebugInspector("Streaming response", { type: "streaming-response", output, streamParts }));
  assistant.body.classList.add("turn-body");
  const controller = new AbortController();
  state.abortController = controller;
  let output = "";
  const streamParts = [];
  const streamDetails = new Map();
  let activeToolPart = null;
  let gotVisibleResponse = false;
  let streamWarningShown = false;
  let latestPromptState = null;
  let lastStreamEventAt = Date.now();
  const progressInterval = setInterval(() => {
    const idleMs = Date.now() - lastStreamEventAt;
    if (!gotVisibleResponse) {
      assistant.body.textContent = waitingText(startTime);
      if (idleMs > STREAM_AWARENESS_TIMEOUT_MS && !streamWarningShown) {
        streamWarningShown = true;
        setStatus("No visible response yet; still waiting.", "warning");
      }
      return;
    }
    if (activeToolPart && activeToolPart.phase !== "done") renderAssistant();
    if (idleMs > STREAM_AWARENESS_TIMEOUT_MS) {
      setStatus("No stream updates; backend/tool may be stuck.", "warning");
    }
  }, 500);
  const appendTextDelta = (delta) => {
    if (activeToolPart?.type === "thinking" && activeToolPart.phase !== "done") {
      activeToolPart.phase = "done";
      activeToolPart.endedAt = Date.now();
      activeToolPart = null;
    }
    output += delta;
    let part = streamParts[streamParts.length - 1];
    if (!part || part.type !== "text") {
      part = { type: "text", text: "" };
      streamParts.push(part);
    }
    part.text += delta;
  };
  const appendToolEvent = (evt) => {
    if (evt.phase === "queued" && !evt.toolName) return;
    const name = evt.toolName || activeToolPart?.name || "tool";
    const blockType = name === "thinking" ? "thinking" : "tool";
    if (!activeToolPart || activeToolPart.phase === "done" || activeToolPart.type !== blockType || (evt.toolName && activeToolPart.name !== evt.toolName)) {
      activeToolPart = { type: blockType, name, phase: evt.phase || "running", createdAt: Date.now(), startedAt: null, endedAt: null, command: "", messages: [], error: false };
      streamParts.push(activeToolPart);
    }
    activeToolPart.name = name;
    if (evt.phase !== "update") activeToolPart.phase = evt.phase || activeToolPart.phase || "running";
    if (["queued", "running"].includes(activeToolPart.phase) && evt.phase === "update") activeToolPart.phase = "running";
    if (activeToolPart.phase === "running" && !activeToolPart.startedAt) activeToolPart.startedAt = Date.now();
    if (activeToolPart.phase === "done" && !activeToolPart.endedAt) activeToolPart.endedAt = Date.now();
    activeToolPart.error = Boolean(evt.isError || activeToolPart.error);
    if (evt.message) {
      if (evt.phase === "queued" || evt.phase === "running") activeToolPart.command = evt.message;
      else if (activeToolPart.type === "thinking") activeToolPart.messages[0] = `${activeToolPart.messages[0] || ""}${evt.message}`;
      else activeToolPart.messages.push(evt.message);
      if (activeToolPart.type === "thinking") activeToolPart.command = thinkingPreview(activeToolPart.messages[0] || "") || activeToolPart.command;
    }
  };
  const renderAssistant = () => {
    assistant.body.textContent = "";
    for (const [index, part] of streamParts.entries()) {
      if (part.type === "text") {
        const visibleText = splitAssistantParts(part.text)
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n\n");
        if (!visibleText) continue;
        const text = document.createElement("div");
        text.className = "turn-text";
        renderMarkdown(visibleText, text);
        assistant.body.append(text);
        continue;
      }

      const tool = document.createElement("details");
      tool.className = `${part.type === "thinking" ? "turn-thinking" : "turn-tool"} ${part.error ? "error" : ""}`;
      const foldKey = `stream:${index}`;
      setDetailsFoldState(tool, foldKey, defaultStreamPartOpen(part), streamDetails);
      const summary = document.createElement("summary");
      trackDetailsFoldState(summary, tool, foldKey, streamDetails);
      let phaseText = "queued";
      if (part.phase === "done") phaseText = formatDuration((part.endedAt || Date.now()) - (part.startedAt || part.createdAt));
      else if (part.phase === "running") phaseText = `running ${formatDuration(Date.now() - (part.startedAt || part.createdAt))}`;
      const label = part.type === "thinking" ? "thinking" : (part.name || "tool");
      appendToolSummary(summary, `${label} · ${phaseText}`, part.command, part.name);
      addToolInspect(summary, `${part.type === "thinking" ? "Thinking" : "Tool"}: ${label}`, { type: `streaming-${part.type}`, part });
      const content = document.createElement("div");
      content.className = "turn-tool-body";
      const command = document.createElement("div");
      command.className = "turn-tool-command";
      command.textContent = part.type === "thinking" ? (part.command || thinkingPreview(part.messages.join("")) || "thinking") : (part.command || part.name || "tool");
      const result = document.createElement("div");
      result.className = "turn-tool-result";
      result.textContent = part.messages.length ? part.messages.join("\n\n") : (part.phase === "done" ? "(no output)" : "running…");
      content.append(command, result);
      tool.append(summary, content);
      assistant.body.append(tool);
    }
    if (!assistant.body.childElementCount) assistant.body.textContent = activeToolPart ? "working…" : "waiting…";
  };
  const markVisible = () => {
    gotVisibleResponse = true;
    assistant.el.classList.remove("streaming-waiting");
  };
  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", ...apiAuthHeaders() },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw await responseError(res);
    await readNdjsonStream(res, (evt) => {
      lastStreamEventAt = Date.now();
      if (evt.type === "ping") return;
      if (evt.type === "delta") {
        markVisible();
        appendTextDelta(evt.delta || "");
        renderAssistant();
      }
      if (evt.type === "tool") {
        markVisible();
        appendToolEvent(evt);
        renderAssistant();
      }
      if (evt.type === "error") {
        markVisible();
        assistant.el.classList.add("error");
        assistant.body.textContent = evt.message || "Unknown error";
        setHeaderDetail(assistant.head, assistant.body.textContent);
        if (evt.state) {
          latestPromptState = evt.state;
          state.data = evt.state;
        }
      }
      if (evt.type === "done" || evt.type === "state") {
        if (activeToolPart && activeToolPart.phase !== "done") {
          activeToolPart.phase = "done";
          activeToolPart.endedAt = Date.now();
          activeToolPart = null;
          renderAssistant();
        }
        if (evt.state) {
          latestPromptState = evt.state;
          state.data = evt.state;
        }
      }
      scrollChatToBottom();
    });
    if (!gotVisibleResponse && !output) {
      assistant.el.classList.add("error");
      assistant.body.textContent = "No response content received.";
      setHeaderDetail(assistant.head, assistant.body.textContent);
    }
  } catch (err) {
    assistant.el.classList.add("error");
    const disconnected = !state.abortRequested && isNetworkError(err);
    assistant.body.textContent = state.abortRequested ? "Request aborted." : (disconnected ? BACKEND_OFFLINE_MESSAGE : errorMessage(err));
    setHeaderDetail(assistant.head, assistant.body.textContent);
    if (disconnected) markBackendOffline();
  } finally {
    clearInterval(progressInterval);
    state.streaming = false;
    state.abortController = null;
    state.abortRequested = false;
    setStreamingUi(false);
    if (latestPromptState) {
      renderState(latestPromptState, { preserveFolding: true });
      await updateSidebarData().catch(() => markBackendOffline());
    } else {
      await syncStateWithoutRerender().catch(() => markBackendOffline());
    }
  }
}

installComposerResize();

$("chat").addEventListener("scroll", () => {
  state.autoScroll = isNearChatBottom();
});

$("promptForm").onsubmit = async (ev) => {
  ev.preventDefault();
  if (state.streaming) {
    abortPrompt();
    return;
  }
  const text = $("prompt").value.trim();
  if (!text) return;
  hideSlashMenu();
  $("prompt").value = "";
  const scheduleText = scheduleRequestText(text);
  if (scheduleText) await sendScheduleRequest(scheduleText);
  else if (/^\/schedule\b/i.test(text)) flashStatus("Usage: /schedule <request>", "warning");
  else if (unsupportedSlashCommand(text)) flashStatus("Unsupported command.", "warning");
  else await sendPrompt(text);
};
$("prompt").addEventListener("compositionstart", () => state.composing = true);
$("prompt").addEventListener("compositionend", () => state.composing = false);
$("prompt").addEventListener("keydown", (ev) => {
  if (!$("slashMenu").hidden && (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Tab")) {
    ev.preventDefault();
    if (ev.key === "Tab") acceptSlashSelection();
    else moveSlashSelection(ev.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (!$("slashMenu").hidden && ev.key === "Escape") {
    ev.preventDefault();
    hideSlashMenu();
    return;
  }
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !state.composing) {
    ev.preventDefault();
    $("promptForm").requestSubmit();
  }
});
$("prompt").addEventListener("input", () => {
  state.slashIndex = 0;
  renderSlashMenu();
});
$("prompt").addEventListener("click", renderSlashMenu);
$("prompt").addEventListener("blur", () => setTimeout(hideSlashMenu, 120));
document.addEventListener("keydown", (ev) => {
  const isFocusShortcut = ev.key === "/" && (ev.metaKey || ev.ctrlKey) && !ev.altKey;
  if (!isFocusShortcut || isEditableTarget(ev.target)) return;
  ev.preventDefault();
  focusPrompt();
});
async function switchCwd(nextCwd) {
  if (!nextCwd) return;
  $("cwdMenu").hidden = true;
  const data = await api("/api/cwd", { method: "POST", body: JSON.stringify({ cwd: nextCwd }) });
  renderState(data);
  if (data.cwdCreated) flashStatus(`Created directory: ${data.cwd}`, "notice");
  await updateSidebarData();
}

function submitCwdSwitch() {
  void runAction(() => switchCwd($("cwd").value), "Switching directory…");
}

$("cwdForm").onsubmit = (ev) => {
  ev.preventDefault();
  submitCwdSwitch();
};
$("cwd").onfocus = renderCwdMenu;
$("cwd").onblur = hideCwdMenuSoon;
$("cwd").oninput = renderCwdMenu;
$("newSession").onclick = () => void runAction(async () => { renderState(await api("/api/sessions/new", { method: "POST" })); await updateSidebarData(); focusPrompt(); }, "Creating session…");
function closeInspector() {
  const panel = $("systemPanel");
  state.inspector = null;
  panel.hidden = true;
  $("systemToggle").classList.remove("active");
  $("treeToggle").classList.remove("active");
  $("tasksToggle").classList.remove("active");
}

function toggleInspector(kind) {
  const panel = $("systemPanel");
  const nextHidden = state.inspector === kind && !panel.hidden;
  if (nextHidden) {
    closeInspector();
    return;
  }
  state.inspector = kind;
  panel.hidden = false;
  $("systemToggle").classList.toggle("active", kind === "system");
  $("treeToggle").classList.toggle("active", kind === "tree");
  $("tasksToggle").classList.toggle("active", kind === "tasks");
  updateInspectorPanel();
}

$("responsesFoldToggle").onclick = toggleAllResponses;
$("systemToggle").onclick = () => toggleInspector("system");
$("treeToggle").onclick = () => toggleInspector("tree");
$("tasksToggle").onclick = () => toggleInspector("tasks");
document.addEventListener("click", (ev) => {
  if ($("systemPanel").hidden) return;
  if (ev.target.closest("#systemPanel, #responsesFoldToggle, #systemToggle, #treeToggle, #tasksToggle")) return;
  closeInspector();
});

setInterval(() => void checkBackend(), BACKEND_CHECK_INTERVAL_MS);

refresh().catch((err) => { flashStatus(errorMessage(err), "error"); });
