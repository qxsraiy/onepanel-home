/**
 * OnePanel 后端主程序
 * ------------------------------------------------------------------
 * v2.0.0 变更要点：
 *  - JWT 密钥不再硬编码：优先环境变量 JWT_SECRET，否则首启随机生成并持久化
 *  - 备份剥离全部敏感字段（WebDAV 密码 / 企微 Secret / 2FA 种子等）
 *  - 恢复流程先判定文件类型再分支，物理库恢复前自动快照，未知文件绝不落盘
 *  - 全部异步路由统一错误兜底 + JSON 错误中间件，登录接口增加限速
 *  - 移除邮箱功能（IMAP / Cloud-Mail）相关接口与字段
 *  - 新增 /api/items/:id/probe（多线路探活交给后端，绕开混合内容与 CORS 限制）
 *  - 新增 /api/config/groups（只改分组，避免整包回写互相覆盖）
 *  - 备份写盘做防抖合并，避免高频写放大
 * v2.2.0 变更要点：
 *  - Item 新增 isHidden / isPinned（隐藏卡、置顶卡），新增 PUT /api/items/:id/flags 轻量切换
 *  - PUT /api/items/:id 只在请求显式带 urls 时重建地址表，避免改标记清空线路
 * v2.10.0 变更要点：
 *  - 主密钥改由管理员密码包裹存库（scrypt 派生 KEK + AES-GCM），不用再单独记 APP_SECRET
 *  - 新增 GET /api/vault/status 与 POST /api/vault/unlock|lock；登录自动解锁，进程重启后需手动解锁
 *  - 锁定态：备忘录不下发明文、写入/恢复/导入 423、自动备份暂停
 * v2.9.0 变更要点：
 *  - 备份只保留加密 .opb（旧 .gz 启动时挪进 backups/legacy，恢复接口不再接受明文包）
 *  - JSON 配置导出/导入与转移导出合并：POST /api/transfer/import（同样二次验证），删除 export-json / import-json
 * v2.8.0 变更要点：
 *  - 备忘录 AES-256-GCM 加密入库（cryptoBox），老数据启动时自动迁移；只对已登录请求解密下发
 *  - 备份包（本地 + WebDAV）整包加密，恢复时自动解密，旧明文 .gz 仍兼容
 *  - 新增 POST /api/transfer/export：密码或 2FA 二次校验后，导出含备忘录的明文转移 JSON
 * v2.6.0 变更要点：
 *  - Item 新增 memo（JSON：{ note, entries[{label,value,masked}], updatedAt }）
 *  - 新增 PUT /api/items/:id/memo（白名单字段 + 20KB 上限），导出/导入/备份均携带
 * v2.5.0 变更要点：
 *  - 新增 GET /api/widgets/weather（services/weather.js）：代理 wttr.in，10 分钟缓存
 *  - 小组件类型白名单增加 weather
 * v2.4.0 变更要点：
 *  - Item 新增 widgetType / widgetConfig（桌面小组件：system / clock），小组件卡不要求填网址
 *  - JSON 导入导出、备份恢复一并携带小组件字段
 * v2.3.0 变更要点：
 *  - 新增 GET /api/system/stats（systemStats 服务），给前端系统状态面板与监测页提供数据
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const QRCode = require('qrcode');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('webdav');

const pingMonitor = require('./services/pingMonitor');
const wechatNotify = require('./services/wechatNotify');
const { probeFastestUrl } = require('./services/urlProbe');
const { getSystemStats } = require('./services/systemStats');
const { getWeather } = require('./services/weather');
const cryptoBox = require('./services/cryptoBox');
const vault = require('./services/vault');
const hlcClock = require('./services/hlc');
const nodeIdentity = require('./services/identity');
const nodeState = require('./services/nodeState');
const itemStore = require('./services/itemStore');
const syncEngine = require('./services/syncEngine');
const blobStore = require('./services/blobStore');
const { cleanPeerUrls } = require('./services/peerUrls');

const app = express();
const prisma = new PrismaClient();
// 【v3.11.0】默认端口改为 5266（可用 PORT 覆盖）
const PORT = Number(process.env.PORT || 5266);

// ====== 🔐 密钥：环境变量优先，否则随机生成并持久化（绝不再硬编码） ======
// 【修复 N9】token 的吊销纪元：改密/踢人时递增，旧 token 立即失效
let tokenEpoch = 0;   // 内存缓存，启动时从 AppConfig.tokenEpoch 加载
const bumpTokenEpoch = () => {
  tokenEpoch += 1;
  // 【B-05】必须持久化：否则重启后 tokenEpoch 归零，改密码时作废的旧 JWT 会复活
  prisma.$executeRawUnsafe('UPDATE AppConfig SET tokenEpoch = ? WHERE id = 1', tokenEpoch).catch(() => {});
};

const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return process.env.JWT_SECRET;
  const keyFile = process.env.JWT_SECRET_FILE || path.join(__dirname, '.jwt-secret');
  try {
    if (fs.existsSync(keyFile)) {
      const saved = fs.readFileSync(keyFile, 'utf8').trim();
      if (saved.length >= 32) return saved;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
    console.warn('⚠️  未检测到 JWT_SECRET 环境变量，已生成随机密钥并写入:', keyFile);
    console.warn('⚠️  建议在 docker-compose 中显式设置 JWT_SECRET，否则清空该文件会导致所有登录失效。');
    return generated;
  } catch (e) {
    console.error('❌ 读写 JWT 密钥文件失败，本次运行使用临时随机密钥（重启后需重新登录）:', e.message);
    return crypto.randomBytes(32).toString('hex');
  }
})();

// ====== 🧰 通用工具 ======
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const TZ = process.env.TZ || 'Asia/Shanghai';
const getFormattedDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  // 统一按 TZ 输出，避免容器 UTC 导致文件名与告警时间错 8 小时
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  return `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}_${p(local.getHours())}-${p(local.getMinutes())}-${p(local.getSeconds())}`;
};

// ====== 🛡️ 基础中间件 ======
app.disable('x-powered-by');
// 【修复 N6】默认**不**信任代理：服务直连时攻击者换个 X-Forwarded-For 就能绕过所有限流。
// 确实挂在 Nginx/Caddy/CF Tunnel 后面时，用 TRUST_PROXY=1 显式开启。
if (String(process.env.TRUST_PROXY || '') === '1') {
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', false);
}
app.use(helmet({
  contentSecurityPolicy: false,      // 面板大量内联样式/属性，默认 CSP 会破坏界面；如需可自行开启
  crossOriginEmbedderPolicy: false,  // 内嵌 iframe（锁定内嵌卡）需要
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true;
app.use(cors({ origin: corsOrigin }));
// 【B-08】默认收紧到 8MB（原来 20MB，单个请求就能吃掉大量内存）；备份恢复接口单独放宽
app.use(express.json({ limit: process.env.JSON_LIMIT || '8mb' }));
app.use(express.urlencoded({ limit: process.env.JSON_LIMIT || '8mb', extended: true }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT || 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { error: '尝试次数过多，请 15 分钟后再试' },
});

// ====== 系统初始化 ======
async function initSystem() {
  // 【v3.3.0】便携包目标机器没有 prisma CLI：首次启动自动建表
  try {
    const { ensureSchema } = require('./services/schemaBootstrap');
    await ensureSchema(prisma);
  } catch (e) {
    console.warn('⚠️ 自动建表失败:', e.message);
  }

  // v3.0.0：节点身份、HLC、状态表
  const me = nodeIdentity.loadOrCreateIdentity();
  nodeState.init(prisma);
  itemStore.init(prisma);
  await nodeState.warm();
  // 【修复 N5】被污染（超前）的持久化 HLC 要能自愈，否则重启都救不回来
  const savedHlc = nodeState.get('hlc', '');
  if (savedHlc && hlcClock.isTooFarAhead(savedHlc, 5 * 60 * 1000)) {
    console.warn('⚠️ 本地 HLC 超前系统时间过多（' + savedHlc + '），已重置为当前时间');
    await nodeState.set('hlc', hlcClock.next(me.nodeId));
  } else {
    hlcClock.restore(savedHlc);
  }
  if (!nodeState.get('nodeId', '')) await nodeState.set('nodeId', me.nodeId);
  if (!nodeState.get('hlc', '')) await nodeState.set('hlc', hlcClock.next(me.nodeId));
  console.log(`🆔 节点身份 ${me.nodeId}`);

  // 同步引擎 + 成员自举（自己也要在成员表里，别人才能认得）
  // 【B-05】从数据库加载 tokenEpoch（否则重启归零 -> 旧 JWT 复活）
  try {
    const rs = await prisma.$queryRawUnsafe('SELECT tokenEpoch FROM AppConfig WHERE id = 1');
    tokenEpoch = Number((rs && rs[0] && rs[0].tokenEpoch) || 0);
  } catch { tokenEpoch = 0; }

  // 【E-09】检查私钥文件权限（Linux/macOS 上过宽会自动修正为 600）
  try { nodeIdentity.checkKeyPermissions && nodeIdentity.checkKeyPermissions(); } catch { /* 忽略 */ }

  syncEngine.init(prisma, itemStore);
  // 【自检修复 BUG-D】收到别人改密码后，本机的旧 JWT 也应失效
  syncEngine.setOnConfigApplied(() => bumpTokenEpoch());
  // 【P1-11】远端卡片变更后重建明文快照（防抖 2 秒），
  // 否则别的节点改了书签，本机的 App 快照会一直停在旧版本
  syncEngine.setOnItemsApplied(() => { try { scheduleSnapshotRebuild(); } catch { /* 忽略 */ } });
  blobStore.init(prisma, async () => {
    const c = await prisma.appConfig.findUnique({ where: { id: 1 } });
    if (!c || !c.webdavUrl || !c.webdavUser || !c.webdavPass) return null;
    return createClient(c.webdavUrl, { username: c.webdavUser, password: c.webdavPass });
  });
  await prisma.member.upsert({
    where: { nodeId: me.nodeId },
    create: {
      nodeId: me.nodeId,
      publicKey: me.publicKeyPem,
      selfUrls: String(nodeState.get('selfUrls', '') || ''),
      role: 'self',
      status: 'active',
      lastSeen: new Date(),
    },
    update: {
      publicKey: me.publicKeyPem,
      selfUrls: String(nodeState.get('selfUrls', '') || ''),
      role: 'self',
      status: 'active',
      lastSeen: new Date(),
    },
  });

  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    const defaultHash = await bcrypt.hash('123456', 10);
    await prisma.appConfig.create({
      data: { id: 1, username: 'admin', password: defaultHash, isFirstLogin: true },
    });
    console.log('✅ 系统初始化完成：默认账号 [admin] 默认密码 [123456]，首次登录会强制改密');
  }
  // 既存"密码包裹的密钥"又设了 APP_SECRET：两者不一定相同，不同就解不开旧数据
  if (vault.envSecret() && config?.vaultWrapped) {
    console.warn('⚠️ 检测到已有密码包裹的数据密钥，同时又设置了 APP_SECRET。');
    console.warn('   如果这个 APP_SECRET 与当初包裹时用的不是同一把钥匙，旧备忘录/备份会解不开。');
  }
  // 监测引擎需要解密后的 pingUrl（v3.0.0 整行加密）
  pingMonitor.setMonitorProvider(async () => {
    if (vault.isLocked()) return [];
    const list = await itemStore.listAll({ locked: false, strict: true });
    return list.filter((i) => i.isMonitored);
  });
  pingMonitor.start(); // 后台监测大轮询
  // 【采纳建议 5.2】PEERS=http://a:3000,http://b:3000 → 启动自动登记成员（docker compose 免手点）
  const peersEnv = String(process.env.PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const u of peersEnv) {
    try {
      const info = await fetch(u.replace(/\/$/, '') + '/api/node/info', { signal: AbortSignal.timeout(4000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!info || !info.nodeId || info.nodeId === nodeIdentity.self().nodeId) continue;
      await prisma.member.upsert({
        where: { nodeId: info.nodeId },
        create: { nodeId: info.nodeId, publicKey: info.publicKey, selfUrls: u, role: 'peer', status: 'active', lastSeen: new Date() },
        update: { publicKey: info.publicKey, selfUrls: u, status: 'active' },
      });
      console.log('🔗 已按 PEERS 登记成员: ' + info.nodeId.slice(0, 6) + ' @ ' + u);
    } catch { /* 忽略单个不可达 */ }
  }
  pruneSyncTables();
  setInterval(pruneSyncTables, 24 * 3600 * 1000).unref?.();
}

// ====== 📦 备份与同步模块 ======
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

// 这些字段绝不进入备份文件（备份会被推到第三方云盘）
const SENSITIVE_CONFIG_KEYS = [
  'username', 'password', 'isFirstLogin',
  'webdavPass', 'wechatCorpSecret', 'twoFactorSecret',
];

// v2.9.0 起只认加密容器 .opb；旧版明文 .gz 不再支持（启动时会被挪到 backups/legacy/）
const BACKUP_FILE_RE = /^backup_[\d_\-]+\.opb$/;
const LEGACY_BACKUP_RE = /\.(json|db)\.gz$/;

let isBackingUp = false;
let backupTimer = null;

// ====== 🔑 口令保险库（v2.10.0）：主密钥由管理员密码包裹 ======
/**
 * 用密码解锁保险库。三种情况：
 *  - 设了 APP_SECRET：本来就不用解锁，直接 true
 *  - 库里已有包裹（vaultWrapped）：解开并放入内存
 *  - 首次（还没有包裹）：把老的 .secret-key 内容（没有就新生成一份）用当前密码包裹后存库
 */
async function unlockVaultWithPassword(config, password) {
  if (vault.envSecret()) return true;
  if (config?.vaultWrapped && config?.vaultSalt) {
    try {
      vault.setSecret(vault.unwrapSecret(config.vaultWrapped, config.vaultSalt, password), 'password');
      return true;
    } catch {
      return false;
    }
  }
  // 首次：接管老密钥文件（保证已有备忘录/备份继续可解）或新生成
  const secret = cryptoBox.readLegacyKey() || require('crypto').randomBytes(32).toString('hex');
  const { salt, wrapped } = vault.wrapSecret(secret, password);
  await prisma.appConfig.update({ where: { id: 1 }, data: { vaultSalt: salt, vaultWrapped: wrapped } });
  vault.setSecret(secret, 'password');
  console.log('🔐 已用管理员密码包裹数据密钥：以后不需要单独记 APP_SECRET / .secret-key 了');
  return true;
}

/** 改密码时重新包裹，数据本身不用重加密 */
async function rewrapVaultForNewPassword(oldPassword, newPassword) {
  if (vault.envSecret()) return;
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  let secret = vault.getSecret();
  if (!secret && config?.vaultWrapped && config?.vaultSalt) {
    secret = vault.unwrapSecret(config.vaultWrapped, config.vaultSalt, oldPassword);
  }
  if (!secret) secret = cryptoBox.readLegacyKey() || require('crypto').randomBytes(32).toString('hex');
  const { salt, wrapped } = vault.wrapSecret(secret, newPassword);
  await prisma.appConfig.update({ where: { id: 1 }, data: { vaultSalt: salt, vaultWrapped: wrapped } });
  vault.setSecret(secret, 'password');
}

/** 备忘录入库统一走这里：明文加密，已经是密文的原样保留 */
const encryptMemoForStore = (raw) => {
  const normalized = normalizeMemo(raw);
  if (!normalized) return null;
  if (normalized.error) return null;
  return normalized.memo.startsWith('enc1:') ? normalized.memo : cryptoBox.encryptString(normalized.memo);
};

/** 老数据迁移：把 v2.8.0 之前的明文备忘录就地加密（只跑一次，之后都是 enc1: 开头） */
async function migrateMemosToEncrypted() {
  if (vault.isLocked()) return; // 锁定态没法加密，等解锁后再迁移
  try {
    const items = await prisma.item.findMany({ where: { memo: { not: null } }, select: { id: true, memo: true } });
    let migrated = 0;
    for (const item of items) {
      if (!item.memo || item.memo.startsWith('enc1:')) continue;
      await prisma.item.update({ where: { id: item.id }, data: { memo: cryptoBox.encryptString(item.memo) } });
      migrated += 1;
    }
    if (migrated) console.log(`🔐 已把 ${migrated} 条明文备忘录加密入库`);
  } catch (e) {
    console.error('⚠️ 备忘录加密迁移失败:', e.message);
  }
}

/** 旧版明文备份（.json.gz / .db.gz）挪到 backups/legacy/，不再参与轮转与恢复 */
function archiveLegacyBackups() {
  try {
    if (!fs.existsSync(backupDir)) return;
    const legacy = fs.readdirSync(backupDir).filter((f) => LEGACY_BACKUP_RE.test(f));
    if (!legacy.length) return;
    const target = path.join(backupDir, 'legacy');
    fs.mkdirSync(target, { recursive: true });
    for (const f of legacy) fs.renameSync(path.join(backupDir, f), path.join(target, f));
    console.log(`📦 已把 ${legacy.length} 个旧版 .gz 备份移到 backups/legacy/（不再参与恢复）`);
  } catch (e) {
    console.warn('⚠️ 归档旧版备份失败:', e.message);
  }
}

/**
 * 写入一条非卡片变更（member/admin/config），带节点签名，供同步传播。
 * 改密码、踢人以前都"只改本地"，是多节点分叉的根源。
 */
/**
 * 通用配置同步（v3.10.2）
 * ------------------------------------------------------------------
 * 一个 op 覆盖所有"账号级配置"：groups / theme / uiPrefs / webdav / notify / app-token
 * 好处：syncEngine 只需处理一个 config-sync 分支，按 kind 分发。
 */
/**
 * 【P2】缩短敏感配置在 ChangeLog 里的暴露窗口
 * ------------------------------------------------------------------
 * 2FA 种子 / WebDAV 密码 / 企微密钥 会明文进 ChangeLog.payload。
 * 加密它们不可行（登录时保险库还没解锁；用密码加密则别的节点解不开）。
 * 务实做法：应用 7 天后把 payload 抹成 '{}'，只留元数据。
 * 7 天足够所有节点同步到（同步间隔 15 秒）。
 */
async function pruneSensitivePayloads() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const rows = await prisma.$queryRawUnsafe(
      "SELECT nodeId, seq, op, payload FROM ChangeLog WHERE entity = 'config' AND payload IS NOT NULL AND payload != '{}'"
    ).catch(() => []);
    let n = 0;
    for (const r of rows || []) {
      if (!['two-factor', 'config-sync'].includes(String(r.op))) continue;
      // 【重要】appToken 是"设备凭证"不是"敏感配置"，不能清理：
      // 清了之后，超过 7 天才入网的新节点永远拿不到旧 Token（join/snapshot 刻意不下发）
      if (String(r.op) === 'config-sync') {
        try {
          const p = JSON.parse(r.payload || '{}');
          if (String(p.kind || '') === 'appToken') continue;
        } catch { /* 解析失败照常清理 */ }
      }
      await prisma.$executeRawUnsafe(
        "UPDATE ChangeLog SET payload = '{}' WHERE nodeId = ? AND seq = ? AND createdAt < ?",
        String(r.nodeId), Number(r.seq), cutoff
      ).catch(() => {});
      n += 1;
    }
    if (n) console.log('[prune] 已清理 ' + n + ' 条敏感配置 payload（7 天前）');
  } catch { /* 忽略 */ }
}

/**
 * 【E-06】批量操作的部分成功语义
 * ------------------------------------------------------------------
 * SQLite 单条写入本身是原子的，但"批量循环中途失败"会留下部分已应用。
 * 与其强行包大事务（长时间持锁，反而阻塞同步），这里明确返回：
 *   { done, failed: [{ uid, error }] }
 * 调用方据此告知用户"成功 N 条，失败 M 条"，并可安全重试（操作幂等）。
 */
async function forEachSettled(list, worker) {
  let done = 0;
  const failed = [];
  for (const item of list) {
    try {
      await worker(item);
      done += 1;
    } catch (e) {
      failed.push({ uid: item && (item.uid || item.id), error: String(e && e.message || e).slice(0, 160) });
    }
  }
  return { done, failed };
}

async function broadcastConfig(kind, data) {
  try {
    await recordSideChange('config', String(kind), 'config-sync', { kind, data });
    if (syncEngine && typeof syncEngine.kick === 'function') syncEngine.kick();
  } catch (e) {
    console.warn('[config-sync] 广播 ' + kind + ' 失败:', e.message);
  }
}

