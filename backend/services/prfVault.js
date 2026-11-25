/**
 * PRF 保险库包裹（v3.9.3）
 * ------------------------------------------------------------------
 * WebAuthn PRF 扩展能在每次认证时派生出**稳定**的 32 字节输出，
 * 相当于"用指纹当密码"。这里把它变成解密主密钥的钥匙：
 *
 *   注册时：PRF 输出 → HKDF → KEK → 包住主密钥 → 存 Passkey.prfWrapped
 *   解锁时：PRF 输出 → HKDF → KEK → 解开 prfWrapped → 得到主密钥
 *
 * 为什么和密码包裹分开存：
 *  - 密码包裹是 vaultSalt/vaultWrapped，改密码会重写，PRF 不用动
 *  - PRF 是"额外一把钥匙"，删了 Passkey 就等于撤销这把钥匙
 */
const crypto = require('crypto');

const KEY_LEN = 32;
const HKDF_INFO = 'onepanel-vault-prf-v1';

/** 固定的 PRF 盐值：必须恒定，否则每次派生结果不同 */
function prfSalt() {
  return crypto.createHash('sha256').update('onepanel-prf-salt-v1').digest();
}

/** PRF 输出（base64）→ 32 字节 KEK */
function kekFromPrf(prfOutputB64) {
  const ikm = Buffer.from(String(prfOutputB64 || ''), 'base64');
  if (ikm.length < 16) throw new Error('PRF 输出太短');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(HKDF_INFO), KEY_LEN));
}

/** 用 PRF 输出把主密钥包起来 */
function wrapByPrf(secretHex, prfOutputB64) {
  const kek = kekFromPrf(prfOutputB64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secretHex, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** 用 PRF 输出解开主密钥；PRF 变了会抛 GCM 认证失败 */
function unwrapByPrf(wrappedB64, prfOutputB64) {
  const kek = kekFromPrf(prfOutputB64);
  const raw = Buffer.from(String(wrappedB64), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { prfSalt, wrapByPrf, unwrapByPrf, kekFromPrf };
