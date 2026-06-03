# pi-web

Lightweight web UI for pi.

## Run

```bash
pnpm install
pnpm dev
# open http://localhost:8787
```

Production build:

```bash
pnpm build
pnpm start
```

Set `PORT` to override the default `8787`. The server binds to `127.0.0.1` by default.

Remote access is disabled by default. For trusted LAN-only access, bind a non-loopback `HOST` with `PI_WEB_ALLOW_REMOTE=1`:

```bash
HOST=0.0.0.0 PI_WEB_ALLOW_REMOTE=1 pnpm start
```

Then open `http://<your-lan-ip>:8787` from another device. If you need a token, also set `PI_WEB_TOKEN` and open the UI once with `#token=<token>`. Only expose pi-web on a trusted LAN or behind an authenticated proxy/tunnel.

## Notes

- Server is native ESM using Node's built-in HTTP server.
- Client is vanilla JS/CSS/HTML.
- Uses pi's SDK runtime for sessions, streaming prompts, rewind (`navigateTree`) and fork.
