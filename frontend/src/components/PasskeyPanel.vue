<script setup>
/**
 * Passkey 管理 + 登录（v3.9.1）
 * ------------------------------------------------------------------
 * RP ID 用父域（后端 WEBAUTHN_RP_ID，默认 xtay.cn），
 * 所以任意子域注册的凭据都能在别的子域用。
 * mode="login" 只显示登录按钮；mode="manage" 显示注册/列表/删除。
 */
import { ref, onMounted } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import { toast } from '../utils/common'

const props = defineProps({
  mode: { type: String, default: 'manage' },
});
const emit = defineEmits(['logged-in']);

const supported = ref(false);
const enabled = ref(false);
const list = ref([]);
const busy = ref(false);

function b64urlToBuf(s) {
  // 兼容三种形态：base64url 字符串 / { type:'Buffer', data:[...] } / ArrayBuffer·Uint8Array
  if (s instanceof ArrayBuffer) return s;
  if (s instanceof Uint8Array) return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
  if (s && typeof s === 'object' && Array.isArray(s.data)) {
    return new Uint8Array(s.data).buffer;
  }
  const str = String(s || '');
  const pad = str.length % 4 ? 4 - (str.length % 4) : 0;
  const b = atob((str + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/'));
  const buf = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 1) buf[i] = b.charCodeAt(i);
  return buf.buffer;
}

/**
 * 规范化从后端拿到的 extensions：
 * PRF 的 eval.first 必须是 ArrayBuffer/ArrayBufferView，字符串会直接报错。
 */
function normalizeExtensions(ext) {
  if (!ext || typeof ext !== 'object') return null;
  const out = JSON.parse(JSON.stringify(ext));
  const first = out?.prf?.eval?.first;
  if (first !== undefined && first !== null) {
    try { out.prf.eval.first = b64urlToBuf(first); } catch { delete out.prf.eval.first; }
  }
  return out;
}
function bufToB64url(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function load() {
  supported.value = !!(window.PublicKeyCredential && navigator.credentials);
  if (!supported.value) return;
  try {
    const st = await axios.get('/api/passkey/status');
    enabled.value = !!st.data.enabled;
    if (props.mode === 'manage') {
      const l = await axios.get('/api/passkey/list');
      list.value = l.data.items || [];
    }
  } catch { /* 忽略 */ }
}

async function register() {
  busy.value = true;
  try {
    const { data } = await axios.get('/api/passkey/register/options');
    const o = data.options;
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBuf(o.challenge),
        rp: { id: o.rp.id, name: o.rp.name },
        user: {
          // 【P0-3】必须用后端下发的 user.id，不要写死 16 个 0：
          // 某些认证器/系统钥匙串会按 user.id 去重，全 0 会导致"换账号后凭据被覆盖"
          id: b64urlToBuf(o.user.id),
          name: o.user.name, displayName: o.user.displayName,
        },
        pubKeyCredParams: o.pubKeyCredParams,
        timeout: o.timeout || 60000,
        attestation: o.attestation || 'none',
        authenticatorSelection: o.authenticatorSelection,
        // 【PRF】Chrome / Edge 支持：让认证器派生一个稳定密钥，用来解保险库
        // 【v3.24.0 修复】后端下发的 prf.eval.first 可能是 base64url 字符串、
        // {type:'Buffer',data:[...]} 或数组，统一转成 ArrayBuffer，
        // 否则浏览器报 "The provided value is not of type '(ArrayBuffer or ArrayBufferView)'"。
        ...(normalizeExtensions(o.extensions) ? { extensions: normalizeExtensions(o.extensions) } : {}),
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({
          id: b64urlToBuf(c.id), type: c.type,
        })),
      },
    });
    if (!cred) throw new Error('用户取消');
    const response = {
      id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    // 取 PRF 派生输出（两条路径：getClientExtensionResults 或 cred.getClientExtensionResults）
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    const prfOut = ext?.prf?.results?.first || null;
    const prfOutput = prfOut ? bufToB64url(prfOut) : null;
    const vr = await axios.post('/api/passkey/register/verify', {
      response, challengeKey: data.challengeKey, label: '我的通行密钥', prfOutput,
    });
    toast(
      vr.data?.prfEnabled
        ? '通行密钥已注册（已启用指纹解锁保险库）'
        : '通行密钥已注册，以后可用指纹/Face ID 登录',
      'success', 5000
    );
    await load();
  } catch (e) {
    toast('注册失败：' + (e.response?.data?.error || e.message), 'error', 6000);
  } finally { busy.value = false; }
}

