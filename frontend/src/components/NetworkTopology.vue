<script setup>
/**
 * 网络拓扑图（v3.8.0 美化版）
 * ------------------------------------------------------------------
 * 纯 SVG + CSS，零依赖。8 项美化：
 *  ① 同心虚线轨道环（空间锚定）
 *  ② 本机呼吸外环（reduced-motion 下自动关闭）
 *  ③ 在线实线 / 离线虚线，在线叠加流动虚线表达"同步中"
 *  ④ 连线端点留白（不戳进节点圆）
 *  ⑤ 中心图标换成 SVG path（Unicode 在不同系统字重不一）
 *  ⑥ 外围圆内显示设备名首字
 *  ⑦ 内置浮条替代 <title>（移动端也能看）
 *  ⑧ 卡片式容器 + 图例收进角落
 */
import { ref, computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  nodeId: { type: String, default: '' },
  nodeName: { type: String, default: '' },
  members: { type: Array, default: () => [] },
});
const emit = defineEmits(['pick']);

const W = 480;
const H = 250;
const CX = W / 2;
const CY = H / 2;

const short = (id) => String(id || '').slice(0, 6);
const labelOf = (m) => (m && m.name ? m.name : short(m && m.nodeId));
/** 圆内首字：优先设备名首字，否则 nodeId 前 2 位 */
const initialOf = (m) => { const s = labelOf(m); return s ? s.slice(0, 1) : '?'; };

const selfName = computed(() => props.nodeName || '本机');
const visible = computed(() => (props.members || []).filter((m) => m && m.status !== 'revoked'));
const revokedCount = computed(() => (props.members || []).filter((m) => m && m.status === 'revoked').length);

const radius = computed(() => Math.min(148, 78 + visible.value.length * 7));

const nodes = computed(() => {
  const list = visible.value;
  const r = radius.value;
  return list.map((m, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(1, list.length) - Math.PI / 2;
    const x = CX + Math.cos(angle) * r;
    const y = CY + Math.sin(angle) * r * 0.7;
    // 连线端点留白：从本机边缘 30px 起步，到目标圆边缘 20px 结束
    const dx = x - CX;
    const dy = y - CY;
    const len = Math.hypot(dx, dy) || 1;
    return {
      ...m,
      x, y,
      label: labelOf(m),
      initial: initialOf(m),
      x1: CX + (dx / len) * 30,
      y1: CY + (dy / len) * 30,
      x2: x - (dx / len) * 20,
      y2: y - (dy / len) * 20,
    };
  });
});

const colorOf = (s) => {
  if (s === 'active') return '#10b981';
  if (s === 'offline') return '#f59e0b';
  if (s === 'revoked') return '#ef4444';
  return '#94a3b8';
};

/** 悬浮浮条：替代 <title>（桌面要停 1 秒才出，移动端看不到） */
const hover = ref(null);
const hoverText = computed(() => {
  const n = hover.value;
  if (!n) return '';
  const parts = [n.label];
  if (n.selfUrls) parts.push(n.selfUrls);
  if (n.status === 'offline') parts.push(n.lastError ? '同步失败：' + n.lastError : '已离线');
  else if (n.lastSyncAt) parts.push('最后同步 ' + new Date(n.lastSyncAt).toLocaleString('zh-CN'));
  return parts.join(' · ');
});
const relTime = (v) => {
  if (!v) return '';
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 1000);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + '分前';
  if (d < 86400) return Math.floor(d / 3600) + '小时前';
  return Math.floor(d / 86400) + '天前';
};

const orbit = computed(() => radius.value);
</script>

