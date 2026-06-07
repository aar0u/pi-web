# pi-hub

Lightweight hub UI for pi.

## Run

```bash
pnpm install
cp .env.example .env
pnpm dev
# open http://localhost:8787
```

Production build:

```bash
pnpm build
pnpm start
```

`pnpm dev` and `pnpm start` load `.env` automatically via Node's native `--env-file-if-exists`, so no `dotenv` package is required. Set `PORT` to override the default `8787`. The server binds to `127.0.0.1` by default. Keep real `.env` files out of git; commit `.env.example` only.

## Scheduled tasks

Scheduled tasks use 5-field cron syntax and are persisted locally:

- `data/tasks.json` — task definitions
- `data/task-runs.jsonl` — execution summaries

Create scheduled tasks from the Web chat with `/schedule <natural-language request>`, for example `/schedule 每天早上 9 点总结项目状态`. pi converts it into a pending cron task in the same conversation; confirm it in the `Tasks` panel to enable. The `Tasks` panel is only for managing tasks. By default, Web-created tasks are pinned to the session where they were created, so scheduled runs do not land in whichever conversation happens to be open later. Scheduled prompts defer until pi is idle so they do not interrupt active Web prompts.

## Telegram bot

Telegram support is optional. Enable it with:

```bash
TELEGRAM_BOT_TOKEN_BUZZ=<bot-token> pnpm start
```

`TELEGRAM_CHAT_ID` is required when Telegram is enabled, so the bot only accepts approved chats. Use one chat id or a comma-separated allowlist, for example `TELEGRAM_CHAT_ID=123456789,987654321`. Telegram prompts use a dedicated fixed working directory, defaulting to the server startup cwd. Override it with `PI_HUB_TELEGRAM_CWD=/path/to/project`. The Telegram session is persisted in `data/telegram-session.json`, so Telegram messages do not follow whichever cwd/session the Web UI currently has open.

Commands:

```text
/new
/schedule every 30 minutes summarize current project
/tasks
/confirm <task_id>
/enable <task_id>
/disable <task_id>
/delete <task_id>
```

Web and Telegram task creation both start with natural language and ask pi to produce a cron-backed task. Created tasks start disabled and require confirmation. Telegram `/schedule` tasks use isolated task sessions by default, while ordinary Telegram chat can be reset with `/new`. Ordinary Telegram messages are queued when pi is busy and may use simple Telegram formatting when helpful.

Remote access is disabled by default. For trusted LAN-only access, bind a non-loopback `HOST` with `PI_HUB_ALLOW_REMOTE=1`:

```bash
HOST=0.0.0.0 PI_HUB_ALLOW_REMOTE=1 pnpm start
```

Then open `http://<your-lan-ip>:8787` from another device. Without `PI_HUB_TOKEN`, anyone who can reach that LAN address can use the full pi-hub API, including prompting the agent, switching directories, browsing files, and managing sessions. This is intended for personal trusted-LAN use only.

If you need a token, also set `PI_HUB_TOKEN` and open the UI once with `#token=<token>`. Only expose pi-hub on a trusted LAN or behind an authenticated proxy/tunnel.

## Notes

- Server is native ESM using Node's built-in HTTP server.
- Client is vanilla JS/CSS/HTML.
- Uses pi's SDK runtime for sessions, streaming prompts, rewind (`navigateTree`) and fork.
