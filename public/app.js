import { BACKEND_OFFLINE_MESSAGE, api, isNetworkError, responseError } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { apiAuthHeaders, installApiTokenFromHash, readNdjsonStream, STREAM_AWARENESS_TIMEOUT_MS } from "./stream.js";
import { $, compactText, formatDuration, icon, setIcon } from "./ui.js";

installApiTokenFromHash();

const state = { data: null, streaming: false, composing: false, abortController: null, abortRequested: false, autoScroll: true, backendOffline: false, filePath: ".", cwdChoices: [], inspector: null };

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
      if (part && typeof part === "object" && typeof part.thinking === "string") return part.thinking;
      if (part && typeof part === "object" && typeof part.name === "string") {
        const details = shortJson(part.input ?? part.arguments ?? part.args);
        return details ? `[tool: ${part.name}] ${details}` : `[tool: ${part.name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isToolOnlyTreeContent(content) {
  if (!Array.isArray(content) || !content.length) return false;
  let hasTool = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim()) return false;
    if (typeof part.thinking === "string" && part.thinking.trim()) return false;
    if (typeof part.name === "string" && part.name) hasTool = true;
  }
  return hasTool;
}

function shouldShowTreeItem(item) {
  if (item.type !== "message" || !item.message) return false;
  const role = item.message.role || "assistant";
  if (role === "user") return true;
  if (role !== "assistant") return false;
  if (item.message.errorMessage || item.message.isError) return true;
  return !isToolOnlyTreeContent(item.message.content);
}

function treeItemText(item) {
  if (item.type !== "message" || !item.message) return item.type || "entry";
  const role = item.message.role || "assistant";
  const text = textOfTreeContent(item.message.content) || item.message.errorMessage || item.message.toolName || "";
  return `${role}: ${text}`.replace(/\s+/g, " ").trim();
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

function focusPrompt() {
  $("prompt")?.focus();
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

function setStreamingUi(streaming) {
  const send = $("send");
  setIcon(send, streaming ? "stop" : "send");
  send.title = streaming ? "Abort" : "Send";
  send.setAttribute("aria-label", streaming ? "Abort" : "Send");
}

function abortPrompt() {
  if (!state.streaming || !state.abortController) return;
  state.abortRequested = true;
  $("status").textContent = "Aborting…";
  state.abortController.abort();
}

function isNearChatBottom() {
  const chat = $("chat");
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

function scrollChatToBottom(force = false) {
  if (force || state.autoScroll) $("chat").scrollTop = $("chat").scrollHeight;
}

function renderState(data, opts = {}) {
  const chat = $("chat");
  const prevScrollTop = chat.scrollTop;
  const prevScrollHeight = chat.scrollHeight;
  updateChrome(data);
  chat.innerHTML = "";
  if (data.turns) renderChatTurns(data.turns, chat);
  else renderMessageRuns(data.messages || [], chat);
  if (opts.preserveScroll) {
    chat.scrollTop = prevScrollTop + (chat.scrollHeight - prevScrollHeight);
  } else {
    state.autoScroll = true;
    scrollChatToBottom(true);
  }
}

function renderChatTurns(turns, container) {
  for (const turn of turns) {
    if (turn.role === "user") addMessage(turn.message, { container });
    else addAssistantTurnFromParts(turn, { container });
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

function toolPreview(command, name) {
  return (command || "")
    .replace(new RegExp(`^[✓▶…]\\s*${name || ""}\\s*(queued|running|done|update)?\\s*`, "i"), "")
    .trim();
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

function turnParts(messages) {
  const parts = [];
  const pendingTools = [];
  for (const m of messages) {
    const text = messageText(m);
    if (m.role === "assistant") {
      for (const part of splitAssistantParts(text)) {
        part.error = part.error || Boolean(m.error || m.isError);
        parts.push(part);
        if (part.type === "tool") pendingTools.push(part);
      }
      continue;
    }

    const part = pendingTools.shift() || { type: "tool", name: m.toolName || m.role || "tool", call: "", results: [], error: false };
    if (!parts.includes(part)) parts.push(part);
    part.name = m.toolName || part.name;
    part.error = part.error || Boolean(m.error || m.isError);
    part.results.push(text || m.error || "(no output)");
  }
  return parts;
}

function addMessageAction(target, kind, label, iconName, onClick) {
  if (!target || !onClick) return;
  const actions = document.createElement("div");
  actions.className = `msg-actions ${kind}-actions`;
  const button = document.createElement("button");
  button.className = "msg-action";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName), label);
  button.onclick = onClick;
  actions.append(button);
  target.append(actions);
}

function addAssistantTurnFromParts(turn, opts = {}) {
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
  summaryText.className = "msg-summary";
  summaryText.textContent = compactText((turn.parts || []).map((part) => part.type === "text" ? part.text : `tool: ${part.name}`).join(" "));
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, summaryText, spacer, indicator);
  head.title = "Collapse/expand";
  head.onclick = () => {
    el.classList.toggle("collapsed");
    setIcon(indicator, el.classList.contains("collapsed") ? "chevron-down" : "chevron-up");
  };

  const body = document.createElement("div");
  body.className = "msg-body turn-body";
  for (const part of turn.parts || []) {
    if (part.type === "text") {
      if (!part.text) continue;
      const section = document.createElement("div");
      section.className = "turn-text";
      renderMarkdown(part.text, section);
      body.append(section);
      continue;
    }

    const tool = document.createElement("details");
    tool.className = `turn-tool ${part.error ? "error" : ""}`;
    const summary = document.createElement("summary");
    appendToolSummary(summary, part.name || "tool", part.call, part.name);
    const content = document.createElement("div");
    content.className = "turn-tool-body";
    const command = document.createElement("div");
    command.className = "turn-tool-command";
    command.textContent = part.call || part.name || "tool";
    const result = document.createElement("div");
    result.className = "turn-tool-result";
    result.textContent = part.results?.length ? part.results.join("\n\n") : "(no output)";
    content.append(command, result);
    tool.append(summary, content);
    body.append(tool);
  }
  if (!body.childElementCount) body.textContent = "";

  el.append(head, body);
  target.append(el);
  const forkEntry = ids[ids.length - 1];
  if (forkEntry) addMessageAction(target, "assistant", "Fork from here", "fork", () => doFork(forkEntry));
  if (target === $("chat")) scrollChatToBottom();
  return { el, body };
}

function addAssistantTurn(messages, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg assistant turn ${messages.some((m) => m.role === "assistant" && (m.error || m.isError)) ? "error" : ""}`;
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
  summaryText.className = "msg-summary";
  summaryText.textContent = assistantTurnSummary(messages);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, summaryText, spacer, indicator);
  head.title = "Collapse/expand";
  head.onclick = () => {
    el.classList.toggle("collapsed");
    setIcon(indicator, el.classList.contains("collapsed") ? "chevron-down" : "chevron-up");
  };

  const body = document.createElement("div");
  body.className = "msg-body turn-body";
  for (const part of turnParts(messages)) {
    if (part.type === "text") {
      const section = document.createElement("div");
      section.className = "turn-text";
      renderMarkdown(part.text, section);
      body.append(section);
      continue;
    }

    const tool = document.createElement("details");
    tool.className = `turn-tool ${part.error ? "error" : ""}`;
    const summary = document.createElement("summary");
    appendToolSummary(summary, part.name, part.call, part.name);
    const content = document.createElement("div");
    content.className = "turn-tool-body";
    const command = document.createElement("div");
    command.className = "turn-tool-command";
    command.textContent = part.call || part.name;
    const result = document.createElement("div");
    result.className = "turn-tool-result";
    result.textContent = part.results.length ? part.results.join("\n\n") : "(no output)";
    content.append(command, result);
    tool.append(summary, content);
    body.append(tool);
  }

  el.append(head, body);
  target.append(el);
  const forkEntry = [...messages].reverse().find((m) => m.id)?.id;
  if (forkEntry) addMessageAction(target, "assistant", "Fork from here", "fork", () => doFork(forkEntry));
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
  role.textContent = m.toolName ? `${m.role || "tool"}: ${m.toolName}` : (m.role || "assistant");
  const summaryText = document.createElement("span");
  summaryText.className = "msg-summary";
  summaryText.textContent = messageSummary(m);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(role, summaryText, spacer);
  if (canCollapse(m)) {
    const defaultCollapsed = m.role === "toolResult";
    if (defaultCollapsed) el.classList.add("collapsed");
    const indicator = document.createElement("span");
    indicator.className = "collapse-indicator";
    indicator.append(icon(defaultCollapsed ? "chevron-down" : "chevron-up"));
    head.append(indicator);
    head.title = "Collapse/expand";
    head.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      el.classList.toggle("collapsed");
      setIcon(indicator, el.classList.contains("collapsed") ? "chevron-down" : "chevron-up");
    };
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  renderMarkdown(messageText(m), body);
  if (opts.pending) {
    const p = document.createElement("span");
    p.className = "pending";
    p.textContent = " pending…";
    body.append(p);
  }
  el.append(head, body);
  target.append(el);
  if (m.role === "user" && m.id) addMessageAction(target, "user", "Edit from here", "navigate", () => doEditHere(m.id));
  if (m.role === "assistant" && m.id) addMessageAction(target, "assistant", "Fork from here", "fork", () => doFork(m.id));
  if (target === $("chat")) scrollChatToBottom();
  return { el, head, body };
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function markBackendOffline() {
  state.backendOffline = true;
  $("status").classList.add("backend-offline");
  $("status").textContent = BACKEND_OFFLINE_MESSAGE;
}

