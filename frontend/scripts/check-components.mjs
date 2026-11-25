/**
 * 检查：模板里用了 <Xxx> 但没有 import（Vue 会把未知组件渲染成空白，且只在控制台警告）
 * 用法：node scripts/check-components.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.vue')) out.push(p);
  }
  return out;
}

/** PascalCase 且首字母大写的标签，才可能是本地组件 */
const isComponentTag = (t) => /^[A-Z][A-Za-z0-9]*$/.test(t) && t !== 'Transition' && t !== 'KeepAlive';

let problems = 0;
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  const tplMatch = src.match(/<template>([\s\S]*)<\/template>/);
  if (!tplMatch) continue;
  const tpl = tplMatch[1];
  const used = new Set();
  for (const m of tpl.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
    if (isComponentTag(m[1])) used.add(m[1]);
  }
  const scriptPart = src.slice(0, src.indexOf('<template>'));
  for (const tag of used) {
    // 自己写自己（递归组件）也算已定义
    const selfName = path.basename(file, '.vue');
    if (tag === selfName) continue;
    // 支持 `import X from`、`import { X, Y } from`、`import { X as Z } from`
    const imported = new RegExp(`import[^;]*\\b${tag}\\b[^;]*from`).test(scriptPart)
      || new RegExp(`import\\s+${tag}\\b`).test(scriptPart);
    if (!imported) {
      problems += 1;
      console.log(`  [MISS] ${path.relative(SRC, file)} 用了 <${tag}> 但没有 import`);
    }
  }
}

// 第二轮：脚本里对 X.value 赋值，但 X 没有 const/let 声明（模板访问会静默变成 undefined）
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  const scriptPart = src.slice(0, src.indexOf('</script>') + '</script>'.length);
  if (!scriptPart) continue;
  const assigned = new Set([...scriptPart.matchAll(/\b(\w+)\.value\s*=/g)].map((m) => m[1]));
  for (const name of assigned) {
    // 只查状态变量命名（is/show/has/can/should 开头），避免把箭头函数参数、事件对象误判
    if (!/^(is|show|has|can|should)[A-Z]/.test(name)) continue;
    const declared = new RegExp('(const|let|var)\\s+' + name + '\\s*=').test(scriptPart);
    if (!declared) {
      problems += 1;
      console.log(`  [MISS] ${path.relative(SRC, file)} 里对 ${name}.value 赋值，但没有声明（未定义的 ref）`);
    }
  }
}

if (problems) { console.log(`\n共 ${problems} 处未导入的组件`); process.exit(1); }
console.log('  ✅ 所有模板组件都有对应 import');
