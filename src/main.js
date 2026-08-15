const { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, promises: fsPromises } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { prepareOperaImport, readImportedBookmarks } = require('./migrate-opera');
const { importOperaCookies } = require('./import-opera-cookies');
const { repairGoogleSession } = require('./repair-google-session');
const { prepareOperaExtensions, loadOperaExtensions } = require('./import-opera-extensions');
const { prepareOperaHistory } = require('./import-opera-history');
const { registerYouTubeDownloader } = require('./youtube-downloader');
const { createDownloadManager } = require('./download-manager');
const { openDefaultBrowserSettings, registerStillBrowser } = require('./default-browser');

const mouseNavigationTestMode = process.env.FOCUS_SLOTS_MOUSE_TEST === '1';
// A restored document must receive a fresh user gesture before Chromium may autoplay media.
app.commandLine.appendSwitch('autoplay-policy', 'document-user-activation-required');
const startPagePath = path.join(__dirname, 'start.html');
const startPageUrl = pathToFileURL(startPagePath).href;
const youtubeUiScript = readFileSync(path.join(__dirname, 'youtube-ui.js'), 'utf8');
// Windows keeps the original profile location so the rename never loses cookies,
// extensions, or saved slots. Other platforms use a conventional Still profile.
const userDataPath = path.join(app.getPath('appData'), process.platform === 'win32' ? 'Focus Slots' : 'Still');
app.setPath('userData', userDataPath);
app.setName('Still');
// v2 deliberately refreshes Windows' cached taskbar identity after the icon gained transparency.
if (process.platform === 'win32') app.setAppUserModelId('com.tim.still.v2');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow;
let importReport;
let topEdgePoll;
let importedHistory = [];
let importedBookmarks = [];
let startSuggestionHistory = [];
let runtimeSuggestionHistory = [];
let topChromeShown = false;
let lastMouseNavigation = { direction: '', source: '', time: 0 };
let activeGuestId = 0;
let mouseNavigationHelper;
let downloadManager;
let pendingExternalUrl = findExternalUrl(process.argv);
let lastModifierWheel = { kind: '', direction: 0, source: '', time: 0 };
let lastExternalApplicationRequest = { url: '', time: 0 };
const guestContentsById = new Map();
const faviconUpscaleJobs = new Map();
const faviconCachePath = path.join(userDataPath, 'favicon-cache-v1');
const permissionPreferencesPath = path.join(userDataPath, 'site-permissions-v1.json');
const permissionKinds = ['microphone', 'camera', 'location', 'notifications'];
const pendingPermissionRequests = new Map();
const permissionActivityByGuest = new Map();
let permissionRequestSequence = 0;
let permissionPreferences = loadPermissionPreferences();
let permissionWriteQueue = Promise.resolve();

