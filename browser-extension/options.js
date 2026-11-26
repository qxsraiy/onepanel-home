import {getConf, saveConf, api, applyTheme } from './common.js';

const $ = (id) => document.getElementById(id);

(async () => {
  const conf = await getConf();
  $('url').value = conf.url || '';
  $('token').value = conf.token || '';
  $('group').value = conf.group || '书签';
})();

$('save').onclick = async () => {
  const conf = {
    url: $('url').value.trim().replace(/\/$/, ''),
    token: $('token').value.trim(),
    group: $('group').value.trim() || '书签',
  };
  $('msg').textContent = '测试连接…';
  try {
    await api(conf, 'GET', '/api/items');
    await saveConf(conf);
    $('msg').textContent = '已保存，连接正常 ✔';
  } catch (e) {
    $('msg').textContent = '连接失败：' + e.message;
  }
};