async function recordSideChange(entity, uid, op, payloadObject) {
  const me = nodeIdentity.self();
  const payload = JSON.stringify(payloadObject);
  const seq = await nodeState.nextSeq();
  const changeId = me.nodeId + ':' + seq;
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const hlc = hlcClock.next(me.nodeId);
  const sig = nodeIdentity.sign([changeId, entity, uid, op, hlc, digest].join('|'));
  await prisma.changeLog.create({
    data: { nodeId: me.nodeId, seq, changeId, entity, uid, op, hlc, payload, sig, pk: me.publicKeyPem },
  });
  return changeId;
}

/**
 * 本地变更留痕（v3.0.0）：写 ChangeLog + 源节点签名。
 * 其他节点凭 changeId=（nodeId:seq）做幂等去重，凭签名验证来源。
 */
/**
 * 卡片增删改后自动重建明文快照（v3.10.1）
 * ------------------------------------------------------------------
 * 防抖 2 秒：批量导入/多次拖动只重建一次。
 * 锁定态直接跳过（保留旧快照，不清空），App 侧仍能读到最后一次的内容。
 */
let snapshotTimer = null;
function scheduleSnapshotRebuild() {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    rebuildAppSnapshot().catch((e) => console.warn('[app-snapshot] 自动重建失败:', e.message));
  }, 2000);
  if (snapshotTimer.unref) snapshotTimer.unref();
}

/** 真正生成快照：锁定态跳过并返回 { skipped: true } */
async function rebuildAppSnapshot() {
  if (vault.isLocked()) return { skipped: true, reason: 'vault-locked' };
  const rows = await itemStore.listAll({ locked: false, includeDeleted: false });
  const bookmarks = rows
    .filter((r) => !r.corrupted && !r.widgetType && !r.isHidden)
    .map((r) => {
      const urls = (r.urls || []).filter((u) => u && u.url);
      const first = urls[0];
      const rawIcon = String(r.icon || '');
      // 【P1-13】Android 桌面小组件走 RemoteViews，Binder 单次传递约 1MB；
      // 上传的本地图标是 data:image/... 的 base64，几张就能把快照撑到几 MB。
      // 超过 2KB 的 data: 一律剥离，只留 hasLocalIcon 标记，客户端按需走 /api/app/icon/:uid。
      const isDataIcon = rawIcon.startsWith('data:');
      const keepIcon = isDataIcon && rawIcon.length > 2048 ? '' : rawIcon;
      return {
        id: r.id, uid: r.uid, name: r.name, group: r.group,
        icon: keepIcon,
        hasLocalIcon: isDataIcon && rawIcon.length > 2048,
        desc: r.description || '',
        url: first ? String(first.url) : '',
        openMethod: r.openMethod === 'same_tab' ? 'same_tab' : 'new_tab',
        urls: urls.map((u) => ({ label: u.label || '', url: String(u.url) })),
        // 【P1-14】排序字段：客户端可直接按此渲染
        isPinned: !!r.isPinned,
        gridY: r.gridY ?? null,
        gridX: r.gridX ?? null,
        order: r.order ?? 0,
      };
    })
    .filter((b) => b.url)
    // 置顶优先 -> 网格 Y -> 网格 X -> order
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const ay = a.gridY ?? 9999, by = b.gridY ?? 9999;
      if (ay !== by) return ay - by;
      const ax = a.gridX ?? 9999, bx = b.gridX ?? 9999;
      if (ax !== bx) return ax - bx;
      return (a.order || 0) - (b.order || 0);
    });

  const nameRows = await prisma.$queryRawUnsafe('SELECT nodeId, name FROM Member').catch(() => []);
  const nameMap = Object.fromEntries((nameRows || []).map((r) => [r.nodeId, r.name || '']));
  const members = await prisma.member.findMany().catch(() => []);
  const nodes = members
    .filter((m) => m.status !== 'revoked')
    .map((m) => ({
      nodeId: m.nodeId, name: nameMap[m.nodeId] || '',
      urls: String(m.selfUrls || '').split(',').map((s) => s.trim()).filter(Boolean),
      role: m.role,
    }));

  const configRow = await prisma.appConfig.findUnique({ where: { id: 1 } });
  // 节点带状态（离线/在线），客户端可以灰度显示
  let peerStateMap = {};
  try { peerStateMap = syncEngine.getPeerState() || {}; } catch { peerStateMap = {}; }
  const nodesWithStatus = nodes.map((n) => {
    const ps = peerStateMap[n.nodeId] || {};
    return { ...n, status: Number(ps.failures || 0) >= 2 ? 'offline' : 'active' };
  });
  const payload = JSON.stringify({
    bookmarks, nodes: nodesWithStatus,
    groups: (() => { try { return JSON.parse(configRow?.groups || '[]'); } catch { return []; } })(),
    // 客户端可跟随主题强调色
    // 【P0-3】themeAccent 不在 schema.prisma 里，configRow 上没有这个字段，
    // 必须 raw 读，否则用户设的强调色永远进不了快照
    themeAccent: await (async () => {
      try {
        const rs = await prisma.$queryRawUnsafe('SELECT themeAccent FROM AppConfig WHERE id = 1');
        return (rs && rs[0] && rs[0].themeAccent) || '#3b82f6';
      } catch { return '#3b82f6'; }
    })(),
    selfNodeId: nodeIdentity.self().nodeId,
  });

  await ensureAppTables();
  const prev = await prisma.$queryRawUnsafe('SELECT version FROM AppSnapshot WHERE id = 1').catch(() => []);
  const version = Number(prev && prev[0] ? prev[0].version : 0) + 1;
  await prisma.$executeRawUnsafe(
    "INSERT OR REPLACE INTO AppSnapshot (id, version, updatedAt, payload) VALUES (1, ?, datetime('now'), ?)",
    version, payload
  );
  return { version, bookmarks: bookmarks.length, nodes: nodes.length };
}

async function recordChangeForItem(uid, op) {
  if (!uid) return null;
  try {
    const row = await prisma.item.findFirst({ where: { uid } });
    if (!row) return null;
    const nodeId = nodeIdentity.self().nodeId;
    const seq = await nodeState.nextSeq();
    const changeId = nodeId + ':' + seq;
    const payloadDigest = crypto.createHash('sha256').update(String(row.payload || '')).digest('hex');
    const signBase = [changeId, 'item', uid, op, row.hlc, payloadDigest].join('|');
    const sig = nodeIdentity.sign(signBase);
    await prisma.changeLog.create({
      data: {
        nodeId, seq, changeId,
        entity: 'item',
        uid, op,
        hlc: row.hlc || '',
        payload: op === 'delete' ? null : row.payload,
        sig,
        pk: nodeIdentity.self().publicKeyPem,
      },
    });
    await prisma.item.updateMany({ where: { uid }, data: { dirty: false } });
    if (row.hlc) await nodeState.set('hlc', row.hlc);
    // 【v3.10.1】卡片变更后自动重建明文快照（防抖 2 秒）
    scheduleSnapshotRebuild();
    return changeId;
  } catch (e) {
    console.warn('⚠️ 记录变更失败:', e.message);
    return null;
  }
}

/** 防抖合并：高频写操作只触发一次真实备份，避免写放大 */
function scheduleBackup(delay = 1500) {
  if (backupTimer) return;
  backupTimer = setTimeout(() => {
    backupTimer = null;
    performBackup();
  }, delay);
}

