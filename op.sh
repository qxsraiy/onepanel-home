#!/usr/bin/env bash
# ======================================================================
#  OnePanel 安装与管理脚本（唯一入口）
#  安装：bash op.sh
#  之后所有管理操作都在这个菜单里（升级/卸载/改端口/状态/日志/回滚/自动更新）
# ----------------------------------------------------------------------
#  用法：
#    curl --http1.1 -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/op.sh -o /root/op.sh
#    bash /root/op.sh
#  参数模式：
#    bash /root/op.sh --port 5266 --dir /opt/onepanel --auto-update
#  参数：
#    --port N        服务端口（默认 5266，被占用会自动建议下一个）
#    --dir PATH      安装目录（默认 /opt/onepanel）
#    --data PATH     数据目录（默认 /var/lib/onepanel）
#    --auto-update   创建每天自动检查更新的计划任务
#    --no-systemd    不注册 systemd（手动启动）
#    --version X.Y.Z 安装指定版本（默认最新）
# ======================================================================
set -euo pipefail

REPO="qxsraiy/onepanel-home"
API="https://api.github.com/repos/${REPO}/releases/latest"
PORT=5266
INSTALL_DIR="/opt/onepanel"
DATA_DIR="/var/lib/onepanel"
AUTO_UPDATE=0
AUTO_UPDATE_HOUR=4
USE_SYSTEMD=1
WANT_VERSION=""
LOCAL_PKG=""
PKG_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --data) DATA_DIR="$2"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --version) WANT_VERSION="$2"; shift 2 ;;
    --pkg) LOCAL_PKG="$2"; shift 2 ;;
    --url) PKG_URL="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ---------- 下载源 ----------
# 国内直连 GitHub 大概率超时。优先级：
#   ① OP_MIRROR 环境变量（用户指定，域名替换式：https://down.xtay.cn）
#   ② down.xtay.cn（本项目自建镜像）
#   ③ ghfast.top / gh-proxy.com / ghproxy.net（公共镜像，前缀拼接式）
#   ④ 直连 github.com
# 两种镜像规则都试：域名替换（down.xtay.cn/qxsraiy/...）与前缀拼接（ghfast.top/https://...）
MIRROR_SELF="${OP_MIRROR:-https://down.xtay.cn}"
MIRROR_PUBLIC=("https://ghfast.top" "https://gh-proxy.com" "https://ghproxy.net")
ACTIVE_MIRROR=""

# 把 github 系 URL 转成候选镜像地址，逐个尝试
gh_fetch() {
  local url="$1" out="$2" tmo="${3:-30}" try m
  local -a tries=()

  # ① 自建镜像：域名替换式
  case "$url" in
    https://github.com/*)
      tries+=("${MIRROR_SELF%/}/${url#https://github.com/}")
      ;;
    https://api.github.com/*)
      tries+=("${MIRROR_SELF%/}/api/${url#https://api.github.com/}")
      ;;
    https://raw.githubusercontent.com/*)
      tries+=("${MIRROR_SELF%/}/raw/${url#https://raw.githubusercontent.com/}")
      ;;
  esac

  # ② 公共镜像：前缀拼接式
  for m in "${MIRROR_PUBLIC[@]}"; do
    tries+=("${m%/}/${url}")
  done

  # ③ 直连
  tries+=("$url")

  for try in "${tries[@]}"; do
    if curl --http1.1 -fsSL --connect-timeout 10 --max-time "$tmo" -o "$out" "$try" 2>/dev/null; then
      case "$try" in
        "$url") ACTIVE_MIRROR="" ;;
        *) ACTIVE_MIRROR="$try"; log "走镜像：$try" ;;
      esac
      return 0
    fi
  done
  return 1
}

# 直连探测：海外服务器直连更快，国内需要镜像。先测直连能否 3 秒内通
GH_DIRECT_OK=0
if curl --http1.1 -fsSL --connect-timeout 3 --max-time 5 -H "User-Agent: onepanel-installer" -o /dev/null "https://api.github.com/rate_limit" 2>/dev/null; then
  GH_DIRECT_OK=1
fi

