/**
 * 节点同步引擎（v3.0.0 阶段 3）
 * ------------------------------------------------------------------
 * 设计要点：
 *  - 拉为主（pull）：每 15 秒向每个 peer 问"我缺哪段"，对方按 seq 增量吐
 *  - 推为辅（push）：本地有新变更就顺手推给对方，失败无所谓（pull 会补上）
 *  - 幂等：changeId = nodeId:seq 全局唯一，已应用的直接跳过
 *  - 冲突：HLC 比较（LWW），输掉的一版进 ItemRevision 留档
 *  - 端到端签名：中继无法伪造来源；签名覆盖 changeId/entity/uid/op/hlc/payload 摘要
 *  - 不依赖 vault：payload 本来就是密文，锁定态也能同步（只是界面看不到内容）
 */
const crypto = require('crypto');
const nodeIdentity = require('./identity');
const hlcClock = require('./hlc');
const nodeState = require('./nodeState');

let prismaRef = null;
/** 宿主可以注册回调：配置类变更应用后通知它（例如吊销 JWT） */
let onConfigApplied = null;
let onItemsApplied = null;
function setOnConfigApplied(fn) { onConfigApplied = fn; }
let itemStoreRef = null;
let running = false;
let timer = null;
const peerState = new Map(); // nodeId -> { failures, nextAt, lastError }

const PEER_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 15000);
const MAX_BACKOFF_MS = 5 * 60 * 1000;
// 【v3.29.0】8 秒太短：CF 代理的节点经常 10~15 秒才响应，会误判离线。提到 20 秒。
const TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 20000);

/** 【P1-11】宿主回调：远端卡片变更应用后重建明文快照 */
function setOnItemsApplied(fn) {
  onItemsApplied = typeof fn === 'function' ? fn : null;
}

function init(prisma, itemStore) {
  prismaRef = prisma;
  itemStoreRef = itemStore;
}

/**
 * 历史纠正：老版本把"拉取进度"写进了 lastSeq（推送进度），会把推送水位顶到本地根本没有的位置，
 * 结果永远推不出去。启动时把 lastSeq 夹到本地真实的最大 seq。
 */
async function clampPushedCursors() {
  try {
    const self = selfNodeId();
    const row = await db().changeLog.findFirst({ where: { nodeId: self }, orderBy: { seq: 'desc' } });
    const maxSeq = row ? row.seq : 0;
    const fixed = await db().peerAck.updateMany({
      where: { lastSeq: { gt: maxSeq } },
      data: { lastSeq: maxSeq },
    });
    if (fixed.count) console.log(`🔧 已纠正 ${fixed.count} 个对端的推送水位（上限 ${maxSeq}）`);
  } catch (e) {
    console.warn('⚠️ 纠正推送水位失败:', e.message);
  }
}

const db = () => {
  if (!prismaRef) throw new Error('syncEngine 未初始化');
  return prismaRef;
};

const selfNodeId = () => nodeIdentity.self().nodeId;
const payloadDigest = (payload) => crypto.createHash('sha256').update(String(payload || '')).digest('hex');

/**
 * 请求级签名：只覆盖 ts + 方法 + 路径。
 * 为什么不签 body：express 解析后重新序列化的字节顺序可能与客户端不同，摘要必然不匹配；
 * body 里的每条 change 自带源节点签名（verifyChange），被改一条就整条丢弃，安全性不受影响。
 */
function signRequest({ ts, method, path }) {
  return nodeIdentity.sign([ts, method, path].join('\n'));
}

function signChange(change) {
  const base = [change.changeId, change.entity, change.uid, change.op, change.hlc, payloadDigest(change.payload)].join('|');
  return nodeIdentity.sign(base);
}

function verifyChange(change, publicKeyPem) {
  const base = [change.changeId, change.entity, change.uid, change.op, change.hlc, payloadDigest(change.payload)].join('|');
  return nodeIdentity.verify(base, change.sig, publicKeyPem);
}

