// Still agent bridge. AI agents (through `still mcp` or `still agent`) use
// this browser with the person's own tabs and sign-ins.
//
// Clients talk newline-delimited JSON over a socket only this user can open
// ($XDG_RUNTIME_DIR/still/agent.sock; on Windows a loopback port plus a
// token in agent.json). The bridge drives pages through Firefox's own
// WebDriver BiDi engine, started in its "dynamic" mode that Firefox built for
// AI assistants: it does not set navigator.webdriver and does not change the
// profile's preferences. Page snapshots come from Playwright's injected
// script (still-agent-playwright.js), run in an isolated sandbox per frame.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  NavigableManager: "chrome://remote/content/shared/NavigableManager.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  WebDriverBiDiConnection: "chrome://remote/content/webdriver-bidi/WebDriverBiDiConnection.sys.mjs",
  UserContextManager: "chrome://remote/content/shared/UserContextManager.sys.mjs"
});

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const PROTOCOL = 1;
const PREF_ENABLED = "still.agent.enabled";
const PREF_DIR = "still.agent.dir";
const PREF_DEBUG = "still.agent.debug";
const SANDBOX = "still-agent";
const IDLE_STOP_MS = 3 * 60 * 1000;
const CALL_TIMEOUT_MS = 30000;
const encoder = new TextEncoder();

const KEYS = {
  enter: "", return: "", tab: "", escape: "", esc: "", backspace: "",
  delete: "", insert: "", space: " ", home: "", end: "", pageup: "",
  pagedown: "", arrowleft: "", arrowup: "", arrowright: "", arrowdown: "",
  left: "", up: "", right: "", down: "", shift: "", control: "",
  ctrl: "", alt: "", meta: "", cmd: "", super: "",
  f1: "", f2: "", f3: "", f4: "", f5: "", f6: "",
  f7: "", f8: "", f9: "", f10: "", f11: "", f12: ""
};
const MODIFIERS = new Set(["", "", "", ""]);

// Sites whose sign-in cookie is known, for "where am I signed in".
const KNOWN_SESSIONS = [
  ["google.com", "Google", ["SID", "__Secure-1PSID", "__Secure-3PSID"]],
  ["github.com", "GitHub", ["user_session", "logged_in"]],
  ["gitlab.com", "GitLab", ["_gitlab_session"]],
  ["x.com", "X", ["auth_token"]],
  ["twitter.com", "Twitter", ["auth_token"]],
  ["facebook.com", "Facebook", ["c_user"]],
  ["instagram.com", "Instagram", ["sessionid"]],
  ["reddit.com", "Reddit", ["reddit_session", "token_v2"]],
  ["linkedin.com", "LinkedIn", ["li_at"]],
  ["amazon.com", "Amazon", ["at-main", "sess-at-main"]],
  ["amazon.de", "Amazon", ["at-acbde", "sess-at-acbde"]],
  ["microsoft.com", "Microsoft", ["MSPAuth", "ESTSAUTH", "ESTSAUTHPERSISTENT"]],
  ["live.com", "Microsoft", ["MSPAuth", "ESTSAUTH", "ESTSAUTHPERSISTENT", "__Host-MSAAUTH"]],
  ["slack.com", "Slack", ["d"]],
  ["notion.so", "Notion", ["token_v2"]],
  ["openai.com", "OpenAI", ["__Secure-next-auth.session-token"]],
  ["chatgpt.com", "ChatGPT", ["__Secure-next-auth.session-token"]],
  ["claude.ai", "Claude", ["sessionKey"]],
  ["anthropic.com", "Anthropic", ["sessionKey"]],
  ["netflix.com", "Netflix", ["NetflixId"]],
  ["spotify.com", "Spotify", ["sp_dc"]],
  ["twitch.tv", "Twitch", ["auth-token"]],
  ["apple.com", "Apple", ["myacinfo"]],
  ["proton.me", "Proton", ["AUTH-"]],
  ["discord.com", "Discord", ["__Secure-recent_mfa"]],
  ["youtube.com", "YouTube", ["__Secure-3PSID", "SID", "LOGIN_INFO"]],
  ["paypal.com", "PayPal", ["login_email", "id_token"]],
  ["ebay.de", "eBay", ["s", "nonsession"]],
  ["vercel.com", "Vercel", ["authorization"]],
  ["figma.com", "Figma", ["figma.st"]],
  ["stackoverflow.com", "Stack Overflow", ["acct"]],
  ["huggingface.co", "Hugging Face", ["token"]],
  ["npmjs.com", "npm", ["npm-session"]]
];
const SESSION_COOKIE = /(^|[_.-])(session|sess|sid|auth|token|logged_?in|login|jwt|access)([_.-]|$)/i;

let playwrightSource = null;
let started = false;

// ---------------------------------------------------------------- helpers

function agentDir() {
  const custom = Services.prefs.getStringPref(PREF_DIR, "");
  if (custom) return custom;
  if (Services.appinfo.OS === "WINNT") {
    return PathUtils.join(Services.dirsvc.get("LocalAppData", Ci.nsIFile).path, "Still");
  }
  const runtime = Services.env.get("XDG_RUNTIME_DIR");
  return runtime ? PathUtils.join(runtime, "still") : PathUtils.join(PathUtils.tempDir, `still-${Services.env.get("USER") || "user"}`);
}

function fail(message, code = "error") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(fail(`${what} timed out after ${Math.round(ms / 1000)} s`, "timeout")), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function binaryString(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return out;
}

function stillWindow() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed && win.document.documentElement.hasAttribute("still") && win.StillChrome) return win;
  }
  return null;
}

function allTabs() {
  const tabs = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.closed || !win.gBrowser) continue;
    for (const tab of win.gBrowser.tabs) if (!tab.closing) tabs.push(tab);
  }
  return tabs;
}

function tabUrl(tab) {
  return tab.linkedBrowser?.currentURI?.spec || "";
}

function tabById(id) {
  const wanted = Number(id);
  const tab = allTabs().find((candidate) => candidate.linkedBrowser?.browserId === wanted);
  if (!tab) throw fail(`No tab with id ${id}. Call tabs to see the open tabs.`, "no_tab");
  return tab;
}

function contextIdForTab(tab) {
  return lazy.NavigableManager.getIdForBrowser(tab.linkedBrowser);
}

function tabForContext(contextId) {
  return allTabs().find((tab) => contextIdForTab(tab) === contextId) || null;
}

