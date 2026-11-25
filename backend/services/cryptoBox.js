/**
 * 本地加密盒子（v2.10.0：密钥改由 vault 提供，不再强制单独记 APP_SECRET）
 * ------------------------------------------------------------------
 *  1) 卡片备忘录（可能写着密码）——每条独立随机 salt + iv，AES-256-GCM；
 *  2) 备份包——整包加密后再落盘 / 上传。
 *
 * 主密钥来自 vault：APP_SECRET 模式下常驻；密码模式下登录/解锁后才在内存里。
 * 未解锁时加密/解密会抛 VaultLockedError，调用方据此降级（不返回明文、不写备份）。
 *
 * 老版本把密钥写在 backend/.secret-key，这里保留读取能力，仅用于"首次包裹"迁移。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vault = require('./vault');

const MAGIC = Buffer.from('OPB1');
const STRING_PREFIX = 'enc1:';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** 老版本密钥文件（只读，用于迁移） */
const LEGACY_KEY_FILE = path.join(__dirname, '..', '.secret-key');

class VaultLockedError extends Error {
  constructor(message = '数据保险库尚未解锁：请先用管理员密码解锁') {
    super(message);
    this.name = 'VaultLockedError';
    this.code = 'VAULT_LOCKED';
    this.status = 423;
  }
}

function readLegacyKey() {
  try {
    if (!fs.existsSync(LEGACY_KEY_FILE)) return null;
    const saved = fs.readFileSync(LEGACY_KEY_FILE, 'utf8').trim();
    return saved.length >= 32 ? saved : null;
  } catch {
    return null;
  }
}

/** 用 HKDF 从主密钥派生某个用途的子密钥（memo / backup 各自独立） */
function deriveKey(info, salt) {
  const secret = vault.getSecret();
  if (!secret) throw new VaultLockedError();
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), salt, Buffer.from(`onepanel-${info}-v1`), KEY_LEN));
}

function seal(plainBuffer, info) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(info, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return { salt, iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(salt, iv, tag, ciphertext, info) {
  const key = deriveKey(info, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 加密字符串（memo 用）：明文进来，'enc1:...' 出去 */
function encryptString(plain, info = 'memo') {
  if (plain === null || plain === undefined || plain === '') return null;
  const text = typeof plain === 'string' ? plain : String(plain);
  const { salt, iv, tag, ciphertext } = seal(Buffer.from(text, 'utf8'), info);
  return STRING_PREFIX + Buffer.concat([salt, iv, tag, ciphertext]).toString('base64');
}

/** 解密字符串：不是我们加密的直接原样返回（兼容早期明文数据） */
function decryptString(value, info = 'memo') {
  if (!value || typeof value !== 'string' || !value.startsWith(STRING_PREFIX)) return value;
  try {
    const raw = Buffer.from(value.slice(STRING_PREFIX.length), 'base64');
    const salt = raw.subarray(0, SALT_LEN);
    const iv = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(SALT_LEN + IV_LEN + TAG_LEN);
    return open(salt, iv, tag, ciphertext, info).toString('utf8');
  } catch (e) {
    if (e instanceof VaultLockedError) throw e;
    console.error('⚠️ 备忘录解密失败（密钥不匹配或数据损坏）:', e.message);
    return null;
  }
}

/** 加密二进制（备份包用） */
function encryptBuffer(buffer, info = 'backup') {
  const { salt, iv, tag, ciphertext } = seal(buffer, info);
  return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, tag, ciphertext]);
}

function isEncryptedBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > MAGIC.length + 1 && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

/** 解密备份包（只接受加密包） */
function decryptBuffer(buffer, info = 'backup') {
  if (!isEncryptedBuffer(buffer)) throw new Error('不是加密备份包（只支持 .opb）');
  const version = buffer[MAGIC.length];
  if (version !== 1) throw new Error('备份包版本不支持: ' + version);
  let offset = MAGIC.length + 1;
  const salt = buffer.subarray(offset, offset + SALT_LEN); offset += SALT_LEN;
  const iv = buffer.subarray(offset, offset + IV_LEN); offset += IV_LEN;
  const tag = buffer.subarray(offset, offset + TAG_LEN); offset += TAG_LEN;
  const ciphertext = buffer.subarray(offset);
  return open(salt, iv, tag, ciphertext, info);
}

/**
 * 内容地址（增量备份去重的地基）：HMAC-SHA256 用 vault 主密钥做 key，取前 16 位。
 * 必须用主密钥而不是每节点私钥，否则同内容在不同节点算出不同地址，去重直接失效。
 */
function contentAddress(buffer) {
  const secret = vault.getSecret();
  if (!secret) throw new VaultLockedError();
  return crypto.createHmac('sha256', String(secret)).update(buffer).digest('hex').slice(0, 16);
}

module.exports = {
  encryptString, decryptString, contentAddress,
  encryptBuffer, decryptBuffer, isEncryptedBuffer,
  readLegacyKey, VaultLockedError,
  LEGACY_KEY_FILE,
};
