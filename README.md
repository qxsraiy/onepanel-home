# OnePanel · 个人数字枢纽

> 私人书签仪表盘 · 多节点自动同步 · 端到端加密 · 支持手机桌面小组件

**只存放正式版本**。开发记录在私有仓库。

> 本仓库同时包含**当前版本的源码快照**（`backend/` + `frontend/`），
> 供 CI 自动构建三架构发布包。开发历史、审计记录、临时脚本一律不进这里。

---

## 三种安装方式

### ① 脚本安装（推荐，支持自动升级）

```bash
curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh | bash
```

自定义：

```bash
curl -fsSL .../install.sh | bash -s -- --port 8080 --dir /opt/onepanel --data /var/lib/onepanel --auto-update
```

| 参数 | 说明 | 默认 |
|---|---|---|
| `--port N` | 服务端口 | **5266** |
| `--dir PATH` | 安装目录 | `/opt/onepanel` |
| `--data PATH` | 数据目录（升级不动） | `/var/lib/onepanel` |
| `--auto-update` | 创建每天检查更新的计划任务 | 关闭 |
| `--no-systemd` | 不注册 systemd | — |
| `--version X.Y.Z` | 安装指定版本 | 最新 |

安装后：

```bash
bash /opt/onepanel/current/upgrade.sh            # 升级
bash /opt/onepanel/current/upgrade.sh --check    # 只检查
bash /opt/onepanel/current/upgrade.sh --rollback # 回滚上一版
```

### ② Docker

```bash
git clone https://github.com/qxsraiy/onepanel-home.git
cd onepanel-home
docker compose up -d
```

升级：`docker compose pull && docker compose up -d`

### ③ 单文件版（Windows / 便携）

去 [Releases](../../releases) 下载 `onepanel-portable-v*-win-x64.zip`，解压双击启动。

升级：下载新 zip，把旧 `data/` 拷过去。

---

## 默认端口 5266

三种安装方式默认都用 **5266**，可用环境变量 `PORT` 或安装参数覆盖。

---

## 首次登录

```
账号：admin
密码：123456   ← 首次登录强制改密（≥8 位，含数字或符号）
```

---

## 多节点部署

节点之间通过「设置 → 共享网络」配对入网。所有节点建议配同一个父域的 HTTPS 域名，并使用：

```bash
COOKIE_DOMAIN=.yourdomain.com
COOKIE_SECURE=1
WEBAUTHN_RP_ID=yourdomain.com
WEBAUTHN_HOSTS=cn.yourdomain.com,us.yourdomain.com
```

这样登录态与 Passkey 可跨节点通用。

---

## 升级机制

| 安装方式 | 升级 | 自动回滚 |
|---|---|---|
| 脚本版 | ✅ 自动（下载→校验→切换→重启） | ✅ 启动失败自动切回 |
| Docker | 手动 `compose pull` | 手动 |
| 单文件版 | 手动下载替换 | 手动 |

脚本版的目录结构：

```
/opt/onepanel/
  ├─ current -> versions/3.11.0     ← 软链接（原子切换）
  ├─ versions/
  │    ├─ 3.10.0/                   ← 保留 2 个旧版本用于回滚
  │    └─ 3.11.0/
  └─ onepanel.env                   ← 端口/域名配置

/var/lib/onepanel/                 ← 数据目录（升级永不触碰）
  └─ onepanel.db
```

---

## 数据安全

- 卡片内容全部加密存储（AES-256-GCM），主密钥由你的密码派生
- 备份与云同步可选 WebDAV，增量去重
- 支持 2FA、Passkey（含 PRF 指纹解锁保险库）
