/* Shared slot policy. No browser privileges or page access. */
(function (root) {
  'use strict';
  const SLOT_COUNT = 5;
  function safeAddress(input) {
    const text = String(input || '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) {
      try { return new URL(text).href; } catch { return ''; }
    }
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(text)) return `http://${text}`;
    if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(text)) return `https://${text}`;
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }
  function slotIndex(value) {
    if (value === '' || value === null || value === undefined) return -1;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n < SLOT_COUNT ? n : -1;
  }
  function allocate(tabs, getIndex) {
    const slots = Array(SLOT_COUNT).fill(null);
    const pending = [];
    for (const tab of tabs) {
      const i = slotIndex(getIndex(tab));
      if (i >= 0 && !slots[i]) slots[i] = tab;
      else pending.push(tab);
    }
    const overflow = [];
    for (const tab of pending) {
      const i = slots.indexOf(null);
      if (i < 0) overflow.push(tab);
      else slots[i] = tab;
    }
    return { slots, overflow };
  }
  function boundedStep(index, direction) {
    return Math.max(0, Math.min(SLOT_COUNT - 1, index + Math.sign(direction)));
  }
  function safeFavicon(uri) {
    return /^(https?:|data:image\/(?:png|jpeg|gif|webp|x-icon|vnd.microsoft.icon|svg\+xml)[;,])/i.test(String(uri || '')) ? uri : '';
  }
  const api = { SLOT_COUNT, safeAddress, slotIndex, allocate, boundedStep, safeFavicon };
  if (typeof module !== 'undefined') module.exports = api;
  else root.StillModel = api;
})(globalThis);
