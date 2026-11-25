/**
 * 节点身份（v3.0.0）
 * ------------------------------------------------------------------
 * 每节点一对 Ed25519 密钥：
 *  - NodeID = base32(sha256(公钥)) 前 26 位（Syncthing 同款思路，便于人眼核对）
 *  - 私钥落盘时用本地机器密钥（data/node-local.key）做 AES-256-GCM 加密
 *  - 签名用于同步请求/变更包，中继无法伪造来源
 *
 * 注意（已与需求方确认）：攻击者拿到 root 且进程正在运行，仍可从内存取私钥；
 * 本设计防的是"只拿到磁盘文件"的场景。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.OP_DATA_DIR || path.join(__dirname, '..', 'data');
const LOCAL_KEY_FILE = path.join(DATA_DIR, 'node-local.key');
const IDENTITY_FILE = path.join(DATA_DIR, 'node-identity.json');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function ensureLocalKey() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LOCAL_KEY_FILE)) {
    const raw = fs.readFileSync(LOCAL_KEY_FILE);
    if (raw.length === 32) return raw;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(LOCAL_KEY_FILE, key, { mode: 0o600 });
  return key;
}

const localKey = ensureLocalKey();
const wrapKey = crypto.createHash('sha256').update(Buffer.concat([localKey, Buffer.from('onepanel-node-identity')])).digest();

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function unseal(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

let identity = null;

function loadOrCreateIdentity() {
  if (identity) return identity;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(IDENTITY_FILE)) {
    try {
      const parsed = JSON.parse(unseal(fs.readFileSync(IDENTITY_FILE)));
      if (parsed && parsed.nodeId && parsed.privateKeyPem) {
        identity = parsed;
        return identity;
      }
    } catch (e) {
      console.error('⚠️ 节点身份文件损坏，将重新生成:', e.message);
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const digest = crypto.createHash('sha256').update(publicKeyPem).digest();
  const nodeId = base32(digest).slice(0, 26);

  identity = { nodeId, publicKeyPem, privateKeyPem, createdAt: new Date().toISOString() };
  fs.writeFileSync(IDENTITY_FILE, seal(JSON.stringify(identity)), { mode: 0o600 });
  console.log('🆔 已生成节点身份:', nodeId);
  return identity;
}

const self = () => loadOrCreateIdentity();

function sign(data) {
  const { privateKeyPem } = self();
  return crypto.sign(null, Buffer.from(String(data)), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

function verify(data, signatureB64, publicKeyPem) {
  try {
    return crypto.verify(null, Buffer.from(String(data)), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signatureB64), 'base64'));
  } catch {
    return false;
  }
}

/**
 * 【E-09】启动时检查私钥文件权限
 * Windows 上 mode 不生效（NTFS ACL 由系统管理），只做提示不阻断。
 * Linux/macOS 上如果 group/other 可读，私钥可能被同机其他用户窃取。
 */
function checkKeyPermissions() {
  if (process.platform === 'win32') return { ok: true, note: 'Windows 不支持 POSIX 权限位' };
  try {
    const fsx = require('fs');
    const pathx = require('fs');
    const st = fsx.statSync(LOCAL_KEY_FILE);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      console.warn('[identity] ⚠️ 私钥文件权限过宽：' + LOCAL_KEY_FILE + ' mode=' + mode.toString(8) + '（建议 600）');
      try { fsx.chmodSync(LOCAL_KEY_FILE, 0o600); console.warn('[identity] 已自动修正为 600'); } catch { /* 忽略 */ }
      return { ok: false, mode };
    }
    return { ok: true, mode };
  } catch { return { ok: true, note: '文件不存在' }; }
}

module.exports = {loadOrCreateIdentity, self, sign, verify, base32, DATA_DIR, checkKeyPermissions };
