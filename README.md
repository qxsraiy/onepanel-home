# OnePanel · 个人数字枢纽

> 私人书签仪表盘 · 多节点自动同步 · 端到端加密 · 手机桌面小组件

**本仓库只放正式版本。** 包含当前版本的源码快照，供 CI 构建发布包。

当前版本：**v3.28.3** · 默认端口 **5266**

---

## 🚀 快速安装

**不需要区分国内外** —— 脚本会自动探测网络环境，选择最快的源。

### 国内（Gitee，秒开）

```bash
curl -fsSL "https://gitee.com/a1225/onepanel-home/raw/main/op.sh?t=$(date +%s)" -o /root/op.sh
bash /root/op.sh
```

> **`?t=$(date +%s)` 必须带** —— Gitee raw 有 10~30 分钟 CDN 缓存，不加参数可能拿到旧版。

### 国外（GitHub 直连）

```bash
curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/op.sh -o /root/op.sh
bash /root/op.sh
```

### 镜像仓库

| 平台 | 地址 | 内容 |
|---|---|---|
| **GitHub** | https://github.com/qxsraiy/onepanel-home | 全量（x64 + arm64 + 便携包） |
| **Gitee（国内）** | https://gitee.com/a1225/onepanel-home | 代码 + **x64 包** |

### 脚本自动选源

启动时探测网络（4 秒内能否访问 gitee.com），决定优先级：

**国内**：`down.xtay.cn` → `Gitee` → 公共镜像 → GitHub

**海外**：`GitHub` → 公共镜像 → `down.xtay.cn` → Gitee

任意源失败自动试下一个，日志会显示实际用的是哪个：

```
[onepanel] 下载源：https://gitee.com/a1225/onepanel-home/releases/download/v3.28.3/...
```
## 📦 网络不好 / 包下载不动

GitHub Release 的 86MB 包在国内经常超时。用浏览器下载后传上去：

```bash
# ① 电脑浏览器下载（能走代理、多线程）
# https://github.com/qxsraiy/onepanel-home/releases/latest

# ② scp 到服务器
scp onepanel-*-linux-x64.tar.gz* root@服务器:/root/

# ③ 用本地包安装（完全不联网）
bash /root/op.sh --pkg /root/onepanel-3.14.1-linux-x64.tar.gz
```

**架构自动识别**：

| 你的机器 `uname -m` | 自动选 |
|---|---|
| x86_64 / amd64 | `linux-x64` |
| aarch64 / arm64 / armv8l | `linux-arm64` |
| armv7l / armhf（32 位 ARM） | ❌ 提示改用 Docker |
| Alpine（musl libc） | ❌ 提示改用 Docker |

**系统没有 Node 18+ 会自动下载**官方 Node 22 到 `/opt/onepanel/runtime/node/`。

---

## 🔄 升级

```bash
bash /root/op.sh          # 选 1（对比版本，有新版就升级）
```

或直接用升级脚本：

```bash
bash /opt/onepanel/current/upgrade.sh                        # 升级
bash /opt/onepanel/current/upgrade.sh --check                # 只检查
bash /opt/onepanel/current/upgrade.sh --rollback             # 回滚
bash /opt/onepanel/current/upgrade.sh --pkg /root/xxx.tar.gz # 本地包升级
```

**升级流程**：

```
查最新 → 比对版本 → 下载 → sha256 校验 → 解压新目录
→ 原子切换软链接 → 重启 → 20 次健康检查
   ✅ 成功 → 清理旧版本（保留 2 份）
   ❌ 失败 → 自动切回旧版本 + 重启
```

**目录结构**：

```
/opt/onepanel/
  ├─ current -> versions/3.14.1     ← 软链接，原子切换
  ├─ versions/
  │    ├─ 3.14.0/                   ← 保留 2 个用于回滚
  │    └─ 3.14.1/
  ├─ runtime/node/                  ← 系统没 Node 时自动下载
  └─ onepanel.env                   ← 端口/域名配置

/var/lib/onepanel/                  ← 数据目录（升级永不触碰）
  └─ onepanel.db
```

---

## ⏰ 自动更新

### 普通 Linux

安装时选「开启每日自动检查更新」，或菜单第 8 项。

```bash
crontab -l    # 能看到这条
```

### 宝塔面板

**宝塔有独立任务库，不读系统 crontab，还会覆盖它。** 安装脚本检测到宝塔会自动提示，请手动添加：

```
宝塔 → 计划任务 → 添加任务
  任务类型：Shell 脚本
  任务名称：OnePanel 自动更新
  执行周期：每天 4 点
  脚本内容：bash /opt/onepanel/current/upgrade.sh --auto
```

---

## 🌐 域名 + HTTPS（反代）

**推荐：Cloudflare 小黄云 + 源站证书**

```
用户 → https://panel.xtay.cn（CF 的 443，不需要备案）
     → CF 回源到你的服务器 8443（非标端口，云厂商不封）
```

### Cloudflare 后台

1. DNS 加 A 记录 `panel` → 服务器 IP，**开小黄云**
2. SSL/TLS → Origin Server → Create Certificate → 保存证书和私钥
3. SSL/TLS → Overview → **Full (strict)**
4. SSL/TLS → Edge Certificates → Always Use HTTPS 开启
5. Rules → Origin Rules → 回源端口改成 **8443**

### 宝塔后台

