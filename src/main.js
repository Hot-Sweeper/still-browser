const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, promises: fsPromises } = require('node:fs');
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
const { startLocalSearxng } = require('./searxng');

const mouseNavigationTestMode = process.env.FOCUS_SLOTS_MOUSE_TEST === '1';
const browsingPartition = 'persist:focus';
// A restored document must receive a fresh user gesture before Chromium may autoplay media.
app.commandLine.appendSwitch('autoplay-policy', 'document-user-activation-required');
// Keep every renderer inside Chromium's OS-level sandbox, including any future
// windows that might otherwise omit an explicit sandbox preference.
app.enableSandbox();
const shellPagePath = path.join(__dirname, 'index.html');
const startPagePath = path.join(__dirname, 'start.html');
const learnPagePath = path.join(__dirname, 'learn.html');
const startPageUrl = pathToFileURL(startPagePath).href;
const editorPageUrl = pathToFileURL(path.join(__dirname, 'editor.html')).href;
const learnPageUrl = pathToFileURL(learnPagePath).href;
const youtubeUiScript = readFileSync(path.join(__dirname, 'youtube-ui.js'), 'utf8');
const youtubeFilterScript = readFileSync(path.join(__dirname, 'youtube-filter.js'), 'utf8');
const youtubeHomeScript = readFileSync(path.join(__dirname, 'youtube-home.js'), 'utf8');
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
let localSearch;
let localSearchBaseUrl = '';
let guestForcedFullscreen = false;
let updateNoticePath = '';
let updatePoll;
let pendingExternalUrl = findExternalUrl(process.argv);
let lastModifierWheel = { kind: '', direction: 0, source: '', time: 0 };
let lastExternalApplicationRequest = { url: '', time: 0 };
const guestContentsById = new Map();
const faviconUpscaleJobs = new Map();
const learningFeedCache = new Map();
const learningAvatarCache = new Map();
const discoveredLearningChannels = new Map();
let learningDiscoveryCache = { signature: '', time: 0, result: null };
let learningDiscoveryJob = null;
let learningHomeFeedCache = { signature: '', time: 0, videos: [], failed: [] };
let learningHomeFeedJob = null;
let musicHomeFeedCache = { signature: '', time: 0, videos: [], failed: [] };
let musicHomeFeedJob = null;
const learningCatalogVersion = 9;
const learningChannels = Object.freeze([
  { id: 'UCOJIGngtr4zcPuuZX6dO8aQ', name: 'Tech2WiLD', accent: '#7c5cff' },
  { id: 'UCPix8N6PMRI4KzgyjuZeF0g', name: 'Fahd Mirza', accent: '#ff8a4c' },
  { id: 'UCOCahKBCEUuzDJawM7yN1dg', name: 'Bijan Bowen', accent: '#2ec4a6' },
  { id: 'UCIgnGlGkVRhd4qNFcEwLL4A', name: 'AI Search', accent: '#4e8cff' },
  { id: 'UCbfYPyITQ-7l4upoX8nvctg', name: 'Two Minute Papers', accent: '#ef5547', addedIn: 3 },
  { id: 'UChhMeymAOC5PNbbnqxD_w4g', name: 'Just Rayen', accent: '#f06a9b', addedIn: 4 },
  { id: 'UC9x0AN7BWHpCDHSm9NiJFJQ', name: 'NetworkChuck', accent: '#c9a45c', addedIn: 5 },
  { id: 'UCawZsQWqfGSbCI5yjkdVkTA', name: 'Matthew Berman', accent: '#f28c45', addedIn: 6 },
  { id: 'UC2mPtIOYm1XihpmfrJKXjMw', name: 'Nerd Snipe', accent: '#f04e45', addedIn: 7 },
  { id: 'UCoy6cTJ7Tg0dqS-DI-_REsA', name: 'Chase AI', accent: '#8d70ff', addedIn: 7 },
  { id: 'UCrJrY9gMcbRL2APnFCXiuBQ', name: 'Christian Peverelli', accent: '#36b9a8', addedIn: 7 },
  { id: 'UCuU9jE4MHHEIyYMbDfUPSew', name: 'Caleb Writes Code', accent: '#57a7f2', addedIn: 7 },
  { id: 'UCxE6qpCeMGgyrae2fV-Lhhg', name: 'Duke Pan', accent: '#ff765d', addedIn: 8 },
  { id: 'UCED3hlYdD0SlCff7jJ8tF3Q', name: 'AI Samson', accent: '#d665f0', addedIn: 8 },
  { id: 'UC2ojq-nuP8ceeHqiroeKhBA', name: 'Nate Herk | AI Automation', accent: '#3bbf8f', addedIn: 8 },
  { id: 'UCG4zMyo_SNL7FZwRa85yp2Q', name: 'fal', accent: '#f2cf4a', addedIn: 8 },
  { id: 'UCKW1UkS5szOItFnKKsWzVRQ', name: 'xCreate', accent: '#4d9fff', addedIn: 8 },
  { id: 'UCNoGPh6-xT7afBoudgrx56Q', name: 'The Mysticle', accent: '#6a8cff', addedIn: 9 },
  { id: 'UC5l7RouTQ60oUjLjt1Nh-UQ', name: 'AI Revolution', accent: '#ef5b72', addedIn: 9 },
  { id: 'UC9Ryt3XOGYBoAJVsBHNGDzA', name: 'Theoretically Media', accent: '#b673ee', addedIn: 9 },
  { id: 'UCkVfrGwV-iG9bSsgCbrNPxQ', name: 'Better Stack', accent: '#59c3a6', addedIn: 9 },
  { id: 'UC3ok91FKp_SAtxhz63Ti3KQ', name: 'VoodooDE VR', accent: '#51a9f4', addedIn: 9 },
  { id: 'UC5rMneyhrBKrNuzJQkRy0uw', name: 'Tyriel Wood - VR Tech', accent: '#ec744f', addedIn: 9 },
  { id: 'UCKoDvV9qSSlhj_EKWTk5CIw', name: 'Tetiana Discovers', accent: '#d768b8', addedIn: 9 },
  { id: 'UC2mgZjuHRDW02mx_ok4wfPw', name: 'MRTV - MIXED REALITY TV', accent: '#5bd46e', addedIn: 9 },
  { id: 'UC0DZj1PNa_Fp0MU6uPSKv5w', name: 'Cloud Codes', accent: '#74a8ff', addedIn: 9 },
  { id: 'UCSbdMXOI_3HGiFviLZO6kNA', name: 'ThrillSeeker', accent: '#ff4f65', addedIn: 9 },
  { id: 'UCYwLV1gDwzGbg7jXQ52bVnQ', name: 'Universe of AI', accent: '#8f74ff' },
  { id: 'UC2WmuBuFq6gL08QYG-JjXKw', name: 'WorldofAI', accent: '#3eb7ff' },
  { id: 'UCsBjURrPoezykLs9EqgamOA', name: 'Fireship', accent: '#f25f4b' },
  { id: 'UCbRP3c757lWg9M-U7TyEkXA', name: 'Theo – t3.gg', accent: '#ec5da7' },
  { id: 'UCXZCJLdBC09xxGZ6gcdrc6A', name: 'OpenAI', accent: '#10a37f' },
  { id: 'UCrDwWp7EBBv4NwvScIpBDOA', name: 'Anthropic', accent: '#d29b6e' },
  { id: 'UCRaz_dquopKtb4ptswKcxTA', name: 'Mistral AI', accent: '#f7a53b', addedIn: 2 },
  { id: 'UCipPA-ZHX6UYGH_Iyti1-Jw', name: 'Qwen · Alibaba Cloud', accent: '#6f7cff', addedIn: 2, feedKeywords: ['qwen'] },
  { id: 'UCP7jMXSY2xbc3KCAE0MHQ-A', name: 'Google DeepMind · Gemini', accent: '#4c8bf5', addedIn: 2 },
  { id: 'UCHlNU7kIZhRgSbhHvFoy72w', name: 'Hugging Face', accent: '#ffd21e', addedIn: 2 },
  { id: 'UCBHcMCGaiJhv-ESTcWGJPcw', name: 'NVIDIA Developer', accent: '#76b900', addedIn: 2 },
  { id: 'UCwKzYuPkYJ_0v1kYOYXNmoA', name: 'Ollama', accent: '#d6d6d6', addedIn: 2 },
  { id: 'UCrpz86KspLzW2JF-feKBn-w', name: 'Local AI', accent: '#42c59a', addedIn: 2 },
  { id: 'UCCb9_Kn8F_Opb3UCGm-lILQ', name: 'Microsoft Research', accent: '#00a4ef', addedIn: 2 }
]);
const musicChannels = Object.freeze([
  { id: 'UCJI5_5Ae0XkY2A58MaAKGjg', name: 'h6itam', accent: '#ff385c' },
  { id: 'UCS8OjP50HmdeXeKYLvF3rdA', name: 'KORDHELL', accent: '#d23b3b' },
  { id: 'UCJWUQibZ1DnBb4r4pCCmpGA', name: 'DVRST', accent: '#865dff' },
  { id: 'UCH8FcwNd0ttrTCsdKep4Fyg', name: 'INTERWORLD', accent: '#576cff' },
  { id: 'UCdlbBrTTQoMRYTv83ohYjgQ', name: 'LXST CXNTURY', accent: '#9c67db' },
  { id: 'UCFyDhQ3yNr8eYl895l7nYJw', name: 'KSLV', accent: '#df5656' },
  { id: 'UCKocLjSeFsiJTgPQlg0q91A', name: 'MoonDeity', accent: '#7184ff' },
  { id: 'UCHsLqoi00xf5mi2CEOy9ugg', name: 'PlayaPhonk', accent: '#ee884f' },
  { id: 'UCI_E_bVdNGff07J5HTHUuLg', name: 'DJ FKU', accent: '#ffb329' },
  { id: 'UCsXGh5GV9HYGpAwtmfQvXYw', name: 'Ogryzek', accent: '#e0b84b' },
  { id: 'UC8EV5KwPBnp07F3kHnj6-9w', name: 'Eternxlkz', accent: '#4ac1d9' },
  { id: 'UCAQ2Go2JWMGt60kYXsWy-bQ', name: 'MXZI', accent: '#4e9bff' },
  { id: 'UCVUhflcUs9R9YEHf5u3nkRQ', name: 'ATLXS', accent: '#f06078' },
  { id: 'UCHxRxWlcJm2d78ZTx2jpe5g', name: 'Ariis', accent: '#f06ec0' },
  { id: 'UCrBVMECNKirKrG56SquaBDw', name: 'Sayfalse', accent: '#55c88b' },
  { id: 'UCF7AofUiOhzjd4Wll-AbtHg', name: 'PHONK ME', accent: '#c65cf2' },
  { id: 'UCMkBFD0YPtrcoB_tni5uOLQ', name: 'Ryan Celsius Sounds', accent: '#e7a94d' },
  { id: 'UCxH0sQJKG6Aq9-vFIPnDZ2A', name: 'The Vibe Guide', accent: '#56a7ff' },
  { id: 'UCYbqreqHm4XAMoMSTMAqAlw', name: 'Phonky Town', accent: '#ff684f' }
]);
const learningPreferencesPath = path.join(userDataPath, 'still-learning-channels-v1.json');
let learningEnabledChannelIds = new Set(learningChannels.map((channel) => channel.id));
let learningPreferencesWriteQueue = Promise.resolve();
const faviconCachePath = path.join(userDataPath, 'favicon-cache-v1');
const permissionPreferencesPath = path.join(userDataPath, 'site-permissions-v1.json');
const permissionKinds = ['microphone', 'camera', 'location', 'notifications'];
const temporaryCertificateExceptions = new Set();
const pendingPermissionRequests = new Map();
const permissionActivityByGuest = new Map();
let permissionRequestSequence = 0;
let permissionPreferences = loadPermissionPreferences();
let permissionWriteQueue = Promise.resolve();

