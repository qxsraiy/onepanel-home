#!/usr/bin/env bash
# ======================================================================
#  OnePanel 自动升级脚本
# ----------------------------------------------------------------------
#  用法：
#    upgrade.sh                 检查并升级到最新版
#    upgrade.sh --auto          只在有新版本时升级（给 cron 用）
#    upgrade.sh --check         只检查，不升级
#    upgrade.sh --rollback      回滚到上一个版本
# ======================================================================
set -uo pipefail

REPO="qxsraiy/onepanel-home"
INSTALL_DIR="${ONEPANEL_DIR:-/opt/onepanel}"
ENV_FILE="${INSTALL_DIR}/onepanel.env"
KEEP=2

MODE="interactive"
[[ "${1:-}" == "--auto" ]] && MODE="auto"
[[ "${1:-}" == "--check" ]] && MODE="check"
[[ "${1:-}" == "--rollback" ]] && MODE="rollback"

# GitHub 加速镜像（国内直连经常超时）
MIRRORS=()
if [ -n "${GH_PROXY:-}" ]; then MIRRORS+=("${GH_PROXY%/}/"); fi
MIRRORS+=("" "https://ghfast.top/" "https://gh-proxy.com/" "https://ghproxy.net/")
gh_fetch() {
  local url="$1" out="$2" tmo="${3:-60}" m
  for m in "${MIRRORS[@]}"; do
    if curl -fsSL --connect-timeout 10 --max-time "$tmo" -o "$out" "${m}${url}" 2>/dev/null; then
      [ -n "$m" ] && log "镜像：$m"
      return 0
    fi
  done
  return 1
}
gh_text() {
  local url="$1" m r
  for m in "${MIRRORS[@]}"; do
    r="$(curl -fsSL --connect-timeout 10 --max-time 25 "${m}${url}" 2>/dev/null)" && { echo "$r"; return 0; }
  done
  return 1
}

log()  { echo -e "\033[36m[upgrade]\033[0m $*"; }
warn() { echo -e "\033[33m[警告]\033[0m $*"; }
err()  { echo -e "\033[31m[错误]\033[0m $*" >&2; }

[[ -f "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }
: "${PORT:=5266}"

CURRENT_LINK="${INSTALL_DIR}/current"
[[ -L "$CURRENT_LINK" ]] || { err "$CURRENT_LINK 不是软链接，当前不是脚本安装形态"; exit 1; }

# ---------- 回滚 ----------
if [[ "$MODE" == "rollback" ]]; then
  CUR="$(readlink "$CURRENT_LINK")"
  PREV="$(ls -1dt "${INSTALL_DIR}"/versions/*/ 2>/dev/null | sed -n '2p')"
  [[ -n "$PREV" ]] || { err "没有可回滚的上一版本"; exit 1; }
  PREV="${PREV%/}"
  log "回滚：$(basename "$CUR") -> $(basename "$PREV")"
  ln -sfn "$PREV" "$CURRENT_LINK"
  systemctl restart onepanel 2>/dev/null || true
  sleep 6
  curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null && { log "✅ 回滚成功"; exit 0; }
  err "回滚后仍不健康"; exit 1
fi

# ---------- 查最新 ----------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_TAG="linux-x64" ;;
  aarch64|arm64) ARCH_TAG="linux-arm64" ;;
  *) err "不支持的架构：$ARCH"; exit 1 ;;
esac

CUR_VER="$(cat "$(readlink "$CURRENT_LINK")/.version" 2>/dev/null || echo '0.0.0')"
log "当前版本：$CUR_VER"

TAG="$(gh_text "https://api.github.com/repos/${REPO}/releases/latest" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
[[ -n "$TAG" ]] || { err "无法查询 GitHub（网络问题？可手动下载）"; exit 1; }
NEW_VER="${TAG#v}"
log "最新版本：$NEW_VER"

if [[ "$CUR_VER" == "$NEW_VER" ]]; then
  log "已是最新版本，无需升级"
  exit 0
fi
[[ "$MODE" == "check" ]] && { log "有新版本：$NEW_VER"; exit 0; }

# ---------- 下载 ----------
ASSET="onepanel-${NEW_VER}-${ARCH_TAG}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "下载 $ASSET …"
gh_fetch "$URL" "$TMP/pkg.tar.gz" 600 || { err "下载失败（可设 GH_PROXY=https://ghfast.top 重试）"; exit 1; }
if gh_fetch "${URL}.sha256" "$TMP/pkg.sha256" 20 2>/dev/null; then
  EXP="$(awk '{print $1}' "$TMP/pkg.sha256")"
  ACT="$(sha256sum "$TMP/pkg.tar.gz" | awk '{print $1}')"
  [[ "$EXP" == "$ACT" ]] || { err "sha256 校验失败"; exit 1; }
  log "校验通过"
fi

# ---------- 解压到新目录 ----------
NEW_DIR="${INSTALL_DIR}/versions/${NEW_VER}"
rm -rf "$NEW_DIR"; mkdir -p "$NEW_DIR"
tar -xzf "$TMP/pkg.tar.gz" -C "$NEW_DIR" --strip-components=1 || { err "解压失败"; exit 1; }
echo "$NEW_VER" > "$NEW_DIR/.version"

# ---------- 切换 + 重启 ----------
OLD_TARGET="$(readlink "$CURRENT_LINK")"
ln -sfn "$NEW_DIR" "$CURRENT_LINK"
log "已切换软链接"

systemctl restart onepanel 2>/dev/null || warn "systemctl restart 失败（非 systemd 环境需手动重启）"

log "等待健康检查…"
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "✅ 升级成功：$CUR_VER -> $NEW_VER"
    # 清理旧版本，保留 $KEEP 份
    ls -1dt "${INSTALL_DIR}"/versions/*/ 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
      [[ "$old" == "$NEW_DIR/" ]] && continue
      rm -rf "$old"
      log "清理旧版本：$(basename "$old")"
    done
    exit 0
  fi
  sleep 2
done

# ---------- 失败回滚 ----------
err "新版本启动失败，回滚到 $OLD_TARGET"
ln -sfn "$OLD_TARGET" "$CURRENT_LINK"
systemctl restart onepanel 2>/dev/null || true
sleep 5
if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  err "已回滚到 $(basename "$OLD_TARGET")，服务正常"
  rm -rf "$NEW_DIR"
  exit 1
fi
err "回滚后仍不健康，需要人工介入：journalctl -u onepanel -n 80"
exit 2
