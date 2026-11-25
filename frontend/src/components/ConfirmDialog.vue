<script setup>
/**
 * 统一二次确认弹窗（v3.7.1）
 * ------------------------------------------------------------------
 * 替代浏览器原生 confirm()：白底黑字的系统弹窗会破坏暗色磨砂的沉浸感，
 * 而且在移动端样式不可控。这里用设计系统的玻璃面板 + 进场动画。
 *
 * 用法：
 *   <ConfirmDialog
 *     v-model:open="confirmState.open"
 *     title="删除卡片"
 *     message="确定删除 [NAS] 吗？"
 *     danger
 *     @confirm="doDelete"
 *   />
 * 或者用 useConfirm() 组合式（见 App.vue 的 askConfirm）。
 */
import { computed, ref, watch, nextTick } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
});
const emit = defineEmits(['update:open', 'confirm', 'cancel']);

function close() { emit('update:open', false); emit('cancel'); }
function ok() { emit('update:open', false); emit('confirm'); }

const rootEl = ref(null)
// 打开时自动聚焦，让 Enter/Esc 生效
watch(() => props.open, async (v) => {
  if (!v) return
  await nextTick()
  if (rootEl.value && rootEl.value.focus) rootEl.value.focus()
})

const iconName = computed(() => (props.danger ? 'mdi:alert-outline' : 'mdi:help-circle-outline'));
</script>

<template>
  <div v-if="open" class="confirm-overlay" tabindex="-1" ref="rootEl" @click.self="close" @keydown.enter.stop.prevent="ok" @keydown.esc.stop.prevent="close">
    <div class="confirm-card" :class="{ danger }">
      <div class="confirm-head">
        <AppIcon :icon="iconName" class="confirm-icon" />
        <span>{{ title }}</span>
      </div>
      <p class="confirm-msg">{{ message }}</p>
      <div class="confirm-actions">
        <button class="btn-cancel" @click="close">{{ cancelText }}</button>
        <button class="btn-primary" :class="{ 'is-danger': danger }" @click="ok">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-overlay {
  position: fixed; inset: 0; z-index: 11000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .38);
  backdrop-filter: blur(4px);
  animation: cf-fade .14s ease;
}
.confirm-card {
  width: min(400px, calc(100vw - 40px));
  padding: 20px 22px 18px; border-radius: 18px;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 94%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent);
  color: var(--theme-color);
  box-shadow: 0 28px 72px -16px rgba(0, 0, 0, .6);
  animation: cf-pop .18s cubic-bezier(.16, 1, .3, 1);
}
.confirm-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.confirm-icon { font-size: 19px; opacity: .85; }
.confirm-card.danger .confirm-icon { color: #f87171; }
.confirm-msg { margin: 0 0 18px; font-size: 13px; line-height: 1.7; opacity: .75; white-space: pre-wrap; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn-primary.is-danger { background: #ef4444; box-shadow: 0 2px 12px -2px rgba(239, 68, 68, .55); }
.btn-primary.is-danger:hover { filter: brightness(1.06); }
@keyframes cf-pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes cf-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
