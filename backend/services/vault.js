/**
 * 口令保险库（v2.10.0）
 * ------------------------------------------------------------------
 * 痛点：之前要单独记一串 APP_SECRET / .secret-key，换机器一忘全废。
 * 现在：用「管理员登录密码」把主密钥包起来存库（scrypt 派生 KEK + AES-256-GCM），
 * 用户只需要记住自己的账号密码。
 *
 * 运行方式：
 *  - 设了 APP_SECRET → 直接当主密钥，永远解锁（适合无人值守自动备份）
 *  - 没设 → 密码模式：登录（或手动解锁）时用密码解开主密钥，放在进程内存里；
 *    服务重启后处于锁定态，备忘录与备份在解锁前不可读写（不会吐脏数据）
 */
const crypto = require('crypto');
const { envValue } = require('./env');

const KEY_LEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const state = {
  secret: null,   // 主密钥（hex 字符串）
  source: 'none', // env | password | none
};

const envSecret = () => String(envValue('APP_SECRET') || '').trim();

function initFromEnv() {
  const s = envSecret();
  if (s.length >= 16) {
    state.secret = s;
    state.source = 'env';
    return true;
  }
  return false;
}
initFromEnv();

const getSecret = () => state.secret;
const isLocked = () => !state.secret;
const mode = () => state.source;

function setSecret(secret, source = 'password') {
  if (!secret) throw new Error('密钥不能为空');
  state.secret = String(secret);
  state.source = source;
}

function lock() {
  if (state.source === 'env') return; // APP_SECRET 模式没有"锁"
  state.secret = null;
  state.source = 'none';
}

const deriveKek = (password, salt) => crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT_OPTS);

/** 用密码把主密钥包起来：{ salt, wrapped } 都存 AppConfig */
function wrapSecret(secretHex, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKek(password, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretHex, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { salt: salt.toString('hex'), wrapped: Buffer.concat([iv, tag, ciphertext]).toString('base64') };
}

/** 密码不对会抛异常（GCM 认证失败），调用方按"解锁失败"处理 */
function unwrapSecret(wrappedB64, saltHex, password) {
  const raw = Buffer.from(String(wrappedB64), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKek(password, Buffer.from(String(saltHex), 'hex')), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * 主密钥指纹：用来判断"两个节点的加密密钥是不是同一把"。
 * 入网时交换它，不一致直接拒绝——否则会像审计里那样把全网卡片清空。
 */
function fingerprint() {
  const secret = state.secret;
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update('onepanel-vault-fingerprint').digest('hex').slice(0, 16);
}

/**
 * 给定 salt/wrapped/password，算出它会解开的主密钥指纹（不落库、不改进程状态）。
 * 用于空库入网时"先验证再写入"：避免 MITM 在中途替换 vaultWrapped。
 */
function fingerprintOf(wrappedB64, saltHex, password) {
  const secret = unwrapSecret(wrappedB64, saltHex, password);
  return crypto.createHmac('sha256', String(secret)).update('onepanel-vault-fingerprint').digest('hex').slice(0, 16);
}

module.exports = { getSecret, isLocked, mode, setSecret, lock, wrapSecret, unwrapSecret, envSecret, state, fingerprint, fingerprintOf };
