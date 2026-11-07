// This isolated-world bridge never handles Google sign-in or reads credentials.
// The page-world YouTube scripts only use it to open the channel manager.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type === 'still-open-learn') {
    browser.runtime.sendMessage({ type: 'open-manager' }).catch(() => {});
  }
});

// Hydrate the already-rendered page from local cached feeds; do not wait for
// YouTube's images, ads and other subresources to finish loading.
const notifyYouTubeReady = () => browser.runtime.sendMessage({ type: 'youtube-ready' }).catch(() => {});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notifyYouTubeReady, { once: true });
else notifyYouTubeReady();