function describeTab(tab) {
  const win = tab.ownerDocument.defaultView;
  const still = win.StillChrome;
  const browser = tab.linkedBrowser;
  const info = {
    id: browser.browserId,
    title: tab.label || "",
    url: tabUrl(tab),
    active: win.gBrowser.selectedTab === tab && win === Services.wm.getMostRecentBrowserWindow(),
    loading: tab.hasAttribute("busy"),
    agent: Boolean(tab.stillAgent),
    place: "slot"
  };
  if (still) {
    const slot = still.slotIndex?.(tab);
    if (tab.stillAgent || tab.hidden) info.place = "agent";
    else if (slot >= 0) info.slot = slot + 1;
  } else {
    info.place = "popup";
    const opener = browser.browsingContext?.opener?.top?.embedderElement;
    const openerTab = opener && opener.ownerDocument.defaultView.gBrowser?.getTabForBrowser(opener);
    if (openerTab) info.opener = openerTab.linkedBrowser.browserId;
  }
  if (tab.soundPlaying) info.audible = true;
  return info;
}

function keyValue(name) {
  if (name.length === 1) return name;
  const key = KEYS[name.toLowerCase()];
  if (!key) throw fail(`Unknown key "${name}". Use names like Enter, Tab, Escape, ArrowDown, Control+a.`, "bad_key");
  return key;
}

function keyActions(combo) {
  // "Control+Shift+K" or "Enter"; a lone "+" is the plus key.
  const parts = combo === "+" ? ["+"] : combo.split(/\+(?!$)/).map((part) => part.trim()).filter(Boolean);
  const values = parts.map(keyValue);
  const actions = [];
  for (const value of values) actions.push({ type: "keyDown", value });
  for (const value of [...values].reverse()) actions.push({ type: "keyUp", value });
  return actions;
}

function textActions(text) {
  const actions = [];
  for (const char of text) {
    const value = char === "\n" ? "" : char;
    actions.push({ type: "keyDown", value }, { type: "keyUp", value });
  }
  return actions;
}

// ------------------------------------------------------------ BiDi client

class BidiClient {
  constructor(onEvent, onClose) {
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.nextId = 0;
    this.pending = new Map();
    this.socket = null;
    this.open = false;
  }

  // Connect in-process: Firefox's BiDi connection only needs an object that
  // behaves like a WebSocket, so no socket, port or Origin check is involved
  // and no other program can reach this session.
  connect(webDriverBiDi) {
    const client = this;
    const listeners = { message: new Set(), close: new Set() };
    const fire = (type, event) => {
      for (const listener of [...listeners[type]]) {
        try { typeof listener === "function" ? listener(event) : listener.handleEvent({ type, ...event }); } catch (error) { console.error(error); }
      }
    };
    this.socket = {
      addEventListener(type, listener) { listeners[type]?.add(listener); },
      removeEventListener(type, listener) { listeners[type]?.delete(listener); },
      // Engine to client.
      send(text) { Promise.resolve().then(() => client.receive(text)); },
      close() {
        Promise.resolve().then(() => {
          fire("close", {});
          if (client.open) { client.open = false; client.rejectAll(); client.onClose?.(); }
        });
      }
    };
    this.deliver = (text) => Promise.resolve().then(() => fire("message", { data: text }));
    this.connection = new lazy.WebDriverBiDiConnection(this.socket, { close() {} });
    webDriverBiDi.addSessionlessConnection(this.connection);
    this.open = true;
  }

  rejectAll() {
    for (const { reject } of this.pending.values()) reject(fail("The browser engine connection closed", "closed"));
    this.pending.clear();
  }

  receive(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === "error") reject(fail(message.message || message.error, message.error));
      else resolve(message.result);
    } else if (message.type === "event") {
      try { this.onEvent(message.method, message.params); } catch (error) { console.error(error); }
    }
  }

  send(method, params = {}, timeout = CALL_TIMEOUT_MS) {
    if (!this.open) return Promise.reject(fail("The browser engine is not connected", "closed"));
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.deliver(JSON.stringify({ id, method, params }));
    return withTimeout(promise, timeout, method).catch((error) => {
      this.pending.delete(id);
      throw error;
    });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    try { this.connection?.close(); } catch {}
    this.rejectAll();
  }
}

// ------------------------------------------------------- control clients

class Connection {
  constructor(bridge, transport) {
    this.bridge = bridge;
    this.transport = transport;
    this.input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    this.output = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
    this.reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    this.reader.setInputStream(this.input);
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.queue = [];
    this.closed = false;
    this.client = "agent";
    this.authorized = !bridge.token;
    this.events = [];
    this.QueryInterface = ChromeUtils.generateQI(["nsIInputStreamCallback", "nsIOutputStreamCallback"]);
    this.input.asyncWait(this, 0, 0, Services.tm.mainThread);
  }

  onInputStreamReady() {
    if (this.closed) return;
    let available = 0;
    try { available = this.input.available(); } catch { this.close(); return; }
    if (!available) { this.close(); return; }
    const bytes = this.reader.readByteArray(available);
    this.buffer += this.decoder.decode(new Uint8Array(bytes), { stream: true });
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.bridge.handle(this, line);
    }
    if (this.buffer.length > 8 * 1024 * 1024) { this.close(); return; }
    this.input.asyncWait(this, 0, 0, Services.tm.mainThread);
  }

  send(message) {
    if (this.closed) return;
    this.queue.push(encoder.encode(JSON.stringify(message) + "\n"));
    this.flush();
  }

  flush() {
    while (this.queue.length && !this.closed) {
      const chunk = this.queue[0];
      const piece = chunk.subarray(0, 0x10000);
      let written;
      try {
        written = this.output.write(binaryString(piece), piece.length);
      } catch (error) {
        if (error.result === Cr.NS_BASE_STREAM_WOULD_BLOCK) { this.output.asyncWait(this, 0, 0, Services.tm.mainThread); return; }
        this.close();
        return;
      }
      if (written < chunk.length) this.queue[0] = chunk.subarray(written);
      else this.queue.shift();
    }
  }

  onOutputStreamReady() { this.flush(); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.input.close(); } catch {}
    try { this.output.close(); } catch {}
    try { this.transport.close(Cr.NS_OK); } catch {}
    this.bridge.dropConnection(this);
  }
}

// ------------------------------------------------------------- the bridge

class Bridge {
  constructor() {
    this.connections = new Set();
    this.server = null;
    this.token = "";
    this.bidi = null;
    this.engineStarting = null;
    this.idleTimer = null;
    this.frameSeq = new Map();
    this.nextSeq = 1;
    this.prompts = new Map();
    this.promptWaiters = new Set();
    this.selfOpened = new Set();
  }

  // ------------------------------------------------------ socket server

