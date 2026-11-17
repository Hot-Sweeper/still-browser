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

  const utilityModes = ["bookmarks", "history", "downloads", "permissions", "browser", "theme", "tabdock"];
  const utilityMeta = {
    bookmarks: { label: "Bookmarks", paths: ["m12 3.7 2.5 5.1 5.6.8-4.05 3.95.96 5.58L12 16.5l-5.01 2.63.96-5.58L3.9 9.6l5.6-.8L12 3.7Z"] },
    history: { label: "History", paths: ["M4.5 5.8v4.4h4.4M5 10a7.5 7.5 0 1 1 .8 5.2M12 7.6V12l3.1 1.8"] },
    downloads: { label: "Downloads", paths: ["M12 3.5v11m-4-4 4 4 4-4M5 19.5h14"] },
    permissions: { label: "Site Permissions", paths: ["M12 3.2 19 6v5.1c0 4.4-2.8 7.6-7 9.7-4.2-2.1-7-5.3-7-9.7V6l7-2.8Z", "M9.2 12.1 11 14l3.9-4.2"] },
    browser: { label: "Browser Setup", paths: [["circle", { cx: "12", cy: "12", r: "8.5" }], "M3.8 12h16.4M12 3.5c-2.2 2.3-3.4 5.2-3.4 8.5s1.2 6.2 3.4 8.5c2.2-2.3 3.4-5.2 3.4-8.5S14.2 5.8 12 3.5Z"] },
    theme: { label: "Appearance", className: "theme-mode-icon", paths: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { class: "theme-fill", d: "M12 3.5a8.5 8.5 0 0 0 0 17Z" }], ["circle", { class: "theme-full", cx: "12", cy: "12", r: "8.5" }], ["circle", { class: "theme-ring", cx: "12", cy: "12", r: "11" }]] },
    tabdock: { label: "Dock Slide", className: "tab-dock-mode-icon", paths: [["rect", { x: "3", y: "7.5", width: "18", height: "9", rx: "4.5" }], "M8.5 12h7m-2.3-2.2 2.3 2.2-2.3 2.2"] }
  };
  if (!utilityModes.includes(state.utilityMode)) state.utilityMode = "bookmarks";

  function slotTabs() {
    return gBrowser.tabs.filter((tab) => !tab.hidden && !tab.closing);
  }

  function slotIndex(tab) {
    return slotTabs().indexOf(tab);
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
  const auraWrap = h("div", { id: "still-tab-aura-wrap", "aria-hidden": "true" }, h("div", { id: "still-tab-aura" }));
  const chrome = h("div", { id: "still-chrome", role: "banner", "aria-label": "Still controls" }, auraWrap, slotRow, topControls, utilityPanel);

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
      element.style.setProperty("--enter-delay", `${Math.min(190, Math.round(distance / 4.4))}ms`);
      element.style.setProperty("--entry-x", `${Math.max(-18, Math.min(18, (cursorX - center) / 24))}px`);
    }
    chrome.classList.add("open");
  }

  function chromeBusy() {
    return state.editingTab || state.draggedTab || chrome.matches(":hover") || !utilityPanel.hidden || !agentPanel.hidden;
  }

  function scheduleChromeHide(delay = 300) {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
      if (state.editingTab || state.draggedTab || chrome.matches(":hover")) return;
      hideUtilityPanel();
      hideAgentPanel();
      if (chrome.contains(document.activeElement)) document.activeElement.blur();
      chrome.classList.remove("open");
    }, delay);
  }

  reveal.addEventListener("mouseenter", (event) => showChrome(event.clientX / window.innerWidth));

  // Like the Electron build: watch the cursor itself. The top few pixels of
  // a window belong to Windows' resize border, so a hover zone alone misses.
  // Polling is a single cheap system call every 40 ms.
  state.revealTimer = setInterval(() => {
    if (document.hidden || state.starting) return;
    const cursor = lazy.StillShared.cursorInWindow(window);
    if (!cursor) return;
    const scale = window.devicePixelRatio || 1;
    const fromTop = cursor.y / scale;
    const inside = cursor.x >= 0 && cursor.x < cursor.width && fromTop >= -2
      && fromTop <= (revealOpen ? 81 : 18);
    if (inside && !revealOpen) {
      revealOpen = true;
      showChrome(cursor.x / cursor.width);
    } else if (!inside && revealOpen) {
      revealOpen = false;
      if (!chromeBusy()) scheduleChromeHide();
    }
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
    pill.append(icon, title, close, h("span", { class: "slot-drop-hint", "aria-hidden": "true" }));
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
    pill.addEventListener("pointerenter", () => auraHover(pill, true));
    pill.addEventListener("pointerleave", () => auraHover(pill, false));
    pill.addEventListener("pointerdown", (event) => { if (event.button === 0 && !event.target.closest("button")) auraPress(pill); });
    pill.addEventListener("keydown", (event) => { if (!event.repeat && event.target === pill && (event.key === "Enter" || event.key === " ")) auraPress(pill); });
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
    pill.append(label);
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
    for (let index = 0; index < SLOT_COUNT; index++) {
      const tab = tabs[index];
      if (tab) {
        let pill = pills.get(tab);
        if (!pill) { pill = buildPill(tab); pills.set(tab, pill); }
        updatePill(pill, tab, index);
        nodes.push(pill);
      } else {
        const pill = emptyPill(index);
        pill.querySelector(".slot-empty-label").textContent = `+ Slot ${index + 1}`;
        pill.setAttribute("aria-label", `Open slot ${index + 1}`);
        nodes.push(pill);
      }
    }
    nodes.forEach((node, index) => {
      if (slotRow.children[index] !== node) slotRow.insertBefore(node, slotRow.children[index] || null);
    });
    while (slotRow.children.length > SLOT_COUNT) slotRow.lastElementChild.remove();
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
  // Slots are picked up with the pointer. After a few pixels the slot lifts,
  // follows the pointer one to one and leans into its motion, while the
  // others slide aside on springs to open the place where it will land.
  // Letting go drops it there from wherever it is, keeping its speed, so the
  // motion never restarts. Escape puts it back. Ctrl+Shift+Left and Right
  // move the focused slot without dragging.

  const REORDER_THRESHOLD = 5;
  const ROOM_SPRING = { omega: 30, zeta: 0.86 };   // slots making room
  const DROP_SPRING = { omega: 24, zeta: 0.8 };    // a slot settling after release
  const LEAN_SPRING = { omega: 22, zeta: 0.9 };
  const slotMotion = new Map();                    // pill -> spring state
  let reorder = null;
  let motionFrame = 0;
  let motionAt = 0;
  const slotLive = h("span", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  layer.append(slotLive);

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

  function motionOf(pill) {
    let m = slotMotion.get(pill);
    if (!m) {
      const title = pill.querySelector(".slot-title");
      m = { x: 0, v: 0, target: 0, y: 0, vy: 0, rot: 0, vr: 0, lean: 0, held: false, spring: ROOM_SPRING,
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
      motionOf(reorder.pill).lean = instant ? 0 : clamp(reorder.velocity / 300, -3, 3);
    }
    for (const [pill, m] of slotMotion) {
      if (instant) {
        if (!m.held) { m.x = m.target; m.y = 0; }
        m.v = m.vy = m.vr = m.rot = 0;
      } else {
        // Small fixed steps keep the springs stable on slow frames.
        let left = elapsed;
        while (left > 0) {
          const dt = Math.min(left, 1 / 240);
          left -= dt;
          if (!m.held) {
            [m.x, m.v] = springStep(m.x, m.v, m.target, m.spring, dt);
            [m.y, m.vy] = springStep(m.y, m.vy, 0, m.spring, dt);
          }
          [m.rot, m.vr] = springStep(m.rot, m.vr, m.held ? m.lean : 0, LEAN_SPRING, dt);
        }
      }
      const settled = !m.held && Math.abs(m.x - m.target) < 0.3 && Math.abs(m.v) < 8
        && Math.abs(m.y) < 0.3 && Math.abs(m.vy) < 8 && Math.abs(m.rot) < 0.05 && Math.abs(m.vr) < 1;
      if (settled && !m.target) {
        pill.style.removeProperty("translate");
        pill.style.removeProperty("rotate");
        slotMotion.delete(pill);
        continue;
      }
      if (settled) { m.x = m.target; m.v = 0; }
      pill.style.translate = `${m.x.toFixed(2)}px ${m.y.toFixed(2)}px`;
      pill.style.rotate = `${m.rot.toFixed(3)}deg`;
      // The light seen through each slot's glass follows the slot.
      pill.style.setProperty("--pill-x", `${m.left + m.x}px`);
      pill.querySelector(".slot-title")?.style.setProperty("--title-x", `${m.left + m.x + m.titleLeft}px`);
    }
    auraFollowMotion();
    const busy = [...slotMotion.values()].some((m) => m.held || m.x !== m.target || m.v || m.y || m.rot);
    if (busy) motionFrame = window.requestAnimationFrame(stepMotion);
    else if (!reorder?.active && !dropPreview) settleMotion();
  }

  // The current slot's light rides along while its slot is moving.
  function auraFollowMotion() {
    const pill = pills.get(gBrowser.selectedTab);
    const m = pill && slotMotion.get(pill);
    if (!m) return;
    aura.animation?.cancel();
    aura.animation = null;
    aura.index = slotTabs().indexOf(gBrowser.selectedTab);
    chrome.style.setProperty("--still-aura-x", `${m.left + m.x}px`);
  }

  function settleMotion() {
    for (const [pill] of slotMotion) {
      pill.style.removeProperty("translate");
      pill.style.removeProperty("rotate");
    }
    slotMotion.clear();
    slotRow.classList.remove("reordering");
    placeShimmerAnchors();
    if (aura.index >= 0) auraMove(aura.index, true, true);
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

  function attachReorder(pill) {
    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || reorder || dropPreview || event.target.closest("button, input, form")
          || state.editingTab === pill.stillTab || slotTabs().length < 2) return;
      reorder = { pill, tab: pill.stillTab, id: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
      try { pill.setPointerCapture(event.pointerId); } catch {}
    });
    pill.addEventListener("pointermove", (event) => {
      if (reorder?.pill !== pill || event.pointerId !== reorder.id) return;
      if (!reorder.active) {
        if (Math.hypot(event.clientX - reorder.startX, event.clientY - reorder.startY) < REORDER_THRESHOLD) return;
        beginReorder(event);
      }
      dragReorder(event);
    });
    const end = (event, cancel) => {
      if (reorder?.pill === pill && event.pointerId === reorder.id) finishReorder({ cancel });
    };
    pill.addEventListener("pointerup", (event) => end(event, false));
    pill.addEventListener("pointercancel", (event) => end(event, true));
    pill.addEventListener("lostpointercapture", (event) => end(event, false));
  }

  function beginReorder(event) {
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
    m.v = m.vy = 0;
    // A slot caught while it is still settling continues from where it is.
    r.baseX = m.x - (event.clientX - r.startX);
    r.baseY = m.y - (event.clientY - r.startY);
    r.lastX = event.clientX;
    r.lastAt = performance.now();
    r.velocity = 0;
    state.draggedTab = r.tab;
    finishEdit({ animate: false });
    showChrome();
    clearTimeout(state.hideTimer);
    slotRow.classList.add("reordering");
    r.pill.classList.add("lifted");
  }

  function dragReorder(event) {
    const r = reorder;
    const m = motionOf(r.pill);
    const now = performance.now();
    const dt = Math.max(4, now - r.lastAt);
    r.velocity = r.velocity * 0.55 + ((event.clientX - r.lastX) / dt * 1000) * 0.45;
    r.lastX = event.clientX;
    r.lastAt = now;
    const min = r.lefts[0] - r.lefts[r.from];
    const max = r.lefts[r.lefts.length - 1] - r.lefts[r.from];
    m.x = rubber(r.baseX + event.clientX - r.startX, min, max);
    // Vertical movement is allowed a little, so the slot reads as picked up.
    m.y = rubber((r.baseY + event.clientY - r.startY) * 0.35, -4, 8, 10);
    m.lean = animationsAllowed() ? clamp(r.velocity / 300, -3, 3) : 0;
    const to = clamp(Math.round((r.lefts[r.from] + m.x - r.lefts[0]) / r.step), 0, r.list.length - 1);
    if (to !== r.to) {
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

  // The click that ends a drag must not also switch to the slot.
  function swallowNextClick() {
    const swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
  }

  function finishReorder({ cancel = false } = {}) {
    const r = reorder;
    reorder = null;
    if (!r) return;
    try { r.pill.releasePointerCapture(r.id); } catch {}
    if (!r.active) return;
    swallowNextClick();
    state.draggedTab = null;
    r.pill.classList.remove("lifted");
    const m = motionOf(r.pill);
    m.held = false;
    m.spring = DROP_SPRING;
    m.v = cancel ? 0 : clamp(r.velocity, -2400, 2400);
    m.vy = 0;
    const tabs = slotTabs();
    const to = cancel ? r.from : r.to;
    const target = tabs[to];
    if (to !== r.from && target && target !== r.tab && tabs.includes(r.tab)) {
      const visual = visualLefts();
      gBrowser.moveTabTo(r.tab, { tabIndex: tabPos(target), forceUngrouped: true });
      aura.index = slotTabs().indexOf(gBrowser.selectedTab);
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
    const agentTab = state.draggingAgentTab;
    if (tabs.length >= SLOT_COUNT) return { kind, index, tab, mode: "replace", hint: "Replace" };
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
      pill.animate([{ opacity: 0.55, scale: ".94" }, { opacity: 1, scale: "1" }], { duration: 280, easing: "cubic-bezier(.23, 1, .32, 1)", composite: "add" });
    }
    kickMotion();
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
    aura.index = slotTabs().indexOf(gBrowser.selectedTab);
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
    if (tabs.length >= SLOT_COUNT) {
      const home = tabs.find(isHomeTab);
      if (home) {
        activate(home, direction);
        if (url) navigateWithSlide(home, url);
        else if (edit) focusStartPage(home);
        return home;
      }
      showChrome();
      showToast("All five slots are in use. Close one before opening another page.");
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

  // The switch shimmer. The current slot keeps a calm lit fill (CSS). When
  // the selection moves, a band of light sweeps across the slots from the
  // old one to the new one, over their surfaces and text, like the shimmer
  // on text while a chat assistant thinks. The band rides the page strip's
  // spring (same samples, same duration), so it speeds up, carries momentum
  // through fast Ctrl+wheel spins and arrives with the page.
  //
  // Each slot draws the band itself (::after) from two row-level values,
  // so it follows the slots exactly, even while they slide in.
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

  // ------------------------------------------------------------ tab aura
  // Ported from Still's native build (aura.js, "bubbly tabs"): one light
  // travels behind the tabs to the selected one, overshooting a little and
  // swelling on the way, and the tab it lands on gets a soft, area-keeping
  // squish. Tabs also squish on hover and press. The light's position and
  // shape live on #still-chrome as --still-aura-* values, read by the layer
  // behind the row and by each tab (the light seen through its glass).
  const AURA_DURATION = 560;
  const aura = { index: -1, animation: null, pillAnimation: null, pill: null, hovers: new Map(), presses: new Map() };
  const auraReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  function auraState() {
    const style = window.getComputedStyle(chrome);
    const read = (name, fallback) => {
      const value = parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    return { x: read("--still-aura-x", NaN), sx: read("--still-aura-sx", 1), sy: read("--still-aura-sy", 1) };
  }

  function auraSet(x, width) {
    chrome.style.setProperty("--still-aura-x", `${x}px`);
    chrome.style.setProperty("--still-aura-w", `${width}px`);
    chrome.style.setProperty("--still-aura-sx", "1");
    chrome.style.setProperty("--still-aura-sy", "1");
    chrome.style.setProperty("--still-aura-o", ".82");
  }

  function auraMove(index, instant = false, layout = false) {
    const list = slotTabs().map((tab) => pills.get(tab));
    const button = list[index];
    if (!button?.isConnected || (index === aura.index && !layout)) return;
    if (!button.offsetWidth) return;
    auraWrap.style.left = `${slotRow.offsetLeft}px`;
    auraWrap.style.top = `${slotRow.offsetTop}px`;
    auraWrap.style.width = `${slotRow.offsetWidth}px`;
    const old = aura.index;
    const current = auraState();
    const from = old < 0 || !Number.isFinite(current.x) ? button.offsetLeft : current.x;
    aura.animation?.cancel();
    aura.animation = null;
    auraReleasePill();
    aura.index = index;
    const x = button.offsetLeft;
    auraSet(x, button.offsetWidth);
    if (instant || old < 0 || auraReduced.matches || !animationsAllowed()) return;
    const overshoot = Math.sign(x - from) * Math.min(8, Math.abs(x - from) * 0.025);
    const animation = chrome.animate([
      { "--still-aura-x": `${from}px`, "--still-aura-sx": String(current.sx || 1), "--still-aura-sy": String(current.sy || 1), "--still-aura-o": ".82", easing: "cubic-bezier(.22,.7,.25,1)" },
      { offset: 0.76, "--still-aura-x": `${x + overshoot}px`, "--still-aura-sx": "1.035", "--still-aura-sy": "1.12", "--still-aura-o": "1", easing: "cubic-bezier(.2,0,.2,1)" },
      { "--still-aura-x": `${x}px`, "--still-aura-sx": "1", "--still-aura-sy": "1", "--still-aura-o": ".82" }
    ], { duration: AURA_DURATION, fill: "both" });
    aura.animation = animation;
    auraBounce(button);
    animation.onfinish = () => {
      if (aura.animation !== animation) return;
      animation.cancel();
      aura.animation = null;
    };
  }

  // Area-preserving squish: wider and shorter, then back, with a tiny hop.
  // Tab motion lives on the separate scale/translate properties, never on
  // `transform`: that one belongs to the bar's slide-in transition, and
  // stacking animations on it left tabs painted half-slid off the top.
  // Both squishes are additive, so a press and a hover multiply together.
  function auraImpulse(pill) {
    const frames = [];
    for (let step = 0; step <= 60; step++) {
      const t = step / 60;
      const deformation = step === 60 ? 0 : -0.05 * Math.exp(-4.6 * t) * Math.sin(11 * t);
      const x = 1 + deformation;
      frames.push({ offset: t, scale: `${x} ${1 / x}`, translate: `0 ${-deformation * 28}px` });
    }
    return pill.animate(frames, { duration: AURA_DURATION, easing: "linear", fill: "both", composite: "add" });
  }

  function auraBounce(pill) {
    aura.pill = pill;
    const animation = auraImpulse(pill);
    aura.pillAnimation = animation;
    animation.onfinish = () => { if (aura.pillAnimation === animation) auraReleasePill(); };
  }

  function auraReleasePill() {
    aura.pillAnimation?.cancel();
    aura.pillAnimation = null;
    aura.pill = null;
  }

  function auraPress(pill) {
    aura.presses.get(pill)?.cancel();
    aura.presses.delete(pill);
    if (auraReduced.matches || !animationsAllowed()) return;
    const animation = auraImpulse(pill);
    aura.presses.set(pill, animation);
    animation.onfinish = () => {
      if (aura.presses.get(pill) !== animation) return;
      animation.cancel();
      aura.presses.delete(pill);
    };
  }

  // Hover: the tab grows a little (more in height) on a soft spring with a
  // squash; leaving springs it back.
  function auraHover(pill, entered) {
    const previous = aura.hovers.get(pill);
    if (previous?.entered === entered) return;
    let cx = 1, cy = 1;
    if (previous?.animation) {
      const timing = previous.animation.effect.getComputedTiming();
      const frame = previous.frames[Math.round((timing.progress ?? 1) * 60)] || previous.frames[60];
      cx = frame.sx; cy = frame.sy;
      previous.animation.cancel();
    } else if (previous?.entered) { cx = 1.018; cy = 1.075; }
    const x = entered ? 1.018 : 1, y = entered ? 1.075 : 1;
    const state = { entered, animation: null, frames: [] };
    aura.hovers.set(pill, state);
    if (auraReduced.matches || !animationsAllowed()) {
      if (entered) {
        state.frames = [{ sx: x, sy: y }];
        state.animation = pill.animate([{ scale: `${x} ${y}` }], { duration: 0, fill: "forwards", composite: "add" });
        state.animation.persist();
      } else aura.hovers.delete(pill);
      return;
    }
    for (let step = 0; step <= 60; step++) {
      const t = step / 60;
      const progress = step === 60 ? 1 : 1 - Math.exp(-6 * t) * (Math.cos(10 * t) + 0.6 * Math.sin(10 * t));
      const squash = step === 60 ? 0 : (entered ? -0.038 : 0.025) * Math.exp(-5 * t) * Math.sin(12 * t);
      let sx = (cx + (x - cx) * progress) * (1 + squash);
      let sy = (cy + (y - cy) * progress) / (1 + squash);
      // Never shrink an entering tab below rest or grow a leaving one again.
      if (entered) { sx = Math.max(1, sx); sy = Math.max(1, sy); }
      else { sx = Math.min(cx, sx); sy = Math.min(cy, sy); }
      state.frames.push({ sx, sy });
    }
    const animation = pill.animate(state.frames.map(({ sx, sy }, k) => ({ offset: k / 60, scale: `${sx} ${sy}` })),
      { duration: entered ? 560 : 640, easing: "linear", fill: "forwards", composite: "add" });
    state.animation = animation;
    // A press squish on the same property would otherwise let Firefox drop
    // the finished hover and snap the tab back to rest while still hovered.
    if (entered) animation.persist();
    if (!entered) animation.onfinish = () => {
      if (aura.hovers.get(pill) !== state) return;
      animation.cancel();
      aura.hovers.delete(pill);
    };
  }

  function auraSettle() {
    auraMove(aura.index, true, true);
    for (const [pill, state] of aura.hovers) { state.animation?.cancel(); if (!state.entered) aura.hovers.delete(pill); }
    for (const [, animation] of aura.presses) animation.cancel();
    aura.presses.clear();
  }

  // Keep the light on the selected tab (instantly when nothing animates).
  function auraSync() {
    const index = slotTabs().indexOf(gBrowser.selectedTab);
    if (index < 0) return;
    if (aura.index < 0) auraMove(index, true, true);
    else if (index !== aura.index) auraMove(index);
  }
  // Only a real change of the row's width re-places the light (opening the
  // bar also reports a resize, which must not cut a running move short).
  let auraRowWidth = 0;
  new ResizeObserver(() => {
    const width = slotRow.offsetWidth;
    if (!width || width === auraRowWidth) return;
    auraRowWidth = width;
    if (aura.index >= 0) auraMove(aura.index, true, true);
  }).observe(slotRow);
  auraReduced.addEventListener("change", auraSettle);
  window.addEventListener("deactivate", auraSettle);

  function glideShimmer(samples) {
    auraMove(Math.round(samples[samples.length - 1]));
  }

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
      if (tabs.length < SLOT_COUNT) armNewSlotEdge();
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

  function runUtility() {
    const mode = state.utilityMode;
    if (!utilityPanel.hidden && utilityPanel.dataset.mode === mode) { hideUtilityPanel(); return; }
    hideUtilityPanel();
    const failed = (what) => (error) => {
      console.error(error);
      if (!utilityPanel.hidden) utilityPanel.append(emptyNote(`Could not load ${what}. Close this panel and try again.`));
    };
    if (mode === "bookmarks") renderBookmarks().catch(failed("bookmarks"));
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
    const direction = event.deltaY > 0 ? 1 : -1;
    const current = Math.max(0, utilityModes.indexOf(state.utilityMode));
    state.utilityMode = utilityModes[(current + direction + utilityModes.length) % utilityModes.length];
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
  // small icons beside the agent mark, listed in the agent panel, and moved
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
  // - In a hidden agent tab, that tab's icon beside the mark is ringed.
  // - The panel keeps a live list of recent steps, with where each happened.

  const AGENT_KEY = "still-agent";
  const AGENT_WORKING_MS = 2500;   // a step counts as current this long
  const AGENT_POINTER_REST_MS = 2600;
  const AGENT_LOG_MAX = 40;
  state.agentOpening = 0;
  const agentState = { clients: [], engine: false, activity: null, idleTimer: 0, log: [], nextStep: 1, pointerTimer: 0, narrateTimer: 0, clockTimer: 0 };
  const agentPanel = h("div", { class: "utility-panel agent-panel", hidden: true, role: "dialog", "aria-label": "Agent access" });
  const agentLive = h("span", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const agentEdge = h("div", { id: "still-agent-edge", "aria-hidden": "true" });
  const agentChips = h("span", { class: "agent-chips", "aria-hidden": "true" });
  agentButton.append(agentChips);
  const agentSteps = h("ol", { class: "agent-steps", "aria-label": "Recent agent steps" });
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
  chrome.append(agentPanel);
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
    try { SessionStore.setCustomTabValue(tab, AGENT_KEY, "1"); } catch {}
    // Hidden once Firefox has finished adding it.
    Promise.resolve().then(() => {
      if (!tab.closing && !tab.selected) gBrowser.hideTab(tab);
      renderAgentChips();
      if (!agentPanel.hidden) renderAgentPanel();
    });
  }

  function openAgentTab(url, { visible = false } = {}) {
    state.agentOpening++;
    let tab;
    try {
      tab = gBrowser.addTrustedTab(url || "about:blank", { inBackground: true });
    } finally {
      state.agentOpening--;
    }
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
    if (tabs.length <= SLOT_COUNT) { activate(tab); return; }
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

  const stepNodes = new Map();   // step id -> row
  function stepRow(step) {
    const tab = tabByBrowserId(step.tab);
    const glyph = tab ? faviconFor(tab, "slot-favicon agent-step-favicon")
      : h("span", { class: "slot-favicon agent-step-favicon placeholder" }, icon([["path", { class: "agent-star", d: starPath }]]));
    const row = h("li", { class: "agent-step" },
      glyph,
      h("span", { class: "agent-step-copy" },
        h("span", { class: "agent-step-text" }),
        h("small", { class: "agent-step-place" })),
      h("time", { class: "agent-step-time" }));
    row.stillStep = step;
    return row;
  }

  function updateStepRow(row) {
    const step = row.stillStep;
    const text = stepText(step);
    const textNode = row.querySelector(".agent-step-text");
    if (textNode.textContent !== text) textNode.textContent = text;
    const place = stepPlace(step);
    const placeNode = row.querySelector(".agent-step-place");
    if (placeNode.textContent !== place) placeNode.textContent = place;
    const time = ago(step.at);
    const timeNode = row.querySelector(".agent-step-time");
    if (timeNode.textContent !== time) timeNode.textContent = time;
    row.classList.toggle("current", step === agentState.log[0] && Date.now() - step.at < AGENT_WORKING_MS);
  }

  // Rows are kept by identity: new steps slide in at the top, and the rows
  // already there move down instead of being rebuilt.
  function renderSteps({ animate = true } = {}) {
    const steps = agentState.log;
    const keep = new Set(steps.map((step) => step.id));
    for (const [id, row] of stepNodes) if (!keep.has(id)) { row.remove(); stepNodes.delete(id); }
    const before = animate && animationsAllowed() ? new Map([...stepNodes.values()].map((row) => [row, row.offsetTop])) : null;
    const fresh = [];
    steps.forEach((step, index) => {
      let row = stepNodes.get(step.id);
      if (!row) { row = stepRow(step); stepNodes.set(step.id, row); fresh.push(row); }
      if (agentSteps.children[index] !== row) agentSteps.insertBefore(row, agentSteps.children[index] || null);
      updateStepRow(row);
    });
    if (!before) return;
    for (const row of fresh) {
      row.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
        { duration: 200, easing: "cubic-bezier(0, 0, .58, 1)" });
    }
    for (const [row, top] of before) {
      const dy = top - row.offsetTop;
      if (dy) row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.77, 0, .175, 1)" });
    }
  }

  function agentTabRow(tab) {
    const working = tab === agentWorkingTab();
    const row = h("div", { class: `agent-tab-row${working ? " working" : ""}`, draggable: "true",
      title: "Drag into the slots, or click to show it in a slot" });
    const open = h("div", { role: "button", tabindex: "0", class: "agent-tab-open" },
      h("span", { class: "agent-tab-icon" }, faviconFor(tab, "slot-favicon agent-tab-favicon")),
      h("span", { class: "agent-tab-copy" },
        h("strong", { text: slotTitle(tab) }),
        h("small", { text: displayUrl(tabUrl(tab)) || "New tab" })));
    const show = () => { hideAgentPanel(); showAgentTab(tab); };
    open.addEventListener("click", show);
    open.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(); }
    });
    const close = h("button", { type: "button", class: "agent-tab-close", title: "Close", "aria-label": `Close ${slotTitle(tab)}` }, closeGlyph());
    close.addEventListener("click", () => { gBrowser.removeTab(tab, { animate: false }); renderAgentPanel(); renderAgentChips(); });
    row.addEventListener("dragstart", (event) => {
      if (event.target.closest(".agent-tab-close")) { event.preventDefault(); return; }
      event.dataTransfer.setData(AGENT_TAB_TYPE, String(tab.linkedBrowser.browserId));
      event.dataTransfer.effectAllowed = "move";
      state.draggingAgentTab = tab;
      row.classList.add("dragging");
      showChrome();
    });
    row.addEventListener("dragend", () => {
      state.draggingAgentTab = null;
      row.classList.remove("dragging");
      clearDropPreview();
      if (!agentPanel.hidden) renderAgentPanel();
    });
    row.append(open, close);
    return row;
  }

  function renderAgentPanel() {
    const names = agentNames();
    const many = new Set(agentState.clients).size > 1;
    const tabs = agentTabs();
    const working = Boolean(agentWorkingTab());
    const stop = h("button", { type: "button", class: "agent-stop", text: "Stop agent access" });
    stop.addEventListener("click", () => {
      hideAgentPanel();
      lazy.StillAgent.disconnectAll().catch(console.error);
      showToast("Agent access stopped. Agents can connect again when you start one.");
    });
    renderSteps({ animate: false });
    agentPanel.replaceChildren(
      h("div", { class: `agent-panel-head${working ? " working" : ""}` },
        h("strong", { text: `${names} ${many ? "are" : "is"} using Still` }),
        h("small", { class: "agent-panel-status" },
          h("span", { class: "agent-status-light", "aria-hidden": "true" }),
          h("span", { class: "agent-status-text", text: agentStatusText() }))),
      h("div", { class: "utility-panel-heading", text: tabs.length ? "Agent tabs" : "No agent tabs" }),
      tabs.length ? h("div", { class: "agent-tab-list" }, ...tabs.map(agentTabRow))
        : h("p", { class: "agent-panel-note", text: "Pages the agent opens wait here, outside your five slots. It can also work in your slots when you ask." }),
      agentState.log.length ? h("div", { class: "utility-panel-heading", text: "Steps" }) : null,
      agentState.log.length ? agentSteps : null,
      stop);
  }

  // Only what changed while the panel is open: status, current tab, steps.
  function refreshAgentPanel() {
    if (agentPanel.hidden) return;
    const working = agentWorkingTab();
    agentPanel.querySelector(".agent-panel-head")?.classList.toggle("working", Boolean(working));
    const status = agentPanel.querySelector(".agent-status-text");
    if (status) status.textContent = agentStatusText();
    if (!agentSteps.isConnected && agentState.log.length) { renderAgentPanel(); return; }
    renderSteps();
  }

  function showAgentPanel({ keyboard = false } = {}) {
    hideUtilityPanel();
    renderAgentPanel();
    agentPanel.hidden = false;
    agentButton.setAttribute("aria-expanded", "true");
    agentButton.classList.add("panel-open");
    clearInterval(agentState.clockTimer);
    agentState.clockTimer = setInterval(() => {
      for (const row of stepNodes.values()) updateStepRow(row);
      const status = agentPanel.querySelector(".agent-status-text");
      if (status) status.textContent = agentStatusText();
    }, 5000);
    if (keyboard) agentPanel.querySelector("button, [role=button]")?.focus({ preventScroll: true });
  }

  function hideAgentPanel() {
    if (agentPanel.hidden) return;
    agentPanel.hidden = true;
    clearInterval(agentState.clockTimer);
    agentButton.setAttribute("aria-expanded", "false");
    agentButton.classList.remove("panel-open");
  }

  agentButton.addEventListener("click", (event) => {
    if (agentPanel.hidden) showAgentPanel({ keyboard: event.detail === 0 });
    else hideAgentPanel();
  });
  agentPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); hideAgentPanel(); agentButton.focus(); }
  });

  // The agent's tabs as small icons beside its mark; the one it is working
  // in carries a ring. Up to three, then a count.
  function renderAgentChips() {
    const tabs = agentTabs();
    const working = agentWorkingTab();
    const shown = tabs.slice(-3);
    const key = shown.map((tab) => `${tab.linkedBrowser.browserId}:${tab.getAttribute("image") || ""}:${slotTitle(tab).charAt(0)}`).join("|") + `+${tabs.length}`;
    if (agentChips.dataset.key !== key) {
      const old = new Map([...agentChips.children].map((node) => [node.dataset.id, node]));
      const nodes = shown.map((tab) => {
        const id = String(tab.linkedBrowser.browserId);
        const existing = old.get(id);
        if (existing && existing.dataset.image === (tab.getAttribute("image") || "")) return existing;
        const chip = h("span", { class: "agent-chip" }, faviconFor(tab, "slot-favicon agent-chip-favicon"));
        chip.dataset.id = id;
        chip.dataset.image = tab.getAttribute("image") || "";
        if (animationsAllowed() && !agentButton.hidden) {
          chip.animate([{ opacity: 0, scale: ".5" }, { opacity: 1, scale: "1" }], { duration: 260, easing: "cubic-bezier(.34, 1.56, .64, 1)" });
        }
        return chip;
      });
      if (tabs.length > shown.length) nodes.unshift(h("span", { class: "agent-chip-more", text: `+${tabs.length - shown.length}` }));
      agentChips.replaceChildren(...nodes);
      agentChips.dataset.key = key;
      agentButton.classList.toggle("has-tabs", tabs.length > 0);
    }
    for (const chip of agentChips.querySelectorAll(".agent-chip")) {
      chip.classList.toggle("working", Boolean(working) && chip.dataset.id === String(working.linkedBrowser.browserId));
    }
  }

  // While the agent works the mark turns; when it stops, the turn eases on
  // to the next resting angle instead of snapping back.
  const agentGlyph = agentButton.querySelector(".agent-glyph");
  const TURN_MS = 1500;
  let agentTurn = null;
  function startAgentTurn() {
    agentButton.classList.add("working");
    if (agentTurn || !animationsAllowed()) return;
    agentTurn = agentGlyph.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: TURN_MS, iterations: Infinity });
  }
  function settleAgentTurn() {
    agentButton.classList.remove("working");
    const turn = agentTurn;
    agentTurn = null;
    if (!turn) return;
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

  function updateAgent({ clients = [], engine = false, activity } = {}) {
    const before = new Set(agentState.clients);
    agentState.clients = clients;
    agentState.engine = engine;
    const connected = clients.length > 0;
    const arrived = clients.filter((name) => !before.has(name));
    agentButton.hidden = !connected;
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
      if (before.size) agentLive.textContent = "Agent disconnected";
    }
    if (activity?.label) {
      agentState.activity = { ...activity, at: Date.now() };
      logStep(agentState.activity);
      startAgentTurn();
      const tab = tabByBrowserId(activity.tab);
      const onScreen = agentOnScreen(tab);
      layer.classList.toggle("agent-acting", onScreen);
      if (onScreen && activity.box) aimPointer(tab, activity);
      else if (onScreen) narrateAgent(activity);
      for (const element of slotRow.querySelectorAll(".agent-busy")) element.classList.remove("agent-busy");
      const pill = tab && !onScreen && !tab.hidden ? pills.get(tab) : null;
      pill?.classList.add("agent-busy");
      clearTimeout(agentState.idleTimer);
      agentState.idleTimer = setTimeout(() => {
        settleAgentTurn();
        layer.classList.remove("agent-acting");
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
  gBrowser.tabContainer.addEventListener("TabSelect", hideAgentOverlays);
  gBrowser.tabContainer.addEventListener("TabClose", (event) => {
    if (event.target.stillAgent) Promise.resolve().then(renderAgentChips);
  });

  // Agent tabs come back hidden after a restart.
  function restoreAgentTabs() {
    for (const tab of gBrowser.tabs) {
      let marked = "";
      try { marked = SessionStore.getCustomTabValue(tab, AGENT_KEY); } catch {}
      if (marked !== "1") continue;
      tab.stillAgent = true;
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
    replacementList.replaceChildren(...slotTabs().filter((tab) => tab !== newTab).slice(0, SLOT_COUNT).map(replacementRow));
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
    if (state.agentOpening) { adoptAgentTab(tab); return; }
    if (!state.restored || state.bypassLimit || tab.hidden) return;
    const tabs = slotTabs();
    if (tabs.length <= SLOT_COUNT) return;
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
      if (tabs.length >= SLOT_COUNT && !tabs.some(isHomeTab)) options = { ...options, inBackground: true };
    }
    return originalAddTab.call(this, uri, options);
  };

  // Ctrl+T and the new-tab command respect the slot limit up front.
  const originalOpenTab = BrowserCommands.openTab.bind(BrowserCommands);
  BrowserCommands.openTab = function stillOpenTab(options = {}) {
    if (!options.url && slotTabs().length >= SLOT_COUNT) {
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
    window.setTimeout(queueRender, 0);
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
    if (!event.target.closest?.(".agent-control, .agent-panel")) hideAgentPanel();
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
    showDock,
    moveDock,
    releaseDock,
    state,
    captureBrowser,
    applyTheme,
    replaySplash: () => runSplash({ force: true }),
    runImport,
    slotIndex,
    agent: { update: updateAgent, openTab: openAgentTab, showTab: showAgentTab, tabs: agentTabs, onScreen: agentOnScreen }
  };

  renderSlots();
  runSplash();
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
