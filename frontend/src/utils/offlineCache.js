/**
 * 离线缓存（v3.2.0，批次 3）
 * ------------------------------------------------------------------
 * 目的：节点不可达时也能打开面板看到卡片列表（而不是白屏）。
 *
 * 安全边界（重要）：
 *  - 只缓存 name / group / icon / 第一条 url / 颜色 —— 这些本来就在页面上明文显示；
 *  - **绝不缓存 memo（密码本）、描述、HLC 之外的任何敏感字段**；
 *  - 缓存写在 IndexedDB，随"清除站点数据"一起消失。
 *  - 锁定态下服务端本来就返回占位卡，缓存自然也是占位卡。
 */

const DB_NAME = 'onepanel-offline';
const DB_VERSION = 1;
const STORE = 'items';
const META = 'meta';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持 IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 只保留"可以出现在屏幕上"的字段 */
function slim(item) {
  return {
    id: item.id,
    uid: item.uid,
    name: item.name || '',
    group: item.group || '书签',
    icon: item.icon || null,
    type: item.type || 'bookmark',
    widgetType: item.widgetType || null,
    // 不缓存 widgetConfig（里面可能含天气城市等配置，与离线渲染无关）
    widgetConfig: null,
    openMethod: item.openMethod || 'new_tab',
    bgColor: item.bgColor || null,
    bgOpacity: item.bgOpacity ?? null,
    gridX: item.gridX ?? null,
    gridY: item.gridY ?? null,
    cardW: item.cardW === 2 ? 2 : 1,
    cardH: item.cardH === 2 ? 2 : 1,
    isHidden: !!item.isHidden,
    isPinned: !!item.isPinned,
    isMonitored: !!item.isMonitored,
    urls: (item.urls || []).slice(0, 3).map((u) => ({
      id: u.id, url: u.url, label: u.label, priority: u.priority,
    })),
    // 明确置空：这几个字段哪怕是空字符串也不缓存，避免误存
    memo: null,
    description: null,
    pingUrl: null,
  };
}

export async function saveItems(items, vaultLocked) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const it of items || []) store.put(slim(it));
      tx.objectStore(META).put({ key: 'state', savedAt: Date.now(), locked: !!vaultLocked, count: (items || []).length });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** 读缓存：返回 { items, savedAt, locked } 或 null */
export async function loadItems() {
  try {
    const db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readonly');
      const items = [];
      tx.objectStore(STORE).openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { items.push(cursor.value); cursor.continue(); }
      };
      const metaReq = tx.objectStore(META).get('state');
      let meta = null;
      metaReq.onsuccess = () => { meta = metaReq.result || null; };
      tx.oncomplete = () => resolve({ items, meta });
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if (!result.items.length) return null;
    return { items: result.items, savedAt: result.meta?.savedAt || null, locked: !!result.meta?.locked };
  } catch {
    return null;
  }
}

export async function clearItems() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  } catch { /* 忽略 */ }
}
