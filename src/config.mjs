import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 8787;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parsePort(value) {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const publicDir = join(rootDir, "public");
export const port = parsePort(process.env.PORT);
export const host = process.env.HOST ?? "127.0.0.1";
export const apiToken = process.env.PI_HUB_TOKEN || "";
export const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN_BUZZ || "";
export const telegramChatId = process.env.TELEGRAM_CHAT_ID_BUZZ || "";
export const telegramCwd = process.env.PI_HUB_TELEGRAM_CWD || "";
export const schedulerIntervalMs = parsePositiveInt(process.env.PI_HUB_SCHEDULER_INTERVAL_MS, 30_000, "PI_HUB_SCHEDULER_INTERVAL_MS");
export const allowRemote = process.env.PI_HUB_ALLOW_REMOTE === "1";
export const isLoopbackHost = LOOPBACK_HOSTS.has(host);

if (!isLoopbackHost && !allowRemote) {
  throw new Error("Refusing to bind non-loopback HOST without PI_HUB_ALLOW_REMOTE=1. Only expose pi-hub on a trusted LAN or behind an authenticated proxy/tunnel.");
}