# 文本读取（API 查询）：按 GH_DIRECT_OK 决定顺序，且必须校验内容
gh_text() {
  local url="$1" try r
  local -a tries=()
  local -a mirrors=()
  case "$url" in
    https://api.github.com/*) mirrors+=("${MIRROR_SELF%/}/api/${url#https://api.github.com/}") ;;
    https://github.com/*) mirrors+=("${MIRROR_SELF%/}/${url#https://github.com/}") ;;
  esac
  for m in "${MIRROR_PUBLIC[@]}"; do mirrors+=("${m%/}/${url}"); done

  # 直连优先（海外）；否则镜像优先（国内）
  if [ "$GH_DIRECT_OK" -eq 1 ]; then
    tries+=("$url")
    for try in "${mirrors[@]}"; do tries+=("$try"); done
  else
    for try in "${mirrors[@]}"; do tries+=("$try"); done
    tries+=("$url")
  fi

  for try in "${tries[@]}"; do
    # -f 会拒绝 4xx/5xx；再额外校验内容，避免镜像返回 HTML 首页被当成功
    r="$(curl --http1.1 -fsSL --connect-timeout 10 --max-time 25 -H "User-Agent: onepanel-installer" -H "Accept: application/vnd.github+json" "$try" 2>/dev/null)" || continue
    # 用 case 匹配，避免 printf|grep -q 在 pipefail 下被 SIGPIPE 误判为失败
    case "$r" in
      *'"tag_name"'*) ;;
      *) continue ;;
    esac
    printf '%s' "$r"
    return 0
  done
  return 1
}

# 带镜像回退的文本读取：gh_text <原始URL>
gh_text() {
  local url="$1" m r
  for m in "${GITHUB_MIRRORS[@]}"; do
    r="$(curl --http1.1 -fsSL --connect-timeout 10 --max-time 25 "${m}${url}" 2>/dev/null)" && { echo "$r"; return 0; }
  done
  return 1
}
log() { echo -e "\033[36m[onepanel]\033[0m $*"; }
err() { echo -e "\033[31m[错误]\033[0m $*" >&2; }

# ======================================================================
#  交互菜单：直接执行 bash op.sh 时进入；curl | bash 时跳过
# ======================================================================
# ---------- 安装向导：逐项询问 ----------
port_in_use() {
  (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$1 ") || \
  (command -v netstat >/dev/null && netstat -ltn 2>/dev/null | grep -q ":$1 ")
}

ask_install_options() {
  echo ""
  echo "  ── 安装配置（直接回车 = 用 [ ] 里的默认值）──"
  echo ""

  # ① 端口
  printf "  ① 服务端口 [%s]: " "$PORT"
  read -r _p
  if [ -n "$_p" ]; then
    case "$_p" in (*[!0-9]*)
      err "端口必须是数字"; return 1 ;;
    esac
    PORT="$_p"
  fi
  if port_in_use "$PORT"; then
    echo "     ⚠️  端口 $PORT 已被占用"
    printf "     是否改用 %s？[Y/n]: " "$((PORT+1))"
    read -r _y
    case "$_y" in n|N) echo "     保持 $PORT（可能启动失败）" ;; *) PORT=$((PORT+1)) ;; esac
  fi

  # ② 安装目录
  printf "  ② 安装目录 [%s]: " "$INSTALL_DIR"
  read -r _d
  [ -n "$_d" ] && INSTALL_DIR="$_d"

  # ③ 数据目录
  printf "  ③ 数据目录（升级不影响）[%s]: " "$DATA_DIR"
  read -r _dt
  [ -n "$_dt" ] && DATA_DIR="$_dt"

  # ④ systemd
  printf "  ④ 注册为系统服务 systemd？[Y/n]: "
  read -r _sd
  case "$_sd" in n|N) USE_SYSTEMD=0 ;; *) USE_SYSTEMD=1 ;; esac

  # ⑤ 自动更新
  printf "  ⑤ 开启每日自动检查更新？[y/N]: "
  read -r _au
  case "$_au" in y|Y)
    AUTO_UPDATE=1
    printf "     每天几点执行？[默认 4]: "
    read -r _h
    AUTO_UPDATE_HOUR="${_h:-4}"
    case "$AUTO_UPDATE_HOUR" in (*[!0-9]*) AUTO_UPDATE_HOUR=4 ;; esac
    ;;
  *) AUTO_UPDATE=0 ;;
  esac

  # ⑥ 指定版本
  printf "  ⑥ 安装指定版本（留空 = 最新）: "
  read -r _v
  [ -n "$_v" ] && WANT_VERSION="${_v#v}"

  # 汇总确认
  echo ""
  echo "  ── 即将安装 ──"
  echo "     端口：$PORT"
  echo "     安装目录：$INSTALL_DIR"
  echo "     数据目录：$DATA_DIR"
  echo "     systemd：$([ "$USE_SYSTEMD" -eq 1 ] && echo 是 || echo 否)"
  if [ "$AUTO_UPDATE" -eq 1 ]; then
    echo "     自动更新：是（每天 ${AUTO_UPDATE_HOUR}:00）"
  else
    echo "     自动更新：否"
  fi
  if [ -n "$WANT_VERSION" ]; then echo "     版本：v$WANT_VERSION"; else echo "     版本：最新"; fi
  echo ""
  printf "  确认开始安装？[Y/n]: "
  read -r _ok
  case "$_ok" in n|N) echo "  已取消"; return 1 ;; esac
  return 0
}
show_menu() {
  echo ""
  echo "╔══════════════════════════════════════════════╗"
  echo "║            OnePanel 管理菜单                  ║"
  echo "╠══════════════════════════════════════════════╣"
  echo "║  1) 安装 / 升级到最新版                       ║"
  echo "║  2) 卸载（可选择是否保留数据）                 ║"
  echo "║  3) 修改端口                                  ║"
  echo "║  4) 查看运行状态                              ║"
  echo "║  5) 重启服务                                  ║"
  echo "║  6) 查看实时日志                              ║"
  echo "║  7) 回滚上一版本                              ║"
  echo "║  8) 开启/关闭自动更新                         ║"
  echo "║  0) 退出                                      ║"
  echo "╚══════════════════════════════════════════════╝"
}

