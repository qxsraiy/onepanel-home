<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import { saveAs } from 'file-saver'
import SelectBox from './SelectBox.vue'
import PasskeyPanel from './PasskeyPanel.vue'
import ApiDocs from './ApiDocs.vue'
import AboutPanel from './AboutPanel.vue'
import ExtensionPanel from './ExtensionPanel.vue'
import GroupManager from './GroupManager.vue'
import SyncPanel from './SyncPanel.vue'
import { readJSON, writeText, safeHex, toast } from '../utils/common'
import { applyThemeToBody, DEFAULT_BG, DEFAULT_COLOR } from '../utils/theme'

// 两步确认（替代原生 confirm：原生弹窗白底黑字，破坏沉浸感）
const armedActions = new Set()
const armConfirm = (key, hint) => {
  if (armedActions.has(key)) { armedActions.delete(key); return true }
  armedActions.add(key)
  toast(hint || '再点一次确认', 'warn', 4000)
  setTimeout(() => armedActions.delete(key), 5000)
  return false
}

const props = defineProps({
  settings: Object,
  // 打开时直接落到某个 tab（全局搜索的快捷操作会传 'sync'）
  initialTab: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save', 'refresh-items'])

// ====== 1. 核心状态初始化 ======
// ⚠️ localStorage 读取必须走 safeParse，脏数据会直接白屏整个设置面板
const parsedSettings = JSON.parse(JSON.stringify(props.settings || {}))

const localSettings = ref({
  ...parsedSettings,
  themeBg: safeHex(readJSON('themeBg', null) ?? localStorage.getItem('themeBg'), null) || parsedSettings.themeBg || DEFAULT_BG,
  themeColor: safeHex(localStorage.getItem('themeColor'), null) || parsedSettings.themeColor || DEFAULT_COLOR,
  themeAccent: safeHex(parsedSettings.themeAccent, null) || '#3b82f6',
  siteTitle: parsedSettings.siteTitle || '个人数字枢纽',
})

// 初始化后的“对比快照”，解决关闭时弹窗误报
const initialSettingsStr = ref(JSON.stringify(localSettings.value))

// 弹窗打开期间外部数据变化时对齐快照
watch(() => props.settings, (newVal) => {
  if (!newVal) return
  Object.assign(localSettings.value, newVal)
  initialSettingsStr.value = JSON.stringify(localSettings.value)
}, { deep: true })

// ====== 2. 各功能模块状态 ======
const activeTab = ref(props.initialTab || 'personalize')
// 父组件切换 initialTab 时同步（showSettings 复用同一实例）
watch(() => props.initialTab, (v) => { if (v) activeTab.value = v })

// ---- 转移导出（v2.8.0）：换机 / 搬家用，必须二次验证身份 ----
const transferOpen = ref(false)
const transferBusy = ref(false)
const transferForm = ref({ password: '', code: '' })
const twoFactorEnabled = ref(false)
const transferMode = ref('export')      // export | import
const transferImportMode = ref('replace') // replace | merge
const transferPayload = ref(null)
const transferItemCount = ref(0)

const openTransfer = async (mode = 'export') => {
  transferForm.value = { password: '', code: '' }
  transferMode.value = mode
  if (mode === 'export') { transferPayload.value = null; transferItemCount.value = 0 }
  transferOpen.value = true
  try {
    const { data } = await axios.get('/api/2fa/status')
    twoFactorEnabled.value = !!data.enabled
  } catch {
    twoFactorEnabled.value = false
  }
}

const doTransferAction = async () => {
  const { password, code } = transferForm.value
  if (!password.trim() && !code.trim()) return toast('请输入账号密码或两步验证码', 'warn')
  transferBusy.value = true
  try {
    if (transferMode.value === 'import') {
      const res = await axios.post('/api/transfer/import', {
        payload: transferPayload.value,
        mode: transferImportMode.value,
        password, code,
      })
      transferOpen.value = false
      transferPayload.value = null
      toast(`导入成功，当前共 ${res.data.total} 张卡片，页面即将刷新`, 'success', 3000)
      emit('refresh-items')
      inputEl.value = ''
      setTimeout(() => window.location.reload(), 1200)
      return
    }
    const { data } = await axios.post('/api/transfer/export', { password, code })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    saveAs(blob, `onepanel-transfer-${stamp}.json`)
    transferOpen.value = false
    toast(`已导出 ${data.items?.length || 0} 张卡片（含备忘录明文），请妥善保管`, 'success')
  } catch (e) {
    toast(e.response?.data?.error || '操作失败', 'error')
  } finally {
    transferBusy.value = false
  }
}

// WebDAV 与恢复
const webdavConfig = ref({ url: '', user: '', pass: '' })
const isWebdavEditing = ref(true)
const cloudBackupList = ref([])
const selectedCloudFile = ref('')

// 企微配置 与 账号配置
const isNotifyEditing = ref(true)
const currentUsername = ref('')
const accountForm = ref({ oldPassword: '', newUsername: '', newPassword: '' })
const notifyConfig = ref({ wechatCorpId: '', wechatCorpSecret: '', wechatAgentId: '', wechatTouser: '@all' })

// 监控大盘数据
const monitoredDevices = ref([])
const deviceStatuses = ref({})
let panelMonitorInterval

// 2FA 绑定相关
const is2FAEnabled = ref(false)
const show2FAAuthPrompt = ref(false)
const verifyPassword = ref('')
const pending2FAAction = ref('')

const qrCodeData = ref('')
const tempSecret = ref('')
const setupCode = ref('')

const load2FASetup = async () => {
  try {
    const res = await axios.get('/api/2fa/setup')
    tempSecret.value = res.data.secret
    qrCodeData.value = res.data.qrCodeUrl
  } catch (error) {
    console.error('❌ 前端请求2FA失败:', error)
    toast('获取二维码失败', 'error')
  }
}

const enable2FA = async () => {
  if (!setupCode.value || setupCode.value.length !== 6) return toast('请输入 6 位动态验证码', 'warn')
  try {
    await axios.post('/api/2fa/enable', { secret: tempSecret.value, code: setupCode.value })
    toast('🎉 双因子认证 (2FA) 绑定成功并已强制开启！', 'success', 3500)
    qrCodeData.value = ''
    setupCode.value = ''
    is2FAEnabled.value = true
  } catch (error) {
    toast(error.response?.data?.error || '验证失败，请检查验证码是否正确或超时', 'error')
  }
}

const trigger2FAAction = (action) => {
  pending2FAAction.value = action
  show2FAAuthPrompt.value = true
  verifyPassword.value = ''
}

const confirm2FAAction = async () => {
  if (!verifyPassword.value) return toast('请输入当前登录密码以验证身份', 'warn')
  // 【P0-4】重新绑定不能先 disable：
  //   原来先调 /api/2fa/disable（立刻广播"全网 2FA 关闭"）再让用户扫码；
  //   中途关掉弹窗 -> 全网 2FA 裸奔。现在只验密码，新码通过后由 enable 一次性覆盖。
  if (pending2FAAction.value === 'rebind') {
    try {
      await axios.post('/api/2fa/verify-password', { password: verifyPassword.value })
      show2FAAuthPrompt.value = false
      verifyPassword.value = ''
      qrCodeData.value = ''
      await load2FASetup()
    } catch (error) {
      toast(error.response?.data?.error || '密码验证失败', 'error')
    }
    return
  }
  // 关闭 2FA 仍走 disable（需要密码）
  try {
    await axios.post('/api/2fa/disable', { password: verifyPassword.value })
    is2FAEnabled.value = false
    show2FAAuthPrompt.value = false
    verifyPassword.value = ''
    qrCodeData.value = ''
    toast('✅ 2FA 安全验证已成功关闭。', 'success')
  } catch (error) {
    toast(error.response?.data?.error || '密码验证失败', 'error')
  }
}

// ====== 3. 生命周期 ======
onMounted(async () => {
  axios.get('/api/config/account').then((res) => { currentUsername.value = res.data.username }).catch(() => {})

  try {
    const res2fa = await axios.get('/api/2fa/status')
    is2FAEnabled.value = !!res2fa.data.enabled
  } catch (e) {}

  try {
    const res = await axios.get('/api/config/notify')
    notifyConfig.value = { ...notifyConfig.value, ...res.data }
    if (notifyConfig.value.wechatCorpId && notifyConfig.value.wechatAgentId) isNotifyEditing.value = false
  } catch (e) {}

  fetchMonitoredList()
  panelMonitorInterval = setInterval(fetchMonitoredList, 10000)

  try {
    const res = await axios.get('/api/config/webdav')
    if (res.data) {
      webdavConfig.value = { url: res.data.url || '', user: res.data.user || '', pass: res.data.pass || '' }
      if (webdavConfig.value.url && webdavConfig.value.user) { isWebdavEditing.value = false; fetchCloudBackupList() }
    }
  } catch (e) {}
})

onUnmounted(() => { clearInterval(panelMonitorInterval) })

// ====== 4. 功能方法 ======
const fetchMonitoredList = async () => {
  try {
    const res = await axios.get('/api/items')
    monitoredDevices.value = (res.data || []).filter((item) => item.isMonitored)
    const statusRes = await axios.get('/api/monitor/status')
    deviceStatuses.value = statusRes.data || {}
  } catch (e) {}
}

const unbindMonitor = async (id) => {
  if (!armConfirm('unmonitor:' + dev.uid, '再点一次确认：解除该设备监控')) return
  try { await axios.put(`/api/monitor/unbind/${id}`); fetchMonitoredList(); emit('refresh-items') } catch (e) { toast('解除失败', 'error') }
}

const saveNotifyConfig = async () => {
  try {
    await axios.put('/api/config/notify', notifyConfig.value)
    toast('推送配置保存成功！', 'success')
    isNotifyEditing.value = false
  } catch (e) { toast('保存失败', 'error') }
}

const testNotify = async () => {
  try {
    await axios.post('/api/monitor/test-notify')
    toast('测试请求已发送，请查看企业微信。', 'success')
  } catch (e) {
    toast(e.response?.data?.error || '测试失败，请检查配置或后端日志', 'error')
  }
}

const saveWebdavConfig = async () => {
  if (webdavConfig.value.url && !/^https?:\/\//i.test(webdavConfig.value.url)) return toast('必须以 http:// 或 https:// 开头', 'warn')
  try {
    await axios.put('/api/config/webdav', webdavConfig.value)
    toast('配置保存成功！', 'success')
    isWebdavEditing.value = false
    fetchCloudBackupList()
  } catch (error) {
    toast(error.response?.data?.error || '保存配置失败', 'error')
  }
}

const fetchCloudBackupList = async () => {
  try {
    const res = await axios.get('/api/backup/cloud-list')
    if (Array.isArray(res.data)) {
      cloudBackupList.value = res.data
      if (cloudBackupList.value.length > 0) selectedCloudFile.value = cloudBackupList.value[0].name
    } else cloudBackupList.value = []
  } catch (error) { cloudBackupList.value = [] }
}

const downloadBackup = async () => {
  let objectUrl = null
  try {
    const res = await axios.get('/api/backup/download', { responseType: 'blob' })
    let fileName = 'onepanel-backup.opb'
    const disposition = res.headers['content-disposition']
    if (disposition && disposition.includes('filename=')) fileName = decodeURIComponent(disposition.split('filename=')[1].replace(/"/g, ''))
    objectUrl = window.URL.createObjectURL(new Blob([res.data]))
    const link = document.createElement('a')
    link.href = objectUrl
    link.setAttribute('download', fileName)
    document.body.appendChild(link)
    link.click()
    link.parentNode.removeChild(link)
  } catch (error) { toast('下载失败。', 'error') }
  finally { if (objectUrl) setTimeout(() => window.URL.revokeObjectURL(objectUrl), 5000) }
}

// ====== 解密转移 JSON（导出/导入都要二次验证身份） ======
const pickTransferFile = (event) => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    let payload
    try { payload = JSON.parse(String(e.target.result)) } catch { return toast('不是合法的 JSON 文件', 'error') }
    const items = payload?.items || payload?.data?.items
    if (!Array.isArray(items)) return toast('这不是 OnePanel 的转移 JSON', 'error')
    transferPayload.value = payload
    transferItemCount.value = items.length
    transferForm.value = { password: '', code: '' }
    transferMode.value = 'import'
    transferImportMode.value = 'replace'
    transferOpen.value = true
  }
  reader.readAsText(file)
}

const handleLocalRestore = (event) => {
  const file = event.target.files[0]
  if (!file) return
  // 文件恢复本身还有密码校验，这里只做一次提醒
  toast('正在上传并恢复，这会覆盖当前数据库', 'warn', 3000)
  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const res = await axios.post('/api/backup/restore-local', { fileData: e.target.result })
      toast((res.data.message || '恢复成功') + ' 页面即将刷新！', 'success', 3000)
      setTimeout(() => window.location.reload(), 1500)
    } catch (err) { toast(err.response?.data?.error || '恢复失败', 'error') }
    finally { event.target.value = '' }
  }
  reader.readAsDataURL(file)
}

const handleCloudRestore = async () => {
  if (!selectedCloudFile.value) return toast('请选择云端文件', 'warn')
  if (!armConfirm('cloud:' + selectedCloudFile.value, '再点一次确认：下载并覆盖当前系统')) return
  try {
    const res = await axios.post('/api/backup/restore-cloud', { fileName: selectedCloudFile.value })
    toast((res.data.message || '恢复成功') + ' 页面即将刷新！', 'success', 3000)
    setTimeout(() => window.location.reload(), 1500)
  } catch (err) { toast(err.response?.data?.error || '恢复失败', 'error') }
}

const handleUpdateAccount = async () => {
  if (!accountForm.value.oldPassword) return toast('请输入原密码验证', 'warn')
  if (!accountForm.value.newUsername && !accountForm.value.newPassword) return toast('请填写修改内容', 'warn')
  // 【F-06】密码强度：≥8 位 + 至少一个数字或符号（不能纯数字/纯字母）
  const pw = accountForm.value.newPassword
  if (pw) {
    if (pw.length < 8) return toast('新密码至少 8 位', 'warn')
    if (!/[0-9]/.test(pw) && !/[^A-Za-z0-9]/.test(pw)) return toast('新密码需包含至少一个数字或符号', 'warn')
    if (/^(\d+|[a-zA-Z]+)$/.test(pw)) return toast('新密码不能是纯数字或纯字母', 'warn')
  }
  try {
    const res = await axios.put('/api/config/account', accountForm.value)
    // Cookie 由后端 Set-Cookie 写入，前端不再碰 localStorage
    toast('修改成功！页面即将重载。', 'success', 3000)
    setTimeout(() => window.location.reload(), 1500)
  } catch (error) {
    toast(error.response?.data?.error || '修改失败，请检查原密码', 'error')
  }
}

// 分组改动：独立走 /api/config/groups，避免拉全量主题覆盖他人正在编辑的字段
const handleUpdateGroupsImmediate = async (newGroups) => {
  localSettings.value.groups = newGroups
  initialSettingsStr.value = JSON.stringify(localSettings.value)
  try {
    await axios.put('/api/config/groups', { groups: newGroups })
  } catch (e) {
    console.warn('分组同步到云端失败', e)
    toast('分组云端同步失败（本地已生效）', 'warn')
  }
  emit('save', localSettings.value, false)
}

const handleSiteIconUpload = (event) => {
  const file = event.target.files[0]
  if (!file) return
  if (file.size > 2 * 1024 * 1024) { toast('图标图片不能超过 2MB！', 'warn'); event.target.value = ''; return }
  const reader = new FileReader()
  reader.onload = (e) => { localSettings.value.siteIcon = e.target.result; event.target.value = '' }
  reader.onerror = () => { toast('读取图片失败', 'error'); event.target.value = '' }
  reader.readAsDataURL(file)
}
const clearSiteIcon = () => { localSettings.value.siteIcon = '' }

const handleBgImageUpload = (event) => {
  const file = event.target.files[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) { toast('背景图片太大了，建议不超过 5MB！请压缩后再上传。', 'warn'); event.target.value = ''; return }
  const reader = new FileReader()
  reader.onload = (e) => { localSettings.value.bgImage = e.target.result; event.target.value = '' }
  reader.onerror = () => { toast('读取图片失败', 'error'); event.target.value = '' }
  reader.readAsDataURL(file)
}
const clearBgImage = () => { localSettings.value.bgImage = '' }

const applyGlobalStyle = async (applyToAll) => {
  if (!armConfirm('style:' + JSON.stringify(localSettings.value.cardBgColor), '再点一次确认应用此样式')) return
  try {
    await axios.put('/api/items/bulk-style', {
      bgColor: localSettings.value.cardBgColor,
      bgOpacity: localSettings.value.cardBgOpacity,
      applyToAll,
    })
    toast('批量应用成功！', 'success')
    emit('refresh-items')
  } catch (error) { toast('应用失败', 'error') }
}

const convertToPngBase64 = (base64DataUrl) => new Promise((resolve) => {
  try {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.width; canvas.height = img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        resolve(canvas.toDataURL('image/png').split(',')[1])
      } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = base64DataUrl
  } catch { resolve(null) }
})