loadLearningPreferences();

function sanitizedLearningChannel(value) {
  const id = String(value?.id || '');
  const name = String(value?.name || '').trim().slice(0, 160);
  if (!/^UC[\w-]{22}$/.test(id) || !name) return null;
  return {
    id,
    name,
    accent: /^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent : learningChannelAccent(id),
    url: `https://www.youtube.com/channel/${id}`,
    watched: Math.max(0, Math.min(999, Number(value.watched) || 0)),
    recentVideo: String(value.recentVideo || '').slice(0, 300)
  };
}

function loadLearningPreferences() {
  try {
    const stored = JSON.parse(readFileSync(learningPreferencesPath, 'utf8'));
    const channels = Array.isArray(stored?.channels) ? stored.channels.map(sanitizedLearningChannel).filter(Boolean) : [];
    channels.forEach((channel) => discoveredLearningChannels.set(channel.id, channel));
    const availableIds = new Set([...learningChannels, ...channels].map((channel) => channel.id));
    if (Array.isArray(stored?.enabled)) {
      learningEnabledChannelIds = new Set(stored.enabled.map(String).filter((id) => availableIds.has(id)));
      const storedCatalogVersion = Math.max(0, Number(stored.catalogVersion) || 0);
      learningChannels
        .filter((channel) => Number(channel.addedIn) > storedCatalogVersion)
        .forEach((channel) => learningEnabledChannelIds.add(channel.id));
    }
  } catch {}
}