async function performBackup() {
  if (isBackingUp) { scheduleBackup(3000); return; }
  // 保险库锁定（密码模式且还没解锁）时不能加密备份：跳过，等下次解锁后再触发
  if (vault.isLocked()) {
    console.log('⏸️ 保险库未解锁，自动备份跳过（登录或解锁后会自动补一次）');
    scheduleBackup(60 * 1000);
    return;
  }
  isBackingUp = true;

  try {
    const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
    // 备份存"解密后的完整对象"：整包还会再 AES-256-GCM 加密一次
    // 【自检修复 BUG-E】备份不该因为一张卡损坏就整体失败：降级取全部，再把损坏的排除掉
  const itemsAll = await itemStore.listAll({ locked: false, includeDeleted: true });
  const corrupted = itemsAll.filter((i) => i.corrupted);
  const items = itemsAll.filter((i) => !i.corrupted);
  if (corrupted.length) console.warn(`⚠️ 备份跳过 ${corrupted.length} 张无法解密的卡片（uid: ${corrupted.map((c) => c.uid).join(',')}）`);
    if (!config) return;

    // 🚀 只剥离敏感字段：账号口令 + 云盘密码 + 企微密钥 + 2FA 种子
    const safeConfig = { ...config };
    SENSITIVE_CONFIG_KEYS.forEach((k) => delete safeConfig[k]);
    const backupData = { config: safeConfig, items };

    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(backupData), 'utf-8'));
    // 落盘 / 上云之前整包 AES-256-GCM 加密：云盘上躺着的也是密文
    const encrypted = cryptoBox.encryptBuffer(compressed, 'backup');
    const backupFileName = `backup_${getFormattedDate()}.opb`;
    fs.writeFileSync(path.join(backupDir, backupFileName), encrypted);

    // 本地滚动保留 3 份
    const localFiles = fs.readdirSync(backupDir)
      .filter((f) => BACKUP_FILE_RE.test(f))
      .sort()
      .reverse();
    for (let i = 3; i < localFiles.length; i++) fs.unlinkSync(path.join(backupDir, localFiles[i]));

    if (config.webdavUrl && config.webdavUser && config.webdavPass) {
      const client = createClient(config.webdavUrl, { username: config.webdavUser, password: config.webdavPass });
      await client.putFileContents(`/${backupFileName}`, encrypted, { overwrite: true });

      const remoteFiles = await client.getDirectoryContents('/');
      const remoteBackups = (Array.isArray(remoteFiles) ? remoteFiles : [])
        .filter((f) => f.basename && BACKUP_FILE_RE.test(f.basename))
        .sort((a, b) => b.basename.localeCompare(a.basename));
      for (let i = 3; i < remoteBackups.length; i++) await client.deleteFile(remoteBackups[i].filename);

      console.log(`[${new Date().toLocaleTimeString('zh-CN', { timeZone: TZ })}] ☁️ WebDAV 滚动备份成功（已脱敏 + 加密）`);
    } else {
      console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: TZ })}] 💾 本地备份成功（已脱敏 + 加密）`);
    }
    // 【修复 BUG-12】增量备份独立调度：以前只挂在"没配 WebDAV"分支，坚果云用户永远走不到
    blobStore.scheduleSync(3000);
  } catch (error) {
    console.error('备份/同步失败:', error.message);
  } finally {
    isBackingUp = false;
  }
}

/**
 * 【修复】同步日志类表无限增长：按时间与条数双重收敛。
 * - ChangeLog：留最近 30 天，且最多 2 万条（保留最近水位，避免把别节点的补差窗口删穿）
 * - AppliedChange：留 30 天（更早的重放已无意义）
 * - ItemRevision：留 30 天（冲突留档，过期自动清）
 */
async function pruneSyncTables() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const old = await prisma.changeLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await prisma.appliedChange.deleteMany({ where: { appliedAt: { lt: cutoff } } });
    await prisma.itemRevision.deleteMany({ where: { createdAt: { lt: cutoff } } });
    const total = await prisma.changeLog.count();
    if (total > 20000) {
      const keep = await prisma.changeLog.findMany({ orderBy: [{ createdAt: 'desc' }], take: 20000, select: { nodeId: true, seq: true } });
      const keepSet = new Set(keep.map((r) => r.nodeId + ':' + r.seq));
      const all = await prisma.changeLog.findMany({ select: { nodeId: true, seq: true } });
      const drop = all.filter((r) => !keepSet.has(r.nodeId + ':' + r.seq));
      for (const r of drop) {
        await prisma.changeLog.delete({ where: { nodeId_seq: { nodeId: r.nodeId, seq: r.seq } } }).catch(() => {});
      }
    }
    if (old.count) console.log(`🧹 已清理 ${old.count} 条过期变更日志`);
  } catch (e) {
    console.warn('⚠️ 清理同步日志失败:', e.message);
  }
}

/** 【F-06】密码强度校验：≥8 位 + 至少包含数字或符号 */
function checkPasswordStrength(pw) {
  const s = String(pw || '');
  if (s.length < 8) return '密码至少 8 位';
  if (!/[0-9]/.test(s) && !/[^A-Za-z0-9]/.test(s)) return '密码需包含至少一个数字或符号';
  if (/^(\d+|[a-zA-Z]+)$/.test(s)) return '密码不能是纯数字或纯字母';
  return null;
}

/** 统一写 auth Cookie：跨子域 + 跨端口共享，HttpOnly 防 XSS 偷 token */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto') !== '0';
function authCookie(token, maxAge = 30 * 24 * 3600) {
  const parts = [
    'auth_token=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAge,
  ];
  if (COOKIE_DOMAIN) parts.push('Domain=' + COOKIE_DOMAIN);
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}
const clearAuthCookie = () => authCookie('', 0);

// ====== 🛡️ 鉴权中间件 ======
const authenticateToken = (req, res, next) => {
  // 【v3.9.0】优先从 Cookie 读（跨子域/跨端口共享登录态），回退到 Authorization 头
  const cookieToken = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith('auth_token='))
  const fromCookie = cookieToken ? decodeURIComponent(cookieToken.slice('auth_token='.length)) : ''
  const header = req.headers.authorization || '';
  const token = fromCookie || (header.startsWith('Bearer ') ? header.slice(7) : null);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '登录已失效，请重新登录' });
    // 【修复 N9】纪元不匹配 = 已被吊销（改过密码 / 被踢）
    if (Number(user.epoch) !== Number(tokenEpoch)) {
      return res.status(403).json({ error: '登录状态已失效（密码或身份已变更），请重新登录' });
    }
    req.user = user;
    next();
  });
};

// ====== 🌐 公开接口 ======
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), tz: TZ }))

// ====== 🔗 节点同步接口（v3.0.0 阶段 3）======
/** 节点间鉴权：X-OP-Node / X-OP-Ts / X-OP-Sign，时间窗 ±5 分钟 */
const authenticateNode = ah(async (req, res, next) => {
  const nodeId = String(req.headers['x-op-node'] || '');
  const ts = String(req.headers['x-op-ts'] || '');
  const sig = String(req.headers['x-op-sign'] || '');
  if (!nodeId || !ts || !sig) return res.status(401).json({ error: '缺少节点身份头' });
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return res.status(401).json({ error: '时间窗超出，请校准时钟' });
  const member = await prisma.member.findUnique({ where: { nodeId } });
  if (!member) return res.status(401).json({ error: '未知节点，请先加入网络' });
  if (member.status === 'revoked') return res.status(403).json({ error: '该节点已被移出网络' });
  if (!nodeIdentity.verify([ts, req.method, req.path].join('\n'), sig, member.publicKey)) {
    return res.status(401).json({ error: '节点签名校验失败' });
  }
  await prisma.member.update({ where: { nodeId }, data: { lastSeen: new Date() } }).catch(() => {});
  req.node = member;
  next();
});

/** 取对方水位（StateVector） */
app.get('/api/sync/vector', authenticateNode, ah(async (req, res) => {
  const vector = await syncEngine.localVector();
  res.json({ nodeId: nodeIdentity.self().nodeId, vector, ts: Date.now() });
}));

/**
 * 增量补差（StateVector 语义）：
 *  ?vector={"nodeA":12,"nodeB":3} → 返回"对方还缺的"变更（按 (nodeId,seq) 升序）
 * 这样任何一台都能当中继：本地 ChangeLog 是全网变更集的子集副本，连不上源节点也能从我这补。
 */
app.get('/api/sync/changes', authenticateNode, ah(async (req, res) => {
  let vector = {};
  try {
    vector = JSON.parse(String(req.query.vector || '{}'));
  } catch {
    vector = {};
  }
  if (!vector || typeof vector !== 'object') vector = {};
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));

  // 全表按 (nodeId, seq) 排序后过滤：数据量小，直接内存筛比写复杂 SQL 稳
  const all = await prisma.changeLog.findMany({ orderBy: [{ nodeId: 'asc' }, { seq: 'asc' }] });
  const missing = all.filter((c) => Number(c.seq) > Number(vector[c.nodeId] || 0));
  const page = missing.slice(0, limit);
  res.json({
    nodeId: nodeIdentity.self().nodeId,
    changes: page.map((c) => ({
      changeId: c.changeId, entity: c.entity, uid: c.uid, op: c.op,
      hlc: c.hlc, payload: c.payload, sig: c.sig, nodeId: c.nodeId, pk: c.pk,
    })),
    hasMore: missing.length > limit,
  });
}));

/** 接收推送：幂等 + LWW + 源节点验签 */
app.post('/api/sync/changes', authenticateNode, ah(async (req, res) => {
  const list = Array.isArray((req.body || {}).changes) ? req.body.changes.slice(0, 500) : [];
  const results = { received: list.length, applied: 0, duplicate: 0, rejected: 0, details: [] };
  for (const change of list) {
    const r = await syncEngine.applyChange(change);
    if (r.applied) results.applied += 1;
    else if (r.reason === 'duplicate') results.duplicate += 1;
    else results.rejected += 1;
    if (!r.applied && r.reason !== 'duplicate') results.details.push({ changeId: change.changeId, reason: r.reason });
  }
  res.json({ ok: true, ...results });
}));

/** 全量快照（新节点引导用）：payload 已是密文，直接给 */
app.get('/api/sync/snapshot', authenticateNode, ah(async (req, res) => {
  const rows = await prisma.item.findMany({ orderBy: { id: 'asc' } });
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  res.json({
    nodeId: nodeIdentity.self().nodeId,
    items: rows.map((r) => ({
      uid: r.uid, payload: r.payload, hlc: r.hlc, nodeId: r.nodeId,
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    })),
    settings: {
      groups: config?.groups || null,
      themeBg: config?.themeBg, themeColor: config?.themeColor,
      siteTitle: config?.siteTitle, siteIcon: config?.siteIcon,
      cardBgColor: config?.cardBgColor, cardBgOpacity: config?.cardBgOpacity,
    },
    // 【修复】把 Member.name 一起下发，否则新节点入网后看不到别人的设备名
    // （name 是后加列，用 raw 读避免依赖 prisma generate）
    members: await (async () => {
      let nameMap = {};
      try {
        const rs = await prisma.$queryRawUnsafe('SELECT nodeId, name FROM Member');
        nameMap = Object.fromEntries((rs || []).map((r) => [r.nodeId, r.name || '']));
      } catch { nameMap = {}; }
      const list = await prisma.member.findMany();
      return list.map((m) => ({
        nodeId: m.nodeId, name: nameMap[m.nodeId] || '', publicKey: m.publicKey,
        selfUrls: m.selfUrls, role: m.role, status: m.status,
      }));
    })(),
    // 【v3.9.5】把 Passkey 一起下发，新节点入网就认得这些凭据
    // 【P1-5】入网时就把主题强调色和 UI 偏好带给新节点（界面立刻对齐）
    // 注意：AppToken 刻意不下发 —— 它是"单节点+单设备"凭证，由 App 切节点时重新换
    themeAccent: await (async () => {
      try {
        const rs = await prisma.$queryRawUnsafe('SELECT themeAccent, uiPrefs FROM AppConfig WHERE id = 1');
        const r0 = rs && rs[0];
        return {
          themeAccent: (r0 && r0.themeAccent) || '#3b82f6',
          uiPrefs: (() => { try { return JSON.parse(r0?.uiPrefs || '{}'); } catch { return {}; } })(),
        };
      } catch { return { themeAccent: '#3b82f6', uiPrefs: {} }; }
    })(),
    passkeys: await prisma.$queryRawUnsafe('SELECT credentialId, publicKey, counter, label, prfWrapped FROM Passkey').catch(() => []),
    ts: Date.now(),
  });
}));

/** 节点列表与同步状态（需登录） */
app.get('/api/sync/status', authenticateToken, ah(async (req, res) => {
  const members = await prisma.member.findMany();
  const acks = await prisma.peerAck.findMany();
  // 设备名：Member.name 是后加的列，用 raw 读避免依赖 prisma generate
  let names = {};
  try {
    const rows = await prisma.$queryRawUnsafe('SELECT nodeId, name FROM Member');
    names = Object.fromEntries((rows || []).map((r) => [r.nodeId, r.name || '']));
  } catch { names = {}; }
  const selfId = nodeIdentity.self().nodeId;
  const counts = await prisma.changeLog.count();
  res.json({
    nodeId: selfId,
    nodeName: names[selfId] || nodeState.get('nodeName', ''),
    hlc: nodeState.get('hlc', ''),
    changes: counts,
    members: members.map((m) => {
      // 【修复】库里的 status 只有 active/revoked，从不会有 offline；
      // 这里结合同步引擎的内存失败计数推导"有效状态"，拓扑图/列表的离线灯才会亮。
      const ps = (syncEngine.getPeerState() || {})[m.nodeId] || {};
      const failures = Number(ps.failures || 0);
      const effective = m.status === 'revoked' ? 'revoked' : (failures >= 2 ? 'offline' : 'active');
      return {
        nodeId: m.nodeId, name: names[m.nodeId] || '', selfUrls: m.selfUrls, role: m.role,
        status: effective, dbStatus: m.status, failures,
        lastError: ps.lastError || '',
        lastSeen: m.lastSeen, lastSyncAt: m.lastSyncAt,
      };
    }),
    cursors: Object.fromEntries(acks.map((a) => [a.peerId, a.lastSeq])),
    peerState: syncEngine.getPeerState(),
  });
}));

/** 设置本机设备名（拓扑图 / 成员列表显示用） */
app.put('/api/node/name', authenticateToken, ah(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  await nodeState.set('nodeName', name);
  await prisma.$executeRawUnsafe('UPDATE Member SET name = ? WHERE nodeId = ?', name, nodeIdentity.self().nodeId).catch(() => {});
  // 【修复】改名字也要广播 member 变更，否则其他节点永远看不到
  const me = nodeIdentity.self();
  const myRow = await prisma.member.findUnique({ where: { nodeId: me.nodeId } }).catch(() => null);
  try {
    await recordSideChange('member', me.nodeId, 'upsert', {
      nodeId: me.nodeId,
      publicKey: me.publicKeyPem,
      selfUrls: (myRow && myRow.selfUrls) || '',
      status: 'active',
      name,
    });
    syncEngine.kick && syncEngine.kick();
  } catch (e) {
    console.warn('广播设备名失败:', e.message);
  }
  res.json({ success: true, name });
}));

/** 主动加一个 peer：问对方要 node/info，写进成员表（阶段 5 的加入向导会复用它） */
app.post('/api/sync/peers', authenticateToken, ah(async (req, res) => {
  const url = String((req.body || {}).url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '地址需要 http(s):// 前缀' });
  let info;
  try {
    const r = await fetch(url + '/api/node/info', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    info = await r.json();
  } catch (e) {
    return res.status(400).json({ error: '连不上对方节点：' + e.message });
  }
  if (!info.nodeId || !info.publicKey) return res.status(400).json({ error: '对方不是 OnePanel 节点' });
  if (info.nodeId === nodeIdentity.self().nodeId) return res.status(400).json({ error: '这就是本机' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '地址必须是 http(s)' });
  await prisma.member.upsert({
    where: { nodeId: info.nodeId },
    create: { nodeId: info.nodeId, publicKey: info.publicKey, selfUrls: cleanPeerUrls(url), role: 'peer', status: 'active', lastSeen: new Date() },
    update: { publicKey: info.publicKey, selfUrls: cleanPeerUrls(url), status: 'active', lastSeen: new Date() },
  });
  res.json({ success: true, member: { nodeId: info.nodeId, selfUrls: url } });
}));

/**
 * 【Q2 方案 A】踢出某个节点：本地立即拉黑，再写一条 admin/revoke 变更，全网跟随。
 * 任何一台都能发起（每台都是管理员），但不能踢自己。
 */
app.post('/api/sync/revoke', authenticateToken, ah(async (req, res) => {
  const target = String((req.body || {}).nodeId || '').trim();
  if (!target) return res.status(400).json({ error: '需要 nodeId' });
  const me = nodeIdentity.self();
  if (target === me.nodeId) return res.status(400).json({ error: '不能踢自己' });
  const member = await prisma.member.findUnique({ where: { nodeId: target } });
  if (!member) return res.status(404).json({ error: '没有这个成员' });
  await prisma.member.update({ where: { nodeId: target }, data: { status: 'revoked' } });
  const changeId = await recordSideChange('admin', target, 'revoke', { nodeId: target, reason: String((req.body || {}).reason || '') });
  console.log(`⛔ 已踢出节点 ${target.slice(0, 6)}（${changeId}），其他节点下一轮同步跟随`);
  res.json({ success: true, nodeId: target, changeId });
}));

/** 手动触发一轮同步（调试与"立即同步"按钮用） */
app.post('/api/sync/now', authenticateToken, ah(async (req, res) => {
  res.json(await syncEngine.syncOnce());
}));

// ====== 🚪 加入网络（v3.0.0 阶段 5）======
/** 一次性加入令牌：内存持有，5 分钟有效，绑定 nodeId + 公钥，用一次即失效 */
/**
 * 【二维码配对】一次性配对码：管理员在老节点生成，新节点凭它入网。
 * 目的：密码永不过网（密码只在本机输入），且解决"空库节点无法比对指纹"的结构性问题。
 */
const pairCodes = new Map();
const PAIR_TTL_MS = 10 * 60 * 1000;
function issuePairCode() {
  const code = crypto.randomBytes(16).toString('hex');
  pairCodes.set(code, { exp: Date.now() + PAIR_TTL_MS });
  for (const [k, v] of pairCodes) if (v.exp < Date.now()) pairCodes.delete(k);
  return code;
}
function consumePairCode(code) {
  const hit = pairCodes.get(String(code || ''));
  if (!hit) return false;
  pairCodes.delete(String(code));
  return hit.exp > Date.now();
}

/**
 * 生成一次性配对信息（需登录）。返回一段可直接复制给对方设备的文本。
 * 内容 = url + code + 主密钥指纹，新节点据此校验并完成入网。
 */
app.post('/api/pair/new', authenticateToken, ah(async (req, res) => {
  const me = nodeIdentity.self();
  const code = issuePairCode();
  const configured = String((nodeState.get('selfUrls', '') || '').split(',')[0] || '').trim();
  const url = String((req.body || {}).url || configured || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
  const payload = { v: 1, url, code, fingerprint: vault.fingerprint() || null, nodeId: me.nodeId, exp: Date.now() + PAIR_TTL_MS };
  const text = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  res.json({ success: true, code, url, text, expiresInMs: PAIR_TTL_MS, fingerprint: payload.fingerprint });
}));

const joinTokens = new Map();
const JOIN_TTL_MS = 5 * 60 * 1000;
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { error: '加入尝试过于频繁，请 15 分钟后再试' },
});

function issueJoinToken(nodeId, publicKey, selfUrls) {
  const token = crypto.randomBytes(24).toString('hex');
  joinTokens.set(token, { nodeId, publicKey, selfUrls: selfUrls || '', exp: Date.now() + JOIN_TTL_MS });
  // 顺手清理过期
  for (const [k, v] of joinTokens) if (v.exp < Date.now()) joinTokens.delete(k);
  return token;
}

function consumeJoinToken(token, nodeId) {
  const hit = joinTokens.get(token);
  if (!hit) return { ok: false, reason: '令牌无效或已被使用' };
  if (hit.exp < Date.now()) { joinTokens.delete(token); return { ok: false, reason: '令牌已过期' }; }
  if (hit.nodeId && nodeId && hit.nodeId !== nodeId) { return { ok: false, reason: '令牌与节点不匹配' }; }
  joinTokens.delete(token);
  return { ok: true, ...hit };
}

/**
 * 老节点侧：新节点凭「管理员账号密码」申请加入。
 * 密码只用于这一次身份证明，老节点不保存任何来自新节点的东西。
 */
/**
 * 待批准的入网请求（v3.13.0）
 * ------------------------------------------------------------------
 * 【安全】账号密码入网不再立即签发令牌，必须由老节点管理员在面板上点「批准」。
 * 理由：密码可能是泄露的/被猜到的，但"管理员亲眼看到一台新设备要进来并点了批准"
 * 是真正的授权动作。
 * 配对串不走这里——生成一次性码本身就是管理员的授权动作。
 * 队列存内存：老节点重启即清空，未批准的请求自动失效（安全默认）。
 */
const joinPending = new Map();
const JOIN_PENDING_TTL = 5 * 60 * 1000;

function pruneJoinPending() {
  const now = Date.now();
  for (const [id, v] of joinPending) {
    if (now - v.at > JOIN_PENDING_TTL) joinPending.delete(id);
  }
}

app.post('/api/join/request', joinLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const nodeId = String(body.nodeId || '');
  const publicKey = String(body.publicKey || '');
  const selfUrls = String(body.selfUrls || '');
  if (!nodeId || !publicKey) return res.status(400).json({ error: '缺少节点身份信息' });
  // 【配对入网】凭一次性配对码时不需要密码（码由老节点管理员当面出示）
  const pairCode = String(body.pairCode || '');
  if (!pairCode && (!body.username || !body.password)) return res.status(400).json({ error: '请输入管理员账号密码，或使用配对码' });
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) return res.status(503).json({ error: '系统尚未初始化' });
  if (pairCode) {
    // 【配对入网】码一次性、10 分钟有效；不校验密码
    if (!consumePairCode(pairCode)) {
      return res.status(401).json({ error: '配对码无效或已过期（请在老节点重新生成）' });
    }
  } else {
    const userOk = String(body.username) === config.username;
    const passOk = await bcrypt.compare(String(body.password), config.password);
    if (!userOk || !passOk) {
      await new Promise((r) => setTimeout(r, 300));
      return res.status(401).json({ error: '账号或密码不正确' });
    }
    // 【安全 v3.13.0】密码对了也必须人工批准：
    //   挂起请求，等管理员在「设置 → 共享网络」点批准后才签发令牌。
    //   配对串不走这里 —— 生成一次性码本身就是管理员的授权动作。
    pruneJoinPending();
    const requestId = crypto.randomBytes(12).toString('hex');
    const ipRaw = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    joinPending.set(requestId, {
      at: Date.now(), nodeId, publicKey, selfUrls, ip: ipRaw,
      status: 'pending', token: null,
    });
    console.log(`🚪 节点 ${nodeId.slice(0, 6)} 请求加入（来自 ${ipRaw}），等待管理员批准`);
    return res.status(202).json({
      pending: true, requestId,
      expiresInMs: JOIN_PENDING_TTL,
      message: '请到老节点的「设置 → 共享网络」里点批准',
    });
  }
  // 配对模式签发的令牌允许在 snapshot 里额外下发主密钥（否则新节点没有密码解不开）
  const token = issueJoinToken(nodeId, publicKey);
  if (pairCode) {
    joinTokens.set(token, { ...(joinTokens.get(token) || {}), pair: true });
  }
  console.log(`🚪 节点 ${nodeId.slice(0, 6)} 申请加入，已签发一次性令牌`);
  // 带上主密钥指纹：新节点用它判断"我们的加密钥匙是不是同一把"
  res.json({ success: true, token, expiresInMs: JOIN_TTL_MS, vaultFingerprint: vault.fingerprint() });
}));

/** 新节点轮询：请求被批准了吗 */
app.get('/api/join/pending/:requestId', joinLimiter, ah(async (req, res) => {
  const id = String(req.params.requestId || '');
  const rec = joinPending.get(id);
  if (!rec) return res.status(404).json({ error: '请求不存在或已过期（请重新发起）' });
  if (Date.now() - rec.at > JOIN_PENDING_TTL) {
    joinPending.delete(id);
    return res.status(410).json({ error: '请求已超时（5 分钟），请重新发起' });
  }
  if (rec.status === 'rejected') {
    joinPending.delete(id);
    return res.status(403).json({ error: '管理员拒绝了这次入网请求' });
  }
  if (rec.status === 'approved' && rec.token) {
    return res.json({ approved: true, token: rec.token, expiresInMs: JOIN_TTL_MS, vaultFingerprint: vault.fingerprint() });
  }
  res.json({ pending: true, waitedMs: Date.now() - rec.at, expiresInMs: Math.max(0, JOIN_PENDING_TTL - (Date.now() - rec.at)) });
}));

/** 管理员：列出待批准的入网请求 */
app.get('/api/join/requests', authenticateToken, (req, res) => {
  pruneJoinPending();
  const items = [...joinPending.entries()]
    .filter(([, v]) => v.status === 'pending')
    .map(([id, v]) => ({
      requestId: id, nodeId: v.nodeId, selfUrls: v.selfUrls, ip: v.ip,
      waitedSec: Math.round((Date.now() - v.at) / 1000),
    }));
  res.json({ items });
});

/** 管理员：批准 */
app.post('/api/join/approve', authenticateToken, ah(async (req, res) => {
  const id = String((req.body || {}).requestId || '');
  const rec = joinPending.get(id);
  if (!rec) return res.status(404).json({ error: '请求不存在或已过期' });
  if (rec.status !== 'pending') return res.status(409).json({ error: '该请求已处理过' });
  const token = issueJoinToken(rec.nodeId, rec.publicKey, rec.selfUrls);
  rec.status = 'approved';
  rec.token = token;
  console.log(`✅ 已批准节点 ${rec.nodeId.slice(0, 6)} 入网（来自 ${rec.ip}）`);
  res.json({ success: true });
}));

/** 管理员：拒绝 */
app.post('/api/join/reject', authenticateToken, ah(async (req, res) => {
  const id = String((req.body || {}).requestId || '');
  const rec = joinPending.get(id);
  if (!rec) return res.status(404).json({ error: '请求不存在或已过期' });
  rec.status = 'rejected';
  console.log(`⛔ 已拒绝节点 ${rec.nodeId.slice(0, 6)} 的入网请求`);
  res.json({ success: true });
}));

/** 老节点侧：凭令牌一次性拿全量（items 是密文，另附账号与密钥包裹以便新节点直接可用） */
app.get('/api/join/snapshot', joinLimiter, ah(async (req, res) => {
  // 优先用请求头，避免 token 落到反代/访问日志里
  const token = String(req.headers['x-join-token'] || req.query.token || '');
  // 配对令牌在消费前先取出标记（consumeJoinToken 会删除记录）
  const wasPair = !!(joinTokens.get(String(token || '')) || {}).pair;
  const consumed = consumeJoinToken(token, String(req.query.nodeId || ''));
  if (!consumed.ok) return res.status(401).json({ error: '加入令牌不可用：' + consumed.reason });

  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const rows = await prisma.item.findMany({ orderBy: { id: 'asc' } });
  const changes = await prisma.changeLog.findMany({ orderBy: [{ nodeId: 'asc' }, { seq: 'asc' }] });

  // 新成员入表 + 广播一条 member 变更（其他节点靠同步自动认识它）
  const me = nodeIdentity.self();
  await prisma.member.upsert({
    where: { nodeId: consumed.nodeId },
    create: { nodeId: consumed.nodeId, publicKey: consumed.publicKey, selfUrls: cleanPeerUrls(consumed.selfUrls), role: 'peer', status: 'active', lastSeen: new Date() },
    update: { publicKey: consumed.publicKey, selfUrls: cleanPeerUrls(consumed.selfUrls), status: 'active', lastSeen: new Date() },
  });
  // 【设计修正】成员广播必须由"本人"发出：老节点代发会被 member-forbidden 拦（防止替别人改身份）。
  // 所以这里不再写 member 变更，改由新节点在 /api/join/from 里给自己上户口。

  res.json({
    app: 'onepanel',
    kind: 'join-snapshot',
    version: 1,
    nodeId: me.nodeId,
    account: { username: config.username, passwordHash: config.password, isFirstLogin: false },
    // 【自检修复】必须告知密钥模式：env 模式下没有 vault 包裹，新节点若也走密码模式会生成随机密钥
    // 【配对入网】只有"管理员当面出示的一次性码"换来的令牌才下发主密钥明文；
    // 密码入网永远不下发（新节点用自己的密码解包裹）。
    vault: {
      salt: config.vaultSalt,
      wrapped: config.vaultWrapped,
      mode: vault.mode(),
      secret: wasPair && vault.mode() === 'password' ? vault.getSecret() : null,
    },
    // 【安全】不下发 2FA 种子（种子泄露=可离线生成验证码）。
    // 新节点落地后 2FA 为关闭状态，需要在该节点重新绑定——比把种子撒出去安全得多。
    // 【v3.8.0】2FA 全网通用：入网时下发种子（入网本就下发了明文主密钥，边际风险为 0）
    twoFactor:
      config.twoFactorEnabled
        ? { enabled: true, secret: config.twoFactorSecret || null }
        : { enabled: false, secret: null },
    twoFactorNotice: config.twoFactorEnabled ? '已同步源节点的 2FA，本机用同一个 6 位码' : null,
    settings: {
      groups: config.groups, themeBg: config.themeBg, themeColor: config.themeColor,
      siteTitle: config.siteTitle, siteIcon: config.siteIcon, bgImage: config.bgImage,
      footerText: config.footerText, cardBgColor: config.cardBgColor, cardBgOpacity: config.cardBgOpacity,
    },
    items: rows.map((r) => ({ uid: r.uid, payload: r.payload, hlc: r.hlc, nodeId: r.nodeId, deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null })),
    changes: changes.map((c) => ({
      changeId: c.changeId, entity: c.entity, uid: c.uid, op: c.op,
      hlc: c.hlc, payload: c.payload, sig: c.sig, nodeId: c.nodeId, pk: c.pk,
    })),
    members: (await prisma.member.findMany()).map((m) => ({
      nodeId: m.nodeId, publicKey: m.publicKey, selfUrls: m.selfUrls, role: m.role, status: m.status,
    })),
  });
}));

/**
 * 新节点侧：一步入网。只在"空库"时允许（避免被利用来清空已有数据）。
 * 流程：申请令牌 → 拉全量 → 落地卡片/成员/账号/密钥包裹 → 用同一密码解锁保险库。
 */
app.post('/api/join/from', joinLimiter, ah(async (req, res) => {
  const body = req.body || {};
  // 【配对入网】可以直接传一段配对串（base64），里面已含地址与配对码
  let pairCode = String(body.pairCode || '');
  let pairUrl = '';
  let pairFingerprint = '';
  if (body.pairText) {
    try {
      const parsed = JSON.parse(Buffer.from(String(body.pairText), 'base64').toString('utf8'));
      pairCode = String(parsed.code || '');
      pairUrl = String(parsed.url || '').replace(/\/$/, '');
      pairFingerprint = String(parsed.fingerprint || '');
    } catch {
      return res.status(400).json({ error: '配对串无法解析（请重新复制）' });
    }
  }
  const url = String(body.url || pairUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '节点地址需要 http(s):// 前缀' });
  if (!pairCode && (!body.username || !body.password)) return res.status(400).json({ error: '请输入管理员账号密码，或使用配对串' });

  // 【修复】只查 item.count 不够：曾经中途失败会留下 ChangeLog/Member 脏数据
  const [existing, changeCount, memberCount] = await Promise.all([
    prisma.item.count(),
    prisma.changeLog.count(),
    prisma.member.count(),
  ]);
  if (existing > 0) return res.status(400).json({ error: '本节点已有数据，不能直接加入（请先备份并清空）' });
  if (changeCount > 0 || memberCount > 1) {
    // 只有"自己那条 member 记录"是允许的
    return res.status(400).json({ error: '本节点残留同步状态（变更日志/成员表），请先清空再入网' });
  }

  const me = nodeIdentity.self();
  const selfUrls = String(body.selfUrls || '').trim();
  const nodeName = String(body.nodeName || '').trim().slice(0, 40);
  let token;
  // 【修复 P0-2】用对方在 join/request 里声明的指纹做锚点；解包后必须对得上
  let vaultFingerprintFromToken = '';
  // 【修复】配对串里自带指纹，必须和对方响应里的指纹交叉校验，否则少一层离线锚定
  if (pairFingerprint && vaultFingerprintFromToken && pairFingerprint !== vaultFingerprintFromToken) {
    return res.status(409).json({ error: '配对串指纹与源节点不一致（可能被篡改，请重新生成配对串）' });
  }
  let pendingSecret = null;
  try {
    const r = await fetch(url + '/api/join/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: me.nodeId, publicKey: me.publicKeyPem, selfUrls, username: body.username, password: body.password, ...(pairCode ? { pairCode } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    let data = await r.json();
    // 【安全 v3.13.0】202 = 对方要求人工批准，轮询等待（最多 5 分钟）
    if (r.status === 202 && data.pending) {
      const requestId = data.requestId;
      const deadline = Date.now() + 5 * 60 * 1000;
      console.log('⏳ 已发起入网请求，等待老节点管理员批准（最多 5 分钟）…');
      let approved = null;
      while (Date.now() < deadline) {
        await new Promise((rr) => setTimeout(rr, 3000));
        try {
          const pr = await fetch(url + '/api/join/pending/' + encodeURIComponent(requestId), {
            signal: AbortSignal.timeout(10000),
          });
          const pj = await pr.json();
          if (pr.status === 403) return res.status(403).json({ error: pj.error || '管理员拒绝了入网请求' });
          if (pr.status === 410 || pr.status === 404) return res.status(410).json({ error: pj.error || '请求已过期，请重新发起' });
          if (pj.approved && pj.token) { approved = pj; break; }
        } catch { /* 网络抖动继续轮询 */ }
      }
      if (!approved) {
        return res.status(408).json({
          error: '等待管理员批准超时（5 分钟）。请到老节点「设置 → 共享网络」点批准，或改用「显示授权码」入网',
          code: 'APPROVAL_TIMEOUT',
        });
      }
      data = approved;
    }
    if (!r.ok) return res.status(r.status).json({ error: data.error || '对方拒绝加入' });
    token = data.token;
    vaultFingerprintFromToken = String(data.vaultFingerprint || '');
    // 【修复 BUG-2】主密钥必须一致，否则入网后会把全网卡片解密成空、再覆盖回去
    const mine = vault.fingerprint();
    if (mine && data.vaultFingerprint && mine !== data.vaultFingerprint) {
      return res.status(409).json({
        error: '主密钥不一致：本机与对方节点的加密钥匙不同（检查 APP_SECRET 是否统一，或在两边设成同一串）',
        code: 'VAULT_MISMATCH',
        mineFingerprint: mine,
        remoteFingerprint: data.vaultFingerprint,
      });
    }
  } catch (e) {
    return res.status(400).json({ error: '连不上对方节点：' + e.message });
  }

  let snapshot;
  try {
    const r = await fetch(url + '/api/join/snapshot?token=' + encodeURIComponent(token) + '&nodeId=' + encodeURIComponent(me.nodeId), { signal: AbortSignal.timeout(30000) });
    snapshot = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: snapshot.error || '拿不到快照' });
  } catch (e) {
    return res.status(400).json({ error: '拉取快照失败：' + e.message });
  }

  // 【修复 P0-2】空库新节点没有本地主密钥，原来这一步会被跳过 → MITM 可替换 vaultWrapped。
  // 现在：先"不落库"地用密码解一遍对方的包裹，算指纹比对，一致才继续写数据。
  const v = snapshot.vault || {};
  const remoteFP = String(vaultFingerprintFromToken || '');
  // 【自检修复 BUG-A】对方是 APP_SECRET 模式：它没有 vault 包裹可下发，
  // 本机若也走密码模式会生成一把随机主密钥 → 卡片全部解不开但"入网成功"。
  if (v.mode === 'env' && !vault.envSecret()) {
    return res.status(409).json({
      error: '对方节点使用 APP_SECRET 模式，本机也必须设置相同的 APP_SECRET 后重启，再入网',
      code: 'VAULT_MODE_ENV_REQUIRED',
    });
  }
  // 【配对入网】老节点用一次性码授权时会直接下发主密钥明文 → 无需密码即可解锁
  if (v.secret) {
    if (remoteFP) {
      const fp = require('crypto').createHmac('sha256', String(v.secret)).update('onepanel-vault-fingerprint').digest('hex').slice(0, 16);
      if (fp !== remoteFP) {
        return res.status(409).json({ error: '配对串里的密钥指纹与下发的密钥不一致（可能被篡改）', code: 'VAULT_FINGERPRINT_MISMATCH' });
      }
    }
    pendingSecret = String(v.secret);
  } else if (v.salt && v.wrapped) {
    let computed;
    try {
      computed = vault.fingerprintOf(v.wrapped, v.salt, String(body.password));
    } catch (e) {
      return res.status(401).json({ error: '解不开对方的密钥包裹：密码不正确，或数据被篡改' });
    }
    if (remoteFP && computed !== remoteFP) {
      return res.status(409).json({
        error: '主密钥指纹不一致：对方声明的密钥与实际下发的包裹不匹配（可能是链路被篡改或 APP_SECRET 不统一）',
        code: 'VAULT_FINGERPRINT_MISMATCH',
        expected: remoteFP,
        actual: computed,
      });
    }
    // 记下来，落地后设为进程主密钥
    pendingSecret = vault.unwrapSecret(v.wrapped, v.salt, String(body.password));
  }

  // 落地卡片（payload 是密文，直接写）
  for (const it of snapshot.items || []) {
    await itemStore.upsertFromSync({ uid: it.uid, payload: it.payload, hlc: it.hlc, nodeId: it.nodeId, deletedAt: it.deletedAt });
  }
  // 落地变更日志（保留源签名，便于继续向第三方转发）
  for (const c of snapshot.changes || []) {
    const [srcNode, seqText] = String(c.changeId).split(':');
    const seqNum = Number(seqText);
    if (!srcNode || !Number.isFinite(seqNum)) continue;
    await prisma.changeLog.upsert({
      where: { nodeId_seq: { nodeId: srcNode, seq: seqNum } },
      create: {
        nodeId: srcNode, seq: seqNum, changeId: c.changeId, entity: c.entity, uid: c.uid,
        op: c.op, hlc: c.hlc, payload: c.payload || null, sig: c.sig || null, pk: c.pk || null,
      },
      update: {},
    }).catch(() => {});
  }
  // 落地成员（含自己）
  for (const m of snapshot.members || []) {
    await prisma.member.upsert({
      where: { nodeId: m.nodeId },
      create: { nodeId: m.nodeId, publicKey: m.publicKey, selfUrls: m.selfUrls || '', role: m.nodeId === me.nodeId ? 'self' : 'peer', status: m.status || 'active', lastSeen: new Date() },
      update: { publicKey: m.publicKey, selfUrls: m.selfUrls || '', status: m.status || 'active' },
    });
  }
  // 账号与密钥包裹：保证"同一个账号密码"可用
  const acc = snapshot.account || {};
  const vaultData = snapshot.vault || {};
  await prisma.appConfig.update({
    where: { id: 1 },
    data: {
      username: acc.username || 'admin',
      password: acc.passwordHash,
      isFirstLogin: false,
      // 【修复 BUG-2】对方没带包裹就保留本地，绝不能用 null 把已有密钥覆盖掉
      ...(vaultData.salt && vaultData.wrapped ? { vaultSalt: vaultData.salt, vaultWrapped: vaultData.wrapped } : {}),
      twoFactorEnabled: !!(snapshot.twoFactor && snapshot.twoFactor.enabled),
      twoFactorSecret: (snapshot.twoFactor && snapshot.twoFactor.secret) || null,
      ...(snapshot.settings || {}),
    },
  });

  // 用同一密码解锁（密码模式；APP_SECRET 模式下本来就是解锁的）
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!pendingSecret) {
    await unlockVaultWithPassword(config, String(body.password));
  } else {
    // 配对模式：主密钥已由老节点一次性下发并校验过指纹，直接用
    vault.setSecret(pendingSecret, 'password');
  }
  // 【修复 P0-2】指纹校验：配对模式下核对主密钥指纹（setSecret 已在上面做过，不重复）
  if (pendingSecret) {
    const fpNow = vault.fingerprint();
    if (vaultFingerprintFromToken && fpNow !== vaultFingerprintFromToken) {
      return res.status(409).json({ error: '入网校验失败：主密钥指纹与对方声明不一致', code: 'VAULT_FINGERPRINT_MISMATCH' });
    }
  }
  if (selfUrls) await nodeState.set('selfUrls', selfUrls);
  await nodeState.set('hlc', hlcClock.next(me.nodeId));

  // 关键：把"我是从哪个地址进来的"写进对方成员记录，否则新节点不知道回连哪里
  await prisma.member.update({
    where: { nodeId: String(snapshot.nodeId || '') },
    data: { selfUrls: url, status: 'active', lastSeen: new Date() },
  }).catch(() => {});
  // 自己的成员记录也写上自己的对外地址
  await prisma.member.update({
    where: { nodeId: me.nodeId },
    data: { selfUrls, role: 'self', status: 'active', lastSeen: new Date() },
  }).catch(() => {});
  // 【修复】入网时填的设备名必须真正落地（原来只解析没用）
  if (nodeName) {
    await nodeState.set('nodeName', nodeName);
  // 【P1-5】落地对端的主题强调色与 UI 偏好（AppToken 刻意不下发）
  if (snapshot.themeAccent && snapshot.themeAccent.themeAccent) {
    await prisma.$executeRawUnsafe(
      'UPDATE AppConfig SET themeAccent = ? WHERE id = 1',
      String(snapshot.themeAccent.themeAccent)
    ).catch(() => {});
  }
  if (snapshot.themeAccent && snapshot.themeAccent.uiPrefs) {
    await prisma.$executeRawUnsafe(
      'UPDATE AppConfig SET uiPrefs = ? WHERE id = 1',
      JSON.stringify(snapshot.themeAccent.uiPrefs).slice(0, 4000)
    ).catch(() => {});
  }
  // 【v3.9.5】落地对端的 Passkey 记录，这样在这台新节点也能用同一把指纹
  for (const pk of snapshot.passkeys || []) {
    if (!pk || !pk.credentialId) continue;
    await prisma.$executeRawUnsafe(
      'INSERT OR REPLACE INTO Passkey (credentialId, publicKey, counter, label, prfWrapped) VALUES (?, ?, ?, ?, ?)',
      String(pk.credentialId), String(pk.publicKey || ''), Number(pk.counter) || 0,
      String(pk.label || '我的通行密钥').slice(0, 40), pk.prfWrapped || null
    ).catch(() => {});
  }
    await prisma.$executeRawUnsafe('UPDATE Member SET name = ? WHERE nodeId = ?', nodeName, me.nodeId).catch(() => {});
  }
  // 其他成员的 name 从快照带回
  for (const m of snapshot.members || []) {
    if (m.name) {
      await prisma.$executeRawUnsafe('UPDATE Member SET name = ? WHERE nodeId = ?', String(m.name).slice(0, 40), m.nodeId).catch(() => {});
    }
  }

  // 【设计修正】成员广播由本人发出：新节点给自己上户口，其他节点凭此认识它
  try {
    const selfPayload = JSON.stringify({
      nodeId: me.nodeId, publicKey: me.publicKeyPem, selfUrls, status: 'active', name: nodeName || '',
    });
    const seq = await nodeState.nextSeq();
    const changeId = me.nodeId + ':' + seq;
    const digest = crypto.createHash('sha256').update(selfPayload).digest('hex');
    // hlc 只生成一次：签名与落库必须用同一个值（BUG-4 的教训）
    const selfHlc = hlcClock.next(me.nodeId);
    const sig = nodeIdentity.sign([changeId, 'member', me.nodeId, 'upsert', selfHlc, digest].join('|'));
    await prisma.changeLog.create({
      data: {
        nodeId: me.nodeId, seq, changeId,
        entity: 'member',
        uid: me.nodeId,
        op: 'upsert',
        hlc: selfHlc,
        payload: selfPayload,
        sig,
        pk: me.publicKeyPem,
      },
    });
    console.log('🪪 已广播本节点身份（member 变更 ' + changeId + '）');
  } catch (e) {
    console.warn('⚠️ 广播节点身份失败:', e.message);
  }

  console.log(`🚪 已加入网络：成员 ${(snapshot.members || []).length} 个，卡片 ${(snapshot.items || []).length} 张`);
  res.json({
    success: true,
    joinedNode: snapshot.nodeId,
    items: (snapshot.items || []).length,
    members: (snapshot.members || []).length,
    selfNodeId: me.nodeId,
  });
}));

// ====== ☁️ 内容寻址增量备份（v3.0.0 阶段 6）======
/** 上传本地新增/改动条目（只传云端没有的地址），随后写一份新清单 */
app.post('/api/backup/blob/sync', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁' });
  // verify=true 时对"已知"条目也去云端核实（云端被清空/换盘后补传）
  const verify = !!(req.body || {}).verify;
  const result = await blobStore.syncItems({ uploadedBy: nodeIdentity.self().nodeId, verify });
  const manifest = result.uploaded ? await blobStore.writeManifest() : null;
  res.json({ success: true, ...result, manifest });
}));

/** 手动写清单（也可单独用） */
app.post('/api/backup/blob/manifest', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁' });
  res.json({ success: true, ...(await blobStore.writeManifest()) });
}));

/** 垃圾回收：只删所有清单都不引用的条目 */
app.post('/api/backup/blob/gc', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：此时 GC 会把云端条目误删' });
  res.json({ success: true, ...(await blobStore.gc()) });
}));

/** 从最新（或指定）清单增量恢复 */
app.post('/api/backup/blob/restore', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁' });
  const manifestKey = String((req.body || {}).manifestKey || '');
  const result = await blobStore.restore({ manifestKey });
  // 恢复后抬升 HLC，避免旧备份把全网数据冲退
  await nodeState.set('hlc', hlcClock.next(nodeIdentity.self().nodeId));
  scheduleBackup();
  res.json({ success: true, ...result });
}));

/** 查看云端条目/清单状态 */
app.get('/api/backup/blob/status', authenticateToken, ah(async (req, res) => {
  try {
    const store = await blobStore.getStore();
    const items = (await store.list('items')).filter((f) => f.endsWith('.opb'));
    const manifests = (await store.list('manifest')).filter((f) => f.endsWith('.opb')).sort();
    const known = await prisma.remoteBlob.count();
    res.json({
      store: store.name,
      items: items.length,
      manifests: manifests.length,
      latestManifest: manifests[manifests.length - 1] || null,
      knownBlobs: known,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ====== 🧭 新节点引导（v3.6.1）======
/**
 * 新设备"刚装好"的判定：
 *  - 没有卡片、没有变更日志、成员表只有自己（或空）
 * 并且用户还没选择过"单独使用"（setupSkipped）。
 * 这几个接口必须免登录：新设备上还没有可用的登录态。
 */
app.get('/api/setup/state', ah(async (req, res) => {
  const [items, changes, members, config] = await Promise.all([
    prisma.item.count(),
    prisma.changeLog.count(),
    prisma.member.count(),
    prisma.appConfig.findUnique({ where: { id: 1 } }),
  ]);
  const skipped = nodeState.get('setupSkipped', '') === '1';
  const fresh = items === 0 && changes === 0 && members <= 1;
  /**
   * 【安全】只有"还没改过初始密码"的节点才允许从登录页退回引导。
   * 一旦用户改过账号密码（isFirstLogin=false），说明这台机器已经初始化完成，
   * 任何人都不该能从登录页把它重新变成"待入网"状态——否则拿到 URL 的人
   * 就能用别人的配对串/账号把节点覆盖掉。
   * 改过密码后想加入网络，必须登录后在「设置 → 共享网络」里操作。
   */
  const neverInitialized = !!config?.isFirstLogin;
  const canReenter = fresh && skipped && neverInitialized;
  res.json({
    fresh,
    skipped,
    showWizard: fresh && !skipped,
    canReenter,
    initialized: !neverInitialized,
    items, changes, members,
    vaultMode: vault.mode(),
  });
}));

/** 选择"不加入网络，单独使用"：只记一个标记，之后正常走首次登录改密 */
app.post('/api/setup/skip', ah(async (req, res) => {
  const items = await prisma.item.count();
  if (items > 0) return res.status(400).json({ error: '本节点已有数据，不需要引导' });
  await nodeState.set('setupSkipped', '1');
  res.json({ success: true });
}));

/**
 * 撤销"单独使用"的选择，重新显示引导页。
 * 免登录：它只在"全新节点"状态下有意义，且没有任何破坏性（不会动数据）。
 * 场景：用户点了"单独使用"进了登录页，又反悔想加入网络。
 */
app.post('/api/setup/reset-skip', ah(async (req, res) => {
  const [items, config] = await Promise.all([
    prisma.item.count(),
    prisma.appConfig.findUnique({ where: { id: 1 } }),
  ]);
  if (items > 0) {
    return res.status(400).json({ error: '本节点已有数据，请改用「设置 → 共享网络 → 加入别的网络」' });
  }
  // 【安全】改过密码就不允许免登录回退，必须先在设置里确认
  if (!config || config.isFirstLogin === false) {
    return res.status(403).json({
      error: '这台设备已初始化完成，请登录后在「设置 → 共享网络 → 加入别的网络」操作',
      code: 'ALREADY_INITIALIZED',
    });
  }
  await nodeState.set('setupSkipped', '');
  res.json({ success: true, showWizard: true });
}));

// ====== 🧩 浏览器扩展打包（v3.7.1）======
/**
 * 把仓库里的 browser-extension/ 目录实时打成 zip 返回。
 * 好处：设置页下载的永远是最新扩展，不再和维护两套脚本。
 */
app.get('/api/extension/bundle', authenticateToken, ah(async (req, res) => {
  const JSZip = require('jszip');
  const fsx = require('fs');
  const pathx = require('path');
  const dir = pathx.join(__dirname, '..', 'browser-extension');
  if (!fsx.existsSync(dir)) return res.status(404).json({ error: '服务端没有 browser-extension 目录' });

  const zip = new JSZip();
  const origin = String(req.query.origin || req.protocol + '://' + req.get('host'));
  for (const name of fsx.readdirSync(dir)) {
    const full = pathx.join(dir, name);
    if (!fsx.statSync(full).isFile()) continue;
    if (name === 'README.md') continue;
    if (!/\.(js|json|html|png|svg)$/i.test(name)) continue;
    let buf = fsx.readFileSync(full);
    // options.js 里预填当前节点地址，省去用户手抄
    if (name === 'options.js') {
      buf = Buffer.from(String(buf).replace("url: conf.url || ''", "url: conf.url || '" + origin + "'"), 'utf8');
    }
    zip.file(name, buf);
  }

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="onepanel-extension.zip"');
  res.send(out);
}));

// ====== 🔁 节点间登录态转移（v3.8.0）======
/**
 * 场景：主域名 Worker 选完节点跳到另一个域名后，localStorage 按域名隔离会丢登录态。
 * 这里用"节点间点对点一次性票据"解决，不需要 Worker 参与认证。
 */
app.post('/api/auth/transfer', authenticateToken, ah(async (req, res) => {
  const toUrl = String((req.body || {}).toUrl || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(toUrl)) return res.status(400).json({ error: '目标地址需要 http(s):// 前缀' });
  const ticket = crypto.randomBytes(24).toString('base64url');
  await nodeState.set('transfer:' + ticket, JSON.stringify({ toUrl, at: Date.now() }));
  res.json({ ticket, from: String(req.protocol + '://' + req.get('host')), toUrl, expiresIn: 300 });
}));

/** 验证对方转来的 ticket，成功签发 60 秒短票据 */
app.post('/api/auth/transfer/verify', ah(async (req, res) => {
  const ticket = String((req.body || {}).ticket || '');
  if (!ticket) return res.status(400).json({ error: '缺少 ticket' });
  const raw = nodeState.get('transfer:' + ticket, '');
  if (!raw) return res.status(410).json({ error: '票据无效或已使用' });
  let info = {};
  try { info = JSON.parse(raw); } catch { info = {}; }
  if (Date.now() - Number(info.at || 0) > 300 * 1000) {
    await nodeState.set('transfer:' + ticket, '');
    return res.status(410).json({ error: '票据已过期' });
  }
  await nodeState.set('transfer:' + ticket, '');
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const shortToken = jwt.sign({ username: config?.username || 'admin', transient: true }, JWT_SECRET, { expiresIn: '60s' });
  res.json({ token: shortToken, username: config?.username || 'admin', nodeId: nodeIdentity.self().nodeId });
}));

/** 接收方：用短期 token 换本机正式登录态 */
app.post('/api/auth/transfer/accept', ah(async (req, res) => {
  const token = String((req.body || {}).token || '');
  if (!token) return res.status(400).json({ error: '缺少 token' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: '票据无效或已过期' }); }
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const username = payload.username || config?.username || 'admin';
  const authToken = jwt.sign({ username, epoch: tokenEpoch }, JWT_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie', authCookie(authToken));
}));

/** 退出：清掉 auth Cookie */
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookie());
  res.json({ success: true });
});

/** 用 Cookie 自查登录态（前端启动时调它，替代"读 localStorage 判断"） */
app.get('/api/auth/me', (req, res) => {
  const cookieToken = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith('auth_token='));
  const token = cookieToken ? decodeURIComponent(cookieToken.slice('auth_token='.length)) : '';
  if (!token) return res.status(401).json({ error: '未登录' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '登录已失效' });
    if (Number(user.epoch) !== Number(tokenEpoch)) return res.status(403).json({ error: '登录已失效' });
    res.json({ ok: true, username: user.username || 'admin' });
  });
});


// ====== 🔑 Passkey（WebAuthn）v3.9.1 ======
/**
 * RP ID 用父域 xtay.cn，这样 cn./us./panel. 任意子域注册的凭据都能互用。
 * origin 校验只比 host（忽略端口），因为实际部署会带端口（:15244 之类）。
 */
// 【P0-2】未配置时不要写死某个域名，否则别人部署直接失败。
// 默认空字符串 = 运行时按请求 hostname 推导（见 rpIdFor）
const RP_ID_ENV = String(process.env.WEBAUTHN_RP_ID || '').trim();
const RP_NAME = String(process.env.WEBAUTHN_RP_NAME || 'OnePanel').trim();
const PASSKEY_ORIGIN_HOSTS = String(process.env.WEBAUTHN_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** 当前请求该用哪个 RP ID：本地回环用 localhost，其余用父域 */
function rpIdFor(req) {
  try {
    const host = new URL(String(req.headers.origin || req.protocol + '://' + req.get('host'))).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return host;
    // 显式配置优先
    if (RP_ID_ENV) return RP_ID_ENV;
    // 未配置：取 hostname 的父域（cn.xtay.cn -> xtay.cn）；
    // 两级域名（xtay.cn）直接用自身；纯 IP 只能用它自己（WebAuthn 下一般不可用）
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
  } catch { return RP_ID_ENV || 'localhost'; }
}

/** 判断请求来源是否被允许（只比 host，忽略协议与端口） */
function originAllowed(origin, req) {
  try {
    const host = new URL(origin).hostname;
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (PASSKEY_ORIGIN_HOSTS.length) {
      return PASSKEY_ORIGIN_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    }
    // 没配白名单时：用"当前请求推导出的 rpId"，允许它自己及其子域
    // 【修复】原来引用已改名的 RP_ID -> ReferenceError
    const rp = rpIdFor(req);
    return host === rp || host.endsWith('.' + rp);
  } catch { return false; }
}

/** 建表（幂等）：passkey 凭据表 */
async function ensurePasskeyTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS Passkey (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credentialId TEXT NOT NULL UNIQUE,
      publicKey TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      label TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      prfWrapped TEXT
    )
  `).catch(() => {});
}

