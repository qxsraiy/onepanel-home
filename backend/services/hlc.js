/**
 * 混合逻辑时钟 HLC（v3.0.0）
 * ------------------------------------------------------------------
 * 为什么不用 Date.now()：
 *  - NAS 断电重启时钟会回到过去，纯物理时间做 LWW 会把旧数据判成新的
 * HLC = (物理毫秒, 逻辑计数, 节点ID)，保证单调递增，且收到远端时间戳时会"抬升"本地
 * 编码成 "物理:计数:节点ID" 字符串，字典序比较前两段即可
 */
const SEP = ':';

let physical = 0;
let counter = 0;

/** 从持久化值恢复（重启后不能回退） */
function restore(encoded) {
  if (!encoded || typeof encoded !== 'string') return;
  const [p, c] = encoded.split(SEP);
  const pp = Number(p);
  const cc = Number(c);
  if (Number.isFinite(pp)) physical = Math.max(physical, pp);
  if (Number.isFinite(cc)) counter = Math.max(counter, cc);
}

function encode(nodeId) {
  return [physical, counter, nodeId].join(SEP);
}

/** 生成下一个时间戳（本地事件） */
function next(nodeId) {
  const now = Date.now();
  if (now > physical) {
    physical = now;
    counter = 0;
  } else {
    counter += 1;
  }
  return encode(nodeId);
}

/** 收到远端时间戳：抬升本地时钟，避免"物理慢的节点一直判旧" */
function receive(remote, nodeId) {
  const parsed = parse(remote);
  if (!parsed) return next(nodeId);
  const now = Date.now();
  const maxPhysical = Math.max(now, physical, parsed.physical);
  if (maxPhysical === physical && maxPhysical === parsed.physical) {
    counter = Math.max(counter, parsed.counter) + 1;
  } else if (maxPhysical === physical) {
    counter += 1;
  } else if (maxPhysical === parsed.physical) {
    counter = parsed.counter + 1;
  } else {
    counter = 0;
  }
  physical = maxPhysical;
  return encode(nodeId);
}

function parse(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  const parts = encoded.split(SEP);
  if (parts.length < 2) return null;
  const p = Number(parts[0]);
  const c = Number(parts[1]);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  return { physical: p, counter: c, nodeId: parts.slice(2).join(SEP) || '' };
}

/** 比较两个 HLC：>0 表示 a 更新 */
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.physical !== pb.physical) return pa.physical - pb.physical;
  if (pa.counter !== pb.counter) return pa.counter - pb.counter;
  // 同一时刻同一计数，用节点 ID 打破平局。
  // 【修复】用码点比较而不是 localeCompare：后者依赖 ICU/区域设置，跨构建理论上可能算出不同赢家。
  const na = String(pa.nodeId);
  const nb = String(pb.nodeId);
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

/**
 * 是否"超前太多"：一台时钟跑到 2099 的节点，它的 HLC 会永远压过所有人，
 * 导致全网任何修改都变成"更旧"而被丢弃。收到远端变更时用它做闸门。
 * 允许 60 秒偏差（NTP 抖动），超出直接拒收并告警。
 */
function isTooFarAhead(encoded, maxSkewMs = 60000) {
  const p = parse(encoded);
  if (!p) return false;
  return p.physical > Date.now() + maxSkewMs;
}

function snapshot() {
  return { physical, counter };
}

module.exports = { restore, next, receive, compare, parse, snapshot, encode, isTooFarAhead };
