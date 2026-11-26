<script setup>
/**
 * 新节点引导（v3.6.1）
 * ------------------------------------------------------------------
 * 新设备装好后**未登录**就能看到两个入口：
 *   ① 用账号密码加入（老节点需人工批准）  ② 不加入，单独使用（新组织第一台）
 *
 * 为什么去掉「扫码」和「输入授权码」：
 *   授权码里带的地址是老节点自报的 selfUrls，填错（内网 IP / 未填）就连不上，
 *   而报错又是 "Unexpected token '<'" 这种看不懂的。账号密码方式让用户
 *   自己填地址，加上老节点人工批准（双重验证），更安全也更省心。
 *
 * 为什么扫码要检测：getUserMedia 只在 HTTPS 或 localhost 下可用，
 * 内网 http://192.168.x.x 调不起摄像头 -> 自动降级提示"用系统相机扫后粘贴"。
 * 解码优先用 BarcodeDetector（Chrome/Edge 支持），不支持也不引额外库。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import { toast } from '../utils/common'
import SelectBox from './SelectBox.vue'

const emit = defineEmits(['done']);

const mode = ref('');          // '' | scan | code | account | local
const busy = ref(false);
const pairText = ref('');
const accForm = ref({ url: '', username: 'admin', password: '', selfUrls: '' });
// 这台设备的名字：会显示在对方的成员列表和拓扑图里
const nodeName = ref(localStorage.getItem('opNodeNameDraft') || '');

// 扫码能力探测
const hasCamera = ref(false);
const hasDetector = ref(false);
const scanError = ref('');
const videoEl = ref(null);
let mediaStream = null;
let detectTimer = null;

const scanReady = computed(() => hasCamera.value && hasDetector.value);

onMounted(async () => {
  try {
    hasDetector.value = typeof window.BarcodeDetector !== 'undefined';
  } catch { hasDetector.value = false; }
  try {
    hasCamera.value = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  } catch { hasCamera.value = false; }
});

onUnmounted(stopScan);

function stopScan() {
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (videoEl.value) videoEl.value.srcObject = null;
}

async function startScan() {
  mode.value = 'scan';
  scanError.value = '';
  if (!scanReady.value) {
    scanError.value = hasDetector.value
      ? '当前地址不是 HTTPS（或 localhost），浏览器不允许打开摄像头。请用手机系统相机扫码，然后把内容粘贴到「输入授权码」。'
      : '当前浏览器不支持网页扫码（建议 Chrome / Edge）。请用系统相机扫码后粘贴到「输入授权码」。';
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream;
      await videoEl.value.play().catch(() => {});
    }
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    detectTimer = setInterval(async () => {
      try {
        if (!videoEl.value || videoEl.value.readyState < 2) return;
        const codes = await detector.detect(videoEl.value);
        if (codes && codes.length) {
          const raw = codes[0].rawValue || '';
          if (raw) {
            stopScan();
            pairText.value = raw;
            mode.value = 'code';
            toast('已识别二维码', 'success');
          }
        }
      } catch { /* 单帧失败忽略 */ }
    }, 500);
  } catch (e) {
    scanError.value = '打不开摄像头：' + (e.message || e) + '。可以改用系统相机扫码后粘贴。';
  }
}

async function joinByCode() {
  if (!pairText.value.trim()) return toast('请粘贴授权码', 'warn');
  busy.value = true;
  try {
    const { data } = await axios.post('/api/join/from', { pairText: pairText.value.trim(), selfUrls: accForm.value.selfUrls.trim(), nodeName: nodeName.value.trim() });
    toast('已加入网络：' + data.items + ' 张卡片 / ' + data.members + ' 个成员', 'success', 5000);
    emit('done');
  } catch (e) {
    toast(e.response?.data?.error || '入网失败', 'error', 6000);
  } finally { busy.value = false; }
}

async function joinByAccount() {
  const f = accForm.value;
  if (!f.url.trim() || !f.username.trim() || !f.password) return toast('请填老节点地址、账号、密码', 'warn');
  busy.value = true;
  try {
    const { data } = await axios.post('/api/join/from', { url: f.url.trim(), username: f.username.trim(), password: f.password, selfUrls: f.selfUrls.trim(), nodeName: nodeName.value.trim() });
    toast('已加入网络：' + data.items + ' 张卡片', 'success', 5000);
    emit('done');
  } catch (e) {
    toast(e.response?.data?.error || '入网失败', 'error', 6000);
  } finally { busy.value = false; }
}

