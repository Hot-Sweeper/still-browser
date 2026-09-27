const SLOT_COUNT = 5;
const elements = {
  chrome: document.querySelector('#chrome'),
  webviews: document.querySelector('#webviews'),
  loadingCover: document.querySelector('#page-loading-cover'),
  transitionStage: document.querySelector('#page-transition-stage'),
  edgeLeft: document.querySelector('.page-edge-fade.left'),
  edgeRight: document.querySelector('.page-edge-fade.right'),
  newSlotEdge: document.querySelector('#new-slot-edge'),
  tabDock: document.querySelector('#tab-dock'),
  tabDockIcons: document.querySelector('#tab-dock-icons'),
  slotRow: document.querySelector('#slot-row'),
  utilityButton: document.querySelector('#utility-button'),
  utilityPanel: document.querySelector('#utility-panel'),
  permissionPrompt: document.querySelector('#permission-prompt'),
  permissionPromptIcons: document.querySelector('#permission-prompt-icons'),
  permissionPromptTitle: document.querySelector('#permission-prompt-title'),
  permissionBlock: document.querySelector('#permission-block'),
  permissionAllow: document.querySelector('#permission-allow'),
  replacementBackdrop: document.querySelector('#slot-replacement-backdrop'),
  replacementModal: document.querySelector('#slot-replacement-modal'),
  replacementUrl: document.querySelector('#slot-replacement-url'),
  replacementList: document.querySelector('#slot-replacement-list'),
  replacementCancel: document.querySelector('#slot-replacement-cancel'),
  toast: document.querySelector('#toast'),
  toastMessage: document.querySelector('#toast-message'),
  toastAction: document.querySelector('#toast-action'),
  toastClose: document.querySelector('#toast-close')
};

let startPageUrl = '';
let editorPageUrl = '';
let learnPageUrl = '';
let searchBaseUrl = '';
let bookmarks = [];
let importedBookmarks = [];
let customBookmarks = [];
let browsingHistory = [];
let importedHistory = [];
let recentHistory = [];
let downloads = [];
let activeIndex = 0;
let updateNoticeShown = false;
let updateAvailable = false;
let updateNoticePath = '';
let editingIndex = -1;
let draggedIndex = -1;
let hideTimer;
let toastTimer;
let theme = 'system';
let utilityMode = 'bookmarks';
let utilityAnimationToken = 0;
let lastUtilityWheelAt = 0;
let slotTransitionToken = 0;
let slotTransitionAnimations = [];
let pendingVerticalNavigation = null;
let historyNavigationPending = false;
let lastSlotInteractionAt = 0;
let snapshotResizeTimer;
let newSlotEdgeTimer;
let newSlotEdgeArmedAt = 0;
let leftSlotWallTimer;
let rightSlotWallTimer;
let pendingExternalUrl = '';
let tabDockSlideEnabled = true;
let tabDockVisible = false;
let tabDockSelectedIndex = 0;
let tabDockHoverIndex = -1;
let tabDockHideTimer;
let tabDockBuildSignature = '';
let tabDockOpenedAt = 0;
let tabDockCommitDirection = 0;
let activePermissionRequest = null;
let permissionPromptClosing = false;
const permissionRequestQueue = [];
const permissionActivityByGuest = new Map();
const faviconUpscaleJobs = new Map();
const SLOT_TRANSITION_DURATION = 220;
const NEW_SLOT_CONFIRM_WINDOW = 1050;
const utilityModes = ['bookmarks', 'history', 'downloads', 'permissions', 'browser', 'theme', 'tabdock'];
const utilityMetadata = {
  bookmarks: {
    label: 'Bookmarks',
    icon: '<svg viewBox="0 0 24 24"><path d="m12 3.7 2.5 5.1 5.6.8-4.05 3.95.96 5.58L12 16.5l-5.01 2.63.96-5.58L3.9 9.6l5.6-.8L12 3.7Z"/></svg>'
  },
  history: {
    label: 'History',
    icon: '<svg viewBox="0 0 24 24"><path d="M4.5 5.8v4.4h4.4M5 10a7.5 7.5 0 1 1 .8 5.2M12 7.6V12l3.1 1.8"/></svg>'
  },
  downloads: {
    label: 'Downloads',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3.5v11m-4-4 4 4 4-4M5 19.5h14"/></svg>'
  },
  permissions: {
    label: 'Site Permissions',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3.2 19 6v5.1c0 4.4-2.8 7.6-7 9.7-4.2-2.1-7-5.3-7-9.7V6l7-2.8Z"/><path d="M9.2 12.1 11 14l3.9-4.2"/></svg>'
  },
  browser: {
    label: 'Browser Setup',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.8 12h16.4M12 3.5c-2.2 2.3-3.4 5.2-3.4 8.5s1.2 6.2 3.4 8.5c2.2-2.3 3.4-5.2 3.4-8.5S14.2 5.8 12 3.5Z"/></svg>'
  },
  theme: {
    label: 'Appearance',
    icon: '<svg class="theme-mode-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path class="theme-fill" d="M12 3.5a8.5 8.5 0 0 0 0 17Z"/></svg>'
  },
  tabdock: {
    label: 'Dock Slide',
    icon: '<svg class="tab-dock-mode-icon" viewBox="0 0 24 24"><rect x="3" y="7.5" width="18" height="9" rx="4.5"/><path d="M8.5 12h7m-2.3-2.2 2.3 2.2-2.3 2.2"/></svg>'
  }
};
const slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  id: crypto.randomUUID(),
  index,
  occupied: index === 0,
  title: index === 0 ? 'Still' : '',
  url: '',
  favicon: '',
  dockFavicon: '',
  ready: false,
  loading: false,
  loadingCoverTimer: null,
  pendingUrl: '',
  snapshot: '',
  snapshotImage: null,
  snapshotGeneration: 0,
  snapshotRefreshTimer: null,
  mediaPlaying: false,
  zoomFactor: 1,
  startupMediaBlocked: true,
  crashRecoveryTimes: [],
  webview: null
}));

function syncPageLoadingCover() {
  elements.loadingCover.hidden = !slots[activeIndex]?.loading;
}

function beginPageLoading(slot) {
  clearTimeout(slot.loadingCoverTimer);
  slot.loadingCoverTimer = null;
  if (slot.loading) return;
  slot.loading = true;
  if (slot.index === activeIndex) syncPageLoadingCover();
}

function finishPageLoading(slot, delay = 120) {
  clearTimeout(slot.loadingCoverTimer);
  slot.loadingCoverTimer = setTimeout(() => {
    slot.loadingCoverTimer = null;
    if (!slot.loading) return;
    slot.loading = false;
    if (slot.index === activeIndex) {
      completeVerticalNavigation(slot);
      syncPageLoadingCover();
    }
  }, delay);
}

function loadRecentHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem('focus-slots-history'));
    recentHistory = Array.isArray(saved) ? saved : [];
  } catch {
    recentHistory = [];
  }
}

function loadCustomBookmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem('still-custom-bookmarks'));
    customBookmarks = Array.isArray(saved) ? saved.filter((item) => /^https?:\/\//i.test(item?.url)) : [];
  } catch {
    customBookmarks = [];
  }
}

function rebuildBrowsingHistory() {
  bookmarks = [...customBookmarks, ...importedBookmarks];
  const seenHistoryUrls = new Set();
  browsingHistory = [
    ...recentHistory,
    ...importedHistory,
    ...bookmarks.map((bookmark) => ({ ...bookmark, title: bookmark.name, visitCount: 1, typedCount: 1 }))
  ].filter((entry) => {
    if (!entry.url || seenHistoryUrls.has(entry.url)) return false;
    seenHistoryUrls.add(entry.url);
    return true;
  });
  window.focusSlots.setSuggestionHistory(browsingHistory);
}

function rememberVisit(slot) {
  if (!slot.url || slot.url.startsWith('file:') || !/^https?:/i.test(slot.url)) return;
  const entry = { url: slot.url, title: slot.title || slot.url, visitCount: 1, typedCount: 0, lastVisit: Date.now() };
  recentHistory = [entry, ...recentHistory.filter((item) => item.url !== entry.url)].slice(0, 500);
  localStorage.setItem('focus-slots-history', JSON.stringify(recentHistory));
}

function saveState() {
  const state = slots.map(({ id, occupied, title, url, favicon, zoomFactor }) => ({
    id,
    occupied,
    title,
    url,
    favicon,
    zoomFactor
  }));
  localStorage.setItem('focus-slots-state', JSON.stringify({ activeIndex, slots: state }));
}

function compactSlotOrder(preferredActive = slots[activeIndex]) {
  const editingSlot = editingIndex >= 0 ? slots[editingIndex] : null;
  const occupied = slots.filter((slot) => slot.occupied);
  const empty = slots.filter((slot) => !slot.occupied);
  slots.splice(0, slots.length, ...occupied, ...empty);
  slots.forEach((slot, index) => {
    slot.index = index;
    slot.webview?.setAttribute('aria-label', `Browsing slot ${index + 1}`);
  });
  activeIndex = Math.max(0, slots.indexOf(preferredActive));
  editingIndex = editingSlot ? slots.indexOf(editingSlot) : -1;
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem('focus-slots-state'));
    if (!saved || !Array.isArray(saved.slots)) return;
    saved.slots.slice(0, SLOT_COUNT).forEach((item, index) => {
      const internalStartPage = !item.url || item.url.startsWith('file:');
      slots[index].id = item.id || slots[index].id;
      slots[index].occupied = Boolean(item.occupied);
      slots[index].title = internalStartPage && item.occupied ? 'Still' : (item.title || '');
      slots[index].url = internalStartPage ? '' : item.url;
      slots[index].favicon = internalStartPage ? '' : (item.favicon || '');
      slots[index].zoomFactor = Number.isFinite(item.zoomFactor)
        ? Math.min(5, Math.max(0.25, item.zoomFactor))
        : 1;
    });
    activeIndex = Number.isInteger(saved.activeIndex) ? Math.max(0, Math.min(4, saved.activeIndex)) : 0;
    if (!slots.some((slot) => slot.occupied)) slots[0].occupied = true;
    if (!slots[activeIndex].occupied) activeIndex = slots.findIndex((slot) => slot.occupied);
    compactSlotOrder(slots[activeIndex]);
  } catch {
    localStorage.removeItem('focus-slots-state');
  }
}

function showChrome(cursorRatio = 0.5) {
  clearTimeout(hideTimer);
  const normalizedRatio = Number.isFinite(cursorRatio) ? Math.max(0, Math.min(1, cursorRatio)) : 0.5;
  const cursorX = window.innerWidth * normalizedRatio;
  elements.chrome.querySelectorAll('.slot, .top-control').forEach((element) => {
    const bounds = element.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2;
    const horizontalDistance = Math.abs(centerX - cursorX);
    const entranceDelay = Math.min(190, Math.round(horizontalDistance / 4.4));
    const entranceOffset = Math.max(-18, Math.min(18, (cursorX - centerX) / 24));
    element.style.setProperty('--enter-delay', `${entranceDelay}ms`);
    element.style.setProperty('--entry-x', `${entranceOffset}px`);
  });
  elements.chrome.classList.add('open');
}

function scheduleChromeHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (editingIndex !== -1 || elements.chrome.matches(':hover')) return;
    if (elements.chrome.contains(document.activeElement) && !document.activeElement.matches('input')) {
      document.activeElement.blur();
    }
    hideUtilityPanel();
    if (!elements.chrome.matches(':focus-within')) {
      elements.chrome.classList.remove('open');
    }
  }, 300);
}

function requestChromeHide() {
  if (editingIndex >= 0 || draggedIndex >= 0 || elements.chrome.matches(':hover')) return;
  hideUtilityPanel();
  if (elements.chrome.contains(document.activeElement) && !document.activeElement.matches('input')) {
    document.activeElement.blur();
  }
  scheduleChromeHide();
}

function hideToast() {
  clearTimeout(toastTimer);
  elements.toast.classList.remove('show', 'has-action');
  elements.toastAction.hidden = true;
  elements.toastAction.onclick = null;
  elements.toastClose.hidden = true;
}

function showToast(message, duration = 3200, action = null) {
  clearTimeout(toastTimer);
  elements.toastMessage.textContent = message;
  elements.toastAction.hidden = !action;
  elements.toastClose.hidden = !action?.dismissible;
  elements.toast.classList.toggle('has-action', Boolean(action));
  elements.toastAction.onclick = null;
  if (action) {
    elements.toastAction.textContent = action.label;
    elements.toastAction.onclick = () => {
      clearTimeout(toastTimer);
      hideToast();
      Promise.resolve(action.run()).catch(() => showToast('Could not open that page.'));
    };
  }
  elements.toast.classList.add('show');
  toastTimer = setTimeout(hideToast, duration);
}

