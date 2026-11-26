<script setup>
/**
 * 共享网络面板（v3.6.2 简化版）
 * ------------------------------------------------------------------
 * 设计原则：默认只看两件事——"邀请新设备"的两个按钮。
 * 成员表 / 拓扑 / 手动同步 / 踢人 全部收进折叠区，不打扰普通使用。
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import QRCode from 'qrcode'
import AppIcon from './AppIcon.vue'
import NetworkTopology from './NetworkTopology.vue'
import { toast, copyToClipboard } from '../utils/common'

const emit = defineEmits(['refresh-items']);

const loading = ref(false);
const busy = ref(false)
// 两步确认（替代原生 confirm）
let kickArmed = null
let joinArmed = false;
const status = ref(null);
const info = ref(null);
const selfUrls = ref('');

const showInvite = ref('');       // '' | qr | code
const pairQr = ref('');
const pairText = ref('');
const showMembers = ref(false)
// 【安全 v3.13.0】待批准的入网请求（账号密码方式入网时，必须在这里点批准）
const joinRequests = ref([])
let joinReqTimer = null
// 【全网节点状态】鼠标悬停节点时显示该节点的 CPU/内存/磁盘
// 网络域名配置（入网时自动继承）
const netConfig = ref(null)
const pulling = ref(false)
// 界面编辑网络域名配置（不用改 env）
const netEditing = ref(false)
const netSaving = ref(false)
const netForm = ref({ cookieDomain: '', webauthnRpId: '', cookieSecure: true })
function startEditNet() {
  netForm.value = {
    cookieDomain: netConfig.value?.cookieDomain || '',
    webauthnRpId: netConfig.value?.webauthnRpId || '',
    cookieSecure: netConfig.value?.cookieSecure !== false,
  }
  netEditing.value = true
}
async function saveNet() {
  netSaving.value = true
  try {
    const { data } = await axios.put('/api/net-config', netForm.value)
    netEditing.value = false
    toast(data.needRelogin ? '已保存，域名变了需要重新登录' : '已保存并立即生效', 'success', 6000)
    await loadNetConfig()
    if (data.needRelogin) setTimeout(() => location.reload(), 2000)
  } catch (e) {
    toast(e.response?.data?.error || '保存失败', 'error', 8000)
  } finally { netSaving.value = false }
}
async function pullNetConfig() {
  pulling.value = true
  try {
    const { data } = await axios.post('/api/net-config/pull')
    if (data.ok) {
      toast('已从网络继承：' + data.cookieDomain + ' / ' + data.webauthnRpId, 'success', 6000)
      await loadNetConfig()
    } else {
      toast(data.reason || '没有节点能提供配置', 'warn', 6000)
    }
  } catch (e) {
    toast(e.response?.data?.error || '拉取失败', 'error')
  } finally { pulling.value = false }
}

async function loadNetConfig() {
  try { const { data } = await axios.get('/api/net-config'); netConfig.value = data } catch { netConfig.value = null }
}
const nodeStats = ref({ self: null, nodes: [], ts: 0 })
const hoverNodeId = ref('')
let nodeStatsTimer = null
async function loadNodeStats() {
  try {
    const { data } = await axios.get('/api/nodes/stats')
    nodeStats.value = data
  } catch { /* 忽略 */ }
}
/** 按 nodeId 找状态：本机返回 self，其他在 nodes 里找 */
/** nodeId -> 状态对象（给拓扑图用） */
/** 提示用户填什么地址（优先用当前访问地址） */
// 当前登录账号（邀请时显示，避免用户记错）
const currentUsername = ref('')
async function loadAccount() {
  try { const { data } = await axios.get('/api/config/account'); currentUsername.value = data.username || '' } catch { /* 忽略 */ }
}

// 三个区块的折叠状态
const showInviteBlock = ref(true)
const showNetConfigBlock = ref(false)

const selfUrlHint = computed(() => {
  if (typeof window === 'undefined') return 'https://你的域名'
  return window.location.origin
})

