<script setup>
/**
 * API 文档 + App Token 管理（v3.10.0）
 * 给手机 App / 桌面小组件用的接口说明 + Token 管理。
 */
import { ref, onMounted } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import { toast } from '../utils/common'

const origin = ref(location.origin)
const tokens = ref([])
const newToken = ref('')
const tokenLabel = ref('')
const busy = ref(false)
const snapInfo = ref('')
let armed = false

async function load() {
  try {
    const r = await axios.get('/api/app/tokens')
    tokens.value = r.data.items || []
  } catch { tokens.value = [] }
}

async function makeToken() {
  busy.value = true
  try {
    const { data } = await axios.post('/api/app/token', { label: tokenLabel.value.trim() || '手机 App' })
    newToken.value = data.token
    toast('Token 已生成，只显示这一次，请立刻复制', 'success', 6000)
    await load()
  } catch (e) {
    toast(e.response?.data?.error || '生成失败', 'error')
  } finally { busy.value = false }
}

async function copyToken() {
  try { await navigator.clipboard.writeText(newToken.value); toast('已复制', 'success') }
  catch { toast('复制失败，请手动选中', 'warn') }
}

async function revoke(prefix) {
  if (!armed) { armed = true; toast('再点一次确认撤销', 'warn', 4000); setTimeout(() => { armed = false }, 5000); return }
  armed = false
  try {
    await axios.delete('/api/app/token/' + encodeURIComponent(prefix))
    toast('已撤销', 'success')
    await load()
  } catch { toast('撤销失败', 'error') }
}

async function rebuildSnapshot() {
  busy.value = true
  try {
    const { data } = await axios.post('/api/app/snapshot/rebuild')
    snapInfo.value = 'v' + data.version + ' · ' + data.bookmarks + ' 条书签 · ' + data.nodes + ' 个节点'
    toast('快照已生成', 'success')
  } catch (e) {
    const msg = e.response?.status === 423 ? '保险库未解锁，请先解锁' : (e.response?.data?.error || e.message)
    toast('生成失败：' + msg, 'error', 6000)
  } finally { busy.value = false }
}

onMounted(load)