  async listen() {
    const dir = agentDir();
    await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 });
    try { await IOUtils.setPermissions(dir, 0o700); } catch {}
    const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    const info = { protocol: PROTOCOL, pid: Services.appinfo.processID };
    if (Services.appinfo.OS === "WINNT") {
      this.token = Services.uuid.generateUUID().toString().replace(/[{}-]/g, "") + Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
      server.initSpecialConnection(-1, Ci.nsIServerSocket.LoopbackOnly, -1);
      Object.assign(info, { port: server.port, token: this.token });
    } else {
      const socketPath = PathUtils.join(dir, "agent.sock");
      await IOUtils.remove(socketPath, { ignoreAbsent: true });
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(socketPath);
      server.initWithFilename(file, 0o600, -1);
      info.socket = socketPath;
    }
    server.asyncListen({
      QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
      onSocketAccepted: (socket, transport) => this.connections.add(new Connection(this, transport)),
      onStopListening: () => {}
    });
    this.server = server;
    this.infoPath = PathUtils.join(dir, "agent.json");
    await IOUtils.writeUTF8(this.infoPath, JSON.stringify(info), { mode: "overwrite" });
    try { await IOUtils.setPermissions(this.infoPath, 0o600); } catch {}
    Services.obs.addObserver(() => this.shutdown(), "quit-application-granted");
  }

  shutdown() {
    for (const connection of [...this.connections]) connection.close();
    try { this.server?.close(); } catch {}
    this.server = null;
    if (this.infoPath) IOUtils.remove(this.infoPath, { ignoreAbsent: true }).catch(() => {});
    this.stopEngine();
  }

  dropConnection(connection) {
    this.connections.delete(connection);
    this.updateUi();
    if (!this.connections.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.connections.size) this.stopEngine(); }, IDLE_STOP_MS);
    }
  }

  clients() {
    return [...this.connections].filter((connection) => connection.authorized).map((connection) => connection.client);
  }

  updateUi(activity) {
    const win = stillWindow();
    try { win?.StillChrome.agent?.update({ clients: this.clients(), engine: Boolean(this.bidi?.open), activity }); } catch (error) { console.error(error); }
  }

  async handle(connection, line) {
    let message;
    try { message = JSON.parse(line); } catch { connection.send({ error: { message: "Invalid JSON", code: "bad_request" } }); return; }
    const { id, method, params = {} } = message;
    try {
      if (method === "hello") {
        if (this.token && params.token !== this.token) throw fail("Wrong token", "unauthorized");
        connection.authorized = true;
        connection.client = String(params.client || "agent").slice(0, 60);
        this.updateUi();
        connection.send({ id, result: { still: true, protocol: PROTOCOL, version: Services.appinfo.version } });
        return;
      }
      if (!connection.authorized) throw fail("Say hello with the token first", "unauthorized");
      if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) throw fail("Agent access is turned off in Still", "disabled");
      const handler = METHODS[method];
      if (!handler) throw fail(`Unknown method ${method}`, "unknown_method");
      clearTimeout(this.idleTimer);
      const result = await handler.call(this, params, connection);
      const events = connection.events.splice(0);
      connection.send({ id, result, ...(events.length ? { events } : {}) });
    } catch (error) {
      if (!(error instanceof Error) || !error.code) console.error("Still agent:", error);
      const events = connection.events.splice(0);
      connection.send({ id, error: { message: error?.message || String(error), code: error?.code || "error" }, ...(events.length ? { events } : {}) });
    }
  }

  // Tell every client about something it did not ask for (a popup, a dialog).
  broadcast(event) {
    for (const connection of this.connections) {
      if (connection.authorized && connection.events.length < 50) connection.events.push(event);
    }
  }

  // ------------------------------------------------------------ engine

  async engine() {
    if (this.bidi?.open) return this.bidi;
    this.engineStarting ||= this.startEngine().finally(() => { this.engineStarting = null; });
    return this.engineStarting;
  }

  async startEngine() {
    const defaults = Services.prefs.getDefaultBranch("");
    defaults.setBoolPref("remote.experimental.dynamicstart.enabled", true);
    // Still shows its own indicator and Stop button instead of Firefox's
    // prompt and banners (which live in the toolbar Still hides).
    defaults.setBoolPref("remote.experimental.dynamicstart.prompt.enabled", false);
    defaults.setBoolPref("remote.experimental.dynamicstart.banner.enabled", false);
    defaults.setBoolPref("remote.experimental.dynamicstart.connectionbanner.enabled", false);
    // Firefox 156 puts dynamic sessions in a separate "remote control"
    // container, which would hide the person's sign-ins from their own
    // agent. Point that container at the default one instead.
    const manager = lazy.UserContextManager;
    if (!manager.__stillDefaultContext) {
      const original = manager.getUserContextIdsByName.bind(manager);
      manager.getUserContextIdsByName = (name) => name === "remote-control-container" ? ["default"] : original(name);
      manager.__stillDefaultContext = true;
    }
    const agent = Cc["@mozilla.org/remote/agent;1"].getService(Ci.nsIRemoteAgent).wrappedJSObject;
    let port = agent.running ? agent.port : await agent.startAtRuntime({ isBrowserAutomation: false });
    if (port === -1) throw fail("Firefox refused to start its automation engine", "engine");
    this.ownsEngine = !agent.isBrowserAutomationRunning;
    const bidi = new BidiClient((method, params) => this.onEngineEvent(method, params), () => {
      if (this.bidi === bidi) { this.bidi = null; this.updateUi(); }
    });
    if (!agent.webDriverBiDi) throw fail("Firefox's automation engine is not available", "engine");
    bidi.connect(agent.webDriverBiDi);
    await bidi.send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
    // Subscribing replays "created" events for tabs that already exist.
    this.replayUntil = Date.now() + 1500;
    await bidi.send("session.subscribe", {
      events: ["browsingContext.contextCreated", "browsingContext.contextDestroyed", "browsingContext.userPromptOpened",
        "browsingContext.userPromptClosed", "browsingContext.downloadWillBegin"]
    });
    this.bidi = bidi;
    this.updateUi();
    return bidi;
  }

  async stopEngine() {
    const bidi = this.bidi;
    this.bidi = null;
    this.prompts.clear();
    if (bidi?.open) {
      try { await bidi.send("session.end", {}, 3000); } catch {}
      bidi.close();
    }
    if (this.ownsEngine) {
      try {
        const agent = Cc["@mozilla.org/remote/agent;1"].getService(Ci.nsIRemoteAgent).wrappedJSObject;
        if (agent.isDynamicStartRunning) await agent.stopAtRuntime();
      } catch (error) { console.error(error); }
    }
    this.updateUi();
  }

  onEngineEvent(method, params) {
    if (method === "browsingContext.userPromptOpened") {
      this.prompts.set(params.context, params);
      for (const waiter of [...this.promptWaiters]) waiter(params.context);
      const tab = tabForContext(params.context);
      this.broadcast({ type: "dialog", tab: tab?.linkedBrowser.browserId, dialog: params.type, message: params.message, defaultValue: params.defaultValue });
    } else if (method === "browsingContext.userPromptClosed") {
      this.prompts.delete(params.context);
    } else if (method === "browsingContext.contextCreated" && !params.parent && Date.now() > (this.replayUntil || 0)) {
      // Let the tab finish attaching before describing it.
      setTimeout(() => {
        const tab = tabForContext(params.context);
        if (!tab) return;
        if (this.selfOpened.delete(tab.linkedBrowser.browserId)) return;
        const info = describeTab(tab);
        if (info.place === "popup" || info.agent || info.opener) this.broadcast({ type: "tab-opened", tab: info });
      }, 50);
    } else if (method === "browsingContext.contextDestroyed" && !params.parent) {
      this.frameSeq.delete(params.context);
      this.broadcast({ type: "tab-closed", context: params.context });
    } else if (method === "browsingContext.downloadWillBegin") {
      this.broadcast({ type: "download", file: params.suggestedFilename, url: params.url });
    }
  }

  // ------------------------------------------------------ page scripts

  async call(context, fn, args = [], { awaitPromise = true, timeout } = {}) {
    const bidi = await this.engine();
    const prompt = this.prompts.get(context);
    if (prompt) throw fail(`A ${prompt.type} dialog is open on this tab: "${prompt.message}". Handle it with the dialog tool first.`, "dialog_open");
    const result = await bidi.send("script.callFunction", {
      functionDeclaration: fn,
      arguments: args,
      awaitPromise,
      target: { context, sandbox: SANDBOX },
      resultOwnership: "none",
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 6 }
    }, timeout);
    if (result.type === "exception") {
      const details = result.exceptionDetails;
      throw fail(details?.text || "The page script failed", "script");
    }
    return result.result;
  }

  // Top-level pages use frame number 0, so their refs read e12; frames get
  // their own number (refs like f3e12) so a ref always finds its frame.
  async inject(context, top = false) {
    if (!this.frameSeq.has(context)) this.frameSeq.set(context, top ? 0 : this.nextSeq++);
    const ready = await this.call(context, "() => !!globalThis.__stillAgent");
    if (ready.value) return;
    if (playwrightSource === null) {
      const resolved = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler)
        .resolveURI(Services.io.newURI("resource://still/still-agent-playwright.js"));
      playwrightSource = await IOUtils.readUTF8(Services.io.newURI(resolved).QueryInterface(Ci.nsIFileURL).file.path);
    }
    const options = {
      isUnderTest: false, sdkLanguage: "javascript", frameSeq: this.frameSeq.get(context), testIdAttributeName: "data-testid",
      stableRafCount: 1, browserName: "firefox", shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: []
    };
    const bidi = await this.engine();
    const result = await bidi.send("script.evaluate", {
      expression: `(() => { const module = {}; ${playwrightSource}\n; globalThis.__stillAgent = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)}); return true; })()`,
      awaitPromise: false,
      target: { context, sandbox: SANDBOX },
      resultOwnership: "none"
    });
    if (result.type === "exception") throw fail(`Could not prepare the page: ${result.exceptionDetails?.text}`, "script");
  }

  // Snapshot one frame, then each iframe inside it, stitched into one tree.
  async snapshotFrame(context, depth = 0) {
    await this.inject(context, depth === 0);
    const result = await this.call(context, `() => {
      const agent = globalThis.__stillAgent;
      const root = document.body || document.documentElement;
      if (!root) return { yaml: "", frames: [] };
      const yaml = agent.ariaSnapshot(root, { mode: "ai" });
      const tree = agent._lastAriaSnapshotForQuery;
      const frames = (tree?.iframeRefs || []).map((ref) => [ref, tree.info.get(ref)?.element?.contentWindow || null]);
      return { yaml, frames };
    }`);
    const value = unpack(result);
    let lines = String(value.yaml || "").split("\n");
    if (depth < 3) {
      for (const [ref, frame] of value.frames || []) {
        const childContext = frame?.context;
        if (!childContext) continue;
        let child = "";
        try { child = await this.snapshotFrame(childContext, depth + 1); } catch (error) { child = `- note: frame could not be read (${error.message})`; }
        const at = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
        if (at < 0 || !child) continue;
        const indent = lines[at].match(/^\s*/)[0] + "  ";
        if (!lines[at].trimEnd().endsWith(":")) lines[at] = lines[at].trimEnd() + ":";
        lines.splice(at + 1, 0, ...child.split("\n").filter(Boolean).map((line) => indent + line));
      }
    }
    return lines.join("\n");
  }

  frameForRef(tab, ref) {
    const top = contextIdForTab(tab);
    const match = /^f(\d+)e\d+$/.exec(ref);
    if (!/^(f\d+)?e\d+$/.test(ref)) throw fail(`"${ref}" is not a ref. Refs look like e12; take a snapshot to get them.`, "bad_ref");
    if (!match) return top;
    const seq = Number(match[1]);
    for (const [context, value] of this.frameSeq) if (value === seq) return context;
    throw fail(`The frame for ${ref} is gone. Take a new snapshot.`, "stale_ref");
  }

  // Resolve a ref, scroll it into view and check what is at its centre.
  async locate(tab, ref, { scroll = true } = {}) {
    const context = this.frameForRef(tab, ref);
    await this.inject(context, context === contextIdForTab(tab));
    const result = await this.call(context, `(ref, scroll) => {
      const info = globalThis.__stillAgent?._lastAriaSnapshotForQuery?.info.get(ref);
      const element = info?.element;
      if (!element || !element.isConnected) return { missing: true };
      if (scroll) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const root = element.getRootNode();
      const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
      const inside = (node) => { for (let n = node; n; n = n.parentNode || n.host) if (n === element) return true; return false; };
      const covered = rect.width && rect.height && hit && !inside(hit) && !hit.contains(element)
        ? (hit.getAttribute("aria-label") || hit.textContent || hit.tagName).trim().replace(/\\s+/g, " ").slice(0, 60) : "";
      return { element, x, y, width: rect.width, height: rect.height, covered,
        tag: element.tagName.toLowerCase(), type: element.type || "", disabled: !!element.disabled };
    }`, [{ type: "string", value: ref }, { type: "boolean", value: scroll }]);
    const value = unpack(result, true);
    if (value.missing) throw fail(`Element ${ref} is no longer on the page. Take a new snapshot.`, "stale_ref");
    if (!value.width && !value.height) throw fail(`Element ${ref} is not visible.`, "not_visible");
    return { context, ...value };
  }

  // An action that opens alert/confirm/prompt only finishes once the dialog
  // closes, so treat a dialog opening on that page as the action's end.
  async act(context, method, params) {
    const bidi = await this.engine();
    const top = topContextOf(context);
    let stopWaiting;
    const dialog = new Promise((resolve) => {
      stopWaiting = () => this.promptWaiters.delete(waiter);
      const waiter = (opened) => { if (opened === top || opened === context) { stopWaiting(); resolve("dialog"); } };
      this.promptWaiters.add(waiter);
    });
    const sent = bidi.send(method, params);
    sent.catch(() => {});
    try {
      return await Promise.race([sent, dialog]);
    } finally {
      stopWaiting();
    }
  }

  async pointer(context, steps) {
    return this.act(context, "input.performActions", {
      context,
      actions: [{ type: "pointer", id: "still-mouse", parameters: { pointerType: "mouse" }, actions: steps }]
    });
  }

  async keys(context, actions) {
    const result = await this.act(context, "input.performActions", { context, actions: [{ type: "key", id: "still-keys", actions }] });
    if (result !== "dialog") await (await this.engine()).send("input.releaseActions", { context });
    return result;
  }

  touch(tab, label) {
    this.updateUi({ tab: tab.linkedBrowser.browserId, label });
  }
}