/** 注册挑战暂存（内存足够：一次注册几秒内完成） */
const pkChallenges = new Map();
const PK_TTL = 5 * 60 * 1000;
function putChallenge(kind, challenge) {
  const key = kind + ':' + crypto.randomBytes(8).toString('hex');
  pkChallenges.set(key, { challenge, at: Date.now() });
  // 顺手清过期
  for (const [k, v] of pkChallenges) if (Date.now() - v.at > PK_TTL) pkChallenges.delete(k);
  // 容量上限：防止被高频请求把内存撑爆（限流之外的第二道防线）
  const MAX = 500;
  if (pkChallenges.size > MAX) {
    const extra = pkChallenges.size - MAX;
    let n = 0;
    for (const k of pkChallenges.keys()) {
      if (n++ >= extra) break;
      pkChallenges.delete(k);
    }
  }
  return key;
}
function takeChallenge(key) {
  const v = pkChallenges.get(key);
  pkChallenges.delete(key);
  if (!v || Date.now() - v.at > PK_TTL) return null;
  return v.challenge;
}

/** 是否已有通行密钥（登录页据此决定要不要显示按钮） */
app.get('/api/passkey/status', ah(async (req, res) => {
  await ensurePasskeyTable();
  const rows = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM Passkey').catch(() => [{ n: 0 }]);
  res.json({ enabled: Number(rows[0]?.n || 0) > 0, rpId: RP_ID, rpName: RP_NAME });
}));

