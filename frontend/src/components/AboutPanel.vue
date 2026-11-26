<script setup>
/**
 * 关于 / 更新（v3.11.0）
 * ------------------------------------------------------------------
 * 显示当前版本、安装形态、检查 GitHub 最新版。
 * 只有脚本版（/opt/onepanel）能一键升级；Docker 和单文件版给手动指引。
 */
import { ref, onMounted } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import { toast } from '../utils/common'

const info = ref(null)
const check = ref(null)
const busy = ref(false)
const job = ref(null)

const INSTALL_LABEL = {
  script: '脚本安装（/opt/onepanel）',
  portable: '单文件版',
  docker: 'Docker 容器',
  dev: '开发环境',
}

async function load() {
  try {
    const r = await axios.get('/api/system/version')
    info.value = r.data
  } catch { info.value = null }
}

async function checkUpdate() {
  busy.value = true
  try {
    const r = await axios.get('/api/system/update-check')
    check.value = r.data
    if (r.data.hasUpdate) toast('发现新版本 ' + r.data.latest, 'success', 5000)
    else toast('已是最新版本', 'success')
  } catch (e) {
    check.value = e.response?.data || null
    toast('检查失败：' + (e.response?.data?.error || e.message), 'error', 6000)
  } finally { busy.value = false }
}

async function doUpgrade() {
  if (!check.value?.hasUpdate) return toast('没有可用的新版本', 'warn')
  busy.value = true
  try {
    const r = await axios.post('/api/system/upgrade')
    toast(r.data.note || '升级已开始，面板会短暂不可用', 'success', 8000)
    // 轮询进度
    const timer = setInterval(async () => {
      try {
        const s = await axios.get('/api/system/upgrade/status')
        job.value = s.data
        if (!s.data.running) {
          clearInterval(timer)
          toast('升级进程结束，正在刷新…', 'success')
          setTimeout(() => location.reload(), 1500)
        }
      } catch { clearInterval(timer) }
    }, 2000)
  } catch (e) {
    toast(e.response?.data?.error || '升级失败', 'error', 6000)
  } finally { busy.value = false }
}

onMounted(load)
</script>
<template>
  <div class="about">
    <div class="setting-block">
      <h4><AppIcon icon="mdi:information-outline" /> 当前版本</h4>
      <div v-if="info" class="ver-grid">
        <div class="vr"><span>版本</span><b>v{{ info.version }}</b></div>
        <div class="vr"><span>安装方式</span><b>{{ INSTALL_LABEL[info.installType] || info.installType }}</b></div>
        <div class="vr"><span>运行环境</span><b>Node {{ info.node }} · {{ info.platform }}/{{ info.arch }}</b></div>
        <div class="vr"><span>服务端口</span><b>{{ info.port }}</b></div>
        <div class="vr"><span>已运行</span><b>{{ Math.floor(info.uptimeSec / 3600) }} 小时 {{ Math.floor((info.uptimeSec % 3600) / 60) }} 分</b></div>
      </div>
      <p v-else class="tip">读取版本信息失败</p>
    </div>

    <div class="setting-block">
      <h4><AppIcon icon="mdi:cloud-download-outline" /> 检查更新</h4>
      <p class="tip">从 GitHub <code>onepanel-home</code> 仓库查询最新正式版。</p>
      <div class="row-actions">
        <button class="btn-primary" :disabled="busy" @click="checkUpdate">
          {{ busy ? '检查中…' : '检查更新' }}
        </button>
        <button
          v-if="check?.hasUpdate && check?.canAutoUpgrade"
          class="btn-outline" :disabled="busy" @click="doUpgrade"
        >一键升级到 v{{ check.latest }}</button>
      </div>

      <div v-if="check" class="update-box">
        <div v-if="check.error" class="up-row warn">{{ check.error }}</div>
        <template v-else>
          <div class="up-row">
            <span>当前</span><b>v{{ check.current }}</b>
            <span class="arrow">→</span>
            <span>最新</span><b :class="{ hot: check.hasUpdate }">v{{ check.latest }}</b>
            <span v-if="check.hasUpdate" class="badge-new">有新版本</span>
            <span v-else class="badge-ok">已是最新</span>
          </div>
          <div v-if="check.hasUpdate" class="up-hint">
            <template v-if="check.canAutoUpgrade">
              ✅ 脚本安装支持一键升级：会自动下载、校验、切换目录、重启服务，失败自动回滚。
            </template>
            <template v-else-if="check.installType === 'docker'">
              🐳 Docker 部署请执行：<code>docker compose pull && docker compose up -d</code>
            </template>
            <template v-else-if="check.installType === 'portable'">
              📦 单文件版：去 <a :href="check.releaseUrl" target="_blank" rel="noopener">GitHub Release</a>
              下载新版 zip，解压后把旧的 <code>data/</code> 目录拷过去再启动。
            </template>
            <template v-else>
              开发环境：<code>git pull && npm install && npm run build</code>
            </template>
          </div>
          <div v-if="check.notes" class="up-notes"><pre>{{ check.notes }}</pre></div>
          <div v-if="check.releaseUrl" class="up-row">
            <a :href="check.releaseUrl" target="_blank" rel="noopener">在 GitHub 查看 Release →</a>
          </div>
        </template>
      </div>

      <div v-if="job" class="job-box">
        <div class="up-row">升级{{ job.running ? '中' : '已结束' }}<span v-if="job.code !== null">（退出码 {{ job.code }}）</span></div>
        <pre class="job-log">{{ (job.log || []).join('\n') }}</pre>
      </div>
    </div>

    <div class="setting-block">
      <h4><AppIcon icon="mdi:help-circle-outline" /> 三种安装方式</h4>
      <ul class="about-list">
        <li><b>脚本安装</b>（推荐）：<code>curl -fsSL https://raw.githubusercontent.com/qxsraiy/onepanel-home/main/install.sh | bash</code>
          —— 支持自动升级与自动回滚</li>
        <li><b>Docker</b>：<code>docker compose up -d</code> —— 数据在 volume，升级用 pull</li>
        <li><b>单文件版</b>：下载 zip 解压即用（内嵌 Node），手动替换升级</li>
      </ul>
    </div>
  </div>
