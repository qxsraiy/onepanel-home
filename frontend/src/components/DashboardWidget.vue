<script setup>
/**
 * 桌面小组件（v2.4.0）
 * ------------------------------------------------------------------
 * 纯展示块，本身不发请求：数据由 App.vue 统一轮询后透传，避免每张卡各开一个计时器。
 *  - system：CPU / 内存 / 磁盘三条迷你进度条 + 面板运行时长
 *  - clock ：本地时间（秒级跳动）+ 日期 + 星期
 */
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  item: { type: Object, required: true },
  stats: { type: Object, default: null },
  statsError: { type: Boolean, default: false },
  hasMemo: { type: Boolean, default: false },
})

const pad = (n) => String(n).padStart(2, '0')

const widgetIcon = computed(() => {
  if (props.item.widgetType === 'clock') return 'mdi:clock-outline'
  if (props.item.widgetType === 'weather') return 'mdi:weather-partly-cloudy'
  return 'mdi:view-dashboard-outline'
})

// ---- 天气（v2.5.0）：后端代理 wttr.in，卡片自己 15 分钟取一次，服务端还有 10 分钟缓存 ----
const weather = ref(null)
const weatherError = ref(false)
let weatherTimer = null
const weatherCity = computed(() => {
  try {
    const cfg = JSON.parse(props.item.widgetConfig || '{}')
    return String(cfg.city || '上海').trim() || '上海'
  } catch {
    return '上海'
  }
})
const fetchingWeather = ref(false)
const fetchWeather = async (force = false) => {
  if (props.item.widgetType !== 'weather') return
  fetchingWeather.value = true
  try {
    const params = { city: weatherCity.value }
    if (force === true) params.refresh = 1 // 手动刷新穿透服务端缓存
    const { data } = await axios.get('/api/widgets/weather', { params })
    weather.value = data
    weatherError.value = false
  } catch (e) {
    weatherError.value = true
    weatherFailure.value = e.response?.data?.error || '天气服务连不上'
  } finally {
    fetchingWeather.value = false
  }
}
const weatherFailure = ref('')
// 观测时间直接来自接口（如 2026-11-17T13:45），只留 HH:mm，让人能确认数据是新的
const observedText = computed(() => {
  const raw = String(weather.value?.observedAt || '')
  const m = raw.match(/T(\d{2}:\d{2})/)
  return m ? m[1] : ''
})

// ---- 时钟 ----
const now = ref(new Date())
let clockTimer = null
onMounted(() => {
  if (props.item.widgetType === 'clock') {
    clockTimer = setInterval(() => { now.value = new Date() }, 1000)
  } else if (props.item.widgetType === 'weather') {
    fetchWeather()
    weatherTimer = setInterval(fetchWeather, 5 * 60 * 1000)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
})
const onVisibilityChange = () => {
  if (props.item.widgetType === 'weather' && document.visibilityState === 'visible') fetchWeather()
}
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  if (weatherTimer) clearInterval(weatherTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
// 编辑里改了城市就立刻重取
watch(() => props.item.widgetConfig, () => { if (props.item.widgetType === 'weather') fetchWeather() })

const clockTime = computed(() => `${pad(now.value.getHours())}:${pad(now.value.getMinutes())}:${pad(now.value.getSeconds())}`)
const clockDate = computed(() => `${now.value.getFullYear()}-${pad(now.value.getMonth() + 1)}-${pad(now.value.getDate())}`)
const weekText = computed(() => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.value.getDay()])
// 当前这一分钟走到的百分比，给时间卡做一条"秒进度"
const secondPercent = computed(() => (now.value.getSeconds() / 60) * 100)

// ---- 系统状态 ----
const levelClass = (p) => {
  const v = Number(p)
  if (!Number.isFinite(v)) return 'ok'
  if (v >= 90) return 'danger'
  if (v >= 70) return 'warn'
  return 'ok'
}
const bars = computed(() => {
  const s = props.stats
  if (!s) return []
  const mk = (key, raw) => {
    // null/undefined 不能被当成 0（Number(null) === 0，这是上一个大坑）
    const valid = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw))
    return { key, percent: valid ? Math.round(Number(raw)) : 0, valid }
  }
  // valid=false 时界面显示 "--"，而不是一条看不懂的空条
  const list = [mk('CPU', s.cpu?.usage), mk('内存', s.mem?.percent)]
  if (s.disk) list.push(mk('磁盘', s.disk.percent))
  return list
})
const formatUptime = (seconds) => {
  let s = Math.max(0, Math.floor(Number(seconds) || 0))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  if (d) return `${d}天${h}小时`
  if (h) return `${h}小时${m}分`
  return `${m}分${s % 60}秒`
}
</script>