// ---- 静态接口清单（文档用）----
const ENDPOINTS = [
  { m: 'POST', p: '/api/app/token', d: '用登录态换长期 App Token（30 天，可撤销）', auth: 'Cookie' },
  { m: 'GET', p: '/api/app/tokens', d: '列出已生成的 App Token（只给前缀）', auth: 'Cookie' },
  { m: 'DELETE', p: '/api/app/token/:prefix', d: '撤销某个 Token', auth: 'Cookie' },
  { m: 'POST', p: '/api/app/snapshot/rebuild', d: '生成明文书签快照（需保险库解锁）', auth: 'Cookie' },
  { m: 'GET', p: '/api/app/snapshot', d: '读快照（书签 + 节点 + 分组），支持 ETag', auth: 'App Token' },
  { m: 'GET', p: '/api/app/bookmarks?group=&limit=', d: '只读书签（小组件最小请求），支持 ETag', auth: 'App Token' },
  { m: 'GET', p: '/api/app/nodes', d: '节点列表（含各节点地址，供 App 测速）', auth: 'App Token' },
  { m: 'GET', p: '/api/app/ping', d: '极轻量测速端点，返回 ok + 时间戳', auth: '无' },
]
</script>
<template>
  <div class="api-docs">
    <!-- 快照 -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:database-sync" /> 书签快照（小组件数据源）</h4>
      <p class="tip">
        小组件拿到的是<strong>明文快照</strong>（只有名称、图标、网址、分组，
        不含密码和备忘录）。生成快照需要保险库已解锁。
      </p>
      <div class="row-actions">
        <button class="btn-primary" :disabled="busy" @click="rebuildSnapshot">
          {{ busy ? '处理中…' : '生成 / 刷新快照' }}
        </button>
        <span v-if="snapInfo" class="ok-text">{{ snapInfo }}</span>
      </div>
    </div>

    <!-- Token -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:key-chain" /> App Token</h4>
      <p class="tip">App 里浏览器登录后可换一个长期 Token，原生小组件用它读快照（不需要每次登录）。</p>
      <div class="row-actions">
        <input v-model="tokenLabel" class="glass-input" maxlength="40" placeholder="设备名，如 小米 14" style="max-width: 220px" />
        <button class="btn-primary" :disabled="busy" @click="makeToken">生成 Token</button>
      </div>
      <div v-if="newToken" class="token-box">
        <code>{{ newToken }}</code>
        <button class="btn-outline" @click="copyToken">复制</button>
      </div>
      <div v-if="tokens.length" class="token-list">
        <div v-for="t in tokens" :key="t.token" class="token-row">
          <code>{{ t.token }}</code>
          <span class="token-meta">{{ t.label }} · 创建 {{ t.createdAt }}<template v-if="t.lastUsedAt"> · 最近 {{ t.lastUsedAt }}</template></span>
          <button class="btn-outline danger-mini" @click="revoke(t.token.replace('…', ''))">撤销</button>
        </div>
      </div>
      <p v-else class="tip">还没有 Token。</p>
    </div>

    <!-- 接口清单 -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:api" /> 接口清单</h4>
      <div class="api-table">
        <div v-for="e in ENDPOINTS" :key="e.p" class="api-row">
          <span class="api-m" :class="e.m.toLowerCase()">{{ e.m }}</span>
          <code class="api-p">{{ e.p }}</code>
          <span class="api-d">{{ e.d }}</span>
          <span class="api-auth">{{ e.auth }}</span>
        </div>
      </div>
    </div>

    <!-- 示例 -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:code-json" /> 请求示例</h4>
      <p class="tip">所有 <code>/api/app/*</code> 都支持 <code>Authorization: Bearer &lt;AppToken&gt;</code>，也兼容 Cookie。</p>
      <pre class="code-block"># 1. 换 Token（用 Cookie 登录态）
curl -X POST {{ origin }}/api/app/token \
  -H &quot;Cookie: auth_token=...&quot; \
  -H &quot;Content-Type: application/json&quot; \
  -d '{&quot;label&quot;:&quot;小米 14&quot;}'

# 2. 生成快照（需要保险库已解锁）
curl -X POST {{ origin }}/api/app/snapshot/rebuild -H &quot;Cookie: auth_token=...&quot;

# 3. 小组件读书签（带 ETag，没变化返回 304）
curl {{ origin }}/api/app/bookmarks?limit=20 \
  -H &quot;Authorization: Bearer op_xxxxx&quot;

# 4. 探测各节点延迟（App 自选最快节点）
curl {{ origin }}/api/app/nodes -H &quot;Authorization: Bearer op_xxxxx&quot;
# 然后对每个节点的 urls[0] 打 /api/app/ping 比 RTT</pre>
    </div>

    <!-- 协议说明 -->
    <div class="setting-block">
      <h4><AppIcon icon="mdi:information-outline" /> 离线缓存建议</h4>
      <ul class="api-list">
        <li>小组件把 <code>/api/app/snapshot</code> 的响应整包存本地（SQLite / UserDefaults / SharedPreferences）。</li>
        <li>每次刷新带上 <code>If-None-Match: &lt;上次的 ETag&gt;</code>，返回 <code>304</code> 就直接用缓存，省流量也省电。</li>
        <li>请求失败（断网 / 节点挂）时<strong>不要清空</strong>本地缓存，继续展示上一次的内容，并标注「离线」。</li>
        <li>用 <code>/api/app/nodes</code> 拿到全部节点，对每个 <code>urls[0] + /api/app/ping</code> 打 2~3 次取最小值，选最快那个作为下次请求的 baseURL。</li>
        <li>切换节点后 Cookie 不共享（App 内 WebView 除外），所以原生请求统一用 App Token，不依赖 Cookie。</li>
      </ul>
    </div>
  </div>
</template>
<style scoped>
.api-docs { padding: 2px; }
.tip { font-size: 12px; opacity: .55; line-height: 1.75; margin: 6px 0 10px; }
.tip code, .api-list code { font-family: ui-monospace, monospace; font-size: 11.5px;
  background: color-mix(in srgb, var(--theme-color) 8%, transparent); padding: 1px 5px; border-radius: 4px; }
.row-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0 6px; }
.ok-text { font-size: 12px; color: #10b981; }

.token-box { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 10px 12px; border-radius: 10px;
  background: color-mix(in srgb, #10b981 10%, transparent); border: 1px solid color-mix(in srgb, #10b981 30%, transparent); }
.token-box code { flex: 1; font-family: ui-monospace, monospace; font-size: 11.5px; word-break: break-all; }
.token-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.token-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); font-size: 12px; flex-wrap: wrap; }
.token-row code { font-family: ui-monospace, monospace; font-size: 11.5px; }
.token-meta { font-size: 10.5px; opacity: .45; }
.danger-mini { margin-left: auto; padding: 4px 10px; font-size: 11.5px; color: #f87171; border-color: rgba(248,113,113,.3); }

.api-table { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.api-row { display: grid; grid-template-columns: 62px minmax(150px, auto) 1fr auto; gap: 10px; align-items: center;
  padding: 8px 10px; border-radius: 9px; font-size: 12px;
  background: color-mix(in srgb, var(--theme-color) 3%, transparent); }
.api-m { font-size: 10px; font-weight: 700; text-align: center; padding: 2px 0; border-radius: 5px; letter-spacing: .3px; }
.api-m.get { background: rgba(59,130,246,.18); color: #60a5fa; }
.api-m.post { background: rgba(16,185,129,.18); color: #34d399; }
.api-m.delete { background: rgba(239,68,68,.18); color: #f87171; }
.api-p { font-family: ui-monospace, monospace; font-size: 11.5px; opacity: .85; }
.api-d { opacity: .55; font-size: 11.5px; }
.api-auth { font-size: 10px; opacity: .4; white-space: nowrap; }

.code-block { margin: 8px 0 0; padding: 12px 14px; border-radius: 10px; overflow-x: auto;
  font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.7;
  background: color-mix(in srgb, var(--theme-color) 5%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 10%, transparent);
  white-space: pre; }
.api-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.9; opacity: .75; }
.api-list li { margin-bottom: 4px; }
</style>