1. 网站 → 添加站点 → 域名填 `panel.xtay.cn`（**不带端口**）→ 纯静态
2. 设置 → SSL → **其他证书** → 粘贴 CF 的证书和私钥 → 保存
3. 设置 → 配置文件 → 把 `listen 443 ssl` 改成 `listen 8443 ssl`
4. 设置 → 反向代理 → 添加 → 目标 `http://127.0.0.1:5266` → 发送域名 `$host`
5. 设置 → 反向代理 → onepanel → 配置文件 → **补一行**：

   ```nginx
   proxy_set_header X-Forwarded-Proto $scheme;
   ```

6. 安全 → 防火墙 → 放行 8443
7. **云厂商安全组也要放行 8443**（最容易漏）

### 后端配置（只有第一台要配）

```bash
# 宝塔 → 文件 → /opt/onepanel/onepanel.env
COOKIE_DOMAIN=.xtay.cn
WEBAUTHN_RP_ID=xtay.cn
```

```bash
systemctl restart onepanel
```

> 后加的节点入网时自动继承这两个值，不用配。

---

## 🌍 多节点部署

### 第一台（配置源头）

```
装好 → 配 Nginx 反代 → 在 onepanel.env 里配 COOKIE_DOMAIN / WEBAUTHN_RP_ID → 重启
```

### 第二台起

```
装好 → 配 Nginx 反代 → 登录 → 设置 → 共享网络 → 入网
     → 域名配置自动继承，什么都不用配
```

**加第 N 台节点时，老节点一个字都不用改。**

### 多节点登录态

**同一个浏览器不能同时登录多个节点** —— 所有节点共用 `Domain=.xtay.cn` 的 Cookie，会互相覆盖。

解法：

- **统一各节点的 `JWT_SECRET`**（同一把钥匙签发的 token 全网通用，不会互相踢）
- 或用不同浏览器 / 无痕窗口分别登录

### 入网方式

| 方式 | 需要人工批准 | 说明 |
|---|---|---|
| **配对串**（二维码/授权码） | ❌ 不用 | 生成一次性码本身就是授权动作 |
| **账号密码** | ✅ 需要 | 老节点面板弹「待批准的入网请求」，点批准才放行 |

**安全设计**：

- 登录页不会显示「重新选择」，已初始化的节点无法被重置
- 账号密码入网必须老节点管理员点批准（防密码泄露被人抢注空库）
- 待批准请求 5 分钟超时，老节点重启即失效

### 已入网但域名配置是空的（升级到 v3.14.1 后）

```
自动：启动后 8 秒向已入网节点要一次
手动：设置 → 共享网络 → 网络域名配置 → [从其他节点自动拉取]
```

---

## 🐳 Docker 部署

```bash
git clone https://github.com/qxsraiy/onepanel-home.git
cd onepanel-home
docker compose up -d
```

- 端口 `5266`
- 数据在 `./data`（volume）
- 升级：`docker compose pull && docker compose up -d`

---

## 💻 首次登录

```
账号：admin
密码：123456      ← 首次登录强制改密（≥8 位，含数字或符号）
```

---

## 🧩 浏览器扩展

```
面板 → 设置 → 浏览器扩展 → 下载扩展包（zip）
→ 解压到固定目录
→ chrome://extensions → 开发者模式 → 加载已解压的扩展程序
→ 点扩展图标 → 填节点地址 + Token（设置 → API 接口 生成）
```

扩展会**自动读取你在面板里设置的主题色**，外观与网页端一致。

---

## 📊 全网节点状态

```
设置 → 共享网络 → 网络拓扑
```

鼠标悬停任意节点圆圈，底部浮条显示：

- 在线/离线
- 版本号
- CPU 占用 + 核心数
- 内存使用
- 磁盘使用
- 已运行时长
- 最后同步时间

---

## 📄 版本历史

| 版本 | 主要变更 |
|---|---|
| **v3.28.3** | 修复 op.sh 里 JS 注释被 bash 当命令执行 |
| v3.28.2 | 菜单第 1 项：已装走升级、未装才安装 |
| v3.28.1 | 脚本自动判断国内外 + 包裁剪到 54MB |
| v3.28.0 | Passkey 跨节点同步 + 打开设置拉最新配置 |
| v3.27.1 | 登录页通行密钥按钮修复 + 2FA 页可切换 |
| v3.27.0 | 卡片样式同步 + passkey status 500 修复 |
| v3.26.0 | Passkey user.id 随机（修认证器去重） |
| v3.25.0 | 登录页通行密钥入口 + 拓扑固定顶部 |
| v3.24.0 | 删解密转移JSON + PRF salt 类型修复 |
| v3.23.0 | 共享网络三区块改折叠 |
| v3.22.0 | 删编辑弹窗里的桌面小组件选择器 |
| v3.21.1 | 入网轮询限流修复 |
| v3.21.0 | 入网方式统一为账号密码 + 人工批准 |
| v3.20.0 | PWA 文件缺失 + readThemeCookie 修复 |
| v3.19.1 | Cookie 按请求动态决定 |
| v3.19.0 | 初始化向导填域名配置 |
| v3.18.0 | 域名配置可在面板界面改 |
| v3.17.0 | arm64 缺 Prisma 引擎修复 |
| v3.14.0 | 网络域名配置入网自动继承 |
| v3.13.0 | 入网需人工批准 |
| v3.11.0 | 三种安装方式 + 升级接口 |

---

## 🛠 技术栈

- **后端**：Node 22 + Express 5 + Prisma/SQLite
- **前端**：Vue 3 + Vite
- **加密**：AES-256-GCM（卡片）、scrypt（密码派生）、Ed25519（节点签名）
- **同步**：HLC + StateVector 增量同步，墓碑优先 LWW
- **认证**：JWT + HttpOnly Cookie（跨子域共享）+ TOTP 2FA + Passkey（PRF 指纹解锁）