function loadPermissionPreferences() {
  try {
    const stored = JSON.parse(readFileSync(permissionPreferencesPath, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const sanitized = {};
    for (const [origin, choices] of Object.entries(stored)) {
      if (!/^https?:\/\//i.test(origin) || !choices || typeof choices !== 'object') continue;
      const validChoices = {};
      for (const kind of permissionKinds) {
        if (choices[kind] === 'allow' || choices[kind] === 'block') validChoices[kind] = choices[kind];
      }
      if (Object.keys(validChoices).length) sanitized[origin] = validChoices;
    }
    return sanitized;
  } catch {
    return {};
  }
}

function savePermissionPreferences() {
  const serialized = JSON.stringify(permissionPreferences, null, 2);
  permissionWriteQueue = permissionWriteQueue.then(async () => {
    await fsPromises.mkdir(path.dirname(permissionPreferencesPath), { recursive: true });
    const temporaryPath = `${permissionPreferencesPath}.tmp`;
    await fsPromises.writeFile(temporaryPath, serialized, 'utf8');
    await fsPromises.rename(temporaryPath, permissionPreferencesPath);
  }).catch((error) => console.error('Could not save Still site permissions:', error));
}

function normalizedWebOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

function permissionOrigin(webContents, requestingOrigin, details = {}) {
  return normalizedWebOrigin(details.securityOrigin)
    || normalizedWebOrigin(requestingOrigin)
    || normalizedWebOrigin(details.requestingUrl)
    || normalizedWebOrigin(webContents?.getURL());
}

function permissionKeys(permission, details = {}) {
  if (permission === 'media') {
    const mediaTypes = Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : (details.mediaType ? [details.mediaType] : []);
    const keys = [];
    if (mediaTypes.includes('audio')) keys.push('microphone');
    if (mediaTypes.includes('video')) keys.push('camera');
    return [...new Set(keys)];
  }
  if (permission === 'geolocation') return ['location'];
  if (permission === 'notifications') return ['notifications'];
  return [];
}

function permissionSnapshot(urlOrOrigin) {
  const origin = normalizedWebOrigin(urlOrOrigin);
  const choices = origin ? permissionPreferences[origin] || {} : {};
  let hostname = '';
  try { hostname = new URL(origin).hostname.replace(/^www\./, ''); } catch { }
  return {
    origin,
    hostname,
    states: Object.fromEntries(permissionKinds.map((kind) => [kind, choices[kind] || 'ask']))
  };
}

function setPermissionChoices(origin, kinds, decision) {
  if (!origin || !kinds.length || !['allow', 'block'].includes(decision)) return;
  permissionPreferences[origin] ||= {};
  kinds.forEach((kind) => {
    if (permissionKinds.includes(kind)) permissionPreferences[origin][kind] = decision;
  });
  savePermissionPreferences();
}

function finishPermissionRequest(id, decision = 'dismiss') {
  const pending = pendingPermissionRequests.get(id);
  if (!pending) return;
  pendingPermissionRequests.delete(id);
  clearTimeout(pending.timeout);
  pending.webContents.removeListener('destroyed', pending.onDestroyed);
  if (decision === 'allow' || decision === 'block') {
    setPermissionChoices(pending.origin, pending.undecidedKinds, decision);
  }
  pending.callback(decision === 'allow');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('permissions:changed', {
      ...permissionSnapshot(pending.origin),
      requestId: id,
      decision,
      requestedKinds: pending.requestedKinds
    });
  }
}

function requestSitePermission(webContents, permission, callback, details = {}) {
  if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') {
    callback(true);
    return;
  }

  const requestedKinds = permissionKeys(permission, details);
  const origin = permissionOrigin(webContents, '', details);
  if (!origin || !requestedKinds.length) {
    callback(false);
    return;
  }

  const choices = permissionPreferences[origin] || {};
  if (requestedKinds.some((kind) => choices[kind] === 'block')) {
    callback(false);
    return;
  }
  const undecidedKinds = requestedKinds.filter((kind) => choices[kind] !== 'allow');
  if (!undecidedKinds.length) {
    callback(true);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
    callback(false);
    return;
  }

  const id = `permission-${Date.now()}-${++permissionRequestSequence}`;
  const onDestroyed = () => finishPermissionRequest(id, 'dismiss');
  const timeout = setTimeout(() => finishPermissionRequest(id, 'dismiss'), 60000);
  pendingPermissionRequests.set(id, {
    callback,
    webContents,
    origin,
    requestedKinds,
    undecidedKinds,
    onDestroyed,
    timeout
  });
  webContents.once('destroyed', onDestroyed);
  mainWindow.webContents.send('permissions:request', {
    id,
    origin,
    hostname: new URL(origin).hostname.replace(/^www\./, ''),
    kinds: undecidedKinds
  });
}

function clearPermissionActivity(guestId) {
  permissionActivityByGuest.delete(guestId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('permissions:activity', {
      guestId,
      origin: '',
      microphone: false,
      camera: false,
      location: false
    });
  }
}

function publishPermissionActivity(guestId) {
  const frames = permissionActivityByGuest.get(guestId);
  const states = frames ? [...frames.values()] : [];
  const active = {
    guestId,
    origin: states.find((state) => state.origin)?.origin || '',
    microphone: states.some((state) => state.microphone),
    camera: states.some((state) => state.camera),
    location: states.some((state) => state.location)
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('permissions:activity', active);
}

async function readFaviconBytes(source) {
  if (source.startsWith('data:image/')) {
    const comma = source.indexOf(',');
    if (comma < 0) throw new Error('Invalid favicon data URL.');
    const metadata = source.slice(0, comma);
    const payload = source.slice(comma + 1);
    const bytes = metadata.includes(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload));
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Favicon is unexpectedly large.');
    return bytes;
  }
  if (!/^https?:\/\//i.test(source)) throw new Error('Unsupported favicon source.');
  const response = await session.fromPartition('persist:focus').fetch(source, {
    credentials: 'include',
    signal: AbortSignal.timeout(4500)
  });
  if (!response.ok) throw new Error(`Favicon returned ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Favicon is unexpectedly large.');
  return bytes;
}

function faviconCacheFile(source) {
  const cacheKey = createHash('sha256').update(`canvas-v2:${source}`).digest('hex');
  return path.join(faviconCachePath, `${cacheKey}.png`);
}

function faviconMimeType(bytes, source) {
  const declared = source.match(/^data:(image\/[a-z0-9.+-]+)/i)?.[1];
  if (declared) return declared;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon';
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  return 'application/octet-stream';
}

async function prepareFaviconForRenderer(source) {
  if (!source || source.length > 200000) return { dataUrl: '', cached: false };
  const cacheFile = faviconCacheFile(source);
  try {
    const cached = await fsPromises.readFile(cacheFile);
    return { dataUrl: `data:image/png;base64,${cached.toString('base64')}`, cached: true };
  } catch { }

  const bytes = await readFaviconBytes(source);
  return {
    dataUrl: `data:${faviconMimeType(bytes, source)};base64,${bytes.toString('base64')}`,
    cached: false
  };
}

async function storeUpscaledFavicon(source, dataUrl) {
  if (!source || source.length > 200000 || !/^data:image\/png;base64,/i.test(dataUrl)) return '';
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.length || png.length > 1024 * 1024 || !png.subarray(0, 8).equals(pngSignature)) return '';
  await fsPromises.mkdir(faviconCachePath, { recursive: true });
  await fsPromises.writeFile(faviconCacheFile(source), png);
  return dataUrl;
}

function findExternalUrl(argumentsList) {
  return argumentsList.find((value) => /^https?:\/\//i.test(String(value || ''))) || '';
}

function openExternalUrl(url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
    pendingExternalUrl = url;
    return;
  }
  mainWindow.webContents.send('app:open-url', url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function externalApplicationUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const blockedProtocols = new Set([
      'http:', 'https:', 'file:', 'about:', 'blob:', 'data:', 'javascript:',
      'chrome:', 'chrome-extension:', 'devtools:'
    ]);
    if (blockedProtocols.has(parsed.protocol.toLowerCase())) return '';
    return /^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function requestExternalApplication(url) {
  const target = externalApplicationUrl(url);
  if (!target || !mainWindow || mainWindow.isDestroyed()) return false;
  const now = Date.now();
  if (lastExternalApplicationRequest.url === target && now - lastExternalApplicationRequest.time < 1200) return true;
  lastExternalApplicationRequest = { url: target, time: now };

  dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Cancel', 'Open application'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Open external application?',
    message: 'This link wants to open another application.',
    detail: target.length > 700 ? `${target.slice(0, 697)}...` : target
  }).then(({ response }) => {
    if (response !== 1) return;
    shell.openExternal(target).catch((error) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        buttons: ['OK'],
        title: 'Application could not be opened',
        message: 'Your system could not find an application for this link.',
        detail: error.message
      });
    });
  }).catch(() => {});
  return true;
}

function isYouTubePage(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function injectYouTubeUi(guest) {
  if (guest.isDestroyed() || !isYouTubePage(guest.getURL())) return;
  guest.executeJavaScript(youtubeUiScript, true).catch(() => {});
}

function suggestionLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function rankedStartSuggestions(value, limit = 5) {
  const query = String(value || '').trim().toLocaleLowerCase();
  if (!query || /^https?:\/\//i.test(query)) return [];
  const tokens = query.split(/\s+/).filter(Boolean);
  const matches = [];
  const siteMatches = new Map();

  const history = runtimeSuggestionHistory.length ? runtimeSuggestionHistory : startSuggestionHistory;
  history.forEach((entry, index) => {
    try {
      const parsed = new URL(entry.url);
      const host = parsed.hostname.replace(/^www\./, '').toLocaleLowerCase();
      const hostStem = host.split('.')[0];
      const title = (entry.title || entry.name || '').toLocaleLowerCase();
      const url = entry.url.toLocaleLowerCase();
      if (!tokens.every((token) => `${host} ${title} ${url}`.includes(token))) return;

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
      matches.push({ url: entry.url, title: entry.title || entry.name || '', score, label: suggestionLabel(entry.url) });
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

function isTrustedStartSender(event) {
  try {
    return path.normalize(fileURLToPath(event.senderFrame.url)) === path.normalize(startPagePath);
  } catch {
    return false;
  }
}

function sendMouseNavigation(direction, source = 'unknown') {
  const now = Date.now();
  const duplicateFromAnotherSource = lastMouseNavigation.direction === direction
    && lastMouseNavigation.source !== source
    && now - lastMouseNavigation.time < 400;
  const switchBounce = lastMouseNavigation.direction === direction
    && lastMouseNavigation.source === source
    && now - lastMouseNavigation.time < 70;
  if (duplicateFromAnotherSource || switchBounce) return;
  lastMouseNavigation = { direction, source, time: now };
  const guest = guestContentsById.get(activeGuestId);
  if (!guest || guest.isDestroyed()) return;
  const history = guest.navigationHistory;
  if (direction === 'back' && history.canGoBack()) history.goBack();
  if (direction === 'forward' && history.canGoForward()) history.goForward();
}

function handleModifierWheel(kind, direction, source) {
  const now = Date.now();
  const sameGesture = lastModifierWheel.kind === kind
    && lastModifierWheel.direction === direction
    && ((lastModifierWheel.source !== source && now - lastModifierWheel.time < 150)
      || (lastModifierWheel.source === source && now - lastModifierWheel.time < 52));
  if (sameGesture) return;
  lastModifierWheel = { kind, direction, source, time: now };
  if (kind === 'slots' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:shortcut', direction < 0 ? 'slot-previous' : 'slot-next');
  } else if (kind === 'tab-dock' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:shortcut', direction < 0 ? 'tab-dock-previous' : 'tab-dock-next');
  }
}

function stopMouseNavigationHelper() {
  if (!mouseNavigationHelper) return;
  mouseNavigationHelper.kill();
  mouseNavigationHelper = null;
}

function startMouseNavigationHelper() {
  if (process.platform !== 'win32') return;
  stopMouseNavigationHelper();
  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, 'mouse-navigation-helper.exe')
    : path.join(__dirname, '..', 'build', 'mouse-helper', 'mouse-navigation-helper.exe');
  if (!existsSync(helperPath)) return;

  const helper = spawn(helperPath, [String(process.pid)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  mouseNavigationHelper = helper;
  const lines = readline.createInterface({ input: helper.stdout });
  lines.on('line', (line) => {
    const direction = line.trim();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isFocused() && !mouseNavigationTestMode) return;
    if (direction === 'back' || direction === 'forward') {
      sendMouseNavigation(direction, 'raw-helper');
    } else if (/^ctrl-alt-wheel:-?1$/.test(direction)) {
      handleModifierWheel('tab-dock', Number(direction.split(':')[1]), 'raw-helper');
    } else if (/^ctrl-wheel:-?1$/.test(direction)) {
      handleModifierWheel('slots', Number(direction.split(':')[1]), 'raw-helper');
    }
  });
  helper.once('exit', () => {
    lines.close();
    if (mouseNavigationHelper === helper) mouseNavigationHelper = null;
  });
  helper.once('error', () => {
    if (mouseNavigationHelper === helper) mouseNavigationHelper = null;
  });
}

function startTopEdgeTracking() {
  clearInterval(topEdgePoll);
  topEdgePoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      if (topChromeShown) mainWindow.webContents.send('chrome:hide');
      topChromeShown = false;
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const insideWidth = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width;
    const distanceFromTop = cursor.y - bounds.y;
    const insideRevealArea = distanceFromTop >= -2 && distanceFromTop <= (topChromeShown ? 72 : 14);
    if (insideWidth && insideRevealArea) {
      if (topChromeShown) return;
      topChromeShown = true;
      const cursorRatio = Math.max(0, Math.min(1, (cursor.x - bounds.x) / bounds.width));
      mainWindow.webContents.send('chrome:show', cursorRatio);
    } else if (topChromeShown) {
      topChromeShown = false;
      mainWindow.webContents.send('chrome:hide');
    }
  }, 40);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 560,
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101112' : '#f5f5f3',
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    if (!pendingExternalUrl) return;
    const url = pendingExternalUrl;
    pendingExternalUrl = '';
    openExternalUrl(url);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  startTopEdgeTracking();

  mainWindow.on('app-command', (_event, command) => {
    if (command === 'browser-backward') sendMouseNavigation('back', 'app-command');
    if (command === 'browser-forward') sendMouseNavigation('forward', 'app-command');
  });

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
  });

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('preload-error', (_preloadEvent, preloadPath, error) => {
      console.error(`Guest preload failed (${preloadPath}):`, error);
    });
    guestContentsById.set(guest.id, guest);
    guest.once('destroyed', () => {
      clearPermissionActivity(guest.id);
      guestContentsById.delete(guest.id);
      if (activeGuestId === guest.id) activeGuestId = 0;
    });
    guest.on('did-start-navigation', (_navigationEvent, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) clearPermissionActivity(guest.id);
    });
    const redirectToExternalApplication = (event, legacyUrl) => {
      const url = event?.url || legacyUrl || '';
      if (!externalApplicationUrl(url)) return;
      event.preventDefault();
      requestExternalApplication(url);
    };
    // Sites such as Discord may use a hidden iframe to launch their desktop app.
    // `will-navigate` only covers the main frame, while this event covers both.
    guest.on('will-frame-navigate', redirectToExternalApplication);
    guest.on('will-navigate', redirectToExternalApplication);
    guest.on('will-redirect', redirectToExternalApplication);
    guest.on('render-process-gone', (_goneEvent, details) => {
      let failedUrl = '';
      try { failedUrl = guest.getURL(); } catch {}
      console.error(`Guest renderer stopped (${details.reason}, ${details.exitCode}): ${failedUrl}`);
    });
    guest.on('dom-ready', () => {
      injectYouTubeUi(guest);
      for (const delay of [500, 1500, 3000]) setTimeout(() => injectYouTubeUi(guest), delay);
    });
    guest.on('did-navigate-in-page', () => setTimeout(() => injectYouTubeUi(guest), 180));
    let hoveredLinkUrl = '';
    let middleClickTarget = '';
    let lastAltWheelAt = 0;

    guest.on('update-target-url', (_targetEvent, url) => {
      hoveredLinkUrl = /^https?:\/\//i.test(url) ? url : '';
    });

    guest.on('before-mouse-event', (event, mouse) => {
      const modifiers = mouse.modifiers || [];
      const windowsDown = modifiers.some((modifier) => modifier === 'meta' || modifier === 'command' || modifier === 'super');
      const altDown = modifiers.includes('alt');
      const controlDown = modifiers.includes('control') || modifiers.includes('ctrl');
      if (mouse.type === 'mouseWheel' && !windowsDown && controlDown) {
        event.preventDefault();
        const now = Date.now();
        if (now - lastAltWheelAt < 85) return;
        const delta = Number(mouse.deltaY || mouse.wheelTicksY || 0);
        if (!delta) return;
        lastAltWheelAt = now;
        handleModifierWheel(altDown ? 'tab-dock' : 'slots', delta > 0 ? -1 : 1, 'electron');
        return;
      }
      if (mouse.button !== 'middle') return;
      if (mouse.type === 'mouseDown' && hoveredLinkUrl) {
        middleClickTarget = hoveredLinkUrl;
        event.preventDefault();
        mainWindow.webContents.send('slot:middle-click', middleClickTarget);
      } else if (mouse.type === 'mouseUp' && middleClickTarget) {
        event.preventDefault();
        middleClickTarget = '';
      }
    });

    guest.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//i.test(url)) {
        mainWindow.webContents.send('slot:new-window', { url, disposition });
      } else {
        requestExternalApplication(url);
      }
      return { action: 'deny' };
    });

    guest.on('before-input-event', (event, input) => {
      const inputKey = input.key.toLowerCase();
      if ((input.type === 'keyDown' || input.type === 'rawKeyDown') && !input.meta && !input.shift
          && ((inputKey === 'alt' && input.control) || (inputKey === 'control' && input.alt))) {
        mainWindow.webContents.send('app:shortcut', 'tab-dock-show');
      }
      if ((input.type === 'keyUp' || input.type === 'rawKeyUp') && (inputKey === 'alt' || inputKey === 'control')) {
        mainWindow.webContents.send('app:shortcut', 'tab-dock-release');
        return;
      }
      if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return;
      const key = inputKey;
      let shortcut = '';
      if (input.control && key === 'l') shortcut = 'location';
      else if (input.control && key === 't') shortcut = 'new-slot';
      else if (input.control && key === 'w') shortcut = 'close-slot';
      else if (input.control && input.shift && key === 'r') shortcut = 'hard-reload';
      else if ((input.control && key === 'r') || key === 'f5') shortcut = 'reload';
      else if (input.control && /^[1-5]$/.test(key)) shortcut = `slot-${key}`;
      else if (input.alt && key === 'arrowleft') shortcut = 'back';
      else if (input.alt && key === 'arrowright') shortcut = 'forward';
      if (!shortcut) return;
      event.preventDefault();
      mainWindow.webContents.send('app:shortcut', shortcut);
    });
  });

  mainWindow.on('closed', () => {
    for (const id of [...pendingPermissionRequests.keys()]) finishPermissionRequest(id, 'dismiss');
    clearInterval(topEdgePoll);
    topChromeShown = false;
    activeGuestId = 0;
    guestContentsById.clear();
    mainWindow = null;
  });
}

function configureBrowsingSession() {
  const browsingSession = session.fromPartition('persist:focus');
  // Google rejects or degrades embedded-browser identifiers. Advertise the
  // Chromium engine itself, while keeping the real engine/version intact.
  const chromiumUserAgent = app.userAgentFallback
    .replace(/\s(?:Electron|Still)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  browsingSession.setUserAgent(chromiumUserAgent);
  downloadManager = createDownloadManager({ browsingSession, userDataPath, getWindow: () => mainWindow });
  browsingSession.registerPreloadScript({
    type: 'frame',
    id: 'still-guest-ui',
    filePath: path.join(__dirname, 'start-preload.js')
  });
  browsingSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    requestSitePermission(webContents, permission, callback, details);
  });
  browsingSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return true;
    const origin = permissionOrigin(webContents, requestingOrigin, details);
    const requestedKinds = permissionKeys(permission, details);
    if (!origin || !requestedKinds.length) return false;
    const choices = permissionPreferences[origin] || {};
    return requestedKinds.every((kind) => choices[kind] === 'allow');
  });
  return browsingSession;
}

ipcMain.handle('app:bootstrap', () => ({
  bookmarks: importedBookmarks,
  history: importedHistory,
  importReport,
  startPageUrl,
  theme: nativeTheme.themeSource,
  downloads: downloadManager?.list() || []
}));

ipcMain.handle('start:suggestions', (event, query) => {
  if (!isTrustedStartSender(event)) return [];
  return rankedStartSuggestions(query);
});

ipcMain.handle('theme:set', (_event, theme) => {
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  return nativeTheme.themeSource;
});

ipcMain.handle('downloads:action', async (event, id, action) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return 'Still is not ready.';
  return downloadManager?.action(String(id || ''), String(action || '')) || 'Downloads are not ready.';
});

ipcMain.handle('permissions:get', (event, url) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return permissionSnapshot('');
  return permissionSnapshot(String(url || ''));
});

ipcMain.handle('permissions:reset', (event, url, kind) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return permissionSnapshot('');
  const origin = normalizedWebOrigin(url);
  const normalizedKind = String(kind || 'all');
  if (origin && permissionPreferences[origin]) {
    if (normalizedKind === 'all') {
      delete permissionPreferences[origin];
    } else if (permissionKinds.includes(normalizedKind)) {
      delete permissionPreferences[origin][normalizedKind];
      if (!Object.keys(permissionPreferences[origin]).length) delete permissionPreferences[origin];
    }
    savePermissionPreferences();
  }
  const snapshot = permissionSnapshot(origin);
  mainWindow.webContents.send('permissions:changed', snapshot);
  return snapshot;
});

ipcMain.handle('favicon:prepare', async (event, source) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { dataUrl: '', cached: false };
  const normalized = String(source || '');
  if (!normalized) return { dataUrl: '', cached: false };
  if (faviconUpscaleJobs.has(normalized)) return faviconUpscaleJobs.get(normalized);
  const job = prepareFaviconForRenderer(normalized).catch(() => ({ dataUrl: '', cached: false })).finally(() => {
    faviconUpscaleJobs.delete(normalized);
  });
  faviconUpscaleJobs.set(normalized, job);
  return job;
});

ipcMain.handle('favicon:store', async (event, source, dataUrl) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return '';
  return storeUpscaledFavicon(String(source || ''), String(dataUrl || '')).catch(() => '');
});

ipcMain.handle('browser:default-settings', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  return openDefaultBrowserSettings();
});

ipcMain.on('window:action', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
});

ipcMain.on('permissions:respond', (event, id, decision) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const normalizedDecision = ['allow', 'block', 'dismiss'].includes(decision) ? decision : 'dismiss';
  finishPermissionRequest(String(id || ''), normalizedDecision);
});

ipcMain.on('permissions:activity', (event, payload) => {
  const guest = guestContentsById.get(event.sender.id);
  if (!guest || guest !== event.sender || !payload || typeof payload !== 'object') return;
  const frameId = String(payload.frameId || '').slice(0, 100);
  if (!frameId) return;
  const state = {
    origin: normalizedWebOrigin(payload.origin),
    microphone: Boolean(payload.microphone),
    camera: Boolean(payload.camera),
    location: Boolean(payload.location)
  };
  let frames = permissionActivityByGuest.get(guest.id);
  if (!frames) {
    frames = new Map();
    permissionActivityByGuest.set(guest.id, frames);
  }
  if (state.microphone || state.camera || state.location) frames.set(frameId, state);
  else frames.delete(frameId);
  if (!frames.size) permissionActivityByGuest.delete(guest.id);
  publishPermissionActivity(guest.id);
});

ipcMain.on('slot:active-guest', (event, guestId) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const normalizedId = Number(guestId);
  if (guestContentsById.has(normalizedId)) activeGuestId = normalizedId;
});

ipcMain.on('history:suggestions', (event, entries) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !Array.isArray(entries)) return;
  runtimeSuggestionHistory = entries.slice(0, 6000).filter((entry) => /^https?:\/\//i.test(entry?.url)).map((entry) => ({
    url: entry.url,
    title: String(entry.title || entry.name || '').slice(0, 500),
    visitCount: Number(entry.visitCount || 0),
    typedCount: Number(entry.typedCount || 0)
  }));
});

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) return;
  const url = findExternalUrl(argv);
  if (url) openExternalUrl(url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  openExternalUrl(url);
});

app.whenReady().then(async () => {
  registerStillBrowser();
  let operaExtensions = [];
  if (process.platform === 'win32') {
    importReport = await prepareOperaImport(userDataPath);
    importedHistory = await prepareOperaHistory(userDataPath);
    importedBookmarks = readImportedBookmarks(userDataPath);
    operaExtensions = await prepareOperaExtensions(userDataPath);
  } else {
    importReport = {
      skipped: true,
      reason: 'Opera GX profile migration is available on Windows only.',
      errors: [],
      extensions: { discovered: 0, loaded: [], disabled: [], failed: [] }
    };
  }
  const seenSuggestionUrls = new Set();
  startSuggestionHistory = [
    ...importedHistory,
    ...importedBookmarks.map((bookmark) => ({ ...bookmark, title: bookmark.name, visitCount: 1, typedCount: 1 }))
  ].filter((entry) => {
    if (!entry.url || seenSuggestionUrls.has(entry.url)) return false;
    seenSuggestionUrls.add(entry.url);
    return true;
  });
  const browsingSession = configureBrowsingSession();
  registerYouTubeDownloader(browsingSession, downloadManager);
  if (process.platform === 'win32') {
    importReport.cookieImport = await importOperaCookies(browsingSession, userDataPath);
    importReport.googleSessionRepair = await repairGoogleSession(browsingSession, userDataPath);
    importReport.extensions = await loadOperaExtensions(browsingSession, operaExtensions);
  }
  createWindow();
  startMouseNavigationHelper();
});

app.on('before-quit', stopMouseNavigationHelper);
app.on('window-all-closed', () => app.quit());