async function checkBackend() {
  if (state.streaming) return;
  try {
    const data = await api("/api/state");
    if (state.backendOffline) updateChrome(data);
    state.backendOffline = false;
  } catch (err) {
    markBackendOffline();
  }
}

async function runAction(action) {
  try {
    await action();
  } catch (err) {
    $("status").textContent = errorMessage(err);
  }
}

function flashStatus(message, kind = "notice") {
  const status = $("status");
  const className = kind === "error" ? "status-error" : "status-flash";
  status.textContent = message;
  status.classList.remove("status-flash", "status-error");
  void status.offsetWidth;
  status.classList.add(className);
  setTimeout(() => status.classList.remove(className), 1100);
}

function locateMessage(entryId) {
  if (!entryId) return;
  const chat = $("chat");
  const target = chat.querySelector(`[data-id="${CSS.escape(entryId)}"], [data-ids~="${CSS.escape(entryId)}"]`);
  chat.querySelectorAll(".located").forEach((el) => el.classList.remove("located"));
  if (!target) {
    flashStatus("Tree node is outside the active chat branch. Use Edit/Fork from a visible message to change branch/session.", "error");
    return;
  }
  target.classList.add("located");
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  setTimeout(() => target.classList.remove("located"), 1600);
}

function treeNodeButton(item) {
  const node = document.createElement("button");
  const textValue = treeItemText(item);
  node.type = "button";
  node.className = `tree-node ${item.active ? "active" : "off-branch"} ${item.current ? "current" : ""}`;
  node.title = textValue || item.id;
  node.onclick = () => locateMessage(item.id);
  const marker = document.createElement("span");
  marker.className = "tree-marker";
  marker.textContent = item.current ? "●" : (item.active ? "•" : "○");
  const text = document.createElement("span");
  text.className = "tree-text";
  text.textContent = textValue || item.id;
  const role = document.createElement("span");
  role.className = "tree-role";
  role.textContent = item.message?.role || item.type;
  const id = document.createElement("span");
  id.className = "tree-id";
  id.textContent = item.id;
  node.append(marker, text, role, id);
  return node;
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
    item.onclick = () => void runAction(() => switchCwd(cwd));
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

async function loadFiles(path = state.filePath) {
  const box = $("files");
  if (!box || !state.data?.cwd) return;
  box.textContent = "Loading…";
  box.className = "files file-empty";
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(path || ".")}`);
    state.filePath = data.relativePath || ".";
    box.className = "files";
    box.innerHTML = "";
    if (data.parentPath) {
      const up = document.createElement("button");
      up.className = "file-row";
      up.innerHTML = `<span class="file-name">../</span><span></span>`;
      up.onclick = () => void loadFiles(data.parentPath);
      box.append(up);
    }
    for (const entry of data.entries || []) {
      const row = document.createElement("button");
      row.className = "file-row";
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = `${entry.isDir ? "▸ " : ""}${entry.name}`;
      name.title = entry.relativePath;
      const mention = document.createElement("span");
      mention.className = "file-mention";
      mention.textContent = "@";
      row.append(name, mention);
      row.onclick = () => entry.isDir ? void loadFiles(entry.path) : insertPromptText(`\`${entry.relativePath}\``);
      mention.onclick = (ev) => {
        ev.stopPropagation();
        insertPromptText(`\`${entry.relativePath}\``);
      };
      box.append(row);
    }
    if (!box.childElementCount) {
      box.className = "files file-empty";
      box.textContent = "empty";
    }
  } catch (err) {
    box.className = "files file-empty";
    box.textContent = errorMessage(err);
  }
}

