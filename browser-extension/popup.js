import {getConf, api, saveBookmark, applyTheme, shortHost } from './common.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');
const say = (t, cls) => { msg.textContent = t; msg.className = 'msg ' + (cls || ''); };

(async () => {
  const conf = await getConf();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('name').value = (tab && tab.title || '').slice(0, 20);
  $('url').value = (tab && tab.url) || '';

  const hint = $('nodeHint');
  if (hint) hint.textContent = conf.url ? '已连接 ' + shortHost(conf.url) : '未连接节点';

  if (!conf.url || !conf.token) { say('请先在扩展的「选项」里填写节点地址与 token', 'err'); return; }
  try {
    // 只取分组名，不再为了分组列表拉全量卡片
    const data = await api(conf, 'GET', '/api/groups');
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const sel = $('group');
    for (const g of groups) {
      const o = document.createElement('option'); o.value = g; o.textContent = g; sel.appendChild(o);
    }
    if (conf.group && groups.includes(conf.group)) sel.value = conf.group;
  } catch (e) {
    say('读取分组失败：' + e.message, 'err');
  }
})();

$('save').onclick = async () => {
  $('save').disabled = true;
  say('保存中…');
  try {
    const conf = await getConf();
    const r = await saveBookmark(conf, {
      name: $('name').value,
      url: $('url').value,
      group: $('group').value,
    });
    say(r.existed ? '这张卡已经存在了' : '已保存，会自动同步到所有节点', 'ok');
    if (!r.existed) setTimeout(() => window.close(), 900);
  } catch (e) {
    say('失败：' + e.message, 'err');
  } finally {
    $('save').disabled = false;
  }
};

$('openOptions').onclick = (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: 'options.html' });
};