// JS 字符串转义：避免站点标题含引号时把插件脚本写坏
const jsString = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')

const downloadExtension = async () => {
  // 由后端把 browser-extension/ 目录实时打包，保证下载的是最新版扩展
  try {
    const res = await axios.get('/api/extension/bundle', { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'onepanel-extension.zip'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    toast('已下载扩展包（解压后在 chrome://extensions 里「加载已解压」）', 'success', 5000)
  } catch (e) {
    toast(e.response?.data?.error || '扩展打包失败', 'error')
  }
}

const setLocalTheme = (bg, color) => {
  localSettings.value.themeBg = bg
  localSettings.value.themeColor = color
}

// ====== 5. 主题预览与回滚 ======
// 预览统一走 applyThemeToBody；取消保存时回滚到打开面板时的样式
watch(() => localSettings.value, (newVal) => {
  applyThemeToBody(newVal)
  // 【跨节点一致】主题写 Cookie（localStorage 按域名隔离会丢）
  const maxAge = 365 * 24 * 3600
  const set = (k, v) => { if (v) document.cookie = k + '=' + encodeURIComponent(v) + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax' }
  set('op_theme_bg', newVal.themeBg)
  set('op_theme_color', newVal.themeColor)
  set('op_theme_accent', newVal.themeAccent)
}, { deep: true, immediate: true })

const rollbackPreview = () => { applyThemeToBody(props.settings || {}) }

const saveAndClose = async () => {
  localSettings.value.themeBg = safeHex(localSettings.value.themeBg, DEFAULT_BG)
  localSettings.value.themeColor = safeHex(localSettings.value.themeColor, DEFAULT_COLOR)

  // 外观默认全量同步到云端（多端漫游，无需开关）
  try {
    await axios.put('/api/config/theme', {
      themeBg: localSettings.value.themeBg,
      themeColor: localSettings.value.themeColor,
      siteIcon: localSettings.value.siteIcon,
      bgImage: localSettings.value.bgImage,
      siteTitle: localSettings.value.siteTitle,
      footerText: localSettings.value.footerText,
      groups: localSettings.value.groups,
      cardBgColor: localSettings.value.cardBgColor,
      cardBgOpacity: localSettings.value.cardBgOpacity,
    })
  } catch (e) {
    toast('⚠️ 云端同步失败：' + (e.response?.data?.error || e.message), 'error', 4000)
    return
  }
  writeText('themeBg', localSettings.value.themeBg)
  writeText('themeColor', localSettings.value.themeColor)

  emit('save', localSettings.value)
  initialSettingsStr.value = JSON.stringify(localSettings.value)
  toast('个性化配置已保存', 'success')
}

const handleCloseCheck = async () => {
  // 有未保存修改时不弹原生 confirm：直接保存后关闭（用户想放弃就点右上角 ×）
  if (JSON.stringify(localSettings.value) !== initialSettingsStr.value) {
    await saveAndClose()
  }
  emit('close')
}
</script>

<template>
  <div class="settings-overlay">
    <div class="settings-container glass-strong">
      <div class="settings-header">
        <h3><AppIcon icon="mdi:cog" /> 系统设置</h3>
        <button class="win-btn close-btn" @click="handleCloseCheck">×</button>
      </div>

      <div class="settings-body">
        <ul class="sidebar">
          <li :class="{ active: activeTab === 'account' }" @click="activeTab = 'account'"><AppIcon icon="mdi:shield-account-outline" /> 账号安全</li>
          <li :class="{ active: activeTab === 'personalize' }" @click="activeTab = 'personalize'"><AppIcon icon="mdi:palette-outline" /> 个性化设置</li>
          <li :class="{ active: activeTab === 'groups' }" @click="activeTab = 'groups'"><AppIcon icon="mdi:folder-outline" /> 分组管理</li>
          <li :class="{ active: activeTab === 'monitor' }" @click="activeTab = 'monitor'"><AppIcon icon="mdi:monitor-dashboard" /> 监控与通知</li>
          <li :class="{ active: activeTab === 'backup' }" @click="activeTab = 'backup'"><AppIcon icon="mdi:cloud-sync-outline" /> 备份与恢复</li>
          <li :class="{ active: activeTab === 'api' }" @click="activeTab = 'api'"><AppIcon icon="mdi:api" /> API 接口</li>
          <li :class="{ active: activeTab === 'ext' }" @click="activeTab = 'ext'"><AppIcon icon="mdi:puzzle-outline" /> 浏览器扩展</li>
          <li :class="{ active: activeTab === 'about' }" @click="activeTab = 'about'"><AppIcon icon="mdi:information-outline" /> 关于 / 更新</li>
          <li :class="{ active: activeTab === 'sync' }" @click="activeTab = 'sync'"><AppIcon icon="mdi:share-variant-outline" /> 共享网络</li>
        </ul>

        <div class="content-area">
          <div v-if="activeTab === 'personalize'" class="tab-pane">
            <div class="setting-block">
              <h4>网站基础信息</h4>
              <div class="form-row" style="margin-bottom:15px"><div class="flex-2"><label>全局标题</label><input v-model="localSettings.siteTitle" type="text" class="glass-input full-w" placeholder="如: 个人数字枢纽" /></div></div>
              <div class="form-group"><label>全局图标</label>
                <div class="icon-upload-row" style="display: flex; align-items: center; gap: 8px;">
                  <input v-if="!localSettings.siteIcon?.startsWith('data:')" v-model="localSettings.siteIcon" type="text" placeholder="mdi:home-circle 或 http://" class="glass-input flex-1" />
                  <div v-else class="glass-input flex-1" style="color: #64ffda; display:flex; flex-direction:row; align-items:center; justify-content:space-between; height: 38px; padding: 0 12px; box-sizing: border-box;">
                    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">✅ 已应用本地图片</span>
                    <button style="background:none; border:none; color:#ef4444; cursor:pointer;" @click="clearSiteIcon">清除</button>
                  </div>
                  <label class="upload-btn" style="height: 38px; display:flex; align-items:center; cursor:pointer;">
                    <AppIcon icon="mdi:upload" /> 本地图片<input type="file" accept="image/*" @change="handleSiteIconUpload" style="display: none;" />
                  </label>
                </div>
              </div>
            </div>

            <div class="setting-block">
              <h4>背景壁纸</h4>
              <div class="icon-upload-row" style="display: flex; align-items: center; gap: 8px;">
                <input v-if="!localSettings.bgImage?.startsWith('data:')" v-model="localSettings.bgImage" type="text" placeholder="填入图片直链 URL 或本地上传" class="glass-input flex-1" />
                <div v-else class="glass-input flex-1" style="color: #64ffda; display:flex; flex-direction:row; align-items:center; justify-content:space-between; height: 38px; padding: 0 12px; box-sizing: border-box;">
                  <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">✅ 已应用本地背景图</span>
                  <button style="background:none; border:none; color:#ef4444; cursor:pointer;" @click="clearBgImage">清除</button>
                </div>
                <label class="upload-btn" style="height: 38px; display:flex; align-items:center; cursor:pointer;">
                  <AppIcon icon="mdi:upload" /> 本地图片<input type="file" accept="image/*" @change="handleBgImageUpload" style="display: none;" />
                </label>
              </div>
            </div>

            <div class="setting-block">
              <h4>✨ 全局主题色彩</h4>
              <div class="form-row">
                <div class="flex-1"><label>全局背景色</label><input v-model="localSettings.themeBg" type="color" class="color-picker" /></div>
                <div class="flex-1"><label>全局文字颜色</label><input v-model="localSettings.themeColor" type="color" class="color-picker" /></div>
              </div>
              <div class="form-group mt-3">
                <label>主题强调色（按钮、选中态、卡片光晕）</label>
                <div class="accent-row">
                  <button
                    v-for="c in ACCENTS" :key="c.value"
                    class="accent-dot"
                    :class="{ active: (localSettings.themeAccent || '#3b82f6') === c.value }"
                    :style="{ background: c.value }"
                    :title="c.name"
                    @click="localSettings.themeAccent = c.value"
                  ></button>
                  <input v-model="localSettings.themeAccent" type="color" class="accent-picker" title="自定义强调色" />
                </div>
              </div>
              <div class="action-row mt-3" style="flex-wrap: wrap;">
                <button class="btn-outline" style="color:#000; background:#f8fafc" @click="setLocalTheme('#f8fafc', '#1e293b')">☀️ 预览白昼模式</button>
                <button class="btn-outline" style="color:#fff; background:#1e1e2f" @click="setLocalTheme('#1e1e2f', '#ffffff')">🌙 预览暗黑模式</button>
              </div>
            </div>

            <div class="setting-block">
              <h4>统一卡片样式预设</h4>
              <div class="form-row">
                <div class="flex-1"><label>预设背景色</label><input v-model="localSettings.cardBgColor" type="color" class="color-picker" /></div>
                <div class="flex-2"><label>预设透明度: {{ localSettings.cardBgOpacity }}</label><input v-model.number="localSettings.cardBgOpacity" type="range" min="0" max="1" step="0.05" class="slider" /></div>
              </div>
              <div class="action-row mt-3">
                <button class="btn-outline" @click="applyGlobalStyle(false)">仅应用于未自定义卡片</button>
                <button class="btn-outline text-danger" @click="applyGlobalStyle(true)">强制应用于全部卡片</button>
              </div>
            </div>

            <div class="setting-block">
              <h4>自定义页脚代码 (支持 HTML/CSS)</h4>
              <textarea v-model="localSettings.footerText" class="glass-input full-w" rows="4" placeholder="<div style='color:red'>Powered by Me</div>"></textarea>
            </div>

            <div class="setting-block mt-4">
              <h4><AppIcon icon="mdi:puzzle-outline" /> 浏览器收藏插件</h4>
              <p style="font-size: 12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent); margin-bottom: 15px;">
                一键生成已绑定当前面板地址的专属 Chrome/Edge 插件。下载后解压，并在浏览器的“扩展程序”中开启“开发者模式”加载即可。
              </p>
              <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <span style="font-weight: bold; color: var(--theme-accent, #3b82f6);">当前绑定地址：</span>
                  <code style="color: #64ffda; margin-left: 10px;">自动识别</code>
                </div>
                <button class="btn-primary" @click="downloadExtension" style="display:flex; align-items:center; gap: 6px;">
                  <AppIcon icon="mdi:download" /> 下载专属插件包
                </button>
              </div>
            </div>

          </div>

          <div v-if="activeTab === 'groups'" class="tab-pane">
            <GroupManager :groups="localSettings.groups" @update-groups-immediate="handleUpdateGroupsImmediate" @refresh-items="emit('refresh-items')" />
          </div>

          <div v-if="activeTab === 'monitor'" class="tab-pane">
            <div class="setting-block">
              <h4><AppIcon icon="mdi:message-badge-outline" /> 企业微信推送管理</h4>

              <div v-if="!isNotifyEditing" class="webdav-status-box" style="margin-bottom: 20px;">
                <div class="status-text">
                  <AppIcon icon="mdi:check-circle" style="color:#10b981; font-size: 20px;" />
                  <span>参数已装载：<code style="color:#64ffda">CorpID/AgentID 已配置</code></span>
                </div>
                <div style="display:flex; gap: 10px;">
                  <button class="btn-outline" @click="testNotify" v-if="notifyConfig.wechatCorpId">发送测试通知</button>
                  <button class="btn-outline" @click="isNotifyEditing = true">修改配置</button>
                </div>
              </div>

              <div v-else class="webdav-edit-form">
                <div class="form-row">
                  <div class="form-group flex-1"><label>企业 ID (CorpID)</label><input v-model="notifyConfig.wechatCorpId" type="text" class="glass-input full-w" /></div>
                  <div class="form-group flex-1"><label>应用 ID (AgentId)</label><input v-model="notifyConfig.wechatAgentId" type="text" class="glass-input full-w" /></div>
                </div>
                <div class="form-group mt-3"><label>应用密钥 (Secret)</label><input v-model="notifyConfig.wechatCorpSecret" type="password" class="glass-input full-w" /></div>
                <div class="form-group mt-3"><label>接收人 (touser，默认 @all 全员)</label><input v-model="notifyConfig.wechatTouser" type="text" class="glass-input full-w" placeholder="@all" /></div>
                <div class="action-row mt-3">
                  <button class="btn-primary" @click="saveNotifyConfig">保存通知配置</button>
                  <button v-if="notifyConfig.wechatCorpId" class="btn-cancel" @click="isNotifyEditing = false">取消</button>
                </div>
              </div>
            </div>

            <div class="setting-block mt-4">
              <h4><AppIcon icon="mdi:server-network" /> 多设备在线大盘</h4>
              <p style="font-size: 12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent);">每分钟检测一次，连续多次无响应视为离线触发告警 (10s自动静默刷新)</p>

              <div v-if="monitoredDevices.length === 0" style="background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; text-align: center; color: color-mix(in srgb, var(--theme-color) 50%, transparent);">
                暂无受监控设备。请在主页添加应用时开启监控。
              </div>

              <div v-else style="display:flex; flex-direction:column; gap:10px;">
                <div v-for="dev in monitoredDevices" :key="dev.id" style="background: color-mix(in srgb, var(--theme-color) 7%, transparent); border:1px solid color-mix(in srgb, var(--theme-color) 12%, transparent); padding: 12px; border-radius:10px; display:flex; justify-content:space-between; align-items:center;">
                  <div style="display:flex; flex-direction:column; gap:4px;">
                    <span style="font-weight:bold; font-size:14px;">{{ dev.name }}</span>
                    <span style="font-family:monospace; font-size:12px; color: color-mix(in srgb, var(--theme-color) 72%, transparent);">🎯 {{ dev.pingUrl }}</span>
                  </div>
                  <div style="display:flex; align-items:center; gap: 15px;">
                    <div style="font-size: 13px; font-weight:bold; width: 80px; text-align:right;">
                      <span v-if="deviceStatuses[dev.id]?.s === 'Offline'" style="color:#ef4444">🔴 离线</span>
                      <span v-else-if="deviceStatuses[dev.id]?.s === 'Suspected'" style="color:#f59e0b">🟡 疑似</span>
                      <span v-else style="color:#10b981">🟢 在线</span>
                    </div>
                    <button class="btn-outline text-danger" style="padding: 6px 12px; font-size:12px;" @click="unbindMonitor(dev.id)">解除监控</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="activeTab === 'backup'" class="tab-pane">
            <!-- ① 云备份管理与恢复 -->
            <div class="setting-block">
              <h4><AppIcon icon="mdi:cloud-sync" /> 云备份管理与恢复</h4>
              <div v-if="!isWebdavEditing" class="webdav-status-box"><div class="status-text"><AppIcon icon="mdi:check-circle" style="color:#10b981; font-size: 20px;" /><span>已连接：<code style="color:#64ffda">{{ webdavConfig.url }}</code></span></div><button class="btn-outline" @click="isWebdavEditing = true">修改配置</button></div>
              <div v-else class="webdav-edit-form">
                <div class="form-group"><label>WebDAV 服务器地址</label><input v-model="webdavConfig.url" type="text" class="glass-input full-w" placeholder="https://" /></div>
                <div class="form-row"><div class="form-group flex-1"><label>WebDAV 账号</label><input v-model="webdavConfig.user" type="text" class="glass-input full-w" /></div><div class="form-group flex-1"><label>密码 / 授权密钥</label><input v-model="webdavConfig.pass" type="password" class="glass-input full-w" /></div></div>
                <div class="action-row mt-3"><button class="btn-primary" @click="saveWebdavConfig">测试并保存云盘</button><button v-if="webdavConfig.url" class="btn-cancel" @click="isWebdavEditing = false">取消</button></div>
              </div>

              <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed color-mix(in srgb, var(--theme-color) 12%, transparent);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
                  <label style="font-size: 13px; color: color-mix(in srgb, var(--theme-color) 72%, transparent);">☁️ 云端历史备份（改动后自动上传，滚动保留 3 份）</label>
                  <button class="btn-outline" style="padding: 4px 8px; font-size: 12px" @click="fetchCloudBackupList"><AppIcon icon="mdi:refresh" /> 刷新列表</button>
                </div>
                <div v-if="cloudBackupList.length > 0" class="form-row">
                  <SelectBox
                    v-model="selectedCloudFile"
                    :options="(cloudBackupList || []).map((f) => ({ label: f.name + ' (' + (f.size / 1024).toFixed(1) + 'KB)', value: f.name }))"
                    placeholder="选择备份文件"
                  />
                  <button class="btn-primary" style="background:#10b981" @click="handleCloudRestore">恢复到这份</button>
                </div>
                <div v-else style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; font-size: 12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent); text-align: center;">暂无云端备份。连上 WebDAV 后点「刷新列表」，或先随便改点什么触发一次自动备份。</div>
                <p style="font-size: 12px; color: #f87171; margin-top: 12px;">⚠️ 恢复会用云端那份覆盖当前全部数据，不可撤销；账号与登录口令始终保留当前值。</p>
              </div>
            </div>

            <!-- ② 本地打包备份与恢复 -->
            <div class="setting-block mt-4">
              <h4><AppIcon icon="mdi:folder-download" /> 本地打包备份与恢复</h4>
              <p style="font-size: 12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent); margin-bottom: 12px;">
                备份包是 AES-256-GCM 整包加密的 <code>.opb</code>（旧版 .gz 已停止支持）。
                密钥由你的<b>管理员密码</b>包裹，换机器时只要账号密码记得、数据带过去就能解——不用再额外记密钥串。
              </p>
              <div class="action-row">
                <button class="btn-outline" style="border-color: #3b82f6; color: #3b82f6;" @click="downloadBackup"><AppIcon icon="mdi:download" /> 下载最新备份包 (.opb)</button>
                <label class="upload-btn" style="cursor:pointer; border-color: #10b981; color: #10b981;">
                  <AppIcon icon="mdi:file-upload-outline" /> 上传 .opb 恢复<input type="file" accept=".opb" @change="handleLocalRestore" style="display:none;" />
                </label>
              </div>
              <p style="font-size: 12px; color: #f87171; margin-top: 12px;">⚠️ 上传恢复会清空并覆盖当前卡片、分组、主题；账号与口令保留。</p>
            </div>

            <!-- ③ 解密转移 JSON -->
            <div class="setting-block mt-4">
              <h4><AppIcon icon="mdi:swap-horizontal" /> 解密转移 JSON</h4>
              <p style="font-size: 12px; color: #fbbf24; margin-bottom: 12px;">
                换机专用：一个文件装下所有卡片的名称、描述、图标、全部网址、分组、标记、小组件配置
                <b>以及备忘录明文</b>（方便到新机器上直接还原）。导出与导入都要先验证身份（账号密码或两步验证码）。
              </p>
              <div class="action-row">
                <button class="btn-outline" style="border-color: #fbbf24; color: #fbbf24;" @click="openTransfer('export')">
                  <AppIcon icon="mdi:shield-key" /> 验证身份并导出
                </button>
                <label class="upload-btn" style="cursor:pointer; border-color: #fbbf24; color: #fbbf24;">
                  <AppIcon icon="mdi:file-import-outline" /> 导入转移 JSON<input type="file" accept=".json" @change="pickTransferFile" style="display:none;" />
                </label>
              </div>
            </div>
          </div>
          <div v-if="activeTab === 'ext'" class="content-area">
            <ExtensionPanel />
          </div>

          <div v-if="activeTab === 'about'" class="content-area">
            <AboutPanel />
          </div>

          <div v-if="activeTab === 'api'" class="content-area">
            <ApiDocs />
          </div>

          <div v-if="activeTab === 'sync'" class="tab-pane">
            <SyncPanel @refresh-items="emit('refresh-items')" />
          </div>

          <div v-if="activeTab === 'account'" class="tab-pane">
            <div class="setting-block">
              <h4><AppIcon icon="mdi:shield-account" /> 账号安全设置</h4>
              <div class="form-group"><label>原账号标识</label><div class="glass-input full-w" style="background:color-mix(in srgb, var(--theme-color) 7%, transparent); color:#64ffda; user-select:none;">{{ currentUsername || '获取中...' }}</div></div>
              <div class="form-group mt-3"><label>原密码 <span style="color:#ef4444">(必填，验证身份)</span></label><input v-model="accountForm.oldPassword" type="password" class="glass-input full-w" placeholder="输入当前密码以继续操作" /></div>
              <div style="height: 1px; background: color-mix(in srgb, var(--theme-color) 12%, transparent); margin: 20px 0;"></div>
              <div class="form-group mt-3"><label>新账号名称 <span style="color: color-mix(in srgb, var(--theme-color) 60%, transparent)">(可选，不修改请留空)</span></label><input v-model="accountForm.newUsername" type="text" class="glass-input full-w" placeholder="不填写则保持原账号" /></div>
              <div class="form-group mt-3"><label>新密码 <span style="color: color-mix(in srgb, var(--theme-color) 60%, transparent)">(可选，修改至少 8 位)</span></label><input v-model="accountForm.newPassword" type="password" class="glass-input full-w" placeholder="不填写则保持原密码（至少 8 位，含数字或符号）" /></div>
              <div class="action-row mt-4"><button class="btn-primary" style="background: #ef4444" @click="handleUpdateAccount">验证并应用修改</button></div>
            </div>

            <div class="setting-block mt-4" style="border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.05);">
              <h4 style="color: #10b981;"><AppIcon icon="mdi:shield-key" /> 高级安全：双因子认证 (2FA)</h4>

              <div v-if="is2FAEnabled">
                <div v-if="!show2FAAuthPrompt" style="display:flex; justify-content:space-between; align-items:center; background: rgba(16,185,129,0.1); padding: 15px; border-radius: 8px;">
                  <span style="color:#64ffda; font-weight:bold; display:flex; align-items:center; gap:8px;">
                    <AppIcon icon="mdi:check-decagram" style="font-size: 18px;" /> 账号已受 2FA 严格保护
                  </span>
                  <div style="display:flex; gap: 10px;">
                    <button class="btn-outline" style="border-color:#3b82f6; color:#3b82f6; padding: 6px 12px; font-size:12px;" @click="trigger2FAAction('rebind')">重新绑定</button>
                    <button class="btn-outline text-danger" style="padding: 6px 12px; font-size:12px;" @click="trigger2FAAction('disable')">关闭认证</button>
                  </div>
                </div>

                <div v-else style="background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; margin-top: 10px;">
                  <p style="font-size: 13px; color: #f59e0b; margin: 0 0 10px 0;">⚠️ 为了您的账号安全，请验证当前登录密码：</p>
                  <div style="display:flex; gap: 10px;">
                    <input v-model="verifyPassword" type="password" class="glass-input flex-2" placeholder="请输入系统登录密码" @keyup.enter="confirm2FAAction" />
                    <button class="btn-cancel flex-1" @click="show2FAAuthPrompt = false">取消</button>
                    <button class="btn-primary flex-1" style="background:#ef4444" @click="confirm2FAAction">确认执行</button>
                  </div>

                </div>
              </div>

              <div v-else>
                <p style="font-size: 12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent); margin-bottom: 15px;">
                  使用 Google Authenticator 或 Microsoft Authenticator 扫码绑定，绑定后每次登录均需输入手机动态码。
                </p>

                <button v-if="!qrCodeData" class="btn-outline" style="border-color: #10b981; color: #10b981;" @click="load2FASetup">
                  获取专属绑定二维码
                </button>

                <div v-else style="background: rgba(0,0,0,0.2); padding: 20px; border-radius: 10px; display: flex; flex-direction: column; align-items: center; gap: 15px;">
                  <p style="font-size: 13px; color: #64ffda; margin: 0;">请打开手机身份验证器 App 扫描下方二维码：</p>
                  <img :src="qrCodeData" alt="2FA QR Code" style="width: 160px; height: 160px; border-radius: 8px; border: 4px solid white;" />
                  <span style="font-size: 12px; color: color-mix(in srgb, var(--theme-color) 72%, transparent); font-family: monospace; user-select: text;">备用密钥: {{ tempSecret }}</span>

                  <input v-model="setupCode" type="text" inputmode="numeric" class="glass-input" placeholder="输入手机上的 6 位数字" style="text-align: center; width: 220px; font-size: 16px; letter-spacing: 2px; margin-top: 8px;" maxlength="6" @keyup.enter="enable2FA" />

                  <div style="display: flex; gap: 10px; width: 220px; margin-top: 10px;">
                    <button class="btn-cancel flex-1" style="padding: 8px 0;" @click="qrCodeData = ''">取消</button>
                    <button class="btn-primary flex-1" style="background: #10b981; padding: 8px 0;" @click="enable2FA">校验并激活</button>
                  </div>
                </div>
              </div>

            </div>

            <div class="setting-block mt-4">
              <h4><AppIcon icon="mdi:fingerprint" /> 通行密钥（Passkey）</h4>
              <p style="font-size:12px; color: color-mix(in srgb, var(--theme-color) 60%, transparent); margin:6px 0 12px;">
                用指纹 / Face ID / Windows Hello 登录，不用输密码。同一父域下注册一次，所有节点通用。
              </p>
              <PasskeyPanel mode="manage" />
            </div>
          </div>
        </div>
      </div>

      <!-- 🔐 转移导出二次验证 -->
      <div v-if="transferOpen" class="transfer-mask" @click.self="transferOpen = false">
        <div class="transfer-card glass-strong">
          <h3>{{ transferMode === 'export' ? '🔐 导出转移数据' : '🔐 导入转移数据' }}</h3>
          <p class="transfer-tip" v-if="transferMode === 'export'">
            这份 JSON 包含所有卡片信息与<b>备忘录明文</b>，请确认是本人操作。
          </p>
          <p class="transfer-tip" v-else>
            即将导入 <b>{{ transferItemCount }} 张卡片</b>（含备忘录明文）。导入会覆盖或合并当前数据，请确认是本人操作。
          </p>
          <div class="form-group" v-if="transferMode === 'import'">
            <label>导入方式</label>
            <SelectBox
                                    v-model="transferImportMode"
                                    :options="[
                                      { label: '合并（保留现有卡片）', value: 'merge' },
                                      { label: '覆盖（清空后导入）', value: 'replace' },
                                    ]"
                                    placeholder="合并"
                                  />
          </div>
          <div class="form-group">
            <label>账号密码</label>
            <input v-model="transferForm.password" type="password" class="glass-input full-w" placeholder="当前登录密码" @keyup.enter="doTransferAction" />
          </div>
          <div class="form-group" v-if="twoFactorEnabled" style="margin-top: 10px;">
            <label>或两步验证码（6 位）</label>
            <input v-model="transferForm.code" type="text" inputmode="numeric" maxlength="6" class="glass-input full-w"
              placeholder="验证器上的 6 位数字" style="letter-spacing: 3px;" @keyup.enter="doTransferAction" />
          </div>
          <p v-else class="transfer-tip" style="opacity:.6">未开启两步验证，输入密码即可。</p>
          <div class="modal-actions" style="margin-top: 16px;">
            <button class="btn-cancel" @click="transferOpen = false">取消</button>
            <button class="btn-primary" :disabled="transferBusy" @click="doTransferAction">
              {{ transferBusy ? '验证中…' : (transferMode === 'export' ? '验证并下载' : '验证并导入') }}
            </button>
          </div>
        </div>
      </div>

      <div class="settings-footer">
        <button class="btn-cancel" @click="handleCloseCheck">关闭</button>
        <button v-if="activeTab === 'personalize'" class="btn-primary" @click="saveAndClose">保存个性化配置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 999; }