/** ① 注册：生成 options（需登录） */
app.get('/api/passkey/register/options', authenticateToken, ah(async (req, res) => {
  await ensurePasskeyTable();
  const rows = await prisma.$queryRawUnsafe('SELECT credentialId FROM Passkey').catch(() => []);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFor(req),
    userID: Buffer.from('onepanel-admin'),
    userName: (await prisma.appConfig.findUnique({ where: { id: 1 } }))?.username || 'admin',
    userDisplayName: 'OnePanel 管理员',
    attestationType: 'none',
    excludeCredentials: (rows || []).map((r) => ({ id: String(r.credentialId) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    // 【PRF】请求 PRF 扩展：注册时若能拿到 prf.results.first，就能用它包住主密钥，
    // 以后指纹一按同时完成"登录 + 解锁保险库"。Chromium 系（Chrome/Edge）已支持。
    extensions: { prf: { eval: { first: require('./services/prfVault').prfSalt() } } },
  });
  const key = putChallenge('reg', options.challenge);
  res.json({ options, challengeKey: key });
}));

/** ② 注册：验证并保存公钥 */
app.post('/api/passkey/register/verify', authenticateToken, ah(async (req, res) => {
  const { response, challengeKey, label, prfOutput } = req.body || {};
  const expectedChallenge = takeChallenge(String(challengeKey || ''));
  if (!expectedChallenge) return res.status(400).json({ error: '挑战已过期，请重试' });
  const origin = String(req.headers.origin || req.protocol + '://' + req.get('host'));
  if (!originAllowed(origin, req)) return res.status(400).json({ error: '来源域名不被允许：' + origin });
  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpIdFor(req),
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: '注册校验失败' });
    }
    const info = verification.registrationInfo;
    const credentialId = info.credential?.id || info.credentialID;
    const publicKey = Buffer.from(info.credential?.publicKey || info.credentialPublicKey).toString('base64');
    const counter = Number(info.credential?.counter ?? info.counter ?? 0);
    // 【PRF】前端如果拿到了 prf.results.first，就用它把当前主密钥包一份存起来。
    // 这样以后"指纹一按"既登录又解锁保险库，不用输密码。
    let prfWrapped = null;
    let prfEnabled = false;
    if (prfOutput) {
      try {
        const { wrapByPrf } = require('./services/prfVault');
        const secret = vault.getSecret();
        if (secret) {
          prfWrapped = wrapByPrf(secret, String(prfOutput));
          prfEnabled = true;
        }
      } catch (e) {
        console.warn('PRF 包裹失败（不影响普通 Passkey 登录）：', e.message);
      }
    }
    await prisma.$executeRawUnsafe(
      'INSERT OR REPLACE INTO Passkey (credentialId, publicKey, counter, label, prfWrapped) VALUES (?, ?, ?, ?, ?)',
      String(credentialId), publicKey, counter, String(label || '我的通行密钥').slice(0, 40), prfWrapped
    );
    // 【v3.9.5】Passkey 同步：让其他节点也认得这条凭据
    try {
      const pv = require('./services/prfVault');
      await recordSideChange('config', String(credentialId), 'passkey-upsert', {
        credentialId: String(credentialId), publicKey, counter,
        label: String(label || '我的通行密钥').slice(0, 40), prfWrapped,
      });
      syncEngine.kick && syncEngine.kick();
    } catch (e) { console.warn('广播 Passkey 失败:', e.message); }
    res.json({ success: true, credentialId, label, prfEnabled });
  } catch (e) {
    res.status(400).json({ error: '注册失败：' + e.message });
  }
}));

/** ③ 登录：生成 options（免登录） */
app.get('/api/passkey/login/options', loginLimiter, ah(async (req, res) => {
  await ensurePasskeyTable();
  const rows = await prisma.$queryRawUnsafe('SELECT credentialId FROM Passkey').catch(() => []);
  if (!rows || !rows.length) return res.status(400).json({ error: '还没有注册通行密钥' });
  const options = await generateAuthenticationOptions({
    rpID: rpIdFor(req),
    allowCredentials: rows.map((r) => ({ id: String(r.credentialId) })),
    userVerification: 'preferred',
    // 【PRF】登录时也要请求，才能拿到同样的派生输出用于解锁
    extensions: { prf: { eval: { first: require('./services/prfVault').prfSalt() } } },
  });
  const key = putChallenge('login', options.challenge);
  res.json({ options, challengeKey: key });
}));

/** ④ 登录：验证签名并签发 Cookie */
app.post('/api/passkey/login/verify', loginLimiter, ah(async (req, res) => {
  const { response, challengeKey, prfOutput } = req.body || {};
  const expectedChallenge = takeChallenge(String(challengeKey || ''));
  if (!expectedChallenge) return res.status(400).json({ error: '挑战已过期，请重试' });
  const origin = String(req.headers.origin || req.protocol + '://' + req.get('host'));
  if (!originAllowed(origin, req)) return res.status(400).json({ error: '来源域名不被允许：' + origin });
  const credId = String(response?.id || '');
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM Passkey WHERE credentialId = ?', credId).catch(() => []);
  const row = rows && rows[0];
  if (!row) return res.status(401).json({ error: '这个通行密钥没有注册过' });
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpIdFor(req),
      requireUserVerification: false,
      credential: {
        id: String(row.credentialId),
        publicKey: Buffer.from(String(row.publicKey), 'base64'),
        counter: Number(row.counter) || 0,
      },
    });
    if (!verification.verified) return res.status(401).json({ error: '签名校验失败' });
    // 更新计数器（防重放）
    await prisma.$executeRawUnsafe(
      'UPDATE Passkey SET counter = ? WHERE credentialId = ?',
      Number(verification.authenticationInfo?.newCounter || row.counter || 0), credId
    );
    const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
    const username = config?.username || 'admin';
    const authToken = jwt.sign({ username, epoch: tokenEpoch }, JWT_SECRET, { expiresIn: '30d' });
    res.setHeader('Set-Cookie', authCookie(authToken));
    // 【PRF】如果这条凭据有 PRF 包裹、前端也给了 prfOutput，就顺手解锁保险库
    let vaultUnlocked = false;
    if (prfOutput && row.prfWrapped) {
      try {
        const { unwrapByPrf } = require('./services/prfVault');
        const secret = unwrapByPrf(String(row.prfWrapped), String(prfOutput));
        if (secret) { vault.setSecret(secret, 'password'); vaultUnlocked = true; }
      } catch (e) {
        console.warn('PRF 解锁失败（密码仍可解锁）：', e.message);
      }
    }
    res.json({ success: true, token: authToken, username, vaultUnlocked });
  } catch (e) {
    res.status(401).json({ error: '登录失败：' + e.message });
  }
}));

/** ⑤ 列出 / 删除通行密钥（需登录） */
app.get('/api/passkey/list', authenticateToken, ah(async (req, res) => {
  await ensurePasskeyTable();
  // 【修复】原来 .catch(() => []) 把"表不存在 / 数据编码坏"这类真错误也吞掉，
  // 前端只看到"没有凭据"，完全无法排查。现在至少打警告，并逐行容错。
  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe('SELECT credentialId, label, createdAt, prfWrapped FROM Passkey');
  } catch (e) {
    console.warn('[passkey] 读取凭据失败（表缺失或数据编码异常）：', e.message.slice(0, 200));
    rows = [];
  }
  const items = [];
  for (const r of rows || []) {
    try {
      items.push({
        credentialId: String(r.credentialId || ''),
        label: r.label == null ? '' : String(r.label),
        createdAt: r.createdAt == null ? '' : String(r.createdAt),
        prf: !!r.prfWrapped,
      });
    } catch { /* 单行坏数据跳过 */ }
  }
  res.json({ items });
}));
app.delete('/api/passkey/:credentialId', authenticateToken, ah(async (req, res) => {
  await prisma.$executeRawUnsafe('DELETE FROM Passkey WHERE credentialId = ?', String(req.params.credentialId)).catch(() => {});
  // 【v3.9.5】删除也要广播，避免其他节点还留着这条凭据
  try {
    await recordSideChange('config', String(req.params.credentialId), 'passkey-delete', { credentialId: String(req.params.credentialId) });
    syncEngine.kick && syncEngine.kick();
  } catch (e) { console.warn('广播删除 Passkey 失败:', e.message); }
  res.json({ success: true });
}));

// ====== 🔄 版本与升级（v3.11.0）======
/** 当前版本（与 package.json 保持同步，发布时由 CI 替换） */
const APP_VERSION = String(process.env.APP_VERSION || require('./package.json').version || '0.0.0');

/** 判断当前安装形态：script / portable / docker / dev */
function detectInstallType() {
  if (fs.existsSync('/.dockerenv')) return 'docker';
  if (process.env.ONEPANEL_INSTALL_TYPE) return String(process.env.ONEPANEL_INSTALL_TYPE);
  // 单文件版会在可执行文件同级放 marker
  try {
    if (fs.existsSync(path.join(process.cwd(), 'portable.marker'))) return 'portable';
  } catch { /* 忽略 */ }
  // 脚本版：/opt/onepanel/current 是软链接
  try {
    const cur = '/opt/onepanel/current';
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) return 'script';
  } catch { /* 忽略 */ }
  return 'dev';
}

/** 是否支持"一键升级"（只有脚本版能自己拉包重启） */
const CAN_AUTO_UPGRADE = () => detectInstallType() === 'script';

/** ① 当前版本信息 */
app.get('/api/system/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    installType: detectInstallType(),
    canAutoUpgrade: CAN_AUTO_UPGRADE(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    port: PORT,
    uptimeSec: Math.round(process.uptime()),
  });
});

/** GitHub 最新版查询缓存（1 小时） */
const UPDATE_REPO = String(process.env.UPDATE_REPO || 'qxsraiy/onepanel-home');
let updateCache = { at: 0, data: null };
async function fetchLatestRelease() {
  if (Date.now() - updateCache.at < 3600 * 1000 && updateCache.data) return updateCache.data;
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { 'user-agent': 'onepanel/' + APP_VERSION, accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error('GitHub API ' + r.status);
  const j = await r.json();
  const data = {
    tag: String(j.tag_name || ''),
    version: String(j.tag_name || '').replace(/^v/, ''),
    name: j.name || '',
    notes: j.body || '',
    url: j.html_url || '',
    publishedAt: j.published_at || '',
    assets: (j.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
  };
  updateCache = { at: Date.now(), data };
  return data;
}

/** 比较版本号：a > b 返回 1 */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** ② 检查更新 */
app.get('/api/system/update-check', authenticateToken, ah(async (req, res) => {
  try {
    const latest = await fetchLatestRelease();
    const hasUpdate = latest.version ? cmpVersion(latest.version, APP_VERSION) > 0 : false;
    res.json({
      current: APP_VERSION,
      latest: latest.version || APP_VERSION,
      hasUpdate,
      releaseUrl: latest.url,
      notes: String(latest.notes || '').slice(0, 4000),
      publishedAt: latest.publishedAt,
      assets: latest.assets,
      installType: detectInstallType(),
      canAutoUpgrade: CAN_AUTO_UPGRADE(),
    });
  } catch (e) {
    res.status(502).json({
      current: APP_VERSION,
      error: '查询 GitHub 失败：' + e.message,
      hint: '国内网络可能需要代理；也可手动去 GitHub Release 页下载',
      releaseUrl: `https://github.com/${UPDATE_REPO}/releases` ,
      installType: detectInstallType(),
      canAutoUpgrade: CAN_AUTO_UPGRADE(),
    });
  }
}));

/** 升级任务状态（内存，进程重启即清空） */
let upgradeJob = { running: false, startedAt: 0, log: [], code: null };

/** ③ 一键升级（仅脚本版） */
app.post('/api/system/upgrade', authenticateToken, ah(async (req, res) => {
  if (!CAN_AUTO_UPGRADE()) {
    return res.status(400).json({ error: '当前安装形态不支持一键升级，请手动更新（详见设置 → 关于）', installType: detectInstallType() });
  }
  if (upgradeJob.running) return res.status(409).json({ error: '已有升级在进行' });
  const script = '/opt/onepanel/current/manage.sh';
  if (!fs.existsSync(script)) return res.status(500).json({ error: '找不到 manage.sh，无法升级' });
  upgradeJob = { running: true, startedAt: Date.now(), log: [], code: null };
  const { spawn } = require('child_process');
  const child = spawn('bash', [script, 'upgrade', '--auto'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const push = (s) => {
    upgradeJob.log.push(String(s).slice(0, 500));
    if (upgradeJob.log.length > 200) upgradeJob.log.shift();
  };
  child.stdout.on('data', (b) => push(b.toString()));
  child.stderr.on('data', (b) => push(b.toString()));
  child.on('close', (code) => { upgradeJob.running = false; upgradeJob.code = code; });
  child.unref();
  res.json({ started: true, note: '升级在后台进行，面板会短暂不可用，稍后刷新即可' });
}));

/** ④ 升级进度 */
app.get('/api/system/upgrade/status', authenticateToken, (req, res) => {
  res.json(upgradeJob);
});

// ====== 📱 手机 App / 桌面小组件 API（v3.10.0）======
/**
 * 设计目标：
 *  1. App 里是浏览器直接登录站点（复用现有 Cookie 登录）
 *  2. 原生桌面小组件需要一个"不需要解密"的明文快照接口
 *  3. 小组件断网时展示本地缓存，恢复后只拉增量（ETag/304）
 *  4. App 可拿节点列表自己测速选最快
 *
 * 认证：App 用 POST /api/app/token 换一个长期 Bearer token（30 天，可撤销）。
 * 也兼容 Cookie（WebView 内直接复用登录态）。
 */

// App 接口放宽 CORS（原生 App / 小组件不走同源策略）
app.use('/api/app', cors({ origin: true, credentials: false }));

/** 建表（幂等）：App Token + 明文快照 */
async function ensureAppTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS AppToken (
      token TEXT PRIMARY KEY,
      label TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastUsedAt TEXT
    )
  `).catch(() => {});
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS AppSnapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      payload TEXT NOT NULL DEFAULT '{}'
    )
  `).catch(() => {});
}

/** 统一的 App 鉴权：Bearer appToken 或 Cookie 登录态 */
const authenticateApp = (req, res, next) => {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const cookieToken = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith('auth_token='));
  const fromCookie = cookieToken ? decodeURIComponent(cookieToken.slice('auth_token='.length)) : '';

  // ① 先试 App token（不需要解锁，能读快照）
  if (bearer) {
    prisma.$queryRawUnsafe("SELECT token FROM AppToken WHERE token = ?", bearer)
      .then((rows) => {
        if (rows && rows.length) {
          // 注：这里用 SQL 等值匹配（数据库层做比较），不存在 JS 层逐字节时序泄露
          prisma.$executeRawUnsafe("UPDATE AppToken SET lastUsedAt = datetime(\'now\') WHERE token = ?", bearer).catch(() => {});
          req.appAuth = { via: 'app-token' };
          return next();
        }
        // 不是 App token，再当普通 JWT 试
        jwt.verify(bearer, JWT_SECRET, (err, user) => {
          if (err) return res.status(401).json({ error: 'App Token 无效' });
          if (Number(user.epoch) !== Number(tokenEpoch)) return res.status(403).json({ error: '登录已失效' });
          req.appAuth = { via: 'jwt-bearer' };
          req.user = user;
          return next();
        });
      })
      .catch(() => res.status(500).json({ error: '鉴权失败' }));
    return;
  }

  // ② 退回到 Cookie
  if (!fromCookie) return res.status(401).json({ error: '请先登录或提供 App Token' });
  jwt.verify(fromCookie, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '登录已失效' });
    if (Number(user.epoch) !== Number(tokenEpoch)) return res.status(403).json({ error: '登录已失效' });
    req.appAuth = { via: 'cookie' };
    req.user = user;
    next();
  });
};

/** ① 用登录态换长期 App Token */
app.post('/api/app/token', authenticateToken, ah(async (req, res) => {
  await ensureAppTables();
  const label = String((req.body || {}).label || '未命名设备').slice(0, 40);
  const token = 'op_' + crypto.randomBytes(24).toString('hex');
  await prisma.$executeRawUnsafe('INSERT INTO AppToken (token, label) VALUES (?, ?)', token, label);
  // 【P1-7】AppToken 必须跨节点同步，否则 App 测速切到别的节点直接 401
  await broadcastConfig('appToken', { action: 'upsert', token, label });
  res.json({ token, label, expiresIn: null, note: '长期有效，可在设置 → API 里撤销' });
}));

/** ② 生成/刷新明文书签快照（需要保险库已解锁） */
app.post('/api/app/snapshot/rebuild', authenticateToken, ah(async (req, res) => {
  const r = await rebuildAppSnapshot();
  if (r.skipped) return res.status(423).json({ error: '保险库未解锁，无法生成快照' });
  res.json({ success: true, version: r.version, bookmarks: r.bookmarks, nodes: r.nodes });
}));