// 【新组织第一台】单独使用前先定域名（可跳过）
const domainForm = ref({ cookieDomain: '', webauthnRpId: '' });
const domainBusy = ref(false);

async function useStandalone() {
  // 先进入域名配置步骤（不是直接 skip）
  mode.value = 'standalone';
}

async function confirmStandalone(skipDomain) {
  domainBusy.value = true;
  try {
    if (!skipDomain) {
      const cd = String(domainForm.value.cookieDomain || '').trim();
      const rp = String(domainForm.value.webauthnRpId || '').trim();
      if (cd || rp) {
        await axios.post('/api/setup/domain', { cookieDomain: cd, webauthnRpId: rp });
      }
    }
    await axios.post('/api/setup/skip');
    emit('done');
  } catch (e) {
    toast(e.response?.data?.error || '操作失败', 'error', 6000);
  } finally { domainBusy.value = false; }
}
</script>

<template>
  <div class="setup-wrap">
    <div class="setup-card">
      <div class="setup-head">
        <AppIcon icon="mdi:server-network" class="setup-logo" />
        <h1>这台设备还没有数据</h1>
        <p>要把它加入已有的 OnePanel 网络，还是单独使用？</p>
        <p class="setup-note">
          加入网络需要老节点管理员在面板上<b>点批准</b>（5 分钟内有效）
        </p>
      </div>

      <!-- 入口列表 -->
      <div v-if="!mode" class="setup-entries">
        <button class="entry" @click="mode = 'account'">
          <AppIcon icon="mdi:account-key-outline" class="entry-icon" />
          <div class="entry-text">
            <b>用账号密码加入</b>
            <span>填老节点地址和它的管理员账号</span>
          </div>
          <AppIcon icon="mdi:chevron-right" class="entry-arrow" />
        </button>

        <div class="setup-divider"><span>或者</span></div>

        <button class="entry standalone" :disabled="busy" @click="useStandalone">
          <AppIcon icon="mdi:home-outline" class="entry-icon" />
          <div class="entry-text">
            <b>不加入网络，单独使用</b>
            <span>这台设备自己存数据，之后也能再加入</span>
          </div>
          <AppIcon icon="mdi:chevron-right" class="entry-arrow" />
        </button>
      </div>

      <!-- 单独使用：先定域名（新组织第一台） -->
      <div v-else-if="mode === 'standalone'" class="standalone-panel">
        <p class="sa-tip">
          这台将成为你网络里的<b>第一台节点</b>。<br>
          如果你有多台服务器（比如 <code>cn.xtay.cn</code> 和 <code>us.xtay.cn</code>），
          现在填好父域，之后加节点就不用再配了。
        </p>

        <label class="sa-label">Cookie 域（多节点共用登录态）</label>
        <input
          v-model="domainForm.cookieDomain"
          class="glass-input"
          placeholder=".xtay.cn"
        />

        <label class="sa-label">Passkey RP ID</label>
        <input
          v-model="domainForm.webauthnRpId"
          class="glass-input"
          placeholder="xtay.cn"
        />

        <p class="sa-note">
          · 只有一台服务器用 IP 访问 → 直接跳过<br>
          · 有域名但还没配反代 → 先跳过，登录后在设置里补<br>
          · 两个值的关系：RP ID 是父域（<code>xtay.cn</code>），Cookie 域带前导点（<code>.xtay.cn</code>）
        </p>

        <div class="sa-actions">
          <button class="btn-outline" :disabled="domainBusy" @click="confirmStandalone(true)">
            跳过，先不配
          </button>
          <button class="btn-primary" :disabled="domainBusy" @click="confirmStandalone(false)">
            {{ domainBusy ? '保存中…' : '保存并继续' }}
          </button>
        </div>
        <button class="sa-back" @click="mode = ''">← 返回</button>
      </div>

      <div v-else-if="mode === 'account'" class="setup-pane">
        <div class="pane-head"><AppIcon icon="mdi:account-key-outline" /> 用账号密码加入</div>
        <p class="pane-tip">填任意一台已有节点，以及它的管理员账号密码。新设备会继承这些卡片与登录凭据。</p>
        <div class="form-group">
          <label>老节点地址</label>
          <input v-model="accForm.url" class="glass-input" placeholder="http://192.168.2.101:3000" />
        </div>
        <div class="form-row">
          <div class="form-group flex-1"><label>账号</label><input v-model="accForm.username" class="glass-input" /></div>
          <div class="form-group flex-1"><label>密码</label><input v-model="accForm.password" type="password" class="glass-input" /></div>
        </div>
        <div class="form-group">
          <label>这台设备的名字</label>
          <input v-model="nodeName" class="glass-input" maxlength="40" @input="localStorage.setItem('opNodeNameDraft', nodeName)" placeholder="例如：客厅 NAS" />
          <span class="field-hint">会显示在对方的成员列表和网络拓扑图里</span>
        </div>
        <div class="form-group">
          <label>本机对外地址（可留空）</label>
          <input v-model="accForm.selfUrls" class="glass-input" placeholder="http://这台机器地址:3000" />
        </div>
        <div class="pane-actions">
          <button class="btn-outline" @click="mode = ''">返回</button>
          <button class="btn-primary" :disabled="busy" @click="joinByAccount">{{ busy ? '入网中…' : '加入网络' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup-note { font-size: 11.5px; opacity: .45; margin: 8px 0 0; line-height: 1.7; }
.setup-note b { opacity: .7; font-weight: 600; }
.standalone-panel { padding: 4px 2px; }
.sa-tip { font-size: 12.5px; line-height: 1.9; opacity: .72; margin: 0 0 18px; }
.sa-tip code, .sa-note code { font-family: ui-monospace, monospace; font-size: 11.5px;
  background: color-mix(in srgb, var(--theme-color) 9%, transparent); padding: 1px 5px; border-radius: 4px; }
.sa-label { display: block; font-size: 11.5px; opacity: .55; margin: 12px 0 5px; }
.sa-note { font-size: 11.5px; line-height: 1.9; opacity: .45; margin: 14px 0 18px; }
.sa-actions { display: flex; gap: 10px; }
.sa-actions .btn-outline, .sa-actions .btn-primary { flex: 1; }
.sa-back { margin-top: 16px; background: none; border: none; color: inherit; opacity: .4;
  font-size: 11.5px; cursor: pointer; padding: 4px 0; }
.sa-back:hover { opacity: .7; }
.setup-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.setup-card {
  width: min(520px, 100%); padding: 28px; border-radius: 22px;
  background: color-mix(in srgb, var(--theme-bg, #0f172a) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 14%, transparent);
  backdrop-filter: blur(20px);
  box-shadow: 0 32px 80px -16px rgba(0, 0, 0, .55);
  color: var(--theme-color);
}
.setup-head { text-align: center; margin-bottom: 22px; }
.setup-logo { font-size: 34px; opacity: .8; }
.setup-head h1 { margin: 10px 0 6px; font-size: 19px; font-weight: 600; }
.setup-head p { margin: 0; font-size: 13px; opacity: .6; }

.setup-entries { display: flex; flex-direction: column; gap: 10px; }
.entry {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 13px 14px; border-radius: 14px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--theme-color) 12%, transparent);
  background: color-mix(in srgb, var(--theme-color) 5%, transparent);
  color: inherit; font: inherit;
  transition: background .15s ease, border-color .15s ease, transform .15s ease;
}
.entry:hover { background: color-mix(in srgb, var(--theme-color) 9%, transparent); border-color: color-mix(in srgb, var(--theme-accent, #3b82f6) 45%, transparent); transform: translateY(-1px); }
.entry:active { transform: scale(.995); }
.entry.dim { opacity: .62; }
.entry-icon { font-size: 20px; opacity: .85; flex-shrink: 0; }
.entry-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.entry-text b { font-size: 13.5px; font-weight: 600; }
.entry-text span { font-size: 11.5px; opacity: .55; }
.entry-arrow { margin-left: auto; opacity: .35; flex-shrink: 0; }
.entry.standalone { border-style: dashed; }
.setup-divider { display: flex; align-items: center; gap: 10px; margin: 6px 0 2px; font-size: 11px; opacity: .4; }
.setup-divider::before, .setup-divider::after { content: ""; flex: 1; height: 1px; background: color-mix(in srgb, var(--theme-color) 14%, transparent); }

.setup-pane { display: flex; flex-direction: column; gap: 12px; }
.pane-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.pane-tip { margin: 0; font-size: 12px; line-height: 1.7; opacity: .6; }
.scan-video { width: 100%; max-height: 300px; border-radius: 12px; background: #000; object-fit: cover; }
.scan-error { font-size: 12.5px; line-height: 1.7; padding: 10px 12px; border-radius: 10px;
  background: rgba(245, 158, 11, .12); color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, .3); }
.pair-input { font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.6; resize: vertical; }
.pane-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.form-row { display: flex; gap: 10px; }
.flex-1 { flex: 1; }
.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-group label { font-size: 12px; opacity: .6; }
.field-hint { font-size: 11px; opacity: .45; }
</style>