async function restartForUpdate() {
  if (await window.focusSlots.installUpdate()) return;
  updateAvailable = false;
  updateNoticeShown = false;
  updateNoticePath = '';
  showToast('The staged update is no longer available.', 6000);
}

function showUpdateReady(stagedPath = '') {
  if (updateNoticeShown && (!stagedPath || stagedPath === updateNoticePath)) return;
  updateAvailable = true;
  updateNoticeShown = true;
  updateNoticePath = stagedPath;
  showToast('Still is ready to update. Restart whenever you’re done watching.', 30000, {
    label: 'Restart & update',
    run: restartForUpdate,
    dismissible: true
  });
}

const permissionDefinitions = {
  microphone: {
    label: 'Microphone',
    icon: '<svg viewBox="0 0 24 24"><rect x="8.4" y="3" width="7.2" height="12" rx="3.6"/><path d="M5.7 11.5a6.3 6.3 0 0 0 12.6 0M12 17.8V21M8.6 21h6.8"/></svg>'
  },
  camera: {
    label: 'Camera',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13.5" height="12" rx="3"/><path d="m16.5 10 4.5-2.4v8.8L16.5 14Z"/></svg>'
  },
  location: {
    label: 'Location',
    icon: '<svg viewBox="0 0 24 24"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/></svg>'
  },
  notifications: {
    label: 'Notifications',
    icon: '<svg viewBox="0 0 24 24"><path d="M6.3 16.5h11.4l-1.4-2V9a4.3 4.3 0 0 0-8.6 0v5.5l-1.4 2ZM10 19.2a2.2 2.2 0 0 0 4 0"/></svg>'
  }
};

function permissionGlyph(kind, className = '') {
  const glyph = document.createElement('span');
  glyph.className = `permission-glyph${className ? ` ${className}` : ''}`;
  glyph.innerHTML = permissionDefinitions[kind]?.icon || '';
  return glyph;
}