/** ③ 读快照（不需要解锁；支持 ETag / 304，省流量） */
app.get('/api/app/snapshot', authenticateApp, ah(async (req, res) => {
  await ensureAppTables();
  const rows = await prisma.$queryRawUnsafe('SELECT version, updatedAt, payload FROM AppSnapshot WHERE id = 1').catch(() => []);
  const row = rows && rows[0];
  if (!row) return res.status(404).json({ error: '还没有快照，请在设置 → API 里点「生成快照」（需先解锁保险库）' });
  const etag = '"v' + row.version + '"';
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  let data = {};
  try { data = JSON.parse(row.payload); } catch { data = {}; }
  res.json({ version: Number(row.version), updatedAt: row.updatedAt, ...data });
}));

/** ④ 只读书签（小组件最小请求，同样支持 ETag） */
/**
 * 【P0-2】按需取卡片图标（本地图标的二进制流）
 * ------------------------------------------------------------------
 * 快照里超 2KB 的 data: 图标会被剥离并标 hasLocalIcon: true，
 * 客户端按需打这个接口拿真图，避免 Android RemoteViews 撞 Binder 1MB 上限。
 */
app.get('/api/app/icon/:uid', authenticateApp, ah(async (req, res) => {
  const uid = String(req.params.uid || '');
  if (!uid) return res.status(400).json({ error: '缺少 uid' });
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁，无法读取图标' });
  const row = await prisma.item.findFirst({ where: { uid } }).catch(() => null);
  if (!row) return res.status(404).json({ error: '卡片不存在' });
  // 用 itemStore 解包（index.js 里没有直接引入 codec）
  let icon = '';
  try {
    const codecMod = require('./services/itemCodec');
    icon = String(codecMod.unpackRow(row).icon || '');
  } catch { icon = ''; }
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(icon);
  if (!m) return res.status(404).json({ error: '这张卡没有本地图标' });
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return res.status(500).json({ error: '图标数据损坏' }); }
  if (!buf.length) return res.status(404).json({ error: '图标为空' });
  res.setHeader('Content-Type', m[1].toLowerCase());
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Content-Length', String(buf.length));
  res.send(buf);
}));

app.get('/api/app/bookmarks', authenticateApp, ah(async (req, res) => {
  await ensureAppTables();
  const group = String(req.query.group || '').trim();
  const rows = await prisma.$queryRawUnsafe('SELECT version, payload FROM AppSnapshot WHERE id = 1').catch(() => []);
  const row = rows && rows[0];
  if (!row) return res.status(404).json({ error: '还没有快照' });
  let data = {};
  try { data = JSON.parse(row.payload); } catch { data = {}; }
  let list = Array.isArray(data.bookmarks) ? data.bookmarks : [];
  if (group) list = list.filter((b) => b.group === group);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const etag = '"b' + row.version + ':' + group + ':' + limit + '"'
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json({ version: Number(row.version), total: list.length, items: list.slice(0, limit) });
}));

/** ⑤ 节点列表（App 自己测速选最快） */
app.get('/api/app/nodes', authenticateApp, ah(async (req, res) => {
  await ensureAppTables();
  const nameRows = await prisma.$queryRawUnsafe('SELECT nodeId, name FROM Member').catch(() => []);
  const nameMap = Object.fromEntries((nameRows || []).map((r) => [r.nodeId, r.name || '']));
  const members = await prisma.member.findMany().catch(() => []);
  const nodes = members.filter((m) => m.status !== 'revoked').map((m) => ({
    nodeId: m.nodeId, name: nameMap[m.nodeId] || '',
    urls: String(m.selfUrls || '').split(',').map((s) => s.trim()).filter(Boolean),
    role: m.role,
  }));
  res.json({ nodes, selfNodeId: nodeIdentity.self().nodeId });
}));

/** ⑥ 极轻量测速端点（App 用来给每个节点打 RTT） */
app.get('/api/app/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now(), nodeId: nodeIdentity.self().nodeId });
});

/** ⑦ 列出 / 撤销 App Token */
app.get('/api/app/tokens', authenticateToken, ah(async (req, res) => {
  await ensureAppTables();
  const rows = await prisma.$queryRawUnsafe('SELECT token, label, createdAt, lastUsedAt FROM AppToken ORDER BY createdAt DESC').catch(() => []);
  res.json({ items: (rows || []).map((r) => ({
    token: String(r.token).slice(0, 12) + '…', label: r.label || '',
    createdAt: r.createdAt || '', lastUsedAt: r.lastUsedAt || '',
  })) });
}));
app.delete('/api/app/token/:prefix', authenticateToken, ah(async (req, res) => {
  await ensureAppTables();
  const prefix = String(req.params.prefix || '');
  const rows = await prisma.$queryRawUnsafe('SELECT token FROM AppToken').catch(() => []);
  const hit = (rows || []).find((r) => String(r.token).startsWith(prefix));
  if (!hit) return res.status(404).json({ error: '未找到该 Token' });
  await prisma.$executeRawUnsafe('DELETE FROM AppToken WHERE token = ?', hit.token);
  await broadcastConfig('appToken', { action: 'delete', token: String(hit.token) });
  res.json({ success: true });
}));

/** 节点自述（v3.0.0）：同步层用它交换身份、水位与时钟 */
/** 节点自述（v3.0.0）：同步层用它交换身份、水位与时钟 */
app.get('/api/node/info', (req, res) => {
  const me = nodeIdentity.self();
  res.json({
    nodeId: me.nodeId,
    publicKey: me.publicKeyPem,
    selfUrls: String(nodeState.get('selfUrls', '') || ''),
    hlc: nodeState.get('hlc', ''),
    seq: Number(nodeState.get('seq', '0')) || 0,
    vaultLocked: vault.isLocked(),
    version: 'v3.0.0',
    tz: TZ,
    ts: Date.now(),
  });
});

/** 设置本节点对外地址（加入向导会用到） */
app.put('/api/node/urls', authenticateToken, ah(async (req, res) => {
  const list = (req.body || {}).urls;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'urls 必须是数组' });
  const cleaned = [...new Set(list.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, 5);
  await nodeState.set('selfUrls', cleaned.join(','));
  res.json({ success: true, urls: cleaned });
}));;

app.post('/api/login', loginLimiter, ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) return res.status(503).json({ error: '系统正在初始化，请稍后重试' });

  const userOk = typeof username === 'string' && username === config.username;
  const passOk = await bcrypt.compare(String(password), config.password);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 300)); // 失败也稍作延迟，抬高爆破成本
    return res.status(401).json({ error: '账号或密码错误' });
  }

  // 1. 首次登录强制改密（后端不看用户名，前端也不要再按用户名判断）
  if (config.isFirstLogin) {
    const tempToken = jwt.sign({ id: 1, requireChange: true }, JWT_SECRET, { expiresIn: '1h' });
    return res.json({ success: true, isFirstLogin: true, token: tempToken, message: '请修改默认账号密码' });
  res.setHeader('Set-Cookie', authCookie(tempToken, 3600));
  }

  // 2. 2FA
  if (config.twoFactorEnabled && config.twoFactorSecret) {
    const temp2FAToken = jwt.sign({ id: 1, is2FAStage: true }, JWT_SECRET, { expiresIn: '5m' });
    rememberLoginSecret(temp2FAToken, password);
    return res.json({ status: 'NEED_2FA', tempToken: temp2FAToken });
  }

  // 登录成功顺手解锁保险库（密码就在手上，用户不用再输一次）
  await unlockVaultWithPassword(config, String(password));
  // 解锁后补跑整行加密迁移：明文列 → payload 密文（幂等，已加密的会跳过）
  try {
    const migration = await itemStore.migrateLegacy();
    if (migration.migrated) console.log(`🔐 登录后整行加密迁移：${migration.migrated} 张卡片`);
  } catch (e) {
    console.warn('⚠️ 整行加密迁移失败:', e.message);
  }

  const token = jwt.sign({ id: 1, username: config.username, epoch: tokenEpoch }, JWT_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie', authCookie(token));
  res.json({ success: true, isFirstLogin: false, status: 'SUCCESS', token, vaultLocked: vault.isLocked() });
}));

// 【修复 N6】6 位 TOTP 只有 100 万种，必须限流，否则 5 分钟窗口内可穷举
const twoFaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { error: '验证码尝试过于频繁，请稍后再试' },
});

app.post('/api/login/verify-2fa', twoFaLimiter, ah(async (req, res) => {
  const { code, tempToken } = req.body || {};
  if (!code || !tempToken) return res.status(400).json({ error: '验证凭证缺失' });

  const decoded = jwt.verify(tempToken, JWT_SECRET);
  if (!decoded.is2FAStage) return res.status(403).json({ error: '非法请求阶段' });

  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config || !config.twoFactorSecret) return res.status(400).json({ error: '当前未启用 2FA' });

  const isValid = speakeasy.totp.verify({ secret: config.twoFactorSecret, encoding: 'base32', token: String(code), window: 1 });
  if (!isValid) return res.status(401).json({ error: '动态验证码错误或已过期' });

  // 【修复 BUG-7】2FA 通过后用第一步暂存的密码解锁保险库（否则每次重启 2FA 用户都要再解锁一次）
  const remembered = takeLoginSecret(String(tempToken));
  if (remembered) {
    await unlockVaultWithPassword(config, remembered);
    try { await itemStore.migrateLegacy(); } catch (e) { console.warn('⚠️ 整行加密迁移失败:', e.message); }
  }
  const finalToken = jwt.sign({ id: 1, username: config.username, epoch: tokenEpoch }, JWT_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie', authCookie(authToken));
  res.json({ success: true, token: finalToken, vaultLocked: vault.isLocked() });
}));

app.post('/api/change-password', ah(async (req, res) => {
  const { newUsername, newPassword, token } = req.body || {};
  const decoded = jwt.verify(token || '', JWT_SECRET);
  if (!decoded.requireChange) return res.status(403).json({ error: '无效的请求' });
  if (!newUsername || String(newUsername).trim().length < 1) return res.status(400).json({ error: '账号不可为空' });
  const pwErr = checkPasswordStrength(newPassword)
  if (!newPassword || pwErr) return res.status(400).json({ error: pwErr || '密码不符合要求' });
  // 首登改密：下面写库后会顺手用新密码把保险库包起来

  const newHash = await bcrypt.hash(String(newPassword), 10);
  await prisma.appConfig.update({
    where: { id: 1 },
    data: { username: String(newUsername).trim(), password: newHash, isFirstLogin: false },
  });
  if (!vault.envSecret()) {
    const secret = cryptoBox.readLegacyKey() || crypto.randomBytes(32).toString('hex');
    const packed = vault.wrapSecret(secret, String(newPassword));
    await prisma.appConfig.update({ where: { id: 1 }, data: { vaultSalt: packed.salt, vaultWrapped: packed.wrapped } });
    vault.setSecret(secret, 'password');
  }
  // 【修复 N9】改密即吊销所有旧 token（踢人同理可调 bumpTokenEpoch）
  bumpTokenEpoch();
  // 【自检修复 BUG-C】首登改密同样要广播，否则其他节点密码分叉
  try {
    const cfg1 = await prisma.appConfig.findUnique({ where: { id: 1 } });
    await recordSideChange('config', 'account', 'password-change', {
      username: cfg1.username,
      passwordHash: cfg1.password,
      vaultSalt: cfg1.vaultSalt,
      vaultWrapped: cfg1.vaultWrapped,
      fingerprint: vault.fingerprint(),
    });
  } catch (e) {
    console.warn('⚠️ 广播首登改密失败（本机已生效）:', e.message);
  }
  const newToken = jwt.sign({ id: 1, username: String(newUsername).trim(), epoch: tokenEpoch }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token: newToken });
}));

/**
 * 【修复 BUG-7】2FA 登录流程里密码只出现在第一步，第二步拿不到密码就无法解锁保险库。
 * 这里在第一步把密码暂存在内存（5 分钟、一次性），第二步用完即删。
 */
const pendingLoginSecrets = new Map();
const PENDING_SECRET_TTL = 5 * 60 * 1000;
function rememberLoginSecret(tempToken, password) {
  for (const [k, v] of pendingLoginSecrets) if (v.exp < Date.now()) pendingLoginSecrets.delete(k);
  pendingLoginSecrets.set(tempToken, { password: String(password || ''), exp: Date.now() + PENDING_SECRET_TTL });
}
function takeLoginSecret(tempToken) {
  const hit = pendingLoginSecrets.get(tempToken);
  if (!hit) return null;
  pendingLoginSecrets.delete(tempToken);
  if (hit.exp < Date.now()) return null;
  return hit.password;
}

// ====== 🔑 保险库状态 / 解锁（需登录） ======
const vaultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { error: '解锁尝试次数过多，请 15 分钟后再试' },
});

app.get('/api/vault/status', authenticateToken, (req, res) => {
  res.json({ locked: vault.isLocked(), mode: vault.mode() });
});

app.post('/api/vault/unlock', authenticateToken, vaultLimiter, ah(async (req, res) => {
  const password = String((req.body || {}).password || '');
  if (!password) return res.status(400).json({ error: '请输入管理员密码' });
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) return res.status(503).json({ error: '系统尚未初始化' });
  const ok = await bcrypt.compare(password, config.password);
  if (!ok) return res.status(400).json({ error: '密码不正确' });
  const unlocked = await unlockVaultWithPassword(config, password);
  if (!unlocked) return res.status(400).json({ error: '解锁失败：密钥包裹与密码不匹配，请确认是否改过密码' });
  await migrateMemosToEncrypted();
  try {
    const migration = await itemStore.migrateLegacy();
    if (migration.migrated) console.log(`🔐 解锁后整行加密迁移：${migration.migrated} 张卡片`);
  } catch (e) {
    console.warn('⚠️ 整行加密迁移失败:', e.message);
  }
  // 【修复】锁定态期间同步到的卡片变更会让 rebuildAppSnapshot 直接跳过，
  // 解锁后立刻补刷一次，保证 App 快照追平
  try { scheduleSnapshotRebuild(); } catch { /* 忽略 */ }
  res.json({ success: true, locked: false });
}));

app.post('/api/vault/lock', authenticateToken, (req, res) => {
  vault.lock();
  res.json({ success: true, locked: vault.isLocked() });
});

// ====== 🔐 账号与 2FA（需登录） ======
app.get('/api/config/account', authenticateToken, ah(async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  res.json({ username: config?.username || '' });
}));

app.put('/api/config/account', authenticateToken, ah(async (req, res) => {
  const { oldPassword, newUsername, newPassword } = req.body || {};
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const isValid = await bcrypt.compare(String(oldPassword || ''), config.password);
  if (!isValid) return res.status(400).json({ error: '原密码验证失败' }); // 400 而非 401：避免前端误判为登录失效
  if (!newUsername || String(newUsername).trim().length < 1) return res.status(400).json({ error: '账号不可为空' });
  const pwErr = checkPasswordStrength(newPassword)
  if (!newPassword || pwErr) return res.status(400).json({ error: pwErr || '密码不符合要求' });

  const newHash = await bcrypt.hash(String(newPassword), 10);
  await prisma.appConfig.update({
    where: { id: 1 },
    data: { username: String(newUsername).trim(), password: newHash, isFirstLogin: false },
  });
  // 用新密码重新包裹保险库：备忘录与旧备份都不需要重新加密
  try {
    await rewrapVaultForNewPassword(String(oldPassword), String(newPassword));
  } catch (e) {
    console.warn('⚠️ 保险库重包失败:', e.message);
  }
  // 【修复 N9】改密即吊销所有旧 token（踢人同理可调 bumpTokenEpoch）
  bumpTokenEpoch();
  // 【Q1 方案 B】广播新的哈希与密钥包裹：主密钥不变，所以不会产生密钥分叉
  try {
    const cfg2 = await prisma.appConfig.findUnique({ where: { id: 1 } });
    await recordSideChange('config', 'account', 'password-change', {
      username: cfg2.username,
      passwordHash: cfg2.password,
      vaultSalt: cfg2.vaultSalt,
      vaultWrapped: cfg2.vaultWrapped,
      fingerprint: vault.fingerprint(),
    });
  } catch (e) {
    console.warn('⚠️ 广播改密码失败（本机已生效）:', e.message);
  }
  const newToken = jwt.sign({ id: 1, username: String(newUsername).trim(), epoch: tokenEpoch }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token: newToken });
}));

app.get('/api/2fa/status', authenticateToken, ah(async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  res.json({ enabled: !!config?.twoFactorEnabled });
}));

app.get('/api/2fa/setup', authenticateToken, ah(async (req, res) => {
  const secret = speakeasy.generateSecret({ name: 'OnePanel 数字枢纽' });
  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qrCodeUrl });
}));

app.post('/api/2fa/enable', authenticateToken, ah(async (req, res) => {
  const { secret, code } = req.body || {};
  if (!secret || !code) return res.status(400).json({ error: '参数不完整' });

  const isValid = speakeasy.totp.verify({ secret, encoding: 'base32', token: String(code), window: 1 });
  if (!isValid) return res.status(400).json({ error: '验证码错误，校准失败' });

  await prisma.appConfig.update({ where: { id: 1 }, data: { twoFactorSecret: secret, twoFactorEnabled: true } });
  // 【v3.8.0】2FA 改为全网通用：开了之后所有节点用同一个种子
  try {
    await recordSideChange('config', 'twoFactor', 'two-factor', { enabled: true, secret });
    syncEngine.kick && syncEngine.kick();
  } catch (e) { console.warn('广播 2FA 开启失败:', e.message); }
  res.json({ success: true, message: '双因子认证已成功激活' });
}));

/** 【P0-4】只校验密码，不改任何状态（供"重新绑定 2FA"前置验证用） */
app.post('/api/2fa/verify-password', authenticateToken, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '必须提供密码' });
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const ok = await bcrypt.compare(String(password), config.password);
  if (!ok) return res.status(400).json({ error: '密码错误' });
  res.json({ success: true });
}));

app.post('/api/2fa/disable', authenticateToken, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '必须提供密码进行身份验证' });

  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const isValid = await bcrypt.compare(String(password), config.password);
  if (!isValid) return res.status(400).json({ error: '密码错误，拒绝越权操作' });

  await prisma.appConfig.update({ where: { id: 1 }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  try {
    await recordSideChange('config', 'twoFactor', 'two-factor', { enabled: false, secret: null });
    syncEngine.kick && syncEngine.kick();
  } catch (e) { console.warn('广播 2FA 关闭失败:', e.message); }
  res.json({ success: true, message: '2FA 已安全关闭' });
}));

// ====== ⚙️ 配置接口 ======
app.get('/api/config/webdav', authenticateToken, ah(async (req, res) => {
  const c = await prisma.appConfig.findUnique({ where: { id: 1 } });
  res.json({ url: c?.webdavUrl || '', user: c?.webdavUser || '', pass: c?.webdavPass || '' });
}));

app.put('/api/config/webdav', authenticateToken, ah(async (req, res) => {
  const { url, user, pass } = req.body || {};
  if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '必须以 http:// 或 https:// 开头' });
  const old = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const changed = old.webdavUrl !== url || old.webdavUser !== user || old.webdavPass !== pass;

  await prisma.appConfig.update({ where: { id: 1 }, data: { webdavUrl: url, webdavUser: user, webdavPass: pass } });
  await broadcastConfig('webdav', { url, user, pass });
  res.json({ success: true });
  if (changed) scheduleBackup(0); // 让用户立刻拿到一份上传到新云盘的备份
}));

app.get('/api/config/notify', authenticateToken, ah(async (req, res) => {
  const c = await prisma.appConfig.findUnique({ where: { id: 1 } });
  res.json({
    wechatCorpId: c?.wechatCorpId || '',
    wechatCorpSecret: c?.wechatCorpSecret || '',
    wechatAgentId: c?.wechatAgentId || '',
    wechatTouser: c?.wechatTouser || '@all',
  });
}));

app.put('/api/config/notify', authenticateToken, ah(async (req, res) => {
  // 【修复】补 wechatTouser：原来既没解构也没写库，广播时 ReferenceError -> 500
  const { wechatCorpId, wechatCorpSecret, wechatAgentId, wechatTouser } = req.body || {};
  const touser = String(wechatTouser || '@all').trim() || '@all';
  await prisma.appConfig.update({
    where: { id: 1 },
    data: { wechatCorpId, wechatCorpSecret, wechatAgentId, wechatTouser: touser },
  });
  await broadcastConfig('notify', { wechatCorpId, wechatCorpSecret, wechatAgentId, wechatTouser: touser });
  res.json({ success: true });
}));

