/**
 * 内容寻址增量备份（v3.0.0 阶段 6）
 * ------------------------------------------------------------------
 * 目标：一个文件全网只上传一次；改一张卡只传那一张。
 *
 * 远端布局：
 *   <root>/items/<前2位>/<地址>.opb     每个条目一个文件，文件名 = 内容地址
 *   <root>/manifest/<时间戳>.opb        清单（只留最近 3 份），记录当时引用的全部地址
 *
 * 去重：
 *   - 地址 = HMAC(vault 主密钥, 规范化条目) 前 16 位，跨节点一致
 *   - RemoteBlob 表记录云端已有内容，并随节点同步，别的节点连 HEAD 都不用发
 *
 * 后端可切换（便于本地验证）：
 *   BLOB_STORE=local  -> backups/blob（本地模拟）
 *   BLOB_STORE=webdav -> 现有 WebDAV 云盘（默认）
 */
const fs = require('fs');
const path = require('path');
const cryptoBox = require('./cryptoBox');
const { envValue } = require('./env');

const MANIFEST_KEEP = Number(envValue('BLOB_MANIFEST_KEEP') || 3);
const ROOT = String(envValue('BLOB_ROOT') || '/onepanel');
const LOCAL_ROOT = path.join(__dirname, '..', 'backups', 'blob');

let prismaRef = null;
let webdavFactory = null;
let queueTimer = null;
let running = false;

function init(prisma, factory) {
  prismaRef = prisma;
  webdavFactory = factory;
}

const db = () => {
  if (!prismaRef) throw new Error('blobStore not initialized');
  return prismaRef;
};

/** 条目的规范化字节：字段顺序固定，保证跨节点同内容同字节 */
function canonicalEntry(row) {
  const obj = {
    uid: row.uid,
    hlc: row.hlc,
    nodeId: row.nodeId,
    // 【修复 N4】墓碑时间不能进内容地址：各节点落墓碑用的是"本地 now"，差几百毫秒就会
    // 算出不同地址 → 同一次删除被重复上传，恢复判等也会失配。只记录"是否已删"。
    deleted: row.deletedAt ? 1 : 0,
    payload: row.payload || '',
  };
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

const entryAddress = (row) => cryptoBox.contentAddress(canonicalEntry(row));

// ====== 存储后端 ======
function localStore() {
  const full = (key) => path.join(LOCAL_ROOT, String(key).replace(/^\/+/, ''));
  return {
    name: 'local',
    async put(key, buffer) {
      const f = full(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buffer);
    },
    async get(key) {
      const f = full(key);
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    },
    async exists(key) { return fs.existsSync(full(key)); },
    async remove(key) { const f = full(key); if (fs.existsSync(f)) fs.unlinkSync(f); },
    async list(prefix) {
      const base = full(prefix);
      if (!fs.existsSync(base)) return [];
      const out = [];
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (fs.statSync(p).isDirectory()) walk(p);
          else out.push(path.relative(LOCAL_ROOT, p).replace(/\\/g, '/'));
        }
      };
      walk(base);
      return out;
    },
  };
}

function webdavStore(client) {
  const key2path = (key) => ROOT + '/' + String(key).replace(/^\/+/, '');
  return {
    name: 'webdav',
    async put(key, buffer) {
      await client.putFileContents(key2path(key), buffer, { overwrite: true });
    },
    async get(key) {
      try { return Buffer.from(await client.getFileContents(key2path(key))); } catch { return null; }
    },
    async exists(key) {
      try { return !!(await client.stat(key2path(key))); } catch { return false; }
    },
    async remove(key) {
      try { await client.deleteFile(key2path(key)); } catch { /* 已不在 */ }
    },
    async list(prefix) {
      try {
        // 【修复 N3】默认只列当前层，而条目布局是 items/<前2位>/<hash>.opb，必须递归；
        // 否则 GC 扫不到任何条目（永远空转）、status 计数恒为 0。
        const contents = await client.getDirectoryContents(key2path(prefix), { deep: true });
        const base = String(prefix).replace(/^\/+/, '');
        return (Array.isArray(contents) ? contents : [])
          .filter((f) => f.type !== 'directory')
          .map((f) => base + '/' + (f.basename || (f.filename || '').split('/').pop() || ''));
      } catch { return []; }
    },
  };
}

async function getStore() {
  const mode = String(envValue('BLOB_STORE') || 'auto');
  if (mode === 'local') return localStore();
  const client = await webdavFactory();
  if (client) return webdavStore(client);
  if (mode === 'webdav') throw new Error('WebDAV 未配置，无法使用云端增量备份');
  // auto：没有云盘就落到本地目录，保证"自动增量备份"永远能跑
  return localStore();
}

