/**
 * 通用工具：本地存储安全读写、颜色解析、菜单夹边、轻量 toast
 * 说明：所有 localStorage 读取都必须走 readJSON/safeParse，
 *      避免脏数据在 setup 阶段抛错导致整页白屏。
 */

/** 安全 JSON.parse */
/** 安全 JSON.parse：解析失败返回 fallback，绝不抛出 */
export function safeParse(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 读 localStorage 并 JSON 解析（脏数据返回 fallback） */
export function readJSON(key, fallback = null) {
  try {
    return safeParse(localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

/** 写入失败（配额溢出等）不抛异常，返回布尔值交给调用方提示 */
/** 写 localStorage（JSON 序列化，失败返回 false） */
export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`[storage] 写入 ${key} 失败:`, e.message);
    return false;
  }
}

/** 写 localStorage 纯文本 */
export function writeText(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** 是否合法的 #rgb / #rrggbb 颜色 */
export const isValidHex = (v) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
/** 校验颜色，非法则返回 fallback */
export const safeHex = (v, fallback) => (isValidHex(v) ? v.trim() : fallback);

/**
 * hex → rgba
 * 注意：通道值为 0 时不能再用 `|| fallback`，否则 #000000 会被算成默认色
 */
/** hex 转 rgba 字符串；alpha 为 0 时不会被 fallback 吞掉 */
export function hexToRgba(hex, alpha = 1, fallback = [15, 23, 42]) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const valid = /^[0-9a-f]{6}$/i.test(h);
  const [r, g, b] = valid
    ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    : fallback;
  const n = Number(alpha);
  const a = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 把数值限制在 [min, max] */
export const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);

/**
 * 右键/长按菜单夹边：避免靠近屏幕右下角的卡片菜单被裁掉
 * @param {number} x 期望的横坐标
 * @param {number} y 期望的纵坐标
 * @param {{width:number,height:number}} size 菜单实际尺寸
 * @returns {{x:number,y:number}} 夹取后的坐标
 */
/** 把右键菜单坐标夹到视口内，避免溢出 */
export function clampMenuPosition(x, y, size = { width: 200, height: 300 }) {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(size.width || 200, vw - margin * 2);
  const height = Math.min(size.height || 300, vh - margin * 2);
  return {
    x: clamp(x, margin, Math.max(margin, vw - width - margin)),
    y: clamp(y, margin, Math.max(margin, vh - height - margin)),
  };
}

/** 页脚自定义 HTML 的轻量净化：保留样式类标签，去掉脚本与事件属性 */
/** 净化页脚 HTML：只允许白名单标签与属性，防 XSS */
export function sanitizeFooter(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

/** 是否窄屏（默认阈值 768px） */
export const isMobileWidth = (width = window.innerWidth) => width <= 768;

/** 等待 ms 毫秒 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轻量 toast：不阻塞交互，移动端体验比 alert 好得多 */
/** 轻提示：type 支持 success/warn/error，duration 毫秒 */
export function toast(message, type = 'info', duration = 2600) {
  const colors = {
    info: 'rgba(30, 41, 59, .92)',
    success: 'rgba(16, 185, 129, .92)',
    error: 'rgba(239, 68, 68, .92)',
    warn: 'rgba(245, 158, 11, .92)',
  };
  let host = document.getElementById('op-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'op-toast-host';
    // 手机端顶栏只有 ~64px 高，toast 贴顶会盖住顶栏按钮，所以小屏往下让一点
    const topOffset = isMobileWidth() ? 'calc(env(safe-area-inset-top) + 76px)' : 'calc(16px + env(safe-area-inset-top))';
    host.style.cssText = `position:fixed;left:50%;top:${topOffset};transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(92vw,520px);`;
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.textContent = String(message);
  el.style.cssText = `background:${colors[type] || colors.info};color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.28);word-break:break-word;white-space:pre-wrap;opacity:0;transform:translateY(-6px);transition:opacity .2s,transform .2s;`;
  host.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 220);
  }, duration);
  return el;
}

/**
 * 复制文本（兼容 http 环境）
 * navigator.clipboard 只在 secure context（HTTPS / localhost）可用，
 * 内网 http://192.168.x.x 会直接抛错，所以这里回退到 execCommand。
 */
/** 复制文本：优先 clipboard API，非安全上下文回退 execCommand */
export async function copyToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;
  // ① 现代 API（HTTPS / localhost）
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 继续走降级 */ }
  // ② 老办法：临时 textarea + execCommand（http 下可用）
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
