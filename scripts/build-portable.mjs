/**
 * 构建便携包（v3.3.0）：一个文件夹，解压即用，目标机器不需要装 Node/npm。
 *
 * 用法：node scripts/build-portable.mjs
 * 产物：dist-portable/
 *   bin/node            当前平台的 Node 运行时（从 process.execPath 复制）
 *   bin/onepanel.js     后端入口
 *   bin/services/       后端模块
 *   bin/node_modules/   运行依赖（含 Prisma client 与查询引擎）
 *   bin/public/         前端静态资源
 *   data/               运行时数据（空）
 *   logs/               日志（空）
 *   op.sh               终端菜单（Linux 用）
 *
 * 说明：不做单文件 SEA，是因为 Prisma 的查询引擎是原生 .node 模块，
 *      塞进单文件后要从临时目录解压再加载，路径与权限问题比收益多。
 *      「一个文件夹 + 自带 node」已经满足"目标机器零依赖"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND_DIST = path.join(ROOT, 'frontend', 'dist');
// 可用 OP_PORTABLE_OUT 指定输出目录（CI 用 dist/onepanel-portable-v{ver}-win-x64）
const OUT = process.env.OP_PORTABLE_OUT
  ? path.resolve(process.env.OP_PORTABLE_OUT)
  : path.join(ROOT, 'dist-portable');

const log = (m) => console.log(`  ${m}`);
const fail = (m) => { console.error(`  [ERR] ${m}`); process.exit(1); };

// 1) 前置检查
if (!fs.existsSync(path.join(BACKEND, 'node_modules'))) fail('backend/node_modules 不存在，先 npm ci');
if (!fs.existsSync(path.join(BACKEND, 'node_modules', '.prisma'))) fail('缺少 Prisma client，先 npx prisma generate');
if (!fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) fail('frontend/dist 不存在，先 npm run build');

// 2) 清空输出目录
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });

// 3) 复制后端代码（不复制 node_modules 里无关的开发依赖，见第 5 步说明）
const copyOpts = { recursive: true, force: true };
fs.cpSync(path.join(BACKEND, 'index.js'), path.join(OUT, 'bin', 'onepanel.js'));
fs.cpSync(path.join(BACKEND, 'services'), path.join(OUT, 'bin', 'services'), copyOpts);
fs.cpSync(path.join(BACKEND, 'prisma', 'schema.prisma'), path.join(OUT, 'bin', 'schema.prisma'));
// 【v3.31.0】APP_VERSION 从 package.json 读，便携包必须带上
fs.cpSync(path.join(BACKEND, 'package.json'), path.join(OUT, 'bin', 'package.json'));
// 【v3.31.0】便携包标记：index.js 靠它在 cwd 判断 installType=portable
fs.writeFileSync(path.join(OUT, 'portable.marker'), 'onepanel-portable', 'utf8');
fs.writeFileSync(path.join(OUT, 'bin', '.version'), (fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8').match(/"version":\s*"([^"]+)"/) || [])[1] || '0.0.0', 'utf8');
if (fs.existsSync(path.join(BACKEND, 'public'))) fs.cpSync(path.join(BACKEND, 'public'), path.join(OUT, 'bin', 'public'), copyOpts);
else fs.cpSync(FRONTEND_DIST, path.join(OUT, 'bin', 'public'), copyOpts);
// 【v3.31.0】op.sh 早已合并进 op.sh；便携包不需要 .sh（Windows 上用 start.bat）
if (fs.existsSync(path.join(ROOT, 'op.sh'))) fs.cpSync(path.join(ROOT, 'op.sh'), path.join(OUT, 'op.sh'));
log(`后端代码 -> bin/`);
// 3.5) 导出建表 SQL（便携包目标机器没有 prisma CLI，启动时要靠它建表）
try {
  const raw = execFileSync('sqlite3', [path.join(BACKEND, 'prisma', 'dev.db'), '.schema'], { encoding: 'utf8' });
  // sqlite_sequence 是 SQLite 内部表，不能（也不需要）重建，去掉它避免启动时报警
  const ddl = raw.split(/;\s*\r?\n/).filter((s) => s.trim() && !/sqlite_sequence/.test(s)).map((s) => s.trim() + ';').join('\n');
  fs.writeFileSync(path.join(OUT, 'bin', 'schema.sql'), ddl, 'utf8');
  const tableCount = (ddl.match(/CREATE TABLE/gi) || []).length;
  log(`建表 SQL -> bin/schema.sql（${tableCount} 张表）`);
} catch (e) {
  // 【v3.31.0】CI 的 Windows runner 没有 sqlite3 —— 直接拿仓库里的 bin/schema.sql 兜底
  console.error('  [!!] 导出 schema.sql 失败:', e.message);
  const fallback = path.join(BACKEND, 'bin', 'schema.sql');
  if (fs.existsSync(fallback)) {
    fs.cpSync(fallback, path.join(OUT, 'bin', 'schema.sql'));
    const n = (fs.readFileSync(fallback, 'utf8').match(/CREATE TABLE/gi) || []).length;
    log(`建表 SQL -> bin/schema.sql（兜底，${n} 张表）`);
  } else {
    fail('既导不出 schema.sql，也没有 backend/bin/schema.sql 兜底');
  }
}


// 4) Node 运行时（从当前进程复制，保证架构/平台一致）
const nodeTarget = path.join(OUT, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
try {
  fs.copyFileSync(process.execPath, nodeTarget);
  if (process.platform !== 'win32') fs.chmodSync(nodeTarget, 0o755);
  log(`Node 运行时 -> bin/${path.basename(nodeTarget)} (${Math.round(fs.statSync(nodeTarget).size / 1048576)}MB)`);
} catch (e) {
  console.error('  [!!] 复制 Node 运行时失败:', e.message);
}

// 5) 生产依赖
//    Prisma 的 client 生成在 node_modules/.prisma，查询引擎是原生 .node，无法打包进单文件。
//    这里复制整个 node_modules（排除明显的开发目录），保证"解压即用"。
const NM = path.join(BACKEND, 'node_modules');
const NM_OUT = path.join(OUT, 'bin', 'node_modules');
const SKIP = new Set(['.bin', '.cache', '.vite', '@types', 'typescript', 'vite', 'prisma']);
let copied = 0;
let bytes = 0;
fs.mkdirSync(NM_OUT, { recursive: true });
for (const name of fs.readdirSync(NM)) {
  if (SKIP.has(name)) continue;
  const from = path.join(NM, name);
  const to = path.join(NM_OUT, name);
  try {
    fs.cpSync(from, to, { recursive: true, force: true, dereference: false });
    copied += 1;
    const st = fs.statSync(to);
    if (st.isFile()) bytes += st.size;
  } catch (e) {
    console.error(`  [!!] 跳过 ${name}: ${e.message}`);
  }
}
// .prisma 单独复制（client 的实际产物，不能跳过）
// 【注意】必须在 prunePortable() 之前复制，否则裁剪会被未裁剪的源目录覆盖
if (fs.existsSync(path.join(NM, '.prisma'))) fs.cpSync(path.join(NM, '.prisma'), path.join(NM_OUT, '.prisma'), copyOpts);

// ── 裁剪：便携包只保留 Windows 平台真正需要的引擎 ──
// 原包 448MB（.prisma/@prisma 占 342MB），裁剪后约 185MB
const prunePortable = () => {
  const nm = NM_OUT;
  let before = 0;
  const sum = (dir) => {
    let s = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { try { s += fs.statSync(p).size; } catch { /* 忽略 */ } }
      }
    };
    try { walk(dir); } catch { /* 忽略 */ }
    return s;
  };
  before = sum(nm);

  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } };

  // ① prisma generate 中断留下的 .tmp*（实测有 6 个 20MB 的残留）
  const killTmp = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      if (n.includes('.tmp')) rm(path.join(d, n));
    }
  };
  killTmp(path.join(nm, '.prisma', 'client'));
  killTmp(path.join(nm, '@prisma', 'engines'));

  // ② schema-engine 只给 prisma migrate 用，运行时不需要
  const engDir = path.join(nm, '@prisma', 'engines');
  for (const f of (fs.existsSync(engDir) ? fs.readdirSync(engDir) : []).filter((n) => n.startsWith('schema-engine'))) {
    rm(path.join(nm, '@prisma', 'engines', f));
  }

  // ③ @prisma/engines 里的引擎与 .prisma/client 重复，删掉节省 20MB
  for (const f of (fs.existsSync(engDir) ? fs.readdirSync(engDir) : []).filter((n) => n.includes('query_engine') || n.includes('query-engine'))) {
    rm(path.join(nm, '@prisma', 'engines', f));
  }

  // ④ engines 下的 node_modules/.cache（Prisma 下载缓存，纯垃圾）
  rm(path.join(nm, '@prisma', 'engines', 'node_modules'));

  // ⑤ Prisma 的运行时用不到包
  for (const d of ['effect', 'fast-check', 'web-streams-polyfill', 'jiti']) {
    rm(path.join(nm, d));
  }
  for (const d of ['fetch-engine', 'get-platform', 'debug', 'engines-version']) {
    rm(path.join(nm, '@prisma', d));
  }

  // ⑥ Windows 便携包不需要 Linux 引擎（debian/arm64 各占 15MB，纯死重量）
  for (const rel of ['.prisma/client', '@prisma/engines']) {
    const d = path.join(nm, rel);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('libquery_engine-') && !f.includes('windows')) rm(path.join(d, f));
      if (f.startsWith('libquery_engine-') && f.includes('windows')) { /* 保留 */ }
    }
  }
  // ⑦ .prisma/client 的 wasm / 类型声明（Node 走原生引擎，不用 wasm）
  rm(path.join(nm, '.prisma', 'client', 'query_engine_bg.wasm'));
  rm(path.join(nm, '.prisma', 'client', 'index.d.ts'));
  rm(path.join(nm, '.prisma', 'client', 'query-engine-windows.exe'));

  const after = sum(nm);
  log(`裁剪 node_modules：${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);
};
prunePortable();
log(`依赖 -> bin/node_modules (${copied} 个包)`);

// 6) 校验关键文件
const must = ['bin/onepanel.js', 'bin/services/syncEngine.js', 'bin/public/index.html', 'bin/node_modules/.prisma/client/index.js', 'op.sh', 'bin/schema.sql'];
let bad = 0;
for (const f of must) {
  const exists = fs.existsSync(path.join(OUT, f));
  log(`${exists ? 'OK  ' : 'MISS'} ${f}`);
  if (!exists) bad += 1;
}

// 7) 提示
const handle = process.platform === 'win32' ? 'bin\\node.exe' : './bin/node';
console.log('');
console.log(`  输出目录: ${OUT}`);
console.log(`  启动方式: cd ${path.basename(OUT)} && ${process.platform === 'win32' ? 'bin\\node.exe bin\\onepanel.js' : './op.sh'}`);
console.log('  目标机器只需解压，不需要 Node / npm / Docker');
if (bad) { console.error(`  [ERR] 缺 ${bad} 个关键文件`); process.exit(1); }
