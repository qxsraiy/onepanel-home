# OnePanel · 个人数字枢纽

> 私人书签仪表盘 · 多节点自动同步 · 端到端加密 · 支持手机桌面小组件

**本仓库只放正式版本。** 开发过程、审计记录、临时脚本一律不进这里。
包含**当前版本的源码快照**（`backend/` + `frontend/`），供 CI 自动构建三架构发布包。

当前版本：**v3.11.3** · 默认端口 **5266**

---

## 三种安装方式

| 方式 | 命令 | 自动升级 | 自动回滚 |
|---|---|---|---|
| **① 脚本（推荐）** | `curl ... | bash` 或 `bash install.sh` 出菜单 | ✅ | ✅ |
| **② Docker** | `docker compose up -d` | 手动 pull | 手动 |
| **③ 便携包** | 下载 zip 解压即用（Windows） | 手动替换 | 手动 |

---

## ① 脚本安装

### 一键安装（无交互）

```bash
curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh | bash
```

### 带菜单的管理脚本（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh -o /root/op.sh
bash /root/op.sh
```

会显示：

```
╔══════════════════════════════════════════════╗
║            OnePanel 管理菜单                  ║
╠══════════════════════════════════════════════╣
║  1) 安装 / 升级到最新版                       ║
║  2) 卸载（可选择是否保留数据）                 ║
║  3) 修改端口                                  ║
║  4) 查看运行状态                              ║
║  5) 重启服务                                  ║
║  6) 查看实时日志                              ║
║  7) 回滚上一版本                              ║
║  8) 开启/关闭自动更新                         ║
║  0) 退出                                      ║
╚══════════════════════════════════════════════╝
```

选 **1** 后逐项询问：

```
  ① 服务端口 [5266]:
  ② 安装目录 [/opt/onepanel]:
  ③ 数据目录（升级不影响）[/var/lib/onepanel]:
  ④ 注册为系统服务 systemd？[Y/n]:
  ⑤ 开启每日自动检查更新？[y/N]:
  ⑥ 安装指定版本（留空 = 最新）:

  ── 即将安装 ──
     端口：5266
     安装目录：/opt/onepanel
     数据目录：/var/lib/onepanel
     systemd：是
     自动更新：否
     版本：最新

  确认开始安装？[Y/n]:
```

### install.sh 参数（非交互直接用）

| 参数 | 说明 | 默认 |
|---|---|---|
| `--port N` | 服务端口 | **5266** |
| `--dir PATH` | 安装目录 | `/opt/onepanel` |
| `--data PATH` | 数据目录（升级不动） | `/var/lib/onepanel` |
| `--auto-update` | 创建自动更新计划任务 | 关闭 |
| `--no-systemd` | 不注册 systemd | — |
| `--version X.Y.Z` | 安装指定版本 | 最新 |
| `--pkg FILE` | **用本地安装包**（国内最稳） | — |
| `--url URL` | 从指定地址下载包 | — |

### 国内网络说明

**GitHub Release 的 86MB 包在国内经常下载不动**。三个办法：

```bash
# ① 用浏览器/IDM/迅雷下载包，再 scp 上去（最稳）
scp onepanel-3.11.3-linux-x64.tar.gz root@服务器:/root/
bash /root/op.sh --pkg /root/onepanel-3.11.3-linux-x64.tar.gz

# ② 指定镜像下载脚本（包还是要上面那种方式）
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh -o /root/op.sh

# ③ 服务器有代理
export https_proxy=http://127.0.0.1:7890
curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh | bash
```

> **不要用 jsDelivr 的 `@main`**：它有 12 小时缓存，会拿到旧版脚本。
> 要用 jsDelivr 就指定 tag：`@v3.11.3`

### 自动更新

**普通 Linux**（自动写 crontab）：

```bash
bash install.sh --auto-update        # 或安装向导里选 y
crontab -l                           # 能看到这条
```

**宝塔面板**（宝塔有独立任务库，不读系统 crontab，还会覆盖它）：

安装脚本检测到宝塔会自动提示。请手动添加：

```
宝塔 → 计划任务 → 添加任务
  任务类型：Shell 脚本
  任务名称：OnePanel 自动更新
  执行周期：每天 4 点
  脚本内容：bash /opt/onepanel/current/upgrade.sh --auto
```

### 升级 / 回滚

```bash
bash /opt/onepanel/current/upgrade.sh            # 升级
bash /opt/onepanel/current/upgrade.sh --check    # 只检查
bash /opt/onepanel/current/upgrade.sh --rollback # 回滚
```

升级流程：查最新 → 比对版本 → 下载 → sha256 校验 → 解压新目录 → 原子切换软链接 → 重启 → 20 次健康检查 → **失败自动切回旧版本**。保留 2 个旧版本。

---

## ② Docker

```bash
git clone https://github.com/qxsraiy/onepanel-home.git
cd onepanel-home
docker compose up -d
```

- 端口 `5266`
- 数据在 `./data`（volume）
- 升级：`docker compose pull && docker compose up -d`

---

## ③ 便携包（Windows）

去 [Releases](../../releases) 下载 `onepanel-portable-v*-win-x64.zip`，解压双击启动。

升级：下载新 zip，把旧 `data/` 拷过去。

---

## 目录结构（脚本版）

```
/opt/onepanel/
  ├─ current -> versions/3.11.3     ← 软链接，原子切换
  ├─ versions/
  │    ├─ 3.11.2/                   ← 保留 2 个用于回滚
  │    └─ 3.11.3/
  ├─ runtime/node/                  ← 系统没 Node 时自动下载
  └─ onepanel.env                   ← 端口/域名配置

/var/lib/onepanel/                  ← 数据目录（升级永不触碰）
  └─ onepanel.db
```

---

## 首次登录

```
账号：admin
密码：123456        ← 首次登录强制改密（≥8 位，含数字或符号）
```

---

## 多节点部署

节点之间通过「设置 → 共享网络」配对入网。建议所有节点配同一个父域的 HTTPS 域名，并在 `onepanel.env` 里加：

```bash
COOKIE_DOMAIN=.yourdomain.com
COOKIE_SECURE=1
WEBAUTHN_RP_ID=yourdomain.com
WEBAUTHN_HOSTS=cn.yourdomain.com,us.yourdomain.com,panel.yourdomain.com
```

这样登录态（Cookie）与 Passkey 可跨节点通用。

---

## 版本历史

| 版本 | 说明 |
|---|---|
| **v3.11.3** | ✅ 当前版本。包内容完整（schema.sql + backend/public + 全部依赖 + Prisma 引擎） |
| v3.11.2 | 修 systemd 直接用 node 启动，但包缺前端产物 |
| v3.11.1 | 补 schema.sql，但 systemd 依赖包内不存在的 manage.sh |
| v3.11.0 | 首个发布，包缺 schema.sql 导致启动失败 |

> v3.11.0 ~ v3.11.2 已删除（安装包不完整），**请只用 v3.11.3**。

---

## 技术栈

- 后端：Node 22 + Express 5 + Prisma/SQLite
- 前端：Vue 3 + Vite
- 加密：AES-256-GCM（卡片内容）、scrypt（密码派生）、Ed25519（节点签名）
- 同步：HLC + StateVector 增量同步，墓碑优先 LWW
- 认证：JWT + HttpOnly Cookie（跨子域共享）+ TOTP 2FA + Passkey（PRF 指纹解锁保险库）