// ====== 上传 ======
async function ensureBlob(store, row, uploadedBy, verify) {
  const address = entryAddress(row);
  const known = await db().remoteBlob.findUnique({ where: { hash: address } });
  if (known && !verify) return { address, skipped: true, reason: 'known' };

  const key = 'items/' + address.slice(0, 2) + '/' + address + '.opb';
  if (await store.exists(key)) {
    await db().remoteBlob.upsert({
      where: { hash: address },
      create: { hash: address, size: 0, uploadedBy: uploadedBy || '', kind: 'item' },
      update: {},
    });
    return { address, skipped: true, reason: 'exists' };
  }

  const sealed = cryptoBox.encryptBuffer(canonicalEntry(row), 'blob');
  await store.put(key, sealed);
  await db().remoteBlob.upsert({
    where: { hash: address },
    create: { hash: address, size: sealed.length, uploadedBy: uploadedBy || '', kind: 'item' },
    update: { size: sealed.length },
  });
  return { address, uploaded: true, bytes: sealed.length };
}

async function syncItems(opts) {
  const options = opts || {};
  const store = await getStore();
  const rows = await db().item.findMany({ orderBy: { id: 'asc' } });
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;
  for (const row of rows) {
    try {
      const r = await ensureBlob(store, row, options.uploadedBy || '', !!options.verify);
      if (r.uploaded) { uploaded += 1; bytes += r.bytes || 0; await new Promise((s) => setTimeout(s, 60)); }
      else skipped += 1;
    } catch (e) {
      console.warn('[blob] 上传失败 ' + row.uid + ': ' + e.message);
    }
  }
  return { total: rows.length, uploaded, skipped, bytes, store: store.name };
}

// ====== 清单 ======
async function writeManifest() {
  const store = await getStore();
  const rows = await db().item.findMany({ orderBy: { id: 'asc' } });
  const entries = rows.map((row) => ({ address: entryAddress(row), uid: row.uid, hlc: row.hlc }));
  const manifest = { version: 1, createdAt: new Date().toISOString(), items: entries };
  // 毫秒级时间戳：同一秒内多次写清单不会互相覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
  const key = 'manifest/' + stamp + '.opb';
  const sealed = cryptoBox.encryptBuffer(Buffer.from(JSON.stringify(manifest), 'utf8'), 'manifest');
  await store.put(key, sealed);

  const manifests = (await store.list('manifest')).filter((f) => f.endsWith('.opb')).sort();
  // 【Q7】保留规则：最近 MANIFEST_KEEP 份 + 每天第一份保留 DAILY_KEEP_DAYS 天
  const { keep, drop } = selectManifestsToKeep(manifests);
  const removeList = drop;
  for (const f of removeList) await store.remove(f);

  await db().remoteBlob.upsert({
    where: { hash: key },
    create: { hash: key, size: sealed.length, kind: 'manifest' },
    update: { size: sealed.length },
  });
  return { key, entries: entries.length, removed: removeList.length, kept: manifests.length - removeList.length };
}

const DAILY_KEEP_DAYS = Number(envValue('BLOB_DAILY_KEEP_DAYS') || 30);

/**
 * 清单保留策略（Q7）：
 *  - 最近 MANIFEST_KEEP 份一律保留（细粒度回滚）
 *  - 每天的第一份保留 DAILY_KEEP_DAYS 天（粗粒度回滚）
 *  - 其余删除
 * 文件名形如 manifest/2026-11-24_15-39-23-456.opb，前 10 位就是日期。
 */
function selectManifestsToKeep(manifests) {
  const sorted = manifests.slice().sort();
  const keep = new Set(sorted.slice(Math.max(0, sorted.length - MANIFEST_KEEP)));
  // 每天第一份
  const firstOfDay = new Map();
  for (const f of sorted) {
    const m = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    if (!firstOfDay.has(m[1])) firstOfDay.set(m[1], f);
  }
  const cutoff = Date.now() - DAILY_KEEP_DAYS * 24 * 3600 * 1000;
  for (const [day, file] of firstOfDay) {
    if (new Date(day + 'T00:00:00Z').getTime() >= cutoff) keep.add(file);
  }
  const drop = sorted.filter((f) => !keep.has(f));
  return { keep: [...keep].sort(), drop };
}

/** 垃圾回收：所有清单都不引用的条目文件才删 */
/**
 * 【E-04】GC 互斥锁
 * 标记-删除之间如果插入新的备份写入，可能删掉被新清单引用的 blob。
 * 这里用模块级 flag 保证同一进程内不会并发 GC。
 */
let gcRunning = false;

async function gc() {
  if (gcRunning) {
    const err = new Error('已有 GC 在执行，请稍后再试');
    err.status = 409;
    err.code = 'GC_BUSY';
    throw err;
  }
  gcRunning = true;
  try {
    return await gcInner();
  } finally {
    gcRunning = false;
  }
}

