/**
 * 卡片存取层（v3.0.0）
 * ------------------------------------------------------------------
 * 所有对 Item 的读写都走这里：
 *  - 写入：业务字段 → JSON → AES-256-GCM → payload；明文列只写同步元数据
 *  - 读取：解密 payload → 还原成前端熟悉的对象形状
 *  - 删除：软删（墓碑），供同步传播
 */
const crypto = require('crypto');
const cryptoBox = require('./cryptoBox');
const codec = require('./itemCodec');
const hlcClock = require('./hlc');
const identity = require('./identity');
const nodeState = require('./nodeState');
const vault = require('./vault');

let prismaRef = null;

function init(prisma) {
  prismaRef = prisma;
}

const db = () => {
  if (!prismaRef) throw new Error('itemStore 尚未初始化');
  return prismaRef;
};

/** UUIDv7：时间有序，跨节点不会撞 */
function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ts = Date.now();
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const selfNodeId = () => identity.self().nodeId;

/** 明文列全部清空：这里只写元数据，避免旧字段变成"明文后门" */
const LEGACY_BLANK = {
  name: '',
  description: null,
  icon: null,
  group: '',
  memo: null,
  pingUrl: null,
  widgetType: null,
  widgetConfig: null,
  bgColor: null,
  bgOpacity: null,
  gridX: null,
  gridY: null,
};

async function listAll({ locked = false, includeDeleted = false, strict = false } = {}) {
  const where = includeDeleted ? {} : { deletedAt: null };
  // 【v3.35.0】按 order 排序（流式布局：order 决定先后，不再依赖 gridX/gridY）
  // order 在加密 payload 里，所以必须解密后再排；id 兜底保证稳定
  const sorted = (list) => list.sort((a, b) => {
    const oa = Number(a.order ?? 0), ob = Number(b.order ?? 0);
    if (oa !== ob) return oa - ob;
    return (a.id || 0) - (b.id || 0);
  });
  const rows = await db().item.findMany({ where, orderBy: { id: 'asc' } });
  // 【修复 P1-2】一张卡损坏不该让整个列表/批量操作 500。
  // 默认降级成"损坏占位卡"（corrupted:true），需要严格模式（删除/转移等写操作）时显式传 strict。
  const out = rows.map((row) => {
    try {
      return codec.unpackRow(row, { locked });
    } catch (e) {
      if (strict) throw e;
      return {
        id: row.id, uid: row.uid, hlc: row.hlc, nodeId: row.nodeId,
        name: '⚠️ 数据损坏', description: '', icon: 'mdi:alert',
        urls: [], url: null, group: '书签', memo: null,
        corrupted: true,
        error: e.message,
      };
    }
  });
  return sorted(out);
}

async function listRaw({ includeDeleted = false } = {}) {
  const where = includeDeleted ? {} : { deletedAt: null };
  return db().item.findMany({ where, orderBy: { id: 'asc' } });
}

async function getById(id) {
  const row = await db().item.findUnique({ where: { id: Number(id) } });
  return row ? codec.unpackRow(row) : null;
}

async function getByUid(uid) {
  const row = await db().item.findFirst({ where: { uid } });
  return row ? codec.unpackRow(row) : null;
}

async function create(input = {}) {
  const uid = input.uid || uuidv7();
  const nodeId = selfNodeId();
  const hlc = hlcClock.next(nodeId);
  const payload = codec.pack(input);
  const row = await db().item.create({
    data: {
      uid,
      payload,
      hlc,
      nodeId,
      dirty: true,
      // 【修复 BUG-10】明文列一律写默认值：业务数据只在 payload（密文）里
      name: '', group: '',
      type: 'bookmark', openMethod: 'new_tab',
      isHidden: false, isPinned: false, isMonitored: false, order: 0,
      description: null, icon: null, bgColor: null, bgOpacity: null,
      gridX: null, gridY: null, memo: null, pingUrl: null,
      widgetType: null, widgetConfig: null,
    },
  });
  return codec.unpackRow(row);
}

async function replace(id, input = {}) {
  // 【修复 BUG-2】写之前确认现有 payload 能解开（密钥不对就别动这张卡）
  const existing = await db().item.findUnique({ where: { id: Number(id) } });
  if (existing && existing.payload) {
    try {
      cryptoBox.decryptString(existing.payload, 'item');
    } catch (e) {
      const err = new Error('这张卡的内容解不开（密钥不一致），已拒绝覆盖：' + e.message);
      err.status = 409;
      err.code = 'DECRYPT_FAILED';
      throw err;
    }
  }
  const nodeId = selfNodeId();
  const hlc = hlcClock.next(nodeId);
  const payload = codec.pack(input);
  const row = await db().item.update({
    where: { id: Number(id) },
    data: {
      payload,
      hlc,
      nodeId,
      dirty: true,
      // 【重要】写回即"复活"：replace 导入/恢复会先软删再写回，不清墓碑会导致卡片永远不可见
      deletedAt: null,
      name: '', group: '',
      type: 'bookmark', openMethod: 'new_tab',
      isHidden: false, isPinned: false, isMonitored: false, order: 0,
      description: null, icon: null, bgColor: null, bgOpacity: null,
      gridX: null, gridY: null, memo: null, pingUrl: null,
      widgetType: null, widgetConfig: null,
    },
  });
  return codec.unpackRow(row);
}

