<script setup>
/**
 * 自定义下拉框（v3.5.5）
 * ------------------------------------------------------------------
 * 为什么不用原生 <select>：
 *  - appearance:none 能改"选择框"的圆角，但**点开后的选项面板是浏览器绘制的**，
 *    圆角/背景/阴影全都不受 CSS 控制，所以永远"看起来是方的"。
 *  - 原生 select 的 option 在部分平台还会强制白底黑字，跟主题打架。
 * 所以这里自己画一个：触发器 + 绝对定位面板，完全跟随设计系统。
 *
 * 用法：<SelectBox v-model="x" :options="[...]" placeholder="请选择" />
 * 选项可传字符串数组，或 { label, value } 数组。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  // 不能用 null 作为 type（Vue 会报 Invalid prop type），空值交给 default
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);

const open = ref(false);
const root = ref(null);

const normalized = computed(() => (props.options || []).map((o) => (
  typeof o === 'object' && o !== null ? { label: String(o.label ?? o.value ?? ''), value: o.value } : { label: String(o), value: o }
)));

const current = computed(() => normalized.value.find((o) => o.value === props.modelValue));

const pick = (opt) => {
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  open.value = false;
};

const onDocClick = (e) => {
  if (!open.value) return;
  if (root.value && !root.value.contains(e.target)) open.value = false;
};
const onKey = (e) => {
  if (e.key === 'Escape') { open.value = false; return; }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    open.value = !open.value;
    return;
  }
  if (!open.value) return;
  const idx = normalized.value.findIndex((o) => o.value === props.modelValue);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = normalized.value[Math.min(normalized.value.length - 1, idx + 1)];
    if (next) pick(next);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = normalized.value[Math.max(0, idx - 1)];
    if (prev) pick(prev);
  }
};

onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div
    ref="root"
    class="sb"
    :class="{ open, disabled }"
    tabindex="0"
    @keydown="onKey"
    @click="!disabled && (open = !open)"
  >
    <div class="sb-value" :class="{ placeholder: !current }">
      {{ current ? current.label : placeholder }}
    </div>
    <AppIcon icon="mdi:chevron-down" class="sb-arrow" />

    <transition name="sb-fade">
      <div v-if="open" class="sb-panel">
        <div
          v-for="opt in normalized" :key="String(opt.value)"
          class="sb-option"
          :class="{ active: opt.value === modelValue }"
          @click.stop="pick(opt)"
        >
          <span>{{ opt.label }}</span>
          <AppIcon v-if="opt.value === modelValue" icon="mdi:check" class="sb-check" />
        </div>
        <div v-if="!normalized.length" class="sb-empty">没有可选项</div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.sb {
  position: relative;
  display: flex; align-items: center;
  width: 100%; box-sizing: border-box;
  min-height: 38px; padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--theme-color) 18%, transparent);
  background: color-mix(in srgb, var(--theme-color) 8%, transparent);
  color: var(--theme-color);
  font-size: 13px;
  cursor: pointer;
  outline: none;
  transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
  user-select: none;
}
.sb:hover { border-color: color-mix(in srgb, var(--theme-color) 28%, transparent); background: color-mix(in srgb, var(--theme-color) 11%, transparent); }
.sb:focus-visible, .sb.open {
  border-color: var(--theme-accent, #3b82f6);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-accent, #3b82f6) 18%, transparent);
}
.sb.disabled { opacity: .5; cursor: not-allowed; }

.sb-value { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-value.placeholder { color: color-mix(in srgb, var(--theme-color) 40%, transparent); }
.sb-arrow { font-size: 16px; opacity: .5; flex-shrink: 0; margin-left: 6px; transition: transform .16s ease; }
.sb.open .sb-arrow { transform: rotate(180deg); opacity: .8; }

/* 面板：自己画，所以圆角/阴影/主题全都可控 */
.sb-panel {
  position: absolute; z-index: 60;
  left: 0; right: 0; top: calc(100% + 6px);
  max-height: 240px; overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 96%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 16%, transparent);
  box-shadow: 0 16px 40px -8px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .25);
  backdrop-filter: blur(12px);
}
.sb-option {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 8px;
  font-size: 13px; cursor: pointer;
  transition: background .12s ease;
}
.sb-option:hover { background: color-mix(in srgb, var(--theme-color) 9%, transparent); }
.sb-option.active { background: color-mix(in srgb, var(--theme-accent, #3b82f6) 18%, transparent); color: var(--theme-color); font-weight: 500; }
.sb-check { margin-left: auto; font-size: 15px; color: var(--theme-accent, #3b82f6); }
.sb-empty { padding: 10px; font-size: 12px; opacity: .5; text-align: center; }

.sb-fade-enter-active, .sb-fade-leave-active { transition: opacity .12s ease, transform .12s ease; }
.sb-fade-enter-from, .sb-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
