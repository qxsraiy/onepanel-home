/**
 * 组件渲染测试（v3.5.9）
 * ------------------------------------------------------------------
 * 解决什么问题：有一类错误"构建能过、运行时才炸"——
 *   ① defineProps 写了非法类型（如 type: null）→ 组件整体渲染失败
 *   ② 模板用了 <Xxx> 但没 import → 渲染成空白，只在控制台警告
 *   ③ 模板里访问了不存在的变量 → 渲染报错
 * 这三类只在真实渲染时暴露，所以这里用 vite SSR 把组件真的渲染一遍。
 *
 * 定位：**纯开发期工具**，不打包进产物、不影响运行时、不需要上线前删除。
 *   体积：0（scripts/ 不进 build）；依赖：只用到项目已有的 vite + vue。
 *
 * 用法：npm run test:components
 */
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

const CASES = [
  {
    name: 'SelectBox（空值 / 有值 / 对象选项）',
    file: '/src/components/SelectBox.vue',
    props: [
      { modelValue: '', options: ['常用', '工具'] },
      { modelValue: '工具', options: ['常用', '工具'] },
      { modelValue: '', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
      { modelValue: null, options: [] },
    ],
    expect: ['sb'],
  },
  {
    name: 'AppIcon（内置图标 / 在线图标 / 空值）',
    file: '/src/components/AppIcon.vue',
    props: [
      { icon: 'mdi:web' },
      { icon: 'logos:vue' },
      {},
    ],
    expect: [],
  },
  {
    name: 'GroupManager（空列表 / 有分组）',
    file: '/src/components/GroupManager.vue',
    props: [
      { groups: [] },
      { groups: ['书签', '工具'] },
    ],
    expect: ['分组'],
  },
  {
    name: 'SyncPanel（无数据时不应崩）',
    file: '/src/components/SyncPanel.vue',
    props: [{}],
    expect: [],
  },
];

let failed = 0;
const errors = [];

// 捕获 Vue 的运行时警告（组件未注册、prop 类型非法都在这里）
const origWarn = console.warn;
const origError = console.error;
function capture() {
  const list = [];
  console.warn = (...args) => { list.push(args.join(' ')); };
  console.error = (...args) => { list.push(args.join(' ')); };
  return {
    list,
    restore() { console.warn = origWarn; console.error = origError; },
  };
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

for (const kase of CASES) {
  let mod;
  try {
    mod = await vite.ssrLoadModule(kase.file);
  } catch (e) {
    failed += 1;
    errors.push(`[加载失败] ${kase.name}: ${e.message}`);
    console.log(`  ✘ ${kase.name} — 模块加载失败`);
    continue;
  }
  for (const props of kase.props) {
    const cap = capture();
    let html = '';
    let thrown = null;
    try {
      const app = createSSRApp({ render: () => h(mod.default, props) });
      app.config.warnHandler = (msg) => cap.list.push('[warn] ' + msg);
      html = await renderToString(app);
    } catch (e) {
      thrown = e;
    }
    cap.restore();

    if (thrown) {
      failed += 1;
      errors.push(`[渲染抛错] ${kase.name} props=${JSON.stringify(props)}: ${thrown.message}`);
      console.log(`  ✘ ${kase.name} props=${JSON.stringify(props)} — 抛错: ${thrown.message.slice(0, 120)}`);
      continue;
    }

    // 空输出说明组件什么都没渲染（典型：未注册组件）
    if (!html || html.trim().length < 5) {
      failed += 1;
      errors.push(`[空输出] ${kase.name} props=${JSON.stringify(props)} 渲染结果为空`);
      console.log(`  ✘ ${kase.name} props=${JSON.stringify(props)} — 渲染为空（可能组件未注册）`);
      continue;
    }

    const bad = cap.list.filter((w) => /Invalid prop|Failed to resolve|Property .* was accessed|is not defined/i.test(w));
    if (bad.length) {
      failed += 1;
      errors.push(`[警告] ${kase.name} props=${JSON.stringify(props)}: ${bad[0].slice(0, 200)}`);
      console.log(`  ✘ ${kase.name} props=${JSON.stringify(props)} — ${bad[0].slice(0, 140)}`);
      continue;
    }

    const missing = (kase.expect || []).filter((token) => !html.includes(token));
    if (missing.length) {
      failed += 1;
      errors.push(`[内容缺失] ${kase.name} props=${JSON.stringify(props)}: 输出里没有 ${missing.join(', ')}`);
      console.log(`  ✘ ${kase.name} props=${JSON.stringify(props)} — 输出缺少 ${missing.join(', ')}`);
      continue;
    }

    console.log(`  ✔ ${kase.name} props=${JSON.stringify(props)}（${html.length} 字节）`);
  }
}

await vite.close();

if (failed) {
  console.log(`\n  共 ${failed} 个用例失败：`);
  for (const e of errors) console.log(`    - ${e}`);
  process.exit(1);
}
console.log('\n  ✅ 组件渲染测试全部通过');