function readablePermissionList(kinds) {
  const labels = kinds.map((kind) => permissionDefinitions[kind]?.label.toLocaleLowerCase()).filter(Boolean);
  if (labels.length < 2) return labels[0] || 'site permissions';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function showNextPermissionRequest() {
  if (permissionPromptClosing || activePermissionRequest || !permissionRequestQueue.length) return;
  activePermissionRequest = permissionRequestQueue.shift();
  const kinds = activePermissionRequest.kinds.filter((kind) => permissionDefinitions[kind]);
  elements.permissionPromptIcons.replaceChildren(...kinds.map((kind) => permissionGlyph(kind)));
  elements.permissionPromptTitle.textContent = `${activePermissionRequest.hostname} wants to use your ${readablePermissionList(kinds)}`;
  elements.permissionPrompt.hidden = false;
  requestAnimationFrame(() => elements.permissionPrompt.classList.add('visible'));
  elements.permissionAllow.focus({ preventScroll: true });
}

function closePermissionPrompt() {
  permissionPromptClosing = true;
  elements.permissionPrompt.classList.remove('visible');
  setTimeout(() => {
    if (activePermissionRequest) return;
    permissionPromptClosing = false;
    elements.permissionPrompt.hidden = true;
    elements.permissionPromptIcons.replaceChildren();
    showNextPermissionRequest();
  }, 150);
}

function answerPermissionRequest(decision) {
  if (!activePermissionRequest) return;
  const request = activePermissionRequest;
  activePermissionRequest = null;
  window.focusSlots.respondPermission(request.id, decision);
  closePermissionPrompt();
  if (decision === 'dismiss') return;
  const action = decision === 'allow' ? 'allowed for' : 'blocked on';
  showToast(`${readablePermissionList(request.kinds)} ${action} ${request.hostname}.`);
}

function enqueuePermissionRequest(request) {
  if (!request?.id || !request?.hostname || !Array.isArray(request.kinds)) return;
  if (activePermissionRequest?.id === request.id || permissionRequestQueue.some((item) => item.id === request.id)) return;
  permissionRequestQueue.push(request);
  showNextPermissionRequest();
}

function permissionActivityForSlot(slot = slots[activeIndex]) {
  if (!slot?.webview) return null;
  try { return permissionActivityByGuest.get(slot.webview.getWebContentsId()) || null; } catch { return null; }
}

function slotPermissionActivity(slot) {
  const activity = permissionActivityForSlot(slot);
  const activeKinds = [
    activity?.microphone && 'microphone',
    activity?.camera && 'camera',
    activity?.location && 'location'
  ].filter(Boolean);
  if (!activeKinds.length) return null;
  const indicator = document.createElement('span');
  indicator.className = 'slot-privacy-activity';
  indicator.setAttribute('aria-label', `${activeKinds.map((kind) => permissionDefinitions[kind].label).join(' and ')} in use`);
  indicator.title = indicator.getAttribute('aria-label');
  indicator.append(...activeKinds.map((kind) => permissionGlyph(kind, `slot-permission-glyph ${kind}`)));
  return indicator;
}

async function renderSitePermissionEntries() {
  const slot = slots[activeIndex];
  const requestedUrl = slot?.url;
  const info = await window.focusSlots.getSitePermissions(requestedUrl);
  if (elements.utilityPanel.hidden || elements.utilityPanel.dataset.mode !== 'permissions') return;
  elements.utilityPanel.querySelector('.permission-panel-loading')?.remove();
  if (!info?.origin) {
    const empty = document.createElement('div');
    empty.className = 'utility-panel-empty';
    empty.textContent = 'Open a website to view its permissions.';
    elements.utilityPanel.appendChild(empty);
    return;
  }

  const site = document.createElement('div');
  site.className = 'permission-site-origin';
  site.textContent = info.hostname;
  site.title = info.origin;
  elements.utilityPanel.appendChild(site);
  const activity = permissionActivityForSlot(slot);

  Object.keys(permissionDefinitions).forEach((kind) => {
    const state = info.states?.[kind] || 'ask';
    const isActive = Boolean(activity?.[kind]);
    const row = document.createElement('div');
    row.className = `permission-setting ${state}${isActive ? ' active' : ''}`;
    row.appendChild(permissionGlyph(kind));

    const copy = document.createElement('span');
    copy.className = 'permission-setting-copy';
    const title = document.createElement('strong');
    title.textContent = permissionDefinitions[kind].label;
    const status = document.createElement('small');
    status.textContent = isActive ? 'In use now' : ({ allow: 'Allowed', block: 'Blocked', ask: 'Ask next time' }[state]);
    copy.append(title, status);
    row.appendChild(copy);

    if (state !== 'ask') {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = 'Reset';
      reset.addEventListener('click', async () => {
        await window.focusSlots.resetSitePermission(info.origin, kind);
        renderUtilityPanel('permissions', true);
        showToast(`${permissionDefinitions[kind].label} will ask again.`);
      });
      row.appendChild(reset);
    }
    elements.utilityPanel.appendChild(row);
  });

  if (Object.values(info.states || {}).some((state) => state !== 'ask')) {
    const resetAll = utilityListItem('Reset all site permissions', '', { action: true });
    resetAll.addEventListener('click', async () => {
      await window.focusSlots.resetSitePermission(info.origin, 'all');
      renderUtilityPanel('permissions', true);
      showToast(`Permissions reset for ${info.hostname}.`);
    });
    elements.utilityPanel.appendChild(resetAll);
  }
}

function isBookmarkable(url) {
  return /^https?:\/\//i.test(url || '');
}

function currentBookmark() {
  const url = slots[activeIndex]?.url;
  return isBookmarkable(url) ? bookmarks.find((item) => item.url === url) : null;
}

function makeUtilityGlyph(mode, className = 'current') {
  const glyph = document.createElement('span');
  glyph.className = `utility-glyph ${className}`;
  glyph.innerHTML = utilityMetadata[mode].icon;
  return glyph;
}

function renderUtilityButton({ animate = false, direction = 1 } = {}) {
  const metadata = utilityMetadata[utilityMode];
  const stage = elements.utilityButton.querySelector('.utility-icon-stage');
  elements.utilityButton.title = `${metadata.label} · scroll to change button`;
  elements.utilityButton.setAttribute('aria-label', `${metadata.label}; scroll to change button`);
  elements.utilityButton.classList.toggle('bookmarked', utilityMode === 'bookmarks' && Boolean(currentBookmark()));
  if (utilityMode === 'tabdock') {
    elements.utilityButton.title = `${metadata.label} · ${tabDockSlideEnabled ? 'On' : 'Off'} · scroll to change button`;
  }
  elements.utilityButton.classList.toggle('dock-slide-enabled', utilityMode === 'tabdock' && tabDockSlideEnabled);

  const incoming = makeUtilityGlyph(utilityMode, animate ? 'incoming' : 'current');
  if (!animate || !stage.firstElementChild) {
    stage.replaceChildren(incoming);
    return;
  }

  const token = ++utilityAnimationToken;
  const outgoing = stage.lastElementChild;
  stage.appendChild(incoming);
  outgoing.classList.remove('current');
  outgoing.classList.add('outgoing');
  const travel = direction > 0 ? -24 : 24;
  outgoing.animate([
    { transform: 'translateY(0) scale(1)', filter: 'blur(0)', opacity: 1 },
    { transform: `translateY(${travel}px) scale(.82)`, filter: 'blur(5px)', opacity: 0 }
  ], { duration: 205, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  incoming.animate([
    { transform: `translateY(${-travel}px) scale(.82)`, filter: 'blur(6px)', opacity: 0 },
    { transform: 'translateY(0) scale(1)', filter: 'blur(0)', opacity: 1 }
  ], { duration: 285, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' });
  setTimeout(() => {
    if (token !== utilityAnimationToken) return;
    incoming.className = 'utility-glyph current';
    incoming.getAnimations().forEach((animation) => animation.cancel());
    stage.replaceChildren(incoming);
  }, 290);
}

function hideUtilityPanel() {
  elements.utilityPanel.hidden = true;
  elements.utilityPanel.replaceChildren();
  elements.utilityButton.classList.remove('panel-open');
}

function utilityListItem(title, url, { action = false, active = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `utility-list-item${action ? ' action' : ''}${active ? ' active' : ''}`;
  const primary = document.createElement('span');
  primary.textContent = title;
  button.appendChild(primary);
  if (url) {
    const secondary = document.createElement('small');
    secondary.textContent = displayUrl(url);
    button.appendChild(secondary);
  }
  return button;
}

function toggleCurrentBookmark() {
  const slot = slots[activeIndex];
  if (!isBookmarkable(slot?.url)) {
    showToast('Open a website before adding a bookmark.');
    return;
  }
  const customIndex = customBookmarks.findIndex((item) => item.url === slot.url);
  if (customIndex >= 0) {
    customBookmarks.splice(customIndex, 1);
    showToast('Bookmark removed.');
  } else if (importedBookmarks.some((item) => item.url === slot.url)) {
    showToast('This page is already in your Opera bookmarks.');
    return;
  } else {
    customBookmarks.unshift({ url: slot.url, name: slot.title || displayUrl(slot.url) });
    showToast('Page bookmarked.');
  }
  localStorage.setItem('still-custom-bookmarks', JSON.stringify(customBookmarks));
  rebuildBrowsingHistory();
  renderUtilityButton();
  renderUtilityPanel('bookmarks', true);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

async function runDownloadAction(id, action) {
  const error = await window.focusSlots.downloadAction(id, action);
  if (error) showToast(`Download: ${error}`);
}

function renderDownloadEntries() {
  const folder = utilityListItem('Open downloads folder', '', { action: true });
  folder.addEventListener('click', () => runDownloadAction('', 'folder'));
  elements.utilityPanel.appendChild(folder);

  downloads.slice(0, 20).forEach((download) => {
    const row = document.createElement('div');
    row.className = 'download-item';

    const title = document.createElement('div');
    title.className = 'download-title';
    title.textContent = download.name || 'Download';
    title.title = download.name || '';
    row.appendChild(title);

    const knownTotal = Number(download.totalBytes) > 0;
    const percent = knownTotal
      ? Math.max(0, Math.min(100, Number(download.receivedBytes || 0) / Number(download.totalBytes) * 100))
      : 0;
    const meta = document.createElement('div');
    meta.className = 'download-meta';
    const stateLabels = {
      progressing: knownTotal ? `${Math.round(percent)}%` : 'Downloading',
      recovering: 'Reconnecting…',
      paused: 'Paused',
      completed: 'Complete',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted'
    };
    const receivedBytes = Number(download.receivedBytes || 0);
    const size = knownTotal
      ? `${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)}`
      : receivedBytes > 0 ? formatBytes(receivedBytes) : '';
    meta.textContent = [stateLabels[download.state] || download.state, size, download.error]
      .filter(Boolean).join(' · ');
    row.appendChild(meta);

    if (['progressing', 'paused', 'recovering'].includes(download.state)) {
      const track = document.createElement('div');
      track.className = `download-progress${knownTotal ? '' : ' indeterminate'}`;
      const fill = document.createElement('div');
      fill.style.width = knownTotal ? `${percent}%` : '36%';
      track.appendChild(fill);
      row.appendChild(track);
    }

    const actions = document.createElement('div');
    actions.className = 'download-actions';
    const addAction = (label, action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => runDownloadAction(download.id, action));
      actions.appendChild(button);
    };
    if ((download.state === 'progressing' || download.state === 'recovering') && download.source === 'youtube') {
      addAction('Cancel', 'cancel');
    } else if (download.state === 'progressing' || download.state === 'recovering') {
      addAction('Pause', 'pause');
      addAction('Cancel', 'cancel');
    } else if (download.state === 'paused') {
      addAction('Resume', 'resume');
      addAction('Cancel', 'cancel');
    } else if (download.state === 'completed') {
      addAction('Open', 'open');
      addAction('Show', 'show');
    } else if ((download.state === 'interrupted' || download.state === 'cancelled') && download.source !== 'youtube') {
      addAction('Retry', 'retry');
      if (download.savePath) addAction('Show', 'show');
    } else if (download.savePath) {
      addAction('Show', 'show');
    }
    row.appendChild(actions);
    elements.utilityPanel.appendChild(row);
  });

  if (downloads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'utility-panel-empty';
    empty.textContent = 'No downloads yet.';
    elements.utilityPanel.appendChild(empty);
  }
}

function renderUtilityPanel(mode, forceOpen = false) {
  if (!forceOpen && !elements.utilityPanel.hidden && elements.utilityPanel.dataset.mode === mode) {
    hideUtilityPanel();
    return;
  }
  elements.utilityPanel.dataset.mode = mode;
  elements.utilityPanel.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'utility-panel-heading';
  heading.textContent = utilityMetadata[mode].label;
  elements.utilityPanel.appendChild(heading);

  if (updateAvailable) {
    const updateAction = utilityListItem('Restart & update Still', '', { action: true });
    updateAction.addEventListener('click', restartForUpdate);
    elements.utilityPanel.appendChild(updateAction);
  }

  if (mode !== 'browser') {
    const browserSetup = utilityListItem('Browser setup', 'Default browser and sign-in options', { action: true });
    browserSetup.addEventListener('click', () => {
      utilityMode = 'browser';
      localStorage.setItem('still-utility-mode', utilityMode);
      renderUtilityButton();
      renderUtilityPanel('browser', true);
    });
    elements.utilityPanel.appendChild(browserSetup);
  }

  if (mode === 'browser') {
    const defaultAction = utilityListItem('Make Still the default browser', 'Choose Still for HTTP and HTTPS in Windows Settings', { action: true });
    defaultAction.addEventListener('click', async () => {
      const opened = await window.focusSlots.openDefaultBrowserSettings();
      if (!opened) showToast('Could not open default-browser settings.');
    });
    elements.utilityPanel.appendChild(defaultAction);

    const pageUrl = slots[activeIndex]?.url || '';
    const edgeAction = utilityListItem('Open this page in Microsoft Edge', 'Works even when Still is your default browser', { action: true });
    edgeAction.disabled = !/^https?:\/\//i.test(pageUrl);
    edgeAction.addEventListener('click', async () => {
      const opened = await window.focusSlots.openInEdge(pageUrl);
      if (!opened) showToast('Could not open Microsoft Edge. Copy the link instead.');
    });
    elements.utilityPanel.appendChild(edgeAction);

    const externalAction = utilityListItem('Open with Windows default browser', 'If that is Still, copy the link into Chrome, Edge, or Firefox', { action: true });
    externalAction.disabled = !/^https?:\/\//i.test(pageUrl);
    externalAction.addEventListener('click', async () => {
      const opened = await window.focusSlots.openInSystemBrowser(pageUrl);
      if (!opened) showToast('Could not open the page in your system browser.');
    });
    elements.utilityPanel.appendChild(externalAction);

    const copyAction = utilityListItem('Copy page link', 'Paste into Chrome, Edge, Firefox, or another browser', { action: true });
    copyAction.disabled = !/^https?:\/\//i.test(pageUrl);
    copyAction.addEventListener('click', async () => {
      if (await window.focusSlots.copyPageUrl(pageUrl)) showToast('Page link copied.');
    });
    elements.utilityPanel.appendChild(copyAction);

    const note = document.createElement('div');
    note.className = 'utility-panel-empty';
    note.textContent = 'Google may still reject sign-in inside Still. Making Still your default does not remove that block. External sign-in will not transfer cookies back to Still.';
    elements.utilityPanel.appendChild(note);
    elements.utilityPanel.hidden = false;
    elements.utilityButton.classList.add('panel-open');
    return;
  }

  if (mode === 'downloads') {
    renderDownloadEntries();
    elements.utilityPanel.hidden = false;
    elements.utilityButton.classList.add('panel-open');
    return;
  }

  if (mode === 'permissions') {
    const loading = document.createElement('div');
    loading.className = 'utility-panel-empty permission-panel-loading';
    loading.textContent = 'Checking this website…';
    elements.utilityPanel.appendChild(loading);
    elements.utilityPanel.hidden = false;
    elements.utilityButton.classList.add('panel-open');
    renderSitePermissionEntries().catch(() => {
      loading.textContent = 'Could not read site permissions.';
    });
    return;
  }

  if (mode === 'bookmarks') {
    const bookmarked = currentBookmark();
    const action = utilityListItem(bookmarked ? 'Remove bookmark' : 'Bookmark this page', '', {
      action: true,
      active: Boolean(bookmarked)
    });
    action.disabled = !isBookmarkable(slots[activeIndex]?.url);
    action.addEventListener('click', toggleCurrentBookmark);
    elements.utilityPanel.appendChild(action);
  }

  const entries = mode === 'bookmarks'
    ? bookmarks.slice(0, 12).map((item) => ({ title: item.name || item.title || displayUrl(item.url), url: item.url }))
    : browsingHistory.slice(0, 12).map((item) => ({ title: item.title || item.name || displayUrl(item.url), url: item.url }));
  const seen = new Set();
  entries.filter((item) => item.url && !seen.has(item.url) && seen.add(item.url)).forEach((item) => {
    const row = utilityListItem(item.title, item.url);
    row.addEventListener('click', () => {
      navigateSlot(slots[activeIndex], item.url);
      hideUtilityPanel();
      scheduleChromeHide();
    });
    elements.utilityPanel.appendChild(row);
  });

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'utility-panel-empty';
    empty.textContent = mode === 'bookmarks' ? 'No bookmarks yet.' : 'No history yet.';
    elements.utilityPanel.appendChild(empty);
  }
  elements.utilityPanel.hidden = false;
  elements.utilityButton.classList.add('panel-open');
}

function changeUtilityMode(direction) {
  hideUtilityPanel();
  const current = Math.max(0, utilityModes.indexOf(utilityMode));
  utilityMode = utilityModes[(current + direction + utilityModes.length) % utilityModes.length];
  localStorage.setItem('still-utility-mode', utilityMode);
  renderUtilityButton({ animate: true, direction });
}

async function runUtilityAction() {
  if (utilityMode === 'bookmarks' || utilityMode === 'history' || utilityMode === 'downloads' || utilityMode === 'permissions' || utilityMode === 'browser') {
    renderUtilityPanel(utilityMode);
    return;
  }
  hideUtilityPanel();
  if (utilityMode === 'theme') {
    cycleTheme();
    return;
  }
  if (utilityMode === 'tabdock') {
    tabDockSlideEnabled = !tabDockSlideEnabled;
    localStorage.setItem('still-tab-dock-slide-enabled', tabDockSlideEnabled ? 'true' : 'false');
    renderUtilityButton();
    showToast(`Dock slide: ${tabDockSlideEnabled ? 'on' : 'off'}`);
  }
}

function historyFallbackLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return (host[0] || '•').toUpperCase();
  } catch {
    return 'S';
  }
}

function historyFavicon(url) {
  if (faviconHistory[url]) return faviconHistory[url];
  try {
    const host = new URL(url).hostname;
    const matchingUrl = Object.keys(faviconHistory).find((candidate) => {
      try { return new URL(candidate).hostname === host; } catch { return false; }
    });
    return matchingUrl ? faviconHistory[matchingUrl] : '';
  } catch {
    return '';
  }
}

function applyHistoryMagnification(centerIndex) {
  elements.historyTrack.querySelectorAll('.history-entry').forEach((entry, index) => {
    const distance = Math.abs(index - centerIndex);
    const influence = Math.exp(-0.5 * Math.pow(distance / 0.82, 2));
    entry.style.setProperty('--history-scale', String(1 + 0.52 * influence));
    entry.style.setProperty('--history-lift', `${-9 * influence}px`);
    entry.style.setProperty('--history-shadow', String(0.62 * influence));
    entry.style.zIndex = String(Math.round(influence * 100));
    entry.classList.toggle('selected', index === centerIndex);
  });
}

function updateHistoryTimelineSelection(timeline) {
  historyTimelineState = timeline;
  applyHistoryMagnification(timeline.selectedIndex);
  const selected = timeline.entries[timeline.selectedIndex];
  elements.historyTitle.textContent = selected?.title || displayUrl(selected?.url || '') || 'Current page';
  const selectedElement = elements.historyTrack.children[timeline.selectedIndex];
  selectedElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function showHistoryTimeline(timeline) {
  if (!timeline || !Array.isArray(timeline.entries) || timeline.entries.length === 0) return;
  const sameHistory = historyTimelineState?.guestId === timeline.guestId
    && historyTimelineState?.entries.length === timeline.entries.length
    && historyTimelineState.entries.every((entry, index) => entry.url === timeline.entries[index].url);
  const wasHidden = elements.historyTimeline.hidden;
  historyHideToken++;
  elements.historyTimeline.classList.remove('closing');

  if (!sameHistory) {
    elements.historyTrack.replaceChildren();
    timeline.entries.forEach((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-entry';
      button.title = entry.title || displayUrl(entry.url);
      button.style.setProperty('--history-delay', `${45 + Math.abs(index - timeline.activeIndex) * 19}ms`);
      const favicon = historyFavicon(entry.url);
      if (favicon) {
        const image = document.createElement('img');
        image.src = favicon;
        image.alt = '';
        image.addEventListener('error', () => image.replaceWith(Object.assign(document.createElement('span'), {
          className: 'history-fallback',
          textContent: historyFallbackLabel(entry.url)
        })));
        button.appendChild(image);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'history-fallback';
        fallback.textContent = historyFallbackLabel(entry.url);
        button.appendChild(fallback);
      }
      button.addEventListener('mouseenter', () => applyHistoryMagnification(index));
      button.addEventListener('click', () => window.focusSlots.goToHistory(timeline.guestId, index));
      elements.historyTrack.appendChild(button);
    });
  }

  elements.historyTrack.onmouseleave = () => {
    if (historyTimelineState) applyHistoryMagnification(historyTimelineState.selectedIndex);
  };
  elements.historyTimeline.hidden = false;
  if (wasHidden) {
    elements.historyTimeline.classList.remove('visible');
    requestAnimationFrame(() => requestAnimationFrame(() => elements.historyTimeline.classList.add('visible')));
  }
  updateHistoryTimelineSelection(timeline);
}

function hideHistoryTimeline() {
  if (elements.historyTimeline.hidden) return;
  const token = ++historyHideToken;
  elements.historyTimeline.classList.add('closing');
  elements.historyTimeline.classList.remove('visible');
  setTimeout(() => {
    if (token !== historyHideToken) return;
    elements.historyTimeline.hidden = true;
    elements.historyTimeline.classList.remove('closing');
    elements.historyTrack.replaceChildren();
    historyTimelineState = null;
  }, 170);
}

function displayUrl(url) {
  if (!url || url.startsWith('file:')) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'www.google.com' && parsed.pathname === '/search') {
      return parsed.searchParams.get('q') || url;
    }
  } catch {}
  return url;
}

function normalizeInput(value) {
  const input = value.trim();
  if (!input) return startPageUrl;
  const normalizedInput = input.toLocaleLowerCase();
  if (normalizedInput === 'editor') return editorPageUrl;
  if (normalizedInput === 'learn' || normalizedInput === 'still learn') return learnPageUrl;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(input)) return `http://${input}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(input)) return `https://${input}`;
  if (!searchBaseUrl) {
    showToast('Still Search is unavailable. Reinstall Still to restore private search.', 7000);
    return startPageUrl;
  }
  const search = new URL('search', searchBaseUrl);
  search.searchParams.set('q', input);
  return search.href;
}

function suggestionLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function rankedHistoryMatches(value, limit = 5) {
  const query = value.trim().toLocaleLowerCase();
  if (!query || /^https?:\/\//i.test(query)) return [];
  const tokens = query.split(/\s+/).filter(Boolean);
  const matches = [];
  const siteMatches = new Map();

  browsingHistory.forEach((entry, index) => {
    try {
      const parsed = new URL(entry.url);
      const host = parsed.hostname.replace(/^www\./, '').toLocaleLowerCase();
      const hostStem = host.split('.')[0];
      const title = (entry.title || '').toLocaleLowerCase();
      const url = entry.url.toLocaleLowerCase();
      const searchable = `${host} ${title} ${url}`;
      if (!tokens.every((token) => searchable.includes(token))) return;

      let score = 0;
      if (hostStem === query || host === query) score += 1100;
      else if (hostStem.startsWith(query) || host.startsWith(query)) score += 900;
      else if (host.includes(query)) score += 700;
      if (title.startsWith(query)) score += 620;
      else if (title.includes(query)) score += 470;
      if (url.includes(query)) score += 260;
      score += Math.min(180, Number(entry.typedCount || 0) * 24);
      score += Math.min(140, Math.log2(Number(entry.visitCount || 0) + 1) * 18);
      score += Math.max(0, 90 - index / 45);
      if (tokens.length === 1 && hostStem.startsWith(query)) {
        const rootUrl = `${parsed.protocol}//${parsed.host}/`;
        const brandNames = { youtube: 'YouTube', github: 'GitHub', linkedin: 'LinkedIn', tiktok: 'TikTok' };
        const siteScore = score + 320;
        const currentSite = siteMatches.get(rootUrl);
        if (!currentSite || currentSite.score < siteScore) {
          siteMatches.set(rootUrl, {
            url: rootUrl,
            title: brandNames[hostStem] || hostStem.charAt(0).toUpperCase() + hostStem.slice(1),
            score: siteScore,
            label: suggestionLabel(rootUrl)
          });
        }
        if (parsed.pathname !== '/') score -= Math.min(360, 140 + parsed.pathname.length * 8);
        if (/\/(?:sign-?in|login|logout|auth|account)(?:\/|$)/i.test(parsed.pathname)) score -= 520;
      }
      matches.push({ ...entry, score, label: suggestionLabel(entry.url) });
    } catch {}
  });

  matches.push(...siteMatches.values());
  const unique = new Map();
  for (const match of matches) {
    let key = match.url;
    try {
      const normalized = new URL(match.url);
      normalized.hostname = normalized.hostname.replace(/^www\./, '');
      key = normalized.href;
    } catch {}
    const existing = unique.get(key);
    if (!existing || existing.score < match.score) unique.set(key, match);
  }
  return [...unique.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

function navigateSlot(slot, url) {
  const target = url || startPageUrl;
  prepareVerticalNavigation(slot, 'forward');
  clearTimeout(slot.snapshotRefreshTimer);
  slot.snapshotRefreshTimer = null;
  slot.url = target;
  slot.pendingUrl = target;
  slot.snapshot = '';
  slot.snapshotImage = null;
  slot.snapshotGeneration++;
  slot.dockFavicon = '';
  beginPageLoading(slot);
  slot.title = target === startPageUrl ? 'Still' : 'Loading…';
  const webview = createWebview(slot);
  try {
    if (slot.ready) {
      slot.pendingUrl = '';
      webview.loadURL(target);
    } else {
      webview.src = target;
    }
  } catch {
    webview.src = target;
  }
  saveState();
}

function updateSlotFromNavigation(slot) {
  if (!slot.webview) return;
  try {
    slot.url = slot.webview.getURL();
  } catch {}
  if (slot.index === activeIndex && utilityMode === 'bookmarks') renderUtilityButton();
  saveState();
}

async function refreshSlotSnapshot(slot) {
  if (!slot?.webview || !slot.ready) return false;
  const generation = ++slot.snapshotGeneration;
  try {
    const image = await slot.webview.capturePage();
    if (generation !== slot.snapshotGeneration || image.isEmpty()) return false;
    const dataUrl = image.toDataURL();
    const snapshotImage = new Image();
    snapshotImage.className = 'page-transition-shot';
    snapshotImage.alt = '';
    snapshotImage.src = dataUrl;
    await snapshotImage.decode();
    if (generation !== slot.snapshotGeneration) return false;
    slot.snapshot = dataUrl;
    slot.snapshotImage = snapshotImage;
    if (slot.index === activeIndex) paintPageEdgeExtensions(slot);
    return true;
  } catch {
    return false;
  }
}

function paintPageEdgeExtensions(slot = slots[activeIndex]) {
  const image = slot?.snapshotImage;
  if (!image?.naturalWidth || !image?.naturalHeight) return false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return false;

    context.drawImage(image, 0, 0, 1, image.naturalHeight, 0, 0, 1, image.naturalHeight);
    elements.edgeLeft.style.setProperty('--edge-image', `url("${canvas.toDataURL('image/png')}")`);

    context.clearRect(0, 0, 1, image.naturalHeight);
    context.drawImage(image, image.naturalWidth - 1, 0, 1, image.naturalHeight, 0, 0, 1, image.naturalHeight);
    elements.edgeRight.style.setProperty('--edge-image', `url("${canvas.toDataURL('image/png')}")`);
    return true;
  } catch {
    return false;
  }
}

function preparePageEdgeExtensions() {
  const slot = slots[activeIndex];
  if (paintPageEdgeExtensions(slot) || !slot?.ready) return;
  refreshSlotSnapshot(slot).then((refreshed) => {
    if (refreshed && slot.index === activeIndex) paintPageEdgeExtensions(slot);
  });
}

function scheduleSlotSnapshotRefresh(slot, delay = 900) {
  clearTimeout(slot.snapshotRefreshTimer);
  slot.snapshotRefreshTimer = setTimeout(() => {
    slot.snapshotRefreshTimer = null;
    if (slot.index !== activeIndex) return;
    if (slotTransitionAnimations.length) {
      scheduleSlotSnapshotRefresh(slot, 650);
      return;
    }
    refreshSlotSnapshot(slot);
  }, delay);
}

function suppressRestoredBackgroundMedia(slot) {
  if (!slot?.startupMediaBlocked || !slot.webview) return;
  try { slot.webview.setAudioMuted(true); } catch {}
  slot.webview.executeJavaScript(`
    document.querySelectorAll('video, audio').forEach((media) => {
      if (!media.paused) media.pause();
    });
  `, true).catch(() => {});
}

async function warmSlotSnapshots() {
  for (const slot of slots.filter((item) => item.occupied)) {
    while (slotTransitionAnimations.length || performance.now() - lastSlotInteractionAt < 1200) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await refreshSlotSnapshot(slot);
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
}

function focusStartPageInput(slot) {
  const webview = slot?.webview;
  if (!webview || slot.index !== activeIndex || !slot.focusStartInput) return;
  let currentUrl = '';
  try { currentUrl = webview.getURL(); } catch {}
  if (currentUrl !== startPageUrl) return;
  try { webview.focus(); } catch {}
  webview.executeJavaScript(`
    (() => {
      const input = document.querySelector('#search-input');
      if (!input) return false;
      input.focus({ preventScroll: true });
      return document.activeElement === input;
    })();
  `, true).then((focused) => {
    if (focused) slot.focusStartInput = false;
  }).catch(() => {});
}

const PAGE_ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function applySlotZoom(slot) {
  if (!slot?.webview || !slot.ready) return;
  const factor = Number.isFinite(slot.zoomFactor) ? slot.zoomFactor : 1;
  try { slot.webview.setZoomFactor(factor); } catch {}
}

function changePageZoom(direction) {
  const slot = slots[activeIndex];
  if (!slot?.webview) return;
  const current = Number.isFinite(slot.zoomFactor) ? slot.zoomFactor : 1;
  let factor = 1;
  if (direction > 0) {
    factor = PAGE_ZOOM_FACTORS.find((value) => value > current + 0.001) || PAGE_ZOOM_FACTORS.at(-1);
  } else if (direction < 0) {
    factor = [...PAGE_ZOOM_FACTORS].reverse().find((value) => value < current - 0.001) || PAGE_ZOOM_FACTORS[0];
  }
  slot.zoomFactor = factor;
  applySlotZoom(slot);
  saveState();
  showToast(`Page zoom: ${Math.round(factor * 100)}%`);
}

function createWebview(slot) {
  if (slot.webview) return slot.webview;
  const webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:focus');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
  webview.setAttribute('aria-label', `Browsing slot ${slot.index + 1}`);
  webview.src = slot.url || startPageUrl;

  webview.addEventListener('dom-ready', () => {
    slot.ready = true;
    finishPageLoading(slot);
    applySlotZoom(slot);
    suppressRestoredBackgroundMedia(slot);
    if (slot.index === activeIndex) {
      window.focusSlots.setActiveGuest(webview.getWebContentsId());
    }
    if (!slot.pendingUrl) {
      focusStartPageInput(slot);
      return;
    }
    const pendingUrl = slot.pendingUrl;
    slot.pendingUrl = '';
    try {
      if (webview.getURL() !== pendingUrl) webview.loadURL(pendingUrl);
    } catch {
      webview.src = pendingUrl;
    }
  });

  webview.addEventListener('did-attach', () => {
    applySlotZoom(slot);
    if (slot.startupMediaBlocked) {
      try { webview.setAudioMuted(true); } catch {}
    }
    if (slot.index === activeIndex) {
      window.focusSlots.setActiveGuest(webview.getWebContentsId());
    }
  });

  webview.addEventListener('enter-html-full-screen', () => {
    if (slot.index === activeIndex) document.body.classList.add('guest-video-fullscreen');
  });
  webview.addEventListener('leave-html-full-screen', () => {
    document.body.classList.remove('guest-video-fullscreen');
  });

  webview.addEventListener('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isInPlace) {
      if (pendingVerticalNavigation?.slot !== slot) prepareVerticalNavigation(slot, 'forward');
      beginPageLoading(slot);
    }
  });
  webview.addEventListener('did-navigate', () => updateSlotFromNavigation(slot));
  webview.addEventListener('did-navigate-in-page', () => updateSlotFromNavigation(slot));
  webview.addEventListener('did-start-loading', () => {
    slot.snapshot = '';
    slot.snapshotImage = null;
    slot.snapshotGeneration++;
    slot.mediaPlaying = false;
  });
  webview.addEventListener('did-stop-loading', () => {
    finishPageLoading(slot, 80);
    suppressRestoredBackgroundMedia(slot);
    if (slot.index === activeIndex) scheduleSlotSnapshotRefresh(slot, 800);
  });
  webview.addEventListener('media-started-playing', () => {
    if (slot.startupMediaBlocked) suppressRestoredBackgroundMedia(slot);
    slot.mediaPlaying = true;
    if (slot.index === activeIndex) scheduleSlotSnapshotRefresh(slot, 180);
  });
  webview.addEventListener('media-paused', () => {
    slot.mediaPlaying = false;
    if (slot.index === activeIndex) scheduleSlotSnapshotRefresh(slot, 450);
  });
  webview.addEventListener('page-title-updated', (event) => {
    slot.title = event.title || 'Untitled';
    rememberVisit(slot);
    if (editingIndex !== slot.index) renderSlots();
    saveState();
  });
  webview.addEventListener('page-favicon-updated', (event) => {
    const favicon = (event.favicons || []).find((url) => /^(https?:|data:)/i.test(url));
    if (!favicon || favicon.length > 3000) return;
    if (slot.favicon !== favicon) slot.dockFavicon = '';
    slot.favicon = favicon;
    if (isBookmarkable(slot.url)) {
    }
    if (editingIndex !== slot.index) renderSlots();
    saveState();
  });
  webview.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3 || event.isMainFrame === false) return;
    const failedUrl = String(event.validatedURL || slot.url || '');
    if (/^https:\/\//i.test(failedUrl) && /^ERR_CERT_/i.test(event.errorDescription)) {
      showToast('Still blocked an untrusted certificate for this site.', 15000, {
        label: 'Access anyway',
        run: async () => {
          if (!await window.focusSlots.allowCertificateForUrl(failedUrl)) {
            showToast('Could not create a temporary certificate exception.');
            return;
          }
          webview.loadURL(failedUrl);
        }
      });
      return;
    }
    if (/^https:\/\//i.test(failedUrl) && event.errorDescription === 'ERR_SSL_PROTOCOL_ERROR') {
      const fallbackUrl = new URL(failedUrl);
      fallbackUrl.protocol = 'http:';
      showToast('HTTPS failed. Access anyway will use an unencrypted connection.', 15000, {
        label: 'Access anyway',
        run: () => webview.loadURL(fallbackUrl.href)
      });
      return;
    }
    showToast(`Could not open that page (${event.errorDescription}).`);
  });
  webview.addEventListener('render-process-gone', (event) => {
    const reason = event.details?.reason || 'crashed';
    if (reason === 'clean-exit' || slot.webview !== webview) return;
    const now = Date.now();
    slot.crashRecoveryTimes = slot.crashRecoveryTimes.filter((time) => now - time < 60000);
    slot.ready = false;
    slot.snapshot = '';
    slot.snapshotImage = null;
    slot.snapshotGeneration++;
    clearTimeout(slot.snapshotRefreshTimer);
    slot.snapshotRefreshTimer = null;

    if (slot.crashRecoveryTimes.length >= 2) {
      showToast('This page keeps crashing. Close its slot and try it again.', 6000);
      return;
    }
    slot.crashRecoveryTimes.push(now);
    showToast('The page stopped unexpectedly. Recovering it...', 4500);
    setTimeout(() => {
      if (slot.webview !== webview || !webview.isConnected) return;
      try {
        webview.reload();
      } catch {
        webview.src = slot.url || startPageUrl;
      }
    }, 300);
  });

  slot.webview = webview;
  elements.webviews.appendChild(webview);
  return webview;
}