/**
 * 两个方向必须分开记：
 *  - pulledSeq：我已从该 peer 收到并应用到第几条（拉取进度）
 *  - lastSeq  ：我已推给该 peer 到第几条（我的本地 seq，推送进度）
 * 用同一个字段会互相污染：拉一次就把"推送进度"顶到头，导致漏推。
 */
async function getCursor(peerId) {
  const row = await db().peerAck.findUnique({ where: { peerId } });
  return row ? row.pulledSeq : 0;
}

async function setCursor(peerId, seq) {
  await db().peerAck.upsert({
    where: { peerId },
    create: { peerId, pulledSeq: seq },
    update: { pulledSeq: seq },
  });
}

async function getPushed(peerId) {
  const row = await db().peerAck.findUnique({ where: { peerId } });
  return row ? row.lastSeq : 0;
}

/**
 * 应用一条远端变更（幂等 + LWW）
 * 返回 { applied, reason }
 */
/** 【P1-11】卡片变更应用后通知宿主：重建明文快照 / 刷新 UI 缓存 */
function notifyItemsApplied() {
  if (typeof onItemsApplied === 'function') {
    try { onItemsApplied(); } catch { /* 忽略 */ }
  }
}

/** 【E-02】seq 上限：超过 JS 安全整数会导致精度丢失、幂等失效 */
const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;

