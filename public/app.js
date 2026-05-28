function renderMarkdown(text, container) {
  let last = 0;
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.append(new Text(text.slice(last, m.index)));
    const pre = document.createElement("pre");
    pre.className = "code-block";
    const code = document.createElement("code");
    code.textContent = m[2];
    if (m[1]) code.className = `language-${m[1]}`;
    if (window.hljs) hljs.highlightElement(code);
    pre.append(code);
    if (m[1]) {
      const lang = document.createElement("span");
      lang.className = "code-lang";
      lang.textContent = m[1];
      pre.append(lang);
    }
    const copy = document.createElement("button");
    copy.className = "code-copy";
    copy.textContent = "Copy";
    copy.onclick = () => {
      navigator.clipboard.writeText(code.textContent);
      copy.textContent = "Copied!";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    pre.append(copy);
    container.append(pre);
    last = m.index + m[0].length;
  }
  if (last < text.length) container.append(new Text(text.slice(last)));
}

const $ = (id) => document.getElementById(id);
const BACKEND_OFFLINE_MESSAGE = "Backend disconnected. Restart it, then refresh if this does not recover.";
const state = { scope: "current", data: null, streaming: false, composing: false, abortController: null, abortRequested: false, autoScroll: true, backendOffline: false };

function isNetworkError(err) {
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError");
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
  } catch (err) {
    if (isNetworkError(err)) throw new Error(BACKEND_OFFLINE_MESSAGE);
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

const STREAM_AWARENESS_TIMEOUT_MS = 45_000;
const BACKEND_CHECK_INTERVAL_MS = 5_000;

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function setIcon(el, name) {
  const use = el.querySelector("use");
  if (use) use.setAttribute("href", `#icon-${name}`);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function messageText(m) {
  if (m.error) return m.error;
  if (m.text) return m.text;
  return m.role === "assistant" ? "waiting…" : "";
}

function canCollapse(m) {
  return m.role === "assistant" || m.role === "toolResult" || m.role === "bashExecution" || m.role === "custom";
}

function focusPrompt() {
  $("prompt")?.focus();
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
  if (data.timeline) {
    renderTimeline(data.timeline);
  } else {
    for (const m of data.messages || []) addMessage(m);
    if ((data.staleMessages || []).length) addStaleGroup(data.staleMessages);
  }
  if (opts.preserveScroll) {
    chat.scrollTop = prevScrollTop + (chat.scrollHeight - prevScrollHeight);
  } else {
    state.autoScroll = true;
    scrollChatToBottom(true);
  }
}

function renderTimeline(timeline) {
  let staleRun = [];
  let assistantRun = [];
  const flushAssistant = () => {
    if (!assistantRun.length) return;
    addAssistantTurn(assistantRun);
    assistantRun = [];
  };
  const flushStale = () => {
    if (!staleRun.length) return;
    flushAssistant();
    addStaleGroup(staleRun);
    staleRun = [];
  };
  for (const m of timeline) {
    if (m.stale) {
      staleRun.push(m);
      continue;
    }
    flushStale();
    if (m.role === "user") {
      flushAssistant();
      addMessage(m);
    } else {
      assistantRun.push(m);
    }
  }
  flushStale();
  flushAssistant();
}

function splitAssistantParts(text) {
  const parts = [];
  const re = /^\s*\[tool: ([^\]]+)\]\s*$/gm;
  let last = 0;
  let match;
  while ((match = re.exec(text || ""))) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "tool", name: match[1], call: match[0].trim(), results: [], error: false });
    last = match.index + match[0].length;
  }
  const rest = (text || "").slice(last).trim();
  if (rest) parts.push({ type: "text", text: rest });
  return parts;
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

function addAssistantTurn(messages, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg assistant turn ${messages.some((m) => m.error || m.isError) ? "error" : ""}`;
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = "assistant";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-up"));
  head.append(role, spacer, indicator);
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
    summary.textContent = part.name;
    const content = document.createElement("div");
    content.className = "turn-tool-body";
    const result = document.createElement("div");
    result.className = "turn-tool-result";
    result.textContent = part.results.length ? part.results.join("\n\n") : "(no output)";
    content.append(result);
    tool.append(summary, content);
    body.append(tool);
  }

  el.append(head, body);
  target.append(el);
  if (target === $("chat")) scrollChatToBottom();
  return { el, body };
}

function addMessage(m, opts = {}) {
  const target = opts.container || $("chat");
  const el = document.createElement("article");
  el.className = `msg ${m.role || "assistant"} ${m.stale ? "stale" : ""} ${m.error || m.isError ? "error" : ""}`;
  el.dataset.id = m.id || "";
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = document.createElement("span");
  role.textContent = m.toolName ? `${m.role || "tool"}: ${m.toolName}` : (m.role || "assistant");
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(role, spacer);
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
  if (m.role === "user" && m.id) {
    const rewind = document.createElement("button");
    rewind.className = "icon-button";
    rewind.title = "Rewind to this request";
    rewind.setAttribute("aria-label", "Rewind to this request");
    rewind.append(icon("rewind"));
    rewind.onclick = () => doRewind(m.id);
    const fork = document.createElement("button");
    fork.className = "icon-button";
    fork.title = "Fork from this request";
    fork.setAttribute("aria-label", "Fork from this request");
    fork.append(icon("fork"));
    fork.onclick = () => doFork(m.id);
    head.append(rewind, fork);
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
  if (target === $("chat")) scrollChatToBottom();
  return { el, head, body };
}

function addStaleGroup(messages) {
  const group = document.createElement("section");
  group.className = "stale-group collapsed";
  const head = document.createElement("div");
  head.className = "stale-head";
  const count = document.createElement("span");
  const first = messages.find((m) => m.role === "user") || messages[0];
  const label = first?.text ? `: ${first.text.replace(/\s+/g, " ").slice(0, 60)}` : "";
  count.textContent = `rewound/fork branch (${messages.length})${label}`;
  const hint = document.createElement("span");
  hint.className = "small";
  hint.textContent = "greyed, click to recover/fork";
  const indicator = document.createElement("span");
  indicator.className = "collapse-indicator";
  indicator.append(icon("chevron-down"));
  head.append(count, hint, indicator);
  const body = document.createElement("div");
  body.className = "stale-body";
  group.append(head, body);
  head.onclick = () => {
    group.classList.toggle("collapsed");
    setIcon(indicator, group.classList.contains("collapsed") ? "chevron-down" : "chevron-up");
  };
  $("chat").append(group);
  for (const m of messages) addMessage(m, { container: body });
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

async function loadSessions() {
  const sessions = await api(`/api/sessions?scope=${state.scope}`);
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
    row.append(main, del);
    row.onclick = () => void runAction(async () => { renderState(await api("/api/sessions/open", { method: "POST", body: JSON.stringify({ path: s.path }) })); await loadSessions(); });
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
  state.data = data;
  $("cwd").value = data.cwd || "";
  const { name, parent } = formatSessionPath(data.sessionFile);
  $("status").classList.remove("backend-offline");
  $("status").textContent = parent ? `${parent}/${name}` : name || "new session";
}

async function refresh(opts = {}) {
  renderState(await api("/api/state"), opts);
  await loadSessions();
}

async function syncStateWithoutRerender() {
  updateChrome(await api("/api/state"));
  await loadSessions();
}

async function sessionAction(endpoint, entryId) {
  try {
    renderState(await api(endpoint, { method: "POST", body: JSON.stringify({ entryId }) }));
    await loadSessions();
  } catch (err) {
    $("status").textContent = errorMessage(err);
    await refresh();
  }
}

const doRewind = (entryId) => sessionAction("/api/rewind", entryId);
const doFork = (entryId) => sessionAction("/api/fork", entryId);

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
  let timedOut = false;
  let latestPromptState = null;
  let lastStreamEventAt = Date.now();
  const startTime = Date.now();
  const progressInterval = setInterval(() => {
    const now = Date.now();
    if (!gotVisibleResponse) {
      const elapsed = Math.floor((now - startTime) / 1000);
      assistant.body.textContent = `waiting… (${elapsed}s)`;
      return;
    }
    if (activeToolPart && activeToolPart.phase !== "done") renderAssistant();
    const idleMs = now - lastStreamEventAt;
    if (idleMs > STREAM_AWARENESS_TIMEOUT_MS) {
      $("status").textContent = `No stream updates for ${formatDuration(idleMs)}; backend/tool may be stuck.`;
    }
  }, 1000);
  const timeout = setTimeout(() => {
    if (gotVisibleResponse) return;
    timedOut = true;
    controller.abort();
  }, STREAM_AWARENESS_TIMEOUT_MS);
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
    if (!activeToolPart || activeToolPart.phase === "done") {
      activeToolPart = { type: "tool", name, phase: evt.phase || "running", startedAt: Date.now(), endedAt: null, messages: [], error: false };
      streamParts.push(activeToolPart);
    }
    activeToolPart.name = name;
    activeToolPart.phase = evt.phase || activeToolPart.phase || "running";
    if (activeToolPart.phase === "done" && !activeToolPart.endedAt) activeToolPart.endedAt = Date.now();
    activeToolPart.error = Boolean(evt.isError || activeToolPart.error);
    if (evt.message) activeToolPart.messages.push(evt.message);
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
      summary.textContent = `${part.name || "tool"} · ${phaseText}`;
      const content = document.createElement("div");
      content.className = "turn-tool-body";
      const result = document.createElement("div");
      result.className = "turn-tool-result";
      result.textContent = part.messages.length ? part.messages.join("\n\n") : "running…";
      content.append(result);
      tool.append(summary, content);
      assistant.body.append(tool);
    }
    if (!assistant.body.childElementCount) assistant.body.textContent = activeToolPart ? "working…" : "waiting…";
  };
  const markVisible = () => {
    gotVisibleResponse = true;
    clearTimeout(timeout);
  };
  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch (err) {
          console.warn("Invalid stream event:", line, err);
          continue;
        }
        lastStreamEventAt = Date.now();
        if (evt.type === "ping") continue;
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
      }
      scrollChatToBottom();
    }
    if (!gotVisibleResponse && !output) {
      assistant.el.classList.add("error");
      assistant.body.textContent = "No response content received.";
    }
  } catch (err) {
    assistant.el.classList.add("error");
    const disconnected = !state.abortRequested && isNetworkError(err);
    assistant.body.textContent = timedOut
      ? `No visible response after ${Math.round(STREAM_AWARENESS_TIMEOUT_MS / 1000)}s; request aborted.`
      : (state.abortRequested ? "Request aborted." : (disconnected ? BACKEND_OFFLINE_MESSAGE : errorMessage(err)));
    if (disconnected) markBackendOffline();
  } finally {
    clearTimeout(timeout);
    clearInterval(progressInterval);
    state.streaming = false;
    state.abortController = null;
    state.abortRequested = false;
    setStreamingUi(false);
    if (!timedOut && latestPromptState) {
      renderState(latestPromptState);
      await loadSessions().catch(() => markBackendOffline());
    } else if (!timedOut) {
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
$("cwdForm").onsubmit = (ev) => {
  ev.preventDefault();
  void runAction(async () => {
    renderState(await api("/api/cwd", { method: "POST", body: JSON.stringify({ cwd: $("cwd").value }) }));
    await loadSessions();
  });
};
$("newSession").onclick = () => void runAction(async () => { renderState(await api("/api/sessions/new", { method: "POST" })); await loadSessions(); focusPrompt(); });
$("currentScope").onclick = () => void runAction(async () => { state.scope = "current"; $("currentScope").classList.add("active"); $("allScope").classList.remove("active"); await loadSessions(); });
$("allScope").onclick = () => void runAction(async () => { state.scope = "all"; $("allScope").classList.add("active"); $("currentScope").classList.remove("active"); await loadSessions(); });

setInterval(() => void checkBackend(), BACKEND_CHECK_INTERVAL_MS);

refresh().then(focusPrompt).catch((err) => { $("status").textContent = errorMessage(err); focusPrompt(); });