function saveLearningPreferences() {
  const payload = JSON.stringify({
    catalogVersion: learningCatalogVersion,
    enabled: [...learningEnabledChannelIds],
    channels: [...discoveredLearningChannels.values()]
  });
  learningPreferencesWriteQueue = learningPreferencesWriteQueue.then(async () => {
    await fsPromises.mkdir(path.dirname(learningPreferencesPath), { recursive: true });
    const temporaryPath = `${learningPreferencesPath}.tmp`;
    await fsPromises.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(temporaryPath, learningPreferencesPath);
  }).catch((error) => console.error('Could not save Still learning channels:', error));
  return learningPreferencesWriteQueue;
}

function learningFilterConfig(homeFeed = null, musicHomeFeed = null) {
  const available = [...learningChannels, ...discoveredLearningChannels.values()];
  return {
    enabled: available.filter((channel) => learningEnabledChannelIds.has(channel.id)).map((channel) => ({
      id: channel.id,
      name: channel.name
    })),
    musicChannels: musicChannels.map((channel) => ({ id: channel.id, name: channel.name })),
    learnPageUrl,
    homeFeed: homeFeed || (
      learningHomeFeedCache.signature === learningHomeFeedSignature()
        ? { videos: learningHomeFeedCache.videos, failed: learningHomeFeedCache.failed, loading: false }
        : { videos: [], failed: [], loading: true }
    ),
    musicHomeFeed: musicHomeFeed || (
      musicHomeFeedCache.signature === musicHomeFeedSignature()
        ? { videos: musicHomeFeedCache.videos, failed: musicHomeFeedCache.failed, loading: false }
        : { videos: [], failed: [], loading: true }
    )
  };
}

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
    await fsPromises.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
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

function isKnownGuest(webContents) {
  return Boolean(webContents && guestContentsById.get(webContents.id) === webContents);
}