app.get('/api/config/theme', authenticateToken, ah(async (req, res) => {
  const c = await prisma.appConfig.findUnique({ where: { id: 1 } });
  res.json({
    themeBg: c?.themeBg,
    themeColor: c?.themeColor,
    themeAccent: await (async () => {
      try {
        const rows = await prisma.$queryRawUnsafe('SELECT themeAccent FROM AppConfig WHERE id = 1');
        return rows && rows[0] ? rows[0].themeAccent : null;
      } catch { return null; }
    })(),
    siteIcon: c?.siteIcon,
    bgImage: c?.bgImage,
    siteTitle: c?.siteTitle,
    footerText: c?.footerText,
    groups: c?.groups ? JSON.parse(c.groups) : null,
    cardBgColor: c?.cardBgColor,
    cardBgOpacity: c?.cardBgOpacity,
  });
}));

// ====== 📝 卡片备忘录（v2.6.0）======
const MEMO_MAX = 20000;
/**
 * 备忘录统一成 JSON 字符串存：{ note, entries: [{ label, value, masked }], updatedAt }
 *  - 只认白名单字段，多余键直接丢掉（防止前端塞脏数据把库撑大）
 *  - 内容全空时返回 null，等价于"没有备忘录"
 */
const normalizeMemo = (input) => {
  if (input === null || input === undefined || input === '') return null;
  // 已经是密文（备份包里带的）就原样保留，别再解密再加密绕一圈
  if (typeof input === 'string' && input.startsWith('enc1:')) return { memo: input };
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      // 也允许直接传一段纯文本，当成 note 处理
      obj = { note: input };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const note = String(obj.note ?? '');
  if (note.length > 4000) return { error: '备注最多 4000 个字符' };
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  if (rawEntries.length > 50) return { error: '密码条目最多 50 条' };
  const entries = [];
  for (const e of rawEntries) {
    const label = String(e?.label ?? '');
    const value = String(e?.value ?? '');
    if (label.length > 60) return { error: '条目名称最多 60 个字符' };
    if (value.length > 1000) return { error: '条目内容最多 1000 个字符' };
    if (!label.trim() && !value.trim()) continue;
    entries.push({ label, value, masked: e?.masked !== false });
  }
  if (!note.trim() && !entries.length) return null;
  const payload = JSON.stringify({ note, entries, updatedAt: Date.now() });
  if (payload.length > MEMO_MAX) return { error: '备忘录太大了（上限 20KB）' };
  return { memo: payload };
};

// ====== 🧩 小组件（v2.4.0）=====
const WIDGET_TYPES = ['system', 'clock', 'weather'];
const normalizeWidgetType = (v) => (WIDGET_TYPES.includes(String(v || '')) ? String(v) : null);
/** 小组件参数统一存字符串，限制长度避免把库撑爆；非法 JSON 直接丢弃 */
const normalizeWidgetConfig = (v) => {
  if (v === null || v === undefined || v === '') return null;
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (text.length > 2000) return null;
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
};

const parseOpacity = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
};

// ====== 🎛️ 全局 UI 偏好（v3.9.4）======
/**
 * 以前这些偏好存在 localStorage，换节点就丢（每个域名一份）。
 * 现在统一存服务端，跟账号一起走，所有节点完全一致。
 */
app.get('/api/config/ui', authenticateToken, ah(async (req, res) => {
  const c = await prisma.appConfig.findUnique({ where: { id: 1 } });
  let ui = {};
  try {
    const rows = await prisma.$queryRawUnsafe('SELECT uiPrefs FROM AppConfig WHERE id = 1');
    if (rows && rows[0] && rows[0].uiPrefs) ui = JSON.parse(rows[0].uiPrefs);
  } catch { ui = {}; }
  res.json({ ui });
}));

app.put('/api/config/ui', authenticateToken, ah(async (req, res) => {
  const ui = req.body && typeof req.body === 'object' ? req.body : {};
  // 只接收白名单键，避免被塞进任意垃圾
  const allowed = ['searchEngine', 'showHidden', 'gridCols', 'cardView', 'sortMode'];
  const clean = {};
  for (const k of allowed) if (ui[k] !== undefined) clean[k] = ui[k];
  const text = JSON.stringify(clean).slice(0, 4000);
  try {
    await prisma.$executeRawUnsafe('UPDATE AppConfig SET uiPrefs = ? WHERE id = 1', text);
  } catch {
    return res.status(400).json({ error: '写入失败（uiPrefs 列可能不存在，重启会自动补）' });
  }
    await broadcastConfig('uiPrefs', clean);
  res.json({ success: true, ui: clean });
}));

app.put('/api/config/theme', authenticateToken, ah(async (req, res) => {
  const { themeBg, themeColor, themeAccent, siteIcon, bgImage, siteTitle, footerText, groups, cardBgColor, cardBgOpacity } = req.body || {};
  await prisma.appConfig.update({
    where: { id: 1 },
    data: {
      themeBg, themeColor, siteIcon, bgImage, siteTitle, footerText,
      groups: Array.isArray(groups) ? JSON.stringify(groups) : (groups ?? null),
      cardBgColor,
      cardBgOpacity: parseOpacity(cardBgOpacity),
    },
  });
  // themeAccent 是后加的列：Prisma client 未重新生成时会报 Unknown argument，用 raw SQL 单独写
  if (themeAccent !== undefined) {
    try {
      await prisma.$executeRawUnsafe('UPDATE AppConfig SET themeAccent = ? WHERE id = 1', String(themeAccent || ''));
    } catch (e) {
      console.warn('写入 themeAccent 失败:', e.message);
    }
  }
  await broadcastConfig('theme', { themeBg, themeColor, themeAccent, siteIcon, bgImage: undefined, siteTitle, footerText, cardBgColor, cardBgOpacity });
  res.json({ success: true });
  scheduleBackup();
}));

/** 只改分组：避免"读整包→写整包"造成的多端互相覆盖 */
app.put('/api/config/groups', authenticateToken, ah(async (req, res) => {
  const { groups } = req.body || {};
  if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) {
    return res.status(400).json({ error: '分组必须是字符串数组' });
  }
  // 【B-09】分组名限制 1~50 字符，去掉首尾空白，拒绝空名
  const cleaned = [...new Set(
    groups.map((g) => String(g).trim()).filter((g) => g.length > 0 && g.length <= 50)
  )];
  if (cleaned.length === 0) return res.status(400).json({ error: '至少保留一个分组' });
  await prisma.appConfig.update({ where: { id: 1 }, data: { groups: JSON.stringify(cleaned) } });
  scheduleBackup();
    await broadcastConfig('groups', cleaned);
  res.json({ success: true, groups: cleaned });
}));

// ====== 📌 业务接口 ======
app.get('/api/items', authenticateToken, ah(async (req, res) => {
  // 整行加密：锁定态只返回占位卡片，解锁后才是真实内容
  res.json(await itemStore.listAll({ locked: vault.isLocked() }));
}));

app.post('/api/items', authenticateToken, ah(async (req, res) => {
  const { type, name, description, icon, openMethod, urls, bgColor, bgOpacity, isMonitored, pingUrl, group, gridX, gridY, isHidden, isPinned, widgetType, widgetConfig } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '名称不能为空' });
  const cleanUrls = (Array.isArray(urls) ? urls : []).filter((u) => u && u.url && String(u.url).trim());
  const widget = normalizeWidgetType(widgetType);
  // 小组件卡是纯展示块，不要求填网址；普通卡片仍然至少一条线路
  if (!widget && cleanUrls.length === 0) return res.status(400).json({ error: '至少需要一个有效地址' });

  // 整行加密：业务字段进 payload，明文列只留同步元数据
  const newItem = await itemStore.create({
    type: type || 'bookmark',
    name: String(name).trim(),
    description,
    icon,
    openMethod: openMethod || 'new_tab',
    bgColor,
    bgOpacity: parseOpacity(bgOpacity),
    isMonitored: !!isMonitored,
    pingUrl,
    group: group || '书签',
    isHidden: !!isHidden,
    isPinned: !!isPinned,
    widgetType: widget,
    widgetConfig: widget ? normalizeWidgetConfig(widgetConfig) : null,
    gridX: Number(gridX) || null,
    gridY: Number(gridY) || null,
    urls: cleanUrls,
  });
  await recordChangeForItem(newItem.uid, 'upsert');
  res.json(newItem);
  scheduleBackup();
}));

app.put('/api/items/position', authenticateToken, ah(async (req, res) => {
  const { id, gridX, gridY, group } = req.body || {};
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁' });
  const updated = await itemStore.patch(id, { gridX: Number(gridX) || null, gridY: Number(gridY) || null, group });
  if (!updated) return res.status(404).json({ error: '卡片不存在' });
  res.json({ success: true });
  await recordChangeForItem(updated.uid, 'upsert');
  scheduleBackup();
}));

/** 轻量标记：置顶 / 隐藏。只动这两个字段，不碰地址表与样式 */
/** 卡片备忘录：独立接口，不改动卡片本身的任何字段 */
app.put('/api/items/:id/memo', authenticateToken, ah(async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: '卡片 ID 不合法' });

  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：请先输入管理员密码解锁后再编辑备忘录' });
  const normalized = normalizeMemo(req.body?.memo);
  if (normalized && normalized.error) return res.status(400).json({ error: normalized.error });
  const plainMemo = normalized ? normalized.memo : null;
  // 备忘录现在是 payload 的一部分（整行加密），不再单独存密文列
  const updated = await itemStore.patch(itemId, { memo: plainMemo });
  if (!updated) return res.status(404).json({ error: '卡片不存在或已被删除' });
  res.json({ success: true, memo: plainMemo });
  await recordChangeForItem(updated.uid, 'upsert');
  scheduleBackup();
}));

app.put('/api/items/:id/flags', authenticateToken, ah(async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: '卡片 ID 不合法' });
  const body = req.body || {};
  const data = {};
  if (body.isHidden !== undefined) data.isHidden = !!body.isHidden;
  if (body.isPinned !== undefined) data.isPinned = !!body.isPinned;
  if (!Object.keys(data).length) return res.status(400).json({ error: '没有可更新的标记' });
  const updated = await itemStore.patch(itemId, data);
  if (!updated) return res.status(404).json({ error: '卡片不存在或已被删除' });
  await recordChangeForItem(updated.uid, 'upsert');
  res.json({ success: true, ...data });
  scheduleBackup();
}));

app.put('/api/items/bulk-style', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：此时批量改样式会误改全部卡片' });
  const { bgColor, bgOpacity, applyToAll } = req.body || {};
  const patchBody = { bgColor, bgOpacity: parseOpacity(bgOpacity) };
  const list = await itemStore.listAll({ locked: false, strict: true });
  let changed = 0;
  for (const item of list) {
    if (!applyToAll && (item.bgColor || item.bgColor === '')) continue;
    await itemStore.patch(item.id, patchBody);
    changed += 1;
  }
  res.json({ success: true, changed });
  scheduleBackup();
}));

app.put('/api/items/group/transfer', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：此时批量转移会误改全部卡片' });
  const { oldGroup, newGroup } = req.body || {};
  if (!oldGroup || !newGroup) return res.status(400).json({ error: '参数不完整' });
  const list = await itemStore.listAll({ locked: false, strict: true });
  let changed = 0;
  // 【E-06】逐条容错：单条失败不影响其余，返回"成功 N / 失败 M"
  const targets = list.filter((item) => item.group === oldGroup);
  const settled = await forEachSettled(targets, async (item) => {
    await itemStore.patch(item.id, { group: newGroup });
  });
  changed += settled.done;
  if (settled.failed.length) {
    console.warn('[group/transfer] 部分失败:', settled.failed.length, settled.failed.slice(0, 3));
    return res.status(207).json({ success: false, changed, failed: settled.failed, message: '部分卡片转移失败' });
  }
  res.json({ success: true, changed });
}));

app.delete('/api/items/group/:groupName', authenticateToken, ah(async (req, res) => {
  // 【修复 N1】批量删除必须要求已解锁：锁定态下卡片解不开，分组名会退化成默认值而误伤全部
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：此时批量删除会误伤全部卡片' });
  // 批量写用严格模式：有一张卡损坏就整批拒绝，绝不拿占位卡去写库

  const target = String(req.params.groupName || '');
  const list = await itemStore.listAll({ locked: false, strict: true });
  let removed = 0;
  for (const item of list) {
    if (item.group !== target) continue;
    const row = await itemStore.softDelete(item.id);
    if (row) { await recordChangeForItem(row.uid, 'delete'); removed += 1; }
  }
  res.json({ success: true, removed });
  scheduleBackup();
}));

app.put('/api/items/:id', authenticateToken, ah(async (req, res) => {
  const itemId = Number(req.params.id);
  const body = req.body || {};
  const cleanUrls = (Array.isArray(body.urls) ? body.urls : []).filter((u) => u && u.url && String(u.url).trim());
  const hasUrls = Array.isArray(body.urls);
  const widget = normalizeWidgetType(body.widgetType);
  const current = await itemStore.getById(itemId);
  if (!current) return res.status(404).json({ error: '卡片不存在' });

  // 整行重写：没传的字段沿用旧值（避免"只改标记却清空线路"）
  const merged = {
    ...current,
    name: body.name !== undefined ? body.name : current.name,
    description: body.description !== undefined ? body.description : current.description,
    icon: body.icon !== undefined ? body.icon : current.icon,
    // 【修复 BUG-11】没传就沿用旧值，别把 same_tab 硬编码回 new_tab
    openMethod: body.openMethod === undefined ? current.openMethod : (body.openMethod === 'same_tab' ? 'same_tab' : 'new_tab'),
    // 【批次 2.2】卡片尺寸：只接受 1/2，其余沿用旧值
    cardW: body.cardW === undefined ? current.cardW : (Number(body.cardW) === 2 ? 2 : 1),
    cardH: body.cardH === undefined ? current.cardH : (Number(body.cardH) === 2 ? 2 : 1),
    bgColor: body.bgColor !== undefined ? body.bgColor : current.bgColor,
    bgOpacity: body.bgOpacity !== undefined ? parseOpacity(body.bgOpacity) : current.bgOpacity,
    isMonitored: body.isMonitored !== undefined ? !!body.isMonitored : current.isMonitored,
    pingUrl: body.pingUrl !== undefined ? body.pingUrl : current.pingUrl,
    group: body.group !== undefined ? body.group : current.group,
    isHidden: body.isHidden !== undefined ? !!body.isHidden : current.isHidden,
    isPinned: body.isPinned !== undefined ? !!body.isPinned : current.isPinned,
    // 【BUG】body 没传 widgetType 时不能 normalize 成 null，否则"只改名字"会把小组件降级成普通卡
    widgetType: body.widgetType === undefined ? current.widgetType : widget,
    widgetConfig: (body.widgetType === undefined || body.widgetConfig === undefined) && body.widgetType !== null && widget === current.widgetType
      ? (current.widgetConfig || null)
      : (widget ? normalizeWidgetConfig(body.widgetConfig) : null),
    gridX: body.gridX !== undefined ? Number(body.gridX) || null : current.gridX,
    gridY: body.gridY !== undefined ? Number(body.gridY) || null : current.gridY,
    urls: hasUrls ? cleanUrls : current.urls,
  };
  const updated = await itemStore.replace(itemId, merged);
  res.json({ success: true });
  await recordChangeForItem(updated.uid, 'upsert');
  scheduleBackup();
}));

app.delete('/api/items/:id', authenticateToken, ah(async (req, res) => {
  const row = await itemStore.softDelete(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '卡片不存在' });
  await recordChangeForItem(row.uid, 'delete');
  res.json({ success: true });
  scheduleBackup();
}));

/** 多线路探活：由后端做 TCP 探测，前端不再受"混合内容 / CORS"限制 */
app.post('/api/items/:id/probe', authenticateToken, ah(async (req, res) => {
  const item = await itemStore.getById(Number(req.params.id));
  if (!item || !item.urls.length) return res.json({ url: null });
  const urls = item.urls.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)).map((u) => u.url);
  const best = await probeFastestUrl(urls);
  res.json({ url: best || urls[0], probed: urls.length });
}));

// ====== 🔍 站点图标抓取 ======
// 抓取目标站点首页，解析 <link rel="*icon*">，失败回退 /favicon.ico
const ICON_LINK_RE = /<link[^>]+rel\s*=\s*["'][^"']*(?:icon|apple-touch-icon)[^"']*["'][^>]*>/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/i;
const SIZES_RE = /sizes\s*=\s*["'](\d+)x\d+["']/i;

app.get('/api/utils/favicon', authenticateToken, ah(async (req, res) => {
  const raw = String(req.query.url || '').trim();
  let target;
  try {
    target = new URL(raw);
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'URL 不合法' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OnePanel/2.0; +favicon-fetcher)', Accept: 'text/html' },
    });
    // 只取前 512KB，避免大页面撑爆内存
    const text = (await resp.text()).slice(0, 512 * 1024);

    const candidates = [];
    for (const m of text.matchAll(ICON_LINK_RE)) {
      const tag = m[0];
      const href = HREF_RE.exec(tag)?.[1];
      if (!href || href.startsWith('data:')) continue;
      let abs;
      try { abs = new URL(href, resp.url || target.toString()).toString(); } catch { continue; }
      const size = Number(SIZES_RE.exec(tag)?.[1] || 0);
      const score = (tag.includes('svg') ? 1000 : 0) + (tag.includes('apple-touch-icon') ? 500 : 0) + size;
      candidates.push({ url: abs, score });
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      return res.json({ icon: candidates[0].url });
    }
  } catch (e) {
    // 页面抓不到不致命，走 /favicon.ico 兜底
  } finally {
    clearTimeout(timer);
  }
  res.json({ icon: `${target.origin}/favicon.ico` });
}));

// ====== 🩺 监控接口 ======
/** 【批次 2.4】站点存活历史：最近 N 次探测，用于画可用性条形图 */
/**
 * 只返回分组名（给扩展/popup 用，避免为了分组列表拉全量卡片）。
 * 【修复】
 *  ① 从 AppConfig.groups 读，新建但还没放卡片的"空分组"也能拿到；
 *  ② 不再依赖保险库解锁状态（原来锁定时卡片全变占位，分组名会失真）。
 *  最后与卡片里实际用到的分组取并集，防止历史卡片用到已从配置里删掉的分组。
 */
app.get('/api/groups', authenticateToken, ah(async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  let configured = [];
  try {
    configured = config && config.groups ? JSON.parse(config.groups) : [];
  } catch {
    configured = [];
  }
  // 卡片里实际出现的分组（锁定态也能读到 group 吗？不能——占位卡 group 固定为"未解锁"，
  // 所以这里只在不锁定时补充，锁定时直接用配置值）
  const used = [];
  if (!vault.isLocked()) {
    const rows = await itemStore.listAll({ locked: false, includeDeleted: false });
    for (const r of rows) if (r.group && !r.corrupted) used.push(r.group);
  }
  const groups = [...new Set([...configured, ...used])].filter((g) => g && g !== '未解锁' && g !== '异常');
  res.json({ groups });
}));

app.get('/api/monitor/history', authenticateToken, ah(async (req, res) => {
  const uid = String(req.query.uid || '');
  const limit = Math.min(240, Math.max(1, Number(req.query.limit || 60)));
  if (!uid) return res.status(400).json({ error: '需要 uid' });
  const rows = await prisma.pingHistory.findMany({
    where: { uid },
    orderBy: { checkedAt: 'desc' },
    take: limit,
    select: { ok: true, latencyMs: true, checkedAt: true },
  });
  const list = rows.reverse();
  const total = list.length;
  const okCount = list.filter((r) => r.ok).length;
  const lats = list.filter((r) => r.ok && r.latencyMs != null).map((r) => r.latencyMs);
  res.json({
    uid,
    total,
    availability: total ? Math.round((okCount / total) * 1000) / 10 : null,
    avgLatency: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
    list,
  });
}));

app.get('/api/monitor/status', authenticateToken, (req, res) => res.json(pingMonitor.getStatus()));

/** 天气小组件：代理 wttr.in，10 分钟缓存，失败缓存 60 秒 */
app.get('/api/widgets/weather', authenticateToken, ah(async (req, res) => {
  const city = String(req.query.city || '').trim();
  if (city.length > 40) return res.status(400).json({ error: '城市名太长' });
  const result = await getWeather(city, { force: String(req.query.refresh || '') === '1' });
  if (result.error) return res.status(503).json({ error: result.error });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...result.data, cached: !!result.cached });
}));

/** 系统状态：CPU / 内存 / 磁盘 / 运行时长（前端 3s 轮询，别做缓存） */
app.get('/api/system/stats', authenticateToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(getSystemStats());
  } catch (e) {
    res.status(500).json({ error: '读取系统状态失败：' + e.message });
  }
});

