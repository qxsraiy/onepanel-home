#!/usr/bin/env bash
# OnePanel 启动入口（被 systemd / install.sh / upgrade.sh 调用）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ONEPANEL_ENV:-/opt/onepanel/onepanel.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${PORT:=5266}"
: "${OP_DATA_DIR:=/var/lib/onepanel}"
export PORT OP_DATA_DIR
export DATABASE_URL="${DATABASE_URL:-file:${OP_DATA_DIR}/onepanel.db}"

# 优先用内置运行时（install.sh 下载的），回退到系统 Node
RUNTIME_NODE="${ONEPANEL_DIR:-/opt/onepanel}/runtime/node/bin/node"
if [[ -x "$RUNTIME_NODE" ]]; then
  NODE_BIN="$RUNTIME_NODE"
else
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || { echo "[onepanel] 找不到 node，请重跑 install.sh" >&2; exit 1; }
fi

mkdir -p "$OP_DATA_DIR"
cd "$HERE/backend"
exec "$NODE_BIN" index.js
