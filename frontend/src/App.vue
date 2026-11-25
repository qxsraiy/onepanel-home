<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import axios from 'axios'
import SettingsPanel from './components/SettingsPanel.vue'
import AppIcon from './components/AppIcon.vue'
import DashboardWidget from './components/DashboardWidget.vue'
import SelectBox from './components/SelectBox.vue'
import SetupWizard from './components/SetupWizard.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import PasskeyPanel from './components/PasskeyPanel.vue'
import {
  readJSON, writeJSON, writeText, hexToRgba, safeHex,
  clampMenuPosition, sanitizeFooter, isMobileWidth, toast, copyToClipboard,
} from './utils/common'
import { applyThemeToBody } from './utils/theme'
import { packLayout, arrangeLayout, resolveSlot, spanOf, SIZE_PRESETS } from './utils/grid'
import { saveItems as saveOfflineItems, loadItems as loadOfflineItems } from './utils/offlineCache'

// ============================================================
// 🚀 0. 小环境
// ============================================================
const isMobile = ref(isMobileWidth())
const onViewportResize = () => {
  isMobile.value = isMobileWidth()
  // 列数变了要重新拆一遍冲突，卡片才不会因为变窄而叠在一起
  updateGridCols?.()
}

// ============================================================
// 🔐 1. 登录 / 会话
// ============================================================
const token = ref('')  // 【v3.9.0】不再从 localStorage 读，改用 Cookie 自查（见 onMounted）
const isLoggedIn = ref(!!token.value)
// 新设备引导：未登录 + 全新节点 + 没选过"单独使用"时显示
const showWizard = ref(false)
// 打开设置时定位到哪个 Tab（全局搜索快捷操作用）
const settingsTab = ref('')
// 是否选过"单独使用"（登录页据此显示"重新选择"入口）
const setupSkipped = ref(false)
const isFirstLogin = ref(false)
const tempToken = ref('')
const loginForm = ref({ username: '', password: '' })
const changePwdForm = ref({ newUsername: 'admin', newPassword: '' })

const temp2FAToken = ref('')
const show2FAInputRow = ref(false)
const totpCode = ref('')

// ---- 自动故障转移（v3.9.4）----
// 连续 N 次网络错误（不是 4xx/5xx，是根本连不上）就认为当前节点失联
const nodeOffline = ref(false)
let netFailCount = 0
const NODE_FAIL_THRESHOLD = 3

// 401/403 = 会话失效才登出；"业务校验失败"（如关闭 2FA 时密码输错）不允许登出
// 注意：v2 后端业务校验失败统一返回 400；这里仍保留白名单双保险
const AUTH_ENDPOINTS = ['/api/login', '/api/2fa/disable', '/api/config/account', '/api/transfer/export']
// 【v3.9.0】登录态改走 HttpOnly Cookie（跨子域/跨端口共享）
axios.defaults.withCredentials = true
axios.interceptors.request.use((config) => {
  if (token.value) config.headers.Authorization = `Bearer ${token.value}`
  return config
})
axios.interceptors.response.use((res) => {
  netFailCount = 0
  if (nodeOffline.value) nodeOffline.value = false
  return res
}, (error) => {
  // 没有 response = 网络层失败（节点挂了 / DNS / 连接被拒）
  if (!error.response) {
    netFailCount += 1
    if (netFailCount >= NODE_FAIL_THRESHOLD) nodeOffline.value = true
  } else {
    netFailCount = 0
  }
  const status = error.response?.status
  const url = error.config?.url || ''
  const isAuthCheck = AUTH_ENDPOINTS.some((p) => url.startsWith(p))
  if ((status === 401 || status === 403) && !isAuthCheck) {
    doLogout(true)
  }
  return Promise.reject(error)
})

const saveToken = (t) => { token.value = t }  // Cookie 由后端 Set-Cookie 写入，前端只留内存态

// Passkey 登录成功：Cookie 已由后端写入，这里只要切状态
// ---- 全局 UI 偏好（存服务端，换节点一致）----
const fetchUiPrefs = async () => {
  try {
    const { data } = await axios.get('/api/config/ui')
    const ui = data.ui || {}
    if (ui.searchEngine) {
      searchEngine.value = ui.searchEngine
      localStorage.setItem('searchEngine', ui.searchEngine)   // 本地只做加速缓存
    }
    if (ui.showHidden !== undefined) showHidden.value = !!ui.showHidden
  } catch { /* 未登录或列未就绪，忽略 */ }
}
const saveUiPref = async (patch) => {
  try { await axios.put('/api/config/ui', patch) } catch { /* 忽略 */ }
}

const onPasskeyLoggedIn = (r) => {
  token.value = r?.token || ''
  isLoggedIn.value = true
  toast('欢迎回来（通行密钥）', 'success')
}

const handleLogin = async () => {
  if (!loginForm.value.username || !loginForm.value.password) return toast('请输入账号和密码', 'warn')
  try {
    const res = await axios.post('/api/login', loginForm.value)

    // 首次登录：后端不看用户名，前端也不再看用户名（原逻辑只对 admin 生效，会撞死路）
    if (res.data.isFirstLogin) {
      isFirstLogin.value = true
      tempToken.value = res.data.token
      return
    }
    if (res.data.status === 'NEED_2FA') {
      temp2FAToken.value = res.data.tempToken
      show2FAInputRow.value = true
      return
    }
    saveToken(res.data.token)
    isLoggedIn.value = true
    afterLogin()
  } catch (error) {
    toast(error.response?.data?.error || '登录失败', 'error')
  }
}

const handleVerify2FA = async () => {
  if (!totpCode.value || totpCode.value.length !== 6) return toast('请输入 6 位动态验证码', 'warn')
  try {
    const res = await axios.post('/api/login/verify-2fa', { code: totpCode.value, tempToken: temp2FAToken.value })
    saveToken(res.data.token)
    isLoggedIn.value = true
    show2FAInputRow.value = false
    totpCode.value = ''
    afterLogin()
  } catch (error) {
    toast(error.response?.data?.error || '验证码错误或已失效，请重试', 'error')
  }
}

const handleChangePassword = async () => {
  if (!changePwdForm.value.newUsername?.trim()) return toast('请设置新账号', 'warn')
  if (!changePwdForm.value.newPassword || changePwdForm.value.newPassword.length < 5) return toast('新密码至少 5 位', 'warn')
  try {
    const res = await axios.post('/api/change-password', { ...changePwdForm.value, token: tempToken.value })
    saveToken(res.data.token)
    isFirstLogin.value = false
    isLoggedIn.value = true
    afterLogin()
  } catch (error) {
    toast(error.response?.data?.error || '改密失败', 'error')
  }
}

function doLogout(silent = false) {
  clearRuntimeState()
  isLoggedIn.value = false
  token.value = ''
  axios.post('/api/auth/logout').catch(() => {})
  if (!silent) toast('已退出登录')
}

const logout = () => doLogout(false)

function clearRuntimeState() {
  stopSystemPolling?.()
  items.value = []
  windows.value = []
  deviceStatuses.value = {}
  contextMenu.value = { visible: false, x: 0, y: 0, item: null }
  showSettings.value = false
  showModal.value = false
  stopPolling()
}

// 登录成功后统一启动数据流（避免登录前启动、登录后不启动）
// ---- 🔒 数据保险库：密钥由登录密码包裹，服务重启后需解锁一次 ----
const vaultLocked = ref(false)
const vaultPassword = ref('')
const vaultUnlocking = ref(false)

const checkVault = async () => {
  if (!isLoggedIn.value) return
  try {
    const { data } = await axios.get('/api/vault/status')
    vaultLocked.value = !!data.locked
  } catch {
    vaultLocked.value = false
  }
}
const unlockVault = async () => {
  if (!vaultPassword.value) return toast('请输入管理员密码', 'warn')
  vaultUnlocking.value = true
  try {
    await axios.post('/api/vault/unlock', { password: vaultPassword.value })
    vaultLocked.value = false
    vaultPassword.value = ''
    toast('保险库已解锁，备忘录可以正常读写', 'success')
    await fetchItems()
  } catch (e) {
    toast(e.response?.data?.error || '解锁失败', 'error')
  } finally {
    vaultUnlocking.value = false
  }
}

function afterLogin() {
  startPolling()
  checkVault()
  fetchItems()
  syncThemeFromCloud()
  handlePendingExtension()
}

// ============================================================
// 🎨 2. 全局设置 / 主题
// ============================================================
const defaultGlobalSettings = {
  siteTitle: '个人数字枢纽',
  siteIcon: 'mdi:home-circle',
  bgImage: '',
  cardBgColor: '#0f172a',
  cardBgOpacity: 0.4,
  groups: ['书签', '服务器', 'NAS', '探针'],
  footerText: 'Powered by Vue3 & Node.js',
}
const savedSettings = readJSON('globalSettings', {})
if (!Array.isArray(savedSettings.groups) || savedSettings.groups.length === 0) {
  savedSettings.groups = defaultGlobalSettings.groups
}
const globalSettings = ref({ ...defaultGlobalSettings, ...savedSettings })
const showSettings = ref(false)

const handleSaveSettings = (newSettings, closePanel = true) => {
  globalSettings.value = newSettings
  syncThemeCookie(newSettings)
  // 顺便把全局 UI 偏好拉下来（换节点也一致）
  fetchUiPrefs()
  // localStorage 只缓存轻量设置：图片走 DB，避免配额溢出把弹窗卡死
  const { bgImage, siteIcon, ...light } = globalSettings.value
  writeJSON('globalSettings', light)
  if (closePanel) showSettings.value = false
  applyThemeToBody(newSettings)
}

/** 从云端同步主题（默认全量漫游，无需开关） */
async function syncThemeFromCloud() {
  if (!isLoggedIn.value) return
  try {
    const res = await axios.get('/api/config/theme')
    const d = res.data || {}

    if (d.siteIcon) globalSettings.value.siteIcon = d.siteIcon
    if (d.bgImage) globalSettings.value.bgImage = d.bgImage
    if (d.siteTitle) globalSettings.value.siteTitle = d.siteTitle
    if (safeHex(d.themeBg, null)) globalSettings.value.themeBg = safeHex(d.themeBg, globalSettings.value.themeBg)
    if (safeHex(d.themeColor, null)) globalSettings.value.themeColor = safeHex(d.themeColor, globalSettings.value.themeColor)
    if (d.footerText !== undefined && d.footerText !== null) globalSettings.value.footerText = d.footerText
    if (Array.isArray(d.groups) && d.groups.length) globalSettings.value.groups = d.groups
    if (d.cardBgColor !== undefined && d.cardBgColor !== null) globalSettings.value.cardBgColor = d.cardBgColor
    if (d.cardBgOpacity !== undefined && d.cardBgOpacity !== null) globalSettings.value.cardBgOpacity = d.cardBgOpacity

    const { bgImage, siteIcon, ...light } = globalSettings.value
    writeJSON('globalSettings', light)
    if (safeHex(d.themeBg, null)) writeText('themeBg', safeHex(d.themeBg, '#0f172a'))
    if (safeHex(d.themeColor, null)) writeText('themeColor', safeHex(d.themeColor, '#f8fafc'))

    applyThemeToBody(globalSettings.value)
  } catch (e) {
    console.warn('云端主题同步失败，继续使用本地缓存', e.message)
  }
}

// ============================================================
// 📦 3. 卡片数据 / 分组 / 状态
// ============================================================
const items = ref([])
const groupedItems = ref({})
const deviceStatuses = ref({})
const FALLBACK_GROUP = '未分组'

// 排序模式（提前声明：构建分组时要判断"排序模式下一并显示隐藏卡"）
const isSortMode = ref(false)
const draggedItem = ref(null)

// 🫥 隐藏卡：默认不上首页；顶栏眼睛按钮 / 快捷键 h / 排序模式可临时显示
const showHidden = ref(false)
const hiddenCount = computed(() => items.value.filter((i) => !!i.isHidden).length)
const revealHidden = computed(() => showHidden.value || isSortMode.value)
const toggleShowHidden = () => {
  showHidden.value = !showHidden.value
  if (showHidden.value && hiddenCount.value > 0) toast(`已显示 ${hiddenCount.value} 张隐藏卡`, 'info')
}

// 引导完成：入网成功就直接进入面板，单独使用就回落到登录页
// 登录页的"重新选择"：撤销单独使用，回到四个入口
// 切到其他节点：回主域名 Worker 重新测速（Cookie 是父域，免登录）
const switchNode = () => {
  const host = location.hostname
  // 去掉最左一级子域，回到父域（cn.xtay.cn -> xtay.cn 的 panel 入口）
  const parts = host.split('.')
  const parent = parts.length > 2 ? parts.slice(1).join('.') : host
  const target = location.protocol + '//panel.' + parent + location.pathname + location.search
  location.href = target
}
const retryCurrent = () => { netFailCount = 0; nodeOffline.value = false; location.reload() }

const backToSetup = async () => {
  try {
    await axios.post('/api/setup/reset-skip');
    setupSkipped.value = false;
    showWizard.value = true;
  } catch (e) {
    toast(e.response?.data?.error || '操作失败', 'error');
  }
}

const onWizardDone = async () => {
  showWizard.value = false
  try {
    const { data } = await axios.get('/api/setup/state')
    showWizard.value = !!data.showWizard
    if (data.items > 0) {
      // 入网成功：老节点的账号已经带过来了，走一次静默探测（不强制登录）
      toast('已加入网络，请用原节点账号密码登录', 'success', 5000)
    }
  } catch { /* 忽略 */ }
}

const fetchItems = async () => {
  try {
    const res = await axios.get('/api/items')
    items.value = Array.isArray(res.data) ? res.data : []
    offlineMode.value = false
    // 后台写离线缓存（只存能公开的元数据，绝不存 memo，见 utils/offlineCache.js）
    saveOfflineItems(items.value, vaultLocked.value)
    fetchMonitorStatus()
  } catch (error) {
    const offline = !error.response
    if (offline) {
      const cached = await loadOfflineItems()
      if (cached && items.value.length === 0) {
        items.value = cached.items
        offlineMode.value = true
        toast('当前连不上节点，显示的是本地缓存（可能不是最新）', 'warn', 5000)
        return
      }
    }
    console.error('❌ 加载卡片失败:', error.response?.data?.error || error.message)
    if (items.value.length === 0) toast(error.response?.data?.error || '加载卡片失败，请检查登录状态', 'error')
  }
}

// 离线模式标记：网络恢复后自动重取
const offlineMode = ref(false)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (offlineMode.value) fetchItems() })
}
const fetchMonitorStatus = async () => {
  if (!isLoggedIn.value) return
  try {
    deviceStatuses.value = (await axios.get('/api/monitor/status')).data || {}
  } catch (e) {
    /* 状态获取失败不打断界面 */
  }
}

const buildGroupedItems = () => {
  const groups = Array.isArray(globalSettings.value.groups) ? globalSettings.value.groups : defaultGlobalSettings.groups
  const map = {}
  groups.forEach((g) => { map[g] = [] })
  map[FALLBACK_GROUP] = []
  items.value.forEach((item) => {
    // 隐藏卡默认不渲染，只在"显示隐藏卡"或排序模式下出现
    if (item.isHidden && !revealHidden.value) return
    const g = item.group && map[item.group] ? item.group : FALLBACK_GROUP
    map[g].push(item)
  })
  // 置顶卡排到分组最前；Array.sort 稳定，其余卡片保持原有顺序
  Object.keys(map).forEach((g) => {
    // 置顶功能已移除（v3.7.2）：不再按 isPinned 排序
  })
  // 兜底分组空时不显示，避免多出一个空分组栏
  if (map[FALLBACK_GROUP].length === 0) delete map[FALLBACK_GROUP]
  groupedItems.value = map
}

watch([items, () => globalSettings.value.groups, showHidden, isSortMode], buildGroupedItems, { deep: true, immediate: true })

const groupOrder = ref([])
watch(groupedItems, (v) => { groupOrder.value = Object.keys(v) }, { immediate: true })

// ============================================================
// 🧲 4. 排序模式（桌面拖拽 + 移动端方向按钮）
// ============================================================
const toggleSortMode = () => { isSortMode.value = !isSortMode.value; closeMenus() }

const GRID_COL = 240
const GRID_ROW = 110

// ---- 网格列数：跟着容器实际宽度算，决定"一行能放几张卡" ----
const gridCols = ref(isMobileWidth() ? 1 : 4)
const updateGridCols = () => {
  const grid = document.querySelector('.icon-grid')
  const width = grid ? grid.clientWidth : 0
  if (width > 0) {
    gridCols.value = Math.max(1, Math.floor((width + 20) / GRID_COL))
    return
  }
  gridCols.value = Math.max(1, Math.floor((window.innerWidth - 80 + 20) / GRID_COL))
}
let gridResizeObserver = null
const observeGridResize = () => {
  if (typeof ResizeObserver === 'undefined') return
  gridResizeObserver = new ResizeObserver(() => updateGridCols())
  const area = document.querySelector('.desktop-area')
  if (area) gridResizeObserver.observe(area)
}