<template>
  <div class="dash-widget" :class="[`type-${item.widgetType}`, { 'is-hidden-card': item.isHidden }]">
    <div class="dw-head">
      <AppIcon :icon="widgetIcon" class="dw-icon" />
      <span class="dw-name">{{ item.name }}</span>
      <AppIcon v-if="hasMemo" icon="mdi:note-text-outline" class="dw-memo" title="有备忘录" />
      <button
        v-if="item.widgetType === 'weather'"
        class="dw-refresh" :class="{ spinning: fetchingWeather }"
        title="立即刷新天气"
        @click.stop="fetchWeather(true)"
      >
        <AppIcon icon="mdi:refresh" />
      </button>
    </div>

    <div class="dw-body">
      <!-- 系统状态 -->
      <template v-if="item.widgetType === 'system'">
        <div v-if="!stats" class="dw-empty">{{ statsError ? '后端读取失败' : '读取中…' }}</div>
        <template v-else>
          <div v-for="b in bars" :key="b.key" class="dw-bar-row" :title="b.key + ' ' + (b.valid ? b.percent + '%' : '读取失败')">
            <span class="dw-bar-label">{{ b.key }}</span>
            <div class="dw-bar">
              <i :class="levelClass(b.percent)" :style="{ width: b.valid ? Math.min(100, Math.max(0, b.percent)) + '%' : '0%' }"></i>
            </div>
            <span class="dw-bar-value">{{ b.valid ? b.percent + '%' : '--' }}</span>
          </div>
          <div class="dw-foot">
            <span>{{ stats.host?.hostname || '本机' }}</span>
            <span>面板已跑 {{ formatUptime(stats.uptime?.process) }}</span>
          </div>
        </template>
      </template>

      <!-- 天气 -->
      <template v-else-if="item.widgetType === 'weather'">
        <div v-if="weatherError" class="dw-empty">{{ weatherFailure || '天气拿不到' }}</div>
        <template v-else-if="weather">
          <div class="dw-weather-main">
            <span class="dw-weather-emoji">{{ weather.emoji }}</span>
            <span class="dw-temp">{{ Number(weather.temp).toFixed(1).replace(/\.0$/, '') }}°</span>
            <span class="dw-weather-desc">{{ weather.desc }}</span>
          </div>
          <div class="dw-weather-meta">
            体感 {{ Number(weather.feelsLike).toFixed(1).replace(/\.0$/, '') }}° · 湿度 {{ weather.humidity }}% · 风 {{ weather.wind }} km/h
          </div>
          <div class="dw-weather-meta" v-if="weather.max !== undefined && weather.max !== null">
            今日 {{ Number(weather.min).toFixed(0) }}° ~ {{ Number(weather.max).toFixed(0) }}°
          </div>
          <div class="dw-foot">
            <span>{{ weather.city }}<template v-if="weather.region"> · {{ weather.region }}</template></span>
            <span v-if="observedText" :title="`数据来源：${weather.source || 'open-meteo'}，观测时间 ${weather.observedAt}`">{{ observedText }} 观测</span>
          </div>
        </template>
        <div v-else class="dw-empty">读取中…</div>
      </template>

      <!-- 时钟 -->
      <template v-else-if="item.widgetType === 'clock'">
        <div class="dw-time">{{ clockTime }}</div>
        <div class="dw-clock-meta">
          <span>{{ clockDate }}</span>
          <span class="dw-week">{{ weekText }}</span>
        </div>
        <div class="dw-seconds"><i :class="{ 'no-transition': secondPercent === 0 }" :style="{ width: secondPercent + '%' }"></i></div>
      </template>

      <div v-else class="dw-empty">未知小组件类型</div>
    </div>
  </div>