need_installed() {
  if [ ! -L "${INSTALL_DIR}/current" ]; then
    err "还没有安装 OnePanel（找不到 ${INSTALL_DIR}/current）"
    err "请先选 1 安装"
    return 1
  fi
  return 0
}

do_uninstall() {
  need_installed || return 1
  echo ""
  echo "  即将卸载 OnePanel。数据目录：${DATA_DIR}"
  printf "  是否保留数据（数据库/节点身份）？[Y/n] "
  read -r keep
  case "$keep" in n|N) KEEP_DATA=0 ;; *) KEEP_DATA=1 ;; esac
  systemctl stop onepanel 2>/dev/null || true
  systemctl disable onepanel 2>/dev/null || true
  rm -f /etc/systemd/system/onepanel.service
  systemctl daemon-reload 2>/dev/null || true
  crontab -l 2>/dev/null | grep -v "onepanel/current/upgrade.sh" | crontab - 2>/dev/null || true
  rm -rf "${INSTALL_DIR}/current" "${INSTALL_DIR}/versions"
  if [ "$KEEP_DATA" -eq 0 ]; then
    rm -rf "$DATA_DIR"
    echo "  ✅ 已卸载（数据已删除）"
  else
    echo "  ✅ 已卸载（数据保留在 ${DATA_DIR}）"
  fi
}

do_change_port() {
  need_installed || return 1
  local cur np
  cur="$(grep -E "^PORT=" "${INSTALL_DIR}/onepanel.env" 2>/dev/null | cut -d= -f2)"
  cur="${cur:-5266}"
  printf "  当前端口 %s，输入新端口 [回车保持]: " "$cur"
  read -r np
  [ -z "$np" ] && { echo "  未修改"; return 0; }
  case "$np" in (*[!0-9]*) err "端口必须是数字"; return 1 ;; esac
  sed -i "s/^PORT=.*/PORT=${np}/" "${INSTALL_DIR}/onepanel.env"
  echo "  ✅ 端口已改为 ${np}，正在重启"
  systemctl restart onepanel 2>/dev/null || true
  sleep 5
  if curl -fsS --max-time 5 "http://127.0.0.1:${np}/api/health" >/dev/null 2>&1; then
    echo "  ✅ 服务已在 ${np} 端口正常响应"
  else
    err "  新端口无响应，检查防火墙 / SELinux / 端口占用"
  fi
}

