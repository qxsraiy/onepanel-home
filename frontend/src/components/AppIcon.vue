<script setup>
/**
 * 图标组件：本地优先 + 在线兜底
 *  - 内置的界面图标全部来自打包进项目的 MDI 子集（src/assets/icons-mdi.json），
 *    内网 / 无外网环境也能正常显示；
 *  - 用户自定义的图标名（如 logos:vue）不在本地集合里时，回退到 @iconify/vue 的在线加载。
 */
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import iconSet from '../assets/icons-mdi.json'

const props = defineProps({
  icon: { type: String, default: '' },
  size: { type: [String, Number], default: '' },
})

const localData = computed(() => {
  const name = (props.icon || '').trim()
  if (!name.startsWith(`${iconSet.prefix}:`)) return null
  const key = name.slice(iconSet.prefix.length + 1)
  const direct = iconSet.icons && iconSet.icons[key]
  if (direct) return direct
  const alias = iconSet.aliases && iconSet.aliases[key]
  if (alias && alias.parent && iconSet.icons[alias.parent]) return iconSet.icons[alias.parent]
  return null
})

const viewBox = computed(() => `0 0 ${localData.value?.width || 24} ${localData.value?.height || 24}`)
const sizeStyle = computed(() => {
  if (!props.size) return null
  const value = typeof props.size === 'number' ? `${props.size}px` : props.size
  return { width: value, height: value }
})
</script>

<template>
  <svg
    v-if="localData"
    class="app-svg-icon"
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="viewBox"
    :style="sizeStyle"
    fill="currentColor"
    aria-hidden="true"
    v-html="localData.body"
  />
  <Icon v-else :icon="icon || 'mdi:web'" :style="sizeStyle" />
</template>

<style scoped>
.app-svg-icon {
  width: 1em;
  height: 1em;
  display: inline-block;
  vertical-align: -0.125em;
  flex-shrink: 0;
}
</style>
