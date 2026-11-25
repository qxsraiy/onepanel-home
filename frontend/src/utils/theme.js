/**
 * 主题应用：统一由这里写 body 样式，方便预览后回滚
 * （原来 App.vue 与 SettingsPanel.vue 各写一份，取消保存时无法回滚）
 */
import { safeHex } from './common';

const DEFAULT_BG = '#0f172a';
const DEFAULT_COLOR = '#f8fafc';
const DEFAULT_ACCENT = '#3b82f6';

// 只有真正的图片来源才配得上 <link rel="icon">：图标名（mdi:home-circle）会被浏览器当成
// 未知协议去请求，控制台里就是一条 ERR_UNKNOWN_URL_SCHEME
const isImageLikeUrl = (v) => /^(https?:\/\/|data:image\/|\/)/i.test(String(v || "").trim());

function setFavicon(href) {
  if (!isImageLikeUrl(href)) return;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

export function applyThemeToBody(settings = {}) {
  // 【F-13】切换主题时短暂开启过渡，避免颜色硬跳；切换完立刻移除，
  // 否则会影响页面其他动画（比如卡片 hover）
  try {
    const root = document.documentElement
    root.classList.add('op-theme-transition')
    clearTimeout(applyThemeToBody._t)
    applyThemeToBody._t = setTimeout(() => root.classList.remove('op-theme-transition'), 320)
  } catch { /* 忽略 */ }
  const bg = safeHex(settings.themeBg, DEFAULT_BG);
  const color = safeHex(settings.themeColor, DEFAULT_COLOR);

  document.body.style.setProperty('--theme-bg', bg);
  document.body.style.setProperty('--theme-color', color);

  if (settings.bgImage) {
    document.body.style.backgroundImage = `url(${settings.bgImage})`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
  } else {
    // 置空而不是 none，交给 CSS 里的渐变兜底
    document.body.style.backgroundImage = '';
  }

  if (settings.siteIcon) setFavicon(settings.siteIcon);
  if (settings.siteTitle) document.title = settings.siteTitle;
}

export { DEFAULT_BG, DEFAULT_COLOR, DEFAULT_ACCENT };
