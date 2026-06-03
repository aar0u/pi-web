import { createServer } from "node:http";
import { allowRemote, apiToken, host, isLoopbackHost, port, publicDir } from "./config.mjs";
import { HttpError, readBody, sendError, sendJson, writeNdjson } from "./http.mjs";
import { makeRuntime, SessionManager } from "./pi-runtime.mjs";
import { registerFilesRoutes } from "./routes/files.mjs";
import { registerRuntimeRoutes } from "./routes/runtime.mjs";
import { registerSessionsRoutes } from "./routes/sessions.mjs";
import { sessionPayload } from "./session-state.mjs";
import { serveStatic } from "./static.mjs";
import { subscribePromptEvents } from "./stream-events.mjs";

let cwd = process.cwd();
let runtime = await makeRuntime(cwd, SessionManager.continueRecent(cwd));
let operationState = "idle";
let activePrompt = null;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function currentState() {
  return sessionPayload(runtime);
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

const colors = process.stdout.isTTY ? {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} : { reset: "", dim: "", green: "", yellow: "", red: "", cyan: "" };

function color(value, code) {
  return `${code}${value}${colors.reset}`;
}

function clientAddress(req) {
  return req.socket.remoteAddress || "unknown";
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
    const suffix = event ? ` ${color(event, colors.red)}` : "";
    console.log(`${color(req.method, colors.cyan)} ${url.pathname} ${color(status, statusColor(status))} ${color(`${duration}ms`, colors.dim)}${suffix} ${color(clientAddress(req), colors.dim)}`);
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
};
registerRuntimeRoutes(apiRoutes, routeContext);
registerSessionsRoutes(apiRoutes, routeContext);
registerFilesRoutes(apiRoutes, routeContext);

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
  if (operationState === "mutation") throw new HttpError(409, "Another session operation is in progress");
  if (promptIsActive()) throw new HttpError(409, "A response is already streaming");

  operationState = "prompt";
  const activeRuntime = runtime;
  const activeSession = activeRuntime.session;
  activePrompt = { session: activeSession, clientClosed: false };

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

  const unsubscribe = subscribePromptEvents(activeSession, res, () => sessionPayload(activeRuntime));
  try {
    writeNdjson(res, { type: "accepted" });
    await activeSession.prompt(text);
    writeNdjson(res, { type: "done", state: sessionPayload(activeRuntime) });
  } catch (error) {
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
  const token = req.headers["x-pi-web-token"] || bearer;
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
  server.close();
  await runtime.dispose().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`${color("pi-web", colors.cyan)} listening at ${color(`http://${host}:${port}`, colors.green)}`);
  console.log(`cwd: ${cwd}`);
  console.log(`host: ${host}`);
  console.log(`port: ${port}`);
  console.log(`allow remote: ${allowRemote ? color("yes", colors.yellow) : "no"}`);
  console.log(`loopback host: ${isLoopbackHost ? color("yes", colors.green) : color("no", colors.yellow)}`);
  console.log(`api token: ${apiToken ? color("enabled", colors.green) : "disabled"}`);
});