/* 转移导出二次验证弹窗 */
.transfer-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 5; border-radius: 16px; }
/* 注意：glass-strong 定义在 App.vue 的 scoped 样式里，这里用不到，必须自己给不透明底色 */
.transfer-card {
  width: min(400px, calc(100vw - 40px)); padding: 22px; border-radius: 14px;
  background: color-mix(in srgb, var(--theme-bg) 97%, #000);
  border: 1px solid color-mix(in srgb, var(--theme-color) 18%, transparent);
  box-shadow: 0 18px 40px rgba(0,0,0,.55);
}
.transfer-card h3 { margin: 0 0 10px; font-size: 16px; }
.transfer-tip { font-size: 12px; line-height: 1.6; color: color-mix(in srgb, var(--theme-color) 60%, transparent); margin: 0 0 12px; }
.transfer-tip b { color: #fbbf24; }

.settings-container {
  width: min(920px, calc(100vw - 24px));
  height: min(660px, calc(100vh - 48px));
  display: flex; flex-direction: column;
  border-radius: 24px; overflow: hidden;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 93%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 12%, transparent);
  backdrop-filter: blur(24px) saturate(1.5);
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  box-shadow: 0 32px 80px -12px rgba(0, 0, 0, .65), 0 2px 10px rgba(0, 0, 0, .3);
  animation: op-pop-in .2s cubic-bezier(.16, 1, .3, 1);
}

.settings-header { height: 60px; padding: 0 24px; border-bottom: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
.settings-header h3 { font-size: 18px; display: flex; align-items: center; gap: 8px; margin: 0; }

.win-btn { width: 30px; height: 30px; border-radius: 50%; border: none; background: color-mix(in srgb, var(--theme-color) 10%, transparent); color: var(--theme-color); cursor: pointer; transition: 0.2s; }
.win-btn:hover { background: #ef4444; color: white; }

.settings-body { flex: 1; display: flex; overflow: hidden; }

.sidebar {
  width: 176px; flex-shrink: 0; padding: 14px 10px;
  display: flex; flex-direction: column; gap: 3px;
  overflow-y: auto;
  border-right: 1px solid color-mix(in srgb, var(--theme-color) 9%, transparent);
  background: color-mix(in srgb, var(--theme-color) 4%, transparent);
}
.sidebar li {
  display: flex; align-items: center; gap: 9px;
  padding: 10px 12px; border-radius: 10px; cursor: pointer;
  font-size: 13px; color: color-mix(in srgb, var(--theme-color) 72%, transparent);
  transition: background .14s ease, color .14s ease;
  position: relative;
}
.sidebar li:hover { background: color-mix(in srgb, var(--theme-color) 9%, transparent); color: color-mix(in srgb, var(--theme-color) 96%, transparent); }
.sidebar li.active {
  background: color-mix(in srgb, var(--theme-accent, #3b82f6) 18%, transparent);
  color: #fff; font-weight: 600;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-accent, #3b82f6) 35%, transparent) inset;
}
.sidebar li:hover { background: color-mix(in srgb, var(--theme-color) 10%, transparent); color: var(--theme-color); }
.sidebar li.active { background: rgba(59, 130, 246, 0.15); color: #3b82f6; border-right: 3px solid #3b82f6; font-weight: bold; }

.content-area { flex: 1; padding: 30px; overflow-y: auto; }

.setting-block {
  background: color-mix(in srgb, var(--theme-color) 6%, transparent);
  border-radius: 14px; padding: 18px 20px; margin-bottom: 16px;
  border: 1px solid color-mix(in srgb, var(--theme-color) 9%, transparent);
  transition: background .16s ease, border-color .16s ease;
}
.setting-block:hover { background: color-mix(in srgb, var(--theme-color) 7%, transparent); border-color: color-mix(in srgb, var(--theme-color) 13%, transparent); }
.setting-block h4 { margin-top: 0; margin-bottom: 16px; font-size: 15px; color: var(--theme-color); display: flex; align-items: center; gap: 6px; }

.form-group { margin-bottom: 15px; }
.form-row { display: flex; gap: 20px; align-items: flex-start; }
.form-row > * > label { display: block; min-height: 18px; margin-bottom: 6px; }
.form-row .slider { margin-top: 6px; }
.flex-1 { flex: 1; } .flex-2 { flex: 2; }
.mt-3 { margin-top: 16px; } .mt-4 { margin-top: 24px; }
.full-w { width: 100%; box-sizing: border-box; resize: vertical; }

.glass-input {
  width: 100%; box-sizing: border-box;
  background: color-mix(in srgb, var(--theme-color) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent);
  padding: 9px 12px; border-radius: 10px;
  color: inherit; font: inherit; font-size: 13px; outline: none;
  transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
}
.glass-input::placeholder { color: color-mix(in srgb, var(--theme-color) 37%, transparent); }
.glass-input:hover { border-color: color-mix(in srgb, var(--theme-color) 22%, transparent); background: color-mix(in srgb, var(--theme-color) 9%, transparent); }
.glass-input:focus {
  border-color: var(--theme-accent, #3b82f6);
  background: color-mix(in srgb, var(--theme-color) 10%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-accent, #3b82f6) 20%, transparent);
}
.glass-input:focus { border-color: #3b82f6; }

.accent-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.accent-dot {
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent; transition: transform .14s ease, border-color .14s ease;
}
.accent-dot:hover { transform: scale(1.12); }
.accent-dot.active { border-color: var(--theme-color); box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-bg) 80%, transparent) inset; }
.accent-picker { width: 34px; height: 26px; border: none; border-radius: 8px; cursor: pointer; background: none; padding: 0; }

.color-picker { -webkit-appearance: none; border: none; width: 100%; height: 40px; border-radius: 8px; cursor: pointer; background: none; }
.color-picker::-webkit-color-swatch { border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); border-radius: 8px; }

.slider { width: 100%; margin-top: 10px; }
.action-row { display: flex; gap: 12px; flex-wrap: wrap; }

.btn-outline { background: transparent; border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); color: var(--theme-color); padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: 0.2s; display: flex; align-items: center; gap: 6px; }
.btn-outline:hover { background: color-mix(in srgb, var(--theme-color) 10%, transparent); }

.text-danger { border-color: rgba(239, 68, 68, 0.4) !important; color: #ef4444 !important; }
.text-danger:hover { background: rgba(239, 68, 68, 0.1) !important; }

/* 开关样式（原来写在 App.vue scoped 里穿透不到这里，开关是坏的） */
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider-round { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: color-mix(in srgb, var(--theme-color) 25%, transparent); transition: .4s; border-radius: 22px; }
.slider-round:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
input:checked + .slider-round { background-color: #10b981; }
input:checked + .slider-round:before { transform: translateX(18px); }

.settings-footer { min-height: 70px; padding: 0 24px; border-top: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent); display: flex; justify-content: flex-end; align-items: center; gap: 12px; flex-shrink: 0; }

.btn-cancel { background: color-mix(in srgb, var(--theme-color) 10%, transparent); color: var(--theme-color); border: none; padding: 10px 24px; border-radius: 8px; cursor: pointer; transition: 0.2s; }
.btn-cancel:hover { background: color-mix(in srgb, var(--theme-color) 20%, transparent); }

.btn-primary {
  background: var(--theme-accent, #3b82f6); color: #fff; border: none;
  padding: 9px 20px; border-radius: 10px; cursor: pointer;
  font-weight: 600; font-size: 13px;
  box-shadow: 0 2px 12px -2px color-mix(in srgb, var(--theme-accent, #3b82f6) 55%, transparent);
  transition: filter .14s ease, transform .14s ease, box-shadow .14s ease;
}
.btn-primary:hover { filter: brightness(1.08); box-shadow: 0 4px 18px -2px color-mix(in srgb, var(--theme-accent, #3b82f6) 62%, transparent); }
.btn-primary:active { transform: scale(.97); }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn-primary:hover { background: #2563eb; }

.icon-upload-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
/* 行内控件统一 38px 高，杜绝 input/label 高度不一 */
.icon-upload-row .glass-input { height: 38px; padding: 0 14px; line-height: 36px; }
.icon-upload-row .upload-btn { margin-bottom: 0; }

.upload-btn { background: color-mix(in srgb, var(--theme-color) 10%, transparent); padding: 0 16px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; font-size: 13px; border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent); color: var(--theme-color); white-space: nowrap; width: auto; flex-shrink: 0; transition: 0.2s; }
.upload-btn:hover { background: color-mix(in srgb, var(--theme-color) 20%, transparent); }

.webdav-status-box { display: flex; justify-content: space-between; align-items: center; background: rgba(16, 185, 129, 0.08); border: 1px dashed rgba(16, 185, 129, 0.3); padding: 16px; border-radius: 10px; color: var(--theme-color); }
.status-text { display: flex; align-items: center; gap: 10px; font-size: 14px; }
</style>
