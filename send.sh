#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REMOTE_HOST=${PI_HUB_DEPLOY_HOST:-mc}
REMOTE_DIR=${PI_HUB_DEPLOY_DIR:-/home/azureuser/others/pi-hub}
REMOTE="$REMOTE_HOST:$REMOTE_DIR"
ENV_FILE=${PI_HUB_ENV_FILE:-}
AUTH_FILE=${PI_HUB_AUTH_FILE:-$HOME/.pi/agent/auth.json}
AGENT_DIR=${PI_HUB_AGENT_DIR:-$HOME/.pi/agent}
AGENT_ARCHIVE=${PI_HUB_AGENT_ARCHIVE:-$SCRIPT_DIR/agent-profile.tar.gz}
AGENT_PROFILE_DIR=$(mktemp -d -t pi-hub-agent-profile.XXXXXX)
export COPYFILE_DISABLE=1

if [[ -z "$ENV_FILE" ]]; then
  if [[ -z "${OneDrive:-}" ]]; then
    echo "Set OneDrive or PI_HUB_ENV_FILE before running this script." >&2
    exit 1
  fi
  ENV_FILE="$OneDrive/dev/.local/share/runtime.env"
fi

ssh "$REMOTE_HOST" "
  set -euo pipefail
  sudo rm -rf '$REMOTE_DIR'
  mkdir -p '$REMOTE_DIR' '$REMOTE_DIR/data'
"

scp "$SCRIPT_DIR"/{package.json,pnpm-lock.yaml,.env.example} "$REMOTE"
scp "$SCRIPT_DIR/src"/*.mjs "$REMOTE/src"
scp "$SCRIPT_DIR/src/routes"/*.mjs "$REMOTE/src/routes"
scp "$SCRIPT_DIR/public"/*.* "$REMOTE/public"
scp "$SCRIPT_DIR/public/vendor"/* "$REMOTE/public/vendor"
scp "$SCRIPT_DIR/scripts"/*.mjs "$REMOTE/scripts"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$AUTH_FILE" ]]; then
  echo "Auth file not found: $AUTH_FILE" >&2
  exit 1
fi
if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Agent dir not found: $AGENT_DIR" >&2
  exit 1
fi

agent_items=()
for item in AGENTS.md settings.json skills prompts extensions; do
  if [[ -e "$AGENT_DIR/$item" ]]; then
    agent_items+=("$item")
  fi
done

if (( ${#agent_items[@]} > 0 )); then
  tar --no-xattrs -C "$AGENT_DIR" -chf - --exclude='.DS_Store' "${agent_items[@]}" | tar -C "$AGENT_PROFILE_DIR" -xf -
fi
cp "$AUTH_FILE" "$AGENT_PROFILE_DIR/auth.json"
chmod 600 "$AGENT_PROFILE_DIR/auth.json"
tar --no-xattrs -C "$AGENT_PROFILE_DIR" -czf "$AGENT_ARCHIVE" --exclude='.DS_Store' .

scp "$ENV_FILE" "$REMOTE/.env"
scp "$AGENT_ARCHIVE" "$REMOTE/agent-profile.tar.gz"

ssh "$REMOTE_HOST" "cat > '$REMOTE_DIR/pi-hub.sh' <<'EOF'
#!/bin/bash
set -euo pipefail
APP_DIR=\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)
cd \"\$APP_DIR\"

# Telegram-only deployment option:
# - Web server still starts, but binds to loopback only.
# - Do not set PI_HUB_ALLOW_REMOTE=1 here.
export HOST=\${HOST:-127.0.0.1}
export PORT=\${PORT:-8787}

rm -rf "\${HOME}/.pi/agent"
mkdir -p "\${HOME}/.pi/agent"
if [[ -f agent-profile.tar.gz ]]; then
  tar --warning=no-unknown-keyword -xzf agent-profile.tar.gz -C "\${HOME}/.pi/agent"
fi
if [[ -f "\${HOME}/.pi/agent/auth.json" ]]; then
  chmod 600 "\${HOME}/.pi/agent/auth.json"
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --prod
  exec pnpm start
fi

npm install --omit=dev

chown -R node "\$APP_DIR"

exec npm start
EOF
chmod +x '$REMOTE_DIR/pi-hub.sh'"

cat <<EOF
Deployed to $REMOTE

Uploaded env file from: $ENV_FILE
Uploaded agent profile from: $AGENT_DIR (${agent_items[*]:-none}, auth.json from $AUTH_FILE)

On the remote server, ensure .env has at least:
  TELEGRAM_BOT_TOKEN_BUZZ=<bot-token>
  TELEGRAM_CHAT_ID=<chat-id>           # required; comma-separated allowed chat ids also work
  PI_HUB_TELEGRAM_CWD=/path/to/project # optional

Then run:
  PORT=8788 ./pi-hub.sh
EOF
