import core from '../shared/sync-core.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hlc = require('../backend/services/hlc.js');

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}\n        core=${JSON.stringify(a)}\n        hlc =${JSON.stringify(b)}`); }
};

// 1) 解析 / 编码
eq('parse-ok', core.parse('1795574254640:3:ABCD'), { physical: 1795574254640, counter: 3, nodeId: 'ABCD' });
eq('parse-bad', core.parse('x:y:z'), null);
eq('encode', core.encode(1000, 2, 'N1'), '1000:2:N1');

// 2) 比较（含平局）
eq('cmp-physical', Math.sign(core.compare('2000:0:A', '1000:9:A')), 1);
eq('cmp-counter', Math.sign(core.compare('2000:5:A', '2000:4:A')), 1);
eq('cmp-tie-node', Math.sign(core.compare('2000:1:B', '2000:1:A')), 1);
eq('cmp-same', core.compare('2000:1:A', '2000:1:A'), 0);
eq('cmp-vs-hlc', Math.sign(core.compare('2000:1:A', '2000:1:B')), Math.sign(hlc.compare('2000:1:A', '2000:1:B')));

// 3) next / receive 与 hlc.js 同规则
const c1 = core.next({ physical: 1000, counter: 5 }, 'N1', 1000);
eq('next-same-ms', c1.encoded, '1000:6:N1');
const c2 = core.next({ physical: 1000, counter: 5 }, 'N1', 2000);
eq('next-advance', c2.encoded, '2000:0:N1');
const r1 = core.receive({ physical: 1000, counter: 0 }, '5000:3:REMOTE', 'N1', 1000);
eq('receive-remote-ahead', r1.encoded, '5000:4:N1');
const r2 = core.receive({ physical: 5000, counter: 0 }, '9000:0:REMOTE', 'N1', 5000);
eq('receive-remote-ahead-2', r2.encoded, '9000:1:N1');
const r3 = core.receive({ physical: 9000, counter: 5 }, '1000:0:REMOTE', 'N1', 9000);
eq('receive-remote-older', r3.encoded, '9000:6:N1');

// 4) 未来时间
eq('ahead-true', core.isTooFarAhead('9999999999999:0:A', 1000, 60000), true);
eq('ahead-false', core.isTooFarAhead('5000:0:A', 1000, 60000), false);

// 5) StateVector
eq('vec-from-ids', core.vectorFromChangeIds(['A:1', 'A:3', 'B:2']), { A: 3, B: 2 });
eq('vec-merge', core.vectorMerge({ A: 1, B: 5 }, { A: 3, C: 1 }), { A: 3, B: 5, C: 1 });
eq('vec-missing-yes', core.isMissing({ A: 3 }, 'A', 4), true);
eq('vec-missing-no', core.isMissing({ A: 3 }, 'A', 3), false);

// 6) LWW / 墓碑
eq('lww-newer-applies', core.shouldApply({ hlc: '1000:0:A', deletedAt: null }, { hlc: '2000:0:B', deletedAt: null }), true);
eq('lww-older-skips', core.shouldApply({ hlc: '2000:0:A', deletedAt: null }, { hlc: '1000:0:B', deletedAt: null }), false);
// 语义统一后：删除也要比 HLC，旧删除不能覆盖新活版本
// 语义统一后：旧删除不能覆盖新活版本（按 HLC 比较）
eq('tombstone-older-skips', core.shouldApply({ hlc: '9000:0:A', deletedAt: null }, { hlc: '1000:0:B', deletedAt: new Date() }), false);
eq('tombstone-not-ressurected', core.shouldApply({ hlc: '1000:0:A', deletedAt: new Date() }, { hlc: '2000:0:B', deletedAt: null }), true);

console.log(`\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
