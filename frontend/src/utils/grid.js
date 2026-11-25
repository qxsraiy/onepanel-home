/**
 * 网格布局工具（v2.5.0）
 * ------------------------------------------------------------------
 * 卡片位置存在 gridX / gridY 两个坐标里，但两份数据完全可能出现：
 *  - 两张卡填了同一格（拖拽落点重合、导入旧数据、手动改库）
 *  - 小组件变大后压住旁边的卡
 * CSS Grid 遇到同格会直接叠在一起，所以渲染前统一做一次"首次适配"重排，
 * 保证画面上永远不会有两张卡盖在一起。
 */

/**
 * 卡片占几格（v3.1.1）：
 *  - 小组件默认 1×2（放得下三条进度条）
 *  - 普通卡片由 cardW/cardH 决定，默认 1×1，可选 2×1 / 1×2 / 2×2
 *  - 只接受 1/2，其余值一律回落，避免旧数据或手改库把网格撑坏
 */
export function spanOf(item) {
  const clamp = (v, d) => (Number(v) === 2 ? 2 : Number(v) === 1 ? 1 : d);
  // 小组件固定 1×2：它内部是"三条进度条 + 页脚"，压成 1 行会被 overflow:hidden 裁掉
  if (item?.widgetType) return { w: 1, h: 2 };
  return { w: clamp(item.cardW, 1), h: clamp(item.cardH, 1) };
}

/** 尺寸选项，给右键菜单用 */
export const SIZE_PRESETS = [
  { key: '1x1', w: 1, h: 1, label: '小 (1×1)' },
  { key: '2x1', w: 2, h: 1, label: '宽 (2×1)' },
  { key: '1x2', w: 1, h: 2, label: '高 (1×2)' },
  { key: '2x2', w: 2, h: 2, label: '大 (2×2)' },
];

const cellKey = (x, y) => `${x}:${y}`;

function createFitter(cols) {
  const occupied = new Set();
  const width = Math.max(1, cols);
  const fits = (x, y, w, h) => {
    if (x < 1 || y < 1) return false;
    if (x + w - 1 > width) return false;
    for (let dx = 0; dx < w; dx += 1) {
      for (let dy = 0; dy < h; dy += 1) {
        if (occupied.has(cellKey(x + dx, y + dy))) return false;
      }
    }
    return true;
  };
  const occupy = (x, y, w, h) => {
    for (let dx = 0; dx < w; dx += 1) {
      for (let dy = 0; dy < h; dy += 1) occupied.add(cellKey(x + dx, y + dy));
    }
  };
  const firstFree = (w, h) => {
    for (let y = 1; y <= 500; y += 1) {
      for (let x = 1; x + w - 1 <= width; x += 1) {
        if (fits(x, y, w, h)) return { x, y };
      }
    }
    return { x: 1, y: 1 };
  };
  return { fits, occupy, firstFree, width };
}

/**
 * 按"首次适配"重排：尽量保留原坐标，只把冲突的卡片挪到最近的空位。
 * @param {Array<{id:number,x?:number,y?:number,w?:number,h?:number}>} entries
 * @param {number} cols 当前网格列数
 * @returns {Map<number,{x:number,y:number}>}
 */
export function packLayout(entries, cols) {
  const { fits, occupy, firstFree } = createFitter(cols);
  const safeX = (v) => (Number.isFinite(Number(v)) ? Number(v) : Infinity);
  const sorted = [...entries].sort((a, b) => {
    const ay = safeX(a.y); const by = safeX(b.y);
    if (ay !== by) return ay - by;
    const ax = safeX(a.x); const bx = safeX(b.x);
    if (ax !== bx) return ax - bx;
    return a.id - b.id;
  });

  const placed = new Map();
  for (const entry of sorted) {
    const w = Math.max(1, Number(entry.w) || 1);
    const h = Math.max(1, Number(entry.h) || 1);
    let x = Number(entry.x);
    let y = Number(entry.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !fits(x, y, w, h)) {
      ({ x, y } = firstFree(w, h));
    }
    occupy(x, y, w, h);
    placed.set(entry.id, { x, y });
  }
  return placed;
}

/** 忽略原坐标，按传入顺序从左到右、从上到下重新排满（一键整理用） */
export function arrangeLayout(entries, cols) {
  const { occupy, firstFree } = createFitter(cols);
  const placed = new Map();
  for (const entry of entries) {
    const w = Math.max(1, Number(entry.w) || 1);
    const h = Math.max(1, Number(entry.h) || 1);
    const { x, y } = firstFree(w, h);
    occupy(x, y, w, h);
    placed.set(entry.id, { x, y });
  }
  return placed;
}

/**
 * 拖拽落点吸附：期望位置被别人占了，就找离它最近的空位（行优先扫描）。
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects 同组其它卡片的实际矩形
 * @param {{x:number,y:number,w:number,h:number}} desired 期望矩形
 * @param {number} cols
 */
export function resolveSlot(rects, desired, cols) {
  const { fits, occupy, firstFree } = createFitter(cols);
  for (const r of rects) occupy(r.x, r.y, Math.max(1, r.w || 1), Math.max(1, r.h || 1));
  const w = Math.max(1, Number(desired.w) || 1);
  const h = Math.max(1, Number(desired.h) || 1);
  const x = Number(desired.x);
  const y = Number(desired.y);
  if (Number.isFinite(x) && Number.isFinite(y) && fits(x, y, w, h)) return { x, y };
  return firstFree(w, h);
}
