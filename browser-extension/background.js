import { getConf, saveBookmark } from './common.js';

// 右键菜单：保存当前页 / 保存为备忘录
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-page', title: '保存到 OnePanel', contexts: ['page', 'link'] });
  chrome.contextMenus.create({ id: 'save-note', title: '保存选中文字到备忘录', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const conf = await getConf();
  if (!conf.url || !conf.token) {
    chrome.notifications?.create({ type: 'basic', iconUrl: 'icon128.png', title: 'OnePanel', message: '请先在扩展设置里填写节点地址与 token' });
    return;
  }
  try {
    if (info.menuItemId === 'save-page') {
      const url = info.linkUrl || (tab && tab.url) || '';
      const name = (tab && tab.title) || url;
      const r = await saveBookmark(conf, { name, url });
      console.log(r.existed ? '已存在' : '已保存', url);
    } else if (info.menuItemId === 'save-note') {
      const text = String(info.selectionText || '').trim();
      if (!text) return;
      // 存成一张卡片：名字用选中的前 20 字，内容进备忘录备注
      const created = await fetch(conf.url.replace(/\/$/, '') + '/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + conf.token },
        body: JSON.stringify({
          name: text.slice(0, 20),
          group: conf.group || '书签',
          urls: [{ url: (tab && tab.url) || 'https://example.com', label: '来源', priority: 10 }],
        }),
      }).then((r) => r.json());
      if (created && created.id) {
        await fetch(conf.url.replace(/\/$/, '') + '/api/items/' + created.id + '/memo', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + conf.token },
          body: JSON.stringify({ memo: { note: text, entries: [] } }),
        });
      }
    }
  } catch (e) {
    console.error('保存失败:', e.message);
  }
});

/**
 * 【S-07】消息入口（预置安全骨架）
 * ------------------------------------------------------------------
 * 目前扩展内部没有 sendMessage/onMessage 通信，所以不存在攻击面。
 * 这里预置一个带 sender 校验的入口，供以后加功能时直接使用：
 *   - 只接受本扩展自己的消息（sender.id === chrome.runtime.id）
 *   - 只接受白名单 action
 *   - 不接受来自 content script（sender.tab 存在）的高权限操作
 */
const ALLOWED_ACTIONS = ['ping', 'getConf'];
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只认自己人
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'forbidden-sender' });
    return false;
  }
  const action = String((msg && msg.action) || '');
  if (!ALLOWED_ACTIONS.includes(action)) {
    sendResponse({ ok: false, error: 'unknown-action' });
    return false;
  }
  if (action === 'ping') {
    sendResponse({ ok: true, pong: Date.now() });
    return false;
  }
  if (action === 'getConf') {
    getConf().then((c) => sendResponse({ ok: true, conf: c })).catch(() => sendResponse({ ok: false }));
    return true;   // 异步
  }
  return false;
});