async function login() {
  busy.value = true;
  try {
    const { data } = await axios.get('/api/passkey/login/options');
    const o = data.options;
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBuf(o.challenge),
        rpId: o.rpId,
        timeout: o.timeout || 60000,
        userVerification: o.userVerification || 'preferred',
        ...(normalizeExtensions(o.extensions) ? { extensions: normalizeExtensions(o.extensions) } : {}),
        allowCredentials: (o.allowCredentials || []).map((c) => ({
          id: b64urlToBuf(c.id), type: c.type,
        })),
      },
    });
    if (!assertion) throw new Error('用户取消');
    const response = {
      id: assertion.id, rawId: bufToB64url(assertion.rawId), type: assertion.type,
      response: {
        clientDataJSON: bufToB64url(assertion.response.clientDataJSON),
        authenticatorData: bufToB64url(assertion.response.authenticatorData),
        signature: bufToB64url(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufToB64url(assertion.response.userHandle) : null,
      },
      clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
    };
    const aext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    const aprf = aext?.prf?.results?.first || null;
    const { data: r } = await axios.post('/api/passkey/login/verify', {
      response, challengeKey: data.challengeKey,
      prfOutput: aprf ? bufToB64url(aprf) : null,
    });
    toast(r.vaultUnlocked ? '已用通行密钥登录，保险库已解锁' : '已用通行密钥登录', 'success');
    emit('logged-in', r);
  } catch (e) {
    toast('登录失败：' + (e.response?.data?.error || e.message), 'error', 6000);
  } finally { busy.value = false; }
}

async function remove(item) {
  if (!confirmRemove) {
    confirmRemove = true;
    toast('再点一次确认删除这条通行密钥', 'warn', 4000);
    setTimeout(() => { confirmRemove = false; }, 5000);
    return;
  }
  confirmRemove = false;
  try {
    await axios.delete('/api/passkey/' + encodeURIComponent(item.credentialId));
    toast('已删除', 'success');
    await load();
  } catch (e) { toast('删除失败', 'error'); }
}
let confirmRemove = false;

onMounted(load);
</script>

<template>
  <!-- 登录页按钮 -->
  <div v-if="mode === 'login'" class="pk-login">
    <button v-if="enabled && supported" class="pk-btn" :disabled="busy" @click="login">
      <AppIcon icon="mdi:fingerprint" />
      {{ busy ? '验证中…' : '用通行密钥登录' }}
    </button>
    <p v-else-if="enabled && !supported" class="pk-hint">
      当前浏览器不支持通行密钥（需 HTTPS + Chrome/Edge/Safari 16+）
    </p>
  </div>

  <!-- 设置里管理 -->
  <div v-else class="pk-manage">
    <div v-if="!supported" class="pk-hint">
      <AppIcon icon="mdi:alert-outline" /> 当前浏览器不支持通行密钥，请用 HTTPS 访问并换 Chrome / Edge / Safari 16+
    </div>
    <template v-else>
      <div class="pk-actions">
        <button class="btn-primary" :disabled="busy" @click="register">
          <AppIcon icon="mdi:fingerprint" /> {{ busy ? '处理中…' : '添加通行密钥' }}
        </button>
      </div>
      <div v-if="list.length" class="pk-list">
        <div v-for="k in list" :key="k.credentialId" class="pk-row">
          <AppIcon icon="mdi:key-variant" class="pk-icon" />
          <div class="pk-info">
            <b>{{ k.label || '通行密钥' }}</b>
            <span>{{ String(k.credentialId).slice(0, 12) }}… · {{ k.createdAt }}<b v-if="k.prf" class="prf-tag">指纹解锁</b></span>
          </div>
          <button class="btn-outline danger-mini" @click="remove(k)">删除</button>
        </div>
      </div>
      <p v-else class="pk-hint">还没有通行密钥。添加后可用指纹 / Face ID / Windows Hello 登录。</p>
    </template>
  </div>
</template>

<style scoped>
.pk-login { margin-top: 14px; }
.pk-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 11px 16px; border-radius: 10px; cursor: pointer; font: inherit; font-size: 13px;
  border: 1px solid color-mix(in srgb, var(--theme-color) 22%, transparent);
  background: color-mix(in srgb, var(--theme-color) 6%, transparent);
  color: var(--theme-color); transition: background .14s ease, border-color .14s ease;
}
.pk-btn:hover { background: color-mix(in srgb, var(--theme-accent, #3b82f6) 14%, transparent); border-color: color-mix(in srgb, var(--theme-accent, #3b82f6) 45%, transparent); }
.pk-btn:disabled { opacity: .55; cursor: not-allowed; }
.pk-hint { font-size: 11.5px; line-height: 1.7; opacity: .5; margin: 8px 0 0; display: flex; gap: 6px; align-items: flex-start; }
.pk-actions { margin-bottom: 12px; }
.pk-list { display: flex; flex-direction: column; gap: 8px; }
.pk-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); font-size: 12px; }
.pk-icon { font-size: 16px; opacity: .7; }
.pk-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pk-info b { font-size: 12.5px; }
.pk-info span { font-size: 10.5px; opacity: .45; font-family: ui-monospace, monospace; display: flex; align-items: center; gap: 6px; }
.prf-tag { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; opacity: 1;
  background: color-mix(in srgb, #10b981 22%, transparent); color: #10b981; font-family: inherit; }
.danger-mini { margin-left: auto; padding: 4px 10px; font-size: 11.5px; color: #f87171; border-color: rgba(248,113,113,.3); }
.danger-mini:hover { background: rgba(248,113,113,.12); }
</style>
