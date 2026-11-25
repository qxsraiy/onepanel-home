/**
 * 极简 .env 读取（Node 不会自动加载 .env）
 * 只为让 DATABASE_URL / APP_SECRET / SECRET_KEY_FILE 在非 Docker 场景也一致生效。
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function readEnvFile(file = ENV_FILE) {
  const out = {};
  try {
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* 读不到就当没有 */
  }
  return out;
}

const ENV = readEnvFile();
const envValue = (key) => process.env[key] || ENV[key] || '';

module.exports = { envValue, readEnvFile };