// ---- 卡片实际矩形（span 由"是否锁定内嵌 / 是否小组件"决定）----
const spanOfItem = (item) => spanOf(item)

// ---- 渲染前统一拆冲突：同格的两张卡不会再叠在一起 ----
const layoutPositions = computed(() => {
  const cols = Math.max(1, gridCols.value)
  const positions = new Map()
  for (const list of Object.values(groupedItems.value)) {
    const entries = list.map((item) => {
      const span = spanOfItem(item)
      return { id: item.id, x: item.gridX, y: item.gridY, w: span.w, h: span.h }
    })
    const placed = packLayout(entries, cols)
    for (const [id, pos] of placed) positions.set(id, pos)
  }
  return positions
})

const rectFor = (item) => {
  const span = spanOfItem(item)
  const pos = layoutPositions.value.get(item.id)
  return { x: pos?.x || 1, y: pos?.y || 1, w: span.w, h: span.h }
}

const onDragStart = (e, item) => {
  if (!isSortMode.value) { e.preventDefault(); return }
  draggedItem.value = item
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', String(item.id))
}

const onDrop = async (e, groupName) => {
  if (!draggedItem.value || !isSortMode.value) return
  const grid = e.currentTarget.querySelector('.icon-grid')
  if (!grid) return
  const rect = grid.getBoundingClientRect()

  let dropX = e.clientX - rect.left
  let dropY = e.clientY - rect.top
  dropX = Math.max(0, dropX)
  dropY = Math.max(0, dropY)

  // 按容器实际列数夹取，避免拖到最右/最下边缘产生隐式列/行
  const cols = Math.max(1, Math.floor((grid.clientWidth + 20) / GRID_COL))
  const rows = Math.max(1, Math.floor((grid.clientHeight + 20) / GRID_ROW))
  const spanW = spanOfItem(draggedItem.value).w

  const gridX = Math.min(Math.max(1, Math.floor(dropX / GRID_COL) + 1), Math.max(1, cols - spanW + 1))
  const gridY = Math.min(Math.max(1, Math.floor(dropY / GRID_ROW) + 1), rows)

  await moveItemTo(draggedItem.value, gridX, gridY, groupName)
  draggedItem.value = null
}

const moveItemTo = async (item, gridX, gridY, groupName) => {
  // 落点被别人占了就自动避让到最近的空位，绝不把两张卡叠在一起
  const others = (groupedItems.value[groupName] || []).filter((i) => i.id !== item.id).map((i) => rectFor(i))
  const span = spanOfItem(item)
  const slot = resolveSlot(others, { x: gridX, y: gridY, w: span.w, h: span.h }, gridCols.value)
  if (item.gridX === slot.x && item.gridY === slot.y && item.group === groupName) return
  item.gridX = slot.x
  item.gridY = slot.y
  item.group = groupName
  try {
    await axios.put('/api/items/position', { id: item.id, gridX: slot.x, gridY: slot.y, group: groupName })
  } catch (err) {
    toast('位置保存失败', 'error')
    fetchItems() // 失败回滚为服务端真实状态
  }
}

/** 移动端排序：方向按钮移动卡片 */
const nudgeItem = async (item, dx, dy) => {
  const current = rectFor(item)
  await moveItemTo(item, Math.max(1, current.x + dx), Math.max(1, current.y + dy), item.group)
}

/**
 * 一键整理布局：把每组卡片按顺序排成规整网格。
 * 注意：v3.7.2 起 UI 上不再提供这个按钮（排序模式只留"完成"），
 * 函数保留是因为它还被键盘快捷键/调试用到，删掉会牵连其他逻辑。
 */
const autoLayout = async () => {
  const cols = isMobile.value ? 1 : Math.max(1, gridCols.value)
  const jobs = []
  for (const [groupName, list] of Object.entries(groupedItems.value)) {
    const entries = list.map((item) => {
      const span = spanOfItem(item)
      return { id: item.id, w: span.w, h: span.h }
    })
    const placed = arrangeLayout(entries, cols)
    for (const item of list) {
      const pos = placed.get(item.id)
      if (!pos) continue
      if (item.gridX !== pos.x || item.gridY !== pos.y) {
        jobs.push(axios.put('/api/items/position', { id: item.id, gridX: pos.x, gridY: pos.y, group: groupName }).catch(() => {}))
      }
    }
  }
  if (jobs.length === 0) return toast('布局已经是整齐的', 'info')
  await Promise.all(jobs)
  await fetchItems()
  toast(`已重新排列 ${jobs.length} 张卡片`, 'success')
}

// ---- 旧数据自愈：同一个格子里塞了多张卡时，把后来者写回一个空位 ----
let layoutFixTimer = null
const persistResolvedLayout = async () => {
  if (!isLoggedIn.value || isSortMode.value) return
  const jobs = []
  for (const [groupName, list] of Object.entries(groupedItems.value)) {
    const seen = new Set()
    const duplicated = new Set()
    for (const item of list) {
      if (!item.gridX || !item.gridY) continue
      const key = `${item.gridX}:${item.gridY}`
      if (seen.has(key)) duplicated.add(key)
      seen.add(key)
    }
    if (!duplicated.size) continue
    for (const item of list) {
      if (!duplicated.has(`${item.gridX}:${item.gridY}`)) continue
      const pos = layoutPositions.value.get(item.id)
      if (!pos || (pos.x === item.gridX && pos.y === item.gridY)) continue
      jobs.push({ id: item.id, gridX: pos.x, gridY: pos.y, group: groupName })
    }
  }
  if (!jobs.length) return
  try {
    await Promise.all(jobs.map((job) => axios.put('/api/items/position', job)))
    for (const job of jobs) {
      const item = items.value.find((i) => i.id === job.id)
      if (item) { item.gridX = job.gridX; item.gridY = job.gridY; item.group = job.group }
    }
  } catch {
    /* 写回失败就只保证这一屏不重叠，下次加载再试 */
  }
}
const scheduleLayoutFix = () => {
  clearTimeout(layoutFixTimer)
  layoutFixTimer = setTimeout(persistResolvedLayout, 600)
}
watch(items, () => { if (items.value.length) scheduleLayoutFix() })

// ============================================================
// 🔎 4.5 全局搜索（按 / 呼出，↑↓ 选择，回车打开）
// ============================================================
const showSearch = ref(false)
const searchQuery = ref('')
const searchIndex = ref(0)

const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return items.value.slice(0, 12)
  return items.value
    .filter((item) => !item.isHidden || revealHidden.value)
    .filter((item) => {
      const memo = parseMemo(item.memo)
      const hay = [
        item.name, item.description, item.group,
        ...(item.urls || []).map((u) => `${u.url} ${u.label}`),
        memo.note,
        ...memo.entries.map((e) => e.label),
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
    .slice(0, 12)
})
watch(searchResults, (list) => { if (searchIndex.value >= list.length) searchIndex.value = 0 })

const openSearch = () => {
  showSearch.value = true
  searchQuery.value = ''
  // 无查询时默认选中第一条快捷操作，回车即可执行
  searchIndex.value = 1000
  nextTick(() => document.querySelector('.search-input')?.focus())
}
const QUICK_ACTIONS = [
  { id: 'new', label: '新建书签' },
  { id: 'sync', label: '多节点同步状态' },
  { id: 'lock', label: '锁定保险库' },
  { id: 'shortcuts', label: '快捷键说明' },
]

const runQuickAction = async (id) => {
  closeSearch()
  if (id === 'new') { showModal.value = true; return }
  if (id === 'sync') { settingsTab.value = 'sync'; showSettings.value = true; return }
  if (id === 'shortcuts') { showShortcuts.value = true; return }
  if (id === 'lock') {
    try { await axios.post('/api/vault/lock'); vaultLocked.value = true; toast('保险库已锁定', 'success') }
    catch (e) { toast(e.response?.data?.error || '锁定失败', 'error') }
  }
}

const closeSearch = () => { showSearch.value = false }

const searchEngine = ref(localStorage.getItem('searchEngine') || 'bing')
const SEARCH_ENGINES = {
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=' },
  duck: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
}
const searchEngineName = computed(() => (SEARCH_ENGINES[searchEngine.value] || SEARCH_ENGINES.bing).name)
watch(searchEngine, (v) => { localStorage.setItem('searchEngine', v); saveUiPref({ searchEngine: v }) })
watch(showHidden, (v) => { saveUiPref({ showHidden: v }) })
// 图标库：内置常用图标 + 搜索（零依赖）
const showIconPicker = ref(false)
const iconQuery = ref('')
const ICON_LIBRARY = [
  'mdi:web', 'mdi:server', 'mdi:nas', 'mdi:router-wireless', 'mdi:docker', 'mdi:docker-hub', 'mdi:github', 'mdi:gitlab',
  'mdi:cloud', 'mdi:cloud-outline', 'mdi:database', 'mdi:folder', 'mdi:folder-network', 'mdi:file-document',
  'mdi:monitor-dashboard', 'mdi:television', 'mdi:music', 'mdi:movie', 'mdi:cctv', 'mdi:home-automation',
  'mdi:lightning-bolt', 'mdi:wifi', 'mdi:shield-lock', 'mdi:key-variant', 'mdi:account', 'mdi:email',
  'mdi:calendar', 'mdi:note-text', 'mdi:chart-line', 'mdi:download', 'mdi:upload', 'mdi:tools',
  'mdi:server-network', 'mdi:memory', 'mdi:harddisk', 'mdi:printer', 'mdi:camera', 'mdi:gamepad-variant',
  'mdi:book-open-variant', 'mdi:rss', 'mdi:youtube', 'mdi:telegram', 'mdi:wechat', 'mdi:weather-partly-cloudy',
  'mdi:clock-outline', 'mdi:view-dashboard-outline', 'mdi:google', 'mdi:linux'
]
const filteredIcons = computed(() => {
  const q = iconQuery.value.trim().toLowerCase()
  if (!q) return ICON_LIBRARY
  return ICON_LIBRARY.filter((n) => n.toLowerCase().includes(q))
})
const openIconPicker = () => { showIconPicker.value = true; iconQuery.value = '' }
const pickIcon = (name) => { formData.value.icon = name; showIconPicker.value = false }

const searchOnWeb = () => {
  const q = searchQuery.value.trim()
  if (!q) return
  const eng = SEARCH_ENGINES[searchEngine.value] || SEARCH_ENGINES.bing
  window.open(eng.url + encodeURIComponent(q), '_blank', 'noopener')
}

// 存活历史弹层（批次 2.4）
const uptimeData = ref(null)
const uptimeItem = ref(null)
const openUptime = async (item) => {
  closeMenus()
  uptimeItem.value = item
  uptimeData.value = { loading: true, list: [], availability: null, avgLatency: null }
  try {
    const { data } = await axios.get('/api/monitor/history', { params: { uid: item.uid, limit: 60 } })
    uptimeData.value = { loading: false, ...data }
  } catch (e) {
    uptimeData.value = { loading: false, list: [], availability: null, avgLatency: null, error: e.response?.data?.error || '读取失败' }
  }
}
const closeUptime = () => { uptimeData.value = null; uptimeItem.value = null }
const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN') : '—')

const onSearchKeydown = (e) => {
  // 没输入时 ↑↓ 在"快捷操作"之间走（1000 起），有输入才走卡片结果
  const hasQuery = !!searchQuery.value.trim()
  const quickActive = searchIndex.value >= 1000
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!hasQuery) {
      searchIndex.value = quickActive && searchIndex.value < 1000 + QUICK_ACTIONS.length - 1 ? searchIndex.value + 1 : 1000
    } else {
      searchIndex.value = (searchIndex.value + 1) % Math.max(1, searchResults.value.length)
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!hasQuery) {
      searchIndex.value = quickActive && searchIndex.value > 1000 ? searchIndex.value - 1 : 1000 + QUICK_ACTIONS.length - 1
    } else {
      searchIndex.value = (searchIndex.value - 1 + Math.max(1, searchResults.value.length)) % Math.max(1, searchResults.value.length)
    }
  } else if (e.key === 'Enter') {
    if (!hasQuery && quickActive) {
      const action = QUICK_ACTIONS[searchIndex.value - 1000]
      if (action) runQuickAction(action.id)
      return
    }
    const item = searchResults.value[searchIndex.value]
    if (item) { closeSearch(); openApp(item) }
  }
}
const pickSearchResult = (item, idx) => {
  if (idx === searchIndex.value) { closeSearch(); openApp(item) } else searchIndex.value = idx
}

// ============================================================
// ➕ 5. 新增 / 编辑 / 删除弹窗
// ============================================================
const showModal = ref(false)
const editingId = ref(null)
const emptyForm = () => ({
  name: '', description: '', icon: '', bgColor: '', bgOpacity: globalSettings.value.cardBgOpacity ?? 0.4,
  isMonitored: false, pingUrl: '',
  isHidden: false,
  widgetType: '', widgetConfig: null, weatherCity: '上海', openMethod: 'new_tab',
  group: (globalSettings.value.groups || [])[0] || '书签',
  urls: [{ url: '', label: '主地址', priority: 10 }],
})
const formData = ref(emptyForm())

const openAddModal = () => { editingId.value = null; formData.value = emptyForm(); showModal.value = true }

const handleImageUpload = (event) => {
  const file = event.target.files[0]
  if (!file) return
  if (file.size > 2 * 1024 * 1024) { toast('图片太大了！请选择 2MB 以下的图片', 'warn'); event.target.value = ''; return }
  const reader = new FileReader()
  reader.onload = (e) => { formData.value.icon = e.target.result; event.target.value = '' }
  reader.onerror = () => { toast('读取图片失败', 'error'); event.target.value = '' }
  reader.readAsDataURL(file)
}
const clearIcon = () => { formData.value.icon = '' }