// Plain JSON to a BiDi argument.
function toLocalValue(value) {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (Array.isArray(value)) return { type: "array", value: value.map(toLocalValue) };
  switch (typeof value) {
    case "string": return { type: "string", value };
    case "boolean": return { type: "boolean", value };
    case "number": return { type: "number", value: Number.isFinite(value) ? value : String(value) };
    case "object": return { type: "object", value: Object.entries(value).map(([key, item]) => [key, toLocalValue(item)]) };
    default: return { type: "string", value: String(value) };
  }
}

// BiDi remote values to plain JSON.
function unpack(remote, keepNodes = false) {
  if (!remote || typeof remote !== "object") return remote;
  switch (remote.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": case "number": case "boolean": return remote.value === "NaN" ? NaN : remote.value;
    case "bigint": return String(remote.value);
    case "array": case "set": return (remote.value || []).map((item) => unpack(item, keepNodes));
    case "object": case "map": {
      const out = {};
      for (const [key, value] of remote.value || []) out[typeof key === "string" ? key : unpack(key)] = unpack(value, keepNodes);
      return out;
    }
    case "window": return { context: remote.value?.context };
    case "node": return keepNodes ? { sharedId: remote.sharedId } : `<${remote.value?.localName || "node"}>`;
    case "date": return remote.value;
    case "regexp": return `/${remote.value?.pattern}/${remote.value?.flags || ""}`;
    default: return `[${remote.type}]`;
  }
}

