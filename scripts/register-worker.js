/**
 * 把一个节点登记到 CF Worker 的节点目录（v3.0.1）
 * 用法：
 *   node scripts/register-worker.js <worker地址> <本节点公网地址> [REGISTER_TOKEN]
 * 说明：Worker 端要求用节点私钥对 nodeId|url|ts 签名，首次注册同时提交公钥。
 */
const path = require('path');
const identity = require(path.join(__dirname, '..', 'backend', 'services', 'identity'));
const nodeState = require(path.join(__dirname, '..', 'backend', 'services', 'nodeState'));

const [, , workerBase, selfUrl, tokenArg] = process.argv;
if (!workerBase || !selfUrl) {
  console.error('用法: node scripts/register-worker.js <worker地址> <本节点公网地址> [REGISTER_TOKEN]');
  process.exit(1);
}
const token = tokenArg || process.env.REGISTER_TOKEN || '';
const me = identity.self();
const ts = String(Date.now());
const signBase = me.nodeId + '|' + selfUrl.replace(/\/$/, '') + '|' + ts;
const sig = identity.sign(signBase);

(async () => {
  const res = await fetch(workerBase.replace(/\/$/, '') + '/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-register-token': token } : {}) },
    body: JSON.stringify({
      nodeId: me.nodeId,
      url: selfUrl.replace(/\/$/, ''),
      ts,
      sig,
      publicKey: me.publicKeyPem,
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(res.status, JSON.stringify(body).slice(0, 300));
  if (!res.ok) process.exit(1);
})();