<template>
  <div class="topo-card">
    <svg :viewBox="`0 0 ${W} ${H}`" class="topo-svg" role="img" aria-label="网络拓扑">
      <defs>
        <radialGradient id="topoSelfGlow">
          <stop offset="0%" stop-color="var(--theme-accent, #3b82f6)" stop-opacity=".3" />
          <stop offset="100%" stop-color="var(--theme-accent, #3b82f6)" stop-opacity="0" />
        </radialGradient>
      </defs>

      <!-- ① 同心轨道环 -->
      <ellipse :cx="CX" :cy="CY" :rx="orbit" :ry="orbit * 0.7"
        fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="3 5" opacity=".08" />
      <ellipse :cx="CX" :cy="CY" :rx="orbit * 0.55" :ry="orbit * 0.55 * 0.7"
        fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="3 5" opacity=".06" />

      <!-- ③④ 连线：在线实线 + 流动虚线；离线虚线；端点留白 -->
      <g v-for="n in nodes" :key="'l' + n.nodeId">
        <line :x1="n.x1" :y1="n.y1" :x2="n.x2" :y2="n.y2"
          :stroke="colorOf(n.status)" stroke-width="1.4" stroke-opacity=".38"
          :stroke-dasharray="n.status === 'offline' ? '4 4' : 'none'" />
        <line v-if="n.status === 'active'" :x1="n.x1" :y1="n.y1" :x2="n.x2" :y2="n.y2"
          :stroke="colorOf(n.status)" stroke-width="1.4" stroke-opacity=".55"
          stroke-dasharray="6 14" class="topo-flow" />
      </g>

      <!-- ② 本机光晕 + 呼吸环 -->
      <circle :cx="CX" :cy="CY" r="60" fill="url(#topoSelfGlow)" />
      <circle :cx="CX" :cy="CY" r="32" fill="none"
        stroke="var(--theme-accent, #3b82f6)" stroke-width="1" stroke-opacity=".35" class="topo-breathe" />

      <!-- ⑤ 本机：SVG 图标代替 Unicode -->
      <g class="topo-self" @mouseenter="hover = { label: selfName, selfUrls: '', status: 'active' }" @mouseleave="hover = null">
        <circle :cx="CX" :cy="CY" r="26"
          fill="color-mix(in srgb, var(--theme-bg, #0f172a) 90%, transparent)"
          stroke="var(--theme-accent, #3b82f6)" stroke-width="2" />
        <path :d="`M${CX - 9} ${CY - 7} h18 v5 h-18 z M${CX - 9} ${CY - 1} h18 v5 h-18 z M${CX - 9} ${CY + 5} h18 v5 h-18 z`"
          fill="var(--theme-accent, #3b82f6)" opacity=".85" />
        <text :x="CX" :y="CY + 44" text-anchor="middle" class="topo-label self-label">{{ selfName }}</text>
        <text :x="CX" :y="CY + 57" text-anchor="middle" class="topo-rel">本机</text>
      </g>

      <!-- ⑥ 外围节点：圆内首字 + 名字 + 相对时间 -->
      <g v-for="n in nodes" :key="n.nodeId" class="topo-node"
        @click="emit('pick', n.nodeId)"
        @mouseenter="hover = n" @mouseleave="hover = null">
        <circle :cx="n.x" :cy="n.y" r="17" stroke-width="2"
          :stroke="colorOf(n.status)"
          fill="color-mix(in srgb, var(--theme-bg, #0f172a) 92%, transparent)" />
        <circle :cx="n.x" :cy="n.y - 17" r="3.5" :fill="colorOf(n.status)" />
        <text :x="n.x" :y="n.y + 4.5" text-anchor="middle" class="topo-initial">{{ n.initial }}</text>
        <text :x="n.x" :y="n.y + 33" text-anchor="middle" class="topo-label">{{ n.label }}</text>
        <text :x="n.x" :y="n.y + 45" text-anchor="middle" class="topo-rel">
          {{ n.status === 'offline' ? '失联' : relTime(n.lastSyncAt) }}
        </text>
      </g>

      <text v-if="!nodes.length" :x="CX" :y="CY + 84" text-anchor="middle" class="topo-empty">
        还没有其他设备加入
      </text>
    </svg>

    <!-- ⑦ 内置浮条 -->
    <div class="topo-tip" :class="{ show: !!hoverText }">{{ hoverText || '悬停节点查看地址与同步时间' }}</div>

    <!-- ⑧ 图例收进角落 -->
    <div class="topo-legend">
      <span><i class="dot active"></i>在线</span>
      <span><i class="dot offline"></i>离线</span>
      <span v-if="revokedCount"><i class="dot revoked"></i>已踢出 {{ revokedCount }}</span>
    </div>
  </div>
</template>

<style scoped>
/* ⑧ 卡片式容器 */
.topo-card {
  position: relative;
  padding: 10px 12px 6px; border-radius: 14px;
  background: color-mix(in srgb, var(--theme-color) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 8%, transparent);
}
.topo-svg { width: 100%; height: auto; display: block; overflow: visible; color: var(--theme-color); }
.topo-node { cursor: pointer; }
.topo-node circle { transition: stroke-width .14s ease; }
.topo-node:hover circle:first-of-type { stroke-width: 3; }
.topo-self { cursor: default; }
.topo-initial { font-size: 12px; font-weight: 700; fill: var(--theme-color); opacity: .8; }
.topo-label { font-size: 10.5px; fill: var(--theme-color); opacity: .85; }
.self-label { font-size: 11.5px; font-weight: 600; opacity: .95; }
.topo-rel { font-size: 9px; fill: var(--theme-color); opacity: .42; }
.topo-empty { font-size: 11px; fill: var(--theme-color); opacity: .4; }

/* ③ 在线连线的流动虚线 */
.topo-flow { animation: topo-dash 1.6s linear infinite; }
@keyframes topo-dash { to { stroke-dashoffset: -20; } }

/* ② 本机呼吸环 */
.topo-breathe { animation: topo-breathe 3.2s ease-in-out infinite; }
@keyframes topo-breathe { 0%, 100% { r: 32; opacity: .18; } 50% { r: 35; opacity: .45; } }

@media (prefers-reduced-motion: reduce) {
  .topo-flow, .topo-breathe { animation: none; }
}

/* ⑦ 浮条 */
.topo-tip {
  margin-top: 4px; text-align: center; font-size: 10.5px;
  color: var(--theme-color); opacity: .42;
  min-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: opacity .16s ease;
}
.topo-tip.show { opacity: .72; }

.topo-legend { display: flex; gap: 12px; justify-content: center; font-size: 10px; opacity: .45; padding-bottom: 2px; }
.topo-legend .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
.topo-legend .dot.active { background: #10b981; }
.topo-legend .dot.offline { background: #f59e0b; }
.topo-legend .dot.revoked { background: #ef4444; }
</style>