// "mail.google.com" -> "google.com"; IP addresses and localhost stay as they are.
function siteOf(hostOrUrl) {
  let host = hostOrUrl;
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostOrUrl)) host = Services.io.newURI(hostOrUrl).host; } catch { return ""; }
  if (!host) return "";
  try { return Services.eTLD.getBaseDomainFromHost(host); } catch { return host; }
}

// The top-level page a frame belongs to.
function topContextOf(context) {
  try {
    const browsingContext = lazy.NavigableManager.getBrowsingContextById(context);
    const top = browsingContext?.top;
    return top?.embedderElement ? lazy.NavigableManager.getIdForBrowser(top.embedderElement) : context;
  } catch {
    return context;
  }
}

function header(tab) {
  const info = describeTab(tab);
  return `Tab ${info.id}${info.slot ? ` (slot ${info.slot})` : info.place === "agent" ? " (agent tab)" : info.place === "popup" ? " (popup window)" : ""}: ${info.title || "Untitled"}\nURL: ${info.url}`;
}

async function waitForLoad(tab, timeout = 15000) {
  const end = Date.now() + timeout;
  await sleep(120);
  while (tab.hasAttribute("busy") && Date.now() < end) await sleep(100);
}

function truncate(text, max) {
  if (!max || text.length <= max) return text;
  return text.slice(0, max) + `\n… cut at ${max} characters (of ${text.length}). Ask for a ref's subtree or raise max_chars for more.`;
}

// ---------------------------------------------------------------- methods

