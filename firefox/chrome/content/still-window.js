// Still's window layer for Firefox. Loaded into each normal browser window by
// still.cfg. Firefox tabs are Still's slots: there are at most five, shown in
// an auto-hiding glass bar. Switching slides live pages instead of snapshots.
(function stillWindow() {
  "use strict";
  if (window.StillChrome) return;

  const HTML = "http://www.w3.org/1999/xhtml";
  const SVG = "http://www.w3.org/2000/svg";
  const SLOT_COUNT = 5;
  const SLIDE_MS = 260;
  const VERTICAL_MS = 240;
  const EASE = "cubic-bezier(.16, 1, .3, 1)";
  const SEARCH_BASE = "http://127.0.0.1:48230/";
  const EXTENSION_ID = "still-prototype@tim.local";
  const NEW_SLOT_CONFIRM_MS = 1050;
  const ICON = "resource://still/still-mark.svg";
  const PREF_DOCK_SLIDE = "still.tabdock.slide";
  const PREF_UTILITY = "still.utility.mode";
  const PREF_THEME = "still.theme";
  const PREF_AGENT_VIEW = "still.agent.liveView";

  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    StillAgent: "resource://still/StillAgent.sys.mjs",
    Downloads: "resource://gre/modules/Downloads.sys.mjs",
    DownloadUtils: "resource://gre/modules/DownloadUtils.sys.mjs",
    StillShared: "resource://still/StillShared.sys.mjs",
    StillImport: "resource://still/StillImport.sys.mjs",
    MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs"
  });

  // Ctrl+wheel switches slots, so the zoom keys are the only way to zoom.
  // Pages must not be able to take them: some (bettermarks' formula editor)
  // read Ctrl+- as a plain "-" and cancel it. Reserved keys go to Firefox
  // before the page sees them, like Ctrl+W and Ctrl+T.
  for (const key of document.querySelectorAll('key[command^="cmd_fullZoom"]')) key.setAttribute("reserved", "true");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let revealOpen = false;
  const state = {
    editingTab: null,
    draggedTab: null,
    hideTimer: 0,
    slide: null,
    nextDirection: null,
    vertical: null,
    edgeTimer: 0,
    edgeArmedAt: 0,
    wallTimer: 0,
    dock: { visible: false, selected: 0, hover: -1, direction: 0, timer: 0 },
    toastTimer: 0,
    overflow: null,
    utilityMode: Services.prefs.getStringPref(PREF_UTILITY, "bookmarks"),
    utilityToken: 0,
    lastUtilityWheel: 0,
    lastSlotWheel: 0,
    suggestionToken: 0,
    renderQueued: false,
    restored: false
  };

  // ---------------------------------------------------------------- helpers

  function h(tag, props = {}, ...children) {
    const element = document.createElementNS(HTML, tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? "" : String(value));
    }
    element.append(...children.filter(Boolean));
    return element;
  }

  // Icons are built from path data so no markup parsing happens in chrome.
  function icon(paths, className = "") {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    for (const spec of paths) {
      const [name, attributes] = typeof spec === "string" ? ["path", { d: spec }] : spec;
      const node = document.createElementNS(SVG, name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  }

  // Every mode the utility button can have, in its order. Settings picks
  // which are on; by default the first five. Settings itself always stays.
  const utilityModes = ["downloads", "agents", "history", "bookmarks", "settings", "chat", "permissions", "browser", "theme", "tabdock"];
  const PREF_UTILITY_MODES = "still.utility.modes";
  const DEFAULT_UTILITY_MODES = "downloads,agents,history,bookmarks,settings";
  const utilityMeta = {
    chat: { label: "Side chat (Ctrl+E)", paths: ["M6.8 5h10.4a2.3 2.3 0 0 1 2.3 2.3v6.2a2.3 2.3 0 0 1-2.3 2.3h-5.7l-4 3.2v-3.2h-.7a2.3 2.3 0 0 1-2.3-2.3V7.3A2.3 2.3 0 0 1 6.8 5Z", "M9 9.6h6M9 12.2h3.6"] },
    agents: { label: "Agent tabs", className: "agents-mode-icon", paths: [["path", { class: "agent-star", d: "M12 4.2c.55 3.9 2.6 6 6.6 6.6-4 .6-6.05 2.7-6.6 6.6-.55-3.9-2.6-6-6.6-6.6 4-.6 6.05-2.7 6.6-6.6Z" }], ["circle", { class: "agent-orbit", cx: "18.2", cy: "5.6", r: "1.15" }]] },
    settings: { label: "Settings", paths: ["M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z", "M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14.1 2.6h-4.2L9.5 5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9A7.5 7.5 0 0 0 9.5 19l.4 2.4h4.2l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4Z"] },
    bookmarks: { label: "Bookmarks", paths: ["m12 3.7 2.5 5.1 5.6.8-4.05 3.95.96 5.58L12 16.5l-5.01 2.63.96-5.58L3.9 9.6l5.6-.8L12 3.7Z"] },
    history: { label: "History", paths: ["M4.5 5.8v4.4h4.4M5 10a7.5 7.5 0 1 1 .8 5.2M12 7.6V12l3.1 1.8"] },
    downloads: { label: "Downloads", paths: ["M12 3.5v11m-4-4 4 4 4-4M5 19.5h14"] },
    permissions: { label: "Site Permissions", paths: ["M12 3.2 19 6v5.1c0 4.4-2.8 7.6-7 9.7-4.2-2.1-7-5.3-7-9.7V6l7-2.8Z", "M9.2 12.1 11 14l3.9-4.2"] },
    browser: { label: "Browser Setup", paths: [["circle", { cx: "12", cy: "12", r: "8.5" }], "M3.8 12h16.4M12 3.5c-2.2 2.3-3.4 5.2-3.4 8.5s1.2 6.2 3.4 8.5c2.2-2.3 3.4-5.2 3.4-8.5S14.2 5.8 12 3.5Z"] },
    theme: { label: "Appearance", className: "theme-mode-icon", paths: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { class: "theme-fill", d: "M12 3.5a8.5 8.5 0 0 0 0 17Z" }], ["circle", { class: "theme-full", cx: "12", cy: "12", r: "8.5" }], ["circle", { class: "theme-ring", cx: "12", cy: "12", r: "11" }]] },
    tabdock: { label: "Dock Slide", className: "tab-dock-mode-icon", paths: [["rect", { x: "3", y: "7.5", width: "18", height: "9", rx: "4.5" }], "M8.5 12h7m-2.3-2.2 2.3 2.2-2.3 2.2"] }
  };
  function enabledUtilityModes() {
    const modes = new Set(Services.prefs.getStringPref(PREF_UTILITY_MODES, DEFAULT_UTILITY_MODES).split(",").map((mode) => mode.trim()));
    modes.add("settings");
    return modes;
  }
  function activeUtilityModes() {
    const enabled = enabledUtilityModes();
    return utilityModes.filter((mode) => enabled.has(mode));
  }
  function setUtilityModes(modes) {
    Services.prefs.setStringPref(PREF_UTILITY_MODES, utilityModes.filter((mode) => modes.has(mode) || mode === "settings").join(","));
    if (!activeUtilityModes().includes(state.utilityMode)) {
      state.utilityMode = activeUtilityModes()[0];
      Services.prefs.setStringPref(PREF_UTILITY, state.utilityMode);
      renderUtilityButton({ animate: true });
    }
  }
  if (!activeUtilityModes().includes(state.utilityMode)) state.utilityMode = activeUtilityModes().includes("bookmarks") ? "bookmarks" : activeUtilityModes()[0];

  function slotTabs() {
    return gBrowser.tabs.filter((tab) => !tab.hidden && !tab.closing);
  }

  function slotIndex(tab) {
    return slotTabs().indexOf(tab);
  }

  // Five slots in all, however many windows they are spread over. A slot
  // detached into its own window takes its place with it: the window it
  // left has one fewer. Every Still window is this same window layer.
  function stillWindows() {
    return [...Services.wm.getEnumerator("navigator:browser")]
      .filter((win) => win !== window && !win.closed && win.StillChrome?.slotTabs);
  }

  function otherSlotCount() {
    let count = 0;
    for (const win of stillWindows()) {
      count += win.StillChrome.slotTabs().filter((tab) => !tab.stillLeaving && !tab.stillDragging).length;
    }
    return count;
  }

  // How many slots this window may hold right now.
  function slotCapacity() {
    return Math.max(0, SLOT_COUNT - otherSlotCount());
  }

  // A window opened for a detached slot, while the main window is open.
  function holdsDetached() {
    return Boolean(state.detached) && stillWindows().length > 0;
  }

  // The other windows redraw their rows when this one gains or loses a slot.
  function notifyPeers() {
    for (const win of stillWindows()) win.StillChrome.queueRender?.();
  }

  // A tab's place in Firefox's tab list. Firefox 156 renamed the old
  // `_tPos` to `index`; reading the missing one sent every move to the end.
  function tabPos(tab) {
    return Number.isInteger(tab?.index) ? tab.index : gBrowser.tabs.indexOf(tab);
  }

  function panelOf(tab) {
    return tab?.linkedPanel ? document.getElementById(tab.linkedPanel) : null;
  }

  function tabOfPanel(panel) {
    return panel ? gBrowser.tabs.find((tab) => tab.linkedPanel === panel.id) || null : null;
  }

  function tabUrl(tab) {
    try { return tab.linkedBrowser.currentURI.spec; } catch { return ""; }
  }

  function managerUrl() {
    try { return WebExtensionPolicy.getByID(EXTENSION_ID)?.getURL("manage.html") || ""; } catch { return ""; }
  }

  function isHomeUrl(url) {
    if (!url || url === "about:blank" || url === "about:newtab" || url === "about:home") return true;
    try { if (url === BROWSER_NEW_TAB_URL) return true; } catch {}
    // Still's start page; with ?q= it is a Still Search results page instead.
    return /^moz-extension:\/\/[^/]+\/newtab\.html(?:#.*)?$/i.test(url);
  }

  // A slot Still may reuse for a new page: showing the start page, idle.
  // A tab that is still about:blank may be about to load something.
  function isHomeTab(tab) {
    const url = tabUrl(tab);
    return url !== "about:blank" && isHomeUrl(url) && !tab.hasAttribute("busy") && !tab.hasAttribute("pending");
  }

  function displayUrl(url) {
    if (!url || isHomeUrl(url)) return "";
    try {
      const parsed = new URL(url);
      if (`${parsed.origin}/` === SEARCH_BASE && parsed.pathname === "/search") return parsed.searchParams.get("q") || url;
      if (parsed.protocol === "moz-extension:" && parsed.pathname === "/newtab.html") return parsed.searchParams.get("q") || "";
    } catch {}
    return url;
  }

  function slotTitle(tab) {
    if (tab.stillDownloadTitle) return tab.stillDownloadTitle;
    if (isHomeUrl(tabUrl(tab)) && !tab.hasAttribute("busy")) return "Still";
    return tab.label || "Untitled";
  }

  function normalizeInput(value) {
    const input = value.trim();
    if (!input) return BROWSER_NEW_TAB_URL;
    const lower = input.toLocaleLowerCase();
    if ((lower === "learn" || lower === "still learn") && managerUrl()) return managerUrl();
    if (/^(https?|about|file|moz-extension):/i.test(input)) return input;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(input)) return `http://${input}`;
    if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(input)) return `https://${input}`;
    // Another engine chosen in Settings gets the query directly.
    const engineUrl = (() => { try { return lazy.StillShared.searchUrlFor(input); } catch { return ""; } })();
    if (engineUrl) return engineUrl;
    // Results open in Still's own search page when the extension is loaded.
    const startPage = (() => { try { return BROWSER_NEW_TAB_URL; } catch { return ""; } })();
    if (/^moz-extension:\/\/[^/]+\/newtab\.html$/i.test(startPage)) return `${startPage}?q=${encodeURIComponent(input)}`;
    const search = new URL("search", SEARCH_BASE);
    search.searchParams.set("q", input);
    return search.href;
  }

  function loadInTab(tab, url) {
    const browser = tab.linkedBrowser;
    browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_NONE
    });
  }

  function animationsAllowed() {
    return !reducedMotion.matches;
  }

  // -------------------------------------------------------------- DOM setup

  const layer = h("div", { id: "still-layer" });
  const reveal = h("div", { id: "still-reveal", "aria-hidden": "true" });
  const edgeLeft = h("div", { class: "still-edge-fade left", "aria-hidden": "true" });
  const edgeRight = h("div", { class: "still-edge-fade right", "aria-hidden": "true" });
  const navStage = h("div", { id: "still-nav-stage", "aria-hidden": "true", hidden: true });
  const newSlotEdge = h("button", { id: "still-new-slot-edge", type: "button", "aria-label": "Open a new slot", tabindex: "-1" },
    h("span", { "aria-hidden": "true", text: "+" }));
  const dock = h("div", { id: "still-tab-dock", "aria-label": "Slot dock", hidden: true });
  const dockIcons = h("div", { id: "still-tab-dock-icons" });
  dock.append(dockIcons);

  const slotRow = h("div", { class: "slot-row", role: "toolbar", "aria-label": "Five browsing slots" });
  const utilityStage = h("span", { class: "utility-icon-stage", "aria-hidden": "true" });
  const utilityButton = h("button", { class: "top-control utility-button", type: "button" }, utilityStage);
  const minimizeButton = h("button", { class: "top-control minimize-control", type: "button", title: "Minimize", "aria-label": "Minimize" },
    icon(["M6.5 12h11"], "control-icon"));
  // One square while the window is normal; a second square slides in behind
  // it once the window fills the screen, so the button reads as "restore".
  const maximizeButton = h("button", { class: "top-control maximize-control", type: "button" },
    icon([
      ["path", { class: "restore-back", d: "M9.5 6.5h6.3a1.7 1.7 0 0 1 1.7 1.7v6.3" }],
      ["rect", { class: "maximize-front", x: "6.5", y: "6.5", width: "11", height: "11", rx: "2.2" }]
    ], "control-icon"));
  const closeButton = h("button", { class: "top-control close-control danger", type: "button", title: "Close", "aria-label": "Close window" },
    icon(["m7.5 7.5 9 9m0-9-9 9"], "control-icon"));
  // Shown only while an AI agent is connected (see the agents section).
  const agentButton = h("button", { class: "top-control agent-control", type: "button", hidden: true, "aria-haspopup": "dialog", "aria-expanded": "false" },
    h("span", { class: "agent-mark", "aria-hidden": "true" },
      icon([["path", { class: "agent-star", d: "M12 4.2c.55 3.9 2.6 6 6.6 6.6-4 .6-6.05 2.7-6.6 6.6-.55-3.9-2.6-6-6.6-6.6 4-.6 6.05-2.7 6.6-6.6Z" }],
        ["circle", { class: "agent-orbit", cx: "18.2", cy: "5.6", r: "1.15" }]], "control-icon agent-glyph")));
  const topControls = h("div", { class: "top-controls" }, agentButton, utilityButton, minimizeButton, maximizeButton, closeButton);
  const utilityPanel = h("div", { class: "utility-panel", hidden: true });
  // The current slot's soft light. It moves to whichever slot is selected.
  const chrome = h("div", { id: "still-chrome", role: "banner", "aria-label": "Still controls" }, slotRow, topControls, utilityPanel);

  const toastMessage = h("span");
  const toastAction = h("button", { type: "button", hidden: true });
  const toast = h("div", { id: "still-toast", role: "status", "aria-live": "polite" }, toastMessage, toastAction);

  const replacementList = h("div", { id: "still-replacement-list" });
  const replacementUrl = h("div", { id: "still-replacement-url" });
  const replacementCancel = h("button", { id: "still-replacement-cancel", type: "button", "aria-label": "Cancel", title: "Cancel" },
    icon(["m7.5 7.5 9 9m0-9-9 9"], "control-icon"));
  const replacementBackdrop = h("div", { id: "still-replacement-backdrop", hidden: true },
    h("section", { id: "still-replacement-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "still-replacement-title" },
      h("div", { class: "replacement-heading" },
        h("div", {},
          h("h2", { id: "still-replacement-title", text: "Choose a slot" }),
          h("p", { text: "This page needs one of your five slots." })),
        replacementCancel),
      replacementUrl,
      replacementList));

  layer.append(navStage, edgeLeft, edgeRight, newSlotEdge, reveal, chrome, dock, replacementBackdrop, toast);
  document.body.append(layer);
  document.documentElement.setAttribute("still", "");

  // ---------------------------------------------------------- startup
  // Plays once per app start in the first window. The Still mark is rebuilt
  // from its five bars, each sliding into place; when the first page is
  // ready the mark lifts away and the page settles in. Never holds a ready
  // browser back: the exit starts as soon as both the page and the minimum
  // entrance have finished, and at the latest after a few seconds.

  const MARK_BARS = [
    // [path in the 1024px icon grid, entry side, stagger order]
    ["M382 212H641A49 49 0 0 1 641 310H382A49 49 0 0 1 382 212Z", -1, 2],
    ["M296.5 336H617A49.5 49.5 0 0 0 617 435H296.5A49.5 49.5 0 0 1 296.5 336Z", 1, 1],
    ["M257 461H766A49 49 0 0 1 766 559H257A49 49 0 0 1 257 461Z", -1, 0],
    ["M405.5 584H722.5A49.5 49.5 0 0 1 722.5 683H405.5A49.5 49.5 0 0 0 405.5 584Z", 1, 1],
    ["M395 709H641A49.5 49.5 0 0 1 641 808H395A49.5 49.5 0 0 1 395 709Z", -1, 2]
  ];

  function buildSplash() {
    const mark = h("div", { class: "still-mark", role: "img", "aria-label": "Still" });
    mark.append(h("div", { class: "still-mark-glow", "aria-hidden": "true" }));
    // Images, not inline SVG: their transform/opacity animations run on the
    // compositor, so the entrance stays smooth while Firefox is busy starting.
    for (const [d] of MARK_BARS) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="200 200 624 624"><path fill="#f1f1ee" d="${d}"/></svg>`;
      mark.append(h("img", { class: "still-mark-bar", alt: "", src: `data:image/svg+xml,${encodeURIComponent(svg)}` }));
    }
    return h("div", { id: "still-splash", "aria-hidden": "true" }, mark);
  }

  function runSplash({ force = false } = {}) {
    let wanted = force;
    try { wanted = lazy.StillShared.claimSplash() || force; } catch {}
    if (!wanted) return;
    const splash = buildSplash();
    layer.append(splash);
    document.documentElement.setAttribute("still-starting", "");
    state.starting = true;
    const motion = animationsAllowed();
    const started = performance.now();
    const bars = [...splash.querySelectorAll(".still-mark-bar")];
    const mark = splash.querySelector(".still-mark");
    const glow = splash.querySelector(".still-mark-glow");

    if (motion) {
      bars.forEach((bar, index) => {
        const [, side, order] = MARK_BARS[index];
        bar.animate([
          { transform: `translate3d(${side * 96}px, 0, 0) scaleX(.5)`, opacity: 0 },
          { opacity: 1, offset: 0.45 },
          { transform: "translate3d(0, 0, 0) scaleX(1)", opacity: 1 }
        ], { duration: 720, delay: 60 + order * 75, easing: "cubic-bezier(.22, 1.22, .36, 1)", fill: "both" });
      });
      mark.animate([{ transform: "scale(.9)" }, { transform: "scale(1)" }], { duration: 1100, easing: EASE, fill: "both" });
      glow.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }],
        { duration: 1200, delay: 250, easing: EASE, fill: "both" });
      // While Firefox finishes starting, a slow wave passes down the bars so
      // the wait reads as work in progress, not a frozen picture.
      state.splashBreathing = bars.map((bar, index) => bar.animate(
        [{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }],
        { duration: 1500, delay: 1150 + index * 120, iterations: Infinity, easing: "ease-in-out" }));
    } else {
      mark.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "both" });
    }

    const minimum = new Promise((resolve) => setTimeout(resolve, motion ? 1050 : 250));
    const pageReady = new Promise((resolve) => { state.splashPageReady = resolve; });
    const ready = lazy.StillShared.extensionReady.then(() => Promise.race([
      pageReady,
      new Promise((resolve) => setTimeout(resolve, 500))
    ]));
    const latest = new Promise((resolve) => setTimeout(resolve, 3200));
    Promise.race([Promise.all([minimum, ready]), latest]).then(() => finishSplash(splash, motion, started));
  }

  function finishSplash(splash, motion) {
    if (!splash.isConnected) return;
    state.splashPageReady = null;
    state.splashBreathing?.forEach((animation) => animation.cancel());
    state.splashBreathing = null;
    const done = () => {
      splash.remove();
      state.starting = false;
      document.documentElement.removeAttribute("still-starting");
      // The slots drop in once, so it is clear where they live.
      showChrome(0.5);
      scheduleChromeHide(1500);
    };
    if (!motion) {
      splash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "both" }).finished.then(done, done);
      return;
    }
    const mark = splash.querySelector(".still-mark");
    splash.querySelectorAll(".still-mark-bar").forEach((bar, index) => {
      const [, side, order] = MARK_BARS[index];
      bar.animate([
        { transform: "translate3d(0, 0, 0)" },
        { transform: `translate3d(${-side * 18}px, 0, 0)` }
      ], { duration: 420, delay: (2 - order) * 30, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "both" });
    });
    mark.animate([
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(1.12)", opacity: 0 }
    ], { duration: 460, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "both" });
    const fade = splash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 520, delay: 120, easing: "ease-out", fill: "both" });
    const panel = panelOf(gBrowser.selectedTab);
    panel?.animate([{ transform: "scale(1.035)" }, { transform: "scale(1)" }], { duration: 760, delay: 80, easing: EASE });
    fade.finished.then(done, done);
  }

  // ------------------------------------------------------------ chrome bar

  function showChrome(cursorRatio = 0.5) {
    if (state.starting) return;
    clearTimeout(state.hideTimer);
    const ratio = Number.isFinite(cursorRatio) ? Math.max(0, Math.min(1, cursorRatio)) : 0.5;
    const cursorX = window.innerWidth * ratio;
    for (const element of chrome.querySelectorAll(".slot, .top-control")) {
      const bounds = element.getBoundingClientRect();
      const center = bounds.left + bounds.width / 2;
      const distance = Math.abs(center - cursorX);
      element.style.setProperty("--enter-delay", `${Math.min(90, Math.round(distance / 9))}ms`);
      element.style.setProperty("--entry-x", `${Math.max(-18, Math.min(18, (cursorX - center) / 24))}px`);
    }
    const opening = !chrome.classList.contains("open");
    chrome.classList.add("open");
    if (opening && Services.prefs.getBoolPref("still.debug.frames", false)) reportFrames("Bar");
  }

  // still.debug.frames: how smoothly an animation was composited, from
  // Firefox's own frame recorder (what reaches the screen, not just the
  // main thread). Shown as a toast and in the browser console.
  function reportFrames(label, duration = 520) {
    const utils = window.windowUtils;
    let start;
    try { start = utils.startFrameTimeRecording(); } catch { return; }
    setTimeout(() => {
      let frames = [];
      try { frames = utils.stopFrameTimeRecording(start).slice(1); } catch {}
      if (!frames.length) return;
      const average = frames.reduce((sum, ms) => sum + ms, 0) / frames.length;
      const worst = Math.max(...frames);
      const text = `${label}: ${Math.round(1000 / average)} fps, worst frame ${worst.toFixed(1)} ms (${utils.layerManagerType})`;
      console.log(`[Still] ${text}`, frames.map((ms) => +ms.toFixed(1)));
      showToast(text, 4000);
    }, duration);
  }

  function chromeBusy() {
    return state.editingTab || state.draggedTab || chrome.matches(":hover") || !utilityPanel.hidden || !agentPanel.hidden || !settingsPage.hidden;
  }

  function scheduleChromeHide(delay = 300) {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
      if (state.editingTab || state.draggedTab || chrome.matches(":hover") || !agentPanel.hidden || !settingsPage.hidden) return;
      hideUtilityPanel();
      if (chrome.contains(document.activeElement)) document.activeElement.blur();
      chrome.classList.remove("open");
    }, delay);
  }

  reveal.addEventListener("mouseenter", (event) => showChrome(event.clientX / window.innerWidth));

  // Like the Electron build: watch the cursor itself. The top few pixels of
  // a window belong to Windows' resize border, so a hover zone alone misses.
  // Far from the top a single cheap system call every 40 ms is enough. Once
  // the cursor comes near, it is read every frame instead, so the bar
  // starts on the very frame the cursor arrives and the frame clock is
  // already running when it does.
  let nearFrame = 0;
  function pollReveal() {
    if (document.hidden || state.starting) return false;
    const cursor = lazy.StillShared.cursorInWindow(window);
    if (!cursor) return false;
    const scale = window.devicePixelRatio || 1;
    const fromTop = cursor.y / scale;
    const across = cursor.x >= 0 && cursor.x < cursor.width;
    const inside = across && fromTop >= -2 && fromTop <= (revealOpen ? 81 : 18);
    if (inside && !revealOpen) {
      revealOpen = true;
      showChrome(cursor.x / cursor.width);
    } else if (!inside && revealOpen) {
      revealOpen = false;
      if (!chromeBusy()) scheduleChromeHide();
    }
    return across && fromTop >= -2 && fromTop <= 160;
  }
  function nearLoop() {
    nearFrame = pollReveal() ? window.requestAnimationFrame(nearLoop) : 0;
  }
  state.revealTimer = setInterval(() => {
    if (nearFrame) return;
    if (pollReveal()) nearFrame = window.requestAnimationFrame(nearLoop);
  }, 40);
  window.addEventListener("unload", () => clearInterval(state.revealTimer));
  chrome.addEventListener("mouseenter", () => clearTimeout(state.hideTimer));
  chrome.addEventListener("mouseleave", () => { if (!chromeBusy()) scheduleChromeHide(); });

  // Empty space on the open bar and the top band move the window the way a
  // title bar does, and double-click maximizes. On Windows Still asks the
  // system to move it (so snapping works); elsewhere the CSS drag region
  // (-moz-window-dragging) hands the press to the window manager.
  function isBarBackground(target) {
    return target === chrome || target === slotRow || target === topControls;
  }

  function toggleMaximized() {
    if (window.fullScreen) window.fullScreen = false;
    else if (window.windowState === window.STATE_MAXIMIZED) window.restore();
    else window.maximize();
  }

  chrome.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !isBarBackground(event.target) || event.detail > 1) return;
    if (lazy.StillShared.startWindowMove(window)) event.preventDefault();
  });

  // On Linux the window manager answers a double-click on a drag area itself
  // (following the system's title bar setting), so only Windows needs this.
  const ownDoubleClick = Services.appinfo.OS === "WINNT";
  chrome.addEventListener("dblclick", (event) => {
    if (ownDoubleClick && isBarBackground(event.target)) toggleMaximized();
  });

  reveal.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.detail > 1) return;
    if (lazy.StillShared.startWindowMove(window)) event.preventDefault();
  });
  reveal.addEventListener("dblclick", () => { if (ownDoubleClick) toggleMaximized(); });

  function syncWindowControls() {
    const filled = window.fullScreen || window.windowState === window.STATE_MAXIMIZED;
    const label = window.fullScreen ? "Exit full screen" : filled ? "Restore" : "Maximize";
    maximizeButton.classList.toggle("restore", filled);
    maximizeButton.title = label;
    maximizeButton.setAttribute("aria-label", label);
  }
  window.addEventListener("sizemodechange", syncWindowControls);
  window.addEventListener("fullscreen", () => setTimeout(syncWindowControls));
  syncWindowControls();

  minimizeButton.addEventListener("click", () => window.minimize());
  maximizeButton.addEventListener("click", toggleMaximized);
  closeButton.addEventListener("click", () => BrowserCommands.tryToCloseWindow?.() ?? window.close());

  // ------------------------------------------------------------- slot pills

  const pills = new WeakMap();
  const emptyPills = [];

  function faviconFor(tab, className = "slot-favicon") {
    const url = tabUrl(tab);
    if (isHomeUrl(url)) return h("img", { class: `${className} brand-favicon`, src: ICON, alt: "" });
    if (tab.stillDownload) return h("span", { class: `${className} download-favicon`, "aria-hidden": "true" }, icon(arrowPaths));
    const image = tab.getAttribute("image");
    const letter = () => h("span", { class: `${className} placeholder`, "aria-hidden": "true",
      text: slotTitle(tab).trim().charAt(0).toLocaleUpperCase() || "·" });
    if (!image) return letter();
    const img = h("img", { class: className, src: image, alt: "" });
    img.addEventListener("error", () => img.replaceWith(letter()), { once: true });
    return img;
  }

  function buildPill(tab) {
    const pill = h("div", { class: "slot", role: "button", tabindex: "0",
      "aria-keyshortcuts": "Control+Shift+ArrowLeft Control+Shift+ArrowRight" });
    pill.stillTab = tab;
    const icon = h("span", { class: "slot-icon" });
    const title = h("span", { class: "slot-title" });
    const close = h("button", { class: "slot-close", type: "button", title: "Close slot" }, closeGlyph());
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSlot(pill.stillTab);
    });
    // The surface carries the slot's fill and edge (and lifts when dragged).
    // The soul's light is drawn inside it, so whenever the surface scales or
    // leans the light goes with it: one slot, never a second outline beside
    // it. The icon and title sit on top.
    pill.stillSurface = h("span", { class: "slot-surface", "aria-hidden": "true" },
      h("span", { class: "slot-light", "aria-hidden": "true" }));
    pill.append(pill.stillSurface, icon, title, close, h("span", { class: "slot-drop-hint", "aria-hidden": "true" }));
    pill.addEventListener("click", (event) => {
      if (event.target.closest("button, input, form")) return;
      activate(pill.stillTab);
      scheduleChromeHide(900);
    });
    pill.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, input, form")) return;
      event.preventDefault();
      beginEdit(pill.stillTab);
    });
    pill.addEventListener("keydown", (event) => {
      if (event.target !== pill) return;
      if (event.ctrlKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        moveSlot(pill.stillTab, slotIndex(pill.stillTab) + (event.key === "ArrowLeft" ? -1 : 1));
        pill.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Enter") beginEdit(pill.stillTab);
      else if (event.key === " ") { event.preventDefault(); activate(pill.stillTab); }
    });
    pill.addEventListener("mouseenter", () => warmTab(pill.stillTab));
    attachReorder(pill);
    return pill;
  }

  function closeGlyph() {
    return icon(["M8 8l8 8M16 8l-8 8"], "close-icon");
  }

  function emptyPill(index) {
    if (emptyPills[index]) return emptyPills[index];
    const pill = h("div", { class: "slot empty", role: "button", tabindex: "0" });
    const label = h("span", { class: "slot-empty-label" });
    pill.append(icon(["M12 6.5v11M6.5 12h11"], "slot-empty-plus"), label);
    const open = () => openNewSlot({ edit: true });
    pill.addEventListener("click", open);
    pill.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });
    pill.append(h("span", { class: "slot-drop-hint", "aria-hidden": "true" }));
    emptyPills[index] = pill;
    return pill;
  }

  function updatePill(pill, tab, index) {
    const active = tab === gBrowser.selectedTab;
    pill.classList.toggle("active", active);
    pill.classList.toggle("loading", tab.hasAttribute("busy") || tab.stillDownload?.kind === "running");
    pill.classList.toggle("muted", tab.hasAttribute("muted"));
    pill.classList.toggle("playing", tab.hasAttribute("soundplaying"));
    pill.setAttribute("aria-pressed", String(active));
    const title = slotTitle(tab);
    const label = `Slot ${index + 1}: ${title}`;
    pill.setAttribute("aria-label", label);
    pill.title = `${title}\nDouble-click to search or enter an address`;
    pill.querySelector(".slot-close").setAttribute("aria-label", `Close slot ${index + 1}`);
    const iconHost = pill.querySelector(".slot-icon");
    const iconKey = `${isHomeUrl(tabUrl(tab))}|${Boolean(tab.stillDownload)}|${tab.getAttribute("image") || ""}|${title.charAt(0)}`;
    if (iconHost.dataset.key !== iconKey) {
      iconHost.dataset.key = iconKey;
      iconHost.replaceChildren(faviconFor(tab));
    }
    const titleNode = pill.querySelector(".slot-title");
    if (titleNode && titleNode.textContent !== title) titleNode.textContent = title;
  }

  function renderSlots() {
    state.renderQueued = false;
    const tabs = slotTabs();
    const nodes = [];
    // Empty slots wait only in the main window. A window that holds a
    // detached slot shows just its own slots while the main one is open.
    const cells = holdsDetached() ? Math.max(1, tabs.length) : Math.max(1, tabs.length, slotCapacity());
    slotRow.style.setProperty("--slot-cells", String(cells));
    for (let index = 0; index < cells; index++) {
      const tab = tabs[index];
      if (tab) {
        let pill = pills.get(tab);
        if (!pill) { pill = buildPill(tab); pills.set(tab, pill); }
        updatePill(pill, tab, index);
        pill.style.setProperty("--i", String(index));
        nodes.push(pill);
      } else {
        const pill = emptyPill(index);
        pill.querySelector(".slot-empty-label").textContent = `Slot ${index + 1}`;
        pill.setAttribute("aria-label", `Open slot ${index + 1}`);
        nodes.push(pill);
      }
    }
    nodes.forEach((node, index) => {
      if (slotRow.children[index] !== node) slotRow.insertBefore(node, slotRow.children[index] || null);
    });
    while (slotRow.children.length > cells) slotRow.lastElementChild.remove();
    placeShimmerAnchors();
    auraSync();
    renderUtilityButton();
    if (state.dock.visible) buildDock();
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    window.requestAnimationFrame(renderSlots);
  }

  // ------------------------------------------------------------- reordering
  // Slots are picked up with the pointer, through Firefox's own drag and
  // drop, the only kind of drag that can cross into another window. Still
  // hides the system's drag image and draws the slot itself: it follows the
  // pointer on a quick spring and leans into its motion, while the others
  // slide aside to open the place where it will land. Letting go drops it
  // there from wherever it is, keeping its speed. Escape puts it back.
  // Ctrl+Shift+Left and Right move the focused slot without dragging.
  //
  // Pulled down, a slot stretches away from the bar like rubber and springs
  // back when let go. Pulled hard enough it tears off: it catches up with
  // the pointer and sticks to it, the others close up, and letting go opens
  // it in a window of its own (the same Still window, with one slot).
  // Dragged onto another Still window it moves there instead.

  const SLOT_TYPE = "application/x-still-slot";
  const TEAR_PULL = 120;       // pointer travel below the grab point that tears a slot off
  const REDOCK_PULL = 56;      // a torn slot brought back this close rejoins the row
  const STRETCH_REACH = 44;    // how far a docked slot gives before it tears
  // Critically damped: slots glide into place and stop, without bouncing.
  const ROOM_SPRING = { omega: 30, zeta: 1 };      // slots making room
  const DROP_SPRING = { omega: 24, zeta: 1 };      // a slot settling after release
  const FOLLOW_SPRING = { omega: 62, zeta: 1 };    // the held slot trailing the pointer
  const TEAR_SPRING = { omega: 26, zeta: 0.74 };   // tearing off: catches up with a little give
  const REDOCK_SPRING = { omega: 34, zeta: 0.9 };
  const LEAN_SPRING = { omega: 22, zeta: 0.9 };
  const slotMotion = new Map();                    // pill -> spring state
  let reorder = null;
  let pendingDrag = null;
  let motionFrame = 0;
  let motionAt = 0;
  const slotLive = h("span", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  layer.append(slotLive);
  // A clear sheet over the pages while a slot is dragged, so the drag is
  // seen by Still and not by the page under the pointer.
  const dragCatcher = h("div", { id: "still-drag-catcher", "aria-hidden": "true", hidden: true });
  layer.prepend(dragCatcher);
  // The slot as it follows the pointer through another window.
  const floatGhost = h("div", { class: "still-slot-float", "aria-hidden": "true" });
  layer.append(floatGhost);
  const blankImage = document.createElementNS(HTML, "canvas");
  blankImage.width = blankImage.height = 1;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Past its limits a value gives less and less, like pulling on rubber.
  function rubber(value, min, max, reach = 36) {
    const past = value < min ? min - value : value > max ? value - max : 0;
    if (!past) return value;
    const give = reach * (1 - 1 / (past * 0.55 / reach + 1));
    return value < min ? min - give : max + give;
  }

  // Downward pull on a docked slot: generous at first, then stiffer.
  function stretch(pull) {
    return STRETCH_REACH * (1 - 1 / (pull / STRETCH_REACH + 1));
  }

  function motionOf(pill) {
    let m = slotMotion.get(pill);
    if (!m) {
      const title = pill.querySelector(".slot-title");
      m = { x: 0, v: 0, target: 0, y: 0, vy: 0, ty: 0, rot: 0, vr: 0, lean: 0, held: false, spring: ROOM_SPRING,
        left: pill.offsetLeft, titleLeft: title ? title.offsetLeft : 0 };
      slotMotion.set(pill, m);
    }
    return m;
  }

  function springStep(position, velocity, target, { omega, zeta }, dt) {
    const acceleration = -omega * omega * (position - target) - 2 * zeta * omega * velocity;
    velocity += acceleration * dt;
    return [position + velocity * dt, velocity];
  }

  function kickMotion() {
    if (motionFrame) return;
    motionAt = performance.now();
    motionFrame = window.requestAnimationFrame(stepMotion);
  }

  function stepMotion(now) {
    motionFrame = 0;
    const elapsed = Math.min(0.05, Math.max(0, (now - motionAt) / 1000));
    motionAt = now;
    const instant = !animationsAllowed();
    if (reorder?.active && now - reorder.lastAt > 40) {
      // The pointer rests: the lean fades as the speed does.
      reorder.velocity *= Math.exp(-elapsed * 10);
      motionOf(reorder.pill).lean = 0;
    }
    for (const [pill, m] of slotMotion) {
      if (instant) {
        m.x = m.target; m.y = m.ty;
        m.v = m.vy = m.vr = m.rot = 0;
      } else {
        // Small fixed steps keep the springs stable on slow frames.
        let left = elapsed;
        while (left > 0) {
          const dt = Math.min(left, 1 / 240);
          left -= dt;
          [m.x, m.v] = springStep(m.x, m.v, m.target, m.spring, dt);
          [m.y, m.vy] = springStep(m.y, m.vy, m.ty, m.spring, dt);
          [m.rot, m.vr] = springStep(m.rot, m.vr, m.held ? m.lean : 0, LEAN_SPRING, dt);
        }
      }
      const settled = !m.held && Math.abs(m.x - m.target) < 0.3 && Math.abs(m.v) < 8
        && Math.abs(m.y - m.ty) < 0.3 && Math.abs(m.vy) < 8 && Math.abs(m.rot) < 0.05 && Math.abs(m.vr) < 1;
      if (settled && !m.target && !m.ty) {
        pill.style.removeProperty("translate");
        surfaceOf(pill).style.removeProperty("rotate");
        slotMotion.delete(pill);
        continue;
      }
      if (settled) { m.x = m.target; m.y = m.ty; m.v = m.vy = 0; }
      // Device-pixel steps keep the title on the pixel grid, so it stays
      // sharp while it moves. Only the surface leans; the text stays level.
      const px = 1 / (window.devicePixelRatio || 1);
      pill.style.translate = `${Math.round(m.x / px) * px}px ${Math.round(m.y / px) * px}px`;
      surfaceOf(pill).style.rotate = `${m.rot.toFixed(3)}deg`;
      // The light seen through each slot's glass follows the slot.
      pill.style.setProperty("--pill-x", `${m.left + m.x}px`);
      pill.querySelector(".slot-title")?.style.setProperty("--title-x", `${m.left + m.x + m.titleLeft}px`);
    }
    auraFollowMotion();
    const busy = [...slotMotion.values()].some((m) => m.held || m.x !== m.target || m.v || m.y !== m.ty || m.vy || m.rot);
    if (busy) motionFrame = window.requestAnimationFrame(stepMotion);
    else if (!reorder?.active && !dropPreview) settleMotion();
  }


  function settleMotion() {
    for (const [pill] of slotMotion) {
      pill.style.removeProperty("translate");
      surfaceOf(pill).style.removeProperty("rotate");
    }
    slotMotion.clear();
    slotRow.classList.remove("reordering");
    placeShimmerAnchors();
    auraMove(slotTabs().indexOf(gBrowser.selectedTab));
  }

  // After the row's order changes, each slot keeps its place on screen and
  // springs from there to its new home.
  function rebaseMotion(visual) {
    for (const [pill, left] of visual) {
      if (!pill.isConnected) continue;
      const m = motionOf(pill);
      m.left = pill.offsetLeft;
      const title = pill.querySelector(".slot-title");
      m.titleLeft = title ? title.offsetLeft : 0;
      m.x = left - m.left;
      m.target = 0;
    }
  }

  function visualLefts() {
    return new Map([...slotRow.children].map((pill) => [pill, pill.offsetLeft + (slotMotion.get(pill)?.x || 0)]));
  }

  // A slot can be picked up when there is somewhere for it to go.
  function canDragSlot() {
    return slotTabs().length >= 2 || stillWindows().length > 0;
  }

  function attachReorder(pill) {
    pill.setAttribute("draggable", "true");
    pill.addEventListener("pointerdown", (event) => {
      pendingDrag = null;
      if (event.button !== 0 || reorder || dropPreview || event.target.closest("button, input, form")
          || state.editingTab === pill.stillTab) return;
      pendingDrag = { pill, tab: pill.stillTab, startX: event.clientX, startY: event.clientY };
    });
    pill.addEventListener("dragstart", (event) => {
      const p = pendingDrag;
      pendingDrag = null;
      if (!p || p.pill !== pill || reorder || dropPreview || state.editingTab === p.tab || !canDragSlot()) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      const dt = event.dataTransfer;
      dt.setData(SLOT_TYPE, String(p.tab.linkedBrowser?.browserId || ""));
      dt.effectAllowed = "move";
      // Still draws the slot; the system's drag image stays out of the way.
      try { dt.setDragImage(blankImage, 0, 0); } catch {}
      reorder = { ...p, active: false };
      beginReorder(p);
      dragReorder(event);
    });
  }

  function beginReorder(start) {
    const r = reorder;
    r.active = true;
    r.tabs = slotTabs();
    r.list = r.tabs.map((tab) => pills.get(tab));
    r.from = r.to = r.tabs.indexOf(r.tab);
    for (const pill of r.list) { const m = motionOf(pill); m.left = pill.offsetLeft; }
    r.lefts = r.list.map((pill) => pill.offsetLeft);
    r.step = r.lefts.length > 1 ? r.lefts[1] - r.lefts[0] : r.pill.offsetWidth;
    const m = motionOf(r.pill);
    m.held = true;
    m.spring = FOLLOW_SPRING;
    // A slot caught while it is still settling continues from where it is.
    r.baseX = m.x;
    r.baseY = m.y;
    r.lastX = start.startX;
    r.lastAt = performance.now();
    r.velocity = 0;
    r.torn = false;
    state.draggedTab = r.tab;
    // The other windows leave room for it while it is on the move.
    r.tab.stillDragging = true;
    finishEdit({ animate: false });
    showChrome();
    clearTimeout(state.hideTimer);
    slotRow.classList.add("reordering");
    r.pill.classList.add("lifted");
    for (const win of [window, ...stillWindows()]) win.StillChrome?.slotDragActive?.(true);
    // If the system ends the drag without telling (it happens), finish it
    // here, so the sheet over the pages never stays.
    r.watch = setInterval(() => {
      if (reorder !== r) { clearInterval(r.watch); return; }
      if (!dragSessionAlive()) {
        if (r.torn && slotTabs().length >= 2) finishReorder();
        else finishReorder({ cancel: !r.droppedHere });
      }
    }, 250);
  }

  function dragSessionAlive() {
    const service = Cc["@mozilla.org/widget/dragservice;1"].getService(Ci.nsIDragService);
    for (const win of [window, ...stillWindows()]) {
      try { if (service.getCurrentSession(win)) return true; } catch {}
    }
    return false;
  }

  function dragReorder(event) {
    const r = reorder;
    if (!r?.active) return;
    // Some drag events carry no position (outside the window, on Linux).
    if (!event.clientX && !event.clientY && !event.screenX && !event.screenY) return;
    const m = motionOf(r.pill);
    const now = performance.now();
    const dt = Math.max(4, now - r.lastAt);
    r.velocity = r.velocity * 0.55 + ((event.clientX - r.lastX) / dt * 1000) * 0.45;
    r.lastX = event.clientX;
    r.lastAt = now;
    const dx = event.clientX - r.startX;
    const pull = event.clientY - r.startY;
    const canTear = slotTabs().length >= 2;
    if (!r.torn && canTear && pull > TEAR_PULL) setTorn(r, true);
    else if (r.torn && pull < REDOCK_PULL) setTorn(r, false);
    const since = now - (r.modeAt || 0);
    if (r.torn) {
      // Stuck to the pointer, leaning into a fling.
      m.target = r.baseX + dx;
      m.ty = r.baseY + pull;
      m.spring = since < 260 ? TEAR_SPRING : FOLLOW_SPRING;
      m.lean = clamp(r.velocity / 320, -5, 5);
    } else {
      const min = r.lefts[0] - r.lefts[r.from];
      const max = r.lefts[r.lefts.length - 1] - r.lefts[r.from];
      m.target = rubber(r.baseX + dx, min, max);
      // Up gives a little; down stretches away from the bar, stiffer the
      // further it goes, until it tears.
      m.ty = pull >= 0 ? stretch(pull) : rubber(pull * 0.35, -4, 0, 8);
      m.spring = r.modeAt && since < 220 ? REDOCK_SPRING : FOLLOW_SPRING;
      m.lean = 0;
    }
    const to = r.torn ? r.from : clamp(Math.round((r.lefts[r.from] + m.target - r.lefts[0]) / r.step), 0, r.list.length - 1);
    if (r.torn) {
      // The others close up, as the row will look once it has left.
      r.to = r.from;
      r.list.forEach((pill, index) => {
        if (pill === r.pill) return;
        const other = motionOf(pill);
        other.target = index > r.from ? -r.step : 0;
        other.spring = ROOM_SPRING;
      });
    } else if (to !== r.to || r.redocked) {
      r.redocked = false;
      r.to = to;
      r.list.forEach((pill, index) => {
        if (pill === r.pill) return;
        let shift = 0;
        if (r.from < to && index > r.from && index <= to) shift = -r.step;
        else if (to < r.from && index >= to && index < r.from) shift = r.step;
        const other = motionOf(pill);
        other.target = shift;
        other.spring = ROOM_SPRING;
      });
    }
    kickMotion();
  }

  function setTorn(r, on) {
    r.torn = on;
    r.modeAt = performance.now();
    if (!on) r.redocked = true;
    r.pill.classList.toggle("torn", on);
    slotLive.textContent = on ? "Release to open this slot in its own window" : "";
  }

  // The pointer left this window during a drag (or came back).
  function setAway(on) {
    if (!reorder?.active || reorder.away === on) return;
    reorder.away = on;
    reorder.pill.classList.toggle("away", on);
  }

  // ------------------------------------------------------------ detaching
  // Firefox moves the live page into the new window (nothing reloads).

  function detachSlot(tab) {
    if (!tab || tab.closing) return false;
    if (slotTabs().length >= 2) {
      tab.stillLeaving = true;
      // still.cfg lets this one new window be (it folds any other second
      // window into the first one).
      state.detachingUntil = Date.now() + 8000;
      let win = null;
      try { win = gBrowser.replaceTabWithWindow(tab); } catch (error) { console.error(error); }
      if (!win) { tab.stillLeaving = false; state.detachingUntil = 0; return false; }
      // If the new window never takes it, the slot stays here as before.
      setTimeout(() => {
        state.detachingUntil = 0;
        if (!tab.closing && gBrowser.tabs.includes(tab)) {
          tab.stillLeaving = false;
          const pill = pills.get(tab);
          pill?.stillTearAnimation?.cancel();
          queueRender();
          notifyPeers();
        }
      }, 8000);
      return true;
    }
    // Alone in its window: back to the window with the most slots.
    const target = stillWindows().sort((a, b) => b.StillChrome.slotTabs().length - a.StillChrome.slotTabs().length)[0];
    if (!target) return false;
    const theirs = target.StillChrome.slotTabs();
    const last = theirs[theirs.length - 1];
    const tabIndex = last ? (Number.isInteger(last.index) ? last.index : target.gBrowser.tabs.indexOf(last)) + 1 : 0;
    tab.stillLeaving = true;
    let adopted = null;
    try { adopted = target.gBrowser.adoptTab(tab, { tabIndex, selectTab: true }); } catch (error) { console.error(error); }
    if (!adopted) { tab.stillLeaving = false; return false; }
    target.focus();
    return true;
  }

  // Letting go of a torn slot: it swells and fades as its window opens.
  function playTearAway(pill) {
    if (!animationsAllowed()) return;
    pill.stillTearAnimation = pill.animate(
      [{ opacity: 1, scale: "1" }, { opacity: 0, scale: "1.28" }],
      { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "forwards" });
  }

  // The click that ends a drag must not also switch to the slot.
  function swallowNextClick() {
    const swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
  }

  function finishReorder({ cancel = false, moved = false } = {}) {
    const r = reorder;
    reorder = null;
    pendingDrag = null;
    if (!r) return;
    clearInterval(r.watch);
    if (!r.active) return;
    swallowNextClick();
    state.draggedTab = null;
    r.tab.stillDragging = false;
    for (const win of [window, ...stillWindows()]) win.StillChrome?.slotDragActive?.(false);
    notifyPeers();
    r.pill.classList.remove("lifted", "torn", "away");
    slotLive.textContent = "";
    const m = motionOf(r.pill);
    m.held = false;
    m.ty = 0;
    if (moved) {
      // It went to another window; this row closes up when it re-renders.
      for (const pill of r.list) { const other = motionOf(pill); other.target = 0; other.ty = 0; other.spring = ROOM_SPRING; }
      kickMotion();
      return;
    }
    if (r.torn && !cancel) {
      playTearAway(r.pill);
      if (detachSlot(r.tab)) {
        m.target = m.x; m.ty = m.y;            // it stays where it was let go, fading
        for (const pill of r.list) if (pill !== r.pill) motionOf(pill).spring = ROOM_SPRING;
        kickMotion();
        return;
      }
      r.pill.stillTearAnimation?.cancel();
    }
    m.spring = DROP_SPRING;
    m.v = cancel ? 0 : clamp(r.velocity, -2400, 2400);
    m.vy = 0;
    const tabs = slotTabs();
    const to = cancel || r.torn ? r.from : r.to;
    const target = tabs[to];
    if (to !== r.from && target && target !== r.tab && tabs.includes(r.tab)) {
      const visual = visualLefts();
      gBrowser.moveTabTo(r.tab, { tabIndex: tabPos(target), forceUngrouped: true });
      renderSlots();
      rebaseMotion(visual);
      slotLive.textContent = `${slotTitle(r.tab)} moved to slot ${slotIndex(r.tab) + 1}`;
    } else {
      for (const pill of r.list) motionOf(pill).target = 0;
    }
    for (const pill of r.list) if (pill !== r.pill) motionOf(pill).spring = ROOM_SPRING;
    kickMotion();
    if (!revealOpen) scheduleChromeHide(900);
  }

  // ------------------------------------------------- slots across windows
  // While any Still window drags a slot, every Still window lays a clear
  // sheet over its pages (slotDragActive), so it sees the drag wherever the
  // pointer is. The window the slot came from steers its own row; any other
  // window shows its bar, the slot following the pointer, and the place in
  // the row where it would land.

  function draggedSlotTab() {
    for (const win of stillWindows()) {
      const tab = win.StillChrome?.state?.draggedTab;
      if (tab && !tab.closing) return tab;
    }
    return null;
  }

  function slotDragActive(on) {
    dragCatcher.hidden = !on;
    if (!on) {
      floatGhost.classList.remove("visible");
      if (dropPreview?.kind === "slot") clearDropPreview();
    }
  }

  function placeFloat(event, tab) {
    if (floatGhost.stillTab !== tab) {
      floatGhost.stillTab = tab;
      floatGhost.replaceChildren(faviconFor(tab), h("span", { class: "slot-title-plain", text: slotTitle(tab) }));
    }
    const width = slotRow.children[0]?.offsetWidth || 220;
    floatGhost.style.width = `${width}px`;
    floatGhost.style.translate = `${Math.round(event.clientX - width / 2)}px ${Math.round(event.clientY - 21)}px`;
    floatGhost.classList.add("visible");
  }

  let slotLeaveTimer = 0;
  function isSlotDrag(event) {
    return [...(event.dataTransfer?.types || [])].includes(SLOT_TYPE);
  }

  function onSlotDragOver(event) {
    if (!isSlotDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    clearTimeout(slotLeaveTimer);
    if (reorder?.active) { setAway(false); dragReorder(event); return; }
    const tab = draggedSlotTab();
    if (!tab) return;
    clearTimeout(state.hideTimer);
    if (!chrome.classList.contains("open")) showChrome(event.clientX / window.innerWidth);
    placeFloat(event, tab);
    setDropPreview(dropPlan("slot", dropIndexAt(event.clientX)));
  }

  window.addEventListener("dragenter", onSlotDragOver, true);
  window.addEventListener("dragover", onSlotDragOver, true);
  window.addEventListener("dragleave", (event) => {
    if (!isSlotDrag(event) || event.relatedTarget) return;
    clearTimeout(slotLeaveTimer);
    slotLeaveTimer = setTimeout(() => {
      if (reorder?.active) { setAway(true); return; }
      floatGhost.classList.remove("visible");
      clearDropPreview();
      if (!revealOpen) scheduleChromeHide(400);
    }, 80);
  }, true);
  window.addEventListener("drop", (event) => {
    if (!isSlotDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(slotLeaveTimer);
    if (reorder?.active) { reorder.droppedHere = true; return; }
    receiveSlot(event);
  }, true);

  // The drag ended: where it ended decides what happens.
  document.addEventListener("dragend", (event) => {
    const r = reorder;
    if (!r?.active || !isSlotDrag(event)) return;
    const dt = event.dataTransfer;
    if (dt.mozUserCancelled) finishReorder({ cancel: true });
    else if (r.droppedHere) finishReorder();
    else if (dt.dropEffect === "move" || r.tab.closing || !gBrowser.tabs.includes(r.tab)) finishReorder({ moved: true });
    else {
      // Let go outside every Still window: it becomes a window of its own.
      if (slotTabs().length >= 2) r.torn = true;
      finishReorder();
    }
  }, true);

  // A slot dropped here from another Still window moves into this row.
  function receiveSlot(event) {
    const tab = draggedSlotTab();
    floatGhost.classList.remove("visible");
    if (!tab) { clearDropPreview(); return; }
    const plan = dropPreview?.kind === "slot" ? dropPreview : dropPlan("slot", dropIndexAt(event.clientX));
    const tabs = slotTabs();
    const before = tabs[plan.index];
    const tabIndex = before ? tabPos(before) : tabs.length ? tabPos(tabs[tabs.length - 1]) + 1 : 0;
    const visual = visualLefts();
    dropPreview = null;
    dropGhost.classList.remove("visible");
    for (const node of slotRow.querySelectorAll(".drop-consumed")) node.classList.remove("drop-consumed");
    tab.stillLeaving = true;
    let adopted = null;
    try { adopted = gBrowser.adoptTab(tab, { tabIndex, selectTab: true }); } catch (error) { console.error(error); }
    if (!adopted) { tab.stillLeaving = false; clearDropPreview(); kickMotion(); return; }
    renderSlots();
    rebaseMotion(visual);
    const pill = pills.get(adopted);
    if (pill && animationsAllowed()) {
      surfaceOf(pill).animate([{ scale: ".94" }, { scale: "1" }], { duration: 280, easing: "cubic-bezier(.23, 1, .32, 1)", composite: "add" });
    }
    kickMotion();
    window.focus();
    slotLive.textContent = `${slotTitle(adopted)} moved here`;
    scheduleChromeHide(1400);
  }

  // ----------------------------------------------------------------- drops
  // Links, text and files dragged from a page can be dropped on the slots:
  // on a page slot they open there, on an empty one in a new slot. The
  // agent's tabs can be dragged from its panel into the row: the slots make
  // room and a placeholder shows where it lands (or, with all five in use,
  // the slot it would replace says so). The bar opens when a drag reaches
  // the top edge.

  const AGENT_TAB_TYPE = "application/x-still-agent-tab";
  const LINK_TYPES = ["text/x-moz-url", "text/uri-list", "text/plain", "application/x-moz-file"];
  let dropPreview = null;
  let dropLeaveTimer = 0;
  state.draggingAgentTab = null;

  const dropGhost = h("div", { class: "still-slot-ghost", "aria-hidden": "true" });
  chrome.append(dropGhost);

  function dropKind(event) {
    const types = [...(event.dataTransfer?.types || [])];
    if (types.includes(SLOT_TYPE)) return null;          // handled by onSlotDragOver
    if (types.includes(AGENT_TAB_TYPE)) return "agent";
    return LINK_TYPES.some((type) => types.includes(type)) ? "link" : null;
  }

  // Which slot the pointer is over, by the row's layout (not by the slots'
  // current, possibly shifted, positions), so the preview never flickers.
  function dropIndexAt(clientX) {
    const row = slotRow.getBoundingClientRect();
    const x = clientX - row.left;
    const nodes = [...slotRow.children];
    const gap = nodes.length > 1 ? nodes[1].offsetLeft - nodes[0].offsetLeft - nodes[0].offsetWidth : 0;
    for (let index = 0; index < nodes.length; index++) {
      if (x < nodes[index].offsetLeft + nodes[index].offsetWidth + gap / 2) return index;
    }
    return nodes.length - 1;
  }

  function dropPlan(kind, index) {
    const tabs = slotTabs();
    const tab = tabs[index] || null;
    if (kind === "link") return { kind, index, tab, mode: tab ? "load" : "new", hint: tab ? "Open here" : "Open in a new slot" };
    // A slot from another window: the five-slot total stays the same.
    if (kind === "slot") return { kind, index: Math.min(index, tabs.length), tab, mode: "insert", hint: "", agentTab: draggedSlotTab() };
    const agentTab = state.draggingAgentTab;
    if (tabs.length >= slotCapacity()) return { kind, index, tab, mode: "replace", hint: "Replace" };
    return { kind, index: Math.min(index, tabs.length), tab, mode: "insert", hint: "", agentTab };
  }

  function setDropPreview(plan) {
    const same = plan && dropPreview && plan.mode === dropPreview.mode && plan.index === dropPreview.index && plan.kind === dropPreview.kind;
    if (same) return;
    for (const node of slotRow.querySelectorAll(".drop-load, .drop-new, .drop-replace, .drop-consumed")) {
      node.classList.remove("drop-load", "drop-new", "drop-replace", "drop-consumed");
    }
    dropPreview = plan;
    const occupied = slotTabs().map((tab) => pills.get(tab)).filter(Boolean);
    if (plan) slotRow.classList.add("reordering");
    occupied.forEach((pill, index) => {
      const m = motionOf(pill);
      m.left = pill.offsetLeft;
      m.target = plan?.mode === "insert" && index >= plan.index ? pill.offsetWidth + gapOf() : 0;
      m.spring = ROOM_SPRING;
    });
    if (plan?.mode === "insert") {
      // The first empty slot is where the row's last slot moves to.
      slotRow.children[occupied.length]?.classList.add("drop-consumed");
      placeGhost(plan);
    } else {
      dropGhost.classList.remove("visible");
      const node = plan ? slotRow.children[plan.index] : null;
      if (node) {
        node.classList.add(`drop-${plan.mode}`);
        const hint = node.querySelector(".slot-drop-hint");
        if (hint) hint.textContent = plan.hint;
      }
    }
    kickMotion();
  }

  function gapOf() {
    return parseFloat(getComputedStyle(slotRow).columnGap) || 8;
  }

  function placeGhost(plan) {
    const node = slotRow.children[plan.index];
    if (!node) return;
    const tab = plan.agentTab;
    dropGhost.replaceChildren(
      tab ? faviconFor(tab) : h("span", { class: "slot-favicon placeholder", text: "+" }),
      h("span", { class: "slot-title-plain", text: tab ? slotTitle(tab) : "Agent tab" }));
    dropGhost.style.left = `${slotRow.offsetLeft + node.offsetLeft}px`;
    dropGhost.style.top = `${slotRow.offsetTop + node.offsetTop}px`;
    dropGhost.style.width = `${node.offsetWidth}px`;
    dropGhost.style.height = `${node.offsetHeight}px`;
    dropGhost.classList.add("visible");
  }

  function clearDropPreview() {
    clearTimeout(dropLeaveTimer);
    if (!dropPreview) return;
    setDropPreview(null);
  }

  function onDragOver(event) {
    const kind = dropKind(event);
    if (!kind || reorder?.active) return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(dropLeaveTimer);
    clearTimeout(state.hideTimer);
    if (!chrome.classList.contains("open")) showChrome(event.clientX / window.innerWidth);
    event.dataTransfer.dropEffect = kind === "agent" ? "move" : "link";
    setDropPreview(dropPlan(kind, dropIndexAt(event.clientX)));
  }

  slotRow.addEventListener("dragenter", onDragOver);
  slotRow.addEventListener("dragover", onDragOver);
  slotRow.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && slotRow.contains(event.relatedTarget)) return;
    clearTimeout(dropLeaveTimer);
    dropLeaveTimer = setTimeout(clearDropPreview, 70);
  });
  slotRow.addEventListener("drop", (event) => {
    const kind = dropKind(event);
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    const plan = dropPlan(kind, dropIndexAt(event.clientX));
    if (kind === "agent") {
      const id = Number(event.dataTransfer.getData(AGENT_TAB_TYPE));
      const tab = gBrowser.tabs.find((candidate) => candidate.linkedBrowser?.browserId === id);
      placeAgentTab(tab, plan);
    } else {
      dropLink(event, plan);
      clearDropPreview();
    }
    scheduleChromeHide(1400);
  });

  // A drag from the page reaching the top edge opens the bar.
  reveal.addEventListener("dragenter", (event) => {
    if (dropKind(event)) showChrome(event.clientX / window.innerWidth);
  });
  chrome.addEventListener("dragover", (event) => {
    if (dropKind(event)) clearTimeout(state.hideTimer);
  });
  chrome.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && chrome.contains(event.relatedTarget)) return;
    if (!state.draggingAgentTab && !revealOpen) scheduleChromeHide(500);
  });

  function dropLink(event, plan) {
    let links = [];
    // `true` refuses javascript: and data: links, as Firefox's tab bar does.
    try { links = Services.droppedLinkHandler.dropLinks(event, true); } catch {}
    const link = links?.find((item) => item.url);
    if (!link) return;
    const raw = link.url.trim();
    const address = /^[a-z][a-z0-9+.-]*:\S+$/i.test(raw) || /^(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(raw)
      || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(raw);
    let tab = plan.tab;
    if (plan.mode === "new" || !tab) tab = openNewSlot({ url: "about:blank" });
    if (!tab) return;
    activate(tab);
    if (!address) {
      // Plain text: search for it in Still Search.
      loadInTab(tab, normalizeInput(raw));
      return;
    }
    const activeEntry = tab.linkedBrowser.browsingContext?.activeSessionHistoryEntry;
    if (activeEntry) activeEntry.hasUserInteraction = true;
    tab.linkedBrowser.fixupAndLoadURIString(raw, {
      triggeringPrincipal: Services.droppedLinkHandler.getTriggeringPrincipal(event),
      policyContainer: Services.droppedLinkHandler.getPolicyContainer(event),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP
    });
    gBrowser.selectedBrowser.focus();
  }

  // An agent tab joins the slots at the place it was dropped. With all five
  // in use it replaces the slot under it, which Undo brings back.
  function placeAgentTab(tab, plan) {
    if (!tab || tab.closing || !tab.hidden) { clearDropPreview(); return; }
    const visual = visualLefts();
    tab.stillAgent = false;
    try { SessionStore.deleteCustomTabValue(tab, AGENT_KEY); } catch {}
    if (plan.mode === "replace" && plan.tab) {
      const replaced = plan.tab;
      const at = slotIndex(replaced);
      const title = slotTitle(replaced);
      gBrowser.showTab(tab);
      gBrowser.moveTabTo(tab, { tabIndex: tabPos(replaced), forceUngrouped: true });
      gBrowser.selectedTab = tab;
      gBrowser.removeTab(replaced, { animate: false });
      clearDropPreview();
      renderAgentChips();
      showToast(`${title} closed to make room`, 6000, { label: "Undo", run: () => undoAgentReplace(tab, at) });
      return;
    }
    const tabs = slotTabs();
    gBrowser.showTab(tab);
    const before = tabs[plan.index];
    if (before) {
      gBrowser.moveTabTo(tab, { tabIndex: tabPos(tab) < tabPos(before) ? tabPos(before) - 1 : tabPos(before), forceUngrouped: true });
    } else if (tabs.length) {
      const last = tabs[tabs.length - 1];
      gBrowser.moveTabTo(tab, { tabIndex: tabPos(tab) < tabPos(last) ? tabPos(last) : tabPos(last) + 1, forceUngrouped: true });
    }
    dropPreview = null;
    dropGhost.classList.remove("visible");
    for (const node of slotRow.querySelectorAll(".drop-consumed")) node.classList.remove("drop-consumed");
    gBrowser.selectedTab = tab;
    renderSlots();
    rebaseMotion(visual);
    // It lands where its placeholder was, growing from the placeholder's size.
    const pill = pills.get(tab);
    if (pill && animationsAllowed()) {
      pill.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(0, 0, .58, 1)" });
      surfaceOf(pill).animate([{ scale: ".94" }, { scale: "1" }], { duration: 280, easing: "cubic-bezier(.23, 1, .32, 1)", composite: "add" });
    }
    kickMotion();
    renderAgentChips();
    if (!agentPanel.hidden) renderAgentPanel();
  }

  // Undo a replace: the agent tab goes back to the agent, and the closed
  // slot reopens in its old place.
  function undoAgentReplace(tab, index) {
    if (tab && !tab.closing) {
      tab.stillAgent = true;
      try { SessionStore.setCustomTabValue(tab, AGENT_KEY, "1"); } catch {}
      gBrowser.hideTab(tab);
    }
    state.bypassLimit = true;
    let restored;
    try { restored = SessionStore.undoCloseTab(window, 0); } finally { state.bypassLimit = false; }
    if (!restored) return;
    const target = slotTabs()[index];
    if (target && target !== restored) gBrowser.moveTabTo(restored, { tabIndex: tabPos(target), forceUngrouped: true });
    gBrowser.selectedTab = restored;
    renderAgentChips();
    if (!agentPanel.hidden) renderAgentPanel();
  }

  // Move a slot without dragging (Ctrl+Shift+Left/Right): the slots glide
  // to their new places on the same springs as a drag.
  function moveSlot(tab, targetIndex) {
    const tabs = slotTabs();
    const target = tabs[Math.max(0, Math.min(tabs.length - 1, targetIndex))];
    if (!target || target === tab || reorder?.active) return;
    const visual = visualLefts();
    gBrowser.moveTabTo(tab, { tabIndex: tabPos(target), forceUngrouped: true });
    renderSlots();
    slotRow.classList.add("reordering");
    rebaseMotion(visual);
    kickMotion();
    showChrome();
    slotLive.textContent = `${slotTitle(tab)} moved to slot ${slotIndex(tab) + 1}`;
  }

  // ----------------------------------------------------------- slot editor

  // Editing an address opens a sheet that grows out of the slot: a roomy
  // field with the page's icon, history suggestions with real site icons,
  // and Still Search. The pill stays in place, marked as the one being edited.
  function focusStartPage(tab) {
    if (tab !== gBrowser.selectedTab) activate(tab, 0);
    finishEdit({ animate: false });
    scheduleChromeHide(250);
    gBrowser.selectedBrowser.focus();
  }

  // Double-click (or Ctrl+L) turns the slot itself into the address field,
  // like a browser's URL bar. Suggestions drop down from that slot as one
  // surface with it.
  function beginEdit(tab) {
    if (!tab) return;
    // A start page already has a search box; use that instead.
    if (isHomeUrl(tabUrl(tab))) { focusStartPage(tab); return; }
    if (tab !== gBrowser.selectedTab) activate(tab, 0);
    renderSlots();
    const pill = pills.get(tab);
    if (!pill) return;
    finishEdit({ animate: false });
    state.editingTab = tab;
    showChrome();
    pill.classList.add("editing");
    const { field, sheet } = buildEditor(tab, pill);
    const title = pill.querySelector(".slot-title");
    if (title) title.replaceWith(field);
    chrome.append(sheet);
    placeSheet(sheet, pill);
    const input = field.querySelector("input");
    input.focus();
    input.select();
    if (animationsAllowed()) {
      field.animate([{ opacity: 0.4, transform: "translateX(-4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: EASE });
    }
  }

  // Under the edited slot, at least wide enough to read, kept in the window.
  // Layout coordinates, so it lines up even while the bar is sliding in.
  function placeSheet(sheet, pill) {
    const box = { x: pill.offsetLeft + slotRow.offsetLeft, y: pill.offsetTop + slotRow.offsetTop, width: pill.offsetWidth, height: pill.offsetHeight };
    const inset = parseFloat(getComputedStyle(chrome).getPropertyValue("--still-toolbar-edge")) || 16;
    const width = Math.min(Math.max(box.width, 520), chrome.clientWidth - 2 * inset);
    const left = Math.max(inset, Math.min(box.x, chrome.clientWidth - width - inset));
    sheet.style.width = `${width}px`;
    sheet.style.left = `${left}px`;
    sheet.style.top = `${box.y + box.height - 1}px`;
    // Square the corner where the slot joins the list.
    sheet.style.borderTopLeftRadius = Math.abs(left - box.x) < 1 ? "0" : "";
    sheet.style.borderTopRightRadius = Math.abs(left + width - (box.x + box.width)) < 1 ? "0" : "";
  }

  function finishEdit({ hide = false, animate = true } = {}) {
    const tab = state.editingTab;
    if (!tab) return;
    state.editingTab = null;
    const pill = pills.get(tab);
    if (pill) {
      pill.classList.remove("editing", "open");
      const field = pill.querySelector(".slot-inline");
      if (field) field.replaceWith(h("span", { class: "slot-title", text: slotTitle(tab) }));
    }
    const sheet = chrome.querySelector(".address-sheet");
    if (sheet) {
      if (animate && animationsAllowed() && !sheet.hidden) {
        sheet.style.pointerEvents = "none";
        sheet.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }],
          { duration: 130, easing: "ease-in", fill: "forwards" }).finished.then(() => sheet.remove(), () => sheet.remove());
      } else {
        sheet.remove();
      }
    }
    queueRender();
    if (hide) scheduleChromeHide();
  }

  // The site's letter, replaced by its real icon only when Firefox has one
  // stored (no network request; never Firefox's dark default globe).
  function siteIcon(url, size = 20) {
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    const letter = h("span", { class: "address-icon letter", "aria-hidden": "true", text: (host[0] || "\u00b7").toUpperCase() });
    if (!/^https?:/i.test(url)) return letter;
    PlacesUtils.favicons.getFaviconForPage(Services.io.newURI(url), size * (window.devicePixelRatio || 1)).then((favicon) => {
      if (!favicon || !letter.isConnected) return;
      const img = h("img", { class: "address-icon", alt: "", width: size, height: size, src: `page-icon:${url}` });
      img.addEventListener("load", () => letter.replaceWith(img), { once: true });
    }, () => {});
    return letter;
  }

  async function historyCandidates(query) {
    const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT url, title, visit_count, typed FROM moz_places
       WHERE hidden = 0 AND visit_count > 0
         AND (url LIKE :pattern ESCAPE '\\' OR title LIKE :pattern ESCAPE '\\')
       ORDER BY frecency DESC LIMIT 80`, { pattern });
    return rows.map((row) => ({
      url: row.getResultByName("url"),
      title: row.getResultByName("title") || "",
      visitCount: row.getResultByName("visit_count") || 0,
      typedCount: row.getResultByName("typed") ? 4 : 0
    }));
  }

  function suggestionLabel(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch { return url; }
  }

  // Ranking carried over from the Electron build so muscle memory still works.
  function rankMatches(history, value, limit = 5) {
    const query = value.trim().toLocaleLowerCase();
    if (!query || /^[a-z]+:\/\//i.test(query)) return [];
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = [];
    const sites = new Map();
    const brands = { youtube: "YouTube", github: "GitHub", linkedin: "LinkedIn", tiktok: "TikTok" };
    history.forEach((entry, index) => {
      try {
        const parsed = new URL(entry.url);
        if (!/^https?:$/.test(parsed.protocol)) return;
        const host = parsed.hostname.replace(/^www\./, "").toLocaleLowerCase();
        const stem = host.split(".")[0];
        const title = entry.title.toLocaleLowerCase();
        const url = entry.url.toLocaleLowerCase();
        if (!tokens.every((token) => `${host} ${title} ${url}`.includes(token))) return;
        let score = 0;
        if (stem === query || host === query) score += 1100;
        else if (stem.startsWith(query) || host.startsWith(query)) score += 900;
        else if (host.includes(query)) score += 700;
        if (title.startsWith(query)) score += 620;
        else if (title.includes(query)) score += 470;
        if (url.includes(query)) score += 260;
        score += Math.min(180, entry.typedCount * 24);
        score += Math.min(140, Math.log2(entry.visitCount + 1) * 18);
        score += Math.max(0, 90 - index);
        if (tokens.length === 1 && stem.startsWith(query)) {
          const root = `${parsed.protocol}//${parsed.host}/`;
          const siteScore = score + 320;
          if (!sites.has(root) || sites.get(root).score < siteScore) {
            sites.set(root, { url: root, title: brands[stem] || stem.charAt(0).toUpperCase() + stem.slice(1), score: siteScore, label: suggestionLabel(root) });
          }
          if (parsed.pathname !== "/") score -= Math.min(360, 140 + parsed.pathname.length * 8);
          if (/\/(?:sign-?in|login|logout|auth|account)(?:\/|$)/i.test(parsed.pathname)) score -= 520;
        }
        matches.push({ ...entry, score, label: suggestionLabel(entry.url) });
      } catch {}
    });
    matches.push(...sites.values());
    const unique = new Map();
    for (const match of matches) {
      let key = match.url;
      try { const parsed = new URL(match.url); parsed.hostname = parsed.hostname.replace(/^www\./, ""); key = parsed.href; } catch {}
      if (!unique.has(key) || unique.get(key).score < match.score) unique.set(key, match);
    }
    return [...unique.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  function buildEditor(tab, pill) {
    const sheet = h("div", { class: "address-sheet", hidden: true });
    const form = h("form", { class: "slot-inline", autocomplete: "off" });
    const current = displayUrl(tabUrl(tab));
    const input = h("input", { type: "text", spellcheck: "false", placeholder: "Search or enter address",
      "aria-label": `Search or enter address for slot ${slotIndex(tab) + 1}`, "aria-controls": "still-address-list", "aria-autocomplete": "list" });
    input.value = current;
    const list = h("div", { class: "address-list", id: "still-address-list", role: "listbox" });
    sheet.append(list);
    let suggestions = [];
    let suggestionsFor = "";
    let selected = -1;
    const showList = (visible) => {
      sheet.hidden = !visible;
      pill.classList.toggle("open", visible);
      if (visible) placeSheet(sheet, pill);
    };

    const rows = () => [...list.querySelectorAll(".address-row")];
    const paintSelection = () => rows().forEach((node, index) => {
      node.classList.toggle("selected", index === selected);
      node.setAttribute("aria-selected", String(index === selected));
    });

    const commit = (chosenUrl = "") => {
      const value = input.value;
      // Only trust suggestions made for exactly what is typed now.
      const fresh = suggestionsFor === value.trim();
      const pick = fresh && selected >= 0 ? suggestions[selected] : null;
      const url = chosenUrl || pick?.url || normalizeInput(value);
      finishEdit();
      if (url && url !== tabUrl(tab)) navigateWithSlide(tab, url);
      else gBrowser.selectedBrowser.focus();
      scheduleChromeHide();
    };

    const renderSuggestions = async () => {
      const query = input.value.trim();
      const token = ++state.suggestionToken;
      if (!query || query === current) {
        showList(false);
        list.replaceChildren();
        suggestions = [];
        suggestionsFor = query;
        selected = -1;
        return;
      }
      let ranked = [];
      try { ranked = rankMatches(await historyCandidates(query), query); } catch {}
      if (token !== state.suggestionToken || state.editingTab !== tab) return;
      const lower = query.toLocaleLowerCase();
      const learn = (lower === "learn" || lower === "still learn") && managerUrl();
      const direct = !learn && !/\s/.test(query) && /^(https?:|localhost|[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$)/i.test(query);
      const searchItem = learn
        ? { kind: "action", url: managerUrl(), title: "Open Still Learn", label: "Your selected YouTube channels only" }
        : direct
          ? { kind: "action", url: normalizeInput(query), title: `Go to ${query}`, label: normalizeInput(query) }
          : { kind: "search", url: normalizeInput(query), title: query, label: "Search" };
      suggestions = [...ranked.map((item) => ({ kind: "page", ...item })), searchItem];
      suggestionsFor = query;
      // A strong history hit (typed the start of a site you use) goes first.
      selected = ranked[0]?.score >= 900 ? 0 : suggestions.length - 1;
      list.replaceChildren(...suggestions.map((item, index) => {
        const glyph = item.kind === "page" ? siteIcon(item.url)
          : h("span", { class: "address-icon glyph", "aria-hidden": "true" },
            icon(item.kind === "search" ? [["circle", { cx: "10.8", cy: "10.8", r: "6.6" }], "m15.8 15.8 4 4"] : ["M5 12h13m-5-5 5 5-5 5"]));
        const row = h("button", { type: "button", role: "option", class: `address-row ${item.kind}` },
          glyph, h("span", { class: "address-title", text: item.title || item.label }), h("small", { text: item.label }));
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("mouseenter", () => { selected = index; paintSelection(); });
        row.addEventListener("click", () => commit(item.url));
        return row;
      }));
      showList(true);
      paintSelection();
    };

    form.append(input);
    sheet.addEventListener("mousedown", (event) => event.preventDefault());
    form.addEventListener("click", (event) => event.stopPropagation());
    form.addEventListener("dblclick", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => { event.preventDefault(); commit(); });
    input.addEventListener("input", renderSuggestions);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "ArrowDown" && suggestions.length) {
        event.preventDefault();
        selected = (selected + 1) % suggestions.length;
        paintSelection();
      } else if (event.key === "ArrowUp" && suggestions.length) {
        event.preventDefault();
        selected = (selected - 1 + suggestions.length) % suggestions.length;
        paintSelection();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finishEdit({ hide: true });
        gBrowser.selectedBrowser.focus();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (state.editingTab === tab && !form.contains(document.activeElement)) finishEdit({ hide: true });
      }, 120);
    });
    return { field: form, sheet };
  }

  // ------------------------------------------------------- slot lifecycle

  function activate(tab, direction = null) {
    if (!tab || tab.closing) return;
    cancelEdgeEffects();
    if (tab === gBrowser.selectedTab) return;
    state.nextDirection = direction;
    gBrowser.selectedTab = tab;
  }

  function openNewSlot({ edit = false, direction = null, url = "" } = {}) {
    const tabs = slotTabs();
    if (tabs.length >= slotCapacity()) {
      const home = tabs.find(isHomeTab);
      if (home) {
        activate(home, direction);
        if (url) navigateWithSlide(home, url);
        else if (edit) focusStartPage(home);
        return home;
      }
      showChrome();
      showToast(tabs.length < SLOT_COUNT
        ? "All five slots are in use across your Still windows. Close one before opening another page."
        : "All five slots are in use. Close one before opening another page.");
      return null;
    }
    let created;
    state.bypassLimit = true;
    try {
      created = gBrowser.addTrustedTab(url || BROWSER_NEW_TAB_URL);
    } finally {
      state.bypassLimit = false;
    }
    state.nextDirection = direction ?? 1;
    gBrowser.selectedTab = created;
    if (edit && !url) focusStartPage(created);
    return created;
  }

  function closeSlot(tab) {
    if (!tab) return;
    if (state.editingTab === tab) finishEdit();
    gBrowser.removeTab(tab, { animate: false, closeWindowWithLastTab: false });
  }

  // Layout box of a slot inside the bar (ignores entrance transforms).
  function pillBox(tab) {
    const pill = pills.get(tab);
    if (!pill?.isConnected) return null;
    return { x: pill.offsetLeft + slotRow.offsetLeft, y: pill.offsetTop + slotRow.offsetTop, width: pill.offsetWidth, height: pill.offsetHeight };
  }

  // Each slot's place in the row, which the soul's drawing reads (below).
  function placeShimmerAnchors() {
    for (const pill of slotRow.children) {
      pill.style.setProperty("--pill-x", `${pill.offsetLeft}px`);
      const title = pill.querySelector(".slot-title");
      if (title) title.style.setProperty("--title-x", `${pill.offsetLeft + title.offsetLeft}px`);
    }
  }

  // Centre of the band at strip position x (slot units, in row pixels).
  function shimmerCenterAt(x, centers) {
    const last = centers.length - 1;
    const clamped = Math.max(0, Math.min(last, x));
    const from = Math.floor(clamped);
    const to = Math.min(last, from + 1);
    return centers[from] + (centers[to] - centers[from]) * (clamped - from);
  }

  // ------------------------------------------------------------ the soul
  // The current slot is lit: a brighter fill, a brighter outline (dark
  // themes), its title at full strength and its close button showing. That
  // light, the soul, has a position in slot units (--soul-p on the row).
  // Each slot is lit by how close the soul is to it, as a whole (never cut
  // in half), with a soft S-curve. Switching moves the soul on the page
  // strip's own spring, so the light hands over from slot to slot in step
  // with the sliding pages; a jump across several slots briefly lights the
  // ones in between, and a fast Ctrl+wheel spin carries it with momentum.
  // At rest it is simply the current slot: nothing has to fade out.

  const soul = { index: -1, animation: null };
  const aura = soul;           // older code reads aura.index for the selected slot
  const auraReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  function surfaceOf(pill) {
    return pill.stillSurface || pill;
  }

  function soulStop() {
    soul.animation?.cancel();
    soul.animation = null;
  }

  // Rest the soul on slot `index` at once.
  function auraMove(index) {
    if (index < 0) return;
    soulStop();
    soul.index = index;
    slotRow.style.setProperty("--soul-p", String(index));
  }

  // Follow the strip's spring samples (slot units over `duration` s). The
  // samples start where the strip is now, so a retarget never jumps.
  function soulGlide(samples, duration) {
    const target = Math.round(samples[samples.length - 1]);
    if (!animationsAllowed() || duration <= 0) { auraMove(target); return; }
    soulStop();
    soul.index = target;
    const last = samples.length - 1;
    const frames = samples.map((value, k) => ({ "--soul-p": value.toFixed(4), offset: k / last }));
    const animation = slotRow.animate(frames, { duration: duration * 1000, easing: "linear", fill: "forwards" });
    soul.animation = animation;
    animation.onfinish = () => {
      if (soul.animation !== animation) return;
      slotRow.style.setProperty("--soul-p", samples[last].toFixed(4));
      soulStop();
    };
  }

  function glideShimmer(samples, duration) {
    soulGlide(samples, duration);
  }

  // Keep the soul on the selected slot when nothing is moving it.
  function auraSync() {
    const index = slotTabs().indexOf(gBrowser.selectedTab);
    if (index < 0 || soul.animation) return;
    if (index !== soul.index) auraMove(index);
  }

  function auraSettle() {
    if (soul.index >= 0) auraMove(soul.index);
  }

  // A dragged slot keeps its light: the soul follows the selected slot's
  // place in the row as soon as the order changes.
  function auraFollowMotion() {
    const index = slotTabs().indexOf(gBrowser.selectedTab);
    if (index >= 0 && index !== soul.index && !soul.animation) auraMove(index);
  }

  // A real change of the row's width re-places the slots' anchors.
  let auraRowWidth = 0;
  new ResizeObserver(() => {
    const width = slotRow.offsetWidth;
    if (!width || width === auraRowWidth) return;
    auraRowWidth = width;
    placeShimmerAnchors();
  }).observe(slotRow);
  auraReduced.addEventListener("change", auraSettle);

  // Ctrl+scroll shows the slots from the top while switching, with the
  // light flowing to each new slot, then slides them away again.
  function peekChrome() {
    clearTimeout(state.peekTimer);
    const pill = pills.get(gBrowser.selectedTab);
    const box = pill?.getBoundingClientRect();
    if (!chrome.classList.contains("open")) showChrome(box ? (box.left + box.width / 2) / window.innerWidth : 0.5);
    chrome.classList.add("peek");
    state.peekTimer = setTimeout(() => {
      chrome.classList.remove("peek");
      if (!chromeBusy() && !revealOpen) chrome.classList.remove("open");
    }, 1100);
  }

  function cycleSlot(direction) {
    const tabs = slotTabs();
    if (!tabs.length) return;
    hideUtilityPanel();
    clearTimeout(state.hideTimer);
    peekChrome();
    const current = Math.max(0, tabs.indexOf(gBrowser.selectedTab));
    if (direction > 0 && current === tabs.length - 1) {
      if (tabs.length < slotCapacity() && !holdsDetached()) armNewSlotEdge();
      else bumpWall("right");
      return;
    }
    if (direction < 0 && current === 0) {
      bumpWall("left");
      return;
    }
    cancelEdgeEffects();
    activate(tabs[current + direction], direction);
  }

  // ------------------------------------------------------- slot strip
  // All slots sit side by side on one strip, and a spring moves the strip.
  // Every input retargets the spring from its current position *and speed*,
  // so a fast Ctrl+wheel spin glides through slots with momentum instead of
  // restarting a fixed animation per notch. The edges use the same spring:
  // a notch there gives the strip a push and it rubber-bands back.
  //
  // The spring is sampled ahead of time into keyframes and handed to
  // Firefox's compositor, so it runs at the display's refresh rate (144 Hz
  // and up) and is not slowed by work on the browser's main thread. Firefox
  // keeps up to five tabs painted (browser.tabs.remote.tabCacheSize), so the
  // pages on the strip are live, not screenshots.

  // Critically damped: the strip keeps its momentum but lands exactly on the
  // slot, never past it, so nothing beyond the last page is ever exposed.
  const SPRING = { omega: 16 };            // ~0.3 s to 95%, no overshoot
  // Edges stretch the page instead of sliding it (no gap behind the page).
  const STRETCH = { omega: 17, kick: 0.9, max: 0.075, hold: 0.018 };

  // Critically damped spring toward `target` from position x0 with speed v0.
  function springAt(seg, t, omega = SPRING.omega) {
    const a0 = seg.x0 - seg.target;
    const b0 = seg.v0 + omega * a0;
    const decay = Math.exp(-omega * t);
    return {
      x: seg.target + (a0 + b0 * t) * decay,
      v: (b0 - omega * (a0 + b0 * t)) * decay
    };
  }

  function springDuration(seg, omega = SPRING.omega) {
    // Until the motion is within ~0.3 px of rest on a wide window.
    for (let t = 0.05; t < 1.2; t += 0.01) {
      const { x, v } = springAt(seg, t, omega);
      if (Math.abs(x - seg.target) < 0.00015 && Math.abs(v) < 0.01) return Math.max(0.12, t);
    }
    return 1.2;
  }

  // The same spring as a CSS easing curve (0 to 1), for motion that is not
  // on the strip, such as back/forward, so everything moves with one feel.
  let springEasingCache = "";
  function springEasing() {
    if (springEasingCache) return springEasingCache;
    const seg = { x0: 0, v0: 0, target: 1 };
    const duration = springDuration(seg);
    const points = [];
    for (let k = 0; k <= 40; k++) points.push(springAt(seg, (k / 40) * duration).x.toFixed(4));
    points[40] = "1";
    springEasingCache = { easing: `linear(${points.join(", ")})`, duration: Math.round(duration * 1000) };
    return springEasingCache;
  }

  function stripWidth() {
    return gBrowser.tabpanels.getBoundingClientRect().width || window.innerWidth;
  }

  function stripNow() {
    const strip = state.strip;
    if (!strip) return null;
    // The running animation's own time is exactly what is on screen; the
    // wall clock can be a frame ahead of the last painted frame.
    const animationTime = strip.animations?.[0]?.currentTime;
    const t = Math.max(0, (Number.isFinite(animationTime) ? animationTime : performance.now() - strip.start) / 1000);
    return t >= strip.duration ? { x: strip.target, v: 0 } : springAt(strip, t);
  }

  function finishSlide() {
    const strip = state.strip;
    if (!strip) return;
    state.strip = null;
    state.slide = null;
    clearTimeout(strip.timer);
    for (const panel of strip.panels) {
      panel.getAnimations().forEach((animation) => animation.cancel());
      panel.classList.remove("still-slide-out", "still-slide-in");
    }
    document.documentElement.removeAttribute("still-moving");
  }

  // Moves the strip so that slot `target` (a slot index, fractions allowed)
  // is in view, starting from where it is now and how fast it is moving.
  function moveStrip(target, { from = null, kick = 0 } = {}) {
    if (!animationsAllowed() || document.documentElement.hasAttribute("inDOMFullscreen")) {
      finishSlide();
      return;
    }
    const now = stripNow();
    // At rest the strip sits on the selected slot.
    const x0 = now ? now.x : (from ?? selectedSlotIndex());
    let v0 = now ? now.v : 0;
    // From rest, start already moving so the slide answers the input at
    // once. Kept below omega x distance, the point where a critically damped
    // spring would overshoot, so it still lands exactly on the slot.
    if (!now && !kick && target !== x0) {
      const distance = target - x0;
      v0 = Math.sign(distance) * Math.min(7, SPRING.omega * Math.abs(distance) * 0.45);
    }
    if (kick) {
      v0 = Math.sign(kick) === Math.sign(v0) || !v0 ? v0 + kick : kick;
    }
    if (Math.abs(x0 - target) < 0.0005 && Math.abs(v0) < 0.01) { finishSlide(); return; }

    const seg = { x0, v0, target, start: performance.now() };
    seg.duration = springDuration(seg);
    // Range the strip covers during this motion, to know which slots show.
    let low = Math.min(x0, target);
    let high = Math.max(x0, target);
    const steps = Math.max(24, Math.round(seg.duration * 90));
    const samples = [];
    for (let k = 0; k <= steps; k++) {
      const t = (k / steps) * seg.duration;
      const x = k === steps ? target : springAt(seg, t).x;
      samples.push(x);
      low = Math.min(low, x);
      high = Math.max(high, x);
    }

    const tabs = slotTabs();
    const width = stripWidth();
    const visible = [];
    // Only slots that actually pass through the window are animated.
    tabs.forEach((tab, index) => {
      if (samples.some((x) => Math.abs(index - x) < 0.999)) {
        const panel = panelOf(tab);
        if (panel) visible.push({ panel, index });
      }
    });

    const previous = state.strip;
    if (previous) {
      clearTimeout(previous.timer);
      for (const panel of previous.panels) {
        if (!visible.some((item) => item.panel === panel)) panel.classList.remove("still-slide-out", "still-slide-in");
      }
    }

    // Created in the same task, these animations start on the same frame, so
    // the panels move as one strip (no shared start time is forced: the
    // timeline clock can be stale while the window is in the background).
    const animations = [];
    for (const { panel, index } of visible) {
      panel.getAnimations().forEach((animation) => animation.cancel());
      panel.classList.add(panel.classList.contains("deck-selected") ? "still-slide-in" : "still-slide-out");
      const frames = samples.map((x, k) => ({
        transform: `translate3d(${((index - x) * width).toFixed(2)}px, 0, 0)`,
        offset: k / steps
      }));
      animations.push(panel.animate(frames, { duration: seg.duration * 1000, easing: "linear", fill: "both" }));
    }

    state.strip = { ...seg, panels: visible.map((item) => item.panel), animations };
    glideShimmer(samples, seg.duration);
    // Keep the spring's clock on the frame the motion really started, so a
    // retarget reads the exact position and speed on screen.
    const live = state.strip;
    animations[0]?.ready.then(() => {
      if (state.strip === live) live.start = performance.now() - (animations[0].currentTime || 0);
    }, () => {});
    state.slide = state.strip;
    document.documentElement.setAttribute("still-moving", "");
    const strip = state.strip;
    strip.timer = setTimeout(() => {
      if (state.strip !== strip) return;
      // Leave the strip resting (e.g. leaning toward "+") until told otherwise.
      if (Math.abs(target - Math.round(target)) > 0.001) return;
      finishSlide();
      warmNeighbors();
    }, seg.duration * 1000 + 30);
  }

  // Where the strip currently rests, in slot units: the selected slot.
  function selectedSlotIndex() {
    return Math.max(0, slotIndex(gBrowser.selectedTab));
  }

  // Ask Firefox to paint likely next slots ahead of time so they are ready.
  function warmTab(tab) {
    if (!tab || tab === gBrowser.selectedTab || tab.closing) return;
    try { gBrowser.warmupTab(tab); } catch {}
  }

  function warmNeighbors() {
    const tabs = slotTabs();
    const index = tabs.indexOf(gBrowser.selectedTab);
    warmTab(tabs[index - 1]);
    warmTab(tabs[index + 1]);
  }

  const tabpanels = gBrowser.tabpanels;
  const originalUpdateSelectedIndex = tabpanels.updateSelectedIndex;
  tabpanels.updateSelectedIndex = function stillUpdateSelectedIndex(value, oldPanel) {
    const previous = oldPanel === undefined ? this.querySelector(":scope > .deck-selected") : oldPanel;
    const result = originalUpdateSelectedIndex.call(this, value, oldPanel);
    try { onDeckSwitched(previous, this.querySelector(":scope > .deck-selected")); } catch (error) { console.error(error); }
    return result;
  };

  function onDeckSwitched(previousPanel, nextPanel) {
    const requested = state.nextDirection;
    state.nextDirection = null;
    if (!previousPanel || !nextPanel || previousPanel === nextPanel) return;
    finishVertical(true);
    const previousTab = tabOfPanel(previousPanel);
    const nextTab = tabOfPanel(nextPanel);
    if (!previousTab || !nextTab || previousTab.closing || !previousPanel.isConnected || requested === 0) {
      finishSlide();
      return;
    }
    cancelEdgeEffects({ keepStrip: true });
    clearStretch();
    moveStrip(slotIndex(nextTab), { from: slotIndex(previousTab) });
    // The new slot may have been sliding as a non-selected panel; it is now
    // the selected one, so it no longer needs the visibility override.
    nextPanel.classList.replace("still-slide-out", "still-slide-in");
  }

  // ------------------------------------------------------ edge feedback
  // At the first or last slot the page stretches toward the edge you push
  // against and springs back (like Android's stretch overscroll). It uses the
  // separate `scale` property, so it combines with a strip glide that is
  // still settling, and it never scales below 1, so no gap ever shows.

  function stretchNow() {
    const stretch = state.stretch;
    if (!stretch) return { x: 0, v: 0 };
    const time = stretch.animation?.currentTime;
    const t = Math.max(0, (Number.isFinite(time) ? time : performance.now() - stretch.start) / 1000);
    if (stretch.hold) return { x: stretch.target, v: 0 };
    return t >= stretch.duration ? { x: stretch.target, v: 0 } : springAt(stretch, t, STRETCH.omega);
  }

  function clearStretch() {
    const stretch = state.stretch;
    if (!stretch) return;
    state.stretch = null;
    stretch.animation?.cancel();
    stretch.panel?.style.removeProperty("transform-origin");
  }

  // side: which edge is pushed. target: resting stretch (0, or a small hold).
  function stretchPanel(side, { kick = 0, target = 0 } = {}) {
    if (!animationsAllowed()) return;
    const panel = panelOf(gBrowser.selectedTab);
    if (!panel) return;
    const previous = state.stretch?.panel === panel && state.stretch.side === side ? stretchNow() : { x: 0, v: 0 };
    clearStretch();
    const seg = { x0: previous.x, v0: previous.v + kick, target };
    // Cap how far repeated notches can stretch.
    if (seg.v0 > 0) {
      const peak = seg.x0 + seg.v0 / (STRETCH.omega * Math.E);
      if (peak > STRETCH.max) seg.v0 *= (STRETCH.max - seg.x0) / Math.max(0.0001, peak - seg.x0);
    }
    seg.duration = springDuration(seg, STRETCH.omega);
    const steps = Math.max(24, Math.round(seg.duration * 90));
    const frames = [];
    for (let k = 0; k <= steps; k++) {
      const x = k === steps ? target : springAt(seg, (k / steps) * seg.duration, STRETCH.omega).x;
      frames.push({ scale: `${(1 + Math.max(0, x)).toFixed(4)} 1`, offset: k / steps });
    }
    // Pushing past the right edge pulls the page toward the left, and back.
    panel.style.transformOrigin = side === "right" ? "100% 50%" : "0% 50%";
    const animation = panel.animate(frames, { duration: seg.duration * 1000, easing: "linear", fill: target ? "forwards" : "none" });
    state.stretch = { ...seg, side, panel, animation, start: performance.now(), hold: false };
    const stretch = state.stretch;
    animation.finished.then(() => {
      if (state.stretch !== stretch) return;
      if (target) stretch.hold = true;
      else clearStretch();
    }, () => {});
  }

  function cancelEdgeEffects({ keepStrip = false } = {}) {
    clearTimeout(state.edgeTimer);
    clearTimeout(state.wallTimer);
    const wasLeaning = state.edgeArmedAt;
    state.edgeArmedAt = 0;
    document.documentElement.removeAttribute("still-edge");
    newSlotEdge.tabIndex = -1;
    if (wasLeaning) {
      if (keepStrip) clearStretch();
      else stretchPanel("right");
    }
  }

  // Notches in quick succession stretch a little further each time.
  function bumpWall(side) {
    clearTimeout(state.wallTimer);
    clearTimeout(state.edgeTimer);
    state.edgeArmedAt = 0;
    document.documentElement.removeAttribute("still-edge");
    stretchPanel(side, { kick: STRETCH.kick });
  }

  // Past the last slot with room for another: the page holds a gentle stretch
  // while a "+" is offered; one more notch opens the new slot, which slides in.
  function armNewSlotEdge() {
    const now = performance.now();
    if (state.edgeArmedAt) {
      if (now - state.edgeArmedAt >= 120) confirmNewSlotEdge();
      return;
    }
    clearTimeout(state.wallTimer);
    state.edgeArmedAt = now;
    newSlotEdge.tabIndex = 0;
    document.documentElement.setAttribute("still-edge", "new-slot");
    stretchPanel("right", { kick: STRETCH.kick * 0.7, target: STRETCH.hold });
    state.edgeTimer = setTimeout(() => cancelEdgeEffects(), NEW_SLOT_CONFIRM_MS);
  }

  function confirmNewSlotEdge() {
    cancelEdgeEffects({ keepStrip: true });
    openNewSlot({ direction: 1 });
  }

  newSlotEdge.addEventListener("click", confirmNewSlotEdge);

  // -------------------------------------------- vertical history slide
  // Back/forward and typed navigations: the old page (a snapshot) leaves
  // vertically and the live new page arrives once it has content.

  function finishVertical(immediate = false) {
    const vertical = state.vertical;
    if (!vertical) return;
    state.vertical = null;
    clearTimeout(vertical.timer);
    vertical.animations?.forEach((animation) => animation.cancel());
    if (immediate || !vertical.animations) {
      navStage.hidden = true;
      navStage.replaceChildren();
    }
  }

  async function captureBrowser(browser) {
    const rect = browser.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    // Only seen while it moves away, so a lighter capture is enough; it keeps
    // heavy pages (video) fast enough to capture in time.
    const scale = 0.6;
    const bitmap = await browser.drawSnapshot(0, 0, rect.width, rect.height, scale, "rgb(0,0,0)");
    if (!bitmap) return null;
    const canvas = h("canvas", { class: "still-nav-shot" });
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { canvas, rect };
  }

  async function prepareVertical(tab, direction) {
    if (!animationsAllowed() || tab !== gBrowser.selectedTab || state.slide) return false;
    finishVertical(true);
    const browser = tab.linkedBrowser;
    const navigationId = (state.verticalCounter = (state.verticalCounter || 0) + 1);
    const locationBefore = tabUrl(tab);
    let shot = null;
    try {
      shot = await Promise.race([
        captureBrowser(browser),
        new Promise((resolve) => setTimeout(() => resolve(null), 140))
      ]);
    } catch {}
    if (!shot || state.verticalCounter !== navigationId || tab !== gBrowser.selectedTab) return false;
    const { canvas, rect } = shot;
    Object.assign(navStage.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    navStage.replaceChildren(canvas);
    navStage.hidden = false;
    const timer = setTimeout(() => {
      // No new page arrived (download, blocked load): just remove the cover.
      if (tabUrl(tab) === locationBefore) finishVertical(true);
      else runVertical(browser);
    }, 1600);
    state.vertical = { tab, browser, direction, canvas, locationBefore, timer };
    return true;
  }

  function runVertical(browser) {
    const vertical = state.vertical;
    if (!vertical || vertical.browser !== browser || vertical.animations) return;
    clearTimeout(vertical.timer);
    if (vertical.tab !== gBrowser.selectedTab) { finishVertical(true); return; }
    const travel = vertical.direction === "back" ? -1 : 1;
    const spring = springEasing();
    const timing = { duration: spring.duration, easing: spring.easing, fill: "both" };
    const panel = panelOf(vertical.tab);
    vertical.animations = [
      vertical.canvas.animate([{ transform: "translate3d(0, 0, 0)" }, { transform: `translate3d(0, ${travel * 100}%, 0)` }], timing),
      panel.animate([{ transform: `translate3d(0, ${-travel * 100}%, 0)` }, { transform: "translate3d(0, 0, 0)" }], timing)
    ];
    Promise.all(vertical.animations.map((animation) => animation.finished)).then(() => {
      if (state.vertical === vertical) finishVertical(true);
    }, () => {});
  }

  async function navigateWithSlide(tab, url) {
    if (tab === gBrowser.selectedTab && !isHomeUrl(url)) await prepareVertical(tab, "forward");
    loadInTab(tab, url);
    gBrowser.selectedBrowser.focus();
  }

  // The site a history entry belongs to (example.com for www.example.com).
  function siteOf(uri) {
    if (!uri) return "";
    try { return Services.eTLD.getBaseDomain(uri); } catch {}
    try { return uri.host || uri.scheme; } catch {}
    return uri.spec || "";
  }

  // Back/forward to another site slides vertically. Within one site (often
  // the same page, as on YouTube) it is instant: there is no new page load
  // to slide to.
  function historyChangesSite(browser, name) {
    try {
      const history = browser.browsingContext?.sessionHistory;
      const entry = history?.getEntryAtIndex(history.index + (name === "back" ? -1 : 1));
      return !entry || siteOf(entry.URI) !== siteOf(browser.currentURI);
    } catch {
      return true;
    }
  }

  for (const name of ["back", "forward"]) {
    const original = BrowserCommands[name].bind(BrowserCommands);
    BrowserCommands[name] = async function stillHistoryCommand(event) {
      const browser = gBrowser.selectedBrowser;
      const possible = name === "back" ? browser.canGoBack : browser.canGoForward;
      const where = event ? BrowserUtils.whereToOpenLink(event, false, true) : "current";
      if (possible && where === "current" && !state.historyPending && historyChangesSite(browser, name)) {
        state.historyPending = true;
        try { await prepareVertical(gBrowser.selectedTab, name); } finally { state.historyPending = false; }
      }
      return original(event);
    };
  }

  // ---------------------------------------------------------- tab dock

  function buildDock() {
    const tabs = slotTabs();
    const active = Math.max(0, tabs.indexOf(gBrowser.selectedTab));
    dockIcons.replaceChildren();
    for (let index = 0; index < SLOT_COUNT; index++) {
      const tab = tabs[index];
      const item = h("button", { type: "button", class: `tab-dock-item${tab ? "" : " empty"}`,
        title: tab ? slotTitle(tab) : "Empty slot", "aria-label": tab ? `Slot ${index + 1}: ${slotTitle(tab)}` : `Open slot ${index + 1}` });
      const distance = Math.abs(index - active);
      item.style.setProperty("--tab-dock-delay", `${distance === 0 ? 0 : 28 + (distance - 1) * (28 + distance * 3)}ms`);
      item.style.setProperty("--tab-dock-scale-duration", `${128 + distance * 72}ms`);
      item.style.setProperty("--tab-dock-opacity-duration", `${58 + distance * 48}ms`);
      item.style.setProperty("--tab-dock-blur-duration", `${112 + distance * 66}ms`);
      const visual = h("span", { class: "tab-dock-visual" });
      visual.append(tab ? faviconFor(tab, "slot-favicon tab-dock-favicon") : h("span", { class: "tab-dock-empty-icon", text: "+" }));
      item.append(visual);
      item.addEventListener("click", () => {
        state.dock.direction = Math.sign(index - active);
        commitDock(index);
        hideDock();
      });
      dockIcons.append(item);
    }
    magnifyDock(state.dock.selected);
  }

  function magnifyDock(center, pointerX = null) {
    const items = [...dockIcons.children];
    let nearest = center;
    let nearestDistance = Infinity;
    items.forEach((item, index) => {
      const bounds = item.getBoundingClientRect();
      const mid = bounds.left + bounds.width / 2;
      const distance = pointerX === null ? Math.abs(index - center) * 82 : Math.abs(pointerX - mid);
      if (distance < nearestDistance) { nearestDistance = distance; nearest = index; }
      const influence = Math.exp(-0.5 * Math.pow(distance / 58, 2.15));
      const visual = item.firstElementChild;
      visual.style.setProperty("--tab-dock-scale", String(1 + 0.68 * influence));
      visual.style.setProperty("--tab-dock-shadow-opacity", String(0.72 * influence));
      visual.style.setProperty("--tab-dock-shadow-y", `${3 + 8 * influence}px`);
      visual.style.setProperty("--tab-dock-shadow-blur", `${16 + 10 * influence}px`);
      item.style.zIndex = String(Math.round(influence * 1000));
    });
    if (pointerX !== null) {
      state.dock.selected = nearest;
      state.dock.hover = nearest;
      state.dock.direction = Math.sign(nearest - slotIndex(gBrowser.selectedTab));
    }
    items.forEach((item, index) => item.classList.toggle("selected", index === state.dock.selected));
  }

  function scheduleDockHide(delay) {
    clearTimeout(state.dock.timer);
    state.dock.timer = setTimeout(hideDock, delay);
  }

  function showDock() {
    slotTabs().forEach(warmTab);
    clearTimeout(state.dock.timer);
    if (state.dock.visible) { scheduleDockHide(4000); return; }
    state.dock.visible = true;
    state.dock.hover = -1;
    state.dock.direction = 0;
    state.dock.selected = Math.max(0, slotIndex(gBrowser.selectedTab));
    buildDock();
    dock.hidden = false;
    dock.classList.remove("closing");
    window.requestAnimationFrame(() => dock.classList.add("visible"));
    scheduleDockHide(4000);
  }

  function hideDock(immediate = false) {
    clearTimeout(state.dock.timer);
    if (!state.dock.visible && dock.hidden) return;
    state.dock.visible = false;
    state.dock.hover = -1;
    dock.classList.add("closing");
    dock.classList.remove("visible");
    if (immediate) { dock.classList.remove("closing"); dock.hidden = true; return; }
    setTimeout(() => { if (!state.dock.visible) dock.hidden = true; }, 120);
  }

  function dockSlideEnabled() {
    return Services.prefs.getBoolPref(PREF_DOCK_SLIDE, true);
  }

  function commitDock(index) {
    const tabs = slotTabs();
    const active = slotIndex(gBrowser.selectedTab);
    const slide = dockSlideEnabled();
    const direction = slide ? (state.dock.direction || Math.sign(index - active)) : 0;
    if (tabs[index]) {
      if (index !== active) activate(tabs[index], direction);
      return;
    }
    openNewSlot({ direction: slide ? (direction || 1) : 0 });
  }

  function releaseDock() {
    if (!state.dock.visible) return;
    commitDock(state.dock.hover >= 0 ? state.dock.hover : state.dock.selected);
    hideDock();
  }

  function moveDock(direction) {
    if (!direction) return;
    if (!state.dock.visible) showDock();
    const step = Math.sign(direction);
    state.dock.hover = -1;
    state.dock.direction = step;
    state.dock.selected = (state.dock.selected + step + SLOT_COUNT) % SLOT_COUNT;
    magnifyDock(state.dock.selected);
    scheduleDockHide(4000);
  }

  dock.addEventListener("pointermove", (event) => {
    if (!state.dock.visible) return;
    clearTimeout(state.dock.timer);
    magnifyDock(state.dock.selected, event.clientX);
  });
  dock.addEventListener("pointerleave", () => scheduleDockHide(900));

  // ------------------------------------------------------- utility panel

  function currentBookmarkable() {
    return /^https?:/i.test(tabUrl(gBrowser.selectedTab));
  }

  async function isBookmarked(url) {
    if (!/^https?:/i.test(url)) return false;
    let found = false;
    await PlacesUtils.bookmarks.fetch({ url }, () => { found = true; });
    return found;
  }

  function renderUtilityButton({ animate = false, direction = 1 } = {}) {
    const meta = utilityMeta[state.utilityMode];
    const slide = dockSlideEnabled();
    const label = state.utilityMode === "tabdock" ? `${meta.label}: ${slide ? "on" : "off"}` : meta.label;
    utilityButton.title = `${label}\nScroll to change this button`;
    utilityButton.setAttribute("aria-label", `${label}. Scroll to change this button.`);
    utilityButton.classList.toggle("dock-slide-enabled", state.utilityMode === "tabdock" && slide);
    if (state.utilityMode === "bookmarks") {
      const url = tabUrl(gBrowser.selectedTab);
      isBookmarked(url).then((marked) => {
        if (tabUrl(gBrowser.selectedTab) === url) utilityButton.classList.toggle("bookmarked", marked);
      }, () => {});
    } else {
      utilityButton.classList.remove("bookmarked");
    }
    const key = state.utilityMode;
    if (!animate && utilityStage.dataset.mode === key) return;
    utilityStage.dataset.mode = key;
    const incoming = h("span", { class: "utility-glyph" }, icon(meta.paths, meta.className || ""));
    const outgoing = utilityStage.lastElementChild;
    if (!animate || !outgoing || !animationsAllowed()) {
      utilityStage.replaceChildren(incoming);
      return;
    }
    const token = ++state.utilityToken;
    utilityStage.append(incoming);
    const travel = direction > 0 ? -24 : 24;
    outgoing.animate([
      { transform: "translateY(0) scale(1)", filter: "blur(0)", opacity: 1 },
      { transform: `translateY(${travel}px) scale(.82)`, filter: "blur(5px)", opacity: 0 }
    ], { duration: 205, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
    incoming.animate([
      { transform: `translateY(${-travel}px) scale(.82)`, filter: "blur(6px)", opacity: 0 },
      { transform: "translateY(0) scale(1)", filter: "blur(0)", opacity: 1 }
    ], { duration: 285, easing: EASE });
    setTimeout(() => { if (token === state.utilityToken) utilityStage.replaceChildren(incoming); }, 290);
  }

  function hideUtilityPanel() {
    if (utilityPanel.hidden) return;
    utilityPanel.hidden = true;
    utilityPanel.replaceChildren();
    utilityButton.classList.remove("panel-open");
    state.downloadView?.stop();
    state.downloadView = null;
  }

  function listItem(title, detail, { action = false, active = false, onClick } = {}) {
    const button = h("button", { type: "button", class: `utility-list-item${action ? " action" : ""}${active ? " active" : ""}` },
      h("span", { text: title }), detail ? h("small", { text: detail }) : null);
    if (onClick) button.addEventListener("click", onClick);
    return button;
  }

  function emptyNote(text) {
    return h("div", { class: "utility-panel-empty", text });
  }

  function openPanel(mode) {
    utilityPanel.dataset.mode = mode;
    utilityPanel.replaceChildren(h("div", { class: "utility-panel-heading", text: utilityMeta[mode].label }));
    utilityPanel.hidden = false;
    utilityButton.classList.add("panel-open");
    showChrome();
  }

  function openUrlFromPanel(url) {
    hideUtilityPanel();
    navigateWithSlide(gBrowser.selectedTab, url);
    scheduleChromeHide();
  }

  async function renderBookmarks() {
    openPanel("bookmarks");
    const url = tabUrl(gBrowser.selectedTab);
    const marked = await isBookmarked(url);
    const action = listItem(marked ? "Remove bookmark" : "Bookmark this page", "", {
      action: true, active: marked,
      onClick: async () => {
        if (marked) await PlacesUtils.bookmarks.remove(await bookmarkGuids(url));
        else await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid, url, title: slotTitle(gBrowser.selectedTab) });
        renderUtilityButton();
        renderBookmarks();
      }
    });
    action.disabled = !currentBookmarkable();
    const recent = await PlacesUtils.bookmarks.getRecent(12);
    if (utilityPanel.dataset.mode !== "bookmarks" || utilityPanel.hidden) return;
    utilityPanel.append(action);
    const rows = recent.filter((item) => item.url).map((item) =>
      listItem(item.title || displayUrl(item.url.href), item.url.href, { onClick: () => openUrlFromPanel(item.url.href) }));
    utilityPanel.append(...(rows.length ? rows : [emptyNote("No bookmarks yet.")]));
  }

  async function bookmarkGuids(url) {
    const guids = [];
    await PlacesUtils.bookmarks.fetch({ url }, (bookmark) => guids.push(bookmark.guid));
    return guids.map((guid) => ({ guid }));
  }

  async function renderHistory() {
    openPanel("history");
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT url, title FROM moz_places WHERE hidden = 0 AND last_visit_date NOT NULL
         AND substr(url, 1, 4) = 'http'
       ORDER BY last_visit_date DESC LIMIT 14`);
    if (utilityPanel.dataset.mode !== "history" || utilityPanel.hidden) return;
    const items = rows.map((row) => {
      const url = row.getResultByName("url");
      return listItem(row.getResultByName("title") || displayUrl(url), url, { onClick: () => openUrlFromPanel(url) });
    });
    utilityPanel.append(...(items.length ? items : [emptyNote("No history yet.")]));
  }

  function downloadRow(download) {
    const name = PathUtils.filename(download.target.path || "") || "Download";
    const row = h("div", { class: "download-item" });
    const meta = h("div", { class: "download-meta" });
    const bar = h("div", { class: "download-progress" }, h("div"));
    const actions = h("div", { class: "download-actions" });
    row.append(h("div", { class: "download-title", title: name, text: name }), meta, bar, actions);
    const update = () => {
      let text;
      if (download.succeeded) text = `Done · ${lazy.DownloadUtils.getTransferTotal(download.target.size || download.currentBytes)}`;
      else if (download.canceled) text = "Canceled";
      else if (download.error) text = "Failed. Retry or open the page again.";
      else if (download.hasProgress) text = `${download.progress}% · ${lazy.DownloadUtils.getTransferTotal(download.currentBytes, download.totalBytes)}`;
      else text = `${lazy.DownloadUtils.getTransferTotal(download.currentBytes)} downloaded`;
      meta.textContent = text;
      const running = !download.stopped;
      bar.hidden = !running;
      bar.classList.toggle("indeterminate", running && !download.hasProgress);
      bar.firstChild.style.width = download.hasProgress ? `${download.progress}%` : "";
      const buttons = [];
      if (download.succeeded) {
        buttons.push(h("button", { type: "button", text: "Open", onclick: () => download.launch().catch(() => showToast("Could not open this file.")) }));
        buttons.push(h("button", { type: "button", text: "Show in folder", onclick: () => download.showContainingDirectory().catch(() => {}) }));
      } else if (running) {
        buttons.push(h("button", { type: "button", text: "Cancel", onclick: () => download.cancel() }));
      } else if (download.error || download.canceled) {
        buttons.push(h("button", { type: "button", text: "Retry", onclick: () => download.start().catch(() => {}) }));
      }
      actions.replaceChildren(...buttons);
    };
    update();
    row.stillUpdate = update;
    return row;
  }

  async function renderDownloads() {
    openPanel("downloads");
    const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    if (utilityPanel.dataset.mode !== "downloads" || utilityPanel.hidden) return;
    const rows = new Map();
    const container = h("div", { class: "download-list" });
    const empty = emptyNote("No downloads yet.");
    const folder = listItem("Open downloads folder", "", {
      action: true,
      onClick: async () => {
        try {
          const dir = await lazy.Downloads.getPreferredDownloadsDirectory();
          new FileUtils.File(dir).reveal();
        } catch { showToast("Could not open the downloads folder."); }
      }
    });
    utilityPanel.append(folder, container);
    const refreshEmpty = () => { if (!rows.size) container.replaceChildren(empty); else empty.remove(); };
    const view = {
      onDownloadAdded(download) {
        const row = downloadRow(download);
        rows.set(download, row);
        empty.remove();
        container.prepend(row);
      },
      onDownloadChanged(download) { rows.get(download)?.stillUpdate(); },
      onDownloadRemoved(download) { rows.get(download)?.remove(); rows.delete(download); refreshEmpty(); }
    };
    await list.addView(view);
    refreshEmpty();
    state.downloadView = { stop: () => list.removeView(view) };
  }

  function permissionLabel(id) {
    const labels = { camera: "Camera", microphone: "Microphone", geo: "Location", "desktop-notification": "Notifications",
      screen: "Screen sharing", "persistent-storage": "Storage", popup: "Pop-ups", "autoplay-media": "Autoplay",
      xr: "Virtual reality", midi: "MIDI", "midi-sysex": "MIDI", "open-protocol-handler": "App links", install: "Add-ons" };
    return labels[id] || SitePermissions.getPermissionLabel?.(id) || id;
  }

  function permissionState(value) {
    if (value === SitePermissions.ALLOW) return "Allowed";
    if (value === SitePermissions.BLOCK || value === SitePermissions.AUTOPLAY_BLOCKED_ALL) return "Blocked";
    if (value === SitePermissions.PROMPT) return "Ask every time";
    return "Custom";
  }

  function renderPermissions() {
    openPanel("permissions");
    const browser = gBrowser.selectedBrowser;
    const principal = browser.contentPrincipal;
    if (!principal || !/^https?:/i.test(principal.URI?.spec || "")) {
      utilityPanel.append(emptyNote("Open a website to see its permissions."));
      return;
    }
    utilityPanel.append(h("div", { class: "permission-site-origin", title: principal.origin, text: principal.host || principal.origin }));
    const entries = SitePermissions.getAllForBrowser(browser).filter((entry) => entry.id && entry.state !== SitePermissions.UNKNOWN);
    if (!entries.length) {
      utilityPanel.append(emptyNote("This site has no saved permissions. Firefox asks when a site wants something."));
      return;
    }
    for (const entry of entries) {
      const reset = h("button", { type: "button", text: "Reset", title: `Reset ${permissionLabel(entry.id)}` });
      reset.addEventListener("click", () => {
        SitePermissions.removeFromPrincipal(principal, entry.id, browser);
        renderPermissions();
      });
      utilityPanel.append(h("div", { class: "permission-setting" },
        h("div", { class: "permission-setting-copy" },
          h("strong", { text: permissionLabel(entry.id) }),
          h("small", { text: permissionState(entry.state) })),
        reset));
    }
  }

  // ------------------------------------------------------ sign-in import

  function reloadSignedInPages() {
    for (const tab of slotTabs()) if (/^https?:/i.test(tabUrl(tab))) tab.linkedBrowser.reload();
  }

  async function runImport(source, { quiet = false } = {}) {
    const label = source === "opera" ? "Opera GX" : "Still (Electron)";
    try {
      const report = await lazy.StillImport.importCookies(window, source);
      if (report.imported) {
        showToast(`Brought over ${report.imported} sign-in cookies from ${label}.`, 7000,
          { label: "Reload pages", run: reloadSignedInPages });
      } else if (!quiet) {
        showToast(report.failed
          ? `${label}'s sign-ins could not be read (${report.failed} are locked to ${label} itself).`
          : `Nothing new to bring over from ${label}.`, 5000);
      }
      return report;
    } catch (error) {
      console.error("Still sign-in import failed", error);
      if (!quiet) showToast(error.message, 6000);
      return null;
    }
  }

  async function runHistoryImport({ quiet = false } = {}) {
    try {
      const report = await lazy.StillImport.importHistory(window, "opera");
      if (report.pages) showToast(`Brought over ${report.pages.toLocaleString()} pages of history and ${report.icons.toLocaleString()} site icons from Opera GX.`, 6000);
      else if (!quiet) showToast("Nothing new to bring over from Opera GX.", 4000);
    } catch (error) {
      console.error("Still history import failed", error);
      if (!quiet) showToast(error.message, 6000);
    }
  }

  // First start: quietly bring over sign-ins (Electron build) and history
  // (Opera GX) once each, so suggestions know your sites from day one.
  async function firstRunImport() {
    if (!Services.prefs.getBoolPref("still.import.electron.done", false)) {
      Services.prefs.setBoolPref("still.import.electron.done", true);
      await runImport("electron", { quiet: true });
    }
    if (!Services.prefs.getBoolPref("still.import.history.done", false)) {
      Services.prefs.setBoolPref("still.import.history.done", true);
      await runHistoryImport({ quiet: true });
    }
  }

  function renderBrowserSetup() {
    openPanel("browser");
    utilityPanel.append(
      listItem("Import sign-ins from Opera GX", "Keeps you logged in to YouTube, Google, and others. Close Opera GX first.", {
        action: true, onClick: () => { hideUtilityPanel(); runImport("opera"); }
      }),
      listItem("Import history from Opera GX", "Pages and site icons, so suggestions know your sites", {
        onClick: () => { hideUtilityPanel(); runHistoryImport(); }
      }),
      listItem("Import sign-ins from Still (Electron)", "Your sessions from the previous Still build", {
        onClick: () => { hideUtilityPanel(); runImport("electron"); }
      }),
      listItem("Import bookmarks, history, and passwords", "From Opera GX, Chrome, Edge, or a file", {
        onClick: () => {
          hideUtilityPanel();
          try { lazy.MigrationUtils.showMigrationWizard(window, {}); } catch { showToast("Could not open the import window."); }
        }
      }));
  }

  // OLED is dark mode with pure black surfaces (bar, panels, start page).
  const themes = ["system", "light", "dark", "oled"];
  const themeNames = { system: "follow system", light: "light", dark: "dark", oled: "OLED (pure black)" };
  const OLED_SHEET = Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(`
    @-moz-document regexp("moz-extension://[^/]+/(newtab|manage)\\.html.*") {
      :root {
        --background: #000 !important;
        --field: #0b0b0b !important;
        --hover: rgba(255, 255, 255, .07) !important;
        --border: rgba(255, 255, 255, .12) !important;
        --edge-light: inset 0 1px 0 rgba(255, 255, 255, .06) !important;
      }
      html, body { background-color: #000 !important; }
    }`));
  function applyTheme(theme) {
    if (!themes.includes(theme)) theme = "system";
    if (theme === "system") {
      Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
      Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", 2);
    } else {
      const dark = theme === "dark" || theme === "oled";
      Services.prefs.setIntPref("ui.systemUsesDarkTheme", dark ? 1 : 0);
      Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", dark ? 0 : 1);
    }
    document.documentElement.setAttribute("still-theme", theme);
    const sheets = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    const registered = sheets.sheetRegistered(OLED_SHEET, sheets.USER_SHEET);
    if (theme === "oled" && !registered) sheets.loadAndRegisterSheet(OLED_SHEET, sheets.USER_SHEET);
    else if (theme !== "oled" && registered) sheets.unregisterSheet(OLED_SHEET, sheets.USER_SHEET);
  }

  function runUtility(event) {
    const mode = state.utilityMode;
    if (!utilityPanel.hidden && utilityPanel.dataset.mode === mode) { hideUtilityPanel(); return; }
    hideUtilityPanel();
    const failed = (what) => (error) => {
      console.error(error);
      if (!utilityPanel.hidden) utilityPanel.append(emptyNote(`Could not load ${what}. Close this panel and try again.`));
    };
    if (mode === "chat") { window.StillChat?.toggle(); scheduleChromeHide(400); }
    else if (mode === "settings") { if (settingsPage.hidden) showSettings({ keyboard: event?.detail === 0 }); else hideSettings(); }
    else if (mode === "agents") { if (agentPanel.hidden) showAgentPanel({ keyboard: event?.detail === 0 }); else hideAgentPanel(); }
    else if (mode === "bookmarks") renderBookmarks().catch(failed("bookmarks"));
    else if (mode === "history") renderHistory().catch(failed("history"));
    else if (mode === "downloads") renderDownloads().catch(failed("downloads"));
    else if (mode === "permissions") renderPermissions();
    else if (mode === "browser") renderBrowserSetup();
    else if (mode === "theme") {
      const current = Services.prefs.getStringPref(PREF_THEME, "system");
      const next = themes[(themes.indexOf(current) + 1) % themes.length];
      Services.prefs.setStringPref(PREF_THEME, next);
      applyTheme(next);
      showToast(`Appearance: ${themeNames[next]}`);
    } else if (mode === "tabdock") {
      const next = !dockSlideEnabled();
      Services.prefs.setBoolPref(PREF_DOCK_SLIDE, next);
      renderUtilityButton();
      showToast(`Dock slide ${next ? "on" : "off"}`);
    }
  }

  utilityButton.addEventListener("click", runUtility);
  utilityButton.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - state.lastUtilityWheel < 95 || !event.deltaY) return;
    state.lastUtilityWheel = now;
    hideUtilityPanel();
    hideAgentPanel();
    hideSettings();
    const direction = event.deltaY > 0 ? 1 : -1;
    const modes = activeUtilityModes();
    const current = Math.max(0, modes.indexOf(state.utilityMode));
    state.utilityMode = modes[(current + direction + modes.length) % modes.length];
    Services.prefs.setStringPref(PREF_UTILITY, state.utilityMode);
    renderUtilityButton({ animate: true, direction });
  }, { passive: false });

  // ------------------------------------------------------------- toasts

  function hideToast() {
    clearTimeout(state.toastTimer);
    toast.classList.remove("show", "has-action");
    toastAction.hidden = true;
    toastAction.onclick = null;
  }

  function showToast(message, duration = 3200, action = null) {
    clearTimeout(state.toastTimer);
    toastMessage.textContent = message;
    toastAction.hidden = !action;
    toast.classList.toggle("has-action", Boolean(action));
    if (action) {
      toastAction.textContent = action.label;
      toastAction.onclick = () => { hideToast(); action.run(); };
    }
    toast.classList.add("show");
    state.toastTimer = setTimeout(hideToast, duration);
  }

  // --------------------------------------------------------------- agents
  // AI agents connect through `still mcp` or `still agent` (StillAgent.sys.mjs).
  // Tabs they open are hidden agent tabs: outside the five slots, shown as
  // live pictures in the agent gallery (the agent button), and moved
  // into a slot when you (or the agent) show one, or when you drag one
  // into the row.
  //
  // What the agent does is visible where it happens:
  // - On the page in front of you, the agent has its own pointer. It glides
  //   to the element it is about to use, rings it, says what it is doing
  //   ("Clicking “Sign in”"), and ripples on a click. Steps without an
  //   element (reading, opening a page) are narrated in a small line at the
  //   bottom left. A thin light runs along the top edge meanwhile.
  // - In a slot behind the current one, that slot is outlined and its icon
  //   carries a small pulsing light.
  // - In a hidden agent tab, a small live view shows it, and the gallery
  //   shows the agent's pointer on that tab's picture.

  const AGENT_KEY = "still-agent";
  const AGENT_WORKING_MS = 2500;   // a step counts as current this long
  const AGENT_POINTER_REST_MS = 2600;
  const AGENT_LOG_MAX = 40;
  state.agentOpening = 0;
  const agentState = { clients: [], engine: false, activity: null, idleTimer: 0, log: [], nextStep: 1, pointerTimer: 0, narrateTimer: 0, clockTimer: 0 };
  const agentPanel = h("section", { id: "still-agent-gallery", hidden: true, role: "dialog", "aria-label": "Agent tabs", tabindex: "-1" });
  const agentLive = h("span", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const agentEdge = h("div", { id: "still-agent-edge", "aria-hidden": "true" });
  const starPath = "M12 4.2c.55 3.9 2.6 6 6.6 6.6-4 .6-6.05 2.7-6.6 6.6-.55-3.9-2.6-6-6.6-6.6 4-.6 6.05-2.7 6.6-6.6Z";

  // The agent's pointer: an arrow in the agent's light, distinct from yours,
  // with the step it is taking beside it.
  const agentPointerVerb = h("span", { class: "agent-pointer-verb" });
  const agentPointerTarget = h("span", { class: "agent-pointer-target" });
  const agentPointer = h("div", { id: "still-agent-pointer", "aria-hidden": "true" },
    icon([["path", { class: "agent-pointer-arrow", d: "M4.6 3.4 19.2 11l-6.5 1.7-3.1 6.2Z" }]], "agent-pointer-icon"),
    h("span", { class: "agent-pointer-label" }, agentPointerVerb, agentPointerTarget));
  const agentFocus = h("div", { id: "still-agent-focus", "aria-hidden": "true" });
  const agentNarrationText = h("span", { class: "agent-narration-text" });
  const agentNarration = h("div", { id: "still-agent-narration", "aria-hidden": "true" },
    icon([["path", { class: "agent-star", d: starPath }]], "agent-narration-star"), agentNarrationText);
  chrome.before(agentPanel);
  layer.append(agentFocus, agentPointer, agentNarration, agentEdge, agentLive);

  function agentNames() {
    const names = [...new Set(agentState.clients)];
    return names.length ? new Intl.ListFormat("en", { type: "conjunction" }).format(names) : "An agent";
  }

  function agentTabs() {
    return gBrowser.tabs.filter((tab) => tab.stillAgent && tab.hidden && !tab.closing);
  }

  function tabByBrowserId(id) {
    return gBrowser.tabs.find((candidate) => candidate.linkedBrowser?.browserId === id) || null;
  }

  // The person can see this tab's page right now.
  function agentOnScreen(tab) {
    return Boolean(tab && tab.ownerDocument === document && tab === gBrowser.selectedTab && !tab.hidden
      && !document.hidden && window.windowState !== window.STATE_MINIMIZED);
  }

  function agentWorkingTab() {
    const activity = agentState.activity;
    return activity && Date.now() - activity.at < AGENT_WORKING_MS ? tabByBrowserId(activity.tab) : null;
  }

  function adoptAgentTab(tab) {
    tab.stillAgent = true;
    tab.stillAgentUsed = Date.now();
    try { SessionStore.setCustomTabValue(tab, AGENT_KEY, "1"); } catch {}
    // Hidden once Firefox has finished adding it.
    Promise.resolve().then(() => {
      if (!tab.closing && !tab.selected) gBrowser.hideTab(tab);
      renderAgentChips();
      if (!agentPanel.hidden) renderAgentPanel();
    });
  }

  function openAgentTab(url, { visible = false, owner = 0 } = {}) {
    state.agentOpening++;
    let tab;
    try {
      tab = gBrowser.addTrustedTab(url || "about:blank", { inBackground: true });
    } finally {
      state.agentOpening--;
    }
    if (tab) tab.stillAgentOwner = owner;
    if (visible) Promise.resolve().then(() => showAgentTab(tab));
    return tab;
  }

  // Bring a tab forward: an agent tab joins the slots (the slot picker asks
  // which slot it replaces when all five are taken).
  function showAgentTab(tab) {
    if (!tab || tab.closing) return;
    const owner = tab.ownerDocument.defaultView;
    if (owner !== window) { owner.gBrowser.selectedTab = tab; owner.focus(); return; }
    if (!tab.hidden) { activate(tab); return; }
    tab.stillAgent = false;
    try { SessionStore.deleteCustomTabValue(tab, AGENT_KEY); } catch {}
    gBrowser.showTab(tab);
    renderAgentChips();
    const tabs = slotTabs();
    if (tabs.length <= Math.max(1, slotCapacity())) { activate(tab); return; }
    const home = tabs.find((candidate) => candidate !== tab && isHomeTab(candidate));
    if (home) {
      gBrowser.moveTabTo(tab, { tabIndex: tabPos(home), forceUngrouped: true });
      gBrowser.selectedTab = tab;
      gBrowser.removeTab(home, { animate: false });
      return;
    }
    showOverflow(tab);
  }

  // "Clicking", "Sign in" -> Clicking “Sign in”
  function stepText(step) {
    return step.target ? `${step.label} “${step.target}”` : step.label;
  }

  // Where a step happened, for the panel.
  function stepPlace(step) {
    const tab = tabByBrowserId(step.tab);
    if (!tab) return step.title ? `Closed tab · ${step.title}` : "Closed tab";
    const title = slotTitle(tab);
    if (tab.hidden && tab.stillAgent) return `Agent tab · ${title}`;
    const index = slotIndex(tab);
    return index >= 0 ? `Slot ${index + 1} · ${title}` : title;
  }

  function agentStatusText() {
    const activity = agentState.activity;
    if (activity && Date.now() - activity.at < AGENT_WORKING_MS) {
      const tab = tabByBrowserId(activity.tab);
      return tab ? `${stepText(activity)} in ${slotTitle(tab)}` : stepText(activity);
    }
    return "Waiting for its next step";
  }

  function ago(at) {
    const seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 5) return "now";
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  }

  // Repeats of the same step on the same page (reading it again, typing
  // into the same field) update one entry instead of adding more.
  function logStep(activity) {
    const last = agentState.log[0];
    const tab = tabByBrowserId(activity.tab);
    if (last && last.tab === activity.tab && last.label === activity.label && last.target === activity.target
        && activity.at - last.at < 6000) {
      last.at = activity.at;
      last.repeat = (last.repeat || 1) + 1;
      return last;
    }
    const step = { id: agentState.nextStep++, tab: activity.tab, label: activity.label, target: activity.target || "",
      title: tab ? slotTitle(tab) : "", at: activity.at };
    agentState.log.unshift(step);
    agentState.log.length = Math.min(agentState.log.length, AGENT_LOG_MAX);
    return step;
  }

  // ------------------------------------------------------- agent gallery
  // The agent button opens a page of its own over the current one: every
  // hidden agent tab as a live picture in a grid, each with the agent's
  // pointer where it last acted and the step it is taking. Click a picture
  // to bring that tab into your slots, or drag it onto the bar.
  //
  // Agent tabs do not pile up: a tab no agent has used for 15 minutes
  // closes, and so do the tabs of an agent that disconnects (after a
  // minute, in case it was only reconnecting).

  const GALLERY_STILL_MS = 2400;          // how often a quiet tab's picture refreshes
  const GALLERY_POINTER_MS = 8000;        // an agent's pointer stays this long after its step
  const AGENT_TAB_IDLE_MS = 15 * 60 * 1000;
  const OWNER_GRACE_MS = 60 * 1000;
  const tiles = new Map();                // tab -> tile
  const gallery = { timer: 0, clock: 0, cursor: 0, opener: null };
  const galleryTitle = h("h2", { class: "agent-gallery-title" });
  const galleryStatus = h("p", { class: "agent-gallery-status" },
    h("span", { class: "agent-status-light", "aria-hidden": "true" }), h("span", { class: "agent-gallery-status-text" }));
  const galleryGrid = h("div", { class: "agent-gallery-grid", role: "list", "aria-label": "Agent tabs" });
  const galleryEmpty = h("p", { class: "agent-gallery-empty", text: "No agent tabs right now. Pages an agent opens show up here, outside your five slots." });
  const galleryCloseAll = h("button", { type: "button", class: "agent-gallery-action", text: "Close all tabs" });
  const galleryStop = h("button", { type: "button", class: "agent-gallery-action danger", text: "Stop agent access" });
  const galleryClose = h("button", { type: "button", class: "agent-gallery-close", title: "Close (Esc)", "aria-label": "Close agent tabs" }, closeGlyph());
  const galleryLiveSwitch = h("button", { type: "button", class: "agent-gallery-switch", role: "switch", title: "Show a small live picture when the agent works in a tab you are not looking at" },
    h("span", { class: "agent-switch", "aria-hidden": "true" }, h("span", { class: "agent-switch-knob" })),
    h("span", { text: "Live view" }));
  agentPanel.append(h("div", { class: "agent-gallery-scroll" },
    h("header", { class: "agent-gallery-head" },
      h("div", { class: "agent-gallery-heading" }, galleryTitle, galleryStatus),
      h("div", { class: "agent-gallery-actions" }, galleryLiveSwitch, galleryCloseAll, galleryStop, galleryClose)),
    galleryGrid, galleryEmpty));

  // Tabs the agent touched get a fresh "last used" time, and remember who.
  function markAgentUse(activity) {
    const tab = tabByBrowserId(activity.tab);
    if (!tab) return;
    tab.stillAgentUsed = Date.now();
    tab.stillAgentStep = { label: activity.label, target: activity.target || "", box: activity.box || null, client: activity.client || "", at: Date.now() };
  }

  function closeAgentTabs(tabs) {
    for (const tab of tabs) if (!tab.closing) gBrowser.removeTab(tab, { animate: false });
  }

  // Every minute: hidden agent tabs nobody has used for a while close.
  state.agentSweep = setInterval(() => {
    const now = Date.now();
    closeAgentTabs(agentTabs().filter((tab) => now - (tab.stillAgentUsed || now) > AGENT_TAB_IDLE_MS));
  }, 60 * 1000);
  window.addEventListener("unload", () => clearInterval(state.agentSweep));

  // An agent disconnected: once the grace minute passes, the hidden tabs it
  // opened and has not used since close.
  function agentOwnerLeft(owner) {
    if (!owner) return;
    const left = Date.now();
    setTimeout(() => {
      closeAgentTabs(agentTabs().filter((tab) => tab.stillAgentOwner === owner && (tab.stillAgentUsed || 0) <= left));
    }, OWNER_GRACE_MS);
  }

  function tileFor(tab) {
    let tile = tiles.get(tab);
    if (tile) return tile;
    const canvas = h("canvas", { class: "agent-tile-canvas" });
    const ring = h("div", { class: "agent-tile-ring" });
    const who = h("span", { class: "agent-tile-who" });
    const pointer = h("div", { class: "agent-tile-pointer" },
      icon([["path", { class: "agent-pointer-arrow", d: "M4.6 3.4 19.2 11l-6.5 1.7-3.1 6.2Z" }]], "agent-view-arrow"), who);
    const close = h("button", { type: "button", class: "agent-tile-close", title: "Close tab" }, closeGlyph());
    const frame = h("div", { class: "agent-tile-frame" }, canvas, ring, pointer);
    const icon_ = h("span", { class: "agent-tile-icon" });
    const title = h("span", { class: "agent-tile-title" });
    const meta = h("span", { class: "agent-tile-meta" });
    const open = h("button", { type: "button", class: "agent-tile-open" }, frame,
      h("span", { class: "agent-tile-info" }, icon_, h("span", { class: "agent-tile-copy" }, title, meta)));
    tile = h("div", { class: "agent-tile", role: "listitem", draggable: "true" }, open, close);
    Object.assign(tile, { stillTab: tab, stillCanvas: canvas, stillRing: ring, stillPointer: pointer, stillWho: who,
      stillIcon: icon_, stillTitle: title, stillMeta: meta, stillOpen: open, stillClose: close, stillSize: null, stillShotAt: 0 });
    open.addEventListener("click", () => { hideAgentPanel(); showAgentTab(tab); });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = tile.nextElementSibling || tile.previousElementSibling;
      gBrowser.removeTab(tab, { animate: false });
      (next?.querySelector(".agent-tile-open") || galleryClose).focus({ preventScroll: true });
    });
    tile.addEventListener("dragstart", (event) => {
      if (event.target.closest?.(".agent-tile-close")) { event.preventDefault(); return; }
      event.dataTransfer.setData(AGENT_TAB_TYPE, String(tab.linkedBrowser.browserId));
      event.dataTransfer.effectAllowed = "move";
      try { event.dataTransfer.setDragImage(frame, frame.clientWidth / 2, frame.clientHeight / 2); } catch {}
      state.draggingAgentTab = tab;
      tile.classList.add("dragging");
      agentPanel.classList.add("dragging");
      showChrome();
    });
    tile.addEventListener("dragend", () => {
      state.draggingAgentTab = null;
      tile.classList.remove("dragging");
      agentPanel.classList.remove("dragging");
      clearDropPreview();
      if (!agentPanel.hidden) renderAgentPanel();
    });
    tiles.set(tab, tile);
    return tile;
  }

  function updateTile(tile) {
    const tab = tile.stillTab;
    const step = tab.stillAgentStep;
    const fresh = step && Date.now() - step.at < GALLERY_POINTER_MS;
    const working = tab === agentWorkingTab();
    const key = tab.getAttribute("image") || "";
    if (tile.stillIcon.dataset.key !== key || !tile.stillIcon.firstChild) {
      tile.stillIcon.dataset.key = key;
      tile.stillIcon.replaceChildren(faviconFor(tab, "slot-favicon agent-tile-favicon"));
    }
    const title = slotTitle(tab);
    if (tile.stillTitle.textContent !== title) tile.stillTitle.textContent = title;
    const where = displayUrl(tabUrl(tab)) || "New tab";
    const meta = fresh ? `${step.client ? `${step.client} · ` : ""}${stepText(step)}`
      : step ? `${where} · ${ago(step.at)} ago` : where;
    if (tile.stillMeta.textContent !== meta) tile.stillMeta.textContent = meta;
    tile.stillOpen.setAttribute("aria-label", `${title}, ${meta}. Show in a slot`);
    tile.stillClose.setAttribute("aria-label", `Close ${title}`);
    tile.classList.toggle("working", working);
    tile.classList.toggle("fresh", Boolean(fresh));
    placeTilePointer(tile);
  }

  // The agent's pointer and ring sit where it last acted, scaled to the
  // picture; without a place it is not shown.
  function placeTilePointer(tile) {
    const step = tile.stillTab.stillAgentStep;
    const size = tile.stillSize;
    const box = step && Date.now() - step.at < GALLERY_POINTER_MS ? step.box : null;
    const show = Boolean(box && size);
    tile.classList.toggle("aiming", show);
    if (!show) return;
    const k = tile.stillCanvas.parentNode.clientWidth / size.width;
    tile.stillRing.style.translate = `${(box.x * k - 2).toFixed(1)}px ${(box.y * k - 2).toFixed(1)}px`;
    tile.stillRing.style.width = `${Math.max(8, box.width * k + 4).toFixed(1)}px`;
    tile.stillRing.style.height = `${Math.max(8, box.height * k + 4).toFixed(1)}px`;
    tile.stillPointer.style.translate = `${((box.x + Math.min(box.width / 2, 28)) * k).toFixed(1)}px ${((box.y + box.height / 2) * k).toFixed(1)}px`;
    if (tile.stillWho.textContent !== (step.client || "")) tile.stillWho.textContent = step.client || "";
  }

  async function captureTile(tile) {
    const tab = tile.stillTab;
    const global = tab && !tab.closing ? tab.linkedBrowser.browsingContext?.currentWindowGlobal : null;
    if (!global) return;
    tile.stillShotAt = performance.now();
    const reference = gBrowser.selectedBrowser;
    const width = tab.linkedBrowser.clientWidth || reference.clientWidth || 1280;
    const height = tab.linkedBrowser.clientHeight || reference.clientHeight || 800;
    const frameWidth = tile.stillCanvas.parentNode.clientWidth || 320;
    const scale = Math.min(1, frameWidth * (window.devicePixelRatio || 1) / width);
    let bitmap;
    try {
      bitmap = await global.drawSnapshot(new DOMRect(0, 0, width, Math.min(height, width * 0.625)), scale, "white");
    } catch {
      return;
    }
    if (!tile.isConnected) { bitmap.close?.(); return; }
    tile.stillCanvas.width = bitmap.width;
    tile.stillCanvas.height = bitmap.height;
    tile.stillCanvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    tile.stillSize = { width, height };
    tile.classList.add("has-frame");
    placeTilePointer(tile);
  }

  // One picture at a time: the tab the agent works in first, then the one
  // whose picture is oldest. Nothing runs while the gallery is closed.
  function galleryTick() {
    gallery.timer = 0;
    if (agentPanel.hidden) return;
    const all = [...tiles.values()].filter((tile) => tile.isConnected);
    const now = performance.now();
    const due = all.filter((tile) => now - tile.stillShotAt > (tile.classList.contains("working") ? VIEW_FRAME_MS : GALLERY_STILL_MS))
      .sort((a, b) => (b.classList.contains("working") - a.classList.contains("working")) || a.stillShotAt - b.stillShotAt);
    const next = due[0];
    (next ? captureTile(next) : Promise.resolve()).finally(() => {
      if (!agentPanel.hidden && !gallery.timer) gallery.timer = setTimeout(galleryTick, next ? 60 : 250);
    });
  }

  function renderAgentPanel() {
    const names = agentNames();
    const many = new Set(agentState.clients).size > 1;
    galleryTitle.textContent = agentState.clients.length ? `${names} ${many ? "are" : "is"} using Still` : "Agent tabs";
    galleryLiveSwitch.setAttribute("aria-checked", String(agentViewEnabled()));
    galleryStop.hidden = !agentState.clients.length;
    const tabs = agentTabs();
    galleryCloseAll.hidden = tabs.length < 2;
    for (const [tab, tile] of tiles) if (!tabs.includes(tab)) { tile.remove(); tiles.delete(tab); }
    const fresh = [];
    tabs.slice().reverse().forEach((tab, index) => {
      const known = tiles.has(tab);
      const tile = tileFor(tab);
      if (!known) fresh.push(tile);
      if (galleryGrid.children[index] !== tile) galleryGrid.insertBefore(tile, galleryGrid.children[index] || null);
      updateTile(tile);
    });
    galleryEmpty.hidden = tabs.length > 0;
    if (animationsAllowed() && !agentPanel.classList.contains("opening")) {
      for (const tile of fresh) {
        tile.animate([{ opacity: 0, scale: ".96" }, { opacity: 1, scale: "1" }], { duration: 240, easing: "cubic-bezier(0, 0, .58, 1)" });
      }
    }
    refreshAgentPanel();
    if (!gallery.timer && !agentPanel.hidden) gallery.timer = setTimeout(galleryTick, 0);
  }

  // Only what changes between steps: the status line and each tile's text.
  function refreshAgentPanel() {
    if (agentPanel.hidden) return;
    const working = Boolean(agentWorkingTab());
    galleryStatus.classList.toggle("working", working);
    galleryStatus.querySelector(".agent-gallery-status-text").textContent = agentState.clients.length ? agentStatusText() : "No agent connected";
    for (const tile of tiles.values()) updateTile(tile);
  }

  function showAgentPanel({ keyboard = false } = {}) {
    hideUtilityPanel();
    hideSettings();
    gallery.opener = document.activeElement;
    agentPanel.hidden = false;
    agentPanel.classList.add("opening");
    renderAgentPanel();
    agentPanel.classList.remove("opening");
    if (animationsAllowed()) {
      agentPanel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "cubic-bezier(0, 0, .58, 1)" });
      [...galleryGrid.children].slice(0, 12).forEach((tile, index) => {
        tile.animate([{ opacity: 0, transform: "translateY(14px) scale(.97)" }, { opacity: 1, transform: "none" }],
          { duration: 360, delay: 30 + index * 22, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "backwards" });
      });
    }
    utilityButton.classList.add("panel-open");
    clearInterval(gallery.clock);
    gallery.clock = setInterval(refreshAgentPanel, 1000);
    hideAgentView();
    // From the keyboard, focus goes to the first picture; with the mouse the
    // page itself takes it, so Escape works without drawing a focus ring.
    if (keyboard) (galleryGrid.querySelector(".agent-tile-open") || galleryClose).focus({ preventScroll: true });
    else agentPanel.focus({ preventScroll: true });
  }

  function hideAgentPanel() {
    if (agentPanel.hidden) return;
    clearInterval(gallery.clock);
    clearTimeout(gallery.timer);
    gallery.timer = 0;
    utilityButton.classList.remove("panel-open");
    const done = () => { agentPanel.hidden = true; };
    if (animationsAllowed()) {
      agentPanel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "cubic-bezier(.42, 0, 1, 1)" }).finished.then(done, done);
    } else done();
    if (agentPanel.contains(document.activeElement)) (gallery.opener?.isConnected ? gallery.opener : utilityButton).focus({ preventScroll: true });
  }

  galleryClose.addEventListener("click", hideAgentPanel);
  galleryLiveSwitch.addEventListener("click", () => {
    const next = !agentViewEnabled();
    Services.prefs.setBoolPref(PREF_AGENT_VIEW, next);
    galleryLiveSwitch.setAttribute("aria-checked", String(next));
    if (!next) hideAgentView();
  });
  galleryCloseAll.addEventListener("click", () => {
    const tabs = agentTabs();
    closeAgentTabs(tabs);
    showToast(`${tabs.length} agent tabs closed`, 6000, { label: "Undo", run: () => {
      state.bypassLimit = true;
      try { for (let i = 0; i < tabs.length; i++) { const tab = SessionStore.undoCloseTab(window, 0); if (tab) adoptAgentTab(tab); } } finally { state.bypassLimit = false; }
    } });
  });
  galleryStop.addEventListener("click", () => {
    hideAgentPanel();
    lazy.StillAgent.disconnectAll().catch(console.error);
    showToast("Agent access stopped. Agents can connect again when you start one.");
  });
  agentPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideAgentPanel(); }
  });

  // Kept for the places that update the agent's tabs: the gallery, when open.
  function renderAgentChips() {
    if (!agentPanel.hidden) renderAgentPanel();
  }

  // While the agent works the mark turns; when it stops, the turn eases on
  // to the next resting angle instead of snapping back.
  // ------------------------------------------------------------ settings
  // A page of its own under the bar, like the agent gallery: what the
  // utility button switches between, appearance, search, agents, slots and
  // imports. Every change applies at once; there is nothing to save.

  const settingsPage = h("section", { id: "still-settings", class: "still-page", hidden: true, role: "dialog", "aria-label": "Settings", tabindex: "-1" });
  const settingsBody = h("div", { class: "settings-body" });
  const settingsClose = h("button", { type: "button", class: "agent-gallery-close", title: "Close (Esc)", "aria-label": "Close settings" }, closeGlyph());
  settingsPage.append(h("div", { class: "agent-gallery-scroll" }, h("div", { class: "settings-column" },
    h("header", { class: "agent-gallery-head" },
      h("div", { class: "agent-gallery-heading" }, h("h2", { class: "agent-gallery-title", text: "Settings" }),
        null),
      h("div", { class: "agent-gallery-actions" }, settingsClose)),
    settingsBody)));
  chrome.before(settingsPage);

  const MODE_NOTES = {
    downloads: "Files you downloaded",
    agents: "Tabs agents work in, live",
    history: "Pages you visited",
    bookmarks: "Bookmark this page, open saved ones",
    settings: "Always on the button",
    chat: "Ask an agent beside the page (Ctrl+E works anyway)",
    permissions: "Camera, microphone and more for this site",
    browser: "Import sign-ins, history and bookmarks",
    theme: "Click to cycle the theme",
    tabdock: "Slide pages when switching from the dock"
  };

  function settingSwitch(label, note, on, onChange) {
    const knob = h("span", { class: "agent-switch", "aria-hidden": "true" }, h("span", { class: "agent-switch-knob" }));
    const row = h("button", { type: "button", class: "settings-row", role: "switch", "aria-checked": String(Boolean(on)) },
      h("span", { class: "settings-copy" }, h("strong", { text: label }), note ? h("small", { text: note }) : null), knob);
    row.addEventListener("click", () => {
      const next = row.getAttribute("aria-checked") !== "true";
      row.setAttribute("aria-checked", String(next));
      onChange(next);
    });
    return row;
  }


  function settingAction(label, note, onClick) {
    const row = h("button", { type: "button", class: "settings-row action" },
      h("span", { class: "settings-copy" }, h("strong", { text: label }), note ? h("small", { text: note }) : null),
      icon([["path", { d: "m9.5 6 6 6-6 6" }]], "settings-chevron"));
    row.addEventListener("click", onClick);
    return row;
  }


  // A fact about how a feature works: a label and its value, often a
  // command or address in monospace, with an optional copy button.
  function settingInfo(label, value, { mono = false, copy = false, note = "" } = {}) {
    const valueNode = h("span", { class: `settings-value${mono ? " mono" : ""}`, text: value });
    const row = h("div", { class: "settings-row info" },
      h("span", { class: "settings-copy" }, h("strong", { text: label }), note ? h("small", { text: note }) : null),
      h("span", { class: "settings-value-wrap" }, valueNode));
    if (copy) {
      const button = h("button", { type: "button", class: "settings-mini", text: "Copy" });
      button.addEventListener("click", () => {
        try { Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(value); } catch {}
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy"; }, 1400);
      });
      row.querySelector(".settings-value-wrap").append(button);
    }
    row.stillValue = valueNode;
    return row;
  }

  function hostOfUrl(url) {
    try { return new URL(url).host; } catch { return url; }
  }

  // Ask the summary endpoint for one token: proves it answers and names the
  // model behind it, with how long the answer took.
  async function checkSummaryModel(endpoint) {
    const started = performance.now();
    const response = await fetch(new URL("v1/chat/completions", endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GridAPI-Project": "Still", "X-GridAPI-Title": "Settings check" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`error ${response.status}`);
    const data = await response.json();
    return { model: data.model || "unknown model", seconds: (performance.now() - started) / 1000 };
  }

  function buttonModeRow(mode) {
    const meta = utilityMeta[mode];
    const locked = mode === "settings";
    const on = locked || enabledUtilityModes().has(mode);
    const row = h("button", { type: "button", class: "settings-row mode", role: "switch", "aria-checked": String(on), "aria-disabled": String(locked) },
      h("span", { class: "settings-mode-icon" }, icon(meta.paths, meta.className || "")),
      h("span", { class: "settings-copy" }, h("strong", { text: meta.label.replace(/ \(.*\)$/, "") }), h("small", { text: MODE_NOTES[mode] || "" })),
      h("span", { class: "agent-switch", "aria-hidden": "true" }, h("span", { class: "agent-switch-knob" })));
    if (!locked) {
      row.addEventListener("click", () => {
        const modes = enabledUtilityModes();
        if (modes.has(mode)) modes.delete(mode); else modes.add(mode);
        setUtilityModes(modes);
        row.setAttribute("aria-checked", String(modes.has(mode)));
      });
    }
    return row;
  }

  // Bare logos in a row. The others rest grey and faint; the chosen one is
  // in full color, its name beneath. "+" adds your own; a custom one can be
  // removed from under its name.
  function logoRow(label, items, value, { onPick, onAdd, onRemove } = {}) {
    const wrap = h("div", { class: "logo-picker" });
    const row = h("div", { class: "logo-row", role: "radiogroup", "aria-label": label });
    const caption = h("div", { class: "logo-caption" });
    const paint = (id) => {
      const item = items.find((candidate) => candidate.id === id);
      caption.replaceChildren(h("span", { text: item?.name || "" }));
      if (item?.custom && onRemove) {
        const remove = h("button", { type: "button", class: "logo-remove", text: "Remove" });
        remove.addEventListener("click", () => onRemove(item.id));
        caption.append(remove);
      }
    };
    for (const item of items) {
      const logo = item.node || (item.logo ? h("img", { src: item.logo, alt: "" }) : null);
      const button = h("button", { type: "button", class: "logo-pick", role: "radio", "aria-checked": String(item.id === value), title: item.name, "aria-label": item.name },
        logo || h("span", { class: "logo-letter", text: (item.name || "?")[0].toUpperCase() }));
      logo?.addEventListener?.("error", () => logo.replaceWith(h("span", { class: "logo-letter", text: (item.name || "?")[0].toUpperCase() })), { once: true });
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-checked") === "true") return;
        for (const other of row.querySelectorAll(".logo-pick")) other.setAttribute("aria-checked", String(other === button));
        if (animationsAllowed()) button.animate([{ scale: ".8" }, { scale: "1.08" }, { scale: "1" }], { duration: 340, easing: "cubic-bezier(.23, 1, .32, 1)" });
        paint(item.id);
        onPick?.(item.id);
      });
      row.append(button);
    }
    if (onAdd) {
      const add = h("button", { type: "button", class: "logo-add", title: "Add your own", "aria-label": `Add your own ${label.toLowerCase()}` },
        icon([["path", { d: "M12 6v12M6 12h12" }]]));
      add.addEventListener("click", () => onAdd(add));
      row.append(add);
    }
    paint(value);
    wrap.append(row, caption);
    return wrap;
  }

  // A small inline form for adding a custom engine or provider.
  function addForm(fields, onSave, onCancel) {
    const inputs = fields.map((field) => h("input", { class: "settings-field", type: field.type || "text", placeholder: field.placeholder || "",
      value: field.value || "", spellcheck: "false", "aria-label": field.label }));
    const save = h("button", { type: "button", class: "settings-mini strong", text: "Add" });
    const cancel = h("button", { type: "button", class: "settings-mini", text: "Cancel" });
    const form = h("div", { class: "logo-form" }, ...inputs, h("span", { class: "logo-form-actions" }, cancel, save));
    save.addEventListener("click", () => {
      const values = inputs.map((input) => input.value.trim());
      const problem = onSave(values);
      if (problem) { inputs[problem.index ?? 0].setAttribute("aria-invalid", "true"); inputs[problem.index ?? 0].focus(); }
    });
    cancel.addEventListener("click", onCancel);
    for (const input of inputs) input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); save.click(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
      input.removeAttribute("aria-invalid");
    });
    setTimeout(() => inputs[0]?.focus(), 0);
    if (animationsAllowed()) form.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0, 0, .58, 1)" });
    return form;
  }

  function choiceSelect(label, choice, saved, onChange) {
    const select = h("select", { class: "settings-select", "aria-label": label });
    for (const item of choice.values) select.append(h("option", { value: item.value, text: item.name }));
    select.value = choice.values.some((item) => item.value === saved) ? saved : choice.value;
    select.addEventListener("change", () => onChange(select.value));
    return h("label", { class: "settings-row info" }, h("span", { class: "settings-copy" }, h("strong", { text: label })), select);
  }

  const AGENT_LOGOS = { codex: "resource://still/logos/openai.svg", claude: "resource://still/logos/claude.svg", t3: "resource://still/logos/t3.png" };

  function settingsGroup(title, ...children) {
    return h("section", { class: "settings-section" }, h("h3", { text: title }), ...children.filter(Boolean));
  }

  function readJsonPref(name) {
    try { const value = JSON.parse(Services.prefs.getStringPref(name, "[]")); return Array.isArray(value) ? value : []; } catch { return []; }
  }

  async function renderSettings() {
    let detected = "";
    try { detected = await lazy.StillShared.gridApiServer(); } catch {}

    // ---- search
    const searchBox = h("div", { class: "settings-block" });
    const searchExtra = h("div");
    const aiChoice = () => Services.prefs.getStringPref("still.search.ai", "").trim();
    const summaryRows = () => {
      const custom = /^https?:\/\//.test(aiChoice()) ? aiChoice() : "";
      const endpoint = custom || detected;
      const on = aiChoice() !== "off" && Boolean(endpoint);
      const model = h("span", { class: "settings-value mono", text: "Checking…" });
      const runCheck = (url) => {
        if (!url) { model.textContent = "No endpoint"; return; }
        model.textContent = "Checking…";
        checkSummaryModel(url).then(({ model: name, seconds }) => { model.textContent = `${name} · ${seconds.toFixed(1)} s`; model.title = name; },
          (error) => { model.textContent = `Not answering (${error.message || error})`; });
      };
      const field = h("input", { class: "settings-field", type: "url", spellcheck: "false", value: custom, placeholder: detected || "https://your-server/", "aria-label": "Summary endpoint" });
      field.addEventListener("change", () => {
        const value = field.value.trim();
        if (value && !/^https?:\/\//.test(value)) { field.setAttribute("aria-invalid", "true"); return; }
        field.removeAttribute("aria-invalid");
        Services.prefs.setStringPref("still.search.ai", value);
        lazy.StillShared.refreshSearchConfig?.().catch(console.error);
        runCheck(value || detected);
      });
      field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); field.blur(); } });
      const details = [
        h("div", { class: "settings-row info" }, h("span", { class: "settings-copy" }, h("strong", { text: "Model" })), h("span", { class: "settings-value-wrap" }, model)),
        h("label", { class: "settings-row field-row" }, h("span", { class: "settings-copy" }, h("strong", { text: "Endpoint" })), field)
      ];
      for (const node of details) node.hidden = !on;
      const toggle = settingSwitch("AI summaries", "", on, (next) => {
        Services.prefs.setStringPref("still.search.ai", next ? custom : "off");
        lazy.StillShared.refreshSearchConfig?.().catch(console.error);
        for (const node of details) node.hidden = !next;
        if (next) runCheck(endpoint);
      });
      if (!endpoint) toggle.disabled = true;
      if (on) runCheck(endpoint);
      return h("div", { class: "settings-rows" }, toggle, ...details);
    };
    const renderSearch = () => {
      const engines = lazy.StillShared.searchEngines || [];
      const chosen = lazy.StillShared.searchEngine?.().id || "still";
      const extra = () => searchExtra.replaceChildren(...((lazy.StillShared.searchEngine?.().id || "still") === "still" ? [summaryRows()] : []));
      const applyEngine = (id) => {
        Services.prefs.setStringPref("still.search.engine", id);
        lazy.StillShared.refreshSearchConfig?.().catch(console.error);
        lazy.StillShared.setSearchEngine?.();
      };
      const picker = logoRow("Search engine", engines, chosen, {
        onPick: (id) => { applyEngine(id); extra(); },
        onRemove: (id) => {
          Services.prefs.setStringPref("still.search.custom", JSON.stringify(readJsonPref("still.search.custom").filter((engine) => engine.id !== id)));
          applyEngine("still");
          renderSearch();
        },
        onAdd: () => {
          searchExtra.replaceChildren(addForm([
            { label: "Search address", type: "url", placeholder: "https://example.com/search?q={q}" },
            { label: "Name", placeholder: "Name (optional)" }
          ], ([url, name]) => {
            if (!/^https?:\/\/.+/.test(url)) return { index: 0 };
            const template = url.includes("{q}") ? url : url.includes("%s") ? url.replace("%s", "{q}") : `${url}${/[?&=]$/.test(url) ? "" : (url.includes("?") ? "&q=" : "?q=")}{q}`;
            const id = `custom-${Date.now().toString(36)}`;
            Services.prefs.setStringPref("still.search.custom", JSON.stringify([...readJsonPref("still.search.custom"), { id, name, url: template }]));
            applyEngine(id);
            renderSearch();
            return null;
          }, extra));
        }
      });
      searchBox.replaceChildren(picker, searchExtra);
      extra();
    };
    renderSearch();

    // ---- side chat
    const chat = window.StillChat;
    const chatBox = h("div", { class: "settings-block" });
    const chatExtra = h("div");
    const renderChat = () => {
      const agents = chat?.agents?.() || [];
      const chosen = Services.prefs.getStringPref("still.chat.agent", "codex");
      const showChoices = (id) => {
        const agent = agents.find((candidate) => candidate.id === id);
        if (!agent || !chat) { chatExtra.replaceChildren(); return; }
        const rows = h("div", { class: "settings-rows" });
        const fill = (options) => rows.replaceChildren(...options.map((choice) => {
          const name = /model/i.test(`${choice.id} ${choice.name}`) ? "Model" : /effort|reason|thought/i.test(`${choice.id} ${choice.name}`) ? "Effort" : choice.name;
          return choiceSelect(name, choice, chat.savedChoice(agent.id, choice.id), (value) => chat.applyChoice(agent.id, choice.id, value));
        }));
        const known = chat.knownChoices(agent.id);
        if (known.length) fill(known);
        else {
          rows.replaceChildren(h("div", { class: "settings-row info" }, h("span", { class: "settings-copy" }, h("small", { text: `Asking ${agent.name} for its models…` }))));
          chat.loadChoices(agent.id).then((options) => { if (rows.isConnected) fill(options); },
            (error) => { if (rows.isConnected) rows.replaceChildren(h("div", { class: "settings-row info" }, h("span", { class: "settings-copy" }, h("small", { text: error.message || `${agent.name} did not answer.` })))); });
        }
        chatExtra.replaceChildren(rows);
      };
      const items = agents.map((agent) => {
        let logo = AGENT_LOGOS[agent.id] || "";
        if (!logo && agent.endpoint) { try { logo = `${new URL(agent.endpoint).origin}/favicon.ico`; } catch {} }
        return { id: agent.id, name: agent.name, logo, custom: !AGENT_LOGOS[agent.id] };
      });
      const picker = logoRow("Side chat", items, chosen, {
        onPick: (id) => { chat?.selectAgent(id); showChoices(id); },
        onRemove: (id) => {
          Services.prefs.setStringPref("still.chat.agents", JSON.stringify(readJsonPref("still.chat.agents").filter((agent) => agent.id !== id)));
          chat?.selectAgent("codex");
          renderChat();
        },
        onAdd: () => {
          chatExtra.replaceChildren(addForm([
            { label: "Endpoint", type: "url", placeholder: "OpenAI-style server", value: detected },
            { label: "Name", placeholder: "Name", value: detected ? "GridAPI" : "" },
            { label: "API key", type: "password", placeholder: "API key (if it needs one)" }
          ], ([endpoint, name, key]) => {
            if (!/^https?:\/\/.+/.test(endpoint)) return { index: 0 };
            const id = `custom-${Date.now().toString(36)}`;
            Services.prefs.setStringPref("still.chat.agents", JSON.stringify([...readJsonPref("still.chat.agents"),
              { id, name: name || new URL(endpoint).host, kind: "openai", endpoint, ...(key ? { key } : {}) }]));
            chat?.selectAgent(id);
            renderChat();
            return null;
          }, () => showChoices(Services.prefs.getStringPref("still.chat.agent", "codex"))));
        }
      });
      chatBox.replaceChildren(picker, chatExtra);
      showChoices(chosen);
    };
    renderChat();

    // ---- theme, as swatches in the same bare row
    const theme = Services.prefs.getStringPref(PREF_THEME, "system");
    const swatch = (a, b) => h("span", { class: "theme-swatch", style: `--a: ${a}; --b: ${b}` });
    const themePicker = logoRow("Theme", [
      { id: "system", name: "System", node: swatch("#f3f3f0", "#161716") },
      { id: "light", name: "Light", node: swatch("#f3f3f0", "#f3f3f0") },
      { id: "dark", name: "Dark", node: swatch("#2a2c2b", "#2a2c2b") },
      { id: "oled", name: "OLED", node: swatch("#000", "#000") }
    ], theme, { onPick: (name) => { Services.prefs.setStringPref(PREF_THEME, name); applyTheme(name); } });

    // ---- agents
    const connected = [...new Set(agentState.clients)];
    const agentsOn = Services.prefs.getBoolPref("still.agent.enabled", true);
    const agentRows = [
      settingInfo("Connect with", "still mcp", { mono: true, copy: true }),
      settingInfo("Connected", connected.length ? new Intl.ListFormat("en").format(connected) : "Nobody right now"),
      settingSwitch("Live view", "", agentViewEnabled(), (on) => { Services.prefs.setBoolPref(PREF_AGENT_VIEW, on); if (!on) hideAgentView(); })
    ];
    for (const row of agentRows) row.hidden = !agentsOn;

    // ---- more
    const tab = gBrowser.selectedTab;
    const siteHost = (() => { try { return new URL(tabUrl(tab)).host; } catch { return ""; } })();
    const more = h("div", { class: "settings-rows", hidden: true },
      settingSwitch("Dock slide", "", dockSlideEnabled(), (on) => { Services.prefs.setBoolPref(PREF_DOCK_SLIDE, on); renderUtilityButton(); }),
      siteHost ? settingAction(`Permissions for ${siteHost}`, "", () => { hideSettings(); renderPermissions(); }) : null,
      settingAction("Import from Opera GX", "", () => { hideSettings(); runImport("opera"); }),
      settingAction("Import history from Opera GX", "", () => { hideSettings(); runHistoryImport(); }),
      settingAction("Import from another browser", "", () => {
        hideSettings();
        try { lazy.MigrationUtils.showMigrationWizard(window, {}); } catch { showToast("Could not open the import window."); }
      }));
    const moreButton = h("button", { type: "button", class: "settings-more", "aria-expanded": "false" },
      h("span", { text: "More" }), icon([["path", { d: "m7 10 5 5 5-5" }]], "settings-more-chevron"));
    moreButton.addEventListener("click", () => { more.hidden = !more.hidden; moreButton.setAttribute("aria-expanded", String(!more.hidden)); });

    settingsBody.replaceChildren(
      settingsGroup("Search", searchBox),
      settingsGroup("Side chat", chatBox),
      settingsGroup("Theme", themePicker),
      settingsGroup("Button", h("div", { class: "settings-rows" }, ...utilityModes.map(buttonModeRow))),
      settingsGroup("Agents", h("div", { class: "settings-rows" },
        settingSwitch("Let agents use Still", "", agentsOn, (on) => {
          Services.prefs.setBoolPref("still.agent.enabled", on);
          for (const row of agentRows) row.hidden = !on;
          if (!on) lazy.StillAgent.disconnectAll().catch(console.error);
        }), ...agentRows)),
      h("section", { class: "settings-section" }, moreButton, more));
  }

  const settingsState = { opener: null };
  function showSettings({ keyboard = false } = {}) {
    hideUtilityPanel();
    hideAgentPanel();
    settingsState.opener = document.activeElement;
    settingsPage.hidden = false;
    utilityButton.classList.add("panel-open");
    renderSettings().then(() => {
      if (keyboard) settingsBody.querySelector("button")?.focus({ preventScroll: true });
    });
    if (!keyboard) settingsPage.focus({ preventScroll: true });
    if (animationsAllowed()) {
      settingsPage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(0, 0, .58, 1)" });
      settingsBody.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
        { duration: 320, easing: "cubic-bezier(.16, 1, .3, 1)" });
    }
  }

  function hideSettings() {
    if (settingsPage.hidden) return;
    utilityButton.classList.remove("panel-open");
    const done = () => { settingsPage.hidden = true; };
    if (animationsAllowed()) {
      settingsPage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "cubic-bezier(.42, 0, 1, 1)" }).finished.then(done, done);
    } else done();
    if (settingsPage.contains(document.activeElement)) (settingsState.opener?.isConnected ? settingsState.opener : utilityButton).focus({ preventScroll: true });
  }

  settingsClose.addEventListener("click", hideSettings);
  settingsPage.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideSettings(); }
  });

  // The mark is the utility button's "Agent tabs" icon, when that is the
  // button's current mode.
  const TURN_MS = 1500;
  let agentTurn = null;
  let agentGlyph = null;
  function startAgentTurn() {
    utilityButton.classList.add("agent-working");
    if (agentTurn || !animationsAllowed()) return;
    agentGlyph = utilityStage.querySelector(".agents-mode-icon");
    if (!agentGlyph) return;
    agentTurn = agentGlyph.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: TURN_MS, iterations: Infinity });
  }
  function settleAgentTurn() {
    utilityButton.classList.remove("agent-working");
    const turn = agentTurn;
    agentTurn = null;
    if (!turn || !agentGlyph?.isConnected) { turn?.cancel(); return; }
    const angle = ((turn.currentTime || 0) % TURN_MS) / TURN_MS * 360;
    turn.cancel();
    const rest = Math.ceil((angle + 1) / 90) * 90;
    agentGlyph.animate([{ rotate: `${angle}deg` }, { rotate: `${rest}deg` }],
      { duration: Math.max(180, (rest - angle) / 360 * TURN_MS * 1.8), easing: "cubic-bezier(.23, 1, .32, 1)" });
  }

  // --- the agent's pointer on the page in front of you
  // Positions come from the page (CSS pixels in its viewport) and are mapped
  // onto the window through the browser's place and zoom. The pointer glides
  // on a spring, so a new target retargets it from wherever it is.
  const POINTER_SPRING = { omega: 21, zeta: 0.9 };
  const pointer = { shown: false, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, frame: 0, at: 0 };

  function pageToWindow(tab, box) {
    const browser = tab.linkedBrowser;
    const area = browser.getBoundingClientRect();
    const zoom = browser.fullZoom || 1;
    return { x: area.left + box.x * zoom, y: area.top + box.y * zoom, width: box.width * zoom, height: box.height * zoom, area };
  }

  function placePointer() {
    agentPointer.style.translate = `${pointer.x.toFixed(1)}px ${pointer.y.toFixed(1)}px`;
  }

  function stepPointer(now) {
    pointer.frame = 0;
    const elapsed = Math.min(0.05, Math.max(0, (now - pointer.at) / 1000));
    pointer.at = now;
    let left = elapsed;
    while (left > 0) {
      const dt = Math.min(left, 1 / 240);
      left -= dt;
      [pointer.x, pointer.vx] = springStep(pointer.x, pointer.vx, pointer.tx, POINTER_SPRING, dt);
      [pointer.y, pointer.vy] = springStep(pointer.y, pointer.vy, pointer.ty, POINTER_SPRING, dt);
    }
    const done = Math.abs(pointer.x - pointer.tx) < 0.3 && Math.abs(pointer.y - pointer.ty) < 0.3
      && Math.abs(pointer.vx) < 6 && Math.abs(pointer.vy) < 6;
    if (done) { pointer.x = pointer.tx; pointer.y = pointer.ty; pointer.vx = pointer.vy = 0; }
    placePointer();
    if (!done) pointer.frame = window.requestAnimationFrame(stepPointer);
  }

  function aimPointer(tab, activity) {
    const box = pageToWindow(tab, activity.box);
    const { area } = box;
    // Off the visible page (it may have scrolled): only narrate.
    if (box.x + box.width < area.left || box.x > area.right || box.y + box.height < area.top || box.y > area.bottom) {
      narrateAgent(activity);
      return;
    }
    hideNarration();
    const x = box.x + Math.min(box.width / 2, 28);
    const y = box.y + box.height / 2;
    pointer.tx = x;
    pointer.ty = y;
    if (!pointer.shown || !animationsAllowed()) {
      // Arrive from a little up and to the left, like a hand reaching in.
      pointer.x = animationsAllowed() ? x - 46 : x;
      pointer.y = animationsAllowed() ? y - 34 : y;
      pointer.vx = pointer.vy = 0;
      pointer.shown = true;
      placePointer();
    }
    agentPointerVerb.textContent = activity.label;
    agentPointerTarget.textContent = activity.target ? `“${activity.target}”` : "";
    agentPointer.classList.toggle("flip", x > area.right - 280);
    agentPointer.classList.add("visible");
    agentFocus.style.translate = `${(box.x - 4).toFixed(1)}px ${(box.y - 4).toFixed(1)}px`;
    agentFocus.style.width = `${Math.round(box.width + 8)}px`;
    agentFocus.style.height = `${Math.round(box.height + 8)}px`;
    agentFocus.classList.add("visible");
    if (animationsAllowed()) {
      if (!pointer.frame) { pointer.at = performance.now(); pointer.frame = window.requestAnimationFrame(stepPointer); }
    } else {
      pointer.x = x; pointer.y = y;
      placePointer();
    }
    if (/click/i.test(activity.label)) agentRipple(x, y, /double/i.test(activity.label) ? 2 : 1);
    clearTimeout(agentState.pointerTimer);
    agentState.pointerTimer = setTimeout(hideAgentPointer, AGENT_POINTER_REST_MS);
  }

  // A click lands as a ring spreading from the pointer's tip, timed to the
  // moment the agent clicks (it waits for the pointer to arrive).
  function agentRipple(x, y, count) {
    for (let i = 0; i < count; i++) {
      const ring = h("div", { class: "agent-ripple", "aria-hidden": "true" });
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      layer.append(ring);
      const frames = animationsAllowed()
        ? [{ opacity: 0.75, transform: "translate(-50%, -50%) scale(.25)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(1.5)" }]
        : [{ opacity: 0.6 }, { opacity: 0 }];
      ring.animate(frames, { duration: 520, delay: 200 + i * 140, easing: "cubic-bezier(0, 0, .58, 1)", fill: "both" })
        .finished.then(() => ring.remove(), () => ring.remove());
    }
  }

  function hideAgentPointer() {
    clearTimeout(agentState.pointerTimer);
    agentPointer.classList.remove("visible");
    agentFocus.classList.remove("visible");
    pointer.shown = false;
    window.cancelAnimationFrame(pointer.frame);
    pointer.frame = 0;
  }

  // Steps that have no element of their own are told in a line at the
  // bottom left, where browsers show status.
  function narrateAgent(activity) {
    agentNarrationText.textContent = `${agentNames()} · ${stepText(activity)}`;
    agentNarration.classList.add("visible");
    clearTimeout(agentState.narrateTimer);
    agentState.narrateTimer = setTimeout(hideNarration, AGENT_POINTER_REST_MS);
  }

  function hideNarration() {
    clearTimeout(agentState.narrateTimer);
    agentNarration.classList.remove("visible");
  }

  function hideAgentOverlays() {
    hideAgentPointer();
    hideNarration();
    layer.classList.remove("agent-acting");
  }

  // --- the live view: what the agent sees in a tab you are not looking at
  // Agents mostly work in hidden agent tabs (or in a slot behind the current
  // one). While they do, a small card at the bottom right shows that page,
  // refreshed as the agent works (at most about three times a second, and
  // only while it is working), with the agent's pointer and ring drawn where
  // it acts and the step written under it. "Show" brings the tab into a
  // slot. The close button turns the view off; the agent panel turns it on.
  const VIEW_FRAME_MS = 350;
  const VIEW_REST_MS = 6000;
  const view = { tab: null, frameAt: 0, timer: 0, trail: 0, hideTimer: 0, token: 0, box: null, size: null };
  const agentViewCanvas = h("canvas", { class: "agent-view-canvas" });
  const agentViewRing = h("div", { class: "agent-view-ring" });
  const agentViewPointer = h("div", { class: "agent-view-pointer" },
    icon([["path", { class: "agent-pointer-arrow", d: "M4.6 3.4 19.2 11l-6.5 1.7-3.1 6.2Z" }]], "agent-view-arrow"));
  const agentViewIcon = h("span", { class: "agent-view-icon" });
  const agentViewTitle = h("span", { class: "agent-view-title" });
  const agentViewPlace = h("small", { class: "agent-view-place" });
  const agentViewStep = h("span", { class: "agent-view-step" });
  const agentViewShow = h("button", { type: "button", class: "agent-view-show", text: "Show" });
  const agentViewClose = h("button", { type: "button", class: "agent-view-close", title: "Turn off the live view", "aria-label": "Turn off the live view" }, closeGlyph());
  const agentView = h("section", { id: "still-agent-view", "aria-label": "What the agent is doing" },
    h("header", { class: "agent-view-head" }, agentViewIcon,
      h("span", { class: "agent-view-heading" }, agentViewTitle, agentViewPlace), agentViewShow, agentViewClose),
    h("div", { class: "agent-view-stage" }, agentViewCanvas, agentViewRing, agentViewPointer),
    h("footer", { class: "agent-view-foot" }, icon([["path", { class: "agent-star", d: starPath }]], "agent-view-star"), agentViewStep));
  layer.append(agentView);

  function agentViewEnabled() {
    return Services.prefs.getBoolPref(PREF_AGENT_VIEW, true);
  }

  function showAgentView(tab, activity) {
    if (!agentViewEnabled() || !tab || tab.closing || !agentPanel.hidden) return;
    const changed = view.tab !== tab;
    view.tab = tab;
    view.box = activity.box || null;
    if (changed) { view.size = null; agentView.classList.remove("has-frame"); }
    const key = `${tab.linkedBrowser.browserId}|${tab.getAttribute("image") || ""}`;
    if (agentViewIcon.dataset.key !== key) {
      agentViewIcon.dataset.key = key;
      agentViewIcon.replaceChildren(faviconFor(tab, "slot-favicon agent-view-favicon"));
    }
    agentViewTitle.textContent = slotTitle(tab);
    agentViewPlace.textContent = tab.hidden ? "Agent tab" : `Slot ${slotIndex(tab) + 1}`;
    agentViewStep.textContent = stepText(activity);
    agentView.classList.add("visible", "working");
    placeViewPointer();
    requestViewFrame();
    clearTimeout(view.hideTimer);
    view.hideTimer = setTimeout(restAgentView, VIEW_REST_MS);
  }

  // The agent paused: the card stays while you point at it, else it leaves.
  function restAgentView() {
    if (agentView.matches(":hover, :focus-within")) { view.hideTimer = setTimeout(restAgentView, 1500); return; }
    hideAgentView();
  }

  function hideAgentView() {
    clearTimeout(view.hideTimer);
    clearTimeout(view.timer);
    clearTimeout(view.trail);
    view.timer = 0;
    view.tab = null;
    view.token++;
    agentView.classList.remove("visible", "working");
  }

  // One frame now (or as soon as the last one is old enough), and one more
  // shortly after the agent's last step, to show what that step did.
  function requestViewFrame() {
    if (!view.timer) {
      const wait = Math.max(0, view.frameAt + VIEW_FRAME_MS - performance.now());
      view.timer = setTimeout(() => { view.timer = 0; view.frameAt = performance.now(); captureAgentView(); }, wait);
    }
    clearTimeout(view.trail);
    view.trail = setTimeout(() => { view.frameAt = performance.now(); captureAgentView(); }, 750);
  }

  async function captureAgentView() {
    const tab = view.tab;
    const global = tab && !tab.closing ? tab.linkedBrowser.browsingContext?.currentWindowGlobal : null;
    if (!global) return;
    const reference = gBrowser.selectedBrowser;
    const width = tab.linkedBrowser.clientWidth || reference.clientWidth || 1280;
    const height = tab.linkedBrowser.clientHeight || reference.clientHeight || 800;
    const stageWidth = agentViewCanvas.parentNode.clientWidth || 320;
    const scale = Math.min(1, stageWidth * (window.devicePixelRatio || 1) / width);
    const token = ++view.token;
    let bitmap;
    try {
      bitmap = await global.drawSnapshot(new DOMRect(0, 0, width, height), scale, "white");
    } catch {
      return;
    }
    if (token !== view.token || view.tab !== tab) { bitmap.close?.(); return; }
    agentViewCanvas.width = bitmap.width;
    agentViewCanvas.height = bitmap.height;
    agentViewCanvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    view.size = { width, height };
    agentView.style.setProperty("--agent-view-ratio", `${width} / ${height}`);
    agentView.classList.add("has-frame");
    placeViewPointer();
  }

  function placeViewPointer() {
    const box = view.box;
    const size = view.size;
    const show = Boolean(box && size);
    agentView.classList.toggle("aiming", show);
    if (!show) return;
    const stage = agentViewCanvas.parentNode;
    const k = stage.clientWidth / size.width;
    agentViewRing.style.translate = `${(box.x * k - 2).toFixed(1)}px ${(box.y * k - 2).toFixed(1)}px`;
    agentViewRing.style.width = `${Math.max(8, box.width * k + 4).toFixed(1)}px`;
    agentViewRing.style.height = `${Math.max(8, box.height * k + 4).toFixed(1)}px`;
    agentViewPointer.style.translate = `${((box.x + Math.min(box.width / 2, 28)) * k).toFixed(1)}px ${((box.y + box.height / 2) * k).toFixed(1)}px`;
  }

  agentViewShow.addEventListener("click", () => {
    const tab = view.tab;
    hideAgentView();
    if (tab?.hidden) showAgentTab(tab);
    else if (tab) activate(tab);
  });
  agentViewClose.addEventListener("click", () => {
    Services.prefs.setBoolPref(PREF_AGENT_VIEW, false);
    hideAgentView();
    showToast("Live view is off. You can turn it back on in the agent gallery.");
    if (!agentPanel.hidden) renderAgentPanel();
  });

  function updateAgent({ clients = [], engine = false, activity } = {}) {
    const before = new Set(agentState.clients);
    agentState.clients = clients;
    agentState.engine = engine;
    const connected = clients.length > 0;
    const arrived = clients.filter((name) => !before.has(name));
    // The agent gallery lives on the utility button ("Agent tabs").
    agentButton.hidden = true;
    const label = connected ? `${agentNames()} ${new Set(clients).size > 1 ? "are" : "is"} using Still` : "No agent connected";
    agentButton.title = label;
    agentButton.setAttribute("aria-label", label);
    if (arrived.length) {
      agentLive.textContent = `${new Intl.ListFormat("en").format(arrived)} connected`;
      showToast(`${new Intl.ListFormat("en").format(arrived)} can now use Still`, 4200, { label: "Stop", run: () => lazy.StillAgent.disconnectAll().catch(console.error) });
    }
    if (!connected) {
      hideAgentPanel();
      settleAgentTurn();
      hideAgentOverlays();
      hideAgentView();
      if (before.size) agentLive.textContent = "Agent disconnected";
    }
    if (activity?.label) {
      agentState.activity = { ...activity, at: Date.now() };
      logStep(agentState.activity);
      markAgentUse(agentState.activity);
      startAgentTurn();
      const tab = tabByBrowserId(activity.tab);
      const onScreen = agentOnScreen(tab);
      layer.classList.toggle("agent-acting", onScreen);
      if (onScreen && activity.box) aimPointer(tab, activity);
      else if (onScreen) narrateAgent(activity);
      if (onScreen && view.tab === tab) hideAgentView();
      else if (!onScreen && tab) showAgentView(tab, activity);
      for (const element of slotRow.querySelectorAll(".agent-busy")) element.classList.remove("agent-busy");
      const pill = tab && !onScreen && !tab.hidden ? pills.get(tab) : null;
      pill?.classList.add("agent-busy");
      clearTimeout(agentState.idleTimer);
      agentState.idleTimer = setTimeout(() => {
        settleAgentTurn();
        layer.classList.remove("agent-acting");
        agentView.classList.remove("working");
        for (const element of slotRow.querySelectorAll(".agent-busy")) element.classList.remove("agent-busy");
        renderAgentChips();
        refreshAgentPanel();
      }, 1400);
    }
    renderAgentChips();
    if (activity?.label) refreshAgentPanel();
    else if (!agentPanel.hidden) renderAgentPanel();
  }

  // Your switching away takes the agent's pointer off the page it was on.
  gBrowser.tabContainer.addEventListener("TabSelect", () => {
    hideAgentOverlays();
    if (view.tab === gBrowser.selectedTab) hideAgentView();
  });
  gBrowser.tabContainer.addEventListener("TabClose", (event) => {
    if (view.tab === event.target) hideAgentView();
    if (event.target.stillAgent) Promise.resolve().then(renderAgentChips);
  });

  // Agent tabs come back hidden after a restart.
  function restoreAgentTabs() {
    for (const tab of gBrowser.tabs) {
      let marked = "";
      try { marked = SessionStore.getCustomTabValue(tab, AGENT_KEY); } catch {}
      if (marked !== "1") continue;
      tab.stillAgent = true;
      tab.stillAgentUsed = Date.now();
      if (!tab.selected) gBrowser.hideTab(tab);
    }
    renderAgentChips();
  }

  // ------------------------------------------------------ download pages
  // A link that turns out to be a file leaves its new slot empty. That slot
  // shows the download instead: the file, live progress, and what to do
  // with it. The page is chrome drawn over the slot's blank browser, so it
  // slides with the slot and reads the download directly.

  const DOWNLOAD_KEY = "still-download";
  const downloadPages = new Map();     // tab -> page
  const arrowPaths = ["M12 4.5v11m-4.5-4.5 4.5 4.5 4.5-4.5"];

  function downloadName(download) {
    try { return PathUtils.filename(download.target.path); } catch { return "Download"; }
  }

  function downloadHost(download) {
    try { return new URL(download.source.url).host || download.source.url; } catch { return download.source?.url || ""; }
  }

  function bytes(value) {
    const [amount, unit] = lazy.DownloadUtils.convertByteUnits(Math.max(0, value || 0));
    return `${amount} ${unit}`;
  }

  // A blank slot opened just for this file (not a page that started one).
  function freshTabFor(download) {
    const id = download.source?.browsingContextId;
    if (!id) return null;
    const tab = gBrowser.tabs.find((candidate) => candidate.linkedBrowser?.browsingContext?.id === id);
    if (!tab || tab.closing || downloadPages.has(tab)) return null;
    const browser = tab.linkedBrowser;
    const blank = !browser.currentURI || browser.currentURI.spec === "about:blank";
    return blank && !browser.canGoBack ? tab : null;
  }

  function downloadState(download) {
    if (download.succeeded) return "done";
    if (download.error) return download.error.becauseBlocked ? "blocked" : "failed";
    if (download.canceled) return download.hasPartialData ? "paused" : "canceled";
    return "running";
  }

  function buildDownloadPage(tab) {
    const fileIcon = h("img", { class: "dl-file", alt: "" });
    const badge = h("span", { class: "dl-badge", "aria-hidden": "true" });
    const name = h("h1", { class: "dl-name" });
    const meta = h("p", { class: "dl-meta" });
    const fill = h("span", { class: "dl-fill" });
    const bar = h("div", { class: "dl-bar", role: "progressbar", "aria-label": "Download progress" }, fill);
    const status = h("p", { class: "dl-status" });
    const actions = h("div", { class: "dl-actions" });
    const live = h("p", { class: "dl-live", role: "status", "aria-live": "polite" });
    const root = h("section", { class: "still-download-page", "aria-label": "Download" },
      h("div", { class: "dl-body" },
        h("div", { class: "dl-icon" }, fileIcon, badge),
        name, meta, bar, status, actions, live));
    fileIcon.addEventListener("error", () => fileIcon.replaceWith(icon(["M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5Z", "M14 3.5V8h4"], "dl-file dl-file-generic")), { once: true });
    return { tab, root, fileIcon, badge, name, meta, bar, fill, status, actions, live, download: null, kind: "", timeLeft: -1, buttons: "" };
  }

  function downloadButton(label, run, primary = false) {
    return h("button", { type: "button", class: primary ? "dl-button primary" : "dl-button", text: label,
      onclick: () => Promise.resolve().then(run).catch(() => showToast("That did not work. Try again from Downloads.")) });
  }

  function renderDownloadPage(page) {
    const download = page.download;
    if (!download) {
      page.root.dataset.state = "missing";
      page.name.textContent = page.missingName || "Download";
      page.meta.textContent = "This download is no longer in your list.";
      page.status.textContent = "";
      page.actions.replaceChildren();
      return;
    }
    const kind = downloadState(download);
    const fileName = downloadName(download);
    if (page.name.textContent !== fileName) { page.name.textContent = fileName; page.name.title = download.target.path; }
    const iconSrc = `moz-icon://${encodeURIComponent(fileName)}?size=64`;
    if (page.fileIcon.isConnected && page.fileIcon.getAttribute("src") !== iconSrc) page.fileIcon.src = iconSrc;
    const total = download.hasProgress ? download.totalBytes : 0;
    page.meta.textContent = [downloadHost(download), total ? bytes(total) : ""].filter(Boolean).join(" · ");
    page.root.dataset.state = kind;
    const known = download.hasProgress && download.totalBytes > 0;
    page.bar.classList.toggle("indeterminate", kind === "running" && !known);
    const progress = kind === "done" ? 1 : known ? download.currentBytes / download.totalBytes : 0;
    page.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
    if (known) page.bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
    else page.bar.removeAttribute("aria-valuenow");

    let text = "";
    if (kind === "running") {
      if (!download.currentBytes) text = "Starting download";
      else {
        const parts = [known ? `${Math.floor(progress * 100)}%` : "", known ? lazy.DownloadUtils.getTransferTotal(download.currentBytes, download.totalBytes) : `${bytes(download.currentBytes)} so far`];
        if (download.speed > 0) parts.push(`${bytes(download.speed)}/s`);
        if (known && download.speed > 0) {
          const [left, last] = lazy.DownloadUtils.getTimeLeft((download.totalBytes - download.currentBytes) / download.speed, page.timeLeft);
          page.timeLeft = last;
          parts.push(left);
        }
        text = parts.filter(Boolean).join(" · ");
      }
    } else if (kind === "done") {
      let folder = "";
      try { folder = PathUtils.filename(PathUtils.parent(download.target.path)); } catch {}
      text = folder ? `Saved in ${folder}` : "Saved";
    } else if (kind === "paused") {
      text = known ? `Paused at ${lazy.DownloadUtils.getTransferTotal(download.currentBytes, download.totalBytes)}` : `Paused at ${bytes(download.currentBytes)}`;
    } else if (kind === "canceled") {
      text = "Canceled";
    } else if (kind === "blocked") {
      text = "Firefox blocked this file because it may be harmful.";
    } else {
      text = "Couldn't finish the download. Check your connection, then try again.";
    }
    if (page.status.textContent !== text) page.status.textContent = text;

    // Rebuild the buttons only when the set changes, so a click never lands
    // on a button that was swapped out under the pointer.
    const set = `${kind}|${download.hasPartialData}`;
    if (page.buttons !== set) {
      page.buttons = set;
      const buttons = [];
      if (kind === "done") {
        buttons.push(downloadButton("Open", () => download.launch(), true));
        buttons.push(downloadButton("Show in folder", () => download.showContainingDirectory()));
      } else if (kind === "running") {
        if (download.hasPartialData) buttons.push(downloadButton("Pause", () => download.cancel()));
        buttons.push(downloadButton("Cancel", async () => { await download.cancel(); await download.removePartialData(); }));
      } else if (kind === "paused") {
        buttons.push(downloadButton("Resume", () => download.start(), true));
        buttons.push(downloadButton("Cancel", () => download.removePartialData()));
      } else if (kind === "canceled" || kind === "failed") {
        buttons.push(downloadButton(kind === "failed" ? "Try again" : "Download again", () => download.start(), true));
      }
      page.actions.replaceChildren(...buttons);
    }
    if (page.kind !== kind) {
      if (page.kind) page.live.textContent = { done: `${fileName} downloaded`, failed: `${fileName} failed`, blocked: `${fileName} blocked`, paused: "Paused", canceled: "Canceled", running: "Downloading" }[kind];
      page.kind = kind;
      page.badge.replaceChildren(kind === "running" ? icon(arrowPaths) : kind === "done" ? icon(["M6.5 12.5l3.5 3.5 7.5-8"]) : kind === "paused" ? icon(["M9.5 7.5v9M14.5 7.5v9"]) : icon(["M12 7v6.5M12 16.8v.2"]));
    }
    if (syncDownloadTitle(page)) queueRender();
  }

  // The slot's title follows the file name.
  function syncDownloadTitle(page) {
    const title = page.download ? downloadName(page.download) : page.missingName || "Download";
    if (page.tab.stillDownloadTitle === title) return false;
    page.tab.stillDownloadTitle = title;
    return true;
  }

  function mountDownloadPage(page) {
    const stack = page.tab.linkedBrowser?.closest(".browserStack");
    if (!stack || page.root.parentNode === stack) return;
    stack.append(page.root);
  }

  function showDownloadPage(tab, download, missingName = "") {
    let page = downloadPages.get(tab);
    if (!page) {
      page = buildDownloadPage(tab);
      downloadPages.set(tab, page);
    }
    page.download = download;
    page.missingName = missingName;
    tab.stillDownload = page;
    renderDownloadPage(page);
    mountDownloadPage(page);
    if (download) {
      try {
        window.SessionStore?.setCustomTabValue(tab, DOWNLOAD_KEY, JSON.stringify({ url: download.source.url, path: download.target.path }));
      } catch {}
    }
    if (state.overflow?.tab === tab) state.overflow.update();
    queueRender();
  }

  function removeDownloadPage(tab) {
    const page = downloadPages.get(tab);
    if (!page) return;
    downloadPages.delete(tab);
    page.root.remove();
    delete tab.stillDownload;
    delete tab.stillDownloadTitle;
    try { window.SessionStore?.deleteCustomTabValue(tab, DOWNLOAD_KEY); } catch {}
    queueRender();
  }

  async function watchDownloads() {
    const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    let replaying = true;
    const known = [];
    await list.addView({
      onDownloadAdded(download) {
        if (replaying) { known.push(download); return; }
        const tab = freshTabFor(download);
        if (tab) showDownloadPage(tab, download);
      },
      onDownloadChanged(download) {
        for (const page of downloadPages.values()) if (page.download === download) renderDownloadPage(page);
      },
      onDownloadRemoved(download) {
        for (const page of downloadPages.values()) {
          if (page.download === download) { page.missingName = downloadName(download); page.download = null; renderDownloadPage(page); }
        }
      }
    });
    replaying = false;
    // A link that started Still may have begun its download before this.
    for (const download of known) {
      if (download.stopped || Date.now() - download.startTime > 30000) continue;
      const tab = freshTabFor(download);
      if (tab) showDownloadPage(tab, download);
    }
    // Slots that showed a download before a restart show it again.
    for (const tab of gBrowser.tabs) {
      let saved = null;
      try { saved = JSON.parse(window.SessionStore?.getCustomTabValue(tab, DOWNLOAD_KEY) || "null"); } catch {}
      if (!saved?.path || downloadPages.has(tab)) continue;
      const download = known.find((item) => item.target.path === saved.path && item.source.url === saved.url) || null;
      let name = "";
      try { name = PathUtils.filename(saved.path); } catch {}
      showDownloadPage(tab, download, name);
    }
  }

  // --------------------------------------------------- five-slot limit
  // Firefox may open a sixth tab (links, window.open, other apps). The tab is
  // kept so opener relationships survive; Still then reuses an empty home
  // slot or asks which slot the page should replace.

  function replacementRow(tab) {
    const row = h("button", { type: "button", class: "replacement-slot" },
      faviconFor(tab, "slot-favicon replacement-favicon"),
      h("span", { class: "replacement-copy" },
        h("strong", { text: slotTitle(tab) }),
        h("span", { text: displayUrl(tabUrl(tab)) || "Start page" })),
      h("span", { class: "replacement-action", text: "Replace" }));
    row.addEventListener("click", () => resolveOverflow(tab));
    return row;
  }

  function showOverflow(newTab) {
    if (state.overflow) {
      // Only one decision at a time; an extra page waits as the newest choice.
      closeOverflowTab(state.overflow.tab);
    }
    state.overflow = { tab: newTab };
    const update = () => {
      const url = newTab.stillDownloadTitle ? `Download: ${newTab.stillDownloadTitle}` : displayUrl(tabUrl(newTab)) || newTab.label || "New page";
      replacementUrl.textContent = url;
      replacementUrl.title = url;
    };
    update();
    state.overflow.update = update;
    replacementList.replaceChildren(...slotTabs().filter((tab) => tab !== newTab).map(replacementRow));
    replacementBackdrop.hidden = false;
    window.requestAnimationFrame(() => replacementBackdrop.classList.add("visible"));
    replacementList.firstElementChild?.focus();
  }

  function hideOverflowDialog() {
    replacementBackdrop.classList.remove("visible");
    setTimeout(() => { if (!replacementBackdrop.classList.contains("visible")) replacementBackdrop.hidden = true; }, 160);
  }

  function closeOverflowTab(tab) {
    if (tab && !tab.closing) gBrowser.removeTab(tab, { animate: false });
  }

  function resolveOverflow(replacedTab) {
    const overflow = state.overflow;
    if (!overflow) return;
    state.overflow = null;
    hideOverflowDialog();
    const { tab } = overflow;
    if (tab.closing) return;
    if (replacedTab.closing || !gBrowser.tabs.includes(replacedTab)) { showOverflow(tab); return; }
    const direction = Math.sign(slotIndex(replacedTab) - slotIndex(gBrowser.selectedTab));
    // The new page takes the chosen slot's place, then that slot closes.
    gBrowser.moveTabTo(tab, { tabIndex: tabPos(replacedTab), forceUngrouped: true });
    state.nextDirection = direction;
    gBrowser.selectedTab = tab;
    closeSlot(replacedTab);
  }

  function cancelOverflow() {
    const overflow = state.overflow;
    if (!overflow) return;
    state.overflow = null;
    hideOverflowDialog();
    const download = overflow.tab.stillDownload?.download;
    closeOverflowTab(overflow.tab);
    if (download && !download.stopped) showToast(`${downloadName(download)} keeps downloading. It is in Downloads.`);
  }

  replacementCancel.addEventListener("click", cancelOverflow);
  replacementBackdrop.addEventListener("pointerdown", (event) => {
    if (event.target === replacementBackdrop) cancelOverflow();
  });

  function handleTabOpen(event) {
    const tab = event.target;
    queueRender();
    notifyPeers();
    if (state.agentOpening) { adoptAgentTab(tab); return; }
    if (!state.restored || state.bypassLimit || tab.hidden) return;
    const tabs = slotTabs();
    if (tabs.length <= Math.max(1, slotCapacity())) return;
    const home = tabs.find((candidate) => candidate !== tab && isHomeTab(candidate));
    if (home) {
      gBrowser.moveTabTo(tab, { tabIndex: tabPos(home), forceUngrouped: true });
      const wasSelected = gBrowser.selectedTab === home;
      if (wasSelected) gBrowser.selectedTab = tab;
      gBrowser.removeTab(home, { animate: false });
      return;
    }
    showOverflow(tab);
  }

  // With every slot taken, a new page (a link from another app, a link that
  // opens a new tab) loads in the background, so the page you are on stays
  // put until you pick the slot it replaces. Free slots behave as before.
  const originalAddTab = gBrowser.addTab;
  gBrowser.addTab = function stillAddTab(uri, options = {}) {
    const opener = options?.openerBrowser && gBrowser.getTabForBrowser(options.openerBrowser);
    if (opener?.stillAgent && opener.hidden) {
      state.agentOpening++;
      try { return originalAddTab.call(this, uri, { ...options, inBackground: true }); } finally { state.agentOpening--; }
    }
    if (state.restored && !state.bypassLimit && !options?.inBackground && !options?.createLazyBrowser) {
      const tabs = slotTabs();
      if (tabs.length >= slotCapacity() && !tabs.some(isHomeTab)) options = { ...options, inBackground: true };
    }
    return originalAddTab.call(this, uri, options);
  };

  // Ctrl+T and the new-tab command respect the slot limit up front.
  const originalOpenTab = BrowserCommands.openTab.bind(BrowserCommands);
  BrowserCommands.openTab = function stillOpenTab(options = {}) {
    if (!options.url && slotTabs().length >= slotCapacity()) {
      openNewSlot({});
      return;
    }
    state.nextDirection = slotTabs().length ? 1 : 0;
    originalOpenTab(options);
  };

  // Window title: the page, then Still (no Firefox branding in the taskbar).
  gBrowser.getWindowTitleForBrowser = function stillWindowTitle(browser) {
    const tab = gBrowser.getTabForBrowser(browser);
    const title = tab && !isHomeUrl(tabUrl(tab)) ? slotTitle(tab) : "";
    return title ? `${title} · Still` : "Still";
  };
  gBrowser.updateTitlebar();

  window.openLocation = function stillOpenLocation() {
    beginEdit(gBrowser.selectedTab);
  };

  // Firefox focuses its address bar (hidden here) for new tabs and some
  // shortcuts. Send that focus to Still's start page or slot editor instead
  // so typing never disappears into an invisible field.
  gURLBar.inputField?.addEventListener("focus", () => {
    window.setTimeout(() => {
      if (!gURLBar.focused) return;
      const tab = gBrowser.selectedTab;
      if (isHomeUrl(tabUrl(tab))) gBrowser.selectedBrowser.focus();
      else beginEdit(tab);
    }, 0);
  });

  // ------------------------------------------------------------- events

  const tabEvents = ["TabAttrModified", "TabMove", "TabShow", "TabHide", "TabPinned", "TabUnpinned"];
  for (const type of tabEvents) gBrowser.tabContainer.addEventListener(type, queueRender);
  // Agent tabs shown or hidden change how many slots the other windows have.
  for (const type of ["TabShow", "TabHide"]) gBrowser.tabContainer.addEventListener(type, notifyPeers);
  // A closing window gives its slots back to the others.
  window.addEventListener("unload", () => {
    const peers = stillWindows();
    Services.tm.dispatchToMainThread(() => { for (const win of peers) if (!win.closed) win.StillChrome?.queueRender?.(); });
  });
  gBrowser.tabContainer.addEventListener("TabOpen", handleTabOpen);
  gBrowser.tabContainer.addEventListener("TabSelect", (event) => {
    if (state.editingTab && state.editingTab !== gBrowser.selectedTab) finishEdit();
    if (gBrowser.selectedTab.stillDownload) mountDownloadPage(gBrowser.selectedTab.stillDownload);
    hideUtilityPanel();
    queueRender();
    window.requestAnimationFrame(placeShimmerAnchors);
  });
  gBrowser.tabContainer.addEventListener("TabClose", (event) => {
    const tab = event.target;
    if (reorder?.active) finishReorder({ cancel: true });
    if (state.overflow?.tab === tab) { state.overflow = null; hideOverflowDialog(); }
    removeDownloadPage(tab);
    if (state.editingTab === tab) state.editingTab = null;
    if (state.vertical?.tab === tab) finishVertical(true);
    if (state.strip?.panels.includes(panelOf(tab))) finishSlide();
    window.setTimeout(() => { queueRender(); notifyPeers(); }, 0);
  });

  gBrowser.addTabsProgressListener({
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress.isTopLevel) return;
      if (state.overflow && browser === state.overflow.tab.linkedBrowser) state.overflow.update();
      const tab = gBrowser.getTabForBrowser(browser);
      if (tab?.stillDownload && location?.spec !== "about:blank") removeDownloadPage(tab);
      if (browser === gBrowser.selectedBrowser && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
        queueRender();
      }
    }
  });

  // Paint each page's own background behind it (and behind the slot row
  // when it moves), so resizing or edge bumps never show Firefox's grey.
  function applyPageColor(browser, color) {
    if (!browser || !/^(rgb|#)/.test(color || "")) return;
    browser.stillColor = color;
    browser.closest(".browserContainer")?.style.setProperty("--tabpanel-background-color", color);
    browser.style.backgroundColor = color;
    if (browser === gBrowser.selectedBrowser) gBrowser.tabpanels.style.backgroundColor = color;
  }

  gBrowser.tabContainer.addEventListener("TabSelect", () => {
    const color = gBrowser.selectedBrowser.stillColor;
    gBrowser.tabpanels.style.backgroundColor = color || "";
  });

  function onPageMessage(browser, name, data) {
    if (name === "Still:PageColor") { applyPageColor(browser, data?.color); return; }
    if (name === "Still:PageReady" && browser === gBrowser.selectedBrowser && tabUrl(gBrowser.selectedTab) !== "about:blank") {
      state.splashPageReady?.();
    }
    if (name === "Still:PageReady") {
      if (state.vertical?.browser === browser && tabUrl(state.vertical.tab) !== state.vertical.locationBefore) {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => runVertical(browser)));
      }
    } else if (name === "Still:Wheel" && gBrowser.browsers.includes(browser)) {
      // Any slot of this window: during a slide Firefox keeps delivering the
      // spin to the page it started on, which is no longer the selected one.
      handleWheelGesture(data.kind, data.direction);
    } else if (name === "Still:Key" && browser === gBrowser.selectedBrowser) {
      if (data?.action === "dock-show") showDock();
      else if (data?.action === "dock-release") releaseDock();
    }
  }

  window.addEventListener("keydown", (event) => {
    if (!event.metaKey && !event.shiftKey
        && ((event.key === "Alt" && event.ctrlKey) || (event.key === "Control" && event.altKey))) {
      showDock();
      return;
    }
    if (event.key !== "Escape") return;
    if (reorder?.active) { event.preventDefault(); event.stopPropagation(); finishReorder({ cancel: true }); return; }
    if (state.overflow) { event.preventDefault(); cancelOverflow(); return; }
    if (state.dock.visible) { hideDock(true); return; }
    if (!utilityPanel.hidden) { hideUtilityPanel(); return; }
    if (document.documentElement.hasAttribute("still-edge")) cancelEdgeEffects();
  }, true);
  window.addEventListener("keyup", (event) => {
    if (event.key === "Alt" || event.key === "Control") releaseDock();
  }, true);

  // Ctrl+wheel over Still's own controls. Over pages the page helper
  // (StillPageChild) delivers the same gesture.
  // Anywhere in the window except over a page itself, which the page helper
  // handles. Mid-slide the pointer is often over the panel container rather
  // than a page, and those notches count too.
  window.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || event.metaKey || !event.deltaY || event.target.closest?.(".utility-button")) return;
    if (event.target.localName === "browser" && event.target.isRemoteBrowser) return;
    event.preventDefault();
    const now = event.timeStamp;
    if (now - (state.wheelAt || 0) > 220 || Math.sign(state.wheelSum || 0) !== Math.sign(event.deltaY)) state.wheelSum = 0;
    state.wheelAt = now;
    state.wheelSum = (state.wheelSum || 0) + (event.deltaMode === 0 ? event.deltaY / 100 : Math.sign(event.deltaY));
    while (Math.abs(state.wheelSum) >= 0.999) {
      const direction = Math.sign(state.wheelSum);
      state.wheelSum -= direction;
      handleWheelGesture(event.altKey ? "dock" : "slots", direction);
    }
  }, { passive: false, capture: true });

  function handleWheelGesture(kind, direction) {
    const now = performance.now();
    // Each step retargets the strip's spring, so a fast spin only needs a
    // short guard against one notch arriving twice.
    if (now - state.lastSlotWheel < (kind === "dock" ? 85 : 24)) return;
    state.lastSlotWheel = now;
    if (kind === "dock") moveDock(direction);
    else cycleSlot(direction);
  }

  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".utility-button, .utility-panel:not(.agent-panel)")) hideUtilityPanel();
    // The agent gallery is a page, not a popup: clicks inside it never close
    // it. Picking a slot on the bar does, to show that slot.
    if (event.target.closest?.("#still-chrome .slot")) { hideAgentPanel(); hideSettings(); }
  }, true);

  // Coming back to the window briefly shows the slots, as in the Electron build.
  window.addEventListener("activate", () => {
    if (!state.editingTab) { showChrome(); scheduleChromeHide(900); }
  });

  window.addEventListener("resize", () => { finishSlide(); clearStretch(); finishVertical(true); placeShimmerAnchors(); });

  reducedMotion.addEventListener("change", () => { finishSlide(); finishVertical(true); });

  // ------------------------------------------------------------- startup

  window.StillChrome = {
    onPageMessage,
    onWheelGesture: handleWheelGesture,
    showToast,
    activate,
    cycleSlot,
    openNewSlot,
    beginEdit,
    slotTabs,
    queueRender,
    slotCapacity,
    detachSlot,
    slotDragActive,
    showDock,
    moveDock,
    releaseDock,
    state,
    captureBrowser,
    applyTheme,
    replaySplash: () => runSplash({ force: true }),
    runImport,
    slotIndex,
    agent: { update: updateAgent, openTab: openAgentTab, showTab: showAgentTab, tabs: agentTabs, onScreen: agentOnScreen, ownerLeft: agentOwnerLeft }
  };

  renderSlots();
  runSplash();
  // A window opened for a detached slot arrives: its page settles in and
  // the bar shows its one slot for a moment.
  if (stillWindows().some((win) => win.StillChrome?.state?.detachingUntil > Date.now())) {
    state.detached = true;
    queueRender();
    window.requestAnimationFrame(() => {
      if (animationsAllowed()) {
        gBrowser.tabpanels.animate([{ opacity: 0, transform: "scale(.965)" }, { opacity: 1, transform: "none" }],
          { duration: 380, easing: EASE });
      }
      showChrome();
      scheduleChromeHide(1500);
    });
  }
  applyTheme(Services.prefs.getStringPref(PREF_THEME, "system"));
  (window.SessionStore?.promiseAllWindowsRestored || Promise.resolve()).then(() => {
    state.restored = true;
    restoreAgentTabs();
    queueRender();
    watchDownloads().catch(console.error);
    lazy.StillAgent.start().then(() => updateAgent(lazy.StillAgent.status())).catch(console.error);
    // Once, when Still has settled and you are not busy with it.
    setTimeout(() => window.requestIdleCallback(() => firstRunImport().catch(console.error), { timeout: 10000 }), 6000);
  });
  lazy.StillShared.attachWindow(window, {
    onPageMessage: (...args) => window.StillChrome.onPageMessage(...args),
    onWheelGesture: (...args) => window.StillChrome.onWheelGesture(...args)
  });
})();
