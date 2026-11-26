<script setup>
/**
 * 浏览器扩展（v3.12.0）
 * ------------------------------------------------------------------
 * 说明为什么不能"点击自动安装"：Chrome 安全模型禁止网页安装扩展。
 * 给三条可行路径：Chrome 商店 / Edge 商店 / 开发者模式拖入。
 */
import { ref } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import { toast } from '../utils/common'

const busy = ref(false)

async function downloadZip() {
  busy.value = true
  try {
    const res = await axios.get('/api/extension/bundle', { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url; a.download = 'onepanel-extension.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    toast('已下载，解开后按下面的步骤加载', 'success', 5000)
  } catch (e) {
    toast(e.response?.data?.error || '打包失败', 'error')
  } finally { busy.value = false }
}

function openExtensionsPage() {
  window.open('chrome://extensions', '_blank')
}
</script>

<template>
  <div class="ext-pane">
    <div class="setting-block">
      <h4><AppIcon icon="mdi:puzzle-outline" /> 浏览器扩展</h4>
      <p class="tip">
        右键任意页面保存到 OnePanel，或选中文字直接存成备忘录。
        扩展会自动读取你在面板里设置的主题色，外观保持一致。
      </p>
      <div class="row-actions">
        <button class="btn-primary" :disabled="busy" @click="downloadZip">
          {{ busy ? '打包中…' : '下载扩展包（zip）' }}
        </button>
      </div>
    </div>

    <div class="setting-block warn-block">
      <h4><AppIcon icon="mdi:shield-lock-outline" /> 关于"点击自动安装"
      </h4>
      <p class="tip">
        <b>浏览器不允许网页自动安装扩展</b>（这是 Chrome / Edge 的安全模型，任何网站都做不到）。
        想做到"点一下就装"，只有两条路：
      </p>
      <div class="path-list">
        <div class="path-row">
          <span class="path-tag ok">推荐</span>
          <div>
            <b>上架 Edge 加载项商店</b>（免费）或 Chrome Web Store（$5）
            <div class="path-desc">上架后用户点"获取"→"添加扩展程序"就是一键安装。审核通常 1~3 天。</div>
          </div>
        </div>
        <div class="path-row">
          <span class="path-tag">现在可用</span>
          <div>
            <b>开发者模式拖入</b>（3 步，30 秒）
            <div class="path-desc">下载 zip → 解压 → 打开 chrome://extensions → 开右上角"开发者模式" → 点"加载已解压的扩展程序" → 选解压出的文件夹。</div>
          </div>
        </div>
      </div>
    </div>

    <div class="setting-block">
      <h4><AppIcon icon="mdi:format-list-numbered" /> 安装步骤</h4>
      <ol class="steps">
        <li>点上面的<b>「下载扩展包」</b>，得到一个 zip</li>
        <li>把 zip <b>解压</b>到一个固定目录（别删，删了扩展会失效）</li>
        <li>浏览器地址栏打开 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>）</li>
        <li>打开右上角 <b>开发者模式</b></li>
        <li>点 <b>加载已解压的扩展程序</b>，选中解压出的文件夹</li>
        <li>点扩展图标 → <b>设置节点与账号</b> → 填节点地址 + 在「设置 → API 接口」生成的 Token</li>
      </ol>
      <button class="btn-outline mt-2" @click="openExtensionsPage">打开扩展管理页</button>
    </div>

    <div class="setting-block">
      <h4><AppIcon icon="mdi:lightbulb-on-outline" /> 能做什么</h4>
      <ul class="about-list">
        <li><b>右键保存</b>：任意页面 → 右键 → 保存到 OnePanel</li>
        <li><b>选中文字存备忘录</b>：选中一段字 → 右键 → 保存到 OnePanel</li>
        <li><b>弹窗保存</b>：点扩展图标，可改名称/分组再保存</li>
        <li><b>自动跟随主题</b>：扩展会读你面板的主题色，和网页端视觉一致</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ext-pane { padding: 2px; }
.tip { font-size: 12.5px; opacity: .58; line-height: 1.85; margin: 6px 0 10px; }
.row-actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 4px; }
.warn-block { border-color: color-mix(in srgb, #f59e0b 35%, transparent) !important;
  background: color-mix(in srgb, #f59e0b 5%, transparent); }
.path-list { display: flex; flex-direction: column; gap: 9px; margin-top: 10px; }
.path-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--theme-color) 4%, transparent); font-size: 12.5px; line-height: 1.7; }
.path-tag { flex-shrink: 0; font-size: 10px; padding: 2px 7px; border-radius: 999px; margin-top: 2px;
  background: color-mix(in srgb, var(--theme-color) 12%, transparent); opacity: .8; }
.path-tag.ok { background: color-mix(in srgb, #10b981 22%, transparent); color: #10b981; opacity: 1; }
.path-desc { font-size: 11.5px; opacity: .5; margin-top: 3px; }
.steps { margin: 8px 0 0; padding-left: 20px; font-size: 12.5px; line-height: 2.1; opacity: .8; }
.steps code, .about-list code { font-family: ui-monospace, monospace; font-size: 11.5px;
  background: color-mix(in srgb, var(--theme-color) 8%, transparent); padding: 1px 5px; border-radius: 4px; }
.about-list { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.95; opacity: .78; }
</style>