function faviconElement(slot) {
  if (!slot.url || slot.url === startPageUrl || slot.url.startsWith('file:')) {
    const brand = document.createElement('img');
    brand.className = 'slot-favicon brand-favicon';
    brand.src = 'assets/still-icon.png';
    brand.alt = '';
    return brand;
  }
  if (slot.favicon) {
    const image = document.createElement('img');
    image.className = 'slot-favicon';
    image.src = slot.favicon;
    image.alt = '';
    image.addEventListener('error', () => {
      slot.favicon = '';
      renderSlots();
    }, { once: true });
    return image;
  }
  const placeholder = document.createElement('span');
  placeholder.className = 'slot-favicon placeholder';
  placeholder.textContent = slot.title?.trim().charAt(0).toLocaleUpperCase() || '·';
  return placeholder;
}

function tabDockSignature() {
  return `${activeIndex}::${slots.map((slot) => [slot.id, slot.occupied, slot.title, slot.dockFavicon ? 'cached' : '', slot.favicon, slot.url].join('|')).join('::')}`;
}

function upscaleFaviconLocally(source) {
  if (faviconUpscaleJobs.has(source)) return faviconUpscaleJobs.get(source);
  const job = (async () => {
    const prepared = await window.focusSlots.prepareFavicon(source);
    if (!prepared?.dataUrl || prepared.cached) return prepared?.dataUrl || '';

    const raster = new Image();
    raster.decoding = 'async';
    raster.src = prepared.dataUrl;
    await Promise.race([
      raster.decode(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Favicon decode timed out.')), 3500))
    ]);
    if (!raster.naturalWidth || !raster.naturalHeight) return '';

    const scale = 128 / Math.max(raster.naturalWidth, raster.naturalHeight);
    const width = Math.max(1, Math.round(raster.naturalWidth * scale));
    const height = Math.max(1, Math.round(raster.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!context) return '';
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, width, height);
    context.drawImage(raster, 0, 0, width, height);

    if (width > 2 && height > 2) {
      const pixels = context.getImageData(0, 0, width, height);
      const original = new Uint8ClampedArray(pixels.data);
      const amount = 0.46;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const offset = (y * width + x) * 4;
          if (original[offset + 3] < 8) continue;
          const neighbors = [offset - 4, offset + 4, offset - width * 4, offset + width * 4];
          for (let channel = 0; channel < 3; channel += 1) {
            let sum = 0;
            let count = 0;
            for (const neighbor of neighbors) {
              if (original[neighbor + 3] < 8) continue;
              sum += original[neighbor + channel];
              count += 1;
            }
            if (!count) continue;
            const center = original[offset + channel];
            pixels.data[offset + channel] = Math.max(0, Math.min(255,
              Math.round(center + amount * (center - sum / count))));
          }
        }
      }
      context.putImageData(pixels, 0, 0);
    }

    const upscaled = canvas.toDataURL('image/png');
    return await window.focusSlots.storeFavicon(source, upscaled) || upscaled;
  })().catch(() => '').finally(() => faviconUpscaleJobs.delete(source));
  faviconUpscaleJobs.set(source, job);
  return job;
}