async function gcInner() {
  // 【修复 BUG-3】锁定态下清单全解不开，used 会是空集 → 把云端条目全删光。先拦一道。
  if (require('./vault').isLocked()) {
    const err = new Error('保险库未解锁，无法安全 GC（清单解不开会把云端条目当垃圾删掉）');
    err.status = 423;
    err.code = 'VAULT_LOCKED';
    throw err;
  }
  const store = await getStore();
  const manifests = (await store.list('manifest')).filter((f) => f.endsWith('.opb')).sort();
  const used = new Set();
  let decoded = 0;
  const latestKey = manifests[manifests.length - 1];
  let latestDecoded = false;
  for (const key of manifests) {
    const buf = await store.get(key);
    if (!buf) continue;
    try {
      const plain = cryptoBox.decryptBuffer(buf, 'manifest').toString('utf8');
      const parsed = JSON.parse(plain);
      for (const it of parsed.items || []) used.add(it.address);
      decoded += 1;
      if (key === latestKey) latestDecoded = true;
    } catch { /* 坏清单跳过 */ }
  }
  // 【修复 P1-3】只要求"至少一份能解"不够：若能解的是很老的清单，
  // 它不包含最近新增的条目 → GC 会把新条目当垃圾删掉。最新一份必须能解。
  if (latestKey && !latestDecoded) {
    const err = new Error('最新一份清单无法解密，已中止 GC（防止误删最近上传的条目）');
    err.status = 409;
    err.code = 'LATEST_MANIFEST_UNDECODABLE';
    throw err;
  }
  // 【修复 BUG-3】有清单却一份都解不开 → 中止，不要当"没有引用"
  if (manifests.length > 0 && decoded === 0) {
    const err = new Error('所有清单都无法解密，已中止 GC（防止误删云端数据）');
    err.status = 409;
    err.code = 'MANIFEST_UNDECODABLE';
    throw err;
  }
  const files = (await store.list('items')).filter((f) => f.endsWith('.opb'));
  let removed = 0;
  for (const f of files) {
    const address = path.basename(f, '.opb');
    if (used.has(address)) continue;
    await store.remove(f);
    await db().remoteBlob.deleteMany({ where: { hash: address } }).catch(() => {});
    removed += 1;
  }
  return { scanned: files.length, removed, manifests: manifests.length };
}

// ====== 恢复（增量）======
async function restore(opts) {
  const options = opts || {};
  const store = await getStore();
  const manifests = (await store.list('manifest')).filter((f) => f.endsWith('.opb')).sort();
  const key = options.manifestKey || manifests[manifests.length - 1];
  if (!key) throw new Error('云端没有可用清单');
  const buf = await store.get(key);
  if (!buf) throw new Error('清单读不到: ' + key);
  const manifest = JSON.parse(cryptoBox.decryptBuffer(buf, 'manifest').toString('utf8'));

  const local = await db().item.findMany();
  const localByUid = new Map(local.map((r) => [r.uid, r]));

  let restored = 0;
  let skipped = 0;
  let missing = 0;
  for (const entry of manifest.items || []) {
    const existing = localByUid.get(entry.uid);
    if (existing && entryAddress(existing) === entry.address) { skipped += 1; continue; }
    const file = 'items/' + entry.address.slice(0, 2) + '/' + entry.address + '.opb';
    const sealed = await store.get(file);
    if (!sealed) { missing += 1; continue; }
    const item = JSON.parse(cryptoBox.decryptBuffer(sealed, 'blob').toString('utf8'));
    // 【修复 BUG-5】恢复不是"无条件覆盖"：本地版本更新就必须跳过，否则用旧清单会把新数据冲掉
    if (existing && existing.hlc) {
      const { compare } = require('./hlc');
      if (compare(item.hlc, existing.hlc) <= 0) {
        skipped += 1;
        continue;
      }
    }
    await db().item.upsert({
      where: { uid: item.uid },
      create: {
        uid: item.uid, payload: item.payload, hlc: item.hlc, nodeId: item.nodeId,
        deletedAt: item.deletedAt ? new Date(item.deletedAt) : null, dirty: true, name: '', group: '',
      },
      update: {
        payload: item.payload, hlc: item.hlc, nodeId: item.nodeId,
        deletedAt: item.deletedAt ? new Date(item.deletedAt) : null, dirty: true,
      },
    });
    restored += 1;
  }
  return { manifest: key, restored, skipped, missing, total: (manifest.items || []).length };
}

// ====== 节流触发 ======
function scheduleSync(delay) {
  if (queueTimer) return;
  queueTimer = setTimeout(async () => {
    queueTimer = null;
    if (running) { scheduleSync(15000); return; }
    running = true;
    try {
      const result = await syncItems({ uploadedBy: 'auto' });
      if (result.uploaded) await writeManifest();
      if (result.uploaded) console.log('[blob] 增量备份完成: 上传 ' + result.uploaded + ' 跳过 ' + result.skipped + ' 共 ' + result.bytes + ' 字节');
    } catch (e) {
      console.warn('[blob] 增量备份失败: ' + e.message);
    } finally {
      running = false;
    }
  }, delay || 5000);
}

module.exports = {
  init, syncItems, writeManifest, gc, restore, scheduleSync,
  entryAddress, canonicalEntry, getStore,
};