const nodeStatsMap = computed(() => {
  const out = {}
  const s = nodeStats.value
  if (!s) return out
  if (s.self && s.self.nodeId) out[s.self.nodeId] = { ...s.self, online: true }
  for (const n of (s.nodes || [])) out[n.nodeId] = n
  return out
})

function statsFor(nodeId) {
  const s = nodeStats.value
  if (!s) return null
  if (nodeId && s.self && s.self.nodeId === nodeId) return s.self
  return (s.nodes || []).find((n) => n.nodeId === nodeId) || null
}
function fmtMem(mem) {
  if (!mem || !mem.total) return '—'
  const g = (n) => (n / 1024 / 1024 / 1024).toFixed(1)
  return g(mem.used) + ' / ' + g(mem.total) + ' GB（' + (mem.percent ?? 0) + '%）'
}
function fmtDisk(disk) {
  if (!disk || !disk.total) return '—'
  const g = (n) => (n / 1024 / 1024 / 1024).toFixed(1)
  return g(disk.used) + ' / ' + g(disk.total) + ' GB（' + (disk.percent ?? 0) + '%）'
}
function fmtUptime(sec) {
  if (!sec && sec !== 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return (d ? d + ' 天 ' : '') + h + ' 小时 ' + m + ' 分'
}

async function loadJoinRequests() {
  try {
    const { data } = await axios.get('/api/join/requests')
    joinRequests.value = data.items || []
  } catch { joinRequests.value = [] }
}
async function approveJoin(item) {
  try {
    await axios.post('/api/join/approve', { requestId: item.requestId })
    toast('已批准 ' + String(item.nodeId).slice(0, 6) + ' 入网', 'success')
    await loadJoinRequests()
    await load()
  } catch (e) { toast(e.response?.data?.error || '批准失败', 'error') }
}
async function rejectJoin(item) {
  try {
    await axios.post('/api/join/reject', { requestId: item.requestId })
    toast('已拒绝', 'success')
    await loadJoinRequests()
  } catch (e) { toast(e.response?.data?.error || '拒绝失败', 'error') }
}
onMounted(() => {
  loadJoinRequests()
  joinReqTimer = setInterval(loadJoinRequests, 5000)
  loadNodeStats()
  loadNetConfig()
  nodeStatsTimer = setInterval(loadNodeStats, 15000)
})
onUnmounted(() => {
  if (joinReqTimer) clearInterval(joinReqTimer)
  if (nodeStatsTimer) clearInterval(nodeStatsTimer)
});
const showAdvanced = ref(false);
const peerUrl = ref('');
const joinForm = ref({ url: '', username: '', password: '', selfUrls: '' });
const showJoinOther = ref(false);

async function load() {
  loading.value = true;
  try {
    const [s, i] = await Promise.all([axios.get('/api/sync/status'), axios.get('/api/node/info')]);
    status.value = s.data;
    info.value = i.data;
    selfUrls.value = (i.data && i.data.selfUrls) || '';
  } catch (e) {
    toast(e.response?.data?.error || '读取同步状态失败', 'error');
  } finally { loading.value = false; }
}

const otherMembers = computed(() => (status.value?.members || []).filter((m) => m.role !== 'self'));

async function makeInvite(kind) {
  busy.value = true;
  try {
    const { data } = await axios.post('/api/pair/new', { url: (selfUrls.value || '').split(',')[0] || '' });
    pairText.value = data.text || '';
    pairQr.value = '';
    pairStamp = Date.now();
    if (kind === 'qr' && pairText.value) {
      try {
        pairQr.value = await QRCode.toDataURL(pairText.value, { margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#0b1220', light: '#ffffff' } });
      } catch { pairQr.value = ''; }
    }
    showInvite.value = kind;
    toast(kind === 'qr' ? '二维码已生成，10 分钟内有效' : '授权码已生成，10 分钟内有效', 'success');
  } catch (e) {
    toast(e.response?.data?.error || '生成失败', 'error');
  } finally { busy.value = false; }
}

// 同一张配对票既用于二维码也用于授权码；点一下展开、再点收起，不重新生成
let pairStamp = 0
const PAIR_TTL = 9 * 60 * 1000   // 后端 10 分钟过期，前端留 1 分钟余量
const toggleInvite = async (kind) => {
  if (showInvite.value === kind) { showInvite.value = ''; return }   // 收起
  // 已有且未过期 -> 直接显示（不重新生成）
  if (pairText.value && Date.now() - pairStamp < PAIR_TTL) {
    if (kind === 'qr' && !pairQr.value) {
      try { pairQr.value = await QRCode.toDataURL(pairText.value, { margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#0b1220', light: '#ffffff' } }) } catch { pairQr.value = '' }
    }
    showInvite.value = kind
    return
  }
  await makeInvite(kind)
}

async function copyText(text) {
  const ok = await copyToClipboard(text)
  toast(ok ? '已复制' : '复制失败，请手动选中文本', ok ? 'success' : 'warn')
}

// 本机设备名（拓扑图与对方成员列表显示）
const nodeNameDraft = ref('')
watch(() => status.value?.nodeName, (v) => { if (v !== undefined) nodeNameDraft.value = v || '' }, { immediate: true })
async function saveNodeName() {
  busy.value = true
  try {
    await axios.put('/api/node/name', { name: nodeNameDraft.value.trim() })
    toast('设备名已保存', 'success')
    await load()
  } catch (e) {
    toast(e.response?.data?.error || '保存失败', 'error')
  } finally { busy.value = false }
}

async function saveUrls() {
  busy.value = true;
  try {
    const list = String(selfUrls.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    await axios.put('/api/node/urls', { urls: list });
    toast('已保存本机地址', 'success');
    await load();
  } catch (e) {
    toast(e.response?.data?.error || '保存失败', 'error');
  } finally { busy.value = false; }
}

async function syncNow() {
  busy.value = true;
  try {
    const { data } = await axios.post('/api/sync/now');
    const list = data.results || [];
    const ok = list.filter((r) => r.ok).length;
    toast('同步完成：' + ok + '/' + list.length + ' 台成功', ok === list.length ? 'success' : 'warn');
    await load();
    emit('refresh-items');
  } catch (e) {
    toast(e.response?.data?.error || '同步失败', 'error');
  } finally { busy.value = false; }
}

async function revoke(member) {
  // 轻量确认：用 toast 二次点击替代原生 confirm（原生弹窗破坏观感）
  if (!kickArmed || kickArmed.nodeId !== member.nodeId) {
    kickArmed = { nodeId: member.nodeId }
    toast('再点一次确认踢出 ' + String(member.nodeId || '').slice(0, 6), 'warn', 4000)
    return
  }
  kickArmed = null
  busy.value = true;
  try {
    await axios.post('/api/sync/revoke', { nodeId: member.nodeId });
    toast('已踢出，其他节点会自动跟随', 'success');
    await load();
  } catch (e) {
    toast(e.response?.data?.error || '踢出失败', 'error');
  } finally { busy.value = false; }
}

async function addPeer() {
  if (!peerUrl.value.trim()) return toast('请输入对方地址', 'warn');
  busy.value = true;
  try {
    await axios.post('/api/sync/peers', { url: peerUrl.value.trim() });
    toast('已加入成员表', 'success');
    peerUrl.value = '';
    await load();
  } catch (e) {
    toast(e.response?.data?.error || '添加失败', 'error');
  } finally { busy.value = false; }
}

async function joinOtherNetwork() {
  const f = joinForm.value;
  if (!f.url.trim() || !f.username.trim() || !f.password) return toast('请填完整', 'warn');
  if (!joinArmed) { joinArmed = true; toast('再点一次确认：这会覆盖本机数据，建议先备份', 'warn', 5000); return }
  joinArmed = false
  busy.value = true;
  try {
    const { data } = await axios.post('/api/join/from', { url: f.url.trim(), username: f.username.trim(), password: f.password, selfUrls: f.selfUrls.trim() });
    toast('已加入：' + data.items + ' 张卡片', 'success', 5000);
    showJoinOther.value = false;
    await load();
    emit('refresh-items');
  } catch (e) {
    toast(e.response?.data?.error || '加入失败', 'error', 6000);
  } finally { busy.value = false; }
}

const highlighted = ref('')
const highlightMember = (nodeId) => {
  highlighted.value = nodeId
  showMembers.value = true
  setTimeout(() => {
    const el = document.querySelector('[data-member="' + nodeId + '"]')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, 140)
}

const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN') : '—');
const shortId = (id) => String(id || '').slice(0, 6);

onMounted(load);
</script>

<template>
  <div class="sync-pane">
    <!-- ===== 网络拓扑（固定在最上方，不折叠）===== -->
    <div class="setting-block topo-block">
      <NetworkTopology
        :node-id="status?.nodeId || ''"
        :node-name="status?.nodeName || ''"
        :members="otherMembers"
        :stats="nodeStatsMap"
        @pick="highlightMember"
      />
    </div>

    <!-- ===== 邀请新设备（账号密码 + 人工批准）===== -->
    <div class="setting-block">
      <button class="fold-head" @click="showInviteBlock = !showInviteBlock">
        <AppIcon icon="mdi:account-multiple-plus-outline" />
        <span>邀请新设备加入</span>
        <AppIcon :icon="showInviteBlock ? 'mdi:chevron-up' : 'mdi:chevron-down'" class="fold-arrow" />
      </button>
      <div v-if="showInviteBlock" class="fold-body">
        <div class="invite-guide">
          <div class="ig-row">
            <span class="ig-label">节点地址</span>
            <code class="ig-val">{{ selfUrlHint }}</code>
          </div>
          <div class="ig-row">
            <span class="ig-label">管理员账号</span>
            <code class="ig-val">{{ status?.username || currentUsername }}</code>
          </div>
          <div class="ig-row">
            <span class="ig-label">管理员密码</span>
            <code class="ig-val">你自己的登录密码</code>
          </div>
        </div>
        <p class="tip" style="margin-top:10px">
          新设备提交后会出现在这页的<b>「待批准的入网请求」</b>里，你点批准才会真正加入（5 分钟内有效）。
        </p>
      </div>
    </div>

    <!-- ===== 待批准的入网请求 ===== -->
    <div v-if="joinRequests.length" class="setting-block pending-block">
      <h4><AppIcon icon="mdi:account-alert-outline" /> 待批准的入网请求（{{ joinRequests.length }}）</h4>
      <p class="tip">有人用账号密码申请加入本网络。确认是你在操作再点批准。</p>
      <div class="pending-list">
        <div v-for="r in joinRequests" :key="r.requestId" class="pending-row">
          <div class="pr-info">
            <code>{{ String(r.nodeId).slice(0, 8) }}</code>
            <span class="pr-ip">{{ r.ip || '未知地址' }}</span>
            <span class="pr-wait">{{ r.waitedSec }} 秒前</span>
          </div>
          <div class="pr-actions">
            <button class="btn-outline danger-mini" @click="rejectJoin(r)">拒绝</button>
            <button class="btn-primary" @click="approveJoin(r)">批准</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 网络域名配置（可直接在界面编辑）===== -->
    <div v-if="netConfig" class="setting-block" :class="{ 'cfg-warn': !netConfig.cookieDomain }">
      <button class="fold-head" @click="showNetConfigBlock = !showNetConfigBlock">
        <AppIcon icon="mdi:earth" />
        <span>网络域名配置</span>
        <AppIcon :icon="showNetConfigBlock ? 'mdi:chevron-up' : 'mdi:chevron-down'" class="fold-arrow" />
      </button>
      <div v-if="showNetConfigBlock" class="fold-body">

      <!-- 展示态 -->
      <template v-if="!netEditing">
        <template v-if="netConfig.cookieDomain">
          <div class="cfg-row"><span>Cookie 域</span><b>{{ netConfig.cookieDomain }}</b></div>
          <div class="cfg-row"><span>Passkey RP ID</span><b>{{ netConfig.webauthnRpId || '—' }}</b></div>
          <div class="cfg-row"><span>强制 HTTPS</span><b>{{ netConfig.cookieSecure ? '是' : '否' }}</b></div>
          <div class="cfg-row"><span>来源</span><b>{{ netConfig.source === 'env' ? '环境变量' : (netConfig.source === 'db' ? '面板/入网继承' : '未设置') }}</b></div>
        </template>
        <p v-else class="tip warn-text">⚠️ 还没配置。多节点要共用登录态和 Passkey 的话，填一下父域即可。</p>
        <div class="row-actions" style="margin-top:10px">
          <button class="btn-outline" @click="startEditNet">{{ netConfig.cookieDomain ? '修改' : '填写配置' }}</button>
          <button class="btn-outline" :disabled="pulling" @click="pullNetConfig">
            {{ pulling ? '拉取中…' : '从其他节点拉取' }}
          </button>
        </div>
        <p class="tip">加新节点不用改这里 —— 新节点入网时会自动继承，老节点不受影响。</p>
      </template>

      <!-- 编辑态 -->
      <template v-else>
        <div class="cfg-edit">
          <label>Cookie 域（多节点共用登录态）</label>
          <input v-model="netForm.cookieDomain" class="glass-input" placeholder=".xtay.cn（前面带点是父域）" />
          <label>Passkey RP ID（必须和访问域名同源）</label>
          <input v-model="netForm.webauthnRpId" class="glass-input" placeholder="xtay.cn（不要带前导点）" />
          <label class="cfg-check">
            <input type="checkbox" v-model="netForm.cookieSecure" />
            强制 Cookie 走 HTTPS（反代 + SSL 时必开）
          </label>
          <p class="tip">
            <b>说明：</b>域名是 <code>cn.xtay.cn</code> / <code>us.xtay.cn</code> 这种时，父域就是 <code>xtay.cn</code>。<br>
            填完后保存立即生效，不用重启服务。改了 Cookie 域需要重新登录一次。
          </p>
          <div class="row-actions" style="margin-top:10px">
            <button class="btn-primary" :disabled="netSaving" @click="saveNet">
              {{ netSaving ? '保存中…' : '保存' }}
            </button>
            <button class="btn-outline" :disabled="netSaving" @click="netEditing = false">取消</button>
          </div>
        </div>
      </template>
    </div>
      </div>

    <!-- ===== 折叠：已加入的设备 ===== -->
    <div class="setting-block">
      <button class="fold-head" @click="showMembers = !showMembers">
        <AppIcon icon="mdi:server-network" />
        <span>已加入的设备（{{ otherMembers.length }}）</span>
        <AppIcon :icon="showMembers ? 'mdi:chevron-up' : 'mdi:chevron-down'" class="fold-arrow" />
      </button>

      <div v-if="showMembers" class="fold-body">
        <div class="form-group">
          <label>本机名字（拓扑图和对方的成员列表里显示）</label>
          <div class="row">
            <input v-model="nodeNameDraft" class="glass-input flex-1" maxlength="40" placeholder="例如：客厅 NAS" />
            <button class="btn-outline" :disabled="busy" @click="saveNodeName">保存</button>
          </div>
        </div>

        <div class="form-group">
          <label>本机对外地址（多个用英文逗号分隔）</label>
          <div class="row">
            <input v-model="selfUrls" class="glass-input flex-1" placeholder="http://192.168.2.101:3000" />
            <button class="btn-outline" :disabled="busy" @click="saveUrls">保存</button>
          </div>
        </div>

        <div class="member-list" style="margin-bottom:10px">
          <div class="member-row self-row">
            <span class="dot active"></span>
            <code class="member-id">{{ status?.nodeName || '本机' }}</code>
            <span class="member-url">本地节点（你自己）</span>
            <span class="member-time">{{ fmtTime(status?.lastSyncAt) }}</span>
                      </div>
        </div>

        <div v-if="!otherMembers.length" class="tip">还没有其他设备。用上面的「邀请新设备加入」把另一台接进来。</div>
        <div v-else class="member-list">
          <div
            v-for="m in otherMembers" :key="m.nodeId"
            class="member-row" :class="{ hl: highlighted === m.nodeId }" :data-member="m.nodeId"
          >
            <span class="dot" :class="m.status"></span>
            <code class="member-id" :title="m.nodeId">{{ m.name || shortId(m.nodeId) }}</code>
            <span class="member-url">{{ m.selfUrls || '—' }}</span>
            <span class="member-time">{{ fmtTime(m.lastSyncAt) }}</span>

          </div>
        </div>

        <div class="row mt-2">
          <button class="btn-outline" :disabled="busy" @click="syncNow">立即同步</button>
          <span class="tip" style="margin:0">上次同步：{{ fmtTime(status?.lastSyncAt) }}</span>
        </div>
      </div>
    </div>

    <!-- ===== 折叠：高级 ===== -->
    <div class="setting-block">
      <button class="fold-head" @click="showAdvanced = !showAdvanced">
        <AppIcon icon="mdi:cog-outline" />
        <span>高级</span>
        <AppIcon :icon="showAdvanced ? 'mdi:chevron-up' : 'mdi:chevron-down'" class="fold-arrow" />
      </button>

      <div v-if="showAdvanced" class="fold-body">
        <div class="form-group">
          <label>手动添加节点（知道对方地址时）</label>
          <div class="row">
            <input v-model="peerUrl" class="glass-input flex-1" placeholder="http://另一台节点地址" />
            <button class="btn-outline" :disabled="busy" @click="addPeer">添加</button>
          </div>
        </div>

        <div class="form-group">
          <label>踢出设备</label>
          <div v-if="!otherMembers.length" class="tip">没有可踢的设备</div>
          <div v-else class="member-list">
            <div v-for="m in otherMembers" :key="'k' + m.nodeId" class="member-row">
              <code class="member-id" :title="m.nodeId">{{ m.name || shortId(m.nodeId) }}</code>
              <span class="member-url">{{ m.status }}</span>
              <button class="btn-outline danger-mini" :disabled="busy || m.status === 'revoked'" @click="revoke(m)">踢出</button>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>加入别的网络（会覆盖本机数据）</label>
          <button v-if="!showJoinOther" class="btn-outline" @click="showJoinOther = true">展开</button>
          <div v-else class="join-other">
            <input v-model="joinForm.url" class="glass-input" placeholder="老节点地址 http://..." />
            <div class="row">
              <input v-model="joinForm.username" class="glass-input flex-1" placeholder="账号" />
              <input v-model="joinForm.password" type="password" class="glass-input flex-1" placeholder="密码" />
            </div>
            <input v-model="joinForm.selfUrls" class="glass-input" placeholder="本机对外地址（可留空）" />
            <div class="row">
              <button class="btn-outline" @click="showJoinOther = false">取消</button>
              <button class="btn-primary" :disabled="busy" @click="joinOtherNetwork">{{ busy ? '处理中…' : '覆盖并加入' }}</button>
            </div>
          </div>
        </div>

        <p class="tip">本机节点 ID：<code>{{ info?.nodeId || '—' }}</code></p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sync-pane { padding: 2px; }
/* 网络拓扑固定顶部，不折叠，上下留一点呼吸 */
.topo-block { margin-bottom: 14px; padding: 4px 2px; }
.member-row { position: relative; }
.self-row { opacity: .72; }
.cfg-edit { display: flex; flex-direction: column; gap: 4px; }
.cfg-edit label { font-size: 11.5px; opacity: .55; margin: 8px 0 3px; }
.cfg-edit .cfg-check { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: .8; margin-top: 10px; cursor: pointer; }
.cfg-edit .cfg-check input { width: auto; }
.cfg-row { display: flex; gap: 12px; font-size: 12.5px; padding: 6px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); margin-bottom: 6px; }
.cfg-row span { width: 100px; opacity: .55; flex-shrink: 0; }
.cfg-row b { font-weight: 500; font-family: ui-monospace, monospace; font-size: 12px; }
.cfg-warn { border-color: color-mix(in srgb, #f59e0b 35%, transparent) !important; }
.warn-text { color: #fbbf24; }
.pending-block {
  border-color: color-mix(in srgb, #f59e0b 40%, transparent) !important;
  background: color-mix(in srgb, #f59e0b 6%, transparent);
}
.pending-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.pending-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 11px; border-radius: 10px;
  background: color-mix(in srgb, var(--theme-color) 6%, transparent);
  font-size: 12px;
}
.pr-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.pr-info code { font-family: ui-monospace, monospace; font-size: 11.5px; }
.pr-ip { opacity: .55; font-family: ui-monospace, monospace; font-size: 11px; }
.pr-wait { margin-left: auto; opacity: .4; font-size: 11px; }
.pr-actions { display: flex; gap: 8px; flex-shrink: 0; }
.pr-actions .btn-primary { padding: 5px 14px; font-size: 12px; }
.setting-block { margin-bottom: 14px; }
.tip { font-size: 12px; opacity: .55; line-height: 1.7; margin: 6px 0 0; }
.warn-tip { color: #fbbf24; opacity: .9; }

/* 两个主按钮：并排、等宽、图标在上 */
.invite-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.invite-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  padding: 16px 10px; border-radius: 14px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent);
  background: color-mix(in srgb, var(--theme-color) 5%, transparent);
  color: inherit; font: inherit; font-size: 13px; font-weight: 600;
  transition: background .15s ease, border-color .15s ease, transform .15s ease;
}
.invite-btn:hover { background: color-mix(in srgb, var(--theme-accent, #3b82f6) 12%, transparent); border-color: color-mix(in srgb, var(--theme-accent, #3b82f6) 45%, transparent); transform: translateY(-1px); }
.invite-btn:active { transform: scale(.98); }
.invite-btn:disabled { opacity: .5; cursor: not-allowed; }
.invite-icon { font-size: 22px; opacity: .85; }

.invite-result { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
.pair-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.pair-qr { width: 168px; height: 168px; border-radius: 12px; background: #fff; padding: 8px; box-shadow: 0 4px 18px -4px rgba(0,0,0,.35); }
.pair-qr-tip { font-size: 11.5px; opacity: .55; }
.pair-box { width: 100%; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5; padding: 9px 10px; border-radius: 10px; resize: vertical;
  background: color-mix(in srgb, var(--theme-color) 6%, transparent); border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent); color: inherit; }
.invite-actions { display: flex; gap: 8px; }

/* 折叠头 */
.fold-head { display: flex; align-items: center; gap: 9px; width: 100%; padding: 2px 0; background: none; border: none; color: inherit; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; }
.fold-head:hover { opacity: .8; }
.fold-arrow { margin-left: auto; opacity: .45; }
.fold-body { margin-top: 12px; }

.row { display: flex; gap: 8px; align-items: center; }
.flex-1 { flex: 1; }
.mt-2 { margin-top: 10px; }
.form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.form-group label { font-size: 12px; opacity: .6; }

/* 成员行 */
.member-list { display: flex; flex-direction: column; gap: 6px; }
.member-row.hl { background: color-mix(in srgb, var(--theme-accent, #3b82f6) 16%, transparent); }
.member-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); font-size: 12px; }
.member-id { font-family: ui-monospace, monospace; opacity: .8; }
.member-url { opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.member-time { margin-left: auto; opacity: .45; font-size: 11px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; flex-shrink: 0; }
.dot.active { background: #10b981; }
.dot.revoked { background: #ef4444; }
.dot.offline { background: #f59e0b; }
.danger-mini { padding: 4px 10px; font-size: 11.5px; color: #f87171; border-color: rgba(248,113,113,.3); }
.danger-mini:hover { background: rgba(248,113,113,.12); }
.join-other { display: flex; flex-direction: column; gap: 8px; }
</style>
