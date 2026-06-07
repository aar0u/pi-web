import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { allowRemote, apiToken, host, isLoopbackHost, port, publicDir, schedulerIntervalMs, telegramBotToken, telegramChatIds, telegramCwd as configuredTelegramCwd } from "./config.mjs";
import { HttpError, readBody, sendError, sendJson, writeNdjson } from "./http.mjs";
import { makeRuntime, SessionManager } from "./pi-runtime.mjs";
import { registerFilesRoutes } from "./routes/files.mjs";
import { registerRuntimeRoutes } from "./routes/runtime.mjs";
import { registerSessionsRoutes } from "./routes/sessions.mjs";
import { registerTasksRoutes } from "./routes/tasks.mjs";
import { startScheduler } from "./scheduler.mjs";
import { DATA_DIR, TaskStore } from "./task-store.mjs";
import { startTelegramBot } from "./telegram-bot.mjs";
import { sessionPayload } from "./session-state.mjs";
import { serveStatic } from "./static.mjs";
import { observePromptEvents, subscribePromptEvents } from "./stream-events.mjs";

let cwd = process.cwd();
const fixedTelegramCwd = resolve(configuredTelegramCwd || cwd);
const TELEGRAM_SESSION_STATE = join(DATA_DIR, "telegram-session.json");
let runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
const taskStore = await TaskStore.open();
let telegramRuntime = telegramBotToken ? await makeTelegramRuntime(fixedTelegramCwd) : null;
let operationState = "idle";
let activePrompt = null;
let promptQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function currentState() {
  return sessionPayload(runtime);
}

function lastMessageText(state) {
  const last = state?.messages?.[state.messages.length - 1];
  return (last?.text || "").trim();
}

function summarizeState(state) {
  return lastMessageText(state).replace(/\s+/g, " ").trim().slice(0, 1500);
}

