// OnePanel Service Worker
// 策略总览：
//  - API 请求：永不缓存（登录态/数据实时性比离线可用更重要）
//  - 页面导航：网络优先，离线时才回退缓存的 index.html（避免发版后一直跑旧壳）
//  - 静态资源（JS/CSS/图片/字体）：缓存优先 + 后台更新
//  - 跨域请求：不拦截

const CACHE_VERSION = 'v3.2.1';
const STATIC_CACHE = `onepanel-static-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== STATIC_CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// 支持 index.html 主动发消息让新 SW 立即接管
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不碰跨域

  // ① API：纯网络，永不进缓存（旧版本缓存 API 是登录错乱/数据陈旧的根源）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // ② 页面导航：网络优先 → 失败回退缓存壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put('/index.html', clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // ③ 静态资源：缓存优先，命中后静默后台更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const clone = networkResponse.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
