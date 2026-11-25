/**
 * 设备在线监测引擎
 * ------------------------------------------------------------------
 * v2.0.0 修复要点：
 *  - 每台设备独立 try/catch 隔离，单台异常不再中断整轮监测
 *  - ICMP 不可用（容器缺 ping 命令）时自动降级到 TCP 443/80 探测，并只提示一次
 *  - 并发探测（Promise.all），不再串行互相拖慢
 *  - 防止上一轮未结束就开启下一轮（重入保护）
 *  - 已删除设备的残留状态自动清理
 *  - 时间统一按 TZ 输出，避免容器 UTC 造成告警时间差 8 小时
 */
const ping = require('ping');
const net = require('net');
const { PrismaClient } = require('@prisma/client');
const wechatNotify = require('./wechatNotify');

const prisma = new PrismaClient();
const deviceStates = {};

// v3.0.0：由 index.js 注入"返回解密后监控项"的函数（pingUrl 在加密 payload 里）
let monitorProvider = null;
function setMonitorProvider(fn) {
  monitorProvider = typeof fn === 'function' ? fn : null;
}

let running = false;
let icmpAvailable = true;
let intervalHandle = null;

const TZ = process.env.TZ || 'Asia/Shanghai';
const CHECK_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 60000);
const OFFLINE_THRESHOLD = Number(process.env.MONITOR_OFFLINE_THRESHOLD || 5); // 连续失败次数
const RETRY_TIMES = Number(process.env.MONITOR_RETRY || 3);
const RETRY_DELAY_MS = Number(process.env.MONITOR_RETRY_DELAY_MS || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString('zh-CN', { timeZone: TZ });

/** 解析监测目标，支持 host、host:port、[IPv6]:port、带 http:// 前缀 */
function parseTarget(raw) {
  const t = String(raw).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!t) return null;
  const v6 = t.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const i = t.lastIndexOf(':');
  if (i > -1 && /^\d+$/.test(t.slice(i + 1))) return { host: t.slice(0, i), port: Number(t.slice(i + 1)) };
  return { host: t, port: null };
}

const probeTcp = ({ host, port }, timeout = 2500) => new Promise((resolve) => {
  const socket = new net.Socket();
  socket.setTimeout(timeout);
  const done = (v) => { socket.destroy(); resolve(v); };
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
  socket.connect(port, host);
});

const probeIcmp = async (host) => {
  try {
    const res = await ping.promise.probe(host, { timeout: 2, min_reply: 1 });
    return !!res.alive;
  } catch (err) {
    if (icmpAvailable) {
      icmpAvailable = false;
      console.error('⚠️ 系统缺少 ping 命令（Alpine 镜像需安装 iputils），ICMP 探测已自动降级为 TCP 443/80 探测');
    }
    return false;
  }
};

/** 单个目标探测：显式端口走 TCP；否则 ICMP，ICMP 不可用时兜底 TCP 443/80 */
const checkHost = async (rawTarget) => {
  if (!rawTarget) return false;
  const target = parseTarget(rawTarget);
  if (!target) return false;
  if (target.host === '127.0.0.1' || target.host === 'localhost') return true;

  if (target.port) return probeTcp(target);

  if (await probeIcmp(target.host)) return true;
  if (icmpAvailable) return false;

  return (await probeTcp({ host: target.host, port: 443 })) || (await probeTcp({ host: target.host, port: 80 }));
};

async function checkOne(dev) {
  let online = false;
  let latencyMs = null;
  for (let r = 0; r < RETRY_TIMES; r++) {
    const t0 = Date.now();
    online = await checkHost(dev.pingUrl);
    if (online) { latencyMs = Date.now() - t0; break; }
    if (r < RETRY_TIMES - 1) await sleep(RETRY_DELAY_MS);
  }

  // 【批次 2.4】写一条存活历史（成功失败都记），用于前端画可用性条形图
  try {
    // 只保留 30 天：顺手清掉更早的
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await prisma.pingHistory.deleteMany({ where: { checkedAt: { lt: cutoff } } }).catch(() => {});
    await prisma.pingHistory.create({ data: { uid: String(dev.uid || dev.id), ok: !!online, latencyMs } });
  } catch (e) {
    if (!globalThis.__pingHistWarned) { console.warn('[监测引擎] 写入存活历史失败:', e.message); globalThis.__pingHistWarned = true; }
  }

  const state = deviceStates[dev.id] || { s: 'Online', f: 0, a: false };

  if (online) {
    if (state.s === 'Offline') {
      console.log(`[监测引擎] 🟢 设备 [${dev.name}] 恢复在线`);
      await wechatNotify.send(`✅ 设备恢复上线\n\n设备名称：${dev.name}\n监测目标：${dev.pingUrl}\n恢复时间：${stamp()}`);
    }
    deviceStates[dev.id] = { s: 'Online', f: 0, a: false };
    return;
  }

  state.f += 1;
  if (state.f >= OFFLINE_THRESHOLD) {
    state.s = 'Offline';
    if (!state.a) {
      console.log(`[监测引擎] 🔴 设备 [${dev.name}] 确诊离线，已触发告警`);
      await wechatNotify.send(`⚠️ 设备离线警告\n\n设备名称：${dev.name}\n监测目标：${dev.pingUrl}\n持续状态：连续 ${OFFLINE_THRESHOLD} 次探测失败\n断线确诊：${stamp()}`);
      state.a = true;
    }
  } else {
    state.s = 'Suspected';
    console.log(`[监测引擎] 🟡 设备 [${dev.name}] 第 ${state.f} 次探测失败（疑似离线）`);
  }
  deviceStates[dev.id] = state;
}

// 存活历史清理：每小时最多一次（原先是每台设备每次探测都删）
let lastHistoryPrune = 0;
async function prunePingHistoryOnce() {
  if (Date.now() - lastHistoryPrune < 3600 * 1000) return;
  lastHistoryPrune = Date.now();
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await prisma.pingHistory.deleteMany({ where: { checkedAt: { lt: cutoff } } });
  } catch { /* 忽略 */ }
}

const runMonitor = async () => {
  if (running) {
    console.log('[监测引擎] 上一轮尚未结束，跳过本轮');
    return;
  }
  running = true;
  try {
    // v3.0.0：pingUrl 在加密 payload 里，必须走解密后的视图
    const items = monitorProvider ? await monitorProvider() : await prisma.item.findMany({ where: { isMonitored: true } });

    await Promise.all(items.map(async (dev) => {
      if (!dev.pingUrl) return;
      try {
        await checkOne(dev);
      } catch (e) {
        // 单台设备异常被隔离，不影响其它设备
        console.error(`❌ [监测引擎] 设备 ${dev.name} 探测异常（已跳过）:`, e.message);
      }
    }));

    // 清理已删除/已取消监控设备的残留状态
    const alive = new Set(items.map((i) => i.id));
    Object.keys(deviceStates).forEach((k) => { if (!alive.has(Number(k))) delete deviceStates[k]; });
  } catch (error) {
    console.error('❌ 后台监测引擎大循环执行异常:', error.message);
  } finally {
    running = false;
  }
};

module.exports = {
  setMonitorProvider,
  start: () => {
    if (intervalHandle) return;
    console.log(`🚀 状态监测系统已启动（间隔 ${CHECK_INTERVAL_MS / 1000}s，连续 ${OFFLINE_THRESHOLD} 次失败判定离线）`);
    runMonitor();
    intervalHandle = setInterval(runMonitor, CHECK_INTERVAL_MS);
  },
  stop: () => {
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = null;
  },
  runOnce: runMonitor,
  getStatus: () => deviceStates,
};