</template>
<style scoped>
.about { padding: 2px; }
/* 段间距：每个 setting-block 之间留 20px */
.about .setting-block { margin-bottom: 20px; }
.about .setting-block:last-child { margin-bottom: 2px; }
.about .setting-block h4 { margin-bottom: 4px; }
.tip { font-size: 12px; opacity: .55; line-height: 1.75; margin: 6px 0 10px; }
.tip code { font-family: ui-monospace, monospace; font-size: 11.5px; padding: 1px 5px; border-radius: 4px;
  background: color-mix(in srgb, var(--theme-color) 8%, transparent); }
.ver-grid { display: flex; flex-direction: column; gap: 8px; }
.vr { display: flex; gap: 12px; font-size: 12.5px; padding: 7px 11px; border-radius: 9px;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); }
.vr span { width: 76px; opacity: .55; flex-shrink: 0; }
.vr b { font-weight: 600; }
.row-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.update-box { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.up-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; flex-wrap: wrap; }
.up-row.warn { color: #fbbf24; }
.up-row b.hot { color: #34d399; }
.arrow { opacity: .4; }
.badge-new { font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
  background: color-mix(in srgb, #10b981 20%, transparent); color: #10b981; }
.badge-ok { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; opacity: .45;
  background: color-mix(in srgb, var(--theme-color) 10%, transparent); }
.up-hint { font-size: 12px; line-height: 1.8; padding: 10px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--theme-accent, #3b82f6) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-accent, #3b82f6) 22%, transparent); }
.up-hint code { font-family: ui-monospace, monospace; font-size: 11.5px; }
.up-notes pre { margin: 0; font-size: 11.5px; line-height: 1.7; max-height: 220px; overflow-y: auto;
  padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); }
.job-box { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.job-log { margin: 0; max-height: 200px; overflow-y: auto; font-size: 11px; line-height: 1.6;
  font-family: ui-monospace, monospace; padding: 10px; border-radius: 9px;
  background: color-mix(in srgb, var(--theme-color) 5%, transparent); white-space: pre-wrap; }
.about-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; line-height: 2; opacity: .78; }
.about-list code { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
</style>