function isAllowedPopupUrl(value) {
  if (value === 'about:blank') return true;
  try {
    return ['http:', 'https:', 'blob:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function configureSitePopups(opener, browsingSession) {
  opener.setWindowOpenHandler(({ url }) => {
    if (!isAllowedPopupUrl(url)) {
      if (externalApplicationUrl(url)) requestExternalApplication(url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 900,
        height: 720,
        minWidth: 420,
        minHeight: 320,
        frame: true,
        show: true,
        autoHideMenuBar: true,
        backgroundColor: '#000000',
        webPreferences: {
          session: browsingSession,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          safeDialogs: true
        }
      }
    };
  });

  opener.on('did-create-window', (popup) => {
    const contents = popup.webContents;
    guestContentsById.set(contents.id, contents);
    contents.once('destroyed', () => guestContentsById.delete(contents.id));
    const guardNavigation = (event, navigation) => {
      const url = typeof navigation === 'string' ? navigation : navigation?.url;
      if (isAllowedPopupUrl(url)) return;
      event.preventDefault();
      if (externalApplicationUrl(url)) requestExternalApplication(url);
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    configureSitePopups(contents, browsingSession);
  });
}

function isTrustedLocalPage(url, expectedPath) {
  try {
    return path.normalize(fileURLToPath(url)) === path.normalize(expectedPath);
  } catch {
    return false;
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
  if (!isKnownGuest(webContents)) {
    callback(false);
    return;
  }
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

function isYouTubeHome(url) {
  try {
    const parsed = new URL(url);
    return isYouTubePage(url) && parsed.pathname === '/';
  } catch {
    return false;
  }
}

function executeYouTubeScripts(guest, nextConfig, includeWatchUi = true) {
  if (guest.isDestroyed()) return Promise.resolve();
  const config = JSON.stringify(nextConfig).replace(/</g, '\\u003c');
  return guest.executeJavaScript(`window.__stillLearningFilterConfig = ${config};`, true)
    .then(() => guest.executeJavaScript(youtubeFilterScript, true))
    .then(() => guest.executeJavaScript(youtubeHomeScript, true))
    .then(() => includeWatchUi && guest.executeJavaScript(youtubeUiScript, true));
}

function injectYouTubeUi(guest) {
  if (guest.isDestroyed() || !isYouTubePage(guest.getURL())) return;
  const startingUrl = guest.getURL();
  executeYouTubeScripts(guest, learningFilterConfig()).catch(() => {});
  if (!isYouTubeHome(startingUrl)) return;

  Promise.all([refreshLearningHomeFeed(), refreshMusicHomeFeed()]).then(([homeFeed, musicHomeFeed]) => {
    if (guest.isDestroyed() || !isYouTubeHome(guest.getURL())
        || homeFeed.signature !== learningHomeFeedSignature()
        || musicHomeFeed.signature !== musicHomeFeedSignature()) return;
    return executeYouTubeScripts(guest, learningFilterConfig(homeFeed, musicHomeFeed), false);
  }).catch(() => {});
}

function refreshYouTubeFilters() {
  for (const guest of guestContentsById.values()) injectYouTubeUi(guest);
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
  return isKnownGuest(event.sender) && isTrustedLocalPage(event.senderFrame.url, startPagePath);
}

function isTrustedLearnSender(event) {
  return isKnownGuest(event.sender) && isTrustedLocalPage(event.senderFrame.url, learnPagePath);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlValue(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(match?.[1]);
}

function parseYoutubeFeed(xml, expectedChannel) {
  return [...String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const entry = match[1];
    const videoId = xmlValue(entry, 'yt:videoId');
    const published = xmlValue(entry, 'published');
    const views = Number(entry.match(/<media:statistics\b[^>]*\bviews="(\d+)"/i)?.[1]);
    if (!/^[\w-]{11}$/.test(videoId) || !Number.isFinite(Date.parse(published))) return null;
    return {
      id: videoId,
      channelId: expectedChannel.id,
      channel: expectedChannel.name,
      title: xmlValue(entry, 'title').slice(0, 500),
      published,
      meta: Number.isSafeInteger(views) && views >= 0
        ? `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(views)} views`
        : '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };
  }).filter(Boolean);
}

function normalizedLearningAvatar(value) {
  const decoded = String(value || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  try {
    const parsed = new URL(decoded);
    if (!['yt3.googleusercontent.com', 'yt3.ggpht.com'].includes(parsed.hostname.toLowerCase())) return '';
    return decoded.replace(/=s\d+(?:-[^/?#"']*)?$/i, '=s176-c-k-c0x00ffffff-no-rj');
  } catch {
    return '';
  }
}

function learningAvatarFromHtml(html) {
  const source = String(html || '');
  const candidates = [
    source.match(/<meta\s+property="og:image"\s+content="([^"]+)/i)?.[1],
    source.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i)?.[1],
    source.match(/<meta\s+name="twitter:image"\s+content="([^"]+)/i)?.[1],
    source.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)/)?.[1],
    source.match(/"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)/)?.[1],
    source.match(/"decoratedAvatarViewModel":\{"avatar":\{"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)/)?.[1]
  ];
  for (const candidate of candidates) {
    const avatar = normalizedLearningAvatar(candidate);
    if (avatar) return avatar;
  }
  return '';
}

async function fetchLearningChannelAvatar(channel) {
  const cached = learningAvatarCache.get(channel.id);
  const cacheLifetime = cached?.url ? 24 * 60 * 60 * 1000 : 60 * 1000;
  if (cached && Date.now() - cached.time < cacheLifetime) return cached.url;
  let url = '';
  try {
    const response = await fetch(`https://www.youtube.com/channel/${channel.id}`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (response.ok) {
      const html = await response.text();
      url = learningAvatarFromHtml(html);
    }
  } catch {}
  learningAvatarCache.set(channel.id, { time: Date.now(), url });
  return url;
}

async function fetchLearningChannel(channel) {
  const cached = learningFeedCache.get(channel.id);
  if (cached && Date.now() - cached.time < 45 * 1000) return cached.videos;
  const avatarPromise = fetchLearningChannelAvatar(channel);
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`, {
    headers: { Accept: 'application/atom+xml, application/xml;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`YouTube feed returned HTTP ${response.status}.`);
  const xml = await response.text();
  if (xml.length > 2_000_000) throw new Error('YouTube feed was unexpectedly large.');
  let videos = parseYoutubeFeed(xml, channel);
  const avatar = await avatarPromise.catch(() => '');
  if (avatar) videos = videos.map((video) => ({ ...video, avatar }));
  if (Array.isArray(channel.feedKeywords) && channel.feedKeywords.length) {
    const terms = channel.feedKeywords.map((term) => String(term).toLocaleLowerCase());
    videos = videos.filter((video) => terms.some((term) => video.title.toLocaleLowerCase().includes(term)));
  }
  learningFeedCache.set(channel.id, { time: Date.now(), videos });
  return videos;
}

function enabledLearningChannels() {
  return [...learningChannels, ...discoveredLearningChannels.values()]
    .filter((channel) => learningEnabledChannelIds.has(channel.id));
}

function learningHomeFeedSignature() {
  return enabledLearningChannels().map((channel) => channel.id).sort().join(',');
}

function rotateLearningVideos(videos, channels) {
  const buckets = new Map(channels.map((channel) => [channel.id, []]));
  for (const video of videos) {
    if (buckets.has(video.channelId)) buckets.get(video.channelId).push(video);
  }
  buckets.forEach((bucket) => bucket.sort((left, right) => Date.parse(right.published) - Date.parse(left.published)));
  const active = [...buckets.values()].filter((bucket) => bucket.length)
    .sort((left, right) => Date.parse(right[0].published) - Date.parse(left[0].published));
  const mixed = [];
  for (let round = 0; active.some((bucket) => bucket[round]); round += 1) {
    active.forEach((bucket) => {
      if (bucket[round]) mixed.push(bucket[round]);
    });
  }
  return mixed;
}

async function refreshLearningHomeFeed() {
  const channels = enabledLearningChannels();
  const signature = learningHomeFeedSignature();
  if (learningHomeFeedCache.signature === signature && Date.now() - learningHomeFeedCache.time < 45 * 1000) {
    return { signature, videos: learningHomeFeedCache.videos, failed: learningHomeFeedCache.failed, loading: false };
  }
  if (learningHomeFeedJob?.signature === signature) return learningHomeFeedJob.promise;

  const promise = (async () => {
    const results = await Promise.allSettled(channels.map(fetchLearningChannel));
    const videos = [];
    const failed = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') videos.push(...result.value);
      else failed.push(channels[index].name);
    });
    const mixed = rotateLearningVideos(videos, channels).slice(0, 180);
    if (learningHomeFeedSignature() === signature) {
      learningHomeFeedCache = { signature, time: Date.now(), videos: mixed, failed };
    }
    return { signature, videos: mixed, failed, loading: false };
  })();
  learningHomeFeedJob = { signature, promise };
  try {
    return await promise;
  } finally {
    if (learningHomeFeedJob?.promise === promise) learningHomeFeedJob = null;
  }
}

function musicHomeFeedSignature() {
  return musicChannels.map((channel) => channel.id).sort().join(',');
}

async function refreshMusicHomeFeed() {
  const signature = musicHomeFeedSignature();
  if (musicHomeFeedCache.signature === signature && Date.now() - musicHomeFeedCache.time < 45 * 1000) {
    return { signature, videos: musicHomeFeedCache.videos, failed: musicHomeFeedCache.failed, loading: false };
  }
  if (musicHomeFeedJob?.signature === signature) return musicHomeFeedJob.promise;

  const promise = (async () => {
    const results = await Promise.allSettled(musicChannels.map(fetchLearningChannel));
    const videos = [];
    const failed = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') videos.push(...result.value);
      else failed.push(musicChannels[index].name);
    });
    const mixed = rotateLearningVideos(videos, musicChannels).slice(0, 180);
    if (musicHomeFeedSignature() === signature) {
      musicHomeFeedCache = { signature, time: Date.now(), videos: mixed, failed };
    }
    return { signature, videos: mixed, failed, loading: false };
  })();
  musicHomeFeedJob = { signature, promise };
  try {
    return await promise;
  } finally {
    if (musicHomeFeedJob?.promise === promise) musicHomeFeedJob = null;
  }
}

const learningHomeRefreshTimer = setInterval(() => {
  for (const guest of guestContentsById.values()) {
    if (!guest.isDestroyed() && isYouTubeHome(guest.getURL())) injectYouTubeUi(guest);
  }
}, 60 * 1000);
learningHomeRefreshTimer.unref?.();

function recentYoutubeHistory(limit = 18) {
  const source = runtimeSuggestionHistory.length ? runtimeSuggestionHistory : importedHistory;
  const seen = new Set();
  const videos = [];
  for (const entry of source) {
    try {
      const url = new URL(entry?.url);
      const host = url.hostname.toLowerCase();
      const id = url.pathname === '/watch' && (host === 'youtube.com' || host.endsWith('.youtube.com'))
        ? url.searchParams.get('v')
        : '';
      if (!/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      videos.push({ id, title: String(entry.title || '').replace(/\s+-\s+YouTube$/i, '').slice(0, 300) });
      if (videos.length >= limit) break;
    } catch {}
  }
  return videos;
}

function learningMetadataBinary() {
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, binaryName)
    : path.join(__dirname, '..', 'build', 'vendor', binaryName);
  return existsSync(candidate) ? candidate : '';
}

function learningChannelAccent(channelId) {
  const palette = ['#7c5cff', '#ff8a4c', '#2ec4a6', '#4e8cff', '#ec5da7', '#d29b6e', '#79c267', '#d9b642'];
  const hash = [...channelId].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
  return palette[hash % palette.length];
}

function inspectYoutubeBatch(executable, videos) {
  return new Promise((resolve) => {
    if (!videos.length) return resolve([]);
    const args = [
      '--no-playlist',
      '--skip-download',
      '--no-warnings',
      '--ignore-errors',
      '--socket-timeout', '10',
      '--retries', '1',
      '--print', '%(channel_id)s\t%(channel)s\t%(channel_url)s\t%(id)s',
      ...videos.map((video) => `https://www.youtube.com/watch?v=${video.id}`)
    ];
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const rows = output.split(/\r?\n/).map((line) => {
        const [id, name, url, videoId] = line.split('\t');
        if (!/^UC[\w-]{22}$/.test(id) || !/^[\w-]{11}$/.test(videoId)) return null;
        return {
          id,
          name: String(name || 'YouTube channel').slice(0, 160),
          url: /^https:\/\/www\.youtube\.com\/channel\/UC[\w-]{22}$/.test(url) ? url : `https://www.youtube.com/channel/${id}`,
          videoId
        };
      }).filter(Boolean);
      resolve(rows);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, 45000);
    child.stdout.on('data', (chunk) => {
      if (output.length < 512_000) output += chunk.toString('utf8');
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

async function discoverLearningChannels(force = false) {
  const videos = recentYoutubeHistory();
  const signature = videos.map((video) => video.id).join(',');
  if (!force && learningDiscoveryCache.result && learningDiscoveryCache.signature === signature
    && Date.now() - learningDiscoveryCache.time < 10 * 60 * 1000) {
    return learningDiscoveryCache.result;
  }
  if (learningDiscoveryJob) return learningDiscoveryJob;

  learningDiscoveryJob = (async () => {
    const executable = learningMetadataBinary();
    if (!videos.length) return { channels: [], scanned: 0, message: 'No watched YouTube videos were found in local history yet.' };
    if (!executable) return { channels: [], scanned: videos.length, message: 'Channel discovery is unavailable in this Still build.' };

    const batchSize = 6;
    const batches = [];
    for (let index = 0; index < videos.length; index += batchSize) batches.push(videos.slice(index, index + batchSize));
    const resolvedRows = (await Promise.all(batches.map((batch) => inspectYoutubeBatch(executable, batch)))).flat();
    const seedIds = new Set(learningChannels.map((channel) => channel.id));
    const historyOrder = new Map(videos.map((video, index) => [video.id, index]));
    const historyTitles = new Map(videos.map((video) => [video.id, video.title]));
    const found = new Map();
    for (const row of resolvedRows) {
      if (seedIds.has(row.id)) continue;
      const existing = found.get(row.id);
      const order = historyOrder.get(row.videoId) ?? videos.length;
      if (existing) {
        existing.watched += 1;
        existing.order = Math.min(existing.order, order);
        continue;
      }
      found.set(row.id, {
        id: row.id,
        name: row.name,
        accent: learningChannelAccent(row.id),
        url: row.url,
        watched: 1,
        recentVideo: historyTitles.get(row.videoId) || '',
        order
      });
    }
    const channels = [...found.values()].sort((left, right) => left.order - right.order).slice(0, 14).map(({ order, ...channel }) => channel);
    discoveredLearningChannels.clear();
    channels.forEach((channel) => discoveredLearningChannels.set(channel.id, channel));
    saveLearningPreferences();
    const result = { channels, scanned: videos.length, message: '' };
    learningDiscoveryCache = { signature, time: Date.now(), result };
    return result;
  })();

  try {
    return await learningDiscoveryJob;
  } finally {
    learningDiscoveryJob = null;
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:shortcut', direction === 'back' ? 'back' : 'forward');
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
    backgroundColor: '#000000',
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      safeDialogs: true,
      webviewTag: true
    }
  });

  mainWindow.loadFile(shellPagePath);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedLocalPage(url, shellPagePath)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('did-finish-load', () => {
    announceStagedUpdate();
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

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== browsingPartition) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    webPreferences.safeDialogs = true;
    delete webPreferences.preload;
    delete params.preload;
  });

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('enter-html-full-screen', () => {
      if (!mainWindow?.isDestroyed() && !mainWindow.isFullScreen()) {
        guestForcedFullscreen = true;
        mainWindow.setFullScreen(true);
      }
    });
    guest.on('leave-html-full-screen', () => {
      if (guestForcedFullscreen && mainWindow && !mainWindow.isDestroyed()) {
        guestForcedFullscreen = false;
        mainWindow.setFullScreen(false);
      }
    });
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

    // Sites use blank, scriptable child windows for sign-in and downloads. A
    // slot cannot preserve window.opener, form POSTs, or later child navigation.
    configureSitePopups(guest, session.fromPartition(browsingPartition));

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
      if (input.control && !input.alt && ['+', '=', 'add'].includes(key)) shortcut = 'zoom-in';
      else if (input.control && !input.alt && ['-', 'subtract'].includes(key)) shortcut = 'zoom-out';
      else if (input.control && !input.alt && key === '0') shortcut = 'zoom-reset';
      else if (input.control && key === 'l') shortcut = 'location';
      else if (input.control && (key === ',' || key === 'comma')) shortcut = 'browser-settings';
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

function stagedUpdateDirectory() {
  if (process.platform !== 'win32' || !app.isPackaged) return '';
  const current = path.dirname(process.execPath);
  if (path.basename(current).toLowerCase() !== 'win-unpacked') return '';
  const parent = path.dirname(current);
  let names;
  try { names = readdirSync(parent, { withFileTypes: true }); } catch { return ''; }
  const candidates = names
    .filter((entry) => entry.isDirectory() && /^win-unpacked-update[-\w]*$/i.test(entry.name))
    .map((entry) => path.join(parent, entry.name))
    .filter((directory) => existsSync(path.join(directory, 'Still.exe'))
      && existsSync(path.join(directory, 'resources', 'app.asar'))
      && !existsSync(path.join(directory, '.still-update-applied')))
    .sort().reverse();
  return candidates[0] || '';
}

function previousUpdateFailed() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  try {
    const log = readFileSync(path.join(path.dirname(process.execPath), '..', 'still-update-last.log'), 'utf8');
    const lastStart = log.lastIndexOf(' START ');
    const latestAttempt = lastStart < 0 ? '' : log.slice(lastStart);
    return latestAttempt.includes(' FAIL ') && !latestAttempt.includes(' SUCCESS ');
  } catch {
    return false;
  }
}

function announceStagedUpdate() {
  const staged = stagedUpdateDirectory();
  if (!staged || staged === updateNoticePath || !mainWindow || mainWindow.isDestroyed()) return;
  updateNoticePath = staged;
  mainWindow.webContents.send('app:update-ready', staged);
}

ipcMain.handle('app:install-update', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const staged = stagedUpdateDirectory();
  const script = path.join(process.resourcesPath, 'apply-update-after-exit.ps1');
  if (!staged || !existsSync(script)) return false;
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  try {
    const helper = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-CurrentDirectory', path.dirname(process.execPath),
      '-StagedDirectory', staged,
      '-ExpectedProcessId', String(process.pid)
    ], { detached: true, windowsHide: true, stdio: 'ignore', env: childEnvironment });
    return await new Promise((resolve) => {
      helper.once('error', (error) => {
        console.error(`Could not launch update helper: ${error.message}`);
        resolve(false);
      });
      helper.once('spawn', () => {
        helper.unref();
        resolve(true);
        setTimeout(() => app.quit(), 200);
      });
    });
  } catch (error) {
    console.error(`Could not launch update helper: ${error.message}`);
    return false;
  }
});

function configureBrowsingSession() {
  const browsingSession = session.fromPartition(browsingPartition);
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
  browsingSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      for (const header of Object.keys(requestHeaders)) {
        // Chromium variations identify experiment cohorts and provide no
        // user-facing browsing functionality.
        if (header.toLowerCase() === 'x-client-data') delete requestHeaders[header];
        if (header.toLowerCase() === 'sec-gpc') delete requestHeaders[header];
      }
      requestHeaders['Sec-GPC'] = '1';
      callback({ requestHeaders });
    }
  );
  // Hardware-device APIs have no UI in Still. Deny their secondary permission
  // path explicitly so a previously remembered Chromium choice cannot bypass the
  // browser's permission handler.
  browsingSession.setDevicePermissionHandler(() => false);
  browsingSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  browsingSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    requestSitePermission(webContents, permission, callback, details);
  });
  browsingSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!isKnownGuest(webContents)) return false;
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return true;
    const origin = permissionOrigin(webContents, requestingOrigin, details);
    const requestedKinds = permissionKeys(permission, details);
    if (!origin || !requestedKinds.length) return false;
    const choices = permissionPreferences[origin] || {};
    return requestedKinds.every((kind) => choices[kind] === 'allow');
  });
  return browsingSession;
}

ipcMain.handle('app:bootstrap', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;
  return {
    bookmarks: importedBookmarks,
    history: importedHistory,
    importReport,
    startPageUrl,
    editorPageUrl,
    learnPageUrl,
    searchBaseUrl: localSearchBaseUrl,
    searchAvailable: Boolean(localSearch),
    updateAvailable: Boolean(stagedUpdateDirectory()),
    updatePath: stagedUpdateDirectory(),
    updateFailed: previousUpdateFailed(),
    theme: nativeTheme.themeSource,
    downloads: downloadManager?.list() || []
  };
});

ipcMain.handle('start:suggestions', (event, query) => {
  if (!isTrustedStartSender(event)) return [];
  return rankedStartSuggestions(query);
});

ipcMain.handle('search:base-url', (event) => {
  if (!isTrustedStartSender(event)) return '';
  return localSearchBaseUrl;
});

ipcMain.handle('learn:catalog', (event) => {
  if (!isTrustedLearnSender(event)) return [];
  return learningChannels;
});

ipcMain.handle('learn:discover', async (event, force) => {
  if (!isTrustedLearnSender(event)) return { channels: [], scanned: 0, message: '' };
  return discoverLearningChannels(force === true);
});

ipcMain.handle('learn:selection', (event) => {
  if (!isTrustedLearnSender(event)) return [];
  return [...learningEnabledChannelIds];
});

ipcMain.handle('learn:selection-set', async (event, requestedIds) => {
  if (!isTrustedLearnSender(event) || !Array.isArray(requestedIds)) return [...learningEnabledChannelIds];
  const availableIds = new Set([...learningChannels, ...discoveredLearningChannels.values()].map((channel) => channel.id));
  learningEnabledChannelIds = new Set([...new Set(requestedIds.map(String))].filter((id) => availableIds.has(id)).slice(0, 80));
  learningHomeFeedCache = { signature: '', time: 0, videos: [], failed: [] };
  await saveLearningPreferences();
  refreshYouTubeFilters();
  return [...learningEnabledChannelIds];
});

ipcMain.on('learn:open', (event) => {
  if (!isKnownGuest(event.sender) || !isYouTubePage(event.senderFrame.url)) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:shortcut', 'open-learn');
});

ipcMain.handle('learn:feed', async (event, requestedIds) => {
  if (!isTrustedLearnSender(event) || !Array.isArray(requestedIds)) return { videos: [], failed: [] };
  const availableChannels = [...learningChannels, ...discoveredLearningChannels.values()];
  const allowedIds = new Set(availableChannels.map((channel) => channel.id));
  const selectedIds = [...new Set(requestedIds.map(String))].filter((id) => allowedIds.has(id)).slice(0, 80);
  const selectedChannels = selectedIds.map((id) => availableChannels.find((channel) => channel.id === id));
  const results = await Promise.allSettled(selectedChannels.map(fetchLearningChannel));
  const videos = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') videos.push(...result.value);
    else failed.push(selectedChannels[index].name);
  });
  videos.sort((left, right) => Date.parse(right.published) - Date.parse(left.published));
  return { videos: videos.slice(0, 120), failed };
});

ipcMain.handle('theme:set', (event, theme) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return nativeTheme.themeSource;
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  return nativeTheme.themeSource;
});

ipcMain.handle('slot:hard-reload', async (event, guestId) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const guest = guestContentsById.get(Number(guestId));
  if (!guest || guest.isDestroyed()) return false;

  let origin = '';
  let url = '';
  try {
    url = guest.getURL();
    origin = normalizedWebOrigin(url);
  } catch {}

  const browsingSession = guest.session;
  const clearing = [browsingSession.clearCache()];
  if (url && typeof browsingSession.clearCodeCaches === 'function') {
    clearing.push(browsingSession.clearCodeCaches({ urls: [url] }));
  }
  if (origin) {
    clearing.push(browsingSession.clearStorageData({
      origin,
      storages: ['serviceworkers', 'cachestorage']
    }));
  }
  await Promise.allSettled(clearing);
  if (guest.isDestroyed()) return false;
  guest.reloadIgnoringCache();
  return true;
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

ipcMain.handle('browser:open-external', async (event, url) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !/^https?:\/\//i.test(String(url || ''))) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('browser:open-edge', async (event, url) => {
  if (process.platform !== 'win32' || !mainWindow || event.sender !== mainWindow.webContents || !/^https?:\/\//i.test(String(url || ''))) return false;
  try {
    await shell.openExternal(`microsoft-edge:${url}`);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('browser:copy-url', (event, url) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !/^https?:\/\//i.test(String(url || ''))) return false;
  clipboard.writeText(url);
  return true;
});

ipcMain.handle('security:allow-certificate', (event, url) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') return false;
    temporaryCertificateExceptions.add(parsed.origin);
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('window:action', (event, action) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.setFullScreen(!mainWindow.isFullScreen());
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

app.on('certificate-error', (event, webContents, url, _error, _certificate, callback) => {
  event.preventDefault();
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  callback(Boolean(origin && isKnownGuest(webContents) && temporaryCertificateExceptions.has(origin)));
});

app.whenReady().then(async () => {
  registerStillBrowser();
  const localSearchPromise = startLocalSearxng({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userDataPath
  }).catch((error) => {
    console.error(`Could not start Still Search: ${error.message}`);
    return null;
  });
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
  localSearch = await localSearchPromise;
  if (localSearch) localSearchBaseUrl = localSearch.baseUrl;
  createWindow();
  updatePoll = setInterval(announceStagedUpdate, 15000);
  updatePoll.unref();
  startMouseNavigationHelper();
});

app.on('before-quit', () => {
  if (updatePoll) clearInterval(updatePoll);
  stopMouseNavigationHelper();
  localSearch?.stop();
});
app.on('window-all-closed', () => app.quit());