app.put('/api/monitor/unbind/:id', authenticateToken, ah(async (req, res) => {
  await prisma.item.update({ where: { id: Number(req.params.id) }, data: { isMonitored: false, pingUrl: null } });
  res.json({ success: true });
  scheduleBackup();
}));

app.post('/api/monitor/test-notify', authenticateToken, ah(async (req, res) => {
  const stamp = new Date().toLocaleString('zh-CN', { timeZone: TZ });
  const success = await wechatNotify.send(`🔔 OnePanel 测试通知\n\n这是一条测试消息，说明企业微信推送配置已打通。\n时间：${stamp}`);
  if (success) return res.json({ success: true });
  res.status(500).json({ error: '推送失败：请检查企微参数是否正确，或查看后端日志详细报错' });
}));

// ====== 📥 备份 / 恢复 ======
const SQLITE_MAGIC = 'SQLite format 3\u0000';
const MAX_DECOMPRESSED = Number(process.env.MAX_RESTORE_BYTES || 128 * 1024 * 1024);

/**
 * 统一恢复引擎：先判定文件类型，再走对应分支。
 * 未知/损坏文件会直接抛错，绝不写盘。
 */
async function processRestoreData(decompressedBuffer) {
  const currentConfig = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!currentConfig) throw new Error('系统未初始化，无法恢复');

  const isSqlite = decompressedBuffer.subarray(0, 16).toString('latin1') === SQLITE_MAGIC;

  if (!isSqlite) {
    // ---- JSON 逻辑备份 ----
    let backupData;
    try {
      backupData = JSON.parse(decompressedBuffer.toString('utf-8'));
    } catch {
      throw new Error('备份文件不可识别：既不是 JSON 备份，也不是 SQLite 数据库文件');
    }
    if (!backupData || typeof backupData !== 'object' || !backupData.config) {
      throw new Error('备份文件结构不正确（缺少 config 段）');
    }

    const updateData = { ...backupData.config };
    delete updateData.id;
    // 恢复后强制沿用当前账号口令，避免被备份里的旧口令覆盖
    // 【修复】备份里的 vault 包裹一律不采用：它是用"备份时的密码"包的，
    // 覆盖过来会让当前密码解不开，还会谎报恢复成功。
    delete updateData.vaultSalt;
    delete updateData.vaultWrapped;
    updateData.username = currentConfig.username;
    updateData.password = currentConfig.password;
    updateData.isFirstLogin = currentConfig.isFirstLogin;

    await prisma.appConfig.update({ where: { id: 1 }, data: updateData });

    if (Array.isArray(backupData.items)) {
      // 【修复 N2】恢复同样要走墓碑，否则其他节点会把被删的卡再推回来
      const olds = await itemStore.listAll({ locked: false, strict: true });
      for (const it of olds) {
        const row = await itemStore.softDelete(it.id);
        if (row) await recordChangeForItem(row.uid, 'delete');
      }
      await prisma.itemUrl.deleteMany({});
      for (const item of backupData.items) {
        // 保留原 uid，恢复后不会变成"一批新卡片"
        await itemStore.create({
          uid: item.uid || undefined,
          type: item.type,
          name: item.name,
          description: item.description,
          icon: item.icon,
          openMethod: item.openMethod,
          bgColor: item.bgColor,
          bgOpacity: item.bgOpacity,
          isMonitored: item.isMonitored,
          pingUrl: item.pingUrl,
          group: item.group,
          isHidden: item.isHidden,
          isPinned: item.isPinned,
          widgetType: normalizeWidgetType(item.widgetType),
          widgetConfig: normalizeWidgetConfig(item.widgetConfig),
          memo: item.memo,
          gridX: item.gridX,
          gridY: item.gridY,
          urls: item.urls || [],
        });
      }
      // 恢复后本地 HLC 必须跳到最后，避免"旧备份把全网数据冲退"
      await nodeState.set('hlc', hlcClock.next(nodeIdentity.self().nodeId));
      // 【修复 N2】恢复出来的卡也要留同步痕迹，否则其他节点永远看不到
      const restored = await itemStore.listAll({ locked: false });
      for (const it of restored) {
        await recordChangeForItem(it.uid, 'upsert');
      }
    }
    return { mode: 'json', items: Array.isArray(backupData.items) ? backupData.items.length : 0 };
  }

  // ---- 物理 SQLite 恢复（老版备份格式）----
  // 【修复】优先按 DATABASE_URL 定位真实库文件，否则多节点部署会写错文件还报"成功"
  const dbPath = (() => {
    if (process.env.DATABASE_FILE) return process.env.DATABASE_FILE;
    const raw = String(process.env.DATABASE_URL || '');
    const m = raw.match(/^file:(.+)$/);
    if (m) { const p = m[1]; return p.startsWith('/') ? p : path.join(__dirname, 'prisma', p); }
    return path.join(__dirname, 'prisma', 'dev.db');
  })();
  if (fs.existsSync(dbPath)) {
    const bakPath = `${dbPath}.pre-restore-${getFormattedDate()}.bak`;
    fs.copyFileSync(dbPath, bakPath);
    console.log(`🗄️ 恢复前已快照当前数据库 → ${bakPath}`);
  }

  await prisma.$disconnect();
  fs.writeFileSync(dbPath, decompressedBuffer);
  try {
    await prisma.$connect();
    const probe = await prisma.appConfig.findUnique({ where: { id: 1 } });
    if (!probe) throw new Error('恢复后的数据库缺少配置记录');
  } catch (e) {
    throw new Error(`恢复的数据库无法读取，请用同名 .bak 快照回滚：${e.message}`);
  }

  await prisma.appConfig.update({
    where: { id: 1 },
    data: {
      username: currentConfig.username,
      password: currentConfig.password,
      isFirstLogin: currentConfig.isFirstLogin,
    },
  });
  return { mode: 'sqlite' };
}

app.get('/api/backup/download', authenticateToken, ah(async (req, res) => {
  if (!fs.existsSync(backupDir)) return res.status(404).json({ error: '暂无备份' });
  const files = fs.readdirSync(backupDir).filter((f) => BACKUP_FILE_RE.test(f)).sort().reverse();
  if (files.length === 0) return res.status(404).json({ error: '暂无备份文件，先做一次修改即可生成' });

  const latest = files[0];
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(path.join(backupDir, latest), latest);
}));

app.get('/api/backup/cloud-list', authenticateToken, ah(async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config?.webdavUrl || !config?.webdavUser || !config?.webdavPass) return res.json([]);

  const client = createClient(config.webdavUrl, { username: config.webdavUser, password: config.webdavPass });
  const contents = await client.getDirectoryContents('/');
  const backups = (Array.isArray(contents) ? contents : [])
    .filter((f) => {
      const name = f.basename || (f.filename ? f.filename.split('/').pop() : '');
      return name && BACKUP_FILE_RE.test(name);
    })
    .map((f) => ({
      name: f.basename || (f.filename ? f.filename.split('/').pop() : 'unknown'),
      size: f.size || 0,
      lastModified: f.lastmod || new Date().toISOString(),
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
  res.json(backups);
}));

/** 只接受加密备份包（.opb）：解密 → 解压 */
const decodeBackupPayload = (buffer) => {
  if (!buffer || !buffer.length) throw new Error('文件内容为空');
  if (!cryptoBox.isEncryptedBuffer(buffer)) {
    throw new Error('不是加密备份包（只支持 .opb；旧版 .gz 已停止支持）');
  }
  let plain;
  try {
    plain = cryptoBox.decryptBuffer(buffer, 'backup');
  } catch (e) {
    throw new Error('备份包解密失败（恢复时请设置与备份时相同的 APP_SECRET / .secret-key）: ' + e.message);
  }
  return zlib.gunzipSync(plain, { maxOutputLength: MAX_DECOMPRESSED });
};

const decodeBackupBase64 = (base64OrDataUrl) => {
  const raw = String(base64OrDataUrl || '');
  const b64 = raw.includes(',') ? raw.split(',').pop() : raw;
  if (!b64) throw new Error('文件内容为空');
  return decodeBackupPayload(Buffer.from(b64, 'base64'));
};

app.post('/api/backup/restore-local', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：请先输入管理员密码解锁后再恢复备份' });
  let decompressed;
  try {
    decompressed = decodeBackupBase64((req.body || {}).fileData);
  } catch (e) {
    return res.status(400).json({ error: '备份包无法恢复（请确认是 OnePanel 生成的 .opb 文件）: ' + e.message });
  }
  const result = await processRestoreData(decompressed);
  res.json({ success: true, message: '本地数据恢复成功，账号密码已安全保留！', ...result });
}));

app.post('/api/backup/restore-cloud', authenticateToken, ah(async (req, res) => {
  if (vault.isLocked()) return res.status(423).json({ error: '保险库未解锁：请先输入管理员密码解锁后再恢复备份' });
  const safeName = path.basename(String((req.body || {}).fileName || ''));
  if (!BACKUP_FILE_RE.test(safeName)) return res.status(400).json({ error: '文件名不合法' });

  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config?.webdavUrl || !config?.webdavUser) return res.status(400).json({ error: '未配置 WebDAV' });

  const client = createClient(config.webdavUrl, { username: config.webdavUser, password: config.webdavPass });
  const cloudFile = await client.getFileContents(`/${safeName}`);
  let decompressed;
  try {
    decompressed = decodeBackupPayload(Buffer.from(cloudFile));
  } catch (e) {
    return res.status(400).json({ error: '云端备份包无法解密/解压（只支持 .opb）: ' + e.message });
  }
  const result = await processRestoreData(decompressed);
  res.json({ success: true, message: '云端备份恢复成功，账号密码已安全保留！', ...result });
}));

// ====== 📤 JSON 导入导出（配置即代码，不含任何敏感字段） ======
// ====== 🔐 转移导出（v2.8.0）：二次验证后才给明文 JSON，用来换机 / 搬家 ======
const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { error: '验证失败次数过多，请 15 分钟后再试' },
});

/** 密码或两步验证码，任一通过即可 */
async function verifyIdentity(config, body = {}) {
  const code = String(body.code || '').trim();
  if (code && config.twoFactorEnabled && config.twoFactorSecret) {
    try {
      const ok = speakeasy.totp.verify({ secret: config.twoFactorSecret, encoding: 'base32', token: code, window: 1 });
      if (ok) return true;
    } catch {
      /* 验证码格式不对就走密码分支 */
    }
  }
  const password = String(body.password || '');
  if (!password) return false;
  try {
    return await bcrypt.compare(password, config.password);
  } catch {
    return false;
  }
}

app.post('/api/transfer/export', authenticateToken, transferLimiter, ah(async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) return res.status(503).json({ error: '系统尚未初始化' });
  const body = req.body || {};
  if (!body.password && !body.code) return res.status(400).json({ error: '请先输入账号密码或两步验证码' });
  const ok = await verifyIdentity(config, body);
  // 用 400 而不是 403：前端拦截器会把 403 当成登录失效，验证错一次就被踢下线太凶
  if (!ok) return res.status(400).json({ error: '身份验证失败：密码或验证码不正确' });
  // 导出带备忘录明文：给了密码就顺手解锁；只给 2FA 又没解锁则解不开
  if (vault.isLocked()) {
    if (body.password) await unlockVaultWithPassword(config, String(body.password));
    if (vault.isLocked()) return res.status(423).json({ error: '请先输入管理员密码解锁保险库（仅 2FA 无法解密备忘录）' });
  }

  const items = await itemStore.listAll({ locked: false });
  const payload = {
    app: 'onepanel',
    kind: 'transfer',
    version: 1,
    exportedAt: new Date().toISOString(),
    account: { username: config.username },
    groups: config.groups ? JSON.parse(config.groups) : [],
    theme: {
      themeBg: config.themeBg, themeColor: config.themeColor, siteIcon: config.siteIcon,
      bgImage: config.bgImage, siteTitle: config.siteTitle, footerText: config.footerText,
      cardBgColor: config.cardBgColor, cardBgOpacity: config.cardBgOpacity,
    },
    // 名称 / 描述 / 图标 / 全部线路 / 标记 / 小组件 / 备忘录（明文，换机后要能直接用）
    items: items.map((i) => ({
      uid: i.uid, hlc: i.hlc,
      type: i.type, name: i.name, description: i.description, icon: i.icon,
      openMethod: i.openMethod, group: i.group, order: i.order,
      bgColor: i.bgColor, bgOpacity: i.bgOpacity,
      gridX: i.gridX, gridY: i.gridY,
      isHidden: i.isHidden, isPinned: i.isPinned,
      isMonitored: i.isMonitored, pingUrl: i.pingUrl,
      widgetType: i.widgetType, widgetConfig: i.widgetConfig,
      memo: i.memo,
      urls: (i.urls || []).map((u) => ({ url: u.url, label: u.label, priority: u.priority })),
    })),
  };

  const stamp = new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(/[: ]/g, '-');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Disposition', `attachment; filename="onepanel-transfer-${stamp}.json"`);
  res.json(payload);
}));

/** 解密转移 JSON：导入同样要验证身份（导入是覆盖型操作，比导出更危险） */
app.post('/api/transfer/import', authenticateToken, transferLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) return res.status(503).json({ error: '系统尚未初始化' });
  if (!body.password && !body.code) return res.status(400).json({ error: '请先输入账号密码或两步验证码' });
  if (!(await verifyIdentity(config, body))) return res.status(400).json({ error: '身份验证失败：密码或验证码不正确' });
  if (vault.isLocked()) {
    if (body.password) await unlockVaultWithPassword(config, String(body.password));
    if (vault.isLocked()) return res.status(423).json({ error: '请先输入管理员密码解锁后再导入' });
  }

  const raw = body.payload || body.data || body;
  // 兼容三种形状：转移包（items 在顶层）/ 旧版 export-json（items 在 data 下）/ 直接贴 items
  const data = raw && raw.data && Array.isArray(raw.data.items) ? raw.data : raw;
  if (!data || !Array.isArray(data.items)) {
    return res.status(400).json({ error: '文件格式不正确（需要 OnePanel 转移 JSON）' });
  }
  if (data.items.length > 5000) return res.status(400).json({ error: '卡片数量超出限制' });
  const mode = body.mode === 'merge' ? 'merge' : 'replace';

  if (mode === 'replace') {
    // 【修复 N2】不能物理删除：deleteMany 不留墓碑，其他节点下一轮 pull 会把旧卡"复活"
    const olds = await itemStore.listAll({ locked: false, strict: true });
    for (const it of olds) {
      const row = await itemStore.softDelete(it.id);
      if (row) await recordChangeForItem(row.uid, 'delete');
    }
    await prisma.itemUrl.deleteMany({});
  }
  let imported = 0;
  for (const i of data.items) {
    if (!i || !i.name || !String(i.name).trim()) continue;
    const cleanUrls = (Array.isArray(i.urls) ? i.urls : []).filter((u) => u && u.url && String(u.url).trim());
    if (!cleanUrls.length && !normalizeWidgetType(i.widgetType)) continue;
    // 【修复】merge 导入撞上已存在的 uid 会触发唯一约束 500；存在就按 id 覆盖（并清墓碑复活）
    const existed = i.uid ? await prisma.item.findFirst({ where: { uid: i.uid } }) : null;
    const saveItem = existed ? itemStore.replace.bind(null, existed.id) : itemStore.create.bind(null);
    await saveItem({
      uid: i.uid || undefined,
      hlc: i.hlc || undefined,
      type: i.type || 'bookmark',
      name: String(i.name).trim(),
      description: i.description ?? null,
      icon: i.icon ?? null,
      openMethod: i.openMethod || 'new_tab',
      bgColor: i.bgColor ?? null,
      bgOpacity: parseOpacity(i.bgOpacity),
      isMonitored: !!i.isMonitored,
      pingUrl: i.pingUrl ?? null,
      isHidden: !!i.isHidden,
      isPinned: !!i.isPinned,
      widgetType: normalizeWidgetType(i.widgetType),
      widgetConfig: normalizeWidgetConfig(i.widgetConfig),
      memo: i.memo,
      group: i.group || '书签',
      gridX: Number(i.gridX) || null,
      gridY: Number(i.gridY) || null,
      urls: cleanUrls,
    });
    imported += 1;
  }
  // 【修复 BUG-5】导入是"本地批量写"，必须补同步痕迹，否则其他节点永远看不到
  if (imported > 0) {
    const all = await itemStore.listAll({ locked: vault.isLocked() });
    for (const it of all) {
      await recordChangeForItem(it.uid, 'upsert');
    }
  }

  {
    // 分组：merge=并集，replace=直接采用导入值（至少保留一个）
    const updateData = {};
    if (Array.isArray(data.groups) && data.groups.length) {
      const incoming = [...new Set(data.groups.map((g) => String(g).trim()).filter(Boolean))];
      if (mode === 'replace') {
        updateData.groups = JSON.stringify(incoming);
      } else {
        // 【修复 BUG-6】重构残留：这里早已不在事务里，tx 不存在导致 500
        const c = await prisma.appConfig.findUnique({ where: { id: 1 } });
        const current = c?.groups ? JSON.parse(c.groups) : [];
        updateData.groups = JSON.stringify([...new Set([...current, ...incoming])]);
      }
    }
    // 主题：仅 replace 模式覆盖（merge 模式不动当前外观）
    if (mode === 'replace' && data.theme && typeof data.theme === 'object') {
      const t = data.theme;
      for (const k of ['themeBg', 'themeColor', 'siteIcon', 'bgImage', 'siteTitle', 'footerText', 'cardBgColor']) {
        if (t[k] !== undefined) updateData[k] = t[k];
      }
      if (t.cardBgOpacity !== undefined) updateData.cardBgOpacity = parseOpacity(t.cardBgOpacity);
    }
    if (Object.keys(updateData).length) {
      await prisma.appConfig.update({ where: { id: 1 }, data: updateData });
    }
  }

  // 导入后 HLC 跳到最后，避免被旧数据回冲
  await nodeState.set('hlc', hlcClock.next(nodeIdentity.self().nodeId));
  scheduleBackup();
  const total = await itemStore.count();
  res.json({ success: true, total, imported, mode });
}));

// ====== 🎨 静态资源与前端兜底路由 ======
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath, {
  setHeaders: (res, filePath) => {
    // sw.js / index.html 不能被长缓存，否则更新永远不生效
    if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

app.get(/^\/(?!api).*/, (req, res) => {
  const indexFile = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(503).send('前端资源尚未构建，请执行 npm run build');
});

// ====== 🚨 统一错误中间件（必须放在所有路由之后） ======
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`❌ [API 异常] ${req.method} ${req.originalUrl} -> ${status}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

// ====== 🚀 启动与优雅退出 ======
let server;
initSystem()
  .then(() => migrateMemosToEncrypted())
.then(async () => {
  const result = await itemStore.migrateLegacy();
  if (result.migrated) console.log(`🔐 整行加密迁移完成：${result.migrated} 张卡片`);
})
  .then(() => archiveLegacyBackups())
  .then(() => {
    server = app.listen(PORT, () => {
      console.log(`🚀 后端已启动：http://localhost:${PORT}（时区 ${TZ}）`);
      // 启动自检：路由是否真的注册上了（排查"接口 404 但代码明明写了"）
      try {
        const registered = (app.router?.stack || app._router?.stack || [])
          .filter((layer) => layer.route)
          .map((layer) => Object.keys(layer.route.methods).join(',').toUpperCase() + ' ' + layer.route.path);
        const joins = registered.filter((p) => p.includes('join'));
        console.log(`🧭 已注册路由 ${registered.length} 条，其中 join 相关: ${joins.join(' | ') || '(无)'}`);
        const joinLayers = (app.router?.stack || app._router?.stack || [])
          .filter((layer) => layer.route && String(layer.route.path).includes('join'))
          .map((layer) => JSON.stringify(layer.route.path) + ' len=' + String(layer.route.path).length + ' stack=' + layer.route.stack.length);
        console.log('🧭 join 层数: ' + joinLayers.join(' | '));
      } catch (e) {
        console.log('🧭 路由自检失败:', e.message);
      }
    });
    syncEngine.start();
  // 【P2】每小时清理一次 7 天前的敏感配置 payload
  setInterval(() => { pruneSensitivePayloads().catch(() => {}); }, 3600 * 1000).unref?.();
  })
  .catch((e) => {
    console.error('❌ 启动失败，进程退出：', e.message);
    process.exit(1);
  });

const shutdown = async (signal) => {
  console.log(`\n收到 ${signal}，正在优雅退出...`);
  try { pingMonitor.stop(); } catch {}
  try { syncEngine.stop(); } catch {}
  if (server) await new Promise((r) => server.close(r));
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('⚠️ 未处理的 Promise 拒绝:', reason));