// 自动抓取站点 favicon（后端解析 <link rel=icon>，兜底 /favicon.ico）
const fetchingIcon = ref(false)
const autoFetchIcon = async () => {
  const firstUrl = formData.value.urls?.find((u) => u.url && u.url.trim())?.url
  if (!firstUrl) return toast('请先填写至少一个网址', 'warn')
  fetchingIcon.value = true
  try {
    const { data } = await axios.get('/api/utils/favicon', { params: { url: firstUrl.trim() } })
    if (data.icon) { formData.value.icon = data.icon; toast('图标获取成功', 'success') }
    else toast('未能找到图标', 'warn')
  } catch (e) {
    toast(e.response?.data?.error || '图标抓取失败', 'error')
  } finally {
    fetchingIcon.value = false
  }
}
const addUrlField = () => formData.value.urls.push({ url: '', label: `备用地址${formData.value.urls.length}`, priority: 5 })
const removeUrlField = (index) => formData.value.urls.splice(index, 1)
const formatUrl = (u) => { if (u.url && !/^https?:\/\//i.test(u.url.trim())) u.url = 'http://' + u.url.trim() }

const saveItem = async () => {
  if (!formData.value.name?.trim()) return toast('请填写名称', 'warn')
  if (formData.value.isMonitored && !formData.value.pingUrl?.trim()) return toast('开启监测时必须填写 Ping/TCP 检测地址', 'warn')

  const isWidget = !!formData.value.widgetType
  const validUrls = formData.value.urls.filter((u) => u.url && u.url.trim() !== '')
  for (const u of validUrls) {
    if (!/^https?:\/\/.+/i.test(u.url.trim())) return toast(`网址格式错误：${u.url}`, 'warn')
  }
  if (!isWidget && validUrls.length === 0) return toast('请填写至少一个有效地址', 'warn')

  try {
    const payload = {
      ...formData.value,
      urls: validUrls,
      // 天气城市走 widgetConfig 存 JSON，其它小组件暂时不带参数
      widgetConfig: formData.value.widgetType === 'weather'
        ? JSON.stringify({ city: (formData.value.weatherCity || '').trim() || '上海' })
        : null,
    }
    delete payload.weatherCity
    if (editingId.value) await axios.put(`/api/items/${editingId.value}`, payload)
    else await axios.post('/api/items', payload)
    showModal.value = false
    editingId.value = null
    toast('已保存', 'success')
    fetchItems()
  } catch (error) {
    console.error('保存失败:', error)
    toast(error.response?.data?.error || '保存失败', 'error')
  }
}

// ============================================================
// 🚀 6. 打开卡片 / 多线路
// ============================================================
const openApp = async (item) => {
  if (isSortMode.value) return
  if (item.widgetType) return // 小组件是展示块，没有可打开的目标
  if (!item.urls || item.urls.length === 0) return

  // 打开方式：卡片里显式选了"当前标签页"就原地跳，否则新开
  const sameTab = item.openMethod === 'same_tab'
  // 同步打开空白页，保住用户手势（否则 await 之后 window.open 会被拦截）
  const win = sameTab ? null : window.open('', '_blank')
  const go = (url) => {
    if (win) { win.location.href = url } else { window.location.href = url }
  }

  if (item.urls.length === 1) return go(item.urls[0].url)

  try {
    // 探活交给后端，绕开 HTTPS 页面探测 http://内网IP 的混合内容限制
    const { data } = await axios.post(`/api/items/${item.id}/probe`)
    go(data.url || item.urls[0].url)
  } catch {
    if (win) win.close()
    toast('所有线路均无响应，已为你打开第一条地址', 'warn')
    window.open(item.urls[0].url, '_blank')
  }
}

// ============================================================
// 🖱️ 7. 上下文菜单（右键 + 触屏长按）与夹边
// ============================================================
const contextMenu = ref({ visible: false, x: 0, y: 0, item: null })

const openMenuAt = async (menuRef, x, y, item) => {
  menuRef.value = { visible: true, x, y, item }
  await nextTick()
  // 测量真实尺寸后夹边，避免靠近屏幕右下角的卡片菜单被裁掉
  const el = document.querySelector('.context-menu')
  const rect = el ? el.getBoundingClientRect() : { width: 200, height: 300 }
  const pos = clampMenuPosition(x, y, { width: rect.width, height: rect.height })
  menuRef.value.x = pos.x
  menuRef.value.y = pos.y
}

// 编辑弹窗预览
const mpFirstUrl = computed(() => {
  const u = (formData.value.urls || []).find((x) => x && String(x.url || '').trim())
  return u ? String(u.url).replace(/^https?:\/\//, '').slice(0, 30) : ''
})
const mpBg = computed(() => {
  const hex = safeHex(formData.value.bgColor, null) || safeHex(globalSettings.value.cardBgColor, '#0f172a')
  const op = formData.value.bgColor && formData.value.bgOpacity != null ? formData.value.bgOpacity : (globalSettings.value.cardBgOpacity ?? 0.4)
  return hexToRgba(hex, op)
})
const defaultIconForWidget = (t) => (t === 'clock' ? 'mdi:clock-outline' : t === 'weather' ? 'mdi:weather-partly-cloudy' : t === 'system' ? 'mdi:view-dashboard-outline' : 'mdi:web')

const showMenu = (e, item) => { openMenuAt(contextMenu, e.clientX, e.clientY, item) }

// 改卡片尺寸：写 payload 后重取列表（服务端会广播给其他节点）
const setCardSize = async (item, preset) => {
  if (!item) return
  try {
    await axios.put(`/api/items/${item.id}`, { cardW: preset.w, cardH: preset.h })
    closeMenus()
    await fetchItems()
    toast(`尺寸已改为 ${preset.label}`, 'success')
  } catch (error) {
    toast(error.response?.data?.error || '改尺寸失败', 'error')
  }
}
const closeMenus = () => { contextMenu.value.visible = false }

// 触屏长按 500ms 弹出菜单（iOS 不派发 contextmenu）
let pressTimer = null
const longPressTriggered = ref(false)
const onTouchStart = (e, item) => {
  if (isSortMode.value) return
  const p = e.touches?.[0]
  if (!p) return
  longPressTriggered.value = false
  pressTimer = setTimeout(() => {
    longPressTriggered.value = true
    if (navigator.vibrate) navigator.vibrate(10)
    openMenuAt(contextMenu, p.clientX, p.clientY, item)
  }, 500)
}
const onTouchEndOrMove = () => { clearTimeout(pressTimer) }

const onCardClick = (item) => {
  if (longPressTriggered.value) { longPressTriggered.value = false; return }
  openApp(item)
}

const editItem = () => {
  const item = contextMenu.value.item
  if (!item) return
  formData.value = {
    name: item.name,
    description: item.description || '',
    icon: item.icon,
    bgColor: item.bgColor || '',
    bgOpacity: item.bgOpacity ?? globalSettings.value.cardBgOpacity ?? 0.4,
    isMonitored: !!item.isMonitored,
    pingUrl: item.pingUrl || '',
    // isPinned 已弃用
    isHidden: !!item.isHidden,
    widgetType: item.widgetType || '',
    widgetConfig: item.widgetConfig ?? null,
    openMethod: item.openMethod === 'same_tab' ? 'same_tab' : 'new_tab',
    weatherCity: (() => {
      try {
        const cfg = JSON.parse(item.widgetConfig || '{}')
        return cfg.city || '上海'
      } catch {
        return '上海'
      }
    })(),
    group: item.group || '书签',
    urls: JSON.parse(JSON.stringify(item.urls || [])),
  }
  if (formData.value.urls.length === 0) formData.value.urls = [{ url: '', label: '主地址', priority: 10 }]
  editingId.value = item.id
  showModal.value = true
  closeMenus()
}

/** 卡片标记：置顶 / 隐藏。走独立接口，不动地址表与样式 */
const toggleFlag = async (item, key) => {
  if (!item) return
  const before = !!item[key]
  const next = !before
  item[key] = next
  closeMenus()
  try {
    await axios.put(`/api/items/${item.id}/flags`, { [key]: next })
    if (key === 'isHidden') {
      toast(next ? '已隐藏，顶栏眼睛按钮可随时显示' : '已取消隐藏', next ? 'info' : 'success')
    } else {
      toast(next ? '已置顶到分组最前' : '已取消置顶', 'success')
    }
  } catch (e) {
    item[key] = before
    toast('标记保存失败，请重试', 'error')
  }
}

const deleteItem = async () => {
  const item = contextMenu.value.item
  if (!item) return
  if (!(await askConfirm(`确定删除「${item.name}」吗？`, { title: '删除卡片', danger: true, confirmText: '删除' }))) return
  try {
    await axios.delete(`/api/items/${item.id}`)
    toast('已删除', 'success')
    fetchItems()
  } catch {
    toast('删除失败', 'error')
  } finally {
    closeMenus()
  }
}

// ============================================================
// 🪟 8. 悬浮小窗（v2.7.0 起彻底移除「锁定内嵌到桌面」：公网站点大多禁止被 iframe 嵌入，
//      留着一堆失效的嵌入配置只会误导人；想看内嵌效果用悬浮小窗就够了）
// ============================================================
const windows = ref([])
let winSeq = 0
let activeZIndex = 10

const openInWindow = (item) => {
  // 触屏设备 / 小屏直接跳新标签，不再生成难操作的小窗
  if (isMobile.value || ('ontouchstart' in window && window.innerWidth <= 1100)) return openApp(item)

  const url = item.urls?.[0]?.url
  if (!url) return

  const w = Math.min(800, window.innerWidth - 80)
  const h = Math.min(550, window.innerHeight - 120)
  const x = Math.max(20, (window.innerWidth - w) / 2)
  const y = Math.max(20, (window.innerHeight - h) / 2)

  windows.value.push({
    id: ++winSeq, itemId: item.id, item, title: item.name, url,
    x, y, width: w, height: h, isMinimized: false, isMaximized: false, zIndex: ++activeZIndex,
  })
  closeMenus()
}

// 同时兼容鼠标与触屏的窗口拖拽（pointer events），并夹取到视口内
const startDragWin = (e, win) => {
  if (win.isMaximized) return
  win.zIndex = ++activeZIndex
  const startX = e.clientX - win.x
  const startY = e.clientY - win.y
  const onMove = (ev) => {
    win.x = Math.max(-win.width + 100, Math.min(ev.clientX - startX, window.innerWidth - 80))
    win.y = Math.max(0, Math.min(ev.clientY - startY, window.innerHeight - 50))
  }
  const onUp = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onUp)
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
  document.addEventListener('pointercancel', onUp)
}

const toggleMaximize = (win) => {
  win.isMaximized = !win.isMaximized
  win.zIndex = ++activeZIndex
}

const openUrl = (url) => {
  if (!url) return
  window.open(url, '_blank', 'noopener')
}


// ============================================================
// 🎨 9. 卡片样式与状态
// ============================================================
const getCombinedStyle = (item) => {
  const hex = safeHex(item.bgColor, null) || safeHex(globalSettings.value.cardBgColor, '#0f172a')
  const opacity = (item.bgColor && item.bgOpacity !== null && item.bgOpacity !== undefined)
    ? item.bgOpacity
    : (globalSettings.value.cardBgOpacity ?? 0.4)

  const baseStyle = {
    background: hexToRgba(hex, opacity),
    // 隐藏卡用虚线边框（内联样式优先级高于 scoped class，必须在这里给）
    border: item.isHidden ? '1px dashed rgba(148,163,184,0.55)' : '1px solid color-mix(in srgb, var(--theme-color) 12%, transparent)',
  }
  // 占位由 spanOfItem 决定：小组件占两行，其余一格
  const span = spanOfItem(item)
  const spanW = span.w
  const spanH = span.h
  // 坐标一律取"拆过冲突之后"的结果，同格重叠的旧数据也会被自动挪开
  const pos = layoutPositions.value.get(item.id)

  // 小屏不携带桌面网格坐标（否则内联 gridColumn 会制造隐式列，把卡片挤出屏幕）
  if (isMobile.value) {
    baseStyle.gridColumn = `span ${spanW}`
    baseStyle.gridRow = `span ${spanH}`
  } else if (pos) {
    baseStyle.gridColumn = `${pos.x} / span ${spanW}`
    baseStyle.gridRow = `${pos.y} / span ${spanH}`
  } else {
    baseStyle.gridColumn = `span ${spanW}`
    baseStyle.gridRow = `span ${spanH}`
  }

  if (draggedItem.value?.id === item.id) {
    baseStyle.opacity = 0.5
    baseStyle.transform = 'scale(0.95)'
    baseStyle.zIndex = 100
  }
  return baseStyle
}

const getStatusClass = (id) => {
  const s = deviceStatuses.value[id]?.s || 'Online'
  if (s === 'Offline') return 'status-offline'
  if (s === 'Suspected') return 'status-suspected'
  return 'status-online'
}

const safeFooterHtml = ref('')
watch(() => globalSettings.value.footerText, (v) => { safeFooterHtml.value = sanitizeFooter(v) }, { immediate: true })

// ============================================================
// 🧩 10. 浏览器插件快捷收藏（?action=add）
// ============================================================
const pendingExtensionData = ref(null)
const checkExtensionQuery = () => {
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.get('action') !== 'add') return
  const payload = {
    name: urlParams.get('title') || '',
    description: '',
    icon: urlParams.get('icon') || '',
    bgColor: '',
    bgOpacity: globalSettings.value.cardBgOpacity ?? 0.4,
    isMonitored: false,
    group: (globalSettings.value.groups || [])[0] || '书签',
    urls: [{ url: urlParams.get('url') || '', label: '主地址', priority: 10 }],
  }
  if (isLoggedIn.value) {
    editingId.value = null
    formData.value = payload
    showModal.value = true
    window.history.replaceState({}, document.title, window.location.pathname)
  } else {
    pendingExtensionData.value = payload
    toast('检测到收藏请求，请先登录面板', 'info')
  }
}
const handlePendingExtension = () => {
  if (!pendingExtensionData.value) return
  editingId.value = null
  formData.value = pendingExtensionData.value
  showModal.value = true
  pendingExtensionData.value = null
  window.history.replaceState({}, document.title, window.location.pathname)
}

// ============================================================
// ⌨️ 10.5 快捷键（? 说明 / h 隐藏卡 / g + 数字跳分组）
// ============================================================
const showShortcuts = ref(false)
const shortcuts = [
  { key: '/', desc: '打开全局搜索，模糊匹配名称、描述、网址、分组' },
  { key: '↑ ↓', desc: '在搜索结果里上下选择，回车直达' },
  { key: 'h', desc: '显示 / 收起隐藏卡（等价于点顶栏眼睛按钮）' },
  { key: 'g 1-9', desc: '跳到第 N 个分组（先按 g 再按数字）' },
  { key: 'i', desc: '打开 / 关闭系统状态面板（CPU / 内存 / 磁盘）' },
  { key: '?', desc: '打开 / 关闭这张快捷键说明' },
  { key: 'Esc', desc: '关闭弹窗、搜索浮层、右键菜单与说明' },
]
const jumpToGroup = (index) => {
  const sections = document.querySelectorAll('.group-section')
  const target = sections[index]
  if (!target) return toast('没有这个分组', 'warn')
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  toast(`已跳到「${groupOrder.value[index] || index + 1}」`, 'info')
}
let gPrefixExpire = 0

// ============================================================
// 🖥️ 10.6 系统状态面板（CPU / 内存 / 磁盘 / 运行时长）
// ============================================================
const showSystem = ref(false)
const systemStats = ref(null)
const systemError = ref(false)
let systemTimer = null

const fetchSystemStats = async () => {
  try {
    const { data } = await axios.get('/api/system/stats')
    systemStats.value = data
    systemError.value = false
  } catch (e) {
    systemError.value = true
  }
}
const startSystemPolling = () => {
  stopSystemPolling()
  systemTimer = setInterval(fetchSystemStats, 3000)
}
const stopSystemPolling = () => {
  if (systemTimer) clearInterval(systemTimer)
  systemTimer = null
}
// 只要"面板开着"或"桌面上有系统小组件"就轮询，两边共用一条 3s 计时器
const systemWidgetCount = computed(() => items.value.filter((i) => i.widgetType === 'system' && (!i.isHidden || revealHidden.value)).length)
const systemPollingNeeded = computed(() => showSystem.value || systemWidgetCount.value > 0)
watch(systemPollingNeeded, (need) => { if (need) startSystemPolling(); else stopSystemPolling() }, { immediate: true })

// ---- 桌面小组件添加（v3.7.1：从"编辑卡片"里独立出来）----
// ---- 统一二次确认（替代原生 confirm，见 components/ConfirmDialog.vue）----
const confirmState = ref({ open: false, title: '', message: '', danger: false, confirmText: '确定' })
let confirmResolve = null
const askConfirm = (message, opts = {}) => {
  confirmState.value = {
    open: true,
    title: opts.title || '确认操作',
    message,
    danger: !!opts.danger,
    confirmText: opts.confirmText || '确定',
  }
  return new Promise((resolve) => { confirmResolve = resolve })
}
const onConfirmOk = () => { confirmState.value.open = false; if (confirmResolve) { confirmResolve(true); confirmResolve = null } }
const onConfirmCancel = () => { confirmState.value.open = false; if (confirmResolve) { confirmResolve(false); confirmResolve = null } }

const showWidgetPicker = ref(false)
const WIDGET_TYPES = [
  { type: 'system', name: '系统状态', desc: 'CPU / 内存 / 磁盘实时占用', icon: 'mdi:view-dashboard-outline' },
  { type: 'clock', name: '时钟', desc: '本地时间、日期与星期', icon: 'mdi:clock-outline' },
  { type: 'weather', name: '天气', desc: '城市实时天气与温度', icon: 'mdi:weather-partly-cloudy' },
]
const openWidgetPicker = () => { showWidgetPicker.value = true }
const addWidget = async (w) => {
  try {
    const body = {
      name: w.name,
      group: globalSettings.value.groups?.[0] || '工具',
      widgetType: w.type,
      urls: [],
    }
    if (w.type === 'weather') body.widgetConfig = JSON.stringify({ city: '上海' })
    await axios.post('/api/items', body)
    showWidgetPicker.value = false
    toast('已添加「' + w.name + '」', 'success')
    await fetchItems()
  } catch (e) {
    toast(e.response?.data?.error || '添加失败', 'error')
  }
}

// 小组件只允许改名和删除
const renamingWidget = ref(null)
const widgetNameDraft = ref('')
const startRenameWidget = (item) => {
  renamingWidget.value = item
  widgetNameDraft.value = item?.name || ''
  closeMenus()
}
const cancelRenameWidget = () => { renamingWidget.value = null; widgetNameDraft.value = '' }
const commitRenameWidget = async () => {
  const name = widgetNameDraft.value.trim()
  if (!renamingWidget.value) return
  if (!name) return toast('名字不能为空', 'warn')
  try {
    await axios.put('/api/items/' + renamingWidget.value.id, { name })
    toast('已改名', 'success')
    cancelRenameWidget()
    await fetchItems()
  } catch (e) {
    toast(e.response?.data?.error || '改名失败', 'error')
  }
}

const closeSystem = () => { showSystem.value = false }
const toggleSystem = () => {
  if (showSystem.value) {
    closeSystem()
    return
  }
  showSystem.value = true
  closeSearch()
  showShortcuts.value = false
  fetchSystemStats()
}

const formatBytes = (n) => {
  if (!Number.isFinite(Number(n))) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(n)
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}
const formatUptime = (seconds) => {
  let s = Math.max(0, Math.floor(Number(seconds) || 0))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${m} 分 ${s % 60} 秒`
}
const levelClass = (percent) => {
  const p = Number(percent)
  if (!Number.isFinite(p)) return 'ok'
  if (p >= 90) return 'danger'
  if (p >= 70) return 'warn'
  return 'ok'
}

// ============================================================
// 📝 10.7 卡片备忘录（备注 + 密码条目，JSON 存库）
// ============================================================
const showMemo = ref(false)
const memoItem = ref(null)
const memoForm = ref({ note: '', entries: [] })
const memoRevealed = ref(new Set())
const savingMemo = ref(false)

/** 备忘录统一按 JSON 解析，脏数据当空处理（历史数据 / 手改库都可能不对） */
const parseMemo = (raw) => {
  if (!raw) return { note: '', entries: [] }
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      note: String(obj?.note || ''),
      entries: Array.isArray(obj?.entries)
        ? obj.entries.map((e) => ({
            label: String(e?.label || ''),
            value: String(e?.value || ''),
            masked: e?.masked !== false,
          }))
        : [],
    }
  } catch {
    return { note: '', entries: [] }
  }
}
const hasMemo = (item) => {
  const memo = parseMemo(item?.memo)
  return !!memo.note.trim() || memo.entries.some((e) => e.label.trim() || e.value.trim())
}

const openMemo = (item) => {
  if (!item) return
  const memo = parseMemo(item.memo)
  memoItem.value = item
  memoForm.value = {
    note: memo.note,
    entries: memo.entries.length
      ? memo.entries.map((e) => ({ ...e }))
      : [{ label: '', value: '', masked: true }],
  }
  memoRevealed.value = new Set()
  showMemo.value = true
  closeMenus()
}
const closeMemo = () => { showMemo.value = false; memoItem.value = null }
const addMemoEntry = () => memoForm.value.entries.push({ label: '', value: '', masked: true })
const removeMemoEntry = (index) => memoForm.value.entries.splice(index, 1)
// 持久切换"这条是否打码"（写进备忘录数据，不是临时的）
const toggleMemoMasked = (index) => {
  const entry = memoForm.value.entries[index]
  if (!entry) return
  entry.masked = !entry.masked
  // 改成明文时顺手把它列为已查看，避免刚点完还是显示成密码
  const next = new Set(memoRevealed.value)
  if (entry.masked) next.delete(index)
  else next.add(index)
  memoRevealed.value = next
}
const toggleMemoReveal = (index) => {
  const next = new Set(memoRevealed.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  memoRevealed.value = next
}
const copyMemoValue = async (value) => {
  if (!value) return toast('这条是空的', 'warn')
  // http 环境下 navigator.clipboard 不可用，copyToClipboard 会自动降级
  const ok = await copyToClipboard(value)
  toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中文本', ok ? 'success' : 'warn')
}
const saveMemo = async () => {
  if (!memoItem.value) return
  const payload = {
    note: memoForm.value.note,
    entries: memoForm.value.entries.filter((e) => e.label.trim() || e.value.trim()),
  }
  savingMemo.value = true
  try {
    const { data } = await axios.put(`/api/items/${memoItem.value.id}/memo`, { memo: payload })
    memoItem.value.memo = data.memo
    toast(data.memo ? '备忘录已保存' : '空备忘录已清除', 'success')
    closeMemo()
  } catch (e) {
    toast(e.response?.data?.error || '保存失败', 'error')
  } finally {
    savingMemo.value = false
  }
}

// 排版入口：只开不关（原来复用 toggleSortMode，点是第二次就把排序模式关掉，纯坑）
const enterSortMode = () => { isSortMode.value = true; closeMenus() }

// ============================================================
// 🔄 11. 轮询与生命周期
// ============================================================
const timers = { monitor: null }
const startPolling = () => {
  stopPolling()
  if (!isLoggedIn.value) return
  timers.monitor = setInterval(fetchMonitorStatus, 30000) // 30s 刷新状态灯
}
const stopPolling = () => {
  if (timers.monitor) clearInterval(timers.monitor)
  timers.monitor = null
}
watch(isLoggedIn, (v) => { if (v) startPolling(); else stopPolling() })

const onKeydown = (e) => {
  if (e.key === 'Escape') {
    showModal.value = false; showSettings.value = false
    showShortcuts.value = false
    closeMemo()
    closeSystem()
    closeSearch(); closeMenus()
    return
  }

  // 输入框/文本域聚焦时一律不劫持按键
  const tag = e.target?.tagName
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable
  if (typing || !isLoggedIn.value || showModal.value || showSettings.value) return

  // 按 / 呼出全局搜索
  if (e.key === '/' && !showSearch.value) {
    e.preventDefault()
    openSearch()
    return
  }

  // 按 ? 呼出快捷键说明（Shift + / 在多数键盘上就是 ?）
  if (e.key === '?') {
    e.preventDefault()
    showShortcuts.value = !showShortcuts.value
    return
  }

  // 按 i 打开 / 关闭系统状态
  if (e.key === 'i' || e.key === 'I') {
    e.preventDefault()
    toggleSystem()
    return
  }

  // 按 h 显示 / 收起隐藏卡
  if (e.key === 'h' || e.key === 'H') {
    e.preventDefault()
    toggleShowHidden()
    return
  }

  // g + 1-9 跳分组（1.2 秒内按数字才生效）
  if (e.key === 'g' || e.key === 'G') {
    gPrefixExpire = Date.now() + 1200
    return
  }
  if (/^[1-9]$/.test(e.key) && Date.now() < gPrefixExpire) {
    gPrefixExpire = 0
    e.preventDefault()
    jumpToGroup(Number(e.key) - 1)
  }
}

/**
 * 跨节点登录态转移（v3.8.0）
 * 从别的节点跳过来时 URL 会带 ?transfer=<ticket>&from=<源节点地址>：
 *   1) 向源节点验票，拿 60 秒短 token
 *   2) 用短 token 换本机 30 天 token
 *   3) 清掉 URL 参数，直接进面板
 */
const acceptTransfer = async () => {
  const q = new URLSearchParams(location.search)
  const ticket = q.get('transfer')
  const from = q.get('from')
  if (!ticket || !from) return false
  try {
    const verify = await axios.post(String(from).replace(/\/$/, '') + '/api/auth/transfer/verify', { ticket })
    const accept = await axios.post('/api/auth/transfer/accept', { token: verify.data.token })
    token.value = accept.data.token
    // Cookie 由后端 Set-Cookie 写入，这里只留内存态
    isLoggedIn.value = true
    // 清掉 URL，避免刷新重放
    q.delete('transfer'); q.delete('from')
    const clean = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash
    history.replaceState(null, '', clean)
    toast('已从其他节点无缝登录', 'success')
    return true
  } catch (e) {
    toast('跨节点登录失败：' + (e.response?.data?.error || e.message), 'error', 5000)
    return false
  }
}

onMounted(async () => {
  // 【v3.9.0】登录态自查：Cookie 有就免登录（跨子域/跨端口都能带过来）
  try {
    const me = await axios.get('/api/auth/me')
    if (me.data && me.data.ok) isLoggedIn.value = true
  } catch { /* 未登录，正常走登录页 */ }
  // 先处理跨节点转移（如果有 ?transfer=）
  await acceptTransfer()
  // 再看是不是全新设备（这个接口免登录）
  try {
    const { data } = await axios.get('/api/setup/state');
    showWizard.value = !!data.showWizard;
    setupSkipped.value = !!data.skipped;
  } catch { showWizard.value = false; }

  window.addEventListener('click', closeMenus)
  window.addEventListener('resize', onViewportResize)
  window.addEventListener('keydown', onKeydown)

  // 首屏主题：先用本地缓存防止闪烁，再悄悄问云端
  const themeCookie = readThemeCookie()
  const cachedBg = themeCookie.themeBg || safeHex(localStorage.getItem('themeBg'), null)
  const cachedColor = themeCookie.themeColor || safeHex(localStorage.getItem('themeColor'), null)
  // 强调色也缓存，减少首屏颜色跳变
  applyThemeToBody({
    ...globalSettings.value,
    themeBg: cachedBg || globalSettings.value.themeBg,
    themeColor: cachedColor || globalSettings.value.themeColor,
  })

  // v2.7.0 起不再有内嵌卡，清掉老版本留在浏览器里的相关配置
  ;['pinnedWidgets', 'widgetSizes', 'widgetReload'].forEach((k) => localStorage.removeItem(k))
  checkExtensionQuery()
  updateGridCols()
  observeGridResize()
  if (isLoggedIn.value) { startPolling(); checkVault(); fetchItems(); syncThemeFromCloud() }
})

// 卡片列表/内嵌尺寸/小组件变化后，列数可能也跟着变（比如小组件占两行）
watch(items, () => { nextTick(updateGridCols) })

onUnmounted(() => {
  window.removeEventListener('click', closeMenus)
  window.removeEventListener('resize', onViewportResize)
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(layoutFixTimer)
  // 【F-04】长按定时器也要清，否则组件卸载后仍可能触发
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
  if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null }
  if (gridResizeObserver) { gridResizeObserver.disconnect(); gridResizeObserver = null }
  stopSystemPolling()
  stopPolling()
})
</script>

<template>
  <div
    class="dashboard-app"
    :style="{ backgroundImage: globalSettings.bgImage ? `url(${globalSettings.bgImage})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }"
  >
    <div class="bg-shape shape-1" v-if="!globalSettings.bgImage"></div>
    <div class="bg-shape shape-2" v-if="!globalSettings.bgImage"></div>

    <!-- ================= 登录层 ================= -->
    <SetupWizard v-if="showWizard && !isLoggedIn" @done="onWizardDone" />
    <div v-if="!isLoggedIn && !showWizard" class="login-overlay glass-strong">
      <div class="login-box glass-strong">
        <h2>{{ isFirstLogin ? '🛡️ 安全初始化' : (show2FAInputRow ? '🔐 安全验证' : '👋 欢迎回来') }}</h2>

        <div v-if="isFirstLogin">
          <p style="color: #f59e0b; font-size: 13px; margin: 10px 0;">检测到首次登录，请修改默认密码！</p>
          <input v-model="changePwdForm.newUsername" type="text" placeholder="设置新账号" class="glass-input full-w mt-3" />
          <input v-model="changePwdForm.newPassword" type="password" placeholder="设置新密码 (至少5位)" class="glass-input full-w mt-3" @keyup.enter="handleChangePassword" />
          <button class="btn-primary full-w mt-4" style="padding: 12px; background: #10b981" @click="handleChangePassword">确认修改</button>
        </div>

        <div v-else-if="show2FAInputRow">
          <p style="color: #10b981; text-align: center; margin: 15px 0 20px 0; font-size: 14px;">
            <AppIcon icon="mdi:shield-check" /> 账号验证通过，请输入 2FA 动态码
          </p>
          <input
            v-model="totpCode" type="text" inputmode="numeric" maxlength="6"
            class="glass-input full-w" placeholder="6位数字验证码"
            style="text-align: center; letter-spacing: 4px; font-size: 18px; font-weight: bold; margin-bottom: 20px;"
            @keyup.enter="handleVerify2FA"
          />
          <div style="display: flex; gap: 10px;">
            <button class="btn-cancel flex-1" style="padding: 12px" @click="show2FAInputRow = false">返回重输</button>
            <button class="btn-primary flex-1" style="padding: 12px" @click="handleVerify2FA">验证并进入</button>
          </div>
        </div>

        <div v-else>
          <input v-model="loginForm.username" type="text" placeholder="账号" class="glass-input full-w mt-3" @keyup.enter="handleLogin" />
          <input v-model="loginForm.password" type="password" placeholder="密码" class="glass-input full-w mt-3" @keyup.enter="handleLogin" />
          <button class="btn-primary full-w mt-4" style="padding: 12px" @click="handleLogin">登 录</button>
        </div>

        <p v-if="setupSkipped" class="setup-back">
          这台设备还没加入网络？
          <button class="link-btn" @click="backToSetup">重新选择</button>
        </p>
      </div>
    </div>

    <!-- ================= 🔒 保险库解锁层（进程重启后出现） ================= -->
    <div v-if="isLoggedIn && vaultLocked" class="login-overlay glass-strong" style="z-index: 9500">
      <div class="login-box glass-strong">
        <h2>🔒 保险库已锁定</h2>
        <p style="font-size: 13px; color: color-mix(in srgb, var(--theme-color) 62%, transparent); line-height: 1.65; margin: 12px 0 4px;">
          备忘录与备份的密钥由你的登录密码保护。服务重启后需要解锁一次，<br />
          解锁前不会下发任何备忘录明文。
        </p>
        <input
          v-model="vaultPassword" type="password" class="glass-input full-w mt-3"
          placeholder="管理员密码" autocomplete="current-password"
          @keyup.enter="unlockVault"
        />
        <button class="btn-primary full-w mt-4" style="padding: 12px" :disabled="vaultUnlocking" @click="unlockVault">
          {{ vaultUnlocking ? '解锁中…' : '解锁保险库' }}
        </button>
        <p style="font-size: 11px; color: color-mix(in srgb, var(--theme-color) 50%, transparent); margin-top: 12px;">
          卡片、分组、主题在解锁前仍然可以查看，只是备忘录是空的。
        </p>
      </div>
    </div>

    <!-- ================= 主界面 ================= -->
    <template v-if="isLoggedIn">
      <header class="top-bar">
        <h2 style="display:flex; align-items:center; gap: 10px;">
          <img
            v-if="globalSettings.siteIcon?.startsWith('data:') || globalSettings.siteIcon?.startsWith('http')"
            :src="globalSettings.siteIcon"
            style="width: 28px; height: 28px; border-radius: 6px; object-fit: cover;"
            alt=""
          />
          <AppIcon v-else :icon="globalSettings.siteIcon || 'mdi:home-circle'" style="font-size: 28px;" />
          <span class="top-title">{{ globalSettings.siteTitle || '个人数字枢纽' }}</span>
        </h2>

        <div class="top-actions">
          <button class="icon-btn" @click.stop="openSearch" title="全局搜索 (快捷键 /)">
            <AppIcon icon="mdi:magnify" />
          </button>
          <button
            v-if="hiddenCount > 0 || showHidden"
            class="icon-btn" :class="{ primary: showHidden }"
            @click.stop="toggleShowHidden"
            :title="showHidden ? `收起隐藏卡（共 ${hiddenCount} 张，快捷键 h）` : `显示 ${hiddenCount} 张隐藏卡（快捷键 h）`"
          >
            <AppIcon :icon="showHidden ? 'mdi:eye' : 'mdi:eye-off'" />
          </button>
          <button
            class="icon-btn sys-btn" :class="{ primary: showSystem }"
            @click.stop="toggleSystem" title="系统状态 (快捷键 i)"
          >
            <AppIcon icon="mdi:monitor-dashboard" />
          </button>
          <button
            class="icon-btn" :class="{ primary: isSortMode }"
            @click.stop="toggleSortMode"
            :title="isSortMode ? '完成排序' : '进入排序模式'"
          >
            <AppIcon :icon="isSortMode ? 'mdi:check' : 'mdi:drag-variant'" />
          </button>
          <button class="icon-btn primary" @click.stop="openAddModal" title="添加应用">
            <AppIcon icon="mdi:plus" />
          </button>
          <button class="icon-btn" @click.stop="settingsTab = ''; showSettings = true" title="全局设置"><AppIcon icon="mdi:cog" /></button>
          <button class="icon-btn" @click.stop="logout" title="退出登录" style="color: #ef4444;"><AppIcon icon="mdi:logout" /></button>
        </div>
      </header>

      <div v-if="isSortMode" class="sort-tip">
        🧲 排序模式已开启：桌面端直接拖拽卡片；手机端点卡片上的方向按钮移动。隐藏卡在此模式下也会显示，方便一起整理。
      </div>

      <div v-if="offlineMode" class="offline-bar">
        <AppIcon icon="mdi:wifi-off" /> 离线模式：显示本地缓存，改动请在恢复连接后再做
      </div>

      <main class="desktop-area">
        <div v-if="items.length === 0" class="empty-tip glass-strong">
          <AppIcon icon="mdi:rocket-launch-outline" class="empty-icon" />
          <p>空空如也，点击右上角加号添加应用吧！</p>
        </div>

        <div
          v-else v-for="groupName in groupOrder" :key="groupName"
          class="group-section"
          @dragover.prevent @drop="onDrop($event, groupName)"
        >
          <h3 class="group-title">
            {{ groupName }}
            <span v-if="groupName === FALLBACK_GROUP" class="group-fallback-tip">（卡片分组不存在时暂列于此）</span>
          </h3>

          <div class="icon-grid" :class="{ 'is-sorting': isSortMode }">
            <template v-for="item in groupedItems[groupName]" :key="item.id">
              <!-- 桌面小组件（系统状态 / 时钟 / 天气）：纯展示块，数据由外层统一轮询 -->
              <DashboardWidget
                v-if="item.widgetType"
                :item="item"
                :stats="systemStats"
                :stats-error="systemError"
                :has-memo="hasMemo(item)"
                :style="getCombinedStyle(item)"
                :draggable="isSortMode && !isMobile"
                @dragstart="onDragStart($event, item)"
                @click="onCardClick(item)"
                @contextmenu.prevent="showMenu($event, item)"
                @touchstart.passive="onTouchStart($event, item)"
                @touchend="onTouchEndOrMove"
                @touchmove.passive="onTouchEndOrMove"
              />

              <!-- 普通卡片 -->
              <div
                v-else
                class="app-card"
                :class="{ 'is-hidden-card': item.isHidden, 'is-context-open': contextMenu.visible && contextMenu.item?.id === item.id, 'is-wide': (item.cardW || 1) === 2, 'is-tall': (item.cardH || 1) === 2, 'is-large': (item.cardW || 1) === 2 && (item.cardH || 1) === 2 }"
                :style="getCombinedStyle(item)"
                :draggable="isSortMode && !isMobile"
                @dragstart="onDragStart($event, item)"
                @click="onCardClick(item)"
                @contextmenu.prevent="showMenu($event, item)"
                @touchstart.passive="onTouchStart($event, item)"
                @touchend="onTouchEndOrMove"
                @touchmove.passive="onTouchEndOrMove"
              >
                <div class="card-content">
                  <div class="icon-container">
                    <img v-if="item.icon?.startsWith('data:') || item.icon?.startsWith('http')" :src="item.icon" class="app-img-icon" alt="" />
                    <AppIcon v-else :icon="item.icon || 'mdi:web'" class="app-icon" />
                  </div>
                  <div class="text-container">
                    <div class="app-name">{{ item.name }}</div>
                    <div v-if="item.description" class="app-desc">{{ item.description }}</div>
                  </div>
                </div>
                <div v-if="item.isMonitored" class="status-glow" :class="getStatusClass(item.id)"></div>

                <!-- 置顶 / 隐藏 / 备忘录角标 -->
                <div v-if="item.isHidden || hasMemo(item)" class="card-flags">
                    <span v-if="item.isHidden" title="隐藏卡：仅显示隐藏卡时可见"><AppIcon icon="mdi:eye-off" /></span>
                  <span v-if="hasMemo(item)" class="flag-memo" title="有备忘录"><AppIcon icon="mdi:note-text-outline" /></span>
                </div>

                <!-- 排序模式下的移动端移动按钮 -->
                <div v-if="isSortMode && isMobile" class="sort-controls" @click.stop>
                  <button @click="nudgeItem(item, 0, -1)" title="上移"><AppIcon icon="mdi:arrow-up" /></button>
                  <button @click="nudgeItem(item, -1, 0)" title="左移"><AppIcon icon="mdi:arrow-left" /></button>
                  <button @click="nudgeItem(item, 1, 0)" title="右移"><AppIcon icon="mdi:arrow-right" /></button>
                  <button @click="nudgeItem(item, 0, 1)" title="下移"><AppIcon icon="mdi:arrow-down" /></button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </main>

      <footer class="custom-footer" v-if="safeFooterHtml" v-html="safeFooterHtml"></footer>

      <SettingsPanel
        v-if="showSettings"
        :settings="globalSettings"
        :initial-tab="settingsTab"
        @close="showSettings = false; settingsTab = ''"
        @save="handleSaveSettings"
        @refresh-items="fetchItems"
      />

      <!-- 卡片菜单：普通卡片 / 小组件共用，按类型只显示真正有效的项 -->
      <div v-if="contextMenu.visible" class="context-menu glass-strong" :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }">
        <div class="menu-header">{{ contextMenu.item?.name }}</div>

        <!-- 【v3.7.1】小组件：只允许改名和删除 -->
        <template v-if="contextMenu.item?.widgetType">
          <div class="menu-item" @click.stop="startRenameWidget(contextMenu.item)">
            <AppIcon icon="mdi:pencil-outline" /> 重命名
          </div>
          <div class="menu-divider"></div>
          <div class="menu-item text-danger" @click.stop="deleteItem">
            <AppIcon icon="mdi:trash-can-outline" /> 删除小组件
          </div>
        </template>

        <!-- 普通卡：完整菜单 -->
        <template v-else>
          <div v-for="(u, index) in contextMenu.item?.urls" :key="u.id || index" class="menu-item" @click.stop="openUrl(u.url)">
            <AppIcon icon="mdi:link-variant" /> 打开 {{ u.label }}
          </div>
          <div class="menu-divider"></div>

          <div class="menu-item" @click.stop="openMemo(contextMenu.item)">
            <AppIcon icon="mdi:note-text-outline" /> 备忘录
            <span v-if="hasMemo(contextMenu.item)" class="menu-badge">已填写</span>
          </div>
          <div class="menu-item" @click.stop="toggleFlag(contextMenu.item, 'isHidden')">
            <AppIcon :icon="contextMenu.item?.isHidden ? 'mdi:eye' : 'mdi:eye-off'" />
            {{ contextMenu.item?.isHidden ? '取消隐藏' : '隐藏这张卡' }}
          </div>
          <div v-if="contextMenu.item?.isMonitored" class="menu-item" @click.stop="openUptime(contextMenu.item)">
            <AppIcon icon="mdi:chart-timeline-variant" /> 查看存活历史
          </div>

          <div class="menu-divider"></div>
          <div class="menu-header sub">尺寸</div>
          <div class="menu-size-row">
            <button
              v-for="p in SIZE_PRESETS" :key="p.key"
              class="menu-size-btn"
              :class="{ active: (contextMenu.item?.cardW || 1) === p.w && (contextMenu.item?.cardH || 1) === p.h }"
              :title="p.label"
              @click.stop="setCardSize(contextMenu.item, p)"
            >
              <span class="size-box" :style="{ width: (p.w * 8 + 6) + 'px', height: (p.h * 8 + 6) + 'px' }"></span>
            </button>
          </div>

          <div v-if="!isMobile" class="menu-item mobile-hide" @click.stop="openInWindow(contextMenu.item)">
            <AppIcon icon="mdi:window-maximize" /> 悬浮小窗打开
            <span class="menu-hint">仅电脑端</span>
          </div>

          <div class="menu-divider"></div>
          <div class="menu-item" @click.stop="editItem"><AppIcon icon="mdi:pencil-outline" /> 编辑此应用</div>
          <div class="menu-item text-danger" @click.stop="deleteItem"><AppIcon icon="mdi:trash-can-outline" /> 删除</div>
        </template>
      </div>

      <!-- 悬浮小窗 -->
      <div class="window-manager">
        <template v-for="win in windows" :key="win.id">
          <div
            v-show="!win.isMinimized"
            class="app-window glass-strong"
            :class="{ maximized: win.isMaximized }"
            :style="win.isMaximized
              ? { left: '8px', top: '8px', right: '8px', bottom: '8px', width: 'auto', height: 'auto', zIndex: win.zIndex }
              : { left: win.x + 'px', top: win.y + 'px', width: win.width + 'px', height: win.height + 'px', zIndex: win.zIndex }"
            @pointerdown="win.zIndex = ++activeZIndex"
          >
            <div class="window-header" @pointerdown="startDragWin($event, win)" @dblclick="win.isMinimized = true" title="拖拽移动 | 双击最小化">
              <div class="window-title">{{ win.title }}</div>
              <div class="window-controls">
                <button class="win-btn" @click.stop="toggleMaximize(win)" :title="win.isMaximized ? '还原' : '最大化'">□</button>
                <button class="win-btn" @click.stop="win.isMinimized = true" title="最小化">_</button>
                <button class="win-btn close-btn" @click.stop="windows = windows.filter(w => w.id !== win.id)" title="关闭">×</button>
              </div>
            </div>
            <div class="window-body"><iframe :src="win.url" frameborder="0" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>
          </div>
        </template>
      </div>

      <div class="dock-area" @contextmenu.prevent>
        <div v-for="win in windows.filter(w => w.isMinimized)" :key="'dock-' + win.id" class="dock-item glass" @click="win.isMinimized = false; win.zIndex = ++activeZIndex">
          <AppIcon icon="mdi:application-outline" /> {{ win.title }}
        </div>
      </div>

      <!-- 📝 卡片备忘录 -->
      <div v-if="showMemo" class="modal-overlay" style="z-index: 1200">
        <div class="modal-content glass-strong scrollable memo-modal">
          <h3>📝 {{ memoItem?.name }} · 备忘录</h3>

          <div class="form-group">
            <label>备注 / 注意事项</label>
            <textarea
              v-model="memoForm.note"
              class="glass-input memo-note"
              rows="4" maxlength="4000"
              placeholder="例如：后台地址、初始账号、到期时间、需要注意的事…"
            ></textarea>
            <div class="memo-count">{{ memoForm.note.length }} / 4000</div>
          </div>

          <div class="form-group">
            <label>密码 / 敏感信息（默认打码，眼睛查看，复制按钮直接取用）</label>
            <div v-for="(entry, idx) in memoForm.entries" :key="idx" class="memo-entry">
              <input v-model="entry.label" class="glass-input memo-entry-label" maxlength="60" placeholder="名称，如 SSH" />
              <input
                v-model="entry.value"
                class="glass-input memo-entry-value"
                maxlength="1000"
                placeholder="内容"
                :type="entry.masked && !memoRevealed.has(idx) ? 'password' : 'text'"
              />
              <button class="memo-icon-btn" title="显示 / 隐藏" @click="toggleMemoReveal(idx)">
                <AppIcon :icon="entry.masked && !memoRevealed.has(idx) ? 'mdi:eye-off' : 'mdi:eye'" />
              </button>
              <button
                class="memo-icon-btn"
                :class="{ locked: entry.masked }"
                :title="entry.masked ? '这条会打码（点一下改成明文保存）' : '这条是明文（点一下改成打码保存）'"
                @click="toggleMemoMasked(idx)"
              >
                <AppIcon :icon="entry.masked ? 'mdi:lock-outline' : 'mdi:lock-open-variant-outline'" />
              </button>
              <button class="memo-icon-btn" title="复制" @click="copyMemoValue(entry.value)">
                <AppIcon icon="mdi:content-copy" />
              </button>
              <button class="memo-icon-btn danger" title="删掉这条" @click="removeMemoEntry(idx)">
                <AppIcon icon="mdi:close" />
              </button>
            </div>
            <button class="memo-add" @click="addMemoEntry"><AppIcon icon="mdi:plus" /> 添加一条密码</button>
          </div>

          <div class="modal-actions">
            <button class="btn-cancel" @click="closeMemo">取消</button>
            <button class="btn-primary" :disabled="savingMemo" @click="saveMemo">
              {{ savingMemo ? '保存中…' : '保存备忘录' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 🔎 全局搜索浮层 -->
      <div v-if="showSearch" class="search-overlay" @click.self="closeSearch">
        <div class="search-box glass-strong">
          <div class="search-bar">
            <AppIcon icon="mdi:magnify" class="search-bar-icon" />
            <input
              v-model="searchQuery"
              class="search-input"
              type="text"
              placeholder="搜索名称、描述、网址、备注… (↑↓ 选择，回车打开，Esc 关闭)"
              @keydown="onSearchKeydown"
            />
            <button class="win-btn close-btn" @click="closeSearch">×</button>
          </div>
          <div class="search-results" v-if="searchResults.length">
            <div
              v-for="(item, idx) in searchResults" :key="item.id"
              class="search-result-item"
              :class="{ active: idx === searchIndex }"
              @mouseenter="searchIndex = idx"
              @click="pickSearchResult(item, idx)"
            >
              <img v-if="item.icon?.startsWith('data:') || item.icon?.startsWith('http')" :src="item.icon" class="search-icon" alt="" />
              <AppIcon v-else :icon="item.icon || 'mdi:web'" class="search-icon" />
              <div class="search-text">
                <div class="search-name">{{ item.name }} <span class="search-group">{{ item.group }}</span></div>
                <div class="search-url">{{ item.urls?.[0]?.url }}</div>
              </div>
            </div>
          </div>
          <!-- 快捷操作：无查询时展示，⌘K 之后直接回车就能用 -->
          <div v-if="!searchQuery.trim()" class="search-actions">
            <div class="search-action" :class="{ active: searchIndex === 1000 }" @mouseenter="searchIndex = 1000" @click="runQuickAction('new')">
              <AppIcon icon="mdi:plus-circle-outline" /> 新建书签
            </div>
            <div class="search-action" :class="{ active: searchIndex === 1001 }" @mouseenter="searchIndex = 1001" @click="runQuickAction('sync')">
              <AppIcon icon="mdi:server-network" /> 多节点同步状态
            </div>
            <div class="search-action" :class="{ active: searchIndex === 1002 }" @mouseenter="searchIndex = 1002" @click="runQuickAction('lock')">
              <AppIcon icon="mdi:lock-outline" /> 锁定保险库
            </div>
            <div class="search-action" :class="{ active: searchIndex === 1003 }" @mouseenter="searchIndex = 1003" @click="runQuickAction('shortcuts')">
              <AppIcon icon="mdi:keyboard-outline" /> 快捷键说明
            </div>
          </div>
          <div v-else-if="!searchResults.length" class="search-empty">
            <div>没有匹配的卡片</div>
            <button class="search-engine-btn" @click="searchOnWeb">
              <AppIcon icon="mdi:web" /> 用 {{ searchEngineName }} 搜「{{ searchQuery.trim() }}」
            </button>
          </div>
        </div>
      </div>

      <!-- 📈 存活历史（批次 2.4） -->
      <div v-if="uptimeData" class="search-overlay" @click.self="closeUptime">
        <div class="search-box glass-strong uptime-box">
          <div class="search-bar">
            <AppIcon icon="mdi:chart-timeline-variant" class="search-bar-icon" />
            <span class="uptime-title">{{ uptimeItem?.name }} · 存活历史</span>
            <button class="win-btn close-btn" @click="closeUptime">×</button>
          </div>
          <div v-if="uptimeData.loading" class="search-empty">读取中…</div>
          <div v-else-if="uptimeData.error" class="search-empty">{{ uptimeData.error }}</div>
          <div v-else class="uptime-body">
            <div class="uptime-summary">
              可用率 <b>{{ uptimeData.availability ?? '—' }}%</b>
              <span v-if="uptimeData.avgLatency != null">· 平均 {{ uptimeData.avgLatency }} ms</span>
              <span class="uptime-count">（最近 {{ uptimeData.total }} 次探测）</span>
            </div>
            <div class="uptime-bars">
              <span
                v-for="(r, i) in uptimeData.list" :key="i"
                class="uptime-bar" :class="r.ok ? 'ok' : 'bad'"
                :title="fmtTime(r.checkedAt) + (r.latencyMs != null ? ' · ' + r.latencyMs + 'ms' : '')"
              ></span>
            </div>
            <p class="search-empty" v-if="!uptimeData.list.length">还没有历史数据（监测每 60 秒一轮）</p>
          </div>
        </div>
      </div>

      <!-- 📡 节点失联横幅 -->
      <div v-if="nodeOffline && isLoggedIn" class="node-offline-bar">
        <AppIcon icon="mdi:access-point-network-off" />
        <span>当前节点连不上了</span>
        <button class="nob-btn" @click="retryCurrent">重试</button>
        <button class="nob-btn primary" @click="switchNode">切换到其他节点</button>
      </div>

      <!-- ⚠️ 统一二次确认 -->
      <ConfirmDialog
        :open="confirmState.open"
        :title="confirmState.title"
        :message="confirmState.message"
        :danger="confirmState.danger"
        :confirm-text="confirmState.confirmText"
        @confirm="onConfirmOk"
        @cancel="onConfirmCancel"
        @update:open="confirmState.open = $event"
      />

      <!-- ⌨️ 快捷键说明浮层 -->
      <div v-if="showShortcuts" class="search-overlay" @click.self="showShortcuts = false">
        <div class="search-box glass-strong shortcut-box">
          <div class="shortcut-title">
            <AppIcon icon="mdi:keyboard-outline" /> 快捷键
            <button class="win-btn close-btn" @click="showShortcuts = false">×</button>
          </div>
          <div class="shortcut-list">
            <div v-for="s in shortcuts" :key="s.key" class="shortcut-row">
              <kbd>{{ s.key }}</kbd>
              <span>{{ s.desc }}</span>
            </div>
          </div>
          <div class="shortcut-foot">卡片上右键 / 长按也能置顶、隐藏、编辑</div>
        </div>
      </div>

      <!-- 🖥️ 系统状态浮层 -->
      <div v-if="showSystem" class="search-overlay" @click.self="closeSystem">
        <div class="search-box glass-strong sys-box">
          <div class="shortcut-title">
            <AppIcon icon="mdi:monitor-dashboard" /> 系统状态
            <span class="sys-live" :class="{ off: systemError }">{{ systemError ? '连接中断' : '实时' }}</span>
            <button class="win-btn widget-add-btn" title="添加桌面小组件" @click.stop="openWidgetPicker">＋</button>
            <button class="win-btn close-btn" @click="closeSystem">×</button>
          </div>

          <div v-if="!systemStats" class="sys-loading">
            {{ systemError ? '读不到系统状态，后端可能没起来' : '读取中…' }}
          </div>

          <div v-else class="sys-body">
            <div class="sys-metric">
              <div class="sys-metric-head">
                <span>CPU 使用率</span>
                <span>{{ systemStats.cpu?.usage ?? '—' }}% · {{ systemStats.cpu?.cores }} 核</span>
              </div>
              <div class="sys-bar"><i :class="levelClass(systemStats.cpu?.usage)" :style="{ width: (systemStats.cpu?.usage || 0) + '%' }"></i></div>
              <div class="sys-sub">{{ systemStats.cpu?.model }}</div>
            </div>

            <div class="sys-metric">
              <div class="sys-metric-head">
                <span>内存</span>
                <span>{{ systemStats.mem?.percent ?? '—' }}%</span>
              </div>
              <div class="sys-bar"><i :class="levelClass(systemStats.mem?.percent)" :style="{ width: (systemStats.mem?.percent || 0) + '%' }"></i></div>
              <div class="sys-sub">已用 {{ formatBytes(systemStats.mem?.used) }} / 共 {{ formatBytes(systemStats.mem?.total) }}</div>
            </div>

            <div class="sys-metric" v-if="systemStats.disk">
              <div class="sys-metric-head">
                <span>磁盘（数据目录）</span>
                <span>{{ systemStats.disk?.percent }}%</span>
              </div>
              <div class="sys-bar"><i :class="levelClass(systemStats.disk?.percent)" :style="{ width: (systemStats.disk?.percent || 0) + '%' }"></i></div>
              <div class="sys-sub">已用 {{ formatBytes(systemStats.disk?.used) }} / 共 {{ formatBytes(systemStats.disk?.total) }}</div>
            </div>

            <div class="sys-grid">
              <div><span>系统运行</span><b>{{ formatUptime(systemStats.uptime?.system) }}</b></div>
              <div><span>面板运行</span><b>{{ formatUptime(systemStats.uptime?.process) }}</b></div>
              <div><span>主机</span><b>{{ systemStats.host?.hostname }} · {{ systemStats.host?.arch }}</b></div>
              <div><span>系统</span><b>{{ systemStats.host?.platform }} {{ systemStats.host?.release }}</b></div>
              <div><span>Node</span><b>{{ systemStats.host?.node }}</b></div>
              <div><span>平均负载</span><b>{{ (systemStats.cpu?.load || []).join(' / ') || '—' }}</b></div>
            </div>
          </div>
          <div class="shortcut-foot">每 3 秒刷新一次，关掉面板就停止轮询</div>
        </div>
      </div>

      <!-- 🧩 添加桌面小组件 -->
      <div v-if="showWidgetPicker" class="search-overlay" @click.self="showWidgetPicker = false">
        <div class="search-box glass-strong widget-picker-box">
          <div class="shortcut-title">
            <AppIcon icon="mdi:widgets-outline" /> 添加桌面小组件
            <button class="win-btn close-btn" @click="showWidgetPicker = false">×</button>
          </div>
          <div class="widget-choices">
            <button v-for="w in WIDGET_TYPES" :key="w.type" class="widget-choice" @click="addWidget(w)">
              <AppIcon :icon="w.icon" class="wc-icon" />
              <div class="wc-text">
                <b>{{ w.name }}</b>
                <span>{{ w.desc }}</span>
              </div>
              <AppIcon icon="mdi:plus" class="wc-plus" />
            </button>
          </div>
          <p class="widget-hint">小组件只用于展示，不支持备忘录、隐藏、置顶等操作。</p>
        </div>
      </div>

      <!-- ✏️ 小组件改名 -->
      <div v-if="renamingWidget" class="search-overlay" @click.self="cancelRenameWidget">
        <div class="search-box glass-strong widget-rename-box">
          <div class="shortcut-title">
            <AppIcon icon="mdi:pencil-outline" /> 重命名小组件
            <button class="win-btn close-btn" @click="cancelRenameWidget">×</button>
          </div>
          <div class="rename-body">
            <input v-model="widgetNameDraft" class="glass-input" maxlength="20" placeholder="小组件名称" @keyup.enter="commitRenameWidget" />
            <div class="rename-actions">
              <button class="btn-outline" @click="cancelRenameWidget">取消</button>
              <button class="btn-primary" @click="commitRenameWidget">保存</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 新增 / 编辑应用弹窗 --><div v-if="showModal" class="modal-overlay">
        <div class="modal-content glass-strong scrollable editor-modal">
          <div v-if="showIconPicker" class="icon-picker" @click.self="showIconPicker = false">
            <div class="icon-picker-panel">
              <div class="icon-picker-head">
                <AppIcon icon="mdi:view-grid-plus-outline" />
                <span>选一个图标</span>
                <button type="button" @click="showIconPicker = false"><AppIcon icon="mdi:close" /></button>
              </div>
              <input v-model="iconQuery" class="glass-input" type="text" placeholder="搜索：server / cloud / docker…" />
              <div class="icon-picker-grid">
                <button
                  v-for="name in filteredIcons" :key="name" type="button"
                  class="icon-picker-item" :class="{ active: formData.icon === name }"
                  :title="name" @click="pickIcon(name)"
                ><AppIcon :icon="name" /></button>
              </div>
              <p v-if="!filteredIcons.length" class="icon-picker-empty">没找到，可直接在上面输入 Iconify 名称</p>
            </div>
          </div>
          <div class="modal-preview">
            <div class="mp-card" :style="{ background: mpBg }">
              <div class="mp-icon">
                <img v-if="formData.icon && (formData.icon.startsWith('data:') || formData.icon.startsWith('http'))" :src="formData.icon" alt="" />
                <AppIcon v-else :icon="formData.icon || defaultIconForWidget(formData.widgetType)" />
              </div>
              <div class="mp-text">
                <div class="mp-name">{{ formData.name || (formData.widgetType ? '未命名小组件' : '未命名应用') }}</div>
                <div class="mp-meta">{{ formData.group || '书签' }}<template v-if="mpFirstUrl"> · {{ mpFirstUrl }}</template></div>
              </div>
              <span class="mp-badge">{{ editingId ? '编辑中' : '新建' }}</span>
            </div>
          </div>
          <div class="modal-body scrollable">
          <div class="form-row">
            <div class="form-group flex-2"><label>应用名称</label><input v-model="formData.name" type="text" maxlength="20" class="glass-input" /></div>
            <div class="form-group flex-1">
              <label>分组归属</label>
              <SelectBox v-model="formData.group" :options="globalSettings.groups" placeholder="选择分组" />
            </div>
          </div>
          <div class="form-group"><label>描述信息</label><input v-model="formData.description" type="text" maxlength="50" class="glass-input" /></div>

          <div class="form-group">
            <label>桌面小组件（选了就是纯展示块，不用填网址）</label>
            <SelectBox
                              v-model="formData.widgetType"
                              :options="[
                                { label: '普通卡片（填网址）', value: '' },
                                { label: '系统状态 — CPU / 内存 / 磁盘', value: 'system' },
                                { label: '时钟 — 本地时间与日期', value: 'clock' },
                                { label: '天气 — 城市与天气', value: 'weather' },
                              ]"
                              placeholder="普通卡片"
                            />
          </div>

          <div class="form-group" v-if="!formData.widgetType">
            <label>打开方式</label>
            <SelectBox
                              v-model="formData.openMethod"
                              :options="[
                                { label: '新标签页打开', value: 'new_tab' },
                                { label: '当前页打开（同标签）', value: 'same_tab' },
                              ]"
                              placeholder="新标签页打开"
                            />
          </div>

          <div class="form-group" v-if="formData.widgetType === 'weather'">
            <label>天气城市（中文或拼音，重名时用拼音更准：上海 / Shanghai / chengde）</label>
            <input v-model="formData.weatherCity" type="text" maxlength="40" class="glass-input" placeholder="上海" />
          </div>

          <div class="form-group" v-if="!formData.widgetType">
            <label>网址 (失去焦点时自动补齐 http://)</label>
            <div v-for="(u, index) in formData.urls" :key="index" class="url-input-row">
              <input v-model="u.url" type="url" @blur="formatUrl(u)" :placeholder="index === 0 ? '主地址' : '备用地址'" class="glass-input flex-1" />
              <button v-if="index === 0" class="action-btn btn-add" @click="addUrlField">+</button>
              <button v-else class="action-btn btn-remove" @click="removeUrlField(index)">-</button>
            </div>
          </div>

          <div class="form-group" v-if="!formData.widgetType">
            <label>图标 (网络直链/Iconify/本地)</label>
            <div class="icon-upload-row">
              <input v-if="!formData.icon?.startsWith('data:')" v-model="formData.icon" type="text" class="glass-input flex-1" />
              <div v-else class="glass-input flex-1" style="color: #10b981;display:flex;align-items:center;justify-content:space-between;padding:0 12px;height:38px;box-sizing:border-box;">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">✅ 已应用本地图片</span>
                <button style="background:none;border:none;color:#ef4444;cursor:pointer;" @click="clearIcon">清除</button>
              </div>
              <button class="upload-btn" style="height:38px;border:none;" :disabled="fetchingIcon" @click="autoFetchIcon" title="根据第一个网址自动抓取站点图标">
                <AppIcon icon="mdi:magnify" />{{ fetchingIcon ? '抓取中…' : '自动获取' }}
              </button>
              <label class="upload-btn" style="height:38px;display:flex;align-items:center;cursor:pointer;">
                <AppIcon icon="mdi:upload" />本地图片<input type="file" accept="image/*" @change="handleImageUpload" style="display:none;" />
              </label>
            </div>
            <div class="icon-lib-row">
              <button class="icon-lib-btn" type="button" @click="openIconPicker">
                <AppIcon icon="mdi:view-grid-plus-outline" />
                <span>从图标库挑选</span>
                <span class="icon-lib-hint">内置 48 个常用图标，可搜索</span>
              </button>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group flex-1"><label>独立卡片背景色</label><input v-model="formData.bgColor" type="color" class="color-picker" title="留空则跟随全局" /></div>
            <div class="form-group flex-2"><label>透明度 (0-1)</label><input v-model.number="formData.bgOpacity" type="range" min="0" max="1" step="0.1" class="slider" /></div>
          </div>


          
          <div class="form-group row-checkbox">
            <label class="switch"><input type="checkbox" v-model="formData.isHidden"><span class="slider-round"></span></label>
            <span>隐藏这张卡（默认不上首页，快捷键 h 可临时显示）</span>
          </div>
          <div class="form-group row-checkbox">
            <label class="switch"><input type="checkbox" v-model="formData.isMonitored"><span class="slider-round"></span></label>
            <span class="switch-text">设备在线监测</span>
          </div>
          </div>
          <div class="form-group" v-if="formData.isMonitored" style="background: rgba(0,0,0,0.1); padding: 15px; border-radius: 10px;">
            <label style="color: #10b981"><AppIcon icon="mdi:radar" /> Ping / TCP 检测地址</label>
            <input v-model="formData.pingUrl" type="text" class="glass-input full-w mt-2" placeholder="IP或域名 (例: 192.168.1.1 或 google.com:80)" />
            <p style="font-size: 11px; color: color-mix(in srgb, var(--theme-color) 62%, transparent); margin: 8px 0 0 0;">填写端口号则执行精准 TCP 检测，不填则执行 ICMP Ping 探测（容器无 ping 命令时自动降级 TCP）。</p>
          </div>

          <div class="modal-actions">
            <button class="btn-cancel" @click="showModal = false">取消</button>
            <button class="btn-primary" @click="saveItem">保存</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.is-sorting { border: 2px dashed rgba(59, 130, 246, 0.5); padding: 10px; border-radius: 16px; background: rgba(59, 130, 246, 0.05); }
.sort-tip {
  margin: 0 16px 6px;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 13px;
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.12);
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.sort-controls { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: flex; gap: 4px; z-index: 5; }
.sort-controls button {
  width: 34px; height: 34px; border-radius: 8px; border: none;
  background: color-mix(in srgb, var(--theme-color) 18%, transparent); color: #fff; font-size: 16px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.group-section { margin-bottom: 40px; display: flex; flex-direction: column; height: auto; }
.group-title {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 14px; padding: 0 2px 8px;
  font-size: 12.5px; font-weight: 600; letter-spacing: .6px; text-transform: none;
  color: color-mix(in srgb, var(--theme-color) 62%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--theme-color) 9%, transparent);
}
.group-title::before {
  content: ''; width: 3px; height: 12px; border-radius: 2px;
  background: var(--theme-accent, #3b82f6); opacity: .85;
}
.group-fallback-tip { font-size: 12px; font-weight: normal; color: color-mix(in srgb, var(--theme-color) 45%, transparent); }

/* 底部收缩自适应高度网格 */
.icon-grid { display: grid; grid-template-columns: repeat(auto-fill, 220px); grid-auto-rows: 90px; gap: 20px; padding-bottom: 20px; align-content: start; height: auto; }

.dashboard-app {
  position: relative; display: flex; flex-direction: column;
  height: 100vh; height: 100dvh;
  background-color: transparent; color: var(--theme-color, #f8fafc);
  overflow: hidden; z-index: 1;
  transition: background 0.3s, color 0.3s;
}
/* 【性能】原来是 400~500px 的圆 + filter: blur(80px) + 无限 animation，
     每帧都要重做高斯模糊，GPU 持续满载 —— 页面卡顿的主因。
     改成静态径向渐变：视觉几乎一样，渲染成本接近 0。 */
.bg-shape {
  position: absolute; border-radius: 50%;
  z-index: -1; pointer-events: none;
  animation: none; filter: none;
}
.shape-1 { width: 620px; height: 620px; top: -18%; left: -14%; opacity: .5;
  background: radial-gradient(circle, rgba(59,130,246,.55) 0%, rgba(59,130,246,.18) 42%, rgba(59,130,246,0) 70%); }
.shape-2 { width: 720px; height: 720px; bottom: -26%; right: -16%; opacity: .45;
  background: radial-gradient(circle, rgba(139,92,246,.5) 0%, rgba(139,92,246,.16) 44%, rgba(139,92,246,0) 72%); }
/* 节点失联横幅 */
.node-offline-bar {
  position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
  z-index: 10500; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: 12px; font-size: 12.5px;
  background: color-mix(in srgb, #f59e0b 18%, var(--theme-bg, #0f172a));
  border: 1px solid color-mix(in srgb, #f59e0b 45%, transparent);
  color: var(--theme-color);
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, .5);
  animation: op-fade-fast .14s ease;
}
.nob-btn {
  padding: 5px 11px; border-radius: 8px; cursor: pointer; font: inherit;
  font-size: 12px; border: 1px solid color-mix(in srgb, var(--theme-color) 22%, transparent);
  background: transparent; color: inherit;
}
.nob-btn.primary { background: var(--theme-accent, #3b82f6); border-color: transparent; color: #fff; font-weight: 500; }
.nob-btn:hover { opacity: .85; }

.setup-back { margin-top: 14px; text-align: center; font-size: 12px; opacity: .55; }
.link-btn {
  background: none; border: none; padding: 0 2px; cursor: pointer;
  color: var(--theme-accent, #3b82f6); font: inherit; font-size: 12px;
  text-decoration: underline; text-underline-offset: 2px;
}
.link-btn:hover { opacity: .8; }

.login-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; }
.login-box { padding: 40px; border-radius: 20px; width: 350px; text-align: center; }
.login-box h2 { margin-bottom: 20px; }
.mt-3 { margin-top: 16px; } .mt-4 { margin-top: 24px; } .full-w { width: 100%; box-sizing: border-box; }

.glass-strong {
  background: color-mix(in srgb, var(--theme-bg) 80%, transparent) !important;
  backdrop-filter: blur(20px);
  border: 1px solid color-mix(in srgb, var(--theme-color) 15%, transparent) !important;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
}

.top-bar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 24px; margin: 16px; border-radius: 16px;
  background: color-mix(in srgb, var(--theme-bg) 25%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent);
  backdrop-filter: blur(10px);
}
.top-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-actions { display: flex; gap: 12px; flex-shrink: 0; }
.icon-btn { width: 40px; height: 40px; border-radius: 12px; border: none; background: color-mix(in srgb, var(--theme-color) 12%, transparent); color: var(--theme-color); font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
.icon-btn:hover { background: color-mix(in srgb, var(--theme-color) 22%, transparent); transform: scale(1.05); }
.icon-btn.primary { background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; }
.desktop-area { flex: 1; padding: 30px 32px 20px; overflow-y: auto; overscroll-behavior: contain; }

.app-card {
  height: 100%; position: relative; border-radius: 16px; cursor: pointer;
  overflow: hidden; display: flex; align-items: center;
  background: color-mix(in srgb, var(--theme-bg) 50%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent);
  transition: transform .2s cubic-bezier(.16,1,.3,1),
              box-shadow .2s cubic-bezier(.16,1,.3,1),
              border-color .2s ease;
  will-change: transform;
}
.app-card:hover {
  transform: translateY(-3px);
  /* 边框只提一点点，主要靠光晕和阴影立起来（原来 24% 太抢眼） */
  border-color: color-mix(in srgb, var(--theme-color) 15%, transparent);
  box-shadow:
    0 0 22px -4px color-mix(in srgb, var(--theme-accent, #3b82f6) 26%, transparent),
    0 10px 24px -10px rgba(0, 0, 0, .42);
}
/* 右键打开菜单时保持"悬浮"状态，鼠标移到菜单上不会掉回去 */
.app-card.is-context-open {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--theme-color) 15%, transparent);
  box-shadow:
    0 0 22px -4px color-mix(in srgb, var(--theme-accent, #3b82f6) 26%, transparent),
    0 10px 24px -10px rgba(0, 0, 0, .42);
}

.app-card:active { transform: translateY(-1px) scale(.996); }
/* 已移除重复的旧版 .app-card:hover（会覆盖新版效果） */
/* 【v3.7.1】大尺寸卡片排版：不要单行横向居中留一堆空白 */
.app-card.is-large .card-content,
.app-card.is-wide .card-content,
.app-card.is-tall .card-content {
  flex-direction: column;
  justify-content: center;
  text-align: center;
  gap: 10px;
  padding: 18px;
}
.app-card.is-large .icon-container,
.app-card.is-tall .icon-container {
  width: 60px; height: 60px; font-size: 30px;
}
.app-card.is-large .app-name { font-size: 15px; }
.app-card.is-large .app-desc,
.app-card.is-wide .app-desc {
  display: block;
  font-size: 11.5px;
  opacity: .6;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.app-card.is-wide .card-content { flex-direction: row; text-align: left; }
.app-card.is-wide .icon-container { width: 52px; height: 52px; }

.card-content { display: flex; align-items: center; gap: 12px; width: 100%; padding: 16px; position: relative; z-index: 2; }
.icon-container {
  flex-shrink: 0; width: 48px; height: 48px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  /* 【可读性】深色/透明 PNG 图标（如 GitHub 黑猫）在暗色卡片上会隐身，
     给一层极淡底板 + 内边距，既保住轮廓又让卡片阵列更整齐 */
  background: color-mix(in srgb, var(--theme-color) 9%, transparent);
  padding: 6px;
}
.app-icon { font-size: 40px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); }
.app-img-icon { width: 100%; height: 100%; object-fit: contain; border-radius: 10px; }
.text-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.app-name { font-size: 15px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 2px 4px rgba(0,0,0,0.2); }
.app-desc { font-size: 12px; color: color-mix(in srgb, var(--theme-color) 75%, transparent); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; }

.status-glow { position: absolute; bottom: 0; left: 0; right: 0; height: 4px; opacity: 0.8; pointer-events: none; z-index: 1; border-radius: 0 0 16px 16px; }
.status-online { background: #10b981; box-shadow: 0 -2px 8px #10b981; }
.status-suspected { background: #f59e0b; box-shadow: 0 -2px 8px #f59e0b; }
.status-offline { background: #ef4444; box-shadow: 0 -2px 8px #ef4444; }

.no-select-title { user-select: none; cursor: pointer; color: color-mix(in srgb, var(--theme-color) 60%, transparent); transition: 0.2s; }
.no-select-title:hover { color: var(--theme-color); text-shadow: 0 0 8px color-mix(in srgb, var(--theme-color) 50%, transparent); }

/* ===== v2.2.0：置顶 / 隐藏 / 内嵌卡懒加载 ===== */
.card-flags {
  position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; z-index: 3;
  font-size: 13px; opacity: .9; pointer-events: none;
}
.card-flags span {
  width: 20px; height: 20px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  background: rgba(15,23,42,0.55); color: #fbbf24;
}
.card-flags span:last-child { color: color-mix(in srgb, var(--theme-color) 62%, transparent); }
.app-card.is-hidden-card { opacity: .55; border-style: dashed !important; filter: saturate(.6); }
.app-card.is-hidden-card:hover { opacity: .92; filter: none; }

/* 快捷键说明 */
.shortcut-box { padding: 18px 20px; gap: 14px; }
.shortcut-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: bold; }
.shortcut-title .app-svg-icon { font-size: 20px; }
.shortcut-title .close-btn { margin-left: auto; }
.shortcut-title .widget-add-btn { margin-left: auto; }
.shortcut-title .widget-add-btn + .close-btn { margin-left: 6px; }
.shortcut-list { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.shortcut-row { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.shortcut-row kbd {
  min-width: 64px; text-align: center; padding: 4px 8px; border-radius: 6px;
  background: color-mix(in srgb, var(--theme-color) 16%, transparent); border: 1px solid color-mix(in srgb, var(--theme-color) 24%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
.shortcut-foot { font-size: 12px; opacity: .65; }

/* ===== v2.6.0：卡片备忘录 ===== */
.menu-badge {
  margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: rgba(251,191,36,.18); color: #fbbf24;
}
.menu-hint { margin-left: auto; font-size: 10px; opacity: .45; }
.card-flags span.flag-memo { color: #fbbf24; }
.memo-modal {
  width: min(560px, calc(100vw - 24px));
  /* 【修复】之前继承了 modal-content 的 padding:0，内容直接贴边框 */
  padding: 22px 24px 20px;
  border: 1px solid color-mix(in srgb, var(--theme-color) 22%, transparent) !important;
}
.memo-modal h3 { margin: 0 0 16px; font-size: 15px; }
.memo-modal .form-group { margin-bottom: 16px; }
.memo-modal .form-group:last-child { margin-bottom: 4px; }
.memo-note { resize: vertical; min-height: 92px; line-height: 1.55; font-size: 13px; }
.memo-count { font-size: 11px; opacity: .45; text-align: right; margin-top: 4px; }
.memo-entry { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.memo-entry-label { width: 120px; flex-shrink: 0; }
.memo-entry-value { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.memo-icon-btn {
  width: 32px; height: 32px; flex-shrink: 0; border-radius: 8px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--theme-color) 18%, transparent); background: color-mix(in srgb, var(--theme-color) 10%, transparent);
  color: inherit; display: flex; align-items: center; justify-content: center; font-size: 15px;
}
.memo-icon-btn:hover { background: color-mix(in srgb, var(--theme-color) 22%, transparent); }
.memo-icon-btn.locked { color: #fbbf24; }
.memo-icon-btn.danger { color: #ef4444; }
.memo-add {
  display: flex; align-items: center; gap: 6px; margin-top: 4px; padding: 7px 12px;
  border-radius: 8px; cursor: pointer; font-size: 12px; color: #10b981;
  border: 1px dashed rgba(100,255,218,.4); background: transparent;
}
.memo-add:hover { background: rgba(100,255,218,.1); }

/* ===== v2.3.0：系统状态面板 ===== */
.sys-box { padding: 18px 20px; gap: 14px; width: min(520px, calc(100vw - 24px)); }
.sys-live {
  font-size: 11px; font-weight: normal; padding: 2px 8px; border-radius: 999px;
  color: #10b981; background: rgba(16,185,129,.14); border: 1px solid rgba(16,185,129,.35);
}
.sys-live.off { color: #f59e0b; background: rgba(245,158,11,.14); border-color: rgba(245,158,11,.35); }
.sys-body { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
.sys-metric { display: flex; flex-direction: column; gap: 6px; }
.sys-metric-head { display: flex; justify-content: space-between; font-size: 13px; opacity: .92; }
.sys-bar { height: 8px; border-radius: 999px; background: color-mix(in srgb, var(--theme-color) 14%, transparent); overflow: hidden; }
.sys-bar i { display: block; height: 100%; border-radius: 999px; transition: width .45s ease; background: linear-gradient(90deg, #22c55e, #16a34a); }
.sys-bar i.warn { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
.sys-bar i.danger { background: linear-gradient(90deg, #f87171, #ef4444); }
.sys-sub { font-size: 11.5px; opacity: .6; word-break: break-all; }
.sys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.sys-grid div { display: flex; flex-direction: column; gap: 2px; font-size: 12px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--theme-color) 8%, transparent); }
.sys-grid span { opacity: .55; font-size: 11px; }
.sys-grid b { font-weight: 600; word-break: break-all; }
.sys-loading { font-size: 13px; opacity: .7; padding: 18px 0; text-align: center; }

/* ===== v2.3.0：内嵌卡加载失败兜底 ===== */
.widget-body { position: relative; }

.context-menu {
  position: fixed; width: 208px; border-radius: 14px; padding: 8px; z-index: 1000;
  animation: op-pop-in .18s cubic-bezier(.16,1,.3,1);
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 12%, transparent);
  color: var(--theme-color);
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  max-height: 70vh; overflow-y: auto;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .42), 0 2px 8px rgba(0, 0, 0, .24);
}
@keyframes scaleIn { 0% { opacity: 0; transform: scale(0.95); } 100% { opacity: 1; transform: scale(1); } }
.menu-header { padding: 4px 16px 8px; font-size: 12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent); margin-bottom: 4px; }
/* 尺寸选择（批次 2.2） */
.menu-size-row { display: flex; gap: 6px; padding: 4px 10px 8px; }
.menu-size-btn { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
  border-radius: 8px; border: 1px solid color-mix(in srgb, var(--theme-color) 16%, transparent); background: color-mix(in srgb, var(--theme-color) 6%, transparent); cursor: pointer; }
.menu-size-btn:hover { background: color-mix(in srgb, var(--theme-color) 12%, transparent); }
.menu-size-btn.active { border-color: var(--accent, #60a5fa); background: rgba(96,165,250,.18); }
.menu-size-btn .size-box { display: block; border-radius: 2px; background: color-mix(in srgb, var(--theme-color) 57%, transparent); }
.menu-header.sub { font-size: 11px; opacity: .5; padding: 2px 10px; }

.menu-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; margin: 1px 0;
  font-size: 13px; border-radius: 10px; cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.menu-item:hover { background: color-mix(in srgb, var(--theme-color) 11%, transparent); }
.menu-item:active { background: color-mix(in srgb, var(--theme-color) 15%, transparent); }
/* 已移除重复的旧版 .menu-item:hover（会覆盖新版效果） */
.menu-item.text-danger { color: #ef4444; }
.menu-divider { height: 1px; background: color-mix(in srgb, var(--theme-color) 10%, transparent); margin: 4px 0; }

.window-manager { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; }
.app-window { position: absolute; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; pointer-events: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.4); border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); }
.app-window.maximized { border-radius: 0; }
.window-header { height: 40px; background: color-mix(in srgb, var(--theme-bg) 80%, black); color: var(--theme-color); display: flex; justify-content: space-between; align-items: center; padding: 0 16px; cursor: grab; touch-action: none; }
.window-header:active { cursor: grabbing; }
.window-controls { display: flex; gap: 8px; }
.win-btn {
  width: 26px; height: 26px; border-radius: 50%; border: none;
  background: color-mix(in srgb, var(--theme-color) 12%, transparent); color: var(--theme-color);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  transition: background .14s ease, transform .14s ease;
}
.win-btn:hover { background: color-mix(in srgb, var(--theme-color) 22%, transparent); }
.win-btn:active { transform: scale(.9); }
/* 已移除重复的旧版 .win-btn:hover（会覆盖新版效果） */
.close-btn:hover { background: #ef4444; color: white; }
.window-body { flex: 1; background: #ffffff; }
.window-body iframe { width: 100%; height: 100%; display: block; }

.dock-area { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; z-index: 20; max-width: 90vw; overflow-x: auto; }
.dock-item { padding: 10px 20px; border-radius: 20px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 14px; background: color-mix(in srgb, var(--theme-bg) 70%, transparent); color: var(--theme-color); border: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent); backdrop-filter: blur(10px); white-space: nowrap; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 100; backdrop-filter: blur(2px); }
.modal-content {
  width: 480px; max-width: calc(100vw - 24px); padding: 24px; border-radius: 24px;
  display: flex; flex-direction: column;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 90%, transparent) !important;
  backdrop-filter: blur(24px) saturate(1.5);
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  color: var(--theme-color) !important;
  border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent) !important;
  box-shadow: 0 32px 80px -12px rgba(0, 0, 0, .6), 0 2px 10px rgba(0, 0, 0, .3);
  animation: op-pop-in .2s cubic-bezier(.16,1,.3,1);
}
.modal-content.scrollable { max-height: 85vh; max-height: 85dvh; overflow-y: auto; }
.modal-content::-webkit-scrollbar { width: 6px; }
.modal-content::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--theme-color) 20%, transparent); border-radius: 3px; }
.form-group { margin-bottom: 16px; display: flex; flex-direction: column; }
.form-row { display: flex; gap: 12px; }
.flex-1 { flex: 1; } .flex-2 { flex: 2; }
.form-group > label { font-size: 12px; margin-bottom: 6px; color: color-mix(in srgb, var(--theme-color) 75%, transparent) !important; }

/* 原生 select 在暗色主题下会退化成白底白字（修 2） */
select.glass-input {
  appearance: none; -webkit-appearance: none;
  background-color: color-mix(in srgb, var(--theme-color) 10%, transparent);
  color: inherit;
  color-scheme: dark;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 16px) calc(50% - 2px), calc(100% - 11px) calc(50% - 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 28px;
}
select.glass-input option { background-color: var(--theme-bg, #0f172a); color: var(--theme-color); }

.glass-input {
  background: color-mix(in srgb, var(--theme-color) 10%, transparent) !important;
  border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent) !important;
  padding: 10px 12px; border-radius: 10px; color: var(--theme-color) !important;
  outline: none; font-size: 14px;
}
.color-picker { -webkit-appearance: none; border: none; width: 100%; height: 38px; border-radius: 10px; cursor: pointer; background: none; }
.color-picker::-webkit-color-swatch { border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); border-radius: 10px; }
.url-input-row, .icon-upload-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
/* 行内控件统一 38px 高，杜绝 input/按钮/label 高度不一 */
.icon-upload-row .glass-input, .url-input-row .glass-input { height: 38px; padding: 0 12px; line-height: 36px; }
.icon-upload-row .upload-btn, .icon-upload-row button.upload-btn { margin-bottom: 0; }
.action-btn { width: 38px; height: 38px; border-radius: 10px; border: none; font-size: 18px; color: white; cursor: pointer; flex-shrink: 0; }
.btn-add { background: rgba(16, 185, 129, 0.4); } .btn-remove { background: rgba(239, 68, 68, 0.4); }
.upload-btn { background: color-mix(in srgb, var(--theme-color) 10%, transparent); padding: 0 12px; height: 38px; border-radius: 10px; display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 13px; border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); color: var(--theme-color); flex-shrink: 0; }
.upload-btn:hover { background: color-mix(in srgb, var(--theme-color) 20%, transparent); }

/* 编辑弹窗里的开关行：文字比正文稍小，长说明拆成次级小字 */
.switch-text { font-size: 12.5px; line-height: 1.5; display: flex; flex-direction: column; gap: 2px; }
.switch-text i { font-style: normal; font-size: 11px; opacity: .5; }
.row-checkbox { font-size: 12.5px; 
  flex-direction: row; align-items: center; gap: 12px;
  background: color-mix(in srgb, var(--theme-color) 5%, transparent) !important;
  padding: 12px; border-radius: 10px;
}
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider-round { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: color-mix(in srgb, var(--theme-color) 25%, transparent); transition: .4s; border-radius: 22px; }
.slider-round:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
input:checked + .slider-round { background-color: #10b981; }
input:checked + .slider-round:before { transform: translateX(18px); }
.slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--theme-color) 20%, transparent); margin-top: 15px; }
.slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #64ffda; cursor: pointer; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 15px; }
.btn-primary {
  background: var(--theme-accent, #3b82f6);
  color: #fff; border: none; padding: 10px 20px; border-radius: 10px;
  cursor: pointer; font-weight: 600; font-size: 13px;
  box-shadow: 0 2px 12px -2px color-mix(in srgb, var(--theme-accent, #3b82f6) 55%, transparent);
  transition: filter .14s ease, transform .14s ease, box-shadow .14s ease;
}
.btn-primary:hover { filter: brightness(1.08); box-shadow: 0 4px 18px -2px color-mix(in srgb, var(--theme-accent, #3b82f6) 62%, transparent); }
.btn-primary:active { transform: scale(.97); }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn-cancel { background: color-mix(in srgb, var(--theme-color) 10%, transparent); color: var(--theme-color); border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); padding: 10px 20px; border-radius: 10px; cursor: pointer; }

.custom-footer {
  text-align: center; padding: 10px; font-size: 12px;
  color: color-mix(in srgb, var(--theme-color) 60%, transparent); z-index: 2;
  background: color-mix(in srgb, var(--theme-bg) 20%, transparent);
  flex-shrink: 0;
  backdrop-filter: blur(10px);
}
.empty-tip { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px; border-radius: 20px; margin: 20px; }
.empty-icon { font-size: 48px; opacity: 0.6; }

/* ====== 全局搜索浮层 ====== */
.search-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.45); display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; backdrop-filter: blur(3px); }
.search-box {
  width: min(580px, calc(100vw - 24px)); border-radius: 18px; overflow: hidden;
  display: flex; flex-direction: column; max-height: 70vh;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  transition: backdrop-filter .46s ease, box-shadow .46s ease, border-color .2s ease;
  animation: op-pop-in .18s cubic-bezier(.16,1,.3,1);
}
.search-box:focus-within {
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  border-color: color-mix(in srgb, var(--theme-color) 20%, transparent);
  box-shadow: 0 0 30px -5px rgba(0, 0, 0, .45), 0 18px 48px rgba(0, 0, 0, .35);
}
.search-bar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent); }
.search-bar-icon { font-size: 20px; opacity: 0.6; flex-shrink: 0; }
.search-input { flex: 1; background: transparent; border: none; outline: none; font-size: 16px; color: var(--theme-color); }
.search-results { overflow-y: auto; padding: 6px; }
.search-result-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border-radius: 12px; cursor: pointer;
  transition: background .14s ease, transform .14s ease;
}
.search-result-item:hover { background: color-mix(in srgb, var(--theme-color) 8%, transparent); }
.search-result-item.active {
  background: color-mix(in srgb, var(--theme-accent, #3b82f6) 20%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-accent, #3b82f6) 45%, transparent) inset;
}
/* 已移除重复的旧版 .search-result-item.active（会覆盖新版效果） */
.search-icon { width: 32px; height: 32px; font-size: 28px; object-fit: contain; border-radius: 8px; flex-shrink: 0; }
.search-text { flex: 1; overflow: hidden; }
.search-name { font-size: 14px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.search-group { font-size: 11px; font-weight: normal; opacity: 0.6; margin-left: 6px; }
.search-url { font-size: 12px; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 快捷操作（批次 2.1） */
.uptime-box { max-width: 620px; }
.uptime-title { flex: 1; font-size: 14px; opacity: .9; }
.uptime-body { padding: 14px 16px 18px; }
.uptime-summary { font-size: 13px; margin-bottom: 12px; opacity: .85; }
.uptime-summary b { font-size: 16px; }
.uptime-count { opacity: .5; font-size: 12px; }
.uptime-bars { display: flex; gap: 2px; align-items: flex-end; height: 44px; flex-wrap: wrap; }
.uptime-bar { width: 6px; height: 100%; border-radius: 2px; opacity: .85; }
.uptime-bar.ok { background: #10b981; }
.uptime-bar.bad { background: #ef4444; }
.offline-bar {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin: 10px auto 0; max-width: 720px; padding: 8px 14px; border-radius: 999px;
  font-size: 12.5px; background: rgba(245,158,11,.16); color: #fbbf24;
  border: 1px solid rgba(245,158,11,.3);
}
.search-actions { padding: 6px 8px 10px; border-top: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent); }
.search-action { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px;
  font-size: 13px; cursor: pointer; opacity: .85; }
.search-action:hover, .search-action.active { background: color-mix(in srgb, var(--theme-color) 10%, transparent); opacity: 1; }

.search-engine-btn {
  display: inline-flex; align-items: center; gap: 6px; margin-top: 10px;
  padding: 8px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--theme-color) 16%, transparent);
  background: color-mix(in srgb, var(--theme-color) 8%, transparent);
  color: inherit; font: inherit; font-size: 12.5px; cursor: pointer;
  transition: background .14s ease;
}
.search-engine-btn:hover { background: color-mix(in srgb, var(--theme-color) 15%, transparent); }

/* 小组件选择器 */
.widget-picker-box { width: min(460px, calc(100vw - 24px)); }
.widget-choices { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 6px; }
.widget-choice {
  display: flex; align-items: center; gap: 12px; padding: 13px 14px;
  border-radius: 14px; cursor: pointer; text-align: left;
  border: 1px solid color-mix(in srgb, var(--theme-color) 12%, transparent);
  background: color-mix(in srgb, var(--theme-color) 5%, transparent);
  color: inherit; font: inherit;
  transition: background .15s ease, border-color .15s ease, transform .15s ease;
}
.widget-choice:hover {
  background: color-mix(in srgb, var(--theme-color) 9%, transparent);
  border-color: color-mix(in srgb, var(--theme-accent, #3b82f6) 45%, transparent);
  transform: translateY(-1px);
}
.wc-icon { font-size: 24px; opacity: .85; flex-shrink: 0; }
.wc-text { display: flex; flex-direction: column; gap: 3px; }
.wc-text b { font-size: 13.5px; font-weight: 600; }
.wc-text span { font-size: 11.5px; opacity: .55; }
.wc-plus { margin-left: auto; opacity: .4; }
.widget-hint { font-size: 11.5px; opacity: .45; padding: 4px 16px 14px; }
.widget-rename-box { width: min(380px, calc(100vw - 24px)); }
.rename-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.rename-actions { display: flex; justify-content: flex-end; gap: 8px; }
.widget-add-btn { font-size: 15px; line-height: 1; padding: 0 0 2px; font-weight: 500; opacity: .72; }
.widget-add-btn:hover { opacity: 1; }

.search-empty { padding: 24px; text-align: center; opacity: 0.5; font-size: 13px; }

/* ---- 图标库（v3.5.4） ---- */
.icon-lib-row { margin-top: 8px; }
.icon-lib-btn {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; border-radius: 10px;
  border: 1px dashed color-mix(in srgb, var(--theme-color) 16%, transparent);
  background: color-mix(in srgb, var(--theme-color) 4%, transparent);
  color: inherit; font: inherit; font-size: 12.5px; cursor: pointer;
  transition: background .14s ease, border-color .14s ease;
}
.icon-lib-btn:hover { background: color-mix(in srgb, var(--theme-color) 9%, transparent); border-color: color-mix(in srgb, var(--theme-accent, #3b82f6) 55%, transparent); }
.icon-lib-hint { margin-left: auto; font-size: 11px; opacity: .45; }
.icon-picker { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  background: rgba(6, 10, 18, .45); backdrop-filter: blur(4px); border-radius: inherit; }
.icon-picker-panel { width: min(460px, calc(100% - 28px)); max-height: 66%; display: flex; flex-direction: column; gap: 10px; padding: 14px;
  border-radius: 16px; /* 【修复】96% 太实，在半透明弹窗底部成了一道"白印"，改成和弹窗本体一致的 90% */
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 90%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 18%, transparent);
  box-shadow: 0 24px 64px -12px rgba(0, 0, 0, .55); }
.icon-picker-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.icon-picker-head button { margin-left: auto; width: 26px; height: 26px; border: none; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer; opacity: .6; }
.icon-picker-head button:hover { opacity: 1; background: color-mix(in srgb, var(--theme-color) 12%, transparent); }
.icon-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(42px, 1fr)); gap: 6px; overflow-y: auto; padding: 2px; }
.icon-picker-item { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border-radius: 10px;
  border: 1px solid transparent; background: color-mix(in srgb, var(--theme-color) 5%, transparent);
  color: inherit; font-size: 18px; cursor: pointer; transition: background .14s ease, border-color .14s ease; }
.icon-picker-item:hover { background: color-mix(in srgb, var(--theme-color) 13%, transparent); }
.icon-picker-item.active { border-color: var(--theme-accent, #3b82f6); }
.icon-picker-empty { font-size: 12px; opacity: .5; text-align: center; padding: 6px; }

/* ---- 编辑弹窗三段式（v3.5.4）：预览头 / 滚动表单 / 固定按钮 ---- */
.modal-content {
  position: relative;
  max-height: min(86vh, 760px);
  display: flex; flex-direction: column;
  overflow: hidden;
}
/* 只有"编辑卡片"用三段式无内边距布局（预览头 / 滚动体 / 固定按钮自带 padding） */
.modal-content.editor-modal { padding: 0; }
.modal-preview {
  flex-shrink: 0; position: relative;
  padding: 16px 20px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-color) 9%, transparent);
}
.mp-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; }
.mp-icon { width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  border-radius: 12px; font-size: 22px; background: color-mix(in srgb, var(--theme-color) 8%, transparent); overflow: hidden; }
.mp-icon img { width: 100%; height: 100%; object-fit: cover; }
.mp-text { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.mp-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-meta { font-size: 11.5px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-badge { position: absolute; top: 16px; right: 20px; font-size: 10px; padding: 2px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--theme-accent, #3b82f6) 20%, transparent); color: var(--theme-accent, #3b82f6); }
.modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 20px 8px; }
.modal-content .modal-actions {
  position: static; flex-shrink: 0; margin: 0; padding: 14px 20px;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 96%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--theme-color) 9%, transparent);
}
</style>

<style>
/* ============================================================
   📱 移动端适配（非 scoped，因为要穿透子组件）
   ============================================================ */
@media (max-width: 768px) {
  /* ① 清掉一切桌面网格坐标：内联 gridColumn 会制造隐式列，把卡片挤出屏幕 */
  .icon-grid { grid-template-columns: 1fr !important; gap: 10px !important; padding: 12px 6px !important; grid-auto-rows: auto !important; }
  .icon-grid > * { grid-column: auto / span 1 !important; grid-row: auto / span 1 !important; }

  .app-card { display: flex !important; align-items: center !important; padding: 10px 16px !important; min-height: auto !important; height: 68px !important; border-radius: 12px !important; box-sizing: border-box !important; }
  .app-card .icon-container { width: 38px !important; height: 38px !important; margin: 0 14px 0 0 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
  .app-card .icon-container .app-icon { font-size: 32px !important; }
  .app-card .app-name { font-size: 18px !important; margin: 0 !important; font-weight: bold !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
  .app-card .app-desc { display: none !important; }

  /* ② 顶栏收窄 + 标题允许截断，避免把按钮挤没 */
  .top-bar { padding: 10px 8px !important; margin: 10px 6px !important; margin-top: max(10px, env(safe-area-inset-top)) !important; border-radius: 12px !important; }
  .top-bar h2 { font-size: 16px !important; margin: 0 !important; min-width: 0; flex: 1; }
  .top-bar h2 svg, .top-bar h2 .app-svg-icon { font-size: 22px !important; }
  .top-actions { gap: 4px !important; }
  .top-bar .icon-btn { width: 44px !important; height: 44px !important; border-radius: 8px !important; font-size: 20px !important; padding: 0 !important; }
  /* 手机上没键盘，快捷键入口只会挤占顶栏 */
  /* 排序模式按钮：排序中显示"完成"，宽度平滑变化（替代原来另加一个"一键整理"按钮） */
.shortcut-title .widget-add-btn {
  margin-left: auto;
  /* 全角"＋"字形偏下，校正基线让它和"×"视觉居中 */
  font-size: 15px; line-height: 1; padding: 0 0 2px;
}
.top-bar .icon-btn.sort-btn { width: auto; min-width: 40px; padding: 0 12px; gap: 5px; transition: padding .16s ease, background .16s ease; }
.top-bar .icon-btn.sort-btn .sort-done-text { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .top-bar .icon-btn.sys-btn { display: none !important; }
  /* 隐藏卡角标在手机上缩一点，别压住卡片标题 */
  .card-flags { top: 4px !important; right: 4px !important; font-size: 12px !important; }
  /* 备忘录：手机上名称 / 内容各占一行，按钮换到下一行，别挤成一坨 */
  .memo-entry { flex-wrap: wrap !important; row-gap: 6px !important; }
  .memo-entry-label { order: 1 !important; flex: 1 1 auto !important; width: auto !important; }
  .memo-icon-btn { order: 2 !important; }
  .memo-entry-value { order: 3 !important; flex: 1 1 100% !important; width: 100% !important; }
  .memo-icon-btn { width: 44px !important; height: 44px !important; }
  .memo-note { min-height: 84px !important; }
  .card-flags span { width: 18px !important; height: 18px !important; }
  .shortcut-row kbd { min-width: 52px !important; }

  /* ③ 弹窗适配：修掉写错的死选择器，真正命中 .modal-content */
  .settings-container { width: 100vw !important; max-width: 100vw !important; height: 100dvh !important; border-radius: 0 !important; margin: 0 !important; border: none !important; box-sizing: border-box !important; }
  .modal-content { width: calc(100vw - 24px) !important; max-width: calc(100vw - 24px) !important; max-height: min(85dvh, 100dvh - 24px) !important; padding: 16px !important; }
  .modal-content.editor-modal { padding: 0 !important; }
  .login-box { width: calc(100vw - 32px) !important; padding: 24px !important; }

  .settings-header { height: 50px !important; padding: 0 15px !important; }
  .settings-header h3 { font-size: 15px !important; }
  .settings-header .win-btn { width: 44px !important; height: 44px !important; border-radius: 10px !important; }

  .settings-body { flex-direction: column !important; overflow: hidden !important; }
  .sidebar { width: 100% !important; flex-direction: row !important; overflow-x: auto !important; white-space: nowrap !important; border-right: none !important; border-bottom: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent) !important; padding: 0 !important; background: color-mix(in srgb, var(--theme-color) 2%, transparent) !important; flex-shrink: 0 !important; }
  .sidebar li { padding: 14px 16px !important; font-size: 13.5px !important; display: inline-flex !important; border-right: none !important; border-bottom: 2px solid transparent; min-height: 44px; align-items: center; }
  .sidebar li.active { border-right: none !important; border-bottom: 2px solid #3b82f6 !important; background: transparent !important; }

  .content-area { padding: 12px !important; overflow-y: auto !important; box-sizing: border-box !important; }
  .setting-block { padding: 12px !important; margin-bottom: 10px !important; border-radius: 10px !important; box-sizing: border-box !important; width: 100% !important; }
  .setting-block h4 { font-size: 13.5px !important; margin-bottom: 10px !important; }
  .setting-block p { font-size: 11px !important; line-height: 1.4 !important; }

  .form-row { flex-direction: column !important; gap: 8px !important; width: 100% !important; box-sizing: border-box !important; }
  .form-group { width: 100% !important; margin-bottom: 8px !important; box-sizing: border-box !important; }
  .form-group label { font-size: 11px !important; margin-bottom: 4px !important; }

  /* ④ 16px 输入框：既放开缩放，又阻止 iOS 聚焦自动放大 */
  .glass-input, .modal-content:not(.editor-modal) select, .modal-content input, .setting-block input, .setting-block select, .setting-block textarea { font-size: 16px !important; padding: 10px 12px !important; border-radius: 8px !important; width: 100% !important; box-sizing: border-box !important; }
  .setting-block input, .setting-block select, .setting-block textarea { scroll-margin-bottom: 96px; }

  .row-checkbox { padding: 10px 12px !important; font-size: 13px !important; border-radius: 8px !important; }

  .settings-footer, .modal-actions { padding: 8px 12px !important; padding-bottom: calc(8px + env(safe-area-inset-bottom)) !important; height: auto !important; flex-shrink: 0 !important; gap: 10px !important; }
  .settings-footer button, .content-area button, .modal-content button { padding: 10px 16px !important; font-size: 13.5px !important; min-height: 44px !important; border-radius: 8px !important; }
  /* 分组标签的小删除键别被上面的通用规则撑大 */
  .content-area .group-tag button { min-height: 0 !important; height: auto !important; padding: 0 4px !important; font-size: 16px !important; }

  /* ⑤ 菜单夹边 + 触控目标 */
  .context-menu { width: 210px !important; max-height: 60vh !important; }
  .menu-item { padding: 14px 16px !important; font-size: 14px !important; min-height: 44px; }

  /* ⑥ 页脚/坞站避让 Home 指示条 */
  .custom-footer { padding-bottom: calc(10px + env(safe-area-inset-bottom)) !important; }
  .dock-area { bottom: calc(20px + env(safe-area-inset-bottom)) !important; }

  /* ⑦ 手机端隐藏小窗入口与坞站 */
  .mobile-hide { display: none !important; }
  .app-window { left: 0 !important; top: 0 !important; width: 100vw !important; height: 100dvh !important; border-radius: 0 !important; z-index: 9999 !important; }
  .dock-area { display: none !important; }

  .sort-controls button { width: 40px; height: 40px; }
}

/* ============================================================
   v3.5.0 统一细节（覆盖散落各处的零散样式）
   ============================================================ */
/* 卡片里的图标/文字在 hover 时轻微上移，和卡片位移形成层次 */
.app-card .icon-container,
.app-card .card-content > * {
  transition: transform .2s cubic-bezier(.16,1,.3,1);
}
.app-card:hover .icon-container { transform: scale(1.04); }

/* 分组之间的呼吸感 */
.group-section + .group-section { margin-top: 28px; }

/* 顶栏按钮统一成圆形图标按钮的观感 */
.top-bar button, .icon-btn {
  transition: background .14s ease, color .14s ease, transform .14s ease;
}
.top-bar button:active, .icon-btn:active { transform: scale(.94); }

/* 焦点可见（键盘用户） */
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--theme-accent, #3b82f6) 70%, transparent);
  outline-offset: 2px;
}

/* 弹层遮罩统一 */
.modal-overlay, .search-overlay {
  background: rgba(6, 10, 18, .55) !important;
  backdrop-filter: blur(6px);
  animation: op-fade-in .16s ease;
}

</style>
