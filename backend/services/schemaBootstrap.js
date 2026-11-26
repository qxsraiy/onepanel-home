/**
 * 首次启动自动建表（v3.3.0）
 * ------------------------------------------------------------------
 * 便携包的目标机器没有 npm / prisma CLI，不能靠 prisma db push。
 * 构建时把 sqlite3 的 .schema 输出存成同目录 schema.sql，
 * 启动时若发现核心表缺失，就按分号切分逐条执行。幂等：只在表缺失时执行。
 */
const fs = require('fs');
const path = require('path');

async function schemaReady(prisma) {
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM NodeState LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

function splitStatements(sql) {
  const out = [];
  let buf = '';
  for (const rawLine of String(sql).split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*--.*$/, '');
    if (!line.trim()) continue;
    buf += line + '\n';
    if (/;\s*$/.test(line)) {
      const stmt = buf.trim().replace(/;\s*$/, '').trim();
      if (stmt) out.push(stmt);
      buf = '';
    }
  }
  const tail = buf.trim().replace(/;\s*$/, '').trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 幂等补列迁移：Prisma 不会自动给已有表加列，便携包升级时也没有 migrations。
 * 这里列出"后加的列"，每一条都捕获错误（列已存在会直接失败，忽略即可）。
 */
async function ensureColumns(prisma) {
  const adds = [
    // v3.7.5：成员设备名
    "ALTER TABLE Member ADD COLUMN name TEXT DEFAULT ''",
    // v3.7.0：主题强调色
    'ALTER TABLE AppConfig ADD COLUMN themeAccent TEXT',
    // v3.9.3：Passkey 的 PRF 包裹
    'ALTER TABLE Passkey ADD COLUMN prfWrapped TEXT',
    // v3.9.4：全局 UI 偏好（换节点也一致）
    "ALTER TABLE AppConfig ADD COLUMN uiPrefs TEXT DEFAULT '{}'",
    // v3.10.6：JWT 纪元（持久化，重启后旧 token 仍失效）
    'ALTER TABLE AppConfig ADD COLUMN tokenEpoch INTEGER DEFAULT 0',
    // v3.14.0：网络域名配置（入网时由老节点下发）
    'ALTER TABLE AppConfig ADD COLUMN cookieDomain TEXT',
    'ALTER TABLE AppConfig ADD COLUMN webauthnRpId TEXT',
    'ALTER TABLE AppConfig ADD COLUMN cookieSecure INTEGER',
  ];
  let done = 0;
  for (const sql of adds) {
    try {
      await prisma.$executeRawUnsafe(sql);
      done += 1;
    } catch { /* 列已存在 / 表不存在，忽略 */ }
  }
  return done;
}

/**
 * 启动时建好"后加的表"（不在 schema.prisma 里，Prisma 不会创建）。
 * 关键：Passkey / AppToken / AppSnapshot 必须在启动就存在，
 * 否则 join/from、syncEngine 的写入会因为表不存在被 .catch 静默吞掉，
 * 而 AppliedChange 已经记账 -> 那批数据永久丢失。
 */
async function ensureTables(prisma) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS Passkey (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credentialId TEXT NOT NULL UNIQUE,
      publicKey TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      label TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      prfWrapped TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS AppToken (
      token TEXT PRIMARY KEY,
      label TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastUsedAt TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS AppSnapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      payload TEXT NOT NULL DEFAULT '{}'
    )`,
  ];
  let done = 0;
  for (const sql of tables) {
    try { await prisma.$executeRawUnsafe(sql); done += 1; } catch { /* 已存在 */ }
  }
  return done;
}

async function ensureSchema(prisma) {
  // 先建后加的表（不依赖 schema.sql）
  try { await ensureTables(prisma); } catch { /* 忽略 */ }
  // 先补列（表已存在的场景），再走建表流程
  try { await ensureColumns(prisma); } catch { /* 忽略 */ }
  if (await schemaReady(prisma)) return { created: false, statements: 0 };

  // 便携包里 schema.sql 与 onepanel.js 同目录；开发环境在 backend/ 上一级
  const candidates = [
    path.join(__dirname, '..', 'schema.sql'),
    path.join(process.cwd(), 'schema.sql'),
    path.join(process.cwd(), 'bin', 'schema.sql'),
  ];
  let sql = String(process.env.PRISMA_SCHEMA_SQL || '');
  for (const c of candidates) {
    if (sql) break;
    try {
      if (fs.existsSync(c)) sql = fs.readFileSync(c, 'utf8');
    } catch { /* 忽略 */ }
  }

  if (!sql) {
    console.warn('⚠️ 数据库表不存在，且找不到 schema.sql（便携包应自带；否则请执行 prisma db push）');
    return { created: false, statements: 0, error: 'no-schema' };
  }

  const statements = splitStatements(sql);
  let done = 0;
  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt);
      done += 1;
    } catch (e) {
      if (!/already exists/i.test(e.message)) {
        console.warn('⚠️ 建表语句失败:', e.message.slice(0, 160));
      }
    }
  }
  console.log(`🗄️ 已按 schema.sql 初始化数据库（${done}/${statements.length} 条）`);
  return { created: true, statements: statements.length, executed: done };
}

module.exports = {ensureSchema, schemaReady, splitStatements, ensureColumns, ensureTables };;;
