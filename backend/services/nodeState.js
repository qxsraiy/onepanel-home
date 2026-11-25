/**
 * 节点本地状态存储（v3.0.0）
 * 用 NodeState 表存 nodeId / urls / hlc / seq 等小键值，避免散落文件。
 */
let prismaRef = null;
const cache = new Map();

function init(prisma) {
  prismaRef = prisma;
}

async function warm() {
  if (!prismaRef) return;
  const rows = await prismaRef.nodeState.findMany();
  for (const row of rows) cache.set(row.key, row.value);
}

function get(key, fallback = null) {
  return cache.has(key) ? cache.get(key) : fallback;
}

async function set(key, value) {
  const text = value === null || value === undefined ? '' : String(value);
  cache.set(key, text);
  if (!prismaRef) return;
  await prismaRef.nodeState.upsert({
    where: { key },
    create: { key, value: text },
    update: { value: text },
  });
}

/**
 * 本地变更序号自增（用于 ChangeLog.seq）。
 * 【修复 BUG-8】必须同步落库：以前防抖 300ms、失败还吞掉，进程崩溃后会复用已用过的 seq，
 * 导致 changeId 唯一键冲突、那条编辑永久不同步（本地有、全网没有）。
 * SQLite 本地写是微秒级，完全不值得防抖。
 */
async function nextSeq() {
  const current = Number(get('seq', '0')) || 0;
  const next = current + 1;
  cache.set('seq', String(next));
  if (prismaRef) {
    // 同步等待落库；失败就抛错，让调用方不要产生"没留痕"的变更
    await prismaRef.nodeState.upsert({
      where: { key: 'seq' },
      create: { key: 'seq', value: String(next) },
      update: { value: String(next) },
    });
  }
  return next;
}

module.exports = { init, warm, get, set, nextSeq };
