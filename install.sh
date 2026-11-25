#!/usr/bin/env bash
# ======================================================================
#  OnePanel 一键安装脚本
# ----------------------------------------------------------------------
#  用法：
#    curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh | bash
#  或：
#    wget -qO- .../install.sh | bash -s -- --port 5266 --dir /opt/onepanel
#
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
USE_SYSTEMD=1
WANT_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --data) DATA_DIR="$2"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --version) WANT_VERSION="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

log() { echo -e "\033[36m[onepanel]\033[0m $*"; }
err() { echo -e "\033[31m[错误]\033[0m $*" >&2; }

# ---------- 1. 环境检查 ----------
command -v curl >/dev/null || { err "需要 curl"; exit 1; }
command -v tar  >/dev/null || { err "需要 tar"; exit 1; }

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_TAG="linux-x64" ;;
  aarch64|arm64) ARCH_TAG="linux-arm64" ;;
  *) err "不支持的架构：$ARCH（支持 x86_64 / aarch64）"; exit 1 ;;
esac
log "架构：$ARCH_TAG"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  NODE_MAJOR=0
else
  NODE_MAJOR="$($NODE_BIN -v | sed 's/v//' | cut -d. -f1)"
fi
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  log "未检测到 Node 18+，将使用安装包内自带的 Node 运行时"
  USE_BUNDLED_NODE=1
else
  log "检测到 Node $(node -v)"
  USE_BUNDLED_NODE=0
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
  TAG="$(curl -fsSL "$API" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
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
log "下载 $ASSET …"
curl -fL --progress-bar -o "$TMP/pkg.tar.gz" "$URL" || { err "下载失败：$URL"; exit 1; }

if curl -fsSL -o "$TMP/pkg.sha256" "$SHA_URL" 2>/dev/null; then
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
  cat > /etc/systemd/system/onepanel.service <<EOF
[Unit]
Description=OnePanel 个人数字枢纽
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/current/backend
EnvironmentFile=${INSTALL_DIR}/onepanel.env
ExecStart=/usr/bin/env bash ${INSTALL_DIR}/current/manage.sh start-fg
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
  log "跳过 systemd（用 manage.sh start 手动启动）"
fi

# ---------- 10. 自动更新计划任务 ----------
if [[ "$AUTO_UPDATE" -eq 1 ]]; then
  CRON_LINE="0 4 * * * bash ${INSTALL_DIR}/current/manage.sh upgrade --auto >> ${INSTALL_DIR}/upgrade.log 2>&1"
  (crontab -l 2>/dev/null | grep -v 'onepanel/current/manage.sh upgrade' ; echo "$CRON_LINE") | crontab -
  log "已添加自动更新计划任务（每天 04:00）"
  log "宝塔面板用户：系统计划任务里也能看到这条，可自行改成想要的时间"
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