/** 只改几个字段（位置、样式、标记）：解密 → 合并 → 重新加密 */
async function patch(id, partial = {}) {
  const row = await db().item.findUnique({ where: { id: Number(id) } });
  if (!row) return null;
  // 【修复 BUG-2】解密失败绝不能当空对象继续重加密，否则会把整张卡静默清空并扩散到全网
  let body;
  try {
    const plain = cryptoBox.decryptString(row.payload, 'item');
    body = plain ? JSON.parse(plain) : {};
  } catch (e) {
    const err = new Error('卡片内容解密失败（密钥不一致或数据损坏），已中止写入：' + e.message);
    err.status = 409;
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
  const merged = { ...body, ...partial };
  if (partial.urls) merged.urls = partial.urls;
  if (partial.memo !== undefined) {
    merged.memo = typeof partial.memo === 'object' && partial.memo !== null ? JSON.stringify(partial.memo) : partial.memo;
  }
  const nodeId = selfNodeId();
  const hlc = hlcClock.next(nodeId);
  const payload = codec.pack(merged);
  const next = await db().item.update({
    where: { id: Number(id) },
    data: {
      payload,
      hlc,
      nodeId,
      dirty: true,
      // 【修复 BUG-10】标记也不落明文列
    },
  });
  return codec.unpackRow(next);
}

async function softDelete(id) {
  const nodeId = selfNodeId();
  const hlc = hlcClock.next(nodeId);
  const row = await db().item.update({
    where: { id: Number(id) },
    data: { deletedAt: new Date(), hlc, nodeId, dirty: true },
  });
  return codec.unpackRow(row);
}

/** 同步落库：直接写 payload（密文直通，不解密） */
async function upsertFromSync({ uid, payload, hlc, nodeId, deletedAt }) {
  const existing = await db().item.findFirst({ where: { uid } });
  if (existing) {
    const newer = hlcClock.compare(hlc, existing.hlc) > 0;
    if (!newer) return { applied: false, reason: 'older' };
    await db().item.update({
      where: { id: existing.id },
      data: {
        payload,
        hlc,
        nodeId,
        deletedAt: deletedAt ? new Date(deletedAt) : null,
        dirty: false,
      },
    });
    return { applied: true, reason: 'updated' };
  }
  await db().item.create({
    data: {
      uid,
      payload: payload || '',
      hlc,
      nodeId,
      deletedAt: deletedAt ? new Date(deletedAt) : null,
      dirty: false,
      name: '',
      group: '',
    },
  });
  return { applied: true, reason: 'created' };
}

async function count() {
  return db().item.count({ where: { deletedAt: null } });
}

/**
 * 一次性迁移：明文列 + ItemUrl 表 → payload 密文，并清空明文列
 * 幂等：payload 为空的才处理
 */
async function migrateLegacy({ batchLog = null } = {}) {
  if (vault.isLocked()) return { migrated: 0, skipped: 'vault-locked' };
  const rows = await db().item.findMany({ include: { urls: true } });
  let migrated = 0;
  for (const row of rows) {
    if (row.payload && row.payload.startsWith('enc1:')) {
      // 已加密，但确保明文列已清空
      if (row.name || row.group || row.memo || row.pingUrl) {
        await db().item.update({ where: { id: row.id }, data: { ...LEGACY_BLANK, name: '' } });
      }
      continue;
    }
    const payload = codec.packFromLegacy(row, row.urls || []);
    await db().item.update({
      where: { id: row.id },
      data: {
        uid: row.uid || uuidv7(),
        payload,
        hlc: row.hlc || hlcClock.next(selfNodeId()),
        nodeId: row.nodeId || selfNodeId(),
        ...LEGACY_BLANK,
        name: '',
      },
    });
    migrated += 1;
    if (batchLog) batchLog(migrated);
  }
  if (migrated) {
    // URL 已进 payload，清空关系表避免明文重复
    await db().itemUrl.deleteMany({});
    console.log(`🔐 已把 ${migrated} 张卡片的明文内容加密进 payload`);
  }
  return { migrated };
}

module.exports = {
  init, listAll, listRaw, getById, getByUid,
  create, replace, patch, softDelete, upsertFromSync,
  count, migrateLegacy, uuidv7, LEGACY_BLANK,
};