function tabDockIcon(slot) {
  if (!slot.occupied) {
    const empty = document.createElement('span');
    empty.className = 'tab-dock-empty-icon';
    empty.textContent = '+';
    return empty;
  }
  if (!slot.url || slot.url === startPageUrl || slot.url.startsWith('file:')) {
    const brand = faviconElement(slot);
    brand.classList.add('tab-dock-favicon');
    return brand;
  }
  if (!slot.favicon) {
    const placeholder = faviconElement(slot);
    placeholder.classList.add('tab-dock-favicon');
    return placeholder;
  }

  const image = document.createElement('img');
  image.className = 'slot-favicon tab-dock-favicon';
  image.alt = '';
  const sourceFavicon = slot.favicon || '';
  image.src = slot.dockFavicon || sourceFavicon;
  image.addEventListener('error', () => {
    const placeholder = document.createElement('span');
    placeholder.className = 'slot-favicon placeholder tab-dock-favicon';
    placeholder.textContent = slot.title?.trim().charAt(0).toLocaleUpperCase() || '·';
    image.replaceWith(placeholder);
  });

  // Keep Alt-dock construction entirely synchronous. The page's own favicon is
  // already available here; decoding/upscaling additional copies while five live
  // webviews are rendering caused native Chromium instability on this machine.
  return image;
}

function buildTabDock() {
  elements.tabDockIcons.replaceChildren();
  slots.forEach((slot, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `tab-dock-item${slot.occupied ? '' : ' empty'}`;
    item.dataset.index = String(index);
    item.title = slot.occupied ? (slot.title || displayUrl(slot.url)) : 'Empty slot';
    const distance = Math.abs(index - activeIndex);
    const arrivalDelay = distance === 0 ? 0 : 28 + (distance - 1) * (28 + distance * 3);
    item.style.setProperty('--tab-dock-delay', `${arrivalDelay}ms`);
    item.style.setProperty('--tab-dock-scale-duration', `${128 + distance * 72}ms`);
    item.style.setProperty('--tab-dock-opacity-duration', `${58 + distance * 48}ms`);
    item.style.setProperty('--tab-dock-blur-duration', `${112 + distance * 66}ms`);

    const visual = document.createElement('span');
    visual.className = 'tab-dock-visual';
    visual.appendChild(tabDockIcon(slot));
    item.appendChild(visual);
    item.addEventListener('click', () => {
      tabDockCommitDirection = Math.sign(index - activeIndex);
      commitTabDockIndex(index);
      hideTabDock();
    });
    elements.tabDockIcons.appendChild(item);
  });
  tabDockBuildSignature = tabDockSignature();
}

function updateTabDockMagnification(centerIndex = tabDockSelectedIndex, pointerX = null) {
  const items = [...elements.tabDockIcons.querySelectorAll('.tab-dock-item')];
  if (!items.length) return;
  let nearestIndex = centerIndex;
  let nearestDistance = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    const bounds = item.getBoundingClientRect();
    const center = bounds.left + bounds.width / 2;
    const distance = pointerX === null ? Math.abs(index - centerIndex) * 82 : Math.abs(pointerX - center);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
    const influence = Math.exp(-0.5 * Math.pow(distance / 58, 2.15));
    const visual = item.querySelector('.tab-dock-visual');
    visual.style.setProperty('--tab-dock-scale', String(1 + 0.68 * influence));
    visual.style.setProperty('--tab-dock-shadow-opacity', String(0.72 * influence));
    visual.style.setProperty('--tab-dock-shadow-y', `${3 + 8 * influence}px`);
    visual.style.setProperty('--tab-dock-shadow-blur', `${16 + 10 * influence}px`);
    item.style.zIndex = String(Math.round(influence * 1000));
  });
  if (pointerX !== null) {
    tabDockSelectedIndex = nearestIndex;
    tabDockHoverIndex = nearestIndex;
    tabDockCommitDirection = Math.sign(nearestIndex - activeIndex);
  }
  items.forEach((item, index) => item.classList.toggle('selected', index === tabDockSelectedIndex));
}

function selectTabDock(index) {
  tabDockSelectedIndex = Math.max(0, Math.min(SLOT_COUNT - 1, index));
  updateTabDockMagnification(tabDockSelectedIndex);
}

function scheduleTabDockHide(delay = 1150) {
  clearTimeout(tabDockHideTimer);
  tabDockHideTimer = setTimeout(() => hideTabDock(), delay);
}

function showTabDock() {
  clearTimeout(tabDockHideTimer);
  if (tabDockVisible) {
    scheduleTabDockHide(4000);
    return;
  }
  const signature = tabDockSignature();
  if (!tabDockVisible || signature !== tabDockBuildSignature) buildTabDock();
  tabDockVisible = true;
  tabDockHoverIndex = -1;
  tabDockCommitDirection = 0;
  tabDockOpenedAt = performance.now();
  elements.tabDock.hidden = false;
  elements.tabDock.classList.remove('closing');
  selectTabDock(activeIndex);
  requestAnimationFrame(() => elements.tabDock.classList.add('visible'));
  scheduleTabDockHide(4000);
}

function hideTabDock(immediate = false) {
  clearTimeout(tabDockHideTimer);
  tabDockVisible = false;
  tabDockHoverIndex = -1;
  elements.tabDock.classList.add('closing');
  elements.tabDock.classList.remove('visible');
  if (immediate) {
    elements.tabDock.classList.remove('closing');
    elements.tabDock.hidden = true;
    return;
  }
  setTimeout(() => {
    if (!tabDockVisible) elements.tabDock.hidden = true;
  }, 120);
}

function releaseTabDockSelection() {
  if (!tabDockVisible) return;
  const chosenIndex = tabDockHoverIndex >= 0 ? tabDockHoverIndex : tabDockSelectedIndex;
  commitTabDockIndex(chosenIndex);
  hideTabDock();
}

function commitTabDockIndex(index) {
  const chosen = slots[index];
  if (!chosen) return;
  const transitionDirection = tabDockSlideEnabled
    ? (tabDockCommitDirection || Math.sign(index - activeIndex))
    : 0;
  if (chosen.occupied) {
    if (index !== activeIndex) activateSlot(index, { transitionDirection });
    return;
  }
  const firstEmpty = slots.find((slot) => !slot.occupied);
  if (!firstEmpty) return;
  const emptyDirection = tabDockSlideEnabled
    ? (tabDockCommitDirection || Math.sign(firstEmpty.index - activeIndex) || 1)
    : 0;
  openSlot(firstEmpty.index, startPageUrl, { transitionDirection: emptyDirection });
}

function moveTabDockSelection(direction) {
  if (!direction) return;
  if (!tabDockVisible) showTabDock();
  const step = Math.sign(direction);
  const nextIndex = (tabDockSelectedIndex + step + SLOT_COUNT) % SLOT_COUNT;
  tabDockHoverIndex = -1;
  tabDockCommitDirection = step;
  selectTabDock(nextIndex);
  scheduleTabDockHide(4000);
}

elements.tabDock.addEventListener('pointermove', (event) => {
  if (!tabDockVisible) return;
  clearTimeout(tabDockHideTimer);
  updateTabDockMagnification(tabDockSelectedIndex, event.clientX);
});
elements.tabDock.addEventListener('pointerenter', () => clearTimeout(tabDockHideTimer));
elements.tabDock.addEventListener('pointerleave', () => {
  scheduleTabDockHide(900);
});

function beginSlotEdit(index) {
  if (!slots[index].occupied) return;
  activateSlot(index, { hideAfter: false });
  editingIndex = index;
  showChrome();
  renderSlots();
  requestAnimationFrame(() => {
    const input = elements.slotRow.querySelector('.slot-editor input');
    input?.focus();
    input?.select();
  });
}

function finishSlotEdit(index, value, chosenUrl = '') {
  const slot = slots[index];
  editingIndex = -1;
  navigateSlot(slot, chosenUrl || normalizeInput(value));
  renderSlots();
  scheduleChromeHide();
}

