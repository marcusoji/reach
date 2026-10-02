const CACHE='reach-citizen-v4';
const ASSETS=['./','./index.html','./css/styles.css','./css/components.css','./css/responsive.css','./js/app.js','./js/navigation.js','./js/state.js','./js/utils.js','./js/backend.js','./js/config.js','./js/relay/protocol.js','./js/relay/capabilities.js','./assets/icons/reach-logo.svg','./assets/icons/icon-192.png','./assets/icons/icon-512.png','./manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('reach-citizen-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const requestUrl=new URL(e.request.url);
  if(requestUrl.origin!==self.location.origin) return; // Never cache authenticated cross-origin API responses.
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();void caches.open(CACHE).then(cache=>cache.put(e.request,copy));}return r}).catch(()=>caches.match('./index.html'))));
});
