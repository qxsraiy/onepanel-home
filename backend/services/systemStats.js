/**
 * 系统状态采集（v2.3.0）
 * ------------------------------------------------------------------
 * 只读本机信息，不引入额外依赖：
 *  - CPU 使用率：用两次 os.cpus() 的时间片差值，比 load average 直观
 *  - 内存：os.totalmem / freemem
 *  - 磁盘：Node 18.15+ 的 fs.statfsSync（拿不到就返回 null，前端隐藏该项）
 *  - 运行时长：os.uptime()（系统）与 process.uptime()（进程）
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

let lastCpuTimes = readCpuTimes();

function readCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
}

/** 距上次调用之间的 CPU 平均使用率（0-100，保留一位小数） */
function getCpuUsage() {
  const now = readCpuTimes();
  const idleDiff = now.idle - lastCpuTimes.idle;
  const totalDiff = now.total - lastCpuTimes.total;
  lastCpuTimes = now;
  if (totalDiff <= 0) return null;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return Math.min(100, Math.max(0, Math.round(usage * 10) / 10));
}

function getDiskUsage(target) {
  try {
    const stats = fs.statfsSync(target);
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    if (!total) return null;
    return {
      total,
      free,
      used: total - free,
      percent: Math.round(((total - free) / total) * 1000) / 10,
      path: target,
    };
  } catch {
    return null;
  }
}

function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus() || [];
  const dataDir = path.join(__dirname, '..', 'prisma');

  return {
    ts: Date.now(),
    cpu: {
      usage: getCpuUsage(),
      cores: cpus.length,
      model: (cpus[0] && cpus[0].model ? cpus[0].model : 'unknown').trim(),
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    mem: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      percent: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : null,
    },
    disk: getDiskUsage(dataDir),
    uptime: {
      system: Math.floor(os.uptime()),
      process: Math.floor(process.uptime()),
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version,
    },
  };
}

module.exports = { getSystemStats };