</template>

<style scoped>
.dash-widget {
  height: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 16px;
  display: flex; flex-direction: column; justify-content: center; gap: 8px; overflow: hidden; min-height: 0;
  cursor: default; border: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent);
  transition: transform .2s cubic-bezier(.16,1,.3,1), border-color .2s ease, box-shadow .2s cubic-bezier(.16,1,.3,1);
}
.dash-widget:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--theme-color) 18%, transparent);
  box-shadow:
    0 0 18px -2px color-mix(in srgb, var(--theme-accent, #3b82f6) 30%, transparent),
    0 0 1px 1px color-mix(in srgb, var(--theme-color) 12%, transparent) inset,
    0 12px 28px -8px rgba(0,0,0,.45);
}
.dw-head { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .75; }
.dw-icon { font-size: 15px; }
.dw-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dw-memo { font-size: 13px; color: #fbbf24; }
.dw-refresh {
  margin-left: auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: color-mix(in srgb, var(--theme-color) 14%, transparent); color: inherit; cursor: pointer; font-size: 13px;
  display: flex; align-items: center; justify-content: center; transition: background .2s;
}
.dw-refresh:hover { background: color-mix(in srgb, var(--theme-color) 28%, transparent); }
.dw-refresh.spinning .app-svg-icon { animation: dw-spin .9s linear infinite; }
@keyframes dw-spin { to { transform: rotate(360deg); } }
.dw-empty { font-size: 12px; opacity: .6; margin: auto 0; }

.dw-bar-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; flex-shrink: 0; line-height: 1.2; }
.dw-bar-label { width: 34px; opacity: 1; flex-shrink: 0; white-space: nowrap; font-weight: 600; font-size: 11px; letter-spacing: .2px; }
.dw-bar { flex: 1; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--theme-color) 22%, transparent); overflow: hidden; }
.dw-bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #22c55e, #16a34a); transition: width .5s ease; }
.dw-bar i.warn { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
.dw-bar i.danger { background: linear-gradient(90deg, #f87171, #ef4444); }
.dw-bar-value { width: 36px; text-align: right; opacity: 1; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 11px; }
/* 内容块垂直居中，别让两行内容之间空一大片 */
.dw-body { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 9px; min-height: 0; }
.dw-body .dw-empty { margin: 0; }
.dw-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; opacity: .5; margin-top: 0; flex-shrink: 0; }

/* 天气 */
.dw-weather-main { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dw-weather-emoji { font-size: 24px; line-height: 1; }
.dw-temp { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.dw-weather-desc { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dw-weather-meta { font-size: 11px; opacity: .62; }
.dw-clock-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: .7; }
.dw-week { padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--theme-color) 16%, transparent); font-size: 11px; }
.dw-seconds { height: 3px; border-radius: 999px; background: color-mix(in srgb, var(--theme-color) 16%, transparent); overflow: hidden; }
.dw-seconds i.no-transition { transition: none !important; }
.dw-seconds i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38bdf8, #8b5cf6); transition: width .9s linear; }

.dw-time { font-size: 38px; font-weight: 700; letter-spacing: 1px; font-variant-numeric: tabular-nums; line-height: 1.05; text-shadow: 0 2px 10px rgba(0,0,0,.25); }
</style>