const METHODS = {
  async status() {
    return { engine: Boolean(this.bidi?.open), clients: this.clients(), tabs: allTabs().length, version: Services.appinfo.version };
  },

  // ---- tabs

  async "tabs.list"() {
    return { tabs: allTabs().map(describeTab) };
  },

  async "tabs.open"({ url = "about:blank", visible = false, wait = true }) {
    const win = stillWindow();
    if (!win) throw fail("Still has no open window", "no_window");
    // A blank tab first, then a real navigation through the engine, so the
    // page always loads (and we know when) even while Still is starting.
    const tab = win.StillChrome.agent.openTab("about:blank", { visible });
    this.selfOpened.add(tab.linkedBrowser.browserId);
    this.touch(tab, "Opened a tab");
    if (url && url !== "about:blank") {
      await sleep(50);
      await METHODS["tabs.navigate"].call(this, { tab: tab.linkedBrowser.browserId, url, wait });
    }
    return { tab: describeTab(tab) };
  },

  async "tabs.select"({ tab: id }) {
    const tab = tabById(id);
    const win = tab.ownerDocument.defaultView;
    if (win.StillChrome?.agent) win.StillChrome.agent.showTab(tab);
    else win.gBrowser.selectedTab = tab;
    win.focus();
    return { tab: describeTab(tab) };
  },

  async "tabs.close"({ tab: id }) {
    const tab = tabById(id);
    const info = describeTab(tab);
    tab.ownerDocument.defaultView.gBrowser.removeTab(tab, { animate: false });
    return { closed: info };
  },

  async "tabs.navigate"({ tab: id, url, action, wait = true }) {
    const tab = tabById(id);
    const bidi = await this.engine();
    const context = contextIdForTab(tab);
    this.touch(tab, "Navigating");
    if (action === "back" || action === "forward") {
      await bidi.send("browsingContext.traverseHistory", { context, delta: action === "back" ? -1 : 1 });
    } else if (action === "reload") {
      await bidi.send("browsingContext.reload", { context, wait: "complete" }, 45000).catch((error) => { if (error.code !== "timeout") throw error; });
    } else {
      if (!url) throw fail("Give a url or an action (back, forward, reload)", "bad_request");
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(url) ? `https://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
      await bidi.send("browsingContext.navigate", { context, url, wait: wait ? "interactive" : "none" }, 45000).catch((error) => { if (error.code !== "timeout") throw error; });
    }
    if (wait) await waitForLoad(tab, 10000);
    return { tab: describeTab(tab) };
  },

  // ---- reading

  async "page.snapshot"({ tab: id, max_chars = 60000 }) {
    const tab = tabById(id);
    this.touch(tab, "Reading the page");
    const yaml = await this.snapshotFrame(contextIdForTab(tab));
    const prompt = this.prompts.get(contextIdForTab(tab));
    return {
      tab: describeTab(tab),
      text: `${header(tab)}${prompt ? `\nDialog open (${prompt.type}): ${prompt.message}` : ""}\n\n${truncate(yaml, max_chars)}`
    };
  },

  async "page.text"({ tab: id, max_chars = 40000, links = false }) {
    const tab = tabById(id);
    this.touch(tab, "Reading the page");
    const context = contextIdForTab(tab);
    const result = await this.call(context, `(withLinks) => {
      const main = document.querySelector("main, [role=main], article") || document.body || document.documentElement;
      let text = (main?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
      if (main !== document.body && document.body && text.length < 200) text = document.body.innerText.trim();
      const out = { title: document.title, text };
      if (withLinks) out.links = [...document.querySelectorAll("a[href]")].filter((a) => a.offsetParent && a.innerText.trim())
        .slice(0, 300).map((a) => ({ text: a.innerText.trim().replace(/\\s+/g, " ").slice(0, 120), href: a.href }));
      return out;
    }`, [{ type: "boolean", value: Boolean(links) }]);
    const value = unpack(result);
    return { tab: describeTab(tab), text: `${header(tab)}\n\n${truncate(value.text || "", max_chars)}`, links: value.links };
  },

  async "page.screenshot"({ tab: id, ref, full_page = false }) {
    const tab = tabById(id);
    const bidi = await this.engine();
    const context = contextIdForTab(tab);
    const params = { context, origin: full_page ? "document" : "viewport", format: { type: "image/png" } };
    if (ref) {
      const located = await this.locate(tab, ref);
      params.context = located.context;
      params.clip = { type: "element", element: located.element };
    }
    const result = await bidi.send("browsingContext.captureScreenshot", params, 45000);
    return { tab: describeTab(tab), image: result.data, mimeType: "image/png" };
  },

  async "page.evaluate"({ tab: id, script, args = [] }) {
    const tab = tabById(id);
    this.touch(tab, "Running a script");
    const bidi = await this.engine();
    const context = contextIdForTab(tab);
    const prompt = this.prompts.get(context);
    if (prompt) throw fail(`A ${prompt.type} dialog is open: "${prompt.message}". Handle it first.`, "dialog_open");
    const source = /^\s*(async\s+)?(\(|function\b|[\w$]+\s*=>)/.test(script) ? script : `() => (${script})`;
    const result = await bidi.send("script.callFunction", {
      functionDeclaration: source,
      arguments: args.map(toLocalValue),
      awaitPromise: true,
      target: { context },
      resultOwnership: "none",
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 8 }
    }, 60000);
    if (result.type === "exception") throw fail(result.exceptionDetails?.text || "Script failed", "script");
    return { tab: describeTab(tab), result: unpack(result.result) };
  },

  async "page.wait"({ tab: id, text, gone, time, timeout = 15000 }) {
    const tab = tabById(id);
    if (time) await sleep(Math.min(Number(time) * 1000, 60000));
    if (!text && !gone) return { tab: describeTab(tab) };
    const context = contextIdForTab(tab);
    const end = Date.now() + Math.min(timeout, 120000);
    while (Date.now() < end) {
      try {
        const result = await this.call(context, `(want, notWant) => {
          const body = document.body?.innerText || "";
          return (!want || body.includes(want)) && (!notWant || !body.includes(notWant));
        }`, [{ type: "string", value: text || "" }, { type: "string", value: gone || "" }]);
        if (result.value) return { tab: describeTab(tab), found: true };
      } catch (error) {
        if (error.code === "dialog_open") throw error;
      }
      await sleep(250);
    }
    throw fail(text ? `"${text}" did not appear within ${Math.round(timeout / 1000)} s` : `"${gone}" did not go away`, "timeout");
  },

  // ---- acting

  async "input.click"({ tab: id, ref, button = "left", double = false, modifiers = [], force = false }) {
    const tab = tabById(id);
    const target = await this.locate(tab, ref);
    if (target.covered && !force) throw fail(`Element ${ref} is covered by "${target.covered}". Close it first, or pass force to click anyway.`, "covered");
    this.touch(tab, "Clicking");
    const buttonId = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    const mods = modifiers.map(keyValue);
    if (mods.length) await (await this.engine()).send("input.performActions", { context: target.context, actions: [{ type: "key", id: "still-keys", actions: mods.map((value) => ({ type: "keyDown", value })) }] });
    const steps = [{ type: "pointerMove", x: Math.round(target.x), y: Math.round(target.y), duration: 60 }];
    for (let i = 0; i < (double ? 2 : 1); i++) steps.push({ type: "pointerDown", button: buttonId }, { type: "pointerUp", button: buttonId });
    await this.pointer(target.context, steps);
    if (mods.length) await (await this.engine()).send("input.releaseActions", { context: target.context });
    await sleep(150);
    await waitForLoad(tab, 4000);
    return { tab: describeTab(tab) };
  },

  async "input.hover"({ tab: id, ref }) {
    const tab = tabById(id);
    const target = await this.locate(tab, ref);
    await this.pointer(target.context, [{ type: "pointerMove", x: Math.round(target.x), y: Math.round(target.y), duration: 80 }]);
    return { tab: describeTab(tab) };
  },

  async "input.type"({ tab: id, ref, text = "", clear = true, submit = false, slowly = false }) {
    const tab = tabById(id);
    let context = contextIdForTab(tab);
    if (ref) {
      const target = await this.locate(tab, ref);
      if (target.covered) throw fail(`Element ${ref} is covered by "${target.covered}".`, "covered");
      context = target.context;
      this.touch(tab, "Typing");
      await this.pointer(context, [{ type: "pointerMove", x: Math.round(target.x), y: Math.round(target.y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      if (clear) {
        const isMac = Services.appinfo.OS === "Darwin";
        await this.keys(context, [...keyActions(isMac ? "Meta+a" : "Control+a"), { type: "keyDown", value: "" }, { type: "keyUp", value: "" }]);
      }
    }
    const actions = textActions(String(text));
    if (slowly) for (const action of actions) if (action.type === "keyUp") action.pause = 40;
    for (let i = 0; i < actions.length; i += 400) await this.keys(context, actions.slice(i, i + 400));
    if (submit) await this.keys(context, keyActions("Enter"));
    await sleep(100);
    if (submit) await waitForLoad(tab, 6000);
    return { tab: describeTab(tab) };
  },

  async "input.fill"({ tab: id, fields = [] }) {
    const tab = tabById(id);
    for (const field of fields) {
      if (typeof field.value === "boolean") {
        const located = await this.locate(tab, field.ref);
        const checked = unpack(await this.call(located.context, "(el) => !!el.checked", [located.element]));
        if (checked !== field.value) await METHODS["input.click"].call(this, { tab: id, ref: field.ref });
      } else {
        const located = await this.locate(tab, field.ref);
        if (located.tag === "select") await METHODS["input.select"].call(this, { tab: id, ref: field.ref, values: [String(field.value)] });
        else await METHODS["input.type"].call(this, { tab: id, ref: field.ref, text: String(field.value), clear: true });
      }
    }
    return { tab: describeTab(tab), filled: fields.length };
  },

  async "input.press"({ tab: id, keys }) {
    const tab = tabById(id);
    this.touch(tab, "Pressing keys");
    const context = contextIdForTab(tab);
    for (const combo of String(keys).split(/\s+/).filter(Boolean)) await this.keys(context, keyActions(combo));
    await sleep(120);
    await waitForLoad(tab, 4000);
    return { tab: describeTab(tab) };
  },

  async "input.select"({ tab: id, ref, values = [] }) {
    const tab = tabById(id);
    const target = await this.locate(tab, ref);
    this.touch(tab, "Choosing an option");
    const result = await this.call(target.context, `(el, wanted) => {
      if (el.tagName !== "SELECT") throw new Error("Not a select element; click it and pick from the list instead");
      const picked = [];
      for (const option of el.options) {
        const hit = wanted.some((w) => option.value === w || option.label.trim() === w || option.text.trim() === w);
        if (hit && (el.multiple || !picked.length)) { option.selected = true; picked.push(option.label || option.value); }
        else if (el.multiple) option.selected = false;
      }
      if (!picked.length) throw new Error("No option matches " + wanted.join(", "));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return picked;
    }`, [target.element, { type: "array", value: values.map((value) => ({ type: "string", value: String(value) })) }]);
    return { tab: describeTab(tab), selected: unpack(result) };
  },

  async "input.scroll"({ tab: id, ref, direction = "down", amount = 600 }) {
    const tab = tabById(id);
    let context = contextIdForTab(tab);
    let x = 0, y = 0, origin = "viewport";
    if (ref) {
      const target = await this.locate(tab, ref, { scroll: false });
      context = target.context;
      x = Math.round(target.x);
      y = Math.round(target.y);
    } else {
      const size = unpack(await this.call(context, "() => [innerWidth, innerHeight]"));
      x = Math.round(size[0] / 2);
      y = Math.round(size[1] / 2);
    }
    const delta = Number(amount) || 600;
    const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
    const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;
    const bidi = await this.engine();
    await bidi.send("input.performActions", { context, actions: [{ type: "wheel", id: "still-wheel", actions: [{ type: "scroll", x, y, deltaX, deltaY, origin }] }] });
    await sleep(350);
    return { tab: describeTab(tab) };
  },

  async "input.drag"({ tab: id, from, to }) {
    const tab = tabById(id);
    const start = await this.locate(tab, from);
    const end = await this.locate(tab, to, { scroll: false });
    const steps = [{ type: "pointerMove", x: Math.round(start.x), y: Math.round(start.y) }, { type: "pointerDown", button: 0 }];
    for (let i = 1; i <= 8; i++) {
      steps.push({ type: "pointerMove", x: Math.round(start.x + (end.x - start.x) * i / 8), y: Math.round(start.y + (end.y - start.y) * i / 8), duration: 30 });
    }
    steps.push({ type: "pointerUp", button: 0 });
    await this.pointer(start.context, steps);
    return { tab: describeTab(tab) };
  },

  async "input.upload"({ tab: id, ref, paths = [] }) {
    const tab = tabById(id);
    for (const file of paths) if (!(await IOUtils.exists(file))) throw fail(`File not found: ${file}`, "no_file");
    const target = await this.locate(tab, ref, { scroll: false });
    const bidi = await this.engine();
    // Firefox only lets a page's process build File objects from paths while
    // dom.file.createInChild is on (automation normally leaves it on). Turn
    // it on just for this call.
    const defaults = Services.prefs.getDefaultBranch("");
    const before = defaults.getBoolPref("dom.file.createInChild", false);
    defaults.setBoolPref("dom.file.createInChild", true);
    try {
      await bidi.send("input.setFiles", { context: target.context, element: target.element, files: paths });
    } finally {
      defaults.setBoolPref("dom.file.createInChild", before);
    }
    return { tab: describeTab(tab), files: paths.length };
  },

  async "dialog.handle"({ tab: id, accept = true, text }) {
    const tab = tabById(id);
    const context = contextIdForTab(tab);
    const prompt = this.prompts.get(context);
    if (!prompt) throw fail("No dialog is open on this tab", "no_dialog");
    const bidi = await this.engine();
    await bidi.send("browsingContext.handleUserPrompt", { context, accept: Boolean(accept), ...(text !== undefined ? { userText: String(text) } : {}) });
    this.prompts.delete(context);
    return { tab: describeTab(tab), handled: prompt.type };
  },

  // ---- browser data

  async downloads({ limit = 15 }) {
    const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    const items = (await list.getAll()).slice(-limit).reverse();
    return {
      downloads: items.map((download) => ({
        file: download.target?.path,
        url: download.source?.url,
        state: download.succeeded ? "done" : download.error ? "failed" : download.canceled ? (download.hasPartialData ? "paused" : "canceled") : "running",
        progress: download.hasProgress ? download.progress : null,
        bytes: download.currentBytes,
        total: download.totalBytes || null,
        started: download.startTime ? new Date(download.startTime).toISOString() : null
      }))
    };
  },

  async "account.signedIn"() {
    const bySite = new Map();
    const add = (site, entry) => {
      const item = bySite.get(site) || { site, signedIn: false, evidence: [], savedLogins: [] };
      if (entry.cookie) { item.evidence.push(entry.cookie); if (entry.sure) item.signedIn = true; item.name ||= entry.name; }
      if (entry.login) item.savedLogins.push(entry.login);
      bySite.set(site, item);
    };
    const now = Date.now() / 1000;
    for (const cookie of Services.cookies.cookies) {
      if (cookie.expiry && cookie.expiry < now) continue;
      if (cookie.originAttributes?.userContextId || cookie.originAttributes?.privateBrowsingId) continue;
      const site = siteOf(cookie.host.replace(/^\./, ""));
      if (!site) continue;
      const known = KNOWN_SESSIONS.find(([domain]) => site === domain);
      if (known) {
        if (known[2].some((name) => name.endsWith("-") ? cookie.name.startsWith(name) : cookie.name === name)) add(site, { cookie: cookie.name, sure: true, name: known[1] });
      } else if (SESSION_COOKIE.test(cookie.name) && cookie.isHttpOnly && !cookie.isSession) {
        add(site, { cookie: cookie.name, sure: false });
      }
    }
    let loginsNote;
    try {
      if (lazy.LoginHelper.isPrimaryPasswordSet() && !Services.logins.isLoggedIn) loginsNote = "Saved passwords are locked behind the Primary Password, so they are not listed.";
      else {
        for (const login of await Services.logins.getAllLogins()) {
          const site = siteOf(login.origin);
          if (!site) continue;
          add(site, { login: login.username || "(no username)" });
        }
      }
    } catch (error) { loginsNote = `Saved passwords could not be read (${error.message}).`; }
    const sites = [...bySite.values()]
      .map((item) => ({ ...item, evidence: [...new Set(item.evidence)].slice(0, 3), savedLogins: [...new Set(item.savedLogins)], likely: item.signedIn ? "signed in" : item.evidence.length ? "maybe" : "saved password only" }))
      .sort((a, b) => (b.signedIn - a.signedIn) || (b.evidence.length - a.evidence.length) || a.site.localeCompare(b.site));
    return { sites, note: loginsNote };
  },

  async "account.cookies"({ domain, values = false }) {
    if (!domain) throw fail("Give a domain, like github.com", "bad_request");
    const cookies = Services.cookies.getCookiesFromHost(domain.replace(/^https?:\/\//, "").split("/")[0], {});
    return {
      cookies: cookies.map((cookie) => ({
        name: cookie.name, domain: cookie.host, path: cookie.path, secure: cookie.isSecure, httpOnly: cookie.isHttpOnly,
        expires: cookie.isSession ? "session" : new Date(cookie.expiry * 1000).toISOString(),
        ...(values ? { value: cookie.value } : {})
      }))
    };
  },

  // Fill the page's sign-in form from Firefox's saved passwords. The
  // password is typed into the page and never returned to the agent.
  async "account.fillLogin"({ tab: id, username, submit = false }) {
    const tab = tabById(id);
    const context = contextIdForTab(tab);
    await this.inject(context);
    const fieldsResult = await this.call(context, `() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
      const inputs = [...document.querySelectorAll("input")].filter((el) => !el.disabled && !el.readOnly && visible(el));
      const password = inputs.find((el) => el.type === "password" && !/new|confirm|repeat/i.test(el.autocomplete + " " + el.name + " " + el.id));
      const textual = (el) => ["text", "email", "tel", ""].includes(el.type) && !/search|captcha|code|otp/i.test(el.name + " " + el.id + " " + el.autocomplete);
      let user = null;
      const pool = password ? inputs.slice(0, inputs.indexOf(password)).filter(textual) : inputs.filter(textual);
      user = pool.reverse().find((el) => /user|mail|login|account|identifier|phone/i.test(el.name + " " + el.id + " " + el.autocomplete + " " + el.type)) || pool[0] || null;
      const point = (el) => { el.scrollIntoView({ block: "center", behavior: "instant" }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
      return { origin: location.origin, user: user ? point(user) : null, password: password ? point(password) : null };
    }`);
    const fields = unpack(fieldsResult);
    if (!fields.user && !fields.password) throw fail("No sign-in field found on this page", "no_form");
    const logins = await Services.logins.searchLoginsAsync({ origin: fields.origin });
    const pool = username ? logins.filter((login) => login.username === username) : logins;
    if (!pool.length) throw fail(username ? `No saved password for ${username} on ${fields.origin}` : `No saved password for ${fields.origin}`, "no_login");
    if (pool.length > 1 && !username) throw fail(`Several saved accounts for ${fields.origin}: ${pool.map((login) => login.username).join(", ")}. Say which username.`, "choose_login");
    const login = pool[0];
    this.touch(tab, "Signing in");
    const fill = async ([x, y], value) => {
      await this.pointer(context, [{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await this.keys(context, [...keyActions(Services.appinfo.OS === "Darwin" ? "Meta+a" : "Control+a"), { type: "keyDown", value: "" }, { type: "keyUp", value: "" }]);
      await this.keys(context, textActions(value));
    };
    if (fields.user && login.username) await fill(fields.user, login.username);
    if (fields.password) await fill(fields.password, login.password);
    if (submit) { await this.keys(context, keyActions("Enter")); await waitForLoad(tab, 8000); }
    return {
      tab: describeTab(tab),
      filled: [fields.user && login.username ? "username" : null, fields.password ? "password" : null].filter(Boolean),
      username: login.username,
      next: fields.password ? undefined : "Only the username step was on this page. After it moves on, call log_in again for the password."
    };
  },

  async "history.search"({ query = "", limit = 20 }) {
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT url, title, last_visit_date FROM moz_places WHERE last_visit_date IS NOT NULL
         AND (instr(lower(url), lower(:q)) > 0 OR instr(lower(IFNULL(title, '')), lower(:q)) > 0)
       ORDER BY last_visit_date DESC LIMIT :limit`,
      { q: String(query), limit: Math.min(limit, 100) });
    return { results: rows.map((row) => ({ url: row.getResultByName("url"), title: row.getResultByName("title"), visited: new Date(row.getResultByName("last_visit_date") / 1000).toISOString() })) };
  },

  async "bookmarks.search"({ query = "", limit = 30 }) {
    const results = query ? await lazy.PlacesUtils.bookmarks.search(query) : await lazy.PlacesUtils.bookmarks.getRecent(limit);
    return { results: results.filter((item) => item.url).slice(0, limit).map((item) => ({ title: item.title, url: item.url.href })) };
  },

  async "engine.stop"() {
    await this.stopEngine();
    return { stopped: true };
  },

  async "debug.eval"({ script }) {
    if (!Services.prefs.getBoolPref(PREF_DEBUG, false)) throw fail("Debug access is off", "disabled");
    const win = stillWindow() || Services.wm.getMostRecentBrowserWindow();
    // Test profiles only (still.agent.debug): runs chrome script in the window.
    const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxPrototype: win, wantXrays: false });
    sandbox.bridge = this;
    const value = await Cu.evalInSandbox(`(async () => { ${script} })()`, sandbox);
    return { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
  }
};

const bridge = new Bridge();

export const StillAgent = {
  async start() {
    if (started) return;
    started = true;
    try {
      await bridge.listen();
    } catch (error) {
      console.error("Still agent bridge could not start", error);
    }
  },
  stopEngine() { return bridge.stopEngine(); },
  disconnectAll() {
    for (const connection of [...bridge.connections]) connection.close();
    return bridge.stopEngine();
  },
  status() {
    return { clients: bridge.clients(), engine: Boolean(bridge.bidi?.open) };
  }
};
