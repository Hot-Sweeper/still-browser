// App-wide pieces shared by all Still windows: Still Search, the extension,
// window identity, and the channel from page helpers to each window.
// No system-wide hooks: Ctrl+wheel over pages comes from StillPageChild.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs"
});

// Each Still window registers its handlers here. Modules cannot rely on
// properties set on chrome windows by window scripts, so this is the one
// channel from shared code (page messages) to a window.
const windowHandlers = new WeakMap();

// Keyed by document: a window can reach shared code as different proxy
// objects, but its document is always the same object.
function handlersFor(win) {
  return win?.document ? windowHandlers.get(win.document) : null;
}

let extensionStarted = false;
let splashShown = false;
let resolveExtension;
const extensionReady = new Promise((resolve) => { resolveExtension = resolve; });

function stillFile(...parts) {
  const file = Services.dirsvc.get("GreD", Ci.nsIFile);
  file.append("still-chrome");
  for (const part of parts) file.append(part);
  return file;
}

// Still's page features (start page, YouTube, channel manager) ship as a
// WebExtension next to the runtime. Release Firefox only runs unsigned
// extensions as temporary add-ons, so it is loaded again on every start.
async function startExtension() {
  if (extensionStarted) return;
  extensionStarted = true;
  const dir = stillFile("extension");
  if (!dir.exists()) return;
  try {
    await lazy.AddonManager.installTemporaryAddon(dir);
    reopenStartPages();
  } catch (error) {
    console.error("Still could not load its extension", error);
  } finally {
    resolveExtension();
  }
}

// Tabs that opened before the extension was ready show Firefox's own start
// page, or a failed copy of Still's (session restore runs before the
// extension exists). Load Still's start page or reload Still's own pages.
function reopenStartPages() {
  const policy = WebExtensionPolicy.getByID("still-prototype@tim.local");
  const ownHost = policy?.mozExtensionHostname;
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    const startUrl = win.BROWSER_NEW_TAB_URL;
    for (const tab of win.gBrowser.tabs) {
      if (tab.hasAttribute("pending")) continue; // restores later, extension is ready by then
      const browser = tab.linkedBrowser;
      let uri = browser.currentURI;
      try { if (browser.documentURI?.spec.startsWith("about:neterror")) uri = browser.documentURI; } catch {}
      const spec = uri?.spec || "";
      if (spec === "about:home" || spec === "about:newtab" || (spec === "about:blank" && !tab.hasAttribute("busy"))) {
        if (startUrl?.startsWith("moz-extension:")) browser.fixupAndLoadURIString(startUrl, { triggeringPrincipal: principal });
      } else if (ownHost && (spec.includes(ownHost) || spec.startsWith("about:neterror"))) {
        browser.reload();
      }
    }
  }
}

Services.obs.addObserver(() => {
  try { search?.kill(); } catch {}
  // The service starts a child process of its own before it can be tied to
  // the browser; end every copy of Still's own executable (exact path).
  try { if (Services.appinfo.OS === "WINNT") stopStaleSearch(stillFile("searxng", "searxng-sidecar.exe").path); } catch {}
}, "quit-application");

// Still Search: the bundled local SearXNG service, started with the browser
// so Still opens like an app (no terminal). Same settings as the Electron build.
const SEARCH_PORT = 48230;
let search = null;
let searchStarted = false;

const SEARCH_SETTINGS = (secret) => `# Managed locally by Still Browser.
use_default_settings:
  engines:
    remove:
      - google
      - google images
      - google news
      - google videos
      - google cse
      - google cse images
      - google scholar
      - google play apps
      - google play movies
      - wikidata

general:
  debug: false
  instance_name: "Still Search"
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: ""
  # Site icons for results, fetched by Still Search itself (see faviconsFor).
  favicon_resolver: "duckduckgo"
  formats:
    - html
    - json

server:
  secret_key: "${secret}"
  bind_address: "127.0.0.1"
  limiter: false
  image_proxy: true
  method: "GET"

# More independent engines, so one engine refusing requests does not leave
# a search empty.
engines:
  - name: bing
    disabled: false
  - name: mojeek
    disabled: false
  - name: yahoo
    disabled: false
`;

