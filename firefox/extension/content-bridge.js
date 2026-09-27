// This isolated-world bridge never handles Google sign-in or reads credentials.
// The page-world YouTube scripts only use it to open the channel manager.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type === 'still-open-learn') {
    browser.runtime.sendMessage({ type: 'open-manager' }).catch(() => {});
  }
});