async function applyChange(change) {
  if (change && Number(change.seq) > MAX_SAFE_SEQ) return { applied: false, reason: 'seq-out-of-range' };
  if (!change || !change.changeId) return { applied: false, reason: 'malformed' };

  const seen = await db().appliedChange.findUnique({ where: { changeId: change.changeId } });
  if (seen) return { applied: false, reason: 'duplicate' };

  // 源节点公钥：优先用成员表，其次用变更里带的 pk（TOFU 自举，便于"我连不到 C，但 B 转发了 C 的变更"）
  // 【修复 P1-1】不再 TOFU 自动入表：否则任何能把请求打到成员的自签节点都能入网。
  // 成员来源只有两条：①加入流程的 snapshot ②成员自己的 member 变更（会随同步传播）。
  // 代价：如果成员表变更还没到，这条数据会延后一个同步周期再被接受（不会丢）。
  let origin = await db().member.findUnique({ where: { nodeId: String(change.nodeId || '') } });
  if (!origin) {
    // 【自检修复 BUG-B】禁止 TOFU 后，中继的成员表传播会断链：
    // B 收到 C 的 member 变更时本地没有 C → 连这条"上户口"也要被拒 → C 永远进不来。
    // 唯一允许的自举：entity=member 且 uid===nodeId（只能给自己上户口）且自带公钥。
    if (change.entity === 'member' && String(change.uid) === String(change.nodeId) && change.pk) {
      origin = await db().member.create({
        data: { nodeId: String(change.nodeId), publicKey: change.pk, selfUrls: '', role: 'peer', status: 'active', lastSeen: new Date() },
      }).catch(() => null);
      if (!origin) origin = await db().member.findUnique({ where: { nodeId: String(change.nodeId) } });
      if (origin) console.warn('[sync] 接受新成员自述身份: ' + String(change.nodeId).slice(0, 6) + '（仅限本人自述）');
    }
  }
  if (!origin) {
    console.warn('[sync] 未知来源变更: ' + change.nodeId + '，等成员表同步到达后重试');
    return { applied: false, reason: 'unknown-origin' };
  }
  if (origin.status === 'revoked') return { applied: false, reason: 'revoked-origin' };
  if (!verifyChange(change, origin.publicKey)) return { applied: false, reason: 'bad-signature' };

  // 【修复】时钟跑到未来的节点会永久压制全网：超前 60 秒以上直接拒收
  if (hlcClock.isTooFarAhead(change.hlc, 60000)) {
    console.warn('[sync] 拒收时钟超前的变更 ' + change.changeId + '（' + change.hlc + '），请校准该节点 NTP');
    return { applied: false, reason: 'clock-ahead' };
  }

  // 收到远端时间戳：抬升本地 HLC
  hlcClock.receive(change.hlc, selfNodeId());
  await nodeState.set('hlc', hlcClock.encode(selfNodeId()));

  let result = { applied: false, reason: 'ignored' };
  if (change.entity === 'item') {
    if (change.op === 'delete') {
      const existing = await db().item.findFirst({ where: { uid: change.uid } });
      if (existing) {
        const newer = hlcClock.compare(change.hlc, existing.hlc) > 0;
        if (newer) {
          await db().item.update({
            where: { id: existing.id },
            data: { deletedAt: new Date(), hlc: change.hlc, nodeId: change.nodeId, dirty: false },
          });
          result = { applied: true, reason: 'tombstoned' };
          notifyItemsApplied();
        } else {
          result = { applied: false, reason: 'older' };
        }
      } else {
        // 没见过这张卡：直接建墓碑，避免"删除被旧数据复活"
        await db().item.create({
          data: {
            uid: change.uid, payload: '', hlc: change.hlc, nodeId: change.nodeId,
            deletedAt: new Date(), dirty: false, name: '', group: '',
          },
        });
        result = { applied: true, reason: 'tombstone-created' };
        notifyItemsApplied();
      }
    } else {
      result = await itemStoreRef.upsertFromSync({
        uid: change.uid,
        payload: change.payload,
        hlc: change.hlc,
        nodeId: change.nodeId,
        deletedAt: null,
      });
      if (result.applied) notifyItemsApplied();
      if (!result.applied && result.reason === 'older') {
        await db().itemRevision.create({
          data: { uid: change.uid, payload: change.payload || '', hlc: change.hlc, nodeId: change.nodeId, reason: 'conflict' },
        });
      }
    }
  } else if (change.entity === 'admin') {
    // 【Q2 方案 A】踢人：任何活跃成员都能签发（因为每台都是管理员），但不能踢自己
    if (change.op === 'revoke') {
      const target = String(change.uid || '');
      if (!target) {
        result = { applied: false, reason: 'bad-revoke' };
      } else if (target === String(change.nodeId)) {
        result = { applied: false, reason: 'revoke-self-denied' };
      } else {
        const victim = await db().member.findUnique({ where: { nodeId: target } });
        if (!victim) {
          result = { applied: false, reason: 'no-such-member' };
        } else if (victim.status === 'revoked') {
          result = { applied: true, reason: 'already-revoked' };
        } else {
          await db().member.update({ where: { nodeId: target }, data: { status: 'revoked' } });
          console.warn('[sync] 成员已被踢出: ' + target + '（由 ' + change.nodeId + ' 发起）');
          result = { applied: true, reason: 'revoked' };
        }
      }
    } else {
      result = { applied: false, reason: 'unknown-admin-op' };
    }
  } else if (change.entity === 'config') {
    // 【Q1 方案 B】改密码同步：只接受"能解出同一主密钥"的包裹，防止被改到解不开
    if (change.op === 'password-change') {
      try {
        const info = JSON.parse(change.payload || ' {}');
        const localFP = require('./vault').fingerprint();
        if (!info.passwordHash || !info.vaultSalt || !info.vaultWrapped) {
          result = { applied: false, reason: 'bad-password-change' };
        } else if (!localFP) {
          // 【P0】本地锁定态：无法验证"新包裹能否解出同一主密钥"，所以**不应用**到本地，
          // 但必须**转发入库**，否则其他节点从中转不到这条变更（中继断链）。
          // 不写 AppliedChange -> 下次同步会再收到 -> 解锁后自然重放并应用。
          result = { applied: false, reason: 'vault-locked', forwardAnyway: true };
        } else {
          // 用新的包裹 + 新密码解一遍？我们拿不到明文密码，只能验证"包裹能解出当���主密钥"
          // 方法：拿本地主密钥做指纹，与对方声称的指纹比（对方在 payload 里带 fingerprint）
          const remoteFP = String(info.fingerprint || '');
          if (remoteFP && remoteFP !== localFP) {
            console.warn('[sync] 拒绝改密码：主密钥指纹不一致（这是换了主密钥，不是改密码）');
            result = { applied: false, reason: 'vault-fingerprint-mismatch' };
          } else {
            await db().appConfig.update({
              where: { id: 1 },
              data: {
                // 【自检修复 BUG-D】用户名也要跟随，否则改了账号名不同步
                ...(info.username ? { username: String(info.username) } : {}),
                password: info.passwordHash,
                vaultSalt: info.vaultSalt,
                vaultWrapped: info.vaultWrapped,
              },
            });
            // 通知宿主吊销本机已颁发的 JWT（密码变了，旧会话应失效）
            if (typeof onConfigApplied === 'function') {
              try { onConfigApplied('password-change'); } catch { /* 忽略 */ }
            }
            console.log('[sync] 已跟随对端更新管理员密码与密钥包裹');
            result = { applied: true, reason: 'password-synced' };
          }
        }
      } catch {
        result = { applied: false, reason: 'bad-config' };
      }
    } else if (change.op === 'two-factor') {
      // 【v3.8.0】2FA 全网通用：状态和种子一起跟随
      try {
        const info = JSON.parse(change.payload || ' {}');
        await db().appConfig.update({
          where: { id: 1 },
          data: {
            twoFactorEnabled: !!info.enabled,
            twoFactorSecret: info.enabled ? (info.secret || null) : null,
          },
        });
        if (typeof onConfigApplied === 'function') {
          try { onConfigApplied('two-factor'); } catch { /* 忽略 */ }
        }
        console.log('[sync] 已跟随对端更新 2FA：' + (info.enabled ? '开启' : '关闭'));
        result = { applied: true, reason: 'two-factor-synced' };
      } catch {
        result = { applied: false, reason: 'bad-two-factor' };
      }
    } else if (change.op === 'config-sync') {
      // 【v3.10.2】通用配置同步：groups / theme / uiPrefs / webdav / notify / appToken
      try {
        const info = JSON.parse(change.payload || ' {}');
        const kind = String(info.kind || '');
        const data = info.data || {};
        const nowIso = new Date().toISOString();
        if (kind === 'groups') {
          // 【v3.30.0 关键修复】以前取"并集"，只能加不能减：
          //   改分组名 → 旧名+新名都在（看起来像没同步）
          //   删分组   → 删不掉，又回来了
          // 现在改成"整体覆盖"（LWW），但要防止并发丢分组：
          //   发送端在 payload 里带 updatedAt，接收端只接受更新的。
          // data 可能是数组（旧节点）或 { groups: [...], updatedAt } （v3.30.0+）
          const rawList = Array.isArray(data) ? data : (Array.isArray(data.groups) ? data.groups : []);
          const updatedAt = Array.isArray(data) ? 0 : Number(data.updatedAt || 0) || 0;
          const incoming = rawList.map((g) => String(g).trim()).filter(Boolean);
          if (!incoming.length) {
            result = { applied: false, reason: 'empty-groups' };
          } else {
            const cur = await db().appConfig.findUnique({ where: { id: 1 } });
            let local = [];
            try { local = JSON.parse(cur?.groups || '[]'); } catch { local = []; }
            let curAt = 0;
            try {
              const rows = await db().$queryRawUnsafe("SELECT value FROM NodeState WHERE key = 'groupsUpdatedAt'");
              curAt = Number((rows && rows[0] && rows[0].value) || 0) || 0;
            } catch { curAt = 0; }
            const incAt = Number(updatedAt || 0) || 0;
            // 没有时间戳时按"后到为准"（兼容旧节点）
            const shouldApply = incAt === 0 || incAt >= curAt;
            if (shouldApply && JSON.stringify(incoming) !== JSON.stringify(local)) {
              await db().appConfig.update({ where: { id: 1 }, data: { groups: JSON.stringify(incoming) } });
              if (incAt) {
                await db().$executeRawUnsafe(
                  "INSERT INTO NodeState (key, value) VALUES ('groupsUpdatedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                  String(incAt)
                ).catch(() => {});
              }
            }
          }
        } else if (kind === 'theme') {
        } else if (kind === 'theme') {
          // 【修复】themeAccent 是后加列，Prisma client 未重新生成时会报 Unknown argument，
          // 必须像 index.js 一样用 raw SQL 单独写；其余字段走 Prisma。
          // bgImage 不同步（体积大，各节点各自设）
          const patch = {};
          // 【v3.27.0】原来漏了 cardBgColor / cardBgOpacity —— 后端广播了但这里不处理，
          // 导致"统一卡片样式预设"改了不跟着同步。
          for (const k of ['themeBg', 'themeColor', 'siteIcon', 'siteTitle', 'footerText', 'cardBgColor']) {
            if (data[k] !== undefined) patch[k] = data[k];
          }
          if (data.cardBgOpacity !== undefined) {
            const n = Number(data.cardBgOpacity);
            if (Number.isFinite(n)) patch.cardBgOpacity = Math.min(1, Math.max(0, n));
          }
          if (Object.keys(patch).length) {
            await db().appConfig.update({ where: { id: 1 }, data: patch });
          }
          if (data.themeAccent !== undefined) {
            await db().$executeRawUnsafe(
              'UPDATE AppConfig SET themeAccent = ? WHERE id = 1',
              String(data.themeAccent || '')
            ).catch(() => {});
          }
        } else if (kind === 'uiPrefs') {
          // 【v3.30.0】改成"合并"而不是"覆盖"：
          //   A 节点改 gridCols、B 节点改 searchEngine
          //   全量覆盖会让后到的把先到的键冲掉
          try {
            const cur = await db().appConfig.findUnique({ where: { id: 1 } });
            let local = {};
            try { local = JSON.parse(cur?.uiPrefs || '{}') || {}; } catch { local = {}; }
            const merged = { ...local, ...(data || {}) };
            await db().$executeRawUnsafe(
              'UPDATE AppConfig SET uiPrefs = ? WHERE id = 1',
              JSON.stringify(merged).slice(0, 4000)
            );
          } catch { /* 列可能不存在 */ }
        } else if (kind === 'webdav') {
          await db().appConfig.update({
            where: { id: 1 },
            data: {
              webdavUrl: data.url || '', webdavUser: data.user || '', webdavPass: data.pass || '',
            },
          });
          // 配置变了要立刻把本机数据补传上去（增量：RemoteBlob 已同步，重复的会跳过）
          try {
            const blobStore = require('./blobStore');
            if (typeof blobStore.scheduleSync === 'function') blobStore.scheduleSync(800);
          } catch { /* 忽略 */ }
        } else if (kind === 'notify') {
          await db().appConfig.update({
            where: { id: 1 },
            data: {
              wechatCorpId: data.wechatCorpId || '', wechatCorpSecret: data.wechatCorpSecret || '',
              wechatAgentId: data.wechatAgentId || '', wechatTouser: data.wechatTouser || '@all',
            },
          });
        } else if (kind === 'appToken') {
          if (data.action === 'delete') {
            await db().$executeRawUnsafe('DELETE FROM AppToken WHERE token = ?', String(data.token || '')).catch(() => {});
          } else if (data.token) {
            await db().$executeRawUnsafe(
              'INSERT OR REPLACE INTO AppToken (token, label, createdAt) VALUES (?, ?, ?)',
              String(data.token), String(data.label || ''), nowIso
            ).catch(() => {});
          }
        } else {
          result = { applied: false, reason: 'unknown-config-kind' };
        }
        if (!result) {
          if (typeof onConfigApplied === 'function') {
            try { onConfigApplied('config-sync:' + kind); } catch { /* 忽略 */ }
          }
          console.log('[sync] 已跟随对端更新配置：' + kind);
          result = { applied: true, reason: 'config-synced:' + kind };
        }
      } catch (e) {
        result = { applied: false, reason: 'bad-config-sync' };
      }
    } else if (change.op === 'passkey-upsert' || change.op === 'passkey-delete') {
      // 【v3.9.5】Passkey 同步：让每条凭据在所有节点都可识别
      try {
        // 【v3.28.0】接收端可能还没有 Passkey 表（新节点从未打开过通行密钥页），
        // 不先建表的话 INSERT 会静默失败 → 表现为"一个节点有、另一个没有"。
        await db().$executeRawUnsafe(
          'CREATE TABLE IF NOT EXISTS Passkey ('
          + 'id INTEGER PRIMARY KEY AUTOINCREMENT,'
          + 'credentialId TEXT NOT NULL UNIQUE,'
          + 'publicKey TEXT NOT NULL,'
          + 'counter INTEGER NOT NULL DEFAULT 0,'
          + 'label TEXT DEFAULT \'\','
          + 'createdAt TEXT NOT NULL DEFAULT (datetime(\'now\')),'
          + 'prfWrapped TEXT)'
        ).catch(() => {});
        const info = JSON.parse(change.payload || ' {}');
        const id = String(info.credentialId || change.uid || '');
        if (!id) {
          result = { applied: false, reason: 'bad-passkey' };
        } else if (change.op === 'passkey-delete') {
          await db().$executeRawUnsafe('DELETE FROM Passkey WHERE credentialId = ?', id).catch(() => {});
          result = { applied: true, reason: 'passkey-deleted' };
        } else {
          // 【v3.28.0】prfWrapped 不跨设备同步：
          // PRF 派生依赖认证器内部密钥，另一台的指纹派生结果不同，同步过来也解不开；
          // 若直接覆盖还会把本机原本能用的包裹冲掉。
          // 这里只更新凭据本体（让登录验签可用），prfWrapped 保留本地已有值。
          await db().$executeRawUnsafe(
            'INSERT INTO Passkey (credentialId, publicKey, counter, label, prfWrapped) VALUES (?, ?, ?, ?, NULL) '
            + 'ON CONFLICT(credentialId) DO UPDATE SET publicKey = excluded.publicKey, counter = excluded.counter, label = excluded.label',
            id, String(info.publicKey || ''), Number(info.counter) || 0,
            String(info.label || '我的通行密钥').slice(0, 40)
          ).catch(() => {});
          result = { applied: true, reason: 'passkey-upserted' };
        }
      } catch {
        result = { applied: false, reason: 'bad-passkey' };
      }
    } else {
      result = { applied: false, reason: 'unknown-config-op' };
    }
  } else if (change.entity === 'member') {
    try {
      const info = JSON.parse(change.payload || '{}');
      const target = String(info.nodeId || change.uid || '');
      if (!target || !info.publicKey) {
        result = { applied: false, reason: 'bad-member' };
      } else if (target !== String(change.nodeId)) {
        // 【修复 BUG-1】只允许节点"改自己"：A 不能替 B 改身份
        result = { applied: false, reason: 'member-forbidden' };
      } else {
        const before = await db().member.findUnique({ where: { nodeId: target } });
        if (before && before.publicKey && before.publicKey !== info.publicKey) {
          // 【修复 BUG-1】已有公钥绝不允许被替换，否则任何成员都能冒充别人
          console.warn('[sync] 拒绝替换已有成员公钥: ' + target);
          result = { applied: false, reason: 'pubkey-replace-rejected' };
        } else {
          // 空地址不覆盖：旧变更里往往没有 selfUrls，别把已经学到的地址清掉
          // 【修复 N7】地址会被所有节点定时 fetch，入库前必须校验，否则等于借全网之手 SSRF
          const { cleanPeerUrls } = require('./peerUrls');
          const cleaned = cleanPeerUrls(info.selfUrls);
          // 空值不覆盖（旧变更没带地址），但"旧值本身不合法"时必须清掉，否则污染会永久留存
          const beforeUrls = before ? cleanPeerUrls(before.selfUrls) : '';
          const urls = cleaned || beforeUrls;
          await db().member.upsert({
            where: { nodeId: target },
            create: {
              nodeId: target, publicKey: info.publicKey,
              selfUrls: urls, status: info.status || 'active', lastSeen: new Date(),
            },
            update: {
              selfUrls: urls, status: info.status || 'active', lastSeen: new Date(),
            },
          });
          // 【修复】设备名同步：name 是后加列，client 未生成时用 raw 写
          if (info.name !== undefined) {
            await db().$executeRawUnsafe(
              'UPDATE Member SET name = ? WHERE nodeId = ?',
              String(info.name || '').slice(0, 40), target
            ).catch(() => {});
          }
          result = { applied: true, reason: 'member-upserted' };
        }
      }
    } catch {
      result = { applied: false, reason: 'bad-member' };
    }
  }

  // 【修复】只有真正被接受的变更才记录并转发；被拒的（越权改别人身份、公钥替换、签名不符等）
  // 绝不能再扩散出去，否则一次伪造尝试会被中继放大到全网。
  // 例外：forwardAnyway（如"锁定态收到改密码"）——本地不应用但必须转发，否则中继断链。
  if (!result.applied && !result.forwardAnyway) return result;

  if (result.applied) {
    await db().appliedChange.create({ data: { changeId: change.changeId } }).catch(() => {});
  }

  // 关键：把这条变更留一份在本地 ChangeLog（保留原 changeId / 源签名 / 公钥），
  // 这样连不上原节点的第三方也能从我这补到这条变更（逐跳中继）。
  const [srcNode, seqText] = String(change.changeId).split(':');
  const seqNum = Number(seqText);
  if (srcNode && Number.isFinite(seqNum)) {
    await db().changeLog.upsert({
      where: { nodeId_seq: { nodeId: srcNode, seq: seqNum } },
      create: {
        nodeId: srcNode, seq: seqNum, changeId: change.changeId,
        entity: change.entity, uid: change.uid, op: change.op,
        hlc: change.hlc, payload: change.payload || null,
        sig: change.sig || null, pk: change.pk || null,
      },
      update: {},
    }).catch(() => {});
  }

  return result;
}