// Still Search is the only search interface: when Firefox is about to show
// one of SearXNG's own pages in a tab (the "Search for..." menu, a typed
// address, a link inside SearXNG), the tab opens Still's results page for
// the same query instead. JSON requests from Still's page are left alone.
const SEARXNG_CATEGORIES = new Map([["general", "general"], ["images", "images"], ["videos", "videos"], ["news", "news"]]);
let redirectInstalled = false;

function stillSearchUrl(uri) {
  const startPage = lazy.BrowserWindowTracker.getTopWindow()?.BROWSER_NEW_TAB_URL || "";
  if (!/^moz-extension:\/\/[^/]+\/newtab\.html$/.test(startPage)) return "";
  let params;
  try { params = new URL(uri.spec).searchParams; } catch { return startPage; }
  const query = (params.get("q") || "").trim();
  if (!query) return startPage;
  const category = SEARXNG_CATEGORIES.get((params.get("categories") || params.get("category") || "general").split(",")[0]) || "general";
  const out = new URLSearchParams({ q: query });
  if (category !== "general") out.set("c", category);
  return `${startPage}?${out}`;
}

function installSearchRedirect() {
  if (redirectInstalled) return;
  redirectInstalled = true;
  Services.obs.addObserver((subject) => {
    let channel;
    try { channel = subject.QueryInterface(Ci.nsIHttpChannel); } catch { return; }
    const uri = channel.URI;
    if (uri.host !== "127.0.0.1" || uri.port !== SEARCH_PORT) return;
    const info = channel.loadInfo;
    if (info?.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) return;
    if (/[?&]format=json\b/.test(uri.spec)) return;
    const target = stillSearchUrl(uri);
    const browser = info.browsingContext?.top?.embedderElement;
    if (!target || !browser?.fixupAndLoadURIString) return;
    channel.cancel(Cr.NS_BINDING_ABORTED);
    lazy.setTimeout(() => {
      browser.fixupAndLoadURIString(target, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }, 0);
  }, "http-on-modify-request");
}

// Site icons for Still Search results. Firefox's own icon store first (sites
// you visited or imported), then Still Search's icon proxy, which fetches the
// icon itself so the page never talks to an icon service. When the proxy has
// no real icon it answers with SearXNG's generic one; that is treated as "no
// icon" and the page keeps its site letter.
const iconCache = new Map(); // host -> data URI or ""
let genericIcon = null;

async function searchSecret() {
  try {
    const settings = PathUtils.join(PathUtils.profileDir, "still-search", "settings.yml");
    return (await IOUtils.readUTF8(settings)).match(/secret_key:\s*"([a-f0-9]{64})"/)?.[1] || "";
  } catch {
    return "";
  }
}

async function hmacHex(win, secret, text) {
  const key = await win.crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await win.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function proxiedIcon(win, secret, host) {
  const url = `http://127.0.0.1:${SEARCH_PORT}/favicon_proxy?authority=${encodeURIComponent(host)}&h=${await hmacHex(win, secret, host)}`;
  const response = await win.fetch(url, { signal: win.AbortSignal.timeout(4000) });
  if (!response.ok) return "";
  const type = response.headers.get("content-type") || "image/png";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 200000) return "";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type.split(";")[0]};base64,${win.btoa(binary)}`;
}

async function placesIcon(url) {
  for (const candidate of [url, `${new URL(url).origin}/`]) {
    try {
      const favicon = await lazy.PlacesUtils.favicons.getFaviconForPage(Services.io.newURI(candidate), 32);
      const data = favicon?.dataURI?.spec;
      if (data?.startsWith("data:")) return data;
    } catch {}
  }
  return "";
}

async function faviconsFor(win, urls) {
  const result = {};
  const secret = await searchSecret();
  if (secret && genericIcon === null) {
    genericIcon = await proxiedIcon(win, secret, "still.invalid").catch(() => "");
  }
  await Promise.all(urls.map(async (url) => {
    let host;
    try { host = new URL(url).host; } catch { return; }
    if (!iconCache.has(host)) {
      iconCache.set(host, (async () => {
        const stored = await placesIcon(url);
        if (stored) return stored;
        if (!secret) return "";
        const fetched = await proxiedIcon(win, secret, host).catch(() => "");
        return fetched && fetched !== genericIcon ? fetched : "";
      })());
    }
    const icon = await iconCache.get(host);
    if (icon) result[url] = icon;
  }));
  return result;
}

// Identifies a service started with these exact settings. Not a secret (it
// only runs on this machine); it lets Still tell its current service apart
// from an older copy without sending a search anywhere.
let healthToken = "";
async function settingsToken(win) {
  if (healthToken) return healthToken;
  const bytes = new TextEncoder().encode(`still-search|${SEARCH_SETTINGS("")}`);
  const digest = await win.crypto.subtle.digest("SHA-256", bytes);
  healthToken = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return healthToken;
}

// "current": Still Search with today's settings answers; "stale": something
// else answers on the port (an older copy); "none": nothing there.
async function searchState(win) {
  const token = await settingsToken(win);
  try {
    const response = await win.fetch(`http://127.0.0.1:${SEARCH_PORT}/__still_searxng_health?token=${token}`,
      { signal: win.AbortSignal.timeout(1500), cache: "no-store" });
    return response.ok && (await response.text()) === "still-searxng-ok" ? "current" : "stale";
  } catch {
    return "none";
  }
}

// Windows job that closes with Firefox: processes in it end when Still ends,
// even if Firefox crashes or is force-closed, so nothing is left behind.
let job = null;
function bindToBrowser(pid) {
  if (Services.appinfo.OS !== "WINNT" || !pid) return;
  try {
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    const kernel32 = ctypes.open("kernel32.dll");
    const HANDLE = ctypes.voidptr_t;
    const BOOL = ctypes.int32_t;
    if (!job) {
      const CreateJobObjectW = kernel32.declare("CreateJobObjectW", ctypes.winapi_abi, HANDLE, ctypes.voidptr_t, ctypes.char16_t.ptr);
      const SetInformationJobObject = kernel32.declare("SetInformationJobObject", ctypes.winapi_abi, BOOL, HANDLE, ctypes.int32_t, ctypes.voidptr_t, ctypes.uint32_t);
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags sits at offset 16.
      const info = ctypes.uint8_t.array(144)();
      const flags = ctypes.cast(info.addressOfElement(16), ctypes.uint32_t.ptr);
      flags.contents = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      const handle = CreateJobObjectW(null, null);
      if (handle.isNull() || !SetInformationJobObject(handle, 9, info.address(), 144)) return;
      job = handle;
    }
    const OpenProcess = kernel32.declare("OpenProcess", ctypes.winapi_abi, HANDLE, ctypes.uint32_t, BOOL, ctypes.uint32_t);
    const AssignProcessToJobObject = kernel32.declare("AssignProcessToJobObject", ctypes.winapi_abi, BOOL, HANDLE, HANDLE);
    const CloseHandle = kernel32.declare("CloseHandle", ctypes.winapi_abi, BOOL, HANDLE);
    const process = OpenProcess(0x0101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (process.isNull()) return;
    AssignProcessToJobObject(job, process);
    CloseHandle(process);
  } catch (error) {
    console.error("Still could not tie a helper to the browser", error);
  }
}

// Ends copies of Still's own search service (matched by exact file path)
// that an earlier run left behind.
function stopStaleSearch(exePath) {
  try {
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    const kernel32 = ctypes.open("kernel32.dll");
    const HANDLE = ctypes.voidptr_t;
    const BOOL = ctypes.int32_t;
    const PROCESSENTRY32W = new ctypes.StructType("PROCESSENTRY32W", [
      { dwSize: ctypes.uint32_t }, { cntUsage: ctypes.uint32_t }, { th32ProcessID: ctypes.uint32_t },
      { th32DefaultHeapID: ctypes.uintptr_t }, { th32ModuleID: ctypes.uint32_t }, { cntThreads: ctypes.uint32_t },
      { th32ParentProcessID: ctypes.uint32_t }, { pcPriClassBase: ctypes.int32_t }, { dwFlags: ctypes.uint32_t },
      { szExeFile: ctypes.char16_t.array(260) }]);
    const snapshot = kernel32.declare("CreateToolhelp32Snapshot", ctypes.winapi_abi, HANDLE, ctypes.uint32_t, ctypes.uint32_t);
    const first = kernel32.declare("Process32FirstW", ctypes.winapi_abi, BOOL, HANDLE, PROCESSENTRY32W.ptr);
    const next = kernel32.declare("Process32NextW", ctypes.winapi_abi, BOOL, HANDLE, PROCESSENTRY32W.ptr);
    const OpenProcess = kernel32.declare("OpenProcess", ctypes.winapi_abi, HANDLE, ctypes.uint32_t, BOOL, ctypes.uint32_t);
    const QueryName = kernel32.declare("QueryFullProcessImageNameW", ctypes.winapi_abi, BOOL, HANDLE, ctypes.uint32_t, ctypes.char16_t.ptr, ctypes.uint32_t.ptr);
    const Terminate = kernel32.declare("TerminateProcess", ctypes.winapi_abi, BOOL, HANDLE, ctypes.uint32_t);
    const CloseHandle = kernel32.declare("CloseHandle", ctypes.winapi_abi, BOOL, HANDLE);
    const list = snapshot(0x2, 0);
    const entry = new PROCESSENTRY32W();
    entry.dwSize = PROCESSENTRY32W.size;
    const target = exePath.toLowerCase();
    for (let ok = first(list, entry.address()); ok; ok = next(list, entry.address())) {
      if (entry.szExeFile.readString().toLowerCase() !== "searxng-sidecar.exe") continue;
      const process = OpenProcess(0x1001, 0, entry.th32ProcessID); // QUERY_LIMITED_INFORMATION | TERMINATE
      if (process.isNull()) continue;
      const buffer = ctypes.char16_t.array(1024)();
      const size = ctypes.uint32_t(1024);
      if (QueryName(process, 0, buffer, size.address()) && buffer.readString().toLowerCase() === target) Terminate(process, 0);
      CloseHandle(process);
    }
    CloseHandle(list);
  } catch (error) {
    console.error("Still could not stop an old search service", error);
  }
}

// Once the service answers, load its settings and preferences pages. That
// initializes SearXNG (~0.1 s) without contacting any search engine, so the
// first real search takes ~0.3 s instead of ~1.5 s.
async function warmSearch(win, base) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const config = await win.fetch(`${base}config`, { signal: win.AbortSignal.timeout(3000) });
      if (config.ok) {
        await config.text();
        await (await win.fetch(`${base}preferences`, { signal: win.AbortSignal.timeout(3000) })).text();
        return;
      }
    } catch {}
    await new Promise((resolve) => win.setTimeout(resolve, 120));
  }
}

