/**
 * @onepanel/sync-core —— 同步内核的纯计算部分（v3.4.0）
 * ------------------------------------------------------------------
 * 目标：把 HLC / StateVector / LWW 判定这三块抽成**零依赖、纯函数**，
 *      使得同一套规则可以跑在 Node、浏览器、CF Worker 里，
 *      将来"浏览器也是同步节点"就不需要重写规则。
 *
 * 边界：
 *  - 不含 IO、不含 Prisma、不读配置、不碰网络；
 *  - 输入输出都是普通字符串/对象，可序列化；
 *  - 与 backend/services/hlc.js 行为一致（有对照测试 scripts/test-sync-core.mjs）。
 *
 * 三块内容：
 *  1) HLC：混合逻辑时钟 <物理毫秒>:<计数>:<节点ID>
 *  2) StateVector：每个源节点我手上有到第几条
 *  3) LWW：按 HLC 决定谁赢，删除按墓碑优先
 */

const SEP = ':'

// ====== 1. HLC ======

/** 解析：返回 { physical, counter, nodeId } 或 null */
function parse(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  const parts = encoded.split(SEP);
  if (parts.length < 3) return null;
  const physical = Number(parts[0]);
  const counter = Number(parts[1]);
  if (!Number.isFinite(physical) || !Number.isFinite(counter)) return null;
  return { physical, counter, nodeId: parts.slice(2).join(SEP) || '' };
}

/** 编码 */
function encode(physical, counter, nodeId) {
  return [Math.floor(physical), Math.max(0, Math.floor(counter)), String(nodeId || '')].join(SEP);
}

/**
 * 比较：返回 >0 表示 a 更新，<0 表示 b 更新，0 表示相同。
 * 平局用节点 ID 的码点比较（不能用 localeCompare，那依赖 ICU/区域设置）。
 */
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.physical !== pb.physical) return pa.physical - pb.physical;
  if (pa.counter !== pb.counter) return pa.counter - pb.counter;
  const na = String(pa.nodeId);
  const nb = String(pb.nodeId);
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

/** 本地产生下一个 HLC：物理时间前进则计数归零，否则计数 +1 */
function next(state, nodeId, nowMs) {
  const now = Number(nowMs ?? Date.now());
  const lastPhysical = Number(state?.physical || 0);
  const lastCounter = Number(state?.counter || 0);
  const physical = Math.max(now, lastPhysical);
  const counter = physical === lastPhysical ? lastCounter + 1 : 0;
  return { state: { physical, counter }, encoded: encode(physical, counter, nodeId) };
}

/** 收到远端 HLC：抬升本地时钟（只升不降） */
function receive(state, remoteEncoded, nodeId, nowMs) {
  const remote = parse(remoteEncoded);
  const now = Number(nowMs ?? Date.now());
  const lastPhysical = Number(state?.physical || 0);
  const lastCounter = Number(state?.counter || 0);
  if (!remote) {
    const physical = Math.max(now, lastPhysical);
    const counter = physical === lastPhysical ? lastCounter + 1 : 0;
    return { state: { physical, counter }, encoded: encode(physical, counter, nodeId) };
  }
  const physical = Math.max(now, lastPhysical, remote.physical);
  let counter;
  if (physical === lastPhysical && physical === remote.physical) counter = Math.max(lastCounter, remote.counter) + 1;
  else if (physical === lastPhysical) counter = lastCounter + 1;
  else if (physical === remote.physical) counter = remote.counter + 1;
  else counter = 0;
  return { state: { physical, counter }, encoded: encode(physical, counter, nodeId) };
}

/** 是否"超前太多"：一台时钟跑到 2099 的节点会永久压制全网，必须拒收 */
function isTooFarAhead(encoded, nowMs, maxSkewMs) {
  const p = parse(encoded);
  if (!p) return false;
  const now = Number(nowMs ?? Date.now());
  const skew = Number(maxSkewMs ?? 60000);
  return p.physical > now + skew;
}

// ====== 2. StateVector ======

/** 由 changeId 列表（nodeId:seq）聚合出 vector */
function vectorFromChangeIds(changeIds) {
  const vector = {};
  for (const id of changeIds || []) {
    const [nodeId, seqText] = String(id).split(SEP);
    const seq = Number(seqText);
    if (!nodeId || !Number.isFinite(seq)) continue;
    vector[nodeId] = Math.max(vector[nodeId] || 0, seq);
  }
  return vector;
}

/** 合并两个 vector（逐节点取最大） */
function vectorMerge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = Math.max(Number(out[k] || 0), Number(v || 0));
  }
  return out;
}

/** 判断一条变更对方是否还缺（seq > vector[nodeId]） */
function isMissing(vector, nodeId, seq) {
  const nid = typeof nodeId === 'object' ? String(nodeId.nodeId || '') : String(nodeId);
  const s = typeof nodeId === 'object' ? Number(nodeId.seq || 0) : Number(seq || 0);
  return s > Number(vector?.[nid] || 0);
}

// ====== 3. LWW（最后写入者赢 + 墓碑优先） ======

/**
 * 决定本地该不该应用远端变更。
 *
 * **与后端 syncEngine.applyChange 的删除语义一致**（v3.5.8 统一）：
 * 一律按 HLC 比较，不做"删除无条件赢"。
 * 理由：无条件删除赢会让"删除后又被更新的版本恢复"永远无法生效（数据被钉死在删除态）。
 * 防复活靠的是墓碑本身参与 HLC 比较 + 墓碑永久保留，不是靠无条件优先级。
 */
function shouldApply(local, remote) {
  const remoteHlc = remote?.hlc;
  const localHlc = local?.hlc;
  // 两边都是墓碑：比 HLC，仍然允许"后删"覆盖"先删"的时间戳
  return compare(remoteHlc, localHlc) > 0;
}

/** 冲突留档用的原因说明 */
function conflictReason(local, remote) {
  const localDeleted = !!(local && local.deletedAt);
  const remoteDeleted = !!(remote && remote.deletedAt);
  if (localDeleted && remoteDeleted) return 'both-deleted';
  if (localDeleted) return 'local-tombstone-wins';
  if (remoteDeleted) return 'remote-tombstone-wins';
  return 'lww';
}

const api = {
  SEP, parse, encode, compare, next, receive, isTooFarAhead,
  vectorFromChangeIds, vectorMerge, isMissing,
  shouldApply, conflictReason,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
export default api;
export {
  parse, encode, compare, next, receive, isTooFarAhead,
  vectorFromChangeIds, vectorMerge, isMissing,
  shouldApply, conflictReason,
};
