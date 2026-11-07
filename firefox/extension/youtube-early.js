// Runs before YouTube's player starts.
// YouTube remembers network stalls in its saved bandwidth record. Stalls
// logged while the computer was frozen made it play its lowest quality
// (144p) for weeks afterwards. If the record holds any stall, drop it:
// YouTube measures the connection again within a few seconds.
(() => {
  try {
    const raw = localStorage.getItem('yt-player-bandwidth');
    if (!raw) return;
    const record = JSON.parse(JSON.parse(raw).data || '{}');
    if (Array.isArray(record.interruptions) && record.interruptions.length) {
      localStorage.removeItem('yt-player-bandwidth');
    }
  } catch {
    // An unreadable record is treated the same way.
    try { localStorage.removeItem('yt-player-bandwidth'); } catch {}
  }
})();

// Route-aware first-paint guard. Native-only pages remain available, and a
// bounded fallback prevents an injection failure from leaving a blank page.
(() => {
  let fallback = 0;
  let failedRoute = '';
  let pendingRoute = '';
  function routeSurface(event) {
    let url;
    const requested = event?.detail?.url || event?.detail?.endpoint?.commandMetadata?.webCommandMetadata?.url;
    try { url = new URL(requested || location.href, location.origin); } catch { return; }
    if (url.origin !== location.origin) return;
    let mode = 'selective';
    try { mode = localStorage.getItem('still-youtube-feed-mode') || mode; } catch {}
    const custom = url.pathname === '/' || (mode !== 'normal' && (
      (url.pathname === '/results' && url.searchParams.has('search_query'))
      || /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|shorts|streams))?\/?$/i.test(url.pathname)));
    const root = document.documentElement;
    if (!root) return;
    clearTimeout(fallback);
    pendingRoute = url.href;
    if (failedRoute === url.href && !document.querySelector('#still-youtube-home,#still-youtube-search,#still-youtube-channel')) { root.dataset.stillYoutubeSurface = 'native'; return; }
    root.dataset.stillYoutubeSurface = custom ? 'custom' : url.pathname === '/watch' ? 'watch' : 'native';
    if (custom) fallback = setTimeout(() => {
      if (pendingRoute === url.href && !document.querySelector('#still-youtube-home,#still-youtube-search,#still-youtube-channel')) {
        failedRoute = url.href;
        root.dataset.stillYoutubeSurface = 'native';
        root.classList.remove('still-youtube-custom-home','still-youtube-custom-search','still-youtube-custom-channel');
      }
    }, 3000);
  }
  routeSurface();
  for (const name of ['yt-navigate-start', 'yt-page-data-updated', 'yt-navigate-finish']) document.addEventListener(name, routeSurface);
  window.addEventListener('popstate', routeSurface);
  window.addEventListener('still-youtube-mode-change', routeSurface);
})();