function reorderSlots(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  if (!slots[fromIndex]?.occupied) return;
  const occupiedCount = slots.filter((slot) => slot.occupied).length;
  toIndex = Math.min(toIndex, occupiedCount - 1);
  const oldRects = new Map(
    [...elements.slotRow.querySelectorAll('.slot')].map((pill) => [pill.dataset.slotId, pill.getBoundingClientRect()])
  );
  const activeSlot = slots[activeIndex];
  const editingSlot = editingIndex >= 0 ? slots[editingIndex] : null;
  const [moved] = slots.splice(fromIndex, 1);
  slots.splice(toIndex, 0, moved);
  compactSlotOrder(activeSlot);
  slotTransitionToken++;
  resetSlotTransitionVisuals();
  editingIndex = editingSlot ? slots.indexOf(editingSlot) : -1;
  renderSlots();
  requestAnimationFrame(() => {
    elements.slotRow.querySelectorAll('.slot').forEach((pill) => {
      const oldRect = oldRects.get(pill.dataset.slotId);
      if (!oldRect) return;
      const newRect = pill.getBoundingClientRect();
      const deltaX = oldRect.left - newRect.left;
      const deltaY = oldRect.top - newRect.top;
      if (!deltaX && !deltaY) return;
      pill.animate([
        { transform: `translate(${deltaX}px, ${deltaY}px) scale(.965)`, filter: 'brightness(1.18)' },
        { transform: 'translate(0, 0) scale(1)', filter: 'brightness(1)' }
      ], { duration: 430, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    });
  });
  saveState();
  showChrome();
}

function attachDragBehavior(pill, slot) {
  if (editingIndex === slot.index) return;
  pill.draggable = slot.occupied;
  pill.addEventListener('dragstart', (event) => {
    if (event.target.closest('button, input, form')) {
      event.preventDefault();
      return;
    }
    draggedIndex = slot.index;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(slot.index));
    pill.classList.add('dragging');
    showChrome();
  });
  pill.addEventListener('dragover', (event) => {
    if (draggedIndex < 0 || draggedIndex === slot.index) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    pill.classList.add('drop-target');
  });
  pill.addEventListener('dragleave', () => pill.classList.remove('drop-target'));
  pill.addEventListener('drop', (event) => {
    event.preventDefault();
    const fromIndex = draggedIndex;
    draggedIndex = -1;
    reorderSlots(fromIndex, slot.index);
  });
  pill.addEventListener('dragend', () => {
    draggedIndex = -1;
    elements.slotRow.querySelectorAll('.dragging, .drop-target').forEach((element) => {
      element.classList.remove('dragging', 'drop-target');
    });
    scheduleChromeHide();
  });
}

function slotEditor(slot) {
  const form = document.createElement('form');
  form.className = 'slot-editor';
  form.autocomplete = 'off';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'Search or enter address';
  let currentUrl = slot.url;
  try {
    currentUrl = slot.webview?.getURL() || currentUrl;
  } catch {}
  input.value = displayUrl(currentUrl);
  input.setAttribute('aria-label', `Search or enter address for slot ${slot.index + 1}`);
  const suggestionPanel = document.createElement('div');
  suggestionPanel.className = 'slot-suggestions';
  // Keep the empty dropdown out of layout until suggestions have actually
  // been rendered. If focus moves during a slot repaint, an uninitialized
  // panel otherwise appears as a thin glass bar beneath the address field.
  suggestionPanel.hidden = true;
  let currentSuggestions = [];
  let selectedSuggestion = -1;

  const paintSuggestionSelection = () => {
    suggestionPanel.querySelectorAll('.slot-suggestion:not(.search-option)').forEach((element, index) => {
      element.classList.toggle('selected', index === selectedSuggestion);
    });
  };

  const renderSuggestions = () => {
    const query = input.value.trim();
    currentSuggestions = rankedHistoryMatches(query);
    selectedSuggestion = currentSuggestions.length ? 0 : -1;
    suggestionPanel.replaceChildren();
    if (!query) {
      suggestionPanel.hidden = true;
      return;
    }
    suggestionPanel.hidden = false;

    currentSuggestions.forEach((suggestion, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `slot-suggestion${index === selectedSuggestion ? ' selected' : ''}`;
      const title = document.createElement('span');
      title.textContent = suggestion.title || suggestion.label;
      const location = document.createElement('small');
      location.textContent = suggestion.label;
      item.append(title, location);
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('mouseenter', () => {
        selectedSuggestion = index;
        paintSuggestionSelection();
      });
      item.addEventListener('click', () => finishSlotEdit(slot.index, input.value, suggestion.url));
      suggestionPanel.appendChild(item);
    });

    const search = document.createElement('button');
    search.type = 'button';
    search.className = 'slot-suggestion search-option';
    const searchTitle = document.createElement('span');
    const normalizedQuery = query.toLocaleLowerCase();
    const opensEditor = normalizedQuery === 'editor';
    const opensLearn = normalizedQuery === 'learn' || normalizedQuery === 'still learn';
    searchTitle.textContent = opensEditor
      ? 'Open blank editor'
      : opensLearn
        ? 'Open Still Learn'
        : `Search Still Search for “${query}”`;
    const searchLabel = document.createElement('small');
    searchLabel.textContent = opensEditor
      ? 'Local writing page'
      : opensLearn
        ? 'Your selected YouTube channels only'
        : 'Private local metasearch';
    search.append(searchTitle, searchLabel);
    search.addEventListener('mousedown', (event) => event.preventDefault());
    search.addEventListener('click', () => finishSlotEdit(slot.index, query, normalizeInput(query)));
    suggestionPanel.appendChild(search);
  };

  form.append(input, suggestionPanel);
  form.addEventListener('click', (event) => event.stopPropagation());
  form.addEventListener('dblclick', (event) => event.stopPropagation());

  const commitEdit = () => {
    const normalizedInput = input.value.trim().toLocaleLowerCase();
    if (normalizedInput === 'editor') {
      finishSlotEdit(slot.index, input.value, editorPageUrl);
      return;
    }
    if (normalizedInput === 'learn' || normalizedInput === 'still learn') {
      finishSlotEdit(slot.index, input.value, learnPageUrl);
      return;
    }
    const suggestion = selectedSuggestion >= 0 ? currentSuggestions[selectedSuggestion] : null;
    const useHistory = suggestion && suggestion.score >= 620;
    finishSlotEdit(slot.index, input.value, useHistory ? suggestion.url : '');
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    commitEdit();
  });
  input.addEventListener('input', renderSuggestions);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commitEdit();
    } else if (event.key === 'ArrowDown' && currentSuggestions.length) {
      event.preventDefault();
      selectedSuggestion = (selectedSuggestion + 1) % currentSuggestions.length;
      paintSuggestionSelection();
    } else if (event.key === 'ArrowUp' && currentSuggestions.length) {
      event.preventDefault();
      selectedSuggestion = (selectedSuggestion - 1 + currentSuggestions.length) % currentSuggestions.length;
      paintSuggestionSelection();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editingIndex = -1;
      renderSlots();
      scheduleChromeHide();
    }
  });
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (editingIndex === slot.index && !form.contains(document.activeElement)) {
        editingIndex = -1;
        renderSlots();
        scheduleChromeHide();
      }
    }, 120);
  });
  return form;
}

function renderSlots() {
  elements.slotRow.replaceChildren();
  slots.forEach((slot) => {
    const pill = document.createElement('div');
    pill.className = `slot${slot.occupied ? '' : ' empty'}${slot.index === activeIndex ? ' active' : ''}`;
    pill.dataset.slotId = slot.id;
    pill.setAttribute('role', 'button');
    pill.tabIndex = 0;
    pill.title = slot.occupied ? 'Double-click to search or enter a URL; drag to reorder' : `Search in slot ${slot.index + 1}; drag to reorder`;
    attachDragBehavior(pill, slot);

    if (!slot.occupied) {
      pill.textContent = `+ Slot ${slot.index + 1}`;
      pill.addEventListener('click', () => {
        openSlot(slot.index, startPageUrl);
        beginSlotEdit(slot.index);
      });
      pill.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          openSlot(slot.index, startPageUrl);
          beginSlotEdit(slot.index);
        }
      });
    } else {
      pill.append(faviconElement(slot));

      if (editingIndex === slot.index) {
        pill.appendChild(slotEditor(slot));
      } else {
        const title = document.createElement('span');
        title.className = 'slot-title';
        title.textContent = slot.title || 'Still';
        pill.appendChild(title);
      }

      const privacyActivity = slotPermissionActivity(slot);
      if (privacyActivity) pill.appendChild(privacyActivity);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'slot-close';
      close.setAttribute('aria-label', `Close slot ${slot.index + 1}`);
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeSlot(slot.index);
      });
      pill.appendChild(close);
      pill.addEventListener('click', () => activateSlot(slot.index));
      pill.addEventListener('dblclick', (event) => {
        if (event.target.closest('button, input, form')) return;
        event.preventDefault();
        beginSlotEdit(slot.index);
      });
      pill.addEventListener('keydown', (event) => {
        if (event.target.closest('button, input, form')) return;
        if (event.key === 'Enter' || event.key === ' ') activateSlot(slot.index);
      });
    }
    elements.slotRow.appendChild(pill);
  });
}

function resetSlotTransitionVisuals() {
  slotTransitionAnimations.forEach((animation) => animation.cancel());
  slotTransitionAnimations = [];
  pendingVerticalNavigation = null;
  elements.transitionStage.hidden = true;
  elements.transitionStage.replaceChildren();
  slots.forEach((slot) => {
    if (!slot.webview) return;
    slot.webview.classList.toggle('active', slot.index === activeIndex);
    slot.webview.style.removeProperty('z-index');
    slot.webview.style.removeProperty('pointer-events');
    slot.webview.style.removeProperty('will-change');
    slot.webview.style.removeProperty('backface-visibility');
    slot.webview.style.removeProperty('transform');
  });
}