do_status() {
  need_installed || return 1
  local port ver
  port="$(grep -E "^PORT=" "${INSTALL_DIR}/onepanel.env" 2>/dev/null | cut -d= -f2)"
  port="${port:-5266}"
  ver="$(cat "${INSTALL_DIR}/current/.version" 2>/dev/null || echo "?")"
  echo ""
  echo "  版本：${ver}"
  echo "  端口：${port}"
  echo "  数据：${DATA_DIR}"
  echo "  systemd：$(systemctl is-active onepanel 2>/dev/null || echo inactive)"
  if curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "  健康：✅ 正常"
  else
    echo "  健康：❌ 无响应"
  fi
  echo "  已装版本：$(ls -1 "${INSTALL_DIR}/versions" 2>/dev/null | tr "\n" " ")"
}

do_restart() {
  need_installed || return 1
  systemctl restart onepanel 2>/dev/null || err "systemctl restart 失败"
  echo "  已重启，等待健康检查…"
  sleep 5
  local port
  port="$(grep -E "^PORT=" "${INSTALL_DIR}/onepanel.env" 2>/dev/null | cut -d= -f2)"
  port="${port:-5266}"
  if curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "  ✅ 服务正常"
  else
    err "  服务无响应，看日志：journalctl -u onepanel -n 50"
  fi
}

do_logs() {
  echo "  按 Ctrl+C 退出"
  journalctl -u onepanel -f -n 50 2>/dev/null || true
}

do_rollback() {
  need_installed || return 1
  bash "${INSTALL_DIR}/current/upgrade.sh" --rollback
}

do_auto_update() {
  need_installed || return 1
  local cmd="bash ${INSTALL_DIR}/current/upgrade.sh --auto >> ${INSTALL_DIR}/upgrade.log 2>&1"

  # 宝塔：不碰系统 crontab，只给指引
  if [ -d /www/server/panel ]; then
    echo ""
    echo "  【宝塔面板】请在宝塔里添加，别用系统 crontab（会被覆盖）"
    echo ""
    echo "   宝塔 → 计划任务 → 添加任务"
    echo "     任务类型：Shell 脚本"
    echo "     任务名称：OnePanel 自动更新"
    echo "     执行周期：每天 4 点（或你想要的时间）"
    echo "     脚本内容：$cmd"
    echo ""
    return 0
  fi

  if crontab -l 2>/dev/null | grep -q "onepanel/current/upgrade.sh"; then
    printf "  当前已开启自动更新，关闭？[y/N] "
    read -r off
    case "$off" in y|Y)
      crontab -l 2>/dev/null | grep -v "onepanel/current/upgrade.sh" | crontab -
      echo "  ✅ 已关闭自动更新" ;;
    esac
  else
    printf "  每天几点自动检查更新？[默认 4] "
    read -r hour
    hour="${hour:-4}"
    (crontab -l 2>/dev/null | grep -v "onepanel/current/upgrade.sh"; \
     echo "0 ${hour} * * * bash ${INSTALL_DIR}/current/upgrade.sh --auto >> ${INSTALL_DIR}/upgrade.log 2>&1") | crontab -
    echo "  ✅ 已开启：每天 ${hour}:00"
  fi
}

run_menu() {
  while true; do
    show_menu
    printf "  请选择 [0-8]: "
    read -r choice
    case "$choice" in
      1) if ask_install_options; then return 0; fi ;;
      2) do_uninstall; echo ""; read -r -p "  按回车继续…" _ ;;
      3) do_change_port; echo ""; read -r -p "  按回车继续…" _ ;;
      4) do_status; echo ""; read -r -p "  按回车继续…" _ ;;
      5) do_restart; echo ""; read -r -p "  按回车继续…" _ ;;
      6) do_logs ;;
      7) do_rollback; echo ""; read -r -p "  按回车继续…" _ ;;
      8) do_auto_update; echo ""; read -r -p "  按回车继续…" _ ;;
      0) echo "  再见"; exit 0 ;;
      *) echo "  无效选项" ;;
    esac
  done
}