async function loadSessions() {
  const sessions = await api("/api/sessions");
  const box = $("sessions");
  box.innerHTML = "";
  const activeSessionPath = state.data?.sessionFile;
  for (const s of sessions) {
    const row = document.createElement("button");
    const isActive = activeSessionPath && s.path === activeSessionPath;
    row.className = `session ${isActive ? "selected" : ""}`;
    if (isActive) row.setAttribute("aria-current", "true");
    row.title = s.firstMessage || s.path;
    const main = document.createElement("span");
    main.className = "session-main";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.name || s.firstMessage || "(empty session)";
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `${s.messageCount} msg · ${new Date(s.modified).toLocaleString()}`;
    const cwd = document.createElement("div");
    cwd.className = "session-cwd";
    cwd.textContent = s.cwd || "";
    main.append(title, meta, cwd);
    const actions = document.createElement("span");
    actions.className = "session-actions";
    const rename = document.createElement("button");
    rename.className = "rename icon-button";
    rename.title = "Rename session";
    rename.setAttribute("aria-label", "Rename session");
    rename.textContent = "✎";
    rename.onclick = (ev) => {
      ev.stopPropagation();
      void runAction(async () => {
        const name = prompt("Session name", s.name || "");
        if (name === null) return;
        await api("/api/sessions", { method: "PATCH", body: JSON.stringify({ path: s.path, name }) });
        await refresh({ preserveScroll: true });
      });
    };
    const del = document.createElement("button");
    del.className = "delete icon-button";
    del.title = "Delete session";
    del.setAttribute("aria-label", "Delete session");
    del.append(icon("trash"));
    del.onclick = (ev) => {
      ev.stopPropagation();
      void runAction(async () => {
        if (!confirm("Delete this session?")) return;
        await api(`/api/sessions?path=${encodeURIComponent(s.path)}`, { method: "DELETE" });
        await refresh();
      });
    };
    actions.append(rename, del);
    row.append(main, actions);
    row.onclick = () => void runAction(async () => { renderState(await api("/api/sessions/open", { method: "POST", body: JSON.stringify({ path: s.path }) })); await updateSidebarData(); });
    box.append(row);
  }
}

