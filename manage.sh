#!/usr/bin/env bash
# ============================================================
# OnePanel 终端管理菜单（v3.3.0）
#   chmod +x manage.sh && ./manage.sh
#
# 目录约定（解压便携包后）：
#   ./manage.sh          本脚本
#   ./bin/node           Node 运行时（便携包自带；系统有 node 也可）
#   ./bin/onepanel.js    打包后的后端
#   ./bin/public/        前端静态资源
#   ./data/              SQLite、节点身份、密钥
#   ./logs/              日志
#   ./data/onepanel.env  端口等配置（重置时保留）
# ============================================================
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$ROOT/bin"
DATA_DIR="$ROOT/data"
LOG_DIR="$ROOT/logs"
ENV_FILE="$DATA_DIR/onepanel.env"
PID_FILE="$DATA_DIR/onepanel.pid"

ok()   { printf "  [OK]   %s\n" "$*"; }
warn() { printf "  [!!]   %s\n" "$*"; }
err()  { printf "  [ERR]  %s\n" "$*"; }
dim()  { printf "         %s\n" "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }
ensure_dirs() { mkdir -p "$DATA_DIR" "$LOG_DIR"; }

load_env() {
  PORT=3000
  HOST=0.0.0.0
  APP_SECRET=""
  SYNC_INTERVAL_MS=15000
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line; do
      case "$line" in
        PORT=*)             PORT=${line#PORT=} ;;
        HOST=*)             HOST=${line#HOST=} ;;
        APP_SECRET=*)       APP_SECRET=${line#APP_SECRET=} ;;
        SYNC_INTERVAL_MS=*) SYNC_INTERVAL_MS=${line#SYNC_INTERVAL_MS=} ;;
      esac
    done < "$ENV_FILE"
  fi
}

save_env() {
  ensure_dirs
  {
    echo "# OnePanel runtime config (managed by manage.sh)"
    echo "PORT=$PORT"
    echo "HOST=$HOST"
    echo "SYNC_INTERVAL_MS=$SYNC_INTERVAL_MS"
    if [ -n "$APP_SECRET" ]; then echo "APP_SECRET=$APP_SECRET"; fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

node_bin() {
  if [ -x "$BIN_DIR/node" ]; then echo "$BIN_DIR/node"
  elif have node; then command -v node
  else echo ""; fi
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

do_status() {
  load_env; ensure_dirs
  echo
  dim "目录      $ROOT"
  dim "监听      $HOST:$PORT"
  local nb
  nb="$(node_bin)"
  if [ -n "$nb" ]; then
    dim "Node      $("$nb" -v 2>/dev/null) ($nb)"
  else
    err "未找到 Node 运行时（放 bin/node 或系统安装 node）"
  fi
  if is_running; then ok "运行中（PID $(cat "$PID_FILE")）"; else warn "未运行"; fi
  if [ -f "$DATA_DIR/dev.db" ]; then
    dim "数据库    $(du -h "$DATA_DIR/dev.db" 2>/dev/null | cut -f1)"
  else
    dim "数据库    尚未创建（首次启动生成）"
  fi
  if [ -f "$DATA_DIR/node-identity.json" ]; then ok "节点身份 已生成"; else dim "节点身份  尚无"; fi
  local cnt=0
  if [ -d "$DATA_DIR/backups" ]; then
    cnt="$(find "$DATA_DIR/backups" -name "*.opb" 2>/dev/null | wc -l | tr -d " ")"
  fi
  dim "本地备份  ${cnt} 份"
  if is_running && have curl; then
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      ok "健康检查 通过"
    else
      warn "进程在但接口无响应"
    fi
  fi
  echo
}

do_start() {
  load_env; ensure_dirs
  if is_running; then warn "已经在运行（PID $(cat "$PID_FILE")）"; return 0; fi
  local nb
  nb="$(node_bin)"
  if [ -z "$nb" ]; then err "找不到 Node"; return 1; fi
  if [ ! -f "$BIN_DIR/onepanel.js" ]; then err "找不到 bin/onepanel.js"; return 1; fi
  cd "$BIN_DIR" || return 1
  PORT="$PORT" HOST="$HOST" SYNC_INTERVAL_MS="$SYNC_INTERVAL_MS" APP_SECRET="$APP_SECRET" \
    OP_DATA_DIR="$DATA_DIR" DATABASE_URL="file:$DATA_DIR/dev.db" \
    nohup "$nb" onepanel.js >> "$LOG_DIR/onepanel.log" 2>&1 &
  echo $! > "$PID_FILE"
  cd "$ROOT" || return 1
  sleep 2
  if is_running; then
    ok "已启动：http://127.0.0.1:$PORT"
  else
    err "启动失败，最近日志："
    tail -n 20 "$LOG_DIR/onepanel.log" 2>/dev/null || true
    return 1
  fi
}

do_stop() {
  if ! is_running; then warn "没有在运行"; rm -f "$PID_FILE"; return 0; fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then warn "优雅退出超时，强制结束"; kill -9 "$pid" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  ok "已停止"
}

do_restart() { do_stop; sleep 1; do_start; }

do_port() {
  load_env
  printf "  当前端口：%s\n" "$PORT"
  printf "  新端口（回车保持不变）："
  read -r p
  if [ -n "$p" ]; then
    case "$p" in
      *[!0-9]*) err "端口必须是数字"; return 1 ;;
    esac
    if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then err "端口范围 1-65535"; return 1; fi
    PORT="$p"
    save_env
    ok "端口已改为 $PORT（需重启生效）"
    if is_running; then
      printf "  现在重启？[y/N] "
      read -r a
      if [ "$a" = "y" ]; then do_restart; fi
    fi
  fi
}

do_uninstall() {
  warn "这会删除程序文件、数据、日志，不可恢复。"
  printf "  输入 DELETE 确认： "
  read -r a
  if [ "$a" != "DELETE" ]; then warn "已取消"; return 0; fi
  do_stop
  rm -rf "$BIN_DIR" "$DATA_DIR" "$LOG_DIR"
  ok "已卸载（本脚本 manage.sh 仍在，可手动删除）"
}

do_reset() {
  warn "重置到初始状态：密码、卡片、节点身份、备份、日志全部清除。"
  warn "重置后本机是全新节点，不再是任何网络成员。"
  printf "  输入 RESET 确认： "
  read -r a
  if [ "$a" != "RESET" ]; then warn "已取消"; return 0; fi
  do_stop
  ensure_dirs
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name "onepanel.env" -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$LOG_DIR"
  mkdir -p "$LOG_DIR"
  ok "已重置：密码/卡片/身份/成员表清空，端口配置保留"
  dim "首次打开面板会要求设置新密码"
}

do_logs() {
  ensure_dirs
  if [ ! -f "$LOG_DIR/onepanel.log" ]; then warn "还没有日志"; return 0; fi
  dim "最近 40 行，Ctrl+C 退出"
  tail -n 40 -f "$LOG_DIR/onepanel.log"
}

do_deps() {
  local missing=""
  for c in curl tar; do if ! have "$c"; then missing="$missing $c"; fi; done
  if [ -z "$missing" ]; then ok "基础依赖齐全（curl / tar）"; else warn "缺少：$missing"; fi
  if have systemctl; then ok "检测到 systemd（可选：注册开机自启）"; else dim "无 systemd，需用本菜单手动启动"; fi
}

banner() {
  echo
  echo "  +------------------------------------------+"
  echo "  |        OnePanel 终端管理菜单             |"
  echo "  +------------------------------------------+"
}

menu() {
  load_env; ensure_dirs
  banner
  if is_running; then ok "状态：运行中（端口 $PORT）"; else warn "状态：已停止"; fi
  echo
  echo "   1) 启动            2) 停止           3) 重启"
  echo "   4) 查看状态        5) 修改端口       6) 实时日志"
  echo "   7) 重置到初始状态  8) 卸载           9) 环境自检"
  echo "   0) 退出"
  echo
  printf "  选择操作： "
}

ensure_dirs
while true; do
  menu
  if ! read -r choice; then break; fi
  echo
  case "$choice" in
    1) do_start ;;
    2) do_stop ;;
    3) do_restart ;;
    4) do_status ;;
    5) do_port ;;
    6) do_logs ;;
    7) do_reset ;;
    8) do_uninstall; break ;;
    9) do_deps ;;
    0|q|Q) ok "再见"; break ;;
    *) warn "没有这个选项" ;;
  esac
  echo
  printf "  回车继续… "
  read -r _ || true
done
