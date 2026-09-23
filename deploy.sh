#!/usr/bin/env bash
# Connect Feishu to an already configured local Codex installation.
# Usage: ./deploy.sh (run from a local checkout, as your normal user)
set -euo pipefail
umask 077

CODES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for cmd in node npm codex systemctl; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd. Install it first." >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo 'Node.js 22+ is required.' >&2; exit 1;
}
codex --version
CODEX_BIN="$(command -v codex)"
export CODEX_BIN

cd "$CODES_DIR/bridge"
npm ci --omit=dev
mkdir -p "$HOME/.codes/secrets" "$HOME/.codes/logs"

if [ -f "$HOME/.codes/bridge.json" ]; then
  echo 'Reusing existing ~/.codes/bridge.json and secrets.'
else
  read -rp 'Feishu App ID: ' FEISHU_APP_ID
  read -rsp 'Feishu App Secret: ' FEISHU_APP_SECRET
  echo
  read -rp 'Project alias [myapp]: ' PROJECT_ALIAS
  PROJECT_ALIAS=${PROJECT_ALIAS:-myapp}
  [[ "$PROJECT_ALIAS" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid project alias.' >&2; exit 1; }
  read -rp "Project path [$CODES_DIR]: " PROJECT_PATH
  PROJECT_PATH=${PROJECT_PATH:-$CODES_DIR}
  [ -n "$FEISHU_APP_ID" ] && [ -n "$FEISHU_APP_SECRET" ] || { echo 'Feishu credentials are required.' >&2; exit 1; }
  mkdir -p "$PROJECT_PATH"
  export FEISHU_APP_ID FEISHU_APP_SECRET PROJECT_ALIAS PROJECT_PATH
  node --input-type=module <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const e = process.env;
const secret = path.join(os.homedir(), '.codes', 'secrets', `${e.PROJECT_ALIAS}_secret`);
// Never overwrite a pre-existing secret, even on an interrupted first install.
fs.writeFileSync(secret, e.FEISHU_APP_SECRET, { mode: 0o600, flag: 'wx' });
const config = {
  projects: { [e.PROJECT_ALIAS]: {
    path: path.resolve(e.PROJECT_PATH),
    feishu: { appId: e.FEISHU_APP_ID, appSecretPath: secret },
  } },
  codexPath: e.CODEX_BIN,
  debug: false,
  backup: false,
};
fs.writeFileSync(path.join(os.homedir(), '.codes', 'bridge.json'),
  JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
  unset FEISHU_APP_SECRET
fi

node bridge.mjs --selftest
node setup-service.mjs
systemctl --user daemon-reload
systemctl --user enable codes-feishu-bridge.service
systemctl --user restart codes-feishu-bridge.service
sleep 3
systemctl --user is-active --quiet codes-feishu-bridge.service || {
  echo 'Startup failed: journalctl --user -u codes-feishu-bridge.service -n 50' >&2
  exit 1
}
echo 'Bridge service started. Check journalctl --user -u codes-feishu-bridge.service for bot connections.'
echo 'Codex uses its local configuration and login. No Codex Home is generated; no daily backup is scheduled.'