// Keeps Still Search available: starts it, and brings it back if it stops
// (crash, or a reused copy from elsewhere going away). Gives up after a few
// quick failures so a broken install does not spin.
function superviseSearch(win) {
  if (searchStarted) return;
  searchStarted = true;
  let failures = 0;
  const check = async () => {
    const current = lazy.BrowserWindowTracker.getTopWindow() || (win.closed ? null : win);
    if (search || !current) return;
    const started = Date.now();
    await runSearch(current);
    if (search) return;
    failures = Date.now() - started < 10000 ? failures + 1 : 0;
  };
  check();
  const timer = lazy.setInterval(() => {
    if (failures >= 3) { lazy.clearInterval(timer); return; }
    check();
  }, 15000);
}

async function runSearch(win) {
  const exe = stillFile("searxng", Services.appinfo.OS === "WINNT" ? "searxng-sidecar.exe" : "searxng-sidecar");
  if (!exe.exists()) return;
  if (search) return;
  const existing = await searchState(win);
  if (existing === "current") return;
  if (existing === "stale") {
    stopStaleSearch(exe.path);
    await new Promise((resolve) => win.setTimeout(resolve, 400));
  }
  try {
    const dir = PathUtils.join(PathUtils.profileDir, "still-search");
    await IOUtils.makeDirectory(dir, { permissions: 0o700 });
    const settings = PathUtils.join(dir, "settings.yml");
    let secret = "";
    try { secret = (await IOUtils.readUTF8(settings)).match(/secret_key:\s*"([a-f0-9]{64})"/)?.[1] || ""; } catch {}
    if (!secret) {
      secret = Array.from(win.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    }
    await IOUtils.writeUTF8(settings, SEARCH_SETTINGS(secret), { tmpPath: `${settings}.tmp` });
    const base = `http://127.0.0.1:${SEARCH_PORT}/`;
    search = await lazy.Subprocess.call({
      command: exe.path,
      arguments: [],
      workdir: exe.parent.path,
      environmentAppend: true,
      environment: {
        SEARXNG_SETTINGS_PATH: settings,
        SEARXNG_BIND_ADDRESS: "127.0.0.1",
        SEARXNG_PORT: String(SEARCH_PORT),
        SEARXNG_BASE_URL: base,
        SEARXNG_LIMITER: "false",
        SEARXNG_IMAGE_PROXY: "true",
        STILL_SEARXNG_PORT: String(SEARCH_PORT),
        STILL_SEARXNG_HEALTH_TOKEN: await settingsToken(win)
      },
      stderr: "stdout"
    });
    bindToBrowser(search.pid);
    warmSearch(win, base);
    // Keep reading so the service never blocks on a full output pipe; the
    // loop ends when the service exits.
    const running = search;
    (async () => {
      try { while (await running.stdout.readString()) { /* discard */ } } catch {}
      if (search === running) search = null;
    })();
  } catch (error) {
    console.error("Still Search did not start", error);
    search = null;
  }
}

// Still Search as Firefox's default engine (context menu "Search for...").
// Set by Still itself, so no extension asks you to approve the change.
let engineSet = false;
async function setSearchEngine() {
  if (engineSet) return;
  engineSet = true;
  try {
    const service = lazy.SearchService;
    await service.init();
    let engine = service.getEngineByName("Still Search");
    if (!engine) {
      engine = await service.addUserEngine({ name: "Still Search", url: `http://127.0.0.1:${SEARCH_PORT}/search?q={searchTerms}` });
    }
    if (service.defaultEngine?.name !== "Still Search") {
      await service.setDefault(engine, service.CHANGE_REASON.USER);
    }
  } catch (error) {
    console.error("Still could not set Still Search as the default engine", error);
  }
}

// Taskbar identity. Windows draws a taskbar button from the program file
// (firefox.exe) unless the window names its own app ID, icon, and display
// name, so every Still window declares them. Shortcuts and the taskbar pin use
// the same app ID (firefox/tools/create-shortcut.js).
export const STILL_APP_ID = "HotSweeper.Still";
let win32 = null;
let iconHandles = null;

function windowsApi() {
  if (win32) return win32;
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const user32 = ctypes.open("user32.dll");
  const shell32 = ctypes.open("shell32.dll");
  const GUID = new ctypes.StructType("GUID", [
    { d1: ctypes.uint32_t }, { d2: ctypes.uint16_t }, { d3: ctypes.uint16_t }, { d4: ctypes.uint8_t.array(8) }]);
  const PROPERTYKEY = new ctypes.StructType("PROPERTYKEY", [{ fmtid: GUID }, { pid: ctypes.uint32_t }]);
  const PROPVARIANT = new ctypes.StructType("PROPVARIANT", [
    { vt: ctypes.uint16_t }, { r1: ctypes.uint16_t }, { r2: ctypes.uint16_t }, { r3: ctypes.uint16_t },
    { value: ctypes.voidptr_t }, { extra: ctypes.voidptr_t }]);
  const guid = (text) => {
    const hex = text.replace(/-/g, "");
    const bytes = [];
    for (let i = 16; i < 32; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return new GUID(parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8, 12), 16), parseInt(hex.slice(12, 16), 16), bytes);
  };
  win32 = {
    ctypes, GUID, PROPERTYKEY, PROPVARIANT, guid,
    LoadImageW: user32.declare("LoadImageW", ctypes.winapi_abi, ctypes.voidptr_t,
      ctypes.voidptr_t, ctypes.char16_t.ptr, ctypes.uint32_t, ctypes.int32_t, ctypes.int32_t, ctypes.uint32_t),
    DwmSetWindowAttribute: ctypes.open("dwmapi.dll").declare("DwmSetWindowAttribute", ctypes.winapi_abi, ctypes.int32_t,
      ctypes.voidptr_t, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t),
    SendMessageW: user32.declare("SendMessageW", ctypes.winapi_abi, ctypes.intptr_t,
      ctypes.voidptr_t, ctypes.uint32_t, ctypes.uintptr_t, ctypes.intptr_t),
    SHGetPropertyStoreForWindow: shell32.declare("SHGetPropertyStoreForWindow", ctypes.winapi_abi, ctypes.int32_t,
      ctypes.voidptr_t, GUID.ptr, ctypes.voidptr_t.ptr),
    SetValue: ctypes.FunctionType(ctypes.winapi_abi, ctypes.int32_t, [ctypes.voidptr_t, PROPERTYKEY.ptr, PROPVARIANT.ptr]).ptr,
    Simple: ctypes.FunctionType(ctypes.winapi_abi, ctypes.uint32_t, [ctypes.voidptr_t]).ptr
  };
  return win32;
}

function setWindowProperties(hwnd, values) {
  const api = windowsApi();
  const { ctypes } = api;
  const store = ctypes.voidptr_t();
  const iid = api.guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
  const opened = api.SHGetPropertyStoreForWindow(hwnd, iid.address(), store.address());
  if (opened < 0 || store.isNull()) return [`open ${opened}`];
  const results = [];
  const vtable = ctypes.cast(store, ctypes.voidptr_t.ptr).contents;
  const slots = ctypes.cast(vtable, ctypes.voidptr_t.array(8).ptr).contents;
  const setValue = ctypes.cast(slots[6], api.SetValue);
  const fmtid = api.guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const keep = [];
  try {
    for (const [pid, text] of values) {
      const buffer = ctypes.char16_t.array()(text);
      keep.push(buffer);
      const key = new api.PROPERTYKEY(fmtid, pid);
      const value = new api.PROPVARIANT(31, 0, 0, 0, ctypes.cast(buffer.address(), ctypes.voidptr_t), null);
      results.push(setValue(store, key.address(), value.address()));
    }
    results.push(ctypes.cast(slots[7], api.Simple)(store));
  } finally {
    ctypes.cast(slots[2], api.Simple)(store);
  }
  return results;
}

// Cursor position relative to a window, in physical pixels, read straight
// from Windows. Used to reveal the slot bar at the top edge, where the resize
// border swallows normal mouse events.
let cursorApi = null;
function cursorInWindow(win) {
  if (Services.appinfo.OS !== "WINNT") return null;
  try {
    if (!cursorApi) {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const user32 = ctypes.open("user32.dll");
      const POINT = new ctypes.StructType("POINT", [{ x: ctypes.int32_t }, { y: ctypes.int32_t }]);
      const RECT = new ctypes.StructType("RECT", [{ left: ctypes.int32_t }, { top: ctypes.int32_t }, { right: ctypes.int32_t }, { bottom: ctypes.int32_t }]);
      cursorApi = {
        ctypes, POINT, RECT,
        GetCursorPos: user32.declare("GetCursorPos", ctypes.winapi_abi, ctypes.int32_t, POINT.ptr),
        GetClientRect: user32.declare("GetClientRect", ctypes.winapi_abi, ctypes.int32_t, ctypes.voidptr_t, RECT.ptr),
        ClientToScreen: user32.declare("ClientToScreen", ctypes.winapi_abi, ctypes.int32_t, ctypes.voidptr_t, POINT.ptr),
        IsIconic: user32.declare("IsIconic", ctypes.winapi_abi, ctypes.int32_t, ctypes.voidptr_t)
      };
    }
    const api = cursorApi;
    win.__stillHwnd ||= api.ctypes.voidptr_t(api.ctypes.UInt64(win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle));
    const hwnd = win.__stillHwnd;
    if (api.IsIconic(hwnd)) return null;
    const point = new api.POINT();
    const origin = new api.POINT(0, 0);
    const rect = new api.RECT();
    if (!api.GetCursorPos(point.address()) || !api.GetClientRect(hwnd, rect.address()) || !api.ClientToScreen(hwnd, origin.address())) return null;
    return { x: point.x - origin.x, y: point.y - origin.y, width: rect.right - rect.left, height: rect.bottom - rect.top };
  } catch {
    return null;
  }
}

