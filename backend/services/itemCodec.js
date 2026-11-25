/**
 * 卡片整行加密编解码（v3.0.0）
 * ------------------------------------------------------------------
 * 存储：Item.payload = AES-256-GCM(JSON 全部业务字段)
 * 明文列只保留同步元数据（uid / hlc / nodeId / deletedAt），不含任何隐私
 *
 * 对外：API 仍然返回老形状（name/description/urls/memo/...），前端零改动。
 */
const cryptoBox = require('./cryptoBox');

/** 进入 payload 的业务字段白名单 */
const FIELDS = [
  'type', 'name', 'description', 'icon', 'openMethod',
  'bgColor', 'bgOpacity', 'group', 'order', 'gridX', 'gridY',
  'cardW', 'cardH', // 卡片尺寸（1 或 2）：默认 1×1，小组件 1×2
  'memo', 'widgetType', 'widgetConfig',
  'isHidden', 'isPinned', 'isMonitored', 'pingUrl',
];

function normalizeUrls(urls) {
  if (!Array.isArray(urls)) return [];
  return urls
    .filter((u) => u && u.url && String(u.url).trim())
    .map((u, i) => ({
      id: u.id ?? i + 1,
      url: String(u.url).trim(),
      label: u.label || '主地址',
      priority: Number.isFinite(Number(u.priority)) ? Number(u.priority) : 0,
    }));
}

/** 从老形状对象抽出业务字段，加密成 payload 字符串 */
function pack(input = {}) {
  const body = {};
  for (const key of FIELDS) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  body.urls = normalizeUrls(input.urls);
  if (body.memo && typeof body.memo === 'object') body.memo = JSON.stringify(body.memo);
  return cryptoBox.encryptString(JSON.stringify(body), 'item');
}

/** 解密 payload，还原成前端熟悉的对象形状 */
function unpackRow(row, { locked = false } = {}) {
  const base = {
    id: row.id,
    uid: row.uid,
    hlc: row.hlc,
    nodeId: row.nodeId,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (locked) {
    return {
      ...base,
      type: 'bookmark',
      name: '🔒 已锁定',
      description: '保险库未解锁，解锁后可见',
      icon: 'mdi:lock-outline',
      openMethod: 'new_tab',
      bgColor: null,
      bgOpacity: null,
      group: '未解锁',
      order: 0,
      gridX: null,
      gridY: null,
      cardW: 1,
      cardH: 1,
      memo: null,
      widgetType: null,
      widgetConfig: null,
      isHidden: false,
      isPinned: false,
      isMonitored: false,
      pingUrl: null,
      urls: [],
      locked: true,
    };
  }
  let body = {};
  try {
    const plain = cryptoBox.decryptString(row.payload, 'item');
    body = plain ? JSON.parse(plain) : {};
  } catch (e) {
    // 【修复 N1】**绝不能**在这里把异常吞掉当成空卡片：
    // 空卡片会带着默认 group="书签"，于是"删除书签分组"这类批量操作会把全网卡打成墓碑。
    // 锁定态继续上抛，让调用方得到 423；其它解密失败也要暴露出来（数据损坏必须可见）。
    const err = new Error('卡片内容无法解密（保险库锁定或密钥不一致）');
    err.code = (e && e.code) || 'DECRYPT_FAILED';
    err.status = (e && e.code === 'VAULT_LOCKED') ? 423 : 409;
    err.cause = e;
    throw err;
  }
  const urls = normalizeUrls(body.urls);
  return {
    ...base,
    type: body.type || 'bookmark',
    name: body.name || '',
    description: body.description ?? null,
    icon: body.icon ?? null,
    openMethod: body.openMethod || 'new_tab',
    bgColor: body.bgColor ?? null,
    bgOpacity: body.bgOpacity ?? null,
    group: body.group || '书签',
    order: body.order ?? 0,
    gridX: body.gridX ?? null,
    gridY: body.gridY ?? null,
    // 【批次 2.2】卡片尺寸：默认 1×1（小组件在 spanOf 里另有默认 1×2）
    cardW: body.cardW === 2 ? 2 : 1,
    cardH: body.cardH === 2 ? 2 : 1,
    memo: body.memo ?? null,
    widgetType: body.widgetType ?? null,
    widgetConfig: body.widgetConfig ?? null,
    isHidden: !!body.isHidden,
    isPinned: !!body.isPinned,
    isMonitored: !!body.isMonitored,
    pingUrl: body.pingUrl ?? null,
    urls,
  };
}

/**
 * 把老数据（明文列 + ItemUrl 表）合成 payload
 * 仅用于一次性迁移，之后明文列全部清空
 */
function packFromLegacy(item, urls = []) {
  let memo = item.memo;
  if (typeof memo === 'string' && memo.startsWith('enc1:')) {
    try {
      memo = cryptoBox.decryptString(memo);
    } catch {
      memo = null;
    }
  }
  return pack({
    type: item.type,
    name: item.name,
    description: item.description,
    icon: item.icon,
    openMethod: item.openMethod,
    bgColor: item.bgColor,
    bgOpacity: item.bgOpacity,
    group: item.group,
    order: item.order,
    gridX: item.gridX,
    gridY: item.gridY,
    memo,
    widgetType: item.widgetType,
    widgetConfig: item.widgetConfig,
    isHidden: item.isHidden,
    isPinned: item.isPinned,
    isMonitored: item.isMonitored,
    pingUrl: item.pingUrl,
    urls,
  });
}

module.exports = { pack, packFromLegacy, unpackRow, normalizeUrls, FIELDS };