function formatSessionPath(path) {
  if (!path) return { name: "", parent: "" };
  const parts = path.split(/[/\\]/);
  const name = parts[parts.length - 1] || "";
  const parent = parts[parts.length - 2] || "";
  return { name, parent };
}

function updateChrome(data) {
  const previousCwd = state.data?.cwd;
  state.data = data;
  if (previousCwd !== data.cwd) state.filePath = ".";
  $("cwd").value = data.cwd || "";
  const { name, parent } = formatSessionPath(data.sessionFile);
  $("status").classList.remove("backend-offline");
  $("status").textContent = data.sessionName || (parent ? `${parent}/${name}` : name || "new session");
  updateInspectorPanel(data);
}

async function updateSidebarData() {
  await Promise.all([loadSessions(), loadCwdOptions(), loadFiles()]);
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
    $("status").textContent = errorMessage(err);
    await refresh();
    return null;
  }
}

const doFork = (entryId) => sessionAction("/api/fork", entryId);
const doEditHere = async (entryId) => {
  const data = await sessionAction("/api/navigate-tree", entryId);
  if (typeof data?.navigation?.editorText === "string") insertPromptText(data.navigation.editorText, true);
};

async function sendPrompt(text) {
  state.streaming = true;
  state.abortRequested = false;
  state.autoScroll = true;
  setStreamingUi(true);
  addMessage({ role: "user", text });
  const assistant = addMessage({ role: "assistant", text: "waiting… (0s)" });
  assistant.body.classList.add("turn-body");
  const controller = new AbortController();
  state.abortController = controller;
  let output = "";
  const streamParts = [];
  let activeToolPart = null;
  let gotVisibleResponse = false;
  let streamWarningShown = false;
  let latestPromptState = null;
  let lastStreamEventAt = Date.now();
  const startTime = Date.now();
  const progressInterval = setInterval(() => {
    const now = Date.now();
    const idleMs = now - lastStreamEventAt;
    if (!gotVisibleResponse) {
      const elapsed = Math.floor((now - startTime) / 1000);
      assistant.body.textContent = `waiting… (${elapsed}s)`;
      if (idleMs > STREAM_AWARENESS_TIMEOUT_MS && !streamWarningShown) {
        streamWarningShown = true;
        $("status").textContent = `No visible response for ${formatDuration(idleMs)}; still waiting.`;
      }
      return;
    }
    if (activeToolPart && activeToolPart.phase !== "done") renderAssistant();
    if (idleMs > STREAM_AWARENESS_TIMEOUT_MS) {
      $("status").textContent = `No stream updates for ${formatDuration(idleMs)}; backend/tool may be stuck.`;
    }
  }, 1000);
  const appendTextDelta = (delta) => {
    output += delta;
    let part = streamParts[streamParts.length - 1];
    if (!part || part.type !== "text") {
      part = { type: "text", text: "" };
      streamParts.push(part);
    }
    part.text += delta;
  };
  const appendToolEvent = (evt) => {
    const name = evt.toolName || activeToolPart?.name || "tool";
    if (evt.phase === "done") $("status").textContent = `${name} done`;
    else $("status").textContent = `Running ${name}…`;
    if (!activeToolPart || activeToolPart.phase === "done") {
      activeToolPart = { type: "tool", name, phase: evt.phase || "running", startedAt: Date.now(), endedAt: null, command: "", messages: [], error: false };
      streamParts.push(activeToolPart);
    }
    activeToolPart.name = name;
    activeToolPart.phase = evt.phase || activeToolPart.phase || "running";
    if (activeToolPart.phase === "done" && !activeToolPart.endedAt) activeToolPart.endedAt = Date.now();
    activeToolPart.error = Boolean(evt.isError || activeToolPart.error);
    if (evt.message) {
      if (evt.phase === "queued" || evt.phase === "running") activeToolPart.command = evt.message;
      else activeToolPart.messages.push(evt.message);
    }
  };
  const renderAssistant = () => {
    assistant.body.textContent = "";
    for (const part of streamParts) {
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
      tool.className = `turn-tool ${part.error ? "error" : ""}`;
      tool.open = part.phase !== "done";
      const summary = document.createElement("summary");
      const duration = formatDuration((part.endedAt || Date.now()) - part.startedAt);
      const phaseText = part.phase === "done" ? `done in ${duration}` : `${part.phase || "running"} for ${duration}`;
      appendToolSummary(summary, `${part.name || "tool"} · ${phaseText}`, part.command, part.name);
      const content = document.createElement("div");
      content.className = "turn-tool-body";
      const command = document.createElement("div");
      command.className = "turn-tool-command";
      command.textContent = part.command || part.name || "tool";
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
        if (evt.state) {
          latestPromptState = evt.state;
          state.data = evt.state;
        }
      }
      if ((evt.type === "done" || evt.type === "state") && evt.state) {
        latestPromptState = evt.state;
        state.data = evt.state;
      }
      scrollChatToBottom();
    });
    if (!gotVisibleResponse && !output) {
      assistant.el.classList.add("error");
      assistant.body.textContent = "No response content received.";
    }
  } catch (err) {
    assistant.el.classList.add("error");
    const disconnected = !state.abortRequested && isNetworkError(err);
    assistant.body.textContent = state.abortRequested ? "Request aborted." : (disconnected ? BACKEND_OFFLINE_MESSAGE : errorMessage(err));
    if (disconnected) markBackendOffline();
  } finally {
    clearInterval(progressInterval);
    state.streaming = false;
    state.abortController = null;
    state.abortRequested = false;
    setStreamingUi(false);
    if (latestPromptState) {
      renderState(latestPromptState);
      await updateSidebarData().catch(() => markBackendOffline());
    } else {
      await syncStateWithoutRerender().catch(() => markBackendOffline());
    }
  }
}

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
  $("prompt").value = "";
  await sendPrompt(text);
};
$("prompt").addEventListener("compositionstart", () => state.composing = true);
$("prompt").addEventListener("compositionend", () => state.composing = false);
$("prompt").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !state.composing) {
    ev.preventDefault();
    $("promptForm").requestSubmit();
  }
});
async function switchCwd(nextCwd) {
  if (!nextCwd) return;
  $("cwdMenu").hidden = true;
  renderState(await api("/api/cwd", { method: "POST", body: JSON.stringify({ cwd: nextCwd }) }));
  await updateSidebarData();
}

$("cwdForm").onsubmit = (ev) => {
  ev.preventDefault();
  void runAction(() => switchCwd($("cwd").value));
};
$("cwd").onfocus = renderCwdMenu;
$("cwd").onblur = hideCwdMenuSoon;
$("cwd").oninput = renderCwdMenu;
$("newSession").onclick = () => void runAction(async () => { renderState(await api("/api/sessions/new", { method: "POST" })); await updateSidebarData(); focusPrompt(); });
function closeInspector() {
  const panel = $("systemPanel");
  state.inspector = null;
  panel.hidden = true;
  $("systemToggle").classList.remove("active");
  $("treeToggle").classList.remove("active");
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
  updateInspectorPanel();
}

$("systemToggle").onclick = () => toggleInspector("system");
$("treeToggle").onclick = () => toggleInspector("tree");
document.addEventListener("click", (ev) => {
  if ($("systemPanel").hidden) return;
  if (ev.target.closest("#systemPanel, #systemToggle, #treeToggle")) return;
  closeInspector();
});

setInterval(() => void checkBackend(), BACKEND_CHECK_INTERVAL_MS);

refresh().then(focusPrompt).catch((err) => { $("status").textContent = errorMessage(err); focusPrompt(); });