async function readTelegramSessionState() {
  try {
    return JSON.parse(await fs.readFile(TELEGRAM_SESSION_STATE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeTelegramSessionState(value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TELEGRAM_SESSION_STATE, `${JSON.stringify(value, null, 2)}\n`);
}

async function createTelegramRuntime(telegramCwd) {
  const nextRuntime = await makeRuntime(telegramCwd, SessionManager.create(telegramCwd));
  await writeTelegramSessionState({ cwd: telegramCwd, sessionFile: nextRuntime.session.sessionFile, sessionId: nextRuntime.session.sessionId });
  return nextRuntime;
}

async function makeTelegramRuntime(telegramCwd) {
  const saved = await readTelegramSessionState();
  if (saved?.cwd === telegramCwd && saved.sessionFile) {
    try {
      return await makeRuntime(telegramCwd, SessionManager.open(saved.sessionFile));
    } catch (error) {
      console.warn("Could not open saved Telegram session, creating a new one:", error instanceof Error ? error.message : error);
    }
  }
  return createTelegramRuntime(telegramCwd);
}

async function resetTelegramSession() {
  if (!telegramRuntime) throw new HttpError(503, "Telegram runtime is not enabled");
  if (operationState !== "idle" || promptIsActive()) throw new HttpError(409, "Another session operation is in progress");
  const oldRuntime = telegramRuntime;
  telegramRuntime = await createTelegramRuntime(fixedTelegramCwd);
  await oldRuntime.dispose().catch(() => {});
  return { sessionFile: telegramRuntime.session.sessionFile, sessionId: telegramRuntime.session.sessionId };
}

async function createTaskSessionBinding({ source = "web" } = {}) {
  const taskCwd = source === "telegram" ? fixedTelegramCwd : cwd;
  const taskRuntime = await makeRuntime(taskCwd, SessionManager.create(taskCwd));
  try {
    const state = sessionPayload(taskRuntime);
    return {
      cwd: state?.cwd || null,
      sessionFile: state?.sessionFile || null,
      sessionId: state?.sessionId || null,
      sessionName: state?.sessionName || null,
    };
  } finally {
    await taskRuntime.dispose().catch(() => {});
  }
}

function promptIsActive() {
  return operationState === "prompt" || runtime.session.isStreaming;
}

async function waitUntilNotStreaming(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!promptIsActive()) return true;
    await sleep(100);
  }
  return !promptIsActive();
}

async function ensureNotStreamingForMutation() {
  if (!promptIsActive()) return;
  if (!activePrompt?.clientClosed) throw new HttpError(409, "Cannot change sessions while a response is streaming");

  await activePrompt.session.abort().catch(() => {});
  if (await waitUntilNotStreaming(1_500)) return;

  const oldRuntime = runtime;
  operationState = "idle";
  activePrompt = null;
  await oldRuntime.dispose().catch(() => {});
  runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
}

async function withRuntimeMutation(fn) {
  await ensureNotStreamingForMutation();
  if (operationState !== "idle") throw new HttpError(409, "Another session operation is in progress");
  operationState = "mutation";
  try {
    await ensureNotStreamingForMutation();
    return await fn();
  } finally {
    operationState = "idle";
  }
}

function beginPrompt() {
  if (operationState !== "idle") throw new HttpError(409, "Another session operation is in progress");
  if (promptIsActive()) throw new HttpError(409, "A response is already streaming");
  operationState = "prompt";
  const activeRuntime = runtime;
  const activeSession = activeRuntime.session;
  activePrompt = { session: activeSession, clientClosed: false };
  return { activeRuntime, activeSession };
}

async function runPromptText({ text, source = "api", taskId = null, telegramChatId: chatId = null }) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Message is empty");
  const { activeRuntime, activeSession } = beginPrompt();
  const startedAt = new Date().toISOString();
  logEvent("prompt", `start ${source}${taskId ? ` task=${taskId}` : ""}`);
  try {
    await activeSession.prompt(text.trim());
    const state = sessionPayload(activeRuntime);
    logLargeTokenUsage(source, state);
    logEvent("prompt", `done ${source}`);
    return { source, taskId, telegramChatId: chatId, startedAt, finishedAt: new Date().toISOString(), state, text: lastMessageText(state), summary: summarizeState(state) };
  } catch (error) {
    logEvent("prompt", `error ${source}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    clearActivePrompt(activeSession);
  }
}

async function runTelegramPromptText({ text, source = "telegram", telegramChatId: chatId = null }) {
  if (!telegramRuntime) throw new HttpError(503, "Telegram runtime is not enabled");
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Message is empty");
  if (operationState !== "idle" || promptIsActive()) throw new HttpError(409, "Another session operation is in progress");

  operationState = "prompt";
  const startedAt = new Date().toISOString();
  logEvent("prompt", `start ${source}`);
  const unsubscribe = observePromptEvents(telegramRuntime.session, logEvent);
  try {
    await telegramRuntime.session.prompt(text.trim());
    const state = sessionPayload(telegramRuntime);
    logLargeTokenUsage(source, state);
    logEvent("prompt", `done ${source}`);
    return { source, telegramChatId: chatId, startedAt, finishedAt: new Date().toISOString(), state, text: lastMessageText(state), summary: summarizeState(state) };
  } catch (error) {
    logEvent("prompt", `error ${source}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    unsubscribe();
    operationState = "idle";
  }
}

async function runEphemeralPromptText({ text, source = "task-proposal", telegramChatId: chatId = null }) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Message is empty");
  if (operationState !== "idle" || promptIsActive()) throw new HttpError(409, "Another session operation is in progress");

  operationState = "prompt";
  const proposalCwd = source === "telegram" ? fixedTelegramCwd : cwd;
  let proposalRuntime = null;
  let unsubscribe = () => {};
  const startedAt = new Date().toISOString();
  logEvent("proposal", `start ${source}`);
  try {
    proposalRuntime = await makeRuntime(proposalCwd, SessionManager.inMemory(proposalCwd));
    unsubscribe = observePromptEvents(proposalRuntime.session, logEvent);
    await proposalRuntime.session.prompt(text.trim());
    const state = sessionPayload(proposalRuntime);
    logLargeTokenUsage(`proposal ${source}`, state);
    logEvent("proposal", `done ${source}`);
    return { source, telegramChatId: chatId, startedAt, finishedAt: new Date().toISOString(), state, text: lastMessageText(state), summary: summarizeState(state) };
  } catch (error) {
    logEvent("proposal", `error ${source}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    unsubscribe();
    await proposalRuntime?.dispose().catch(() => {});
    operationState = "idle";
  }
}

async function refreshActiveRuntimeIfSessionChanged(sessionFile, nextCwd) {
  if (!sessionFile || runtime.session.sessionFile !== sessionFile) return;
  const oldRuntime = runtime;
  cwd = nextCwd || cwd;
  runtime = await makeRuntime(cwd, SessionManager.open(sessionFile));
  await oldRuntime.dispose().catch(() => {});
}

function scheduledTaskRunMessage(task, finishedAt, includePrompt = false) {
  return [
    `Scheduled run · ${task.id}`,
    finishedAt,
    includePrompt ? `Prompt: ${truncateText(task.prompt, 500)}` : "",
  ].filter(Boolean).join("\n");
}

function scheduledTaskResultMessage(task, resultText) {
  const text = truncateText(resultText || "Completed");
  return [
    `Scheduled result · ${task.id}`,
    "",
    text,
  ].join("\n");
}

function syntheticUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function syntheticAssistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: syntheticUsage(),
  };
}

async function appendTaskResultToBoundSession(task, resultText, finishedAt) {
  const appendTo = (targetRuntime) => {
    const entries = targetRuntime.session.sessionManager.getEntries?.() || [];
    const includePrompt = !entries.some((entry) => entry.type === "message");
    targetRuntime.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: scheduledTaskRunMessage(task, finishedAt, includePrompt) }],
    });
    targetRuntime.session.sessionManager.appendMessage(syntheticAssistantMessage(scheduledTaskResultMessage(task, resultText)));
    return sessionPayload(targetRuntime);
  };
  if (resolve(runtime.session.sessionFile || "") === resolve(task.sessionFile)) return appendTo(runtime);

  let boundRuntime = null;
  try {
    boundRuntime = await makeRuntime(task.cwd, SessionManager.open(task.sessionFile));
    return appendTo(boundRuntime);
  } finally {
    await boundRuntime?.dispose().catch(() => {});
  }
}

async function runTaskPromptText({ text, task, source = "scheduler" }) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Message is empty");
  if (!task?.sessionFile || !task?.cwd) throw new HttpError(409, "Scheduled task has no bound session; recreate it so it can be pinned to a conversation");
  if (operationState !== "idle" || promptIsActive()) throw new HttpError(409, "A response is already streaming");

  operationState = "prompt";
  let taskRuntime = null;
  let shouldRefreshActiveRuntime = false;
  try {
    shouldRefreshActiveRuntime = runtime.session.sessionFile === task.sessionFile;
    taskRuntime = await makeRuntime(task.cwd, SessionManager.inMemory(task.cwd));
    const unsubscribe = observePromptEvents(taskRuntime.session, logEvent);
    const startedAt = new Date().toISOString();
    try {
      await taskRuntime.session.prompt(`${text.trim()}\n\nKeep the final scheduled task result concise. Do not include raw tool outputs or long source snippets.`);
    } finally {
      unsubscribe();
    }
    const ephemeralState = sessionPayload(taskRuntime);
    logLargeTokenUsage(`task ${task.id}`, ephemeralState);
    const resultText = lastMessageText(ephemeralState);
    const finishedAt = new Date().toISOString();
    const state = await appendTaskResultToBoundSession(task, resultText, finishedAt);
    return { source, taskId: task.id, startedAt, finishedAt, state, text: scheduledTaskResultMessage(task, resultText), summary: summarizeState(ephemeralState) };  } finally {
    await taskRuntime?.dispose().catch(() => {});
    operationState = "idle";
    if (shouldRefreshActiveRuntime) await refreshActiveRuntimeIfSessionChanged(task.sessionFile, task.cwd);
  }
}

async function waitForIdle() {
  while (promptIsActive() || operationState !== "idle") await sleep(500);
}

const promptRunner = {
  isIdle: () => !promptIsActive() && operationState === "idle",
  runText: runPromptText,
  runTask: runTaskPromptText,
  runTelegram: runTelegramPromptText,
  runEphemeral: runEphemeralPromptText,
  resetTelegram: resetTelegramSession,
  createTaskSessionBinding,
  enqueue(input) {
    const run = promptQueue.then(async () => {
      await waitForIdle();
      return runPromptText(input);
    });
    promptQueue = run.catch(() => {});
    return run;
  },
  enqueueTelegram(input) {
    const run = promptQueue.then(async () => {
      await waitForIdle();
      return runTelegramPromptText(input);
    });
    promptQueue = run.catch(() => {});
    return run;
  },
  enqueueEphemeral(input) {
    const run = promptQueue.then(async () => {
      await waitForIdle();
      return runEphemeralPromptText(input);
    });
    promptQueue = run.catch(() => {});
    return run;
  },
};

const colors = process.stdout.isTTY ? {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} : { reset: "", dim: "", green: "", yellow: "", red: "", blue: "", magenta: "", cyan: "" };

function color(value, code) {
  return `${code}${value}${colors.reset}`;
}

function logTime() {
  return new Date().toTimeString().slice(0, 8);
}

function clientAddress(req) {
  return req.socket.remoteAddress || "unknown";
}

const QUIET_POLL_PATHS = new Set(["/api/state", "/api/sessions"]);
const POLL_AWARENESS_INTERVAL_MS = 60_000;
const LARGE_TOKEN_THRESHOLD = 50_000;
const LARGE_CONTEXT_PERCENT = 70;
const pollStats = new Map();
let lastPollAwarenessAt = Date.now();

function eventColor(kind) {
  if (kind === "prompt" || kind === "proposal") return colors.cyan;
  if (kind === "task") return colors.magenta;
  if (kind === "tool") return colors.blue;
  if (kind === "tokens") return colors.yellow;
  if (kind === "poll") return colors.dim;
  return colors.green;
}

function logEvent(kind, message) {
  console.log(`${color(logTime(), colors.dim)} ${color("event", colors.cyan)} ${color(kind, eventColor(kind))} ${message}`);
}

function formatK(value) {
  if (!Number.isFinite(value)) return "?";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(value);
}

function truncateText(value, max = 6_000) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tokenCount(stats) {
  const tokens = stats?.tokens || {};
  return (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0);
}

function logLargeTokenUsage(label, state) {
  const stats = state?.stats;
  const total = tokenCount(stats);
  const percent = stats?.contextUsage?.percent;
  if (total < LARGE_TOKEN_THRESHOLD && (!Number.isFinite(percent) || percent < LARGE_CONTEXT_PERCENT)) return;
  const parts = [`${label}: tokens ${formatK(total)} (threshold ${formatK(LARGE_TOKEN_THRESHOLD)})`];
  if (Number.isFinite(percent)) parts.push(`context ${Math.round(percent)}%`);
  logEvent("tokens", parts.join(", "));
}

function recordPollRequest(pathname, status, duration) {
  const stats = pollStats.get(pathname) || { count: 0, errors: 0, totalMs: 0, lastStatus: 0 };
  stats.count += 1;
  stats.totalMs += duration;
  stats.lastStatus = status;
  if (status >= 400) stats.errors += 1;
  pollStats.set(pathname, stats);
}

function flushPollAwareness(force = false) {
  const now = Date.now();
  if (!force && now - lastPollAwarenessAt < POLL_AWARENESS_INTERVAL_MS) return;
  lastPollAwarenessAt = now;
  const parts = [];
  for (const [pathname, stats] of pollStats) {
    if (!stats.count) continue;
    const avg = Math.round(stats.totalMs / stats.count);
    const errors = stats.errors ? ` err ${stats.errors}` : "";
    parts.push(`${pathname}×${stats.count} ${stats.lastStatus} avg ${avg}ms${errors}`);
  }
  pollStats.clear();
  if (parts.length) logEvent("poll", parts.join(" · "));
}

function statusColor(status) {
  if (status >= 500) return colors.red;
  if (status >= 400) return colors.yellow;
  return colors.green;
}

function logRequest(req, res, url) {
  const started = Date.now();
  let logged = false;
  const write = (event = "") => {
    if (logged) return;
    logged = true;
    const status = res.statusCode || 0;
    const duration = Date.now() - started;
    if (!event && req.method === "GET" && QUIET_POLL_PATHS.has(url.pathname) && status < 400) {
      recordPollRequest(url.pathname, status, duration);
      flushPollAwareness();
      return;
    }
    flushPollAwareness();
    const suffix = event ? ` ${color(event, colors.red)}` : "";
    console.log(`${color(logTime(), colors.dim)} ${color(req.method, colors.cyan)} ${url.pathname} ${color(status, statusColor(status))} ${color(`${duration}ms`, colors.dim)}${suffix} ${color(clientAddress(req), colors.dim)}`);
  };
  res.once("finish", () => write());
  res.once("close", () => {
    if (!res.writableEnded) write("aborted");
  });
}

const apiRoutes = new Map();
const routeContext = {
  getCwd: () => cwd,
  setCwd: (nextCwd) => { cwd = nextCwd; },
  getRuntime: () => runtime,
  setRuntime: (nextRuntime) => { runtime = nextRuntime; },
  currentState,
  withRuntimeMutation,
  promptRunner,
  taskStore,
};
registerRuntimeRoutes(apiRoutes, routeContext);
registerSessionsRoutes(apiRoutes, routeContext);
registerFilesRoutes(apiRoutes, routeContext);
registerTasksRoutes(apiRoutes, routeContext);

function clearActivePrompt(activeSession) {
  if (activePrompt?.session === activeSession) activePrompt = null;
  operationState = "idle";
}

async function readPromptText(req, activeSession) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    clearActivePrompt(activeSession);
    throw error;
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    clearActivePrompt(activeSession);
    throw new HttpError(400, "Message is empty");
  }
  return body.text;
}

async function handlePrompt(req, res) {
  const { activeRuntime, activeSession } = beginPrompt();
  const text = await readPromptText(req, activeSession);
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let completed = false;
  const heartbeat = setInterval(() => writeNdjson(res, { type: "ping", timestamp: Date.now() }), 10_000);
  res.on("close", () => {
    if (completed) return;
    if (activePrompt?.session === activeSession) activePrompt.clientClosed = true;
    void activeSession.abort().catch(() => {});
  });

  const unsubscribe = subscribePromptEvents(activeSession, res, () => sessionPayload(activeRuntime), logEvent);
  logEvent("prompt", "start web");
  try {
    writeNdjson(res, { type: "accepted" });
    await activeSession.prompt(text);
    const state = sessionPayload(activeRuntime);
    logLargeTokenUsage("web", state);
    logEvent("prompt", "done web");
    writeNdjson(res, { type: "done", state });
  } catch (error) {
    logEvent("prompt", `error web: ${error instanceof Error ? error.message : String(error)}`);
    writeNdjson(res, { type: "error", message: error instanceof Error ? error.message : String(error), state: sessionPayload(activeRuntime) });
  } finally {
    completed = true;
    clearActivePrompt(activeSession);
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
}

function requestOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    return new URL(origin);
  } catch {
    throw new HttpError(403, "Invalid request origin");
  }
}

function assertApiAccess(req) {
  const origin = requestOrigin(req);
  if (origin && origin.host !== req.headers.host) throw new HttpError(403, "Cross-origin API requests are not allowed");

  if (!apiToken) return;
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = req.headers["x-pi-hub-token"] || bearer;
  if (token !== apiToken) throw new HttpError(401, "Missing or invalid API token");
}

async function handleApi(req, res, url) {
  try {
    assertApiAccess(req);
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      await handlePrompt(req, res);
      return;
    }

    const handler = apiRoutes.get(`${req.method} ${url.pathname}`);
    if (handler) {
      await handler(req, res, url);
      if (!res.writableEnded) sendJson(res, currentState());
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendError(res, error);
  }
}

const telegramBot = startTelegramBot({ token: telegramBotToken, allowedChatIds: telegramChatIds, taskStore, runner: promptRunner });
const scheduler = startScheduler({
  taskStore,
  runner: promptRunner,
  intervalMs: schedulerIntervalMs,
  notifyTelegram: telegramBot?.sendMessage,
  logEvent,
});

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendJson(res, { error: "Bad request" }, 400);
    return;
  }

  logRequest(req, res, url);
  if (url.pathname.startsWith("/api/")) void handleApi(req, res, url);
  else serveStatic(req, res, url.pathname, publicDir);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down...`);
  flushPollAwareness(true);
  server.close();
  scheduler.stop();
  telegramBot?.stop();
  await telegramRuntime?.dispose().catch(() => {});
  await runtime.dispose().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`${color("pi-hub", colors.cyan)} listening at ${color(`http://${host}:${port}`, colors.green)}`);
  console.log(`cwd: ${cwd}`);
  console.log(`host: ${host}`);
  console.log(`port: ${port}`);
  console.log(`allow remote: ${allowRemote ? color("yes", colors.yellow) : "no"}`);
  console.log(`loopback host: ${isLoopbackHost ? color("yes", colors.green) : color("no", colors.yellow)}`);
  console.log(`api auth: ${apiToken ? color("token required", colors.green) : "no token (loopback/local only)"}`);
  console.log(`telegram bot: ${telegramBotToken ? color("enabled", colors.green) : "disabled"}`);
  if (telegramBotToken) console.log(`telegram cwd: ${fixedTelegramCwd}`);
  console.log(`task persistence: data/tasks.json + data/task-runs.jsonl`);
});
