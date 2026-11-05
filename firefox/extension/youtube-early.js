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