# 有显式参数（--pkg/--port/--version 等）时直接安装，否则一律进菜单
if [ $# -eq 0 ]; then
  run_menu
fi

# ---------- 1. 环境检查 ----------
command -v curl >/dev/null || { err "需要 curl"; exit 1; }
command -v tar  >/dev/null || { err "需要 tar"; exit 1; }

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64|x64)          ARCH_TAG="linux-x64" ;;
  aarch64|arm64|armv8l|armv8b) ARCH_TAG="linux-arm64" ;;
  armv7l|armv6l|armhf)
    err "检测到 32 位 ARM（$ARCH），官方只提供 x64 / arm64 包。"
    err "请改用 Docker 部署：docker compose up -d"
    exit 1 ;;
  *) err "无法识别的架构：$ARCH"; exit 1 ;;
esac
log "架构：$ARCH（匹配 $ARCH_TAG）"

# libc 检测：Alpine(musl) 上官方 Node 二进制跑不起来
LIBC="glibc"
if ldd --version 2>&1 | grep -qi musl; then LIBC="musl"; fi
if [[ "$LIBC" == "musl" ]]; then
  err "检测到 musl libc（Alpine？）。官方 Node 二进制需要 glibc。"
  err "Alpine 请用 Docker 部署：docker compose up -d"
  exit 1
fi

# ---------- 2. Node 运行时 ----------
NODE_WANT="22.15.1"
RUNTIME_DIR="${INSTALL_DIR}/runtime"
mkdir -p "$RUNTIME_DIR"

NODE_BIN="$(command -v node || true)"
NODE_OK=0
if [[ -n "$NODE_BIN" ]]; then
  NODE_MAJOR="$($NODE_BIN -v | sed 's/v//' | cut -d. -f1)"
  [[ "$NODE_MAJOR" -ge 18 ]] && NODE_OK=1
fi

if [[ "$NODE_OK" -eq 1 ]]; then
  log "使用系统 Node：$(node -v)"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
else
  log "系统没有 Node 18+，自动下载官方 Node $NODE_WANT（$ARCH_TAG）…"
  NODE_TARBALL="node-v${NODE_WANT}-${ARCH_TAG}.tar.xz"
  NODE_URL="https://nodejs.org/dist/v${NODE_WANT}/${NODE_TARBALL}"
  if ! curl --http1.1 -fL --max-time 300 -o "$RUNTIME_DIR/node.tar.xz" "$NODE_URL"; then
    err "下载 Node 失败：$NODE_URL"
    err "也可以自己先装 Node 18+ 后重跑本脚本，或用 Docker 部署"
    exit 1
  fi
  tar -xJf "$RUNTIME_DIR/node.tar.xz" -C "$RUNTIME_DIR"
  mv "$RUNTIME_DIR/node-v${NODE_WANT}-${ARCH_TAG}" "$RUNTIME_DIR/node" 2>/dev/null || true
  rm -f "$RUNTIME_DIR/node.tar.xz"
  export PATH="$RUNTIME_DIR/node/bin:$PATH"
  log "已内置 Node：$($RUNTIME_DIR/node/bin/node -v)"
fi