// Hands a window move to Windows, exactly like pressing a title bar, so the
// drag, Aero Snap, and shake behave natively.
let moveApi = null;
function startWindowMove(win) {
  if (Services.appinfo.OS !== "WINNT") return false;
  try {
    if (!moveApi) {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      const user32 = ctypes.open("user32.dll");
      moveApi = {
        ctypes,
        ReleaseCapture: user32.declare("ReleaseCapture", ctypes.winapi_abi, ctypes.int32_t),
        PostMessageW: user32.declare("PostMessageW", ctypes.winapi_abi, ctypes.int32_t,
          ctypes.voidptr_t, ctypes.uint32_t, ctypes.uintptr_t, ctypes.intptr_t)
      };
    }
    const handle = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
    const hwnd = moveApi.ctypes.voidptr_t(moveApi.ctypes.UInt64(handle));
    moveApi.ReleaseCapture();
    // WM_NCLBUTTONDOWN on the caption (HTCAPTION = 2).
    return Boolean(moveApi.PostMessageW(hwnd, 0x00A1, 2, 0));
  } catch (error) {
    console.error("Still could not start moving the window", error);
    return false;
  }
}

function applyWindowIcon(win) {
  if (Services.appinfo.OS !== "WINNT") return;
  try {
    const file = stillFile("still.ico");
    if (!file.exists()) return;
    const api = windowsApi();
    const { ctypes } = api;
    const handle = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
    const hwnd = ctypes.voidptr_t(ctypes.UInt64(handle));
    const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    const results = setWindowProperties(hwnd, [
      [5, STILL_APP_ID],
      [2, `"${exe}" -profile "${profile}"`],
      [3, `${file.path},0`],
      [4, "Still"]
    ]);
    if (!iconHandles) {
      iconHandles = {
        big: api.LoadImageW(null, file.path, 1, 256, 256, 0x10),
        small: api.LoadImageW(null, file.path, 1, 32, 32, 0x10)
      };
    }
    for (const [size, icon] of [[1, iconHandles.big], [0, iconHandles.small]]) {

      if (!icon.isNull()) api.SendMessageW(hwnd, 0x80, size, ctypes.cast(icon, ctypes.intptr_t).value);
    }
    // A black window border, so no light frame shows around dark pages.
    const black = ctypes.uint32_t(0);
    api.DwmSetWindowAttribute(hwnd, 34, black.address(), 4);
    return results;
  } catch (error) {
    console.error("Still could not set its taskbar identity", error);
    return [String(error)];
  }
}

export const StillShared = {
  extensionReady,
  faviconsFor: (urls) => faviconsFor(lazy.BrowserWindowTracker.getTopWindow(), urls),
  startWindowMove,
  cursorInWindow,
  applyWindowIcon,
  // The startup animation plays once per app start, in the first window.
  claimSplash() {
    if (splashShown) return false;
    splashShown = true;
    return true;
  },
  pageMessage(browser, name, data) {
    const doc = browser?.ownerDocument;
    (doc ? windowHandlers.get(doc) : null)?.onPageMessage(browser, name, data);
  },
  attachWindow(win, handlers) {
    if (handlers) {
      const doc = win.document;
      windowHandlers.set(doc, handlers);
      win.addEventListener("unload", () => windowHandlers.delete(doc), { once: true });
    }
    superviseSearch(win);
    installSearchRedirect();
    setSearchEngine();
    applyWindowIcon(win);
    // Firefox may reset the icon once the window is shown.
    win.addEventListener("load", () => applyWindowIcon(win), { once: true });
    win.setTimeout(() => applyWindowIcon(win), 1500);
    startExtension();
  }
};