function prepareVerticalNavigation(slot, direction) {
  if (slot.index !== activeIndex || !slot.snapshotImage
      || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  resetSlotTransitionVisuals();
  const token = ++slotTransitionToken;
  const outgoing = slot.snapshotImage.cloneNode(true);
  outgoing.style.zIndex = '1';
  elements.transitionStage.replaceChildren(outgoing);
  elements.transitionStage.hidden = false;
  pendingVerticalNavigation = { slot, direction, outgoing, token };
  return true;
}

function completeVerticalNavigation(slot) {
  const pending = pendingVerticalNavigation;
  if (!pending || pending.slot !== slot || pending.token !== slotTransitionToken) return false;
  pendingVerticalNavigation = null;
  const { outgoing, direction, token } = pending;
  const incoming = slot.webview;
  if (!incoming) {
    resetSlotTransitionVisuals();
    return false;
  }
  incoming.classList.add('active');
  incoming.style.zIndex = '49';
  incoming.style.pointerEvents = 'none';
  incoming.style.willChange = 'transform';
  incoming.style.backfaceVisibility = 'hidden';
  const travel = direction === 'back' ? -1 : 1;
  const timing = {
    duration: SLOT_TRANSITION_DURATION,
    easing: 'cubic-bezier(.16, 1, .3, 1)',
    fill: 'both'
  };
  const outgoingAnimation = outgoing.animate([
    { transform: 'translate3d(0, 0, 0)' },
    { transform: `translate3d(0, ${travel * 100}%, 0)` }
  ], timing);
  const incomingAnimation = incoming.animate([
    { transform: `translate3d(0, ${-travel * 100}%, 0)` },
    { transform: 'translate3d(0, 0, 0)' }
  ], timing);
  slotTransitionAnimations = [outgoingAnimation, incomingAnimation];
  Promise.allSettled(slotTransitionAnimations.map((animation) => animation.finished)).then(() => {
    if (token !== slotTransitionToken) return;
    resetSlotTransitionVisuals();
  });
  return true;
}

function navigateHistory(direction) {
  const slot = slots[activeIndex];
  const webview = slot?.webview;
  if (!webview || historyNavigationPending) return;
  const canNavigate = direction === 'back' ? webview.canGoBack() : webview.canGoForward();
  if (!canNavigate) return;
  historyNavigationPending = true;
  prepareVerticalNavigation(slot, direction);
  beginPageLoading(slot);
  try {
    if (direction === 'back') webview.goBack();
    else webview.goForward();
  } finally {
    setTimeout(() => { historyNavigationPending = false; }, 260);
  }
}

function animateLiveSlotTransition(outgoing, incoming, direction) {
  const token = ++slotTransitionToken;
  resetSlotTransitionVisuals();
  outgoing.classList.add('active');
  incoming.classList.add('active');
  outgoing.style.zIndex = '1';
  incoming.style.zIndex = '2';
  outgoing.style.pointerEvents = 'none';
  incoming.style.pointerEvents = 'none';
  outgoing.style.willChange = 'transform';
  outgoing.style.backfaceVisibility = 'hidden';
  incoming.style.willChange = 'transform';
  incoming.style.backfaceVisibility = 'hidden';
  const travel = direction > 0 ? -1 : 1;
  const timing = { duration: SLOT_TRANSITION_DURATION, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' };
  const outgoingAnimation = outgoing.animate([
    { transform: 'translate3d(0, 0, 0)' },
    { transform: `translate3d(${travel * 100}%, 0, 0)` }
  ], timing);
  const incomingAnimation = incoming.animate([
    { transform: `translate3d(${-travel * 100}%, 0, 0)` },
    { transform: 'translate3d(0, 0, 0)' }
  ], timing);
  slotTransitionAnimations = [outgoingAnimation, incomingAnimation];
  Promise.allSettled(slotTransitionAnimations.map((animation) => animation.finished)).then(() => {
    if (token !== slotTransitionToken) return;
    resetSlotTransitionVisuals();
  });
}

function animateSnapshotTransition(outgoingSlot, incomingSlot, direction) {
  if (outgoingSlot.mediaPlaying || incomingSlot.mediaPlaying
      || !outgoingSlot.snapshotImage || !incomingSlot.snapshotImage) return false;
  const token = ++slotTransitionToken;
  resetSlotTransitionVisuals();
  const outgoing = outgoingSlot.snapshotImage.cloneNode(true);
  const incoming = incomingSlot.snapshotImage.cloneNode(true);
  outgoing.style.zIndex = '1';
  incoming.style.zIndex = '2';
  elements.transitionStage.replaceChildren(outgoing, incoming);
  elements.transitionStage.hidden = false;
  const travel = direction > 0 ? -1 : 1;
  const timing = {
    duration: SLOT_TRANSITION_DURATION,
    easing: 'cubic-bezier(.16, 1, .3, 1)',
    fill: 'both'
  };
  const outgoingAnimation = outgoing.animate([
    { transform: 'translate3d(0, 0, 0)' },
    { transform: `translate3d(${travel * 100}%, 0, 0)` }
  ], timing);
  const incomingAnimation = incoming.animate([
    { transform: `translate3d(${-travel * 100}%, 0, 0)` },
    { transform: 'translate3d(0, 0, 0)' }
  ], timing);
  slotTransitionAnimations = [outgoingAnimation, incomingAnimation];
  Promise.allSettled(slotTransitionAnimations.map((animation) => animation.finished)).then(() => {
    if (token !== slotTransitionToken) return;
    resetSlotTransitionVisuals();
  });
  return true;
}

function activateSlot(index, { hideAfter = true, transitionDirection = 0 } = {}) {
  cancelNewSlotEdgePreview();
  cancelLeftSlotWallBump();
  cancelRightSlotWallBump();
  const slot = slots[index];
  if (!slot.occupied) return openSlot(index, startPageUrl);
  const previousIndex = activeIndex;
  const outgoingSlot = slots[previousIndex];
  const outgoingWebview = outgoingSlot?.webview;
  if (editingIndex >= 0 && editingIndex !== index) editingIndex = -1;
  activeIndex = index;
  syncPageLoadingCover();
  const activeWebview = createWebview(slot);
  slot.startupMediaBlocked = false;
  try { activeWebview.setAudioMuted(false); } catch {}
  paintPageEdgeExtensions(slot);
  if (transitionDirection && outgoingWebview && outgoingWebview !== activeWebview) {
    if (!animateSnapshotTransition(outgoingSlot, slot, transitionDirection)) {
      animateLiveSlotTransition(outgoingWebview, activeWebview, transitionDirection);
    }
  } else {
    slotTransitionToken++;
    resetSlotTransitionVisuals();
  }
  try {
    window.focusSlots.setActiveGuest(activeWebview.getWebContentsId());
  } catch {}
  applySlotZoom(slot);
  renderSlots();
  renderUtilityButton();
  saveState();
  scheduleSlotSnapshotRefresh(slot, 900);
  if (hideAfter) scheduleChromeHide();
}

function cancelNewSlotEdgePreview() {
  clearTimeout(newSlotEdgeTimer);
  newSlotEdgeTimer = undefined;
  newSlotEdgeArmedAt = 0;
  document.body.classList.remove('new-slot-edge-preview');
  elements.newSlotEdge.setAttribute('aria-hidden', 'true');
  elements.newSlotEdge.tabIndex = -1;
}

function cancelLeftSlotWallBump() {
  clearTimeout(leftSlotWallTimer);
  leftSlotWallTimer = undefined;
  document.body.classList.remove('left-slot-wall-bump');
}

function cancelRightSlotWallBump() {
  clearTimeout(rightSlotWallTimer);
  rightSlotWallTimer = undefined;
  document.body.classList.remove('right-slot-wall-bump');
}

function bumpLeftSlotWall() {
  cancelNewSlotEdgePreview();
  cancelRightSlotWallBump();
  preparePageEdgeExtensions();
  clearTimeout(leftSlotWallTimer);
  document.body.classList.add('left-slot-wall-bump');
  lastSlotInteractionAt = performance.now();
  leftSlotWallTimer = setTimeout(cancelLeftSlotWallBump, 280);
}

function bumpRightSlotWall() {
  cancelNewSlotEdgePreview();
  cancelLeftSlotWallBump();
  preparePageEdgeExtensions();
  clearTimeout(rightSlotWallTimer);
  document.body.classList.add('right-slot-wall-bump');
  lastSlotInteractionAt = performance.now();
  rightSlotWallTimer = setTimeout(cancelRightSlotWallBump, 280);
}

function confirmNewSlotEdgePreview() {
  const empty = slots.find((slot) => !slot.occupied);
  if (!empty) {
    cancelNewSlotEdgePreview();
    return;
  }
  cancelNewSlotEdgePreview();
  lastSlotInteractionAt = performance.now();
  openSlot(empty.index, startPageUrl, { transitionDirection: 1 });
}

function armNewSlotEdgePreview() {
  cancelLeftSlotWallBump();
  cancelRightSlotWallBump();
  const empty = slots.find((slot) => !slot.occupied);
  if (!empty) {
    cancelNewSlotEdgePreview();
    return;
  }
  preparePageEdgeExtensions();
  const now = performance.now();
  if (newSlotEdgeArmedAt) {
    if (now - newSlotEdgeArmedAt >= 120) confirmNewSlotEdgePreview();
    return;
  }
  newSlotEdgeArmedAt = now;
  lastSlotInteractionAt = now;
  elements.newSlotEdge.setAttribute('aria-hidden', 'false');
  elements.newSlotEdge.tabIndex = 0;
  document.body.classList.add('new-slot-edge-preview');
  clearTimeout(newSlotEdgeTimer);
  newSlotEdgeTimer = setTimeout(cancelNewSlotEdgePreview, NEW_SLOT_CONFIRM_WINDOW);
}

function visuallyOrderedOccupiedSlots() {
  const slotsById = new Map(slots.map((slot) => [slot.id, slot]));
  const visualOrder = [...elements.slotRow.querySelectorAll('.slot[data-slot-id]')]
    .map((pill) => slotsById.get(pill.dataset.slotId))
    .filter((slot) => slot?.occupied);
  return visualOrder.length ? visualOrder : slots.filter((slot) => slot.occupied);
}

function cycleOccupiedSlot(direction) {
  // The rendered pill order is authoritative. This keeps Ctrl+wheel aligned
  // with a drag-reordered tab row even if a pending event retained an old index.
  const occupied = visuallyOrderedOccupiedSlots();
  if (!occupied.length) return;
  const activeSlot = slots[activeIndex];
  const current = Math.max(0, occupied.findIndex((slot) => slot === activeSlot || slot.id === activeSlot?.id));
  hideUtilityPanel();
  clearTimeout(hideTimer);
  elements.chrome.classList.remove('open');
  if (direction > 0 && current === occupied.length - 1) {
    if (slots.some((slot) => !slot.occupied)) armNewSlotEdgePreview();
    else bumpRightSlotWall();
    return;
  }
  if (direction < 0 && current === 0) {
    cancelNewSlotEdgePreview();
    bumpLeftSlotWall();
    return;
  }
  cancelNewSlotEdgePreview();
  const next = occupied[current + direction];
  if (next === undefined) return;
  lastSlotInteractionAt = performance.now();
  activateSlot(next.index, { transitionDirection: direction });
}

function openSlot(index, url = startPageUrl, { transitionDirection = 0 } = {}) {
  const slot = slots[index];
  const alreadyCreated = Boolean(slot.webview);
  slot.occupied = true;
  slot.title = url === startPageUrl ? 'Still' : 'Loading…';
  slot.url = url;
  slot.favicon = '';
  slot.dockFavicon = '';
  slot.focusStartInput = url === startPageUrl;
  beginPageLoading(slot);
  createWebview(slot);
  if (alreadyCreated) navigateSlot(slot, url);
  activateSlot(index, { transitionDirection });
  requestAnimationFrame(() => focusStartPageInput(slot));
}

function openInAvailableSlot(url, { edit = false, fallbackToCurrent = false } = {}) {
  const empty = slots.find((slot) => !slot.occupied);
  if (!empty) {
    if (fallbackToCurrent) {
      navigateSlot(slots[activeIndex], url);
      scheduleChromeHide();
      return;
    }
    showChrome();
    showToast('All five slots are in use. Close one before opening another page.');
    return;
  }
  openSlot(empty.index, url);
  if (edit) beginSlotEdit(empty.index);
}

function isHomeSlot(slot) {
  return slot.occupied && (!slot.url || slot.url === startPageUrl || slot.url.startsWith('file:'));
}

function hideSlotReplacementModal() {
  pendingExternalUrl = '';
  elements.replacementBackdrop.classList.remove('visible');
  setTimeout(() => {
    if (!elements.replacementBackdrop.classList.contains('visible')) elements.replacementBackdrop.hidden = true;
  }, 155);
}

function showSlotReplacementModal(url) {
  pendingExternalUrl = url;
  elements.replacementUrl.textContent = displayUrl(url);
  elements.replacementList.replaceChildren();
  slots.filter((slot) => slot.occupied).forEach((slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'replacement-slot';
    const icon = faviconElement(slot);
    icon.classList.add('replacement-favicon');
    const copy = document.createElement('span');
    copy.className = 'replacement-copy';
    const title = document.createElement('strong');
    title.textContent = slot.title || 'Untitled';
    const address = document.createElement('span');
    address.textContent = displayUrl(slot.url || startPageUrl);
    copy.append(title, address);
    const replace = document.createElement('span');
    replace.className = 'replacement-action';
    replace.textContent = 'Replace';
    button.append(icon, copy, replace);
    button.addEventListener('click', () => {
      const target = pendingExternalUrl;
      hideSlotReplacementModal();
      if (!target) return;
      const direction = Math.sign(slot.index - activeIndex);
      navigateSlot(slot, target);
      activateSlot(slot.index, { transitionDirection: direction });
    });
    elements.replacementList.append(button);
  });
  elements.replacementBackdrop.hidden = false;
  requestAnimationFrame(() => elements.replacementBackdrop.classList.add('visible'));
}

function openExternalUrl(url) {
  const empty = slots.find((slot) => !slot.occupied);
  if (empty) {
    openSlot(empty.index, url, { transitionDirection: Math.sign(empty.index - activeIndex) });
    return;
  }
  const home = slots.find(isHomeSlot);
  if (home) {
    const direction = Math.sign(home.index - activeIndex);
    navigateSlot(home, url);
    activateSlot(home.index, { transitionDirection: direction });
    return;
  }
  showSlotReplacementModal(url);
}

function openMiddleClickedLink(url) {
  if (!/^https?:\/\//i.test(url)) return;
  openExternalUrl(url);
}

function closeSlot(index) {
  const slot = slots[index];
  clearTimeout(slot.snapshotRefreshTimer);
  clearTimeout(slot.loadingCoverTimer);
  slot.snapshotRefreshTimer = null;
  slot.loadingCoverTimer = null;
  const wasActive = activeIndex === index;
  if (editingIndex === index) editingIndex = -1;
  slot.webview?.remove();
  slot.webview = null;
  slot.occupied = false;
  slot.title = '';
  slot.url = '';
  slot.favicon = '';
  slot.ready = false;
  slot.loading = false;
  slot.pendingUrl = '';
  slot.snapshot = '';
  slot.snapshotImage = null;
  slot.snapshotGeneration++;
  slot.mediaPlaying = false;
  slot.zoomFactor = 1;

  if (!slots.some((item) => item.occupied)) {
    slots[0].occupied = true;
    slots[0].title = 'Still';
  }
  const fallback = wasActive || !slots[activeIndex].occupied
    ? slots.find((item) => item.occupied)
    : slots[activeIndex];
  compactSlotOrder(fallback);
  if (wasActive) {
    activateSlot(activeIndex, { hideAfter: false });
  } else {
    renderSlots();
    saveState();
  }
}

function cycleTheme() {
  const themes = ['system', 'light', 'dark'];
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  window.focusSlots.setTheme(theme);
  renderUtilityButton();
  showToast(`Theme: ${theme}`);
}

async function hardReloadSlot(slot = slots[activeIndex]) {
  const webview = slot?.webview;
  if (!webview) return;
  let handled = false;
  try {
    handled = await window.focusSlots.hardReload(webview.getWebContentsId());
  } catch {}
  if (!handled && webview.isConnected) webview.reloadIgnoringCache();
}

function runShortcut(shortcut) {
  const webview = slots[activeIndex].webview;
  if (shortcut === 'location') beginSlotEdit(activeIndex);
  else if (shortcut === 'browser-settings') {
    showChrome();
    utilityMode = 'browser';
    localStorage.setItem('still-utility-mode', utilityMode);
    renderUtilityButton();
    renderUtilityPanel('browser', true);
  }
  else if (shortcut === 'new-slot') openInAvailableSlot(startPageUrl);
  else if (shortcut === 'open-learn') openInAvailableSlot(learnPageUrl, { fallbackToCurrent: true });
  else if (shortcut === 'close-slot') closeSlot(activeIndex);
  else if (shortcut === 'back') navigateHistory('back');
  else if (shortcut === 'forward') navigateHistory('forward');
  else if (shortcut === 'hard-reload') hardReloadSlot();
  else if (shortcut === 'reload') webview.reload();
  else if (shortcut === 'zoom-in') changePageZoom(1);
  else if (shortcut === 'zoom-out') changePageZoom(-1);
  else if (shortcut === 'zoom-reset') changePageZoom(0);
  else if (shortcut === 'slot-previous') cycleOccupiedSlot(-1);
  else if (shortcut === 'slot-next') cycleOccupiedSlot(1);
  else if (shortcut === 'tab-dock-previous') moveTabDockSelection(-1);
  else if (shortcut === 'tab-dock-next') moveTabDockSelection(1);
  else if (shortcut === 'tab-dock-show') showTabDock();
  else if (shortcut === 'tab-dock-release') releaseTabDockSelection();
  else if (/^slot-[1-5]$/.test(shortcut)) activateSlot(Number(shortcut.at(-1)) - 1);
}

async function initialize() {
  const bootstrap = await window.focusSlots.bootstrap();
  startPageUrl = bootstrap.startPageUrl;
  editorPageUrl = bootstrap.editorPageUrl;
  learnPageUrl = bootstrap.learnPageUrl;
  if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(bootstrap.searchBaseUrl)) searchBaseUrl = bootstrap.searchBaseUrl;
  importedBookmarks = bootstrap.bookmarks || [];
  importedHistory = bootstrap.history || [];
  downloads = bootstrap.downloads || [];
  if (!bootstrap.searchAvailable) showToast('Still Search is unavailable. Reinstall Still to restore private search.', 7000);
  if (bootstrap.updateAvailable) showUpdateReady(bootstrap.updatePath);
  if (bootstrap.updateFailed) showToast('The last update failed; Still restored the previous build. The details are in still-update-last.log.', 15000);
  loadRecentHistory();
  loadCustomBookmarks();
  rebuildBrowsingHistory();
  theme = bootstrap.theme || 'system';
  const savedDockSlideEnabled = localStorage.getItem('still-tab-dock-slide-enabled');
  tabDockSlideEnabled = savedDockSlideEnabled === null ? true : savedDockSlideEnabled === 'true';
  const savedUtilityMode = localStorage.getItem('still-utility-mode');
  utilityMode = utilityModes.includes(savedUtilityMode) ? savedUtilityMode : 'bookmarks';
  renderUtilityButton();
  restoreState();
  slots[activeIndex].startupMediaBlocked = false;
  // Keep every saved slot, but restore only the visible page into Chromium.
  // Inactive slots are created on first activation; loading five video-heavy
  // sites at startup was consuming roughly 2 GB and made the whole desktop lag.
  createWebview(slots[activeIndex]);
  activateSlot(activeIndex, { hideAfter: false });
  setTimeout(() => warmSlotSnapshots(), 2600);

  const extensionReport = bootstrap.importReport?.extensions;
  const disabledCount = extensionReport?.disabled?.length || 0;
  const reportKey = extensionReport ? `${extensionReport.loaded.length}:${disabledCount}:${extensionReport.failed.length}` : '';
  if (extensionReport?.discovered && localStorage.getItem('extension-report-seen') !== reportKey) {
    localStorage.setItem('extension-report-seen', reportKey);
    const details = [];
    if (disabledCount) details.push(`${extensionReport.disabled.map((item) => item.name).join(', ')} disabled`);
    if (extensionReport.failed.length) details.push(`${extensionReport.failed.length} incompatible`);
    const suffix = details.length ? `; ${details.join('; ')}` : '';
    showToast(`Loaded ${extensionReport.loaded.length} Opera GX extensions${suffix}.`, 6000);
  }
}

elements.chrome.addEventListener('mouseenter', () => clearTimeout(hideTimer));
elements.chrome.addEventListener('mouseleave', scheduleChromeHide);
elements.newSlotEdge.addEventListener('click', confirmNewSlotEdgePreview);
elements.utilityButton.addEventListener('click', runUtilityAction);
elements.toastClose.addEventListener('click', hideToast);
elements.utilityButton.addEventListener('wheel', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const now = Date.now();
  if (now - lastUtilityWheelAt < 95 || !event.deltaY) return;
  lastUtilityWheelAt = now;
  changeUtilityMode(event.deltaY > 0 ? 1 : -1);
}, { passive: false });
elements.permissionAllow.addEventListener('click', () => answerPermissionRequest('allow'));
elements.permissionBlock.addEventListener('click', () => answerPermissionRequest('block'));
document.querySelector('#minimize').addEventListener('click', () => window.focusSlots.windowAction('minimize'));
document.querySelector('#maximize').addEventListener('click', () => window.focusSlots.windowAction('maximize'));
document.querySelector('#close-window').addEventListener('click', () => window.focusSlots.windowAction('close'));
window.focusSlots.onNewWindow((details) => {
  const url = typeof details === 'string' ? details : details?.url;
  if (/^https?:\/\//i.test(url)) openInAvailableSlot(url);
});
window.focusSlots.onMiddleClick(openMiddleClickedLink);
window.focusSlots.onShortcut(runShortcut);
window.focusSlots.onChromeShow(showChrome);
window.focusSlots.onChromeHide(requestChromeHide);
window.focusSlots.onDownloadsChanged((nextDownloads) => {
  downloads = Array.isArray(nextDownloads) ? nextDownloads : [];
  if (!elements.utilityPanel.hidden && elements.utilityPanel.dataset.mode === 'downloads') {
    renderUtilityPanel('downloads', true);
  }
});
window.focusSlots.onPermissionRequest(enqueuePermissionRequest);
window.focusSlots.onPermissionChanged((details) => {
  if (details?.requestId && activePermissionRequest?.id === details.requestId) {
    activePermissionRequest = null;
    closePermissionPrompt();
  } else if (details?.requestId) {
    const queuedIndex = permissionRequestQueue.findIndex((request) => request.id === details.requestId);
    if (queuedIndex >= 0) permissionRequestQueue.splice(queuedIndex, 1);
  }
  if (!elements.utilityPanel.hidden && elements.utilityPanel.dataset.mode === 'permissions') {
    renderUtilityPanel('permissions', true);
  }
});
window.focusSlots.onPermissionActivity((activity) => {
  const guestId = Number(activity?.guestId);
  if (!Number.isFinite(guestId)) return;
  if (activity.microphone || activity.camera || activity.location) permissionActivityByGuest.set(guestId, activity);
  else permissionActivityByGuest.delete(guestId);
  renderSlots();
  if (!elements.utilityPanel.hidden && elements.utilityPanel.dataset.mode === 'permissions') {
    renderUtilityPanel('permissions', true);
  }
});
window.focusSlots.onOpenUrl((url) => {
  if (/^https?:\/\//i.test(url)) openExternalUrl(url);
});
window.focusSlots.onUpdateReady(showUpdateReady);

elements.replacementCancel.addEventListener('click', hideSlotReplacementModal);
elements.replacementBackdrop.addEventListener('pointerdown', (event) => {
  if (event.target === elements.replacementBackdrop) hideSlotReplacementModal();
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#utility-button, #utility-panel')) hideUtilityPanel();
});

document.addEventListener('wheel', (event) => {
  if (event.target.closest('#utility-button')) return;
  if (event.metaKey) return;
  if (event.altKey && event.ctrlKey) {
    event.preventDefault();
    if (event.deltaY) moveTabDockSelection(event.deltaY > 0 ? 1 : -1);
    return;
  }
  if (event.ctrlKey && !event.altKey) {
    event.preventDefault();
    if (event.deltaY) cycleOccupiedSlot(event.deltaY > 0 ? 1 : -1);
    return;
  }
}, { passive: false });

document.addEventListener('keyup', (event) => {
  if (event.key === 'Alt' || event.key === 'Control') releaseTabDockSelection();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activePermissionRequest) {
    event.preventDefault();
    answerPermissionRequest('dismiss');
    return;
  }
  if (!event.metaKey && !event.shiftKey &&
      ((event.key === 'Alt' && event.ctrlKey) || (event.key === 'Control' && event.altKey))) showTabDock();
});

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && ['+', '=', 'add'].includes(key)) {
    event.preventDefault();
    changePageZoom(1);
  } else if (event.ctrlKey && !event.altKey && ['-', 'subtract'].includes(key)) {
    event.preventDefault();
    changePageZoom(-1);
  } else if (event.ctrlKey && !event.altKey && key === '0') {
    event.preventDefault();
    changePageZoom(0);
  } else if (event.ctrlKey && key === 'l') {
    event.preventDefault();
    beginSlotEdit(activeIndex);
  } else if (event.ctrlKey && key === 't') {
    event.preventDefault();
    openInAvailableSlot(startPageUrl);
  } else if (event.ctrlKey && key === 'w') {
    event.preventDefault();
    closeSlot(activeIndex);
  } else if (event.ctrlKey && event.shiftKey && key === 'r') {
    event.preventDefault();
    hardReloadSlot();
  } else if (event.ctrlKey && key === 'r') {
    event.preventDefault();
    slots[activeIndex].webview.reload();
  } else if (event.ctrlKey && /^[1-5]$/.test(event.key)) {
    event.preventDefault();
    activateSlot(Number(event.key) - 1);
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    if (slots[activeIndex].webview.canGoBack()) slots[activeIndex].webview.goBack();
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    if (slots[activeIndex].webview.canGoForward()) slots[activeIndex].webview.goForward();
  } else if (event.key === 'F5') {
    event.preventDefault();
    slots[activeIndex].webview.reload();
  } else if (event.key === 'Escape') {
    hideTabDock(true);
    if (!elements.replacementBackdrop.hidden) {
      hideSlotReplacementModal();
      return;
    }
    cancelNewSlotEdgePreview();
    cancelLeftSlotWallBump();
    cancelRightSlotWallBump();
    editingIndex = -1;
    renderSlots();
    document.activeElement?.blur();
    scheduleChromeHide();
  }
});

document.addEventListener('selectstart', (event) => {
  if (!event.target.closest('input')) event.preventDefault();
});

window.addEventListener('focus', () => {
  showChrome();
  scheduleChromeHide();
});

window.addEventListener('resize', () => {
  clearTimeout(snapshotResizeTimer);
  slotTransitionToken++;
  resetSlotTransitionVisuals();
  slots.forEach((slot) => {
    clearTimeout(slot.snapshotRefreshTimer);
    slot.snapshotRefreshTimer = null;
    slot.snapshot = '';
    slot.snapshotImage = null;
    slot.snapshotGeneration++;
  });
  snapshotResizeTimer = setTimeout(() => {
    const slot = slots[activeIndex];
    if (slot?.occupied && !slot.mediaPlaying) scheduleSlotSnapshotRefresh(slot, 350);
  }, 420);
});

window.addEventListener('beforeunload', saveState);

initialize().catch((error) => showToast(`Still could not start: ${error.message}`));