/** 本地 StateVector：每个源节点我手上有到第几条 */
async function localVector() {
  const rows = await db().changeLog.groupBy({ by: ['nodeId'], _max: { seq: true } });
  const vector = {};
  for (const row of rows) vector[row.nodeId] = row._max.seq || 0;
  return vector;
}

/** 取本地待推送的变更（seq > 对方已确认水位） */
async function pendingFor(peerId, limit = 200) {
  const since = await getPushed(peerId);
  return db().changeLog.findMany({
    where: { nodeId: selfNodeId(), seq: { gt: since } },
    orderBy: { seq: 'asc' },
    take: limit,
  });
}

async function markPushedTo(peerId, seq) {
  if (!seq) return;
  await db().peerAck.upsert({
    where: { peerId },
    create: { peerId, lastSeq: seq },
    update: { lastSeq: seq },
  });
}

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
};

/** 带签名的请求（节点间调用） */
async function signedFetch(url, method, path, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = String(Date.now());
  const sig = signRequest({ ts, method, path });
  return fetchWithTimeout(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-op-node': selfNodeId(),
      'x-op-ts': ts,
      'x-op-sign': sig,
    },
    body: body || undefined,
  });
}

/** 解析 Member.selfUrls 的候选地址，逐个尝试 */
async function tryUrls(member, fn) {
  const urls = String(member.selfUrls || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  let lastError = null;
  for (const base of urls) {
    try {
      const result = await fn(base.replace(/\/$/, ''));
      return { ok: true, base, result };
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, error: lastError ? lastError.message : 'no-url' };
}

/** 把本地还没推给该 peer 的变更送过去 */
async function pushToPeer(member, peerId) {
  let pushed = 0;
  let failed = 0;
  for (let round = 0; round < 5; round += 1) {
    const mine = await pendingFor(peerId, 200);
    if (!mine.length) break;
    const batch = mine.map((c) => ({
      changeId: c.changeId, entity: c.entity, uid: c.uid, op: c.op,
      hlc: c.hlc, payload: c.payload, sig: c.sig, nodeId: c.nodeId, pk: c.pk,
    }));
    const res = await tryUrls(member, (base) =>
      signedFetch(base + '/api/sync/changes', 'POST', '/api/sync/changes', { changes: batch })
    );
    if (!res.ok) { failed += batch.length; break; }
    // 【修复】对方即使 HTTP 200，也可能全部 rejected（例如成员表被污染后一直拒收）。
    // 只有"确实被接受/判重复"才推进水位，否则日后对方永久缺这批数据。
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const rejected = body && Number(body.rejected) > 0;
    if (rejected) {
      console.warn('[sync] 推送被拒 ' + (body && body.rejected) + ' 条（不推进水位，下次重试）');
      break;
    }
    await markPushedTo(peerId, mine[mine.length - 1].seq);
    pushed += batch.length;
    if (batch.length < 200) break;
  }
  return { pushed, failed };
}

/** 对一个 peer 做一次补差：先把自己的增量推过去，再拉自己缺的 */
async function syncWithPeer(member) {
  const peerId = member.nodeId;
  const state = peerState.get(peerId) || { failures: 0, nextAt: 0, lastError: '' };
  if (Date.now() < state.nextAt) return { skipped: true };

  try {
    // 1) push：只出站的节点靠这一步把自己的改动送进网络
    const push = await pushToPeer(member, peerId);

    // 2) pull：StateVector 补差，拿自己缺的（含别人转发过来的）
    let totalPulled = 0;
    let totalApplied = 0;
    for (let round = 0; round < 5; round += 1) {
      const vector = await localVector();
      const encoded = encodeURIComponent(JSON.stringify(vector));
      const pull = await tryUrls(member, async (base) => {
        const res = await signedFetch(
          base + '/api/sync/changes?vector=' + encoded,
          'GET', '/api/sync/changes', undefined
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
      if (!pull.ok) throw new Error('pull 失败: ' + pull.error);

      const incoming = (pull.result && pull.result.changes) || [];
      totalPulled += incoming.length;
      for (const change of incoming) {
        const r = await applyChange(change);
        if (r.applied) totalApplied += 1;
      }
      if (!pull.result.hasMore || incoming.length === 0) break;
    }

    await db().member.update({
      where: { nodeId: peerId },
      data: { lastSyncAt: new Date(), lastSeen: new Date(), status: 'active' },
    }).catch(() => {});

    peerState.set(peerId, { failures: 0, nextAt: 0, lastError: '' });
    return { ok: true, pushed: push.pushed, pulled: totalPulled, applied: totalApplied };
  } catch (e) {
    state.failures += 1;
    state.lastError = e.message;
    const backoff = Math.min(MAX_BACKOFF_MS, PEER_INTERVAL_MS * Math.pow(2, Math.min(state.failures, 6)));
    state.nextAt = Date.now() + backoff;
    peerState.set(peerId, state);
    return { ok: false, error: e.message, failures: state.failures, nextInMs: backoff };
  }
}

/** 一轮同步：遍历所有 active 成员 */
async function syncOnce() {
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const self = selfNodeId();
    const members = await db().member.findMany({ where: { status: 'active' } });
    const peers = members.filter((m) => m.nodeId !== self && m.selfUrls);
    const results = [];
    for (const peer of peers) {
      results.push({ peer: peer.nodeId, ...(await syncWithPeer(peer)) });
    }
    return { peers: peers.length, results };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  clampPushedCursors().catch(() => {});
  timer = setInterval(() => {
    syncOnce().catch((e) => console.warn('⚠️ 同步轮次异常:', e.message));
  }, PEER_INTERVAL_MS);
  console.log(`🔗 同步引擎已启动（间隔 ${PEER_INTERVAL_MS / 1000}s）`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const getPeerState = () => Object.fromEntries(peerState);

module.exports = {init, start, stop, syncOnce, syncWithPeer, clampPushedCursors, localVector, setOnConfigApplied,
  applyChange, verifyChange, signChange, signRequest, payloadDigest,
  getCursor, setCursor, pendingFor, markPushedTo,
  getPeerState, selfNodeId, TIMEOUT_MS, setOnItemsApplied };