# ---------- 2. 端口检查 ----------
port_in_use() { (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$1 ") || (command -v netstat >/dev/null && netstat -ltn 2>/dev/null | grep -q ":$1 "); }
if port_in_use "$PORT"; then
  ORIG=$PORT
  while port_in_use "$PORT"; do PORT=$((PORT+1)); done
  log "端口 $ORIG 已被占用，改用 $PORT"
fi
log "服务端口：$PORT"

# ---------- 3. 取版本 ----------
log "查询最新版本…"
if [[ -n "$WANT_VERSION" ]]; then
  TAG="v$WANT_VERSION"
else
  RESP="$(gh_text "$API" || true)"
  if [ -z "$RESP" ]; then
    err "无法访问 GitHub（直连与镜像均失败）"
    echo "" >&2
    echo "  ── 诊断 ──" >&2
    echo "  直连 HTTP/1.1：$(curl --http1.1 -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 8 https://api.github.com/rate_limit 2>/dev/null || echo 失败)" >&2
    echo "  直连 HTTP/2：  $(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 8 https://api.github.com/rate_limit 2>/dev/null || echo 失败)" >&2
    echo "  DNS：$(getent hosts api.github.com 2>/dev/null | head -1 || echo '解析失败')" >&2
    echo "  curl 版本：$(curl --version 2>/dev/null | head -1)" >&2
    echo "" >&2
    echo "  解决：① 美国/海外服务器直连通常可用，检查是否被防火墙拦" >&2
    echo "        ② 国内服务器：OP_MIRROR=https://down.xtay.cn bash op.sh" >&2
    echo "        ③ 实在不行：手动下载包后用 --pkg 指定" >&2
    exit 1
  fi
  if echo "$RESP" | grep -q "Not Found"; then
    err "该仓库还没有任何 Release 包（GitHub 404），请等发布或用 --pkg 手动指定"
    exit 1
  fi
  TAG="$(echo "$RESP" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
fi
[[ -n "$TAG" ]] || { err "无法查询最新版本，请检查网络"; exit 1; }
VER="${TAG#v}"
log "安装版本：$TAG"

ASSET="onepanel-${VER}-${ARCH_TAG}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
SHA_URL="${URL}.sha256"

# ---------- 4. 准备目录 ----------
VER_DIR="${INSTALL_DIR}/versions/${VER}"
mkdir -p "${INSTALL_DIR}/versions" "$VER_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

# ---------- 5. 下载 + 校验 ----------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo ""
echo "  安装包直链（可复制到浏览器 / IDM / 迅雷下载）："
echo "  $URL"
echo ""
if [ -z "${LOCAL_PKG:-}" ] && [ -z "${PKG_URL:-}" ]; then
  echo "  ⚠️  国内直连 GitHub Release 下载 86MB 包通常会超时。"
  echo "     如果下面卡住请 Ctrl+C，用浏览器下载上面的直链后执行："
  echo "       bash op.sh --pkg /path/to/$ASSET"
  echo ""
fi
log "下载 $ASSET …"
if [ -n "${LOCAL_PKG:-}" ]; then
  log "使用本地安装包：$LOCAL_PKG"
  cp "$LOCAL_PKG" "$TMP/pkg.tar.gz" || { err "无法读取本地包"; exit 1; }
elif [ -n "${PKG_URL:-}" ]; then
  log "从指定地址下载：$PKG_URL"
  curl --http1.1 -fL --connect-timeout 15 --max-time 1800 -o "$TMP/pkg.tar.gz" "$PKG_URL" || {
    err "指定地址下载失败：$PKG_URL"; exit 1; }
else
  gh_fetch "$URL" "$TMP/pkg.tar.gz" 600 || { err "下载失败：$URL"
    err "可手动下载后用：bash op.sh --pkg /path/to/$ASSET"; exit 1; }
fi

if gh_fetch "$SHA_URL" "$TMP/pkg.sha256" 20 2>/dev/null; then
  EXPECT="$(awk '{print $1}' "$TMP/pkg.sha256")"
  ACTUAL="$(sha256sum "$TMP/pkg.tar.gz" | awk '{print $1}')"
  if [[ "$EXPECT" != "$ACTUAL" ]]; then
    err "校验失败！期望 $EXPECT 实际 $ACTUAL"
    exit 1
  fi
  log "sha256 校验通过"
else
  log "未找到校验文件，跳过（不推荐）"
fi

# ---------- 6. 解压 ----------
log "解压到 $VER_DIR"
tar -xzf "$TMP/pkg.tar.gz" -C "$VER_DIR" --strip-components=1
echo "$VER" > "$VER_DIR/.version"

# ---------- 7. 切换软链接（原子） ----------
PREV=""
if [[ -L "${INSTALL_DIR}/current" ]]; then
  PREV="$(readlink "${INSTALL_DIR}/current")"
  log "上一版本：$PREV（保留用于回滚）"
fi
ln -sfn "$VER_DIR" "${INSTALL_DIR}/current"
log "已切换到 $VER_DIR"

# ---------- 8. 数据目录与配置 ----------
ENV_FILE="${INSTALL_DIR}/onepanel.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
# OnePanel 环境配置（安装时生成）
PORT=$PORT
OP_DATA_DIR=$DATA_DIR
DATABASE_URL=file:${DATA_DIR}/onepanel.db
NODE_ENV=production
# 有多节点/HTTPS 域名时再填：
# COOKIE_DOMAIN=.yourdomain.com
# COOKIE_SECURE=1
# WEBAUTHN_RP_ID=yourdomain.com
# WEBAUTHN_HOSTS=cn.yourdomain.com,us.yourdomain.com
EOF
  chmod 600 "$ENV_FILE"
  log "已生成配置：$ENV_FILE（改端口/域名请编辑它）"
fi

# ---------- 9. 注册 systemd ----------
if [[ "$USE_SYSTEMD" -eq 1 ]] && command -v systemctl >/dev/null; then
  NODE_FOR_SYSTEMD="$(command -v node || true)"
if [ -x "${INSTALL_DIR}/runtime/node/bin/node" ]; then
  NODE_FOR_SYSTEMD="${INSTALL_DIR}/runtime/node/bin/node"
fi
if [ -z "$NODE_FOR_SYSTEMD" ]; then
  err "找不到可用的 node，无法注册 systemd"
  exit 1
fi
log "systemd 将使用：$NODE_FOR_SYSTEMD"

cat > /etc/systemd/system/onepanel.service <<EOF
[Unit]
Description=OnePanel 个人数字枢纽
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/current/backend
EnvironmentFile=${INSTALL_DIR}/onepanel.env
ExecStart=${NODE_FOR_SYSTEMD} index.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable onepanel >/dev/null 2>&1 || true
  systemctl restart onepanel
  log "已注册 systemd 服务：onepanel"
else
  log "跳过 systemd（用 op.sh start 手动启动）"
fi

# ---------- 10. 自动更新计划任务 ----------
if [ "$AUTO_UPDATE" -eq 1 ]; then
  CRON_CMD="bash ${INSTALL_DIR}/current/upgrade.sh --auto >> ${INSTALL_DIR}/upgrade.log 2>&1"
  if [ -d /www/server/panel ]; then
    # 宝塔不读取系统 crontab，且会覆盖 /var/spool/cron，所以不能写 crontab
    echo ""
    echo "  ══════════════════════════════════════════════════════"
    echo "  检测到【宝塔面板】—— 自动更新需要你在宝塔里手动添加"
    echo "  ══════════════════════════════════════════════════════"
    echo ""
    echo "   宝塔 → 计划任务 → 添加任务"
    echo "     任务类型：Shell 脚本"
    echo "     任务名称：OnePanel 自动更新"
    echo "     执行周期：每天 ${AUTO_UPDATE_HOUR:-4} 点"
    echo "     脚本内容：$CRON_CMD"
    echo ""
    echo "   （宝塔有独立任务库，系统 crontab 里写的它不显示，还会被覆盖）"
    echo ""
  else
    (crontab -l 2>/dev/null | grep -v "onepanel/current/upgrade.sh"; echo "0 ${AUTO_UPDATE_HOUR:-4} * * * $CRON_CMD") | crontab -
    log "已添加自动更新计划任务（每天 ${AUTO_UPDATE_HOUR:-4}:00）"
  fi
fi

# ---------- 11. 健康检查 ----------
log "等待服务启动…"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "✅ 安装完成！"
    echo ""
    echo "  访问地址：http://<本机IP>:${PORT}"
    echo "  默认账号：admin"
    echo "  默认密码：123456（首次登录会强制改密）"
    echo ""
    echo "  安装目录：${INSTALL_DIR}/current"
    echo "  数据目录：${DATA_DIR}"
    echo "  配置文件：${ENV_FILE}"
    echo "  升级命令：bash ${INSTALL_DIR}/current/upgrade.sh
   回滚命令：bash ${INSTALL_DIR}/current/upgrade.sh --rollback"
    echo ""
    exit 0
  fi
  sleep 1
done

err "启动超时。检查日志：journalctl -u onepanel -n 50"
if [[ -n "$PREV" ]]; then
  err "可回滚：ln -sfn $PREV ${INSTALL_DIR}/current && systemctl restart onepanel"
fi
exit 1
