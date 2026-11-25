/**
 * 成员对外地址校验（v3.0.1）
 * 成员自报的地址会被所有节点定时 fetch，不校验就等于"借全体节点之手 SSRF"。
 * 规则：必须 http(s)；拒绝环回/未指定与云元数据段；RFC1918 内网默认放行（自建内网是主场景），
 * 可用 PEER_ALLOW_PRIVATE=0 收紧。
 */
function isSafePeerUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '0.0.0.0' || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '169.254.169.254' || host.startsWith('169.254.')) return false; // 云元数据/链路本地
  if (host === '::1' || host === '::') return false;
  // 【S-05 补全】
  // 云厂商元数据域名（不只是 IP）
  if (['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data'].includes(host)) return false;
  // CGNAT / 运营商级 NAT：100.64.0.0/10
  const cg = host.match(/^100\.(\d+)\./);
  if (cg && Number(cg[1]) >= 64 && Number(cg[1]) <= 127) return false;
  // IPv6 链路本地 fe80::/10 与 ULA fc00::/7 —— 无条件拒绝（不管是否允许内网）
  if (/^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) return false;
  // 【修复】环回地址永远拒绝：即使允许内网，也不该让全网定时去打某台的 127.0.0.1
  const loop = host.match(/^127\.(\d+)\.(\d+)\.(\d+)$/);
  if (loop) return false;
  const allowPrivate = String(process.env.PEER_ALLOW_PRIVATE || '1') === '1';
  if (!allowPrivate) {
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      if (a === 10) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
    }
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
  }
  return true;
}

const cleanPeerUrls = (raw) => String(raw || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .filter(isSafePeerUrl).join(',');

module.exports = { isSafePeerUrl, cleanPeerUrls };
