<script setup>
/**
 * 共享网络面板（v3.6.2 简化版）
 * ------------------------------------------------------------------
 * 设计原则：默认只看两件事——"邀请新设备"的两个按钮。
 * 成员表 / 拓扑 / 手动同步 / 踢人 全部收进折叠区，不打扰普通使用。
 */
import { ref, computed, onMounted, watch } from 'vue'
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
const showMembers = ref(false);
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
    <!-- ===== 唯一的主视觉：邀请新设备 ===== -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:account-multiple-plus-outline" /> 邀请新设备加入</h4>
      <p class="tip">在新设备装好后打开它的面板，扫码或粘贴下面的内容即可。10 分钟内有效、只能用一次。</p>

      <div class="invite-row">
        <button class="invite-btn" :disabled="busy" @click="toggleInvite('qr')">
          <AppIcon icon="mdi:qrcode" class="invite-icon" />
          <span>{{ showInvite === 'qr' ? '收起二维码' : '显示二维码' }}</span>
        </button>
        <button class="invite-btn" :disabled="busy" @click="toggleInvite('code')">
          <AppIcon icon="mdi:key-variant" class="invite-icon" />
          <span>{{ showInvite === 'code' ? '收起授权码' : '显示授权码' }}</span>
        </button>
      </div>

            <div v-if="showInvite" class="invite-result">
        <!-- 二维码模式：只有二维码，不再重复显示下面的文本 -->
        <div v-if="showInvite === 'qr' && pairQr" class="pair-qr-wrap">
          <img :src="pairQr" class="pair-qr" alt="配对二维码" />
          <div class="pair-qr-tip">新设备有摄像头时直接扫这个码</div>
        </div>
        <!-- 授权码模式：只有文本 -->
        <textarea v-else-if="showInvite === 'code'" v-model="pairText" readonly class="pair-box" rows="4"></textarea>
        <div class="invite-actions">
          <button class="btn-outline" @click="copyText(pairText)">复制授权码</button>
          <button class="btn-outline" @click="showInvite = ''">收起</button>
        </div>
        <p class="tip warn-tip">⚠️ 这段内容里有节点地址和一次性配对码，请勿发到群里或论坛。</p>
      </div>
    </div>

    <!-- ===== 网络拓扑 ===== -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:lan-connect" /> 网络拓扑</h4>
      <NetworkTopology
        :node-id="status?.nodeId || ''"
        :node-name="status?.nodeName || ''"
        :members="otherMembers"
        @pick="highlightMember"
      />
      <p class="tip">点节点可在下面列表里定位；悬停显示地址与最后同步时间。</p>
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

        <div v-if="!otherMembers.length" class="tip">还没有其他设备。用上面的二维码或授权码邀请一台。</div>
        <div v-else class="member-list">
          <div v-for="m in otherMembers" :key="m.nodeId" class="member-row" :class="{ hl: highlighted === m.nodeId }" :data-member="m.nodeId">
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
