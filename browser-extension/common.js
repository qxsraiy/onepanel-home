/**
 * 读取配置：节点地址 + token + 默认分组。
 * 用 storage.local 而不是 storage.sync：token 不该跟着 Chrome 账号同步到其他设备
 * （公司电脑登了个人账号的话，token 会被复制过去）。
 */
export async function getConf() {
  const { conf } = await chrome.storage.local.get(['conf']);
  return conf || { url: '', token: '', group: '书签' };
}

export async function saveConf(conf) {
  await chrome.storage.local.set({ conf });
}

/** 统一 API 调用 */
export async function api(conf, method, path, body) {
  if (!conf.url || !conf.token) throw new Error('还没配置节点地址与 token');
  const res = await fetch(conf.url.replace(/\/$/, '') + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + conf.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/** 保存一条书签（自动去重：同名且同地址视为已存在） */
export async function saveBookmark(conf, { name, url, group, description }) {
  const items = await api(conf, 'GET', '/api/items');
  const list = Array.isArray(items) ? items : [];
  const exists = list.find((i) => (i.urls || []).some((u) => u.url === url));
  if (exists) return { existed: true, item: exists };
  const created = await api(conf, 'POST', '/api/items', {
    name: String(name || url).slice(0, 20),
    description: String(description || '').slice(0, 50),
    group: group || conf.group || '书签',
    urls: [{ url, label: '主地址', priority: 10 }],
  });
  return { existed: false, item: created };
}

/**
 * 从面板拉主题配置，应用到扩展页面（跟随面板配色）
 * 拿不到就用默认深色，不阻塞页面
 */
export async function applyTheme() {
  try {
    const conf = await getConf();
    if (!conf.url || !conf.token) return;
    const base = String(conf.url).replace(/\/$/, '');
    const r = await fetch(base + '/api/config/theme', {
      headers: { authorization: 'Bearer ' + conf.token },
    });
    if (!r.ok) return;
    const t = await r.json();
    const root = document.documentElement;
    if (t.themeBg) root.style.setProperty('--bg', t.themeBg);
    if (t.themeColor) root.style.setProperty('--fg', t.themeColor);
    if (t.themeAccent) {
      root.style.setProperty('--accent', t.themeAccent);
      root.style.setProperty('--glow', t.themeAccent + '59');
    }
  } catch { /* 忽略，用默认配色 */ }
}

/** 取节点 host 用于显示 */
export function shortHost(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}
