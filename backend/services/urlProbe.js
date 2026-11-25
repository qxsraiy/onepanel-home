/**
 * 多线路探活（后端执行）
 * ------------------------------------------------------------------
 * 为什么放在后端：
 *  1. 浏览器从前端探测 http://内网IP 时，若面板部署在 HTTPS 下属于"混合内容"，会被浏览器直接阻断
 *  2. no-cors fetch 无法读到状态码，证书错误/自签名也会误判
 *  3. 后端探测没有 CORS / 混合内容限制，结果更可靠，前端也不需要 await 后才能开新标签
 */
const net = require('net');

const DEFAULT_TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 2500);

function parseUrl(rawUrl) {
  try {
    const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

/** TCP 连接探测：能连上就认为线路可用 */
function probeTcp({ host, port }, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok, ms) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok ? ms : null);
    };
    const started = Date.now();
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true, Date.now() - started));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * 在多个候选地址中挑出响应最快的可用线路
 * @param {string[]} urls
 * @returns {Promise<string|null>}
 */
async function probeFastestUrl(urls) {
  const list = (urls || []).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const results = await Promise.all(list.map(async (url) => {
    const parsed = parseUrl(url);
    if (!parsed) return { url, ms: null };
    const ms = await probeTcp(parsed);
    return { url, ms };
  }));

  const ok = results.filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms);
  return ok.length ? ok[0].url : null;
}

module.exports = { probeFastestUrl, probeTcp, parseUrl };
