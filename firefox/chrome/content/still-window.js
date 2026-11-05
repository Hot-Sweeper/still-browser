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
    Downloads: "resource://gre/modules/Downloads.sys.mjs",
    DownloadUtils: "resource://gre/modules/DownloadUtils.sys.mjs",
    StillShared: "resource://still/StillShared.sys.mjs",
    StillImport: "resource://still/StillImport.sys.mjs",
    MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs"
  });

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
    theme: { label: "Appearance", className: "theme-mode-icon", paths: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { class: "theme-fill", d: "M12 3.5a8.5 8.5 0 0 0 0 17Z" }]] },
    tabdock: { label: "Dock Slide", className: "tab-dock-mode-icon", paths: [["rect", { x: "3", y: "7.5", width: "18", height: "9", rx: "4.5" }], "M8.5 12h7m-2.3-2.2 2.3 2.2-2.3 2.2"] }
  };
  if (!utilityModes.includes(state.utilityMode)) state.utilityMode = "bookmarks";

  function slotTabs() {
    return gBrowser.tabs.filter((tab) => !tab.hidden && !tab.closing);
  }

  function slotIndex(tab) {
    return slotTabs().indexOf(tab);
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
  const minimizeButton = h("button", { class: "top-control", type: "button", title: "Minimize", "aria-label": "Minimize" },
    icon(["M6.5 12h11"], "control-icon"));
  const fullscreenButton = h("button", { class: "top-control", type: "button", title: "Fullscreen", "aria-label": "Fullscreen" },
    icon([["rect", { x: "6.5", y: "6.5", width: "11", height: "11", rx: "2.2" }]], "control-icon"));
  const closeButton = h("button", { class: "top-control danger", type: "button", title: "Close", "aria-label": "Close window" },
    icon(["m7.5 7.5 9 9m0-9-9 9"], "control-icon"));
  const topControls = h("div", { class: "top-controls" }, utilityButton, minimizeButton, fullscreenButton, closeButton);
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
      element.style.setProperty("--enter-delay", `${Math.min(190, Math.round(distance / 4.4))}ms`);
      element.style.setProperty("--entry-x", `${Math.max(-18, Math.min(18, (cursorX - center) / 24))}px`);
    }
    chrome.classList.add("open");
  }

  function chromeBusy() {
    return state.editingTab || state.draggedTab || chrome.matches(":hover") || !utilityPanel.hidden;
  }

  function scheduleChromeHide(delay = 300) {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
      if (state.editingTab || state.draggedTab || chrome.matches(":hover")) return;
      hideUtilityPanel();
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

  // Empty space on the open bar moves the window the way a title bar does
  // (Windows handles the move, so snapping works); double-click maximizes.
  function isBarBackground(target) {
    return target === chrome || target === slotRow || target === topControls;
  }

  chrome.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !isBarBackground(event.target) || event.detail > 1) return;
    if (lazy.StillShared.startWindowMove(window)) event.preventDefault();
  });

  chrome.addEventListener("dblclick", (event) => {
    if (!isBarBackground(event.target)) return;
    if (window.windowState === window.STATE_MAXIMIZED) window.restore();
    else window.maximize();
  });

  // The top band moves the window too, before the bar has slid in.
  reveal.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.detail > 1) return;
    if (lazy.StillShared.startWindowMove(window)) event.preventDefault();
  });
  reveal.addEventListener("dblclick", () => {
    if (window.windowState === window.STATE_MAXIMIZED) window.restore();
    else window.maximize();
  });

  minimizeButton.addEventListener("click", () => window.minimize());
  fullscreenButton.addEventListener("click", () => { window.fullScreen = !window.fullScreen; });
  closeButton.addEventListener("click", () => BrowserCommands.tryToCloseWindow?.() ?? window.close());

  // ------------------------------------------------------------- slot pills

  const pills = new WeakMap();
  const emptyPills = [];

  function faviconFor(tab, className = "slot-favicon") {
    const url = tabUrl(tab);
    if (isHomeUrl(url)) return h("img", { class: `${className} brand-favicon`, src: ICON, alt: "" });
    const image = tab.getAttribute("image");
    const letter = () => h("span", { class: `${className} placeholder`, "aria-hidden": "true",
      text: slotTitle(tab).trim().charAt(0).toLocaleUpperCase() || "·" });
    if (!image) return letter();
    const img = h("img", { class: className, src: image, alt: "" });
    img.addEventListener("error", () => img.replaceWith(letter()), { once: true });
    return img;
  }

  function buildPill(tab) {
    const pill = h("div", { class: "slot", role: "button", tabindex: "0", draggable: "true" });
    pill.stillTab = tab;
    const icon = h("span", { class: "slot-icon" });
    const title = h("span", { class: "slot-title" });
    const close = h("button", { class: "slot-close", type: "button", title: "Close slot" }, closeGlyph());
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSlot(pill.stillTab);
    });
    pill.append(icon, title, close);
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
      if (event.key === "Enter") beginEdit(pill.stillTab);
      else if (event.key === " ") { event.preventDefault(); activate(pill.stillTab); }
    });
    pill.addEventListener("mouseenter", () => warmTab(pill.stillTab));
    attachDrag(pill);
    return pill;
  }

  function closeGlyph() {
    return icon(["m8 8 8 8m0-8-8 8"], "close-icon");
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
    pill.addEventListener("dragover", (event) => {
      if (!state.draggedTab) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    pill.addEventListener("drop", (event) => {
      event.preventDefault();
      if (state.draggedTab) moveSlot(state.draggedTab, slotTabs().length - 1);
    });
    emptyPills[index] = pill;
    return pill;
  }

  function updatePill(pill, tab, index) {
    const active = tab === gBrowser.selectedTab;
    pill.classList.toggle("active", active);
    pill.classList.toggle("loading", tab.hasAttribute("busy"));
    pill.classList.toggle("muted", tab.hasAttribute("muted"));
    pill.classList.toggle("playing", tab.hasAttribute("soundplaying"));
    pill.setAttribute("aria-pressed", String(active));
    const title = slotTitle(tab);
    const label = `Slot ${index + 1}: ${title}`;
    pill.setAttribute("aria-label", label);
    pill.title = `${title}\nDouble-click to search or enter an address`;
    pill.querySelector(".slot-close").setAttribute("aria-label", `Close slot ${index + 1}`);
    const iconHost = pill.querySelector(".slot-icon");
    const iconKey = `${isHomeUrl(tabUrl(tab))}|${tab.getAttribute("image") || ""}|${title.charAt(0)}`;
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
    renderUtilityButton();
    if (state.dock.visible) buildDock();
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    window.requestAnimationFrame(renderSlots);
  }

  // ------------------------------------------------------------- reordering

  function attachDrag(pill) {
    pill.addEventListener("dragstart", (event) => {
      if (event.target.closest("button, input, form") || state.editingTab === pill.stillTab) {
        event.preventDefault();
        return;
      }
      state.draggedTab = pill.stillTab;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/x-still-slot", String(slotIndex(pill.stillTab)));
      pill.classList.add("dragging");
      showChrome();
    });
    pill.addEventListener("dragover", (event) => {
      if (!state.draggedTab || state.draggedTab === pill.stillTab) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      pill.classList.add("drop-target");
    });
    pill.addEventListener("dragleave", () => pill.classList.remove("drop-target"));
    pill.addEventListener("drop", (event) => {
      event.preventDefault();
      const dragged = state.draggedTab;
      state.draggedTab = null;
      if (dragged && dragged !== pill.stillTab) moveSlot(dragged, slotIndex(pill.stillTab));
    });
    pill.addEventListener("dragend", () => {
      state.draggedTab = null;
      for (const node of slotRow.querySelectorAll(".dragging, .drop-target")) node.classList.remove("dragging", "drop-target");
      scheduleChromeHide();
    });
  }

  function moveSlot(tab, targetIndex) {
    const tabs = slotTabs();
    const target = tabs[Math.max(0, Math.min(tabs.length - 1, targetIndex))];
    if (!target || target === tab) return;
    const before = new Map([...slotRow.children].map((node) => [node, node.getBoundingClientRect()]));
    gBrowser.moveTabTo(tab, { tabIndex: target._tPos, forceUngrouped: true });
    renderSlots();
    if (!animationsAllowed()) return;
    for (const node of slotRow.children) {
      const old = before.get(node);
      if (!old) continue;
      const now = node.getBoundingClientRect();
      const dx = old.left - now.left;
      if (!dx) continue;
      node.animate([
        { transform: `translateX(${dx}px) scale(.965)`, filter: "brightness(1.18)" },
        { transform: "translateX(0) scale(1)", filter: "brightness(1)" }
      ], { duration: 430, easing: EASE });
    }
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
    pill.draggable = false;
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
    const width = Math.min(Math.max(box.width, 520), chrome.clientWidth - 28);
    const left = Math.max(14, Math.min(box.x, chrome.clientWidth - width - 14));
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
      pill.draggable = true;
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

  function glideShimmer(samples, duration) {
    const pillsInOrder = slotTabs().map((tab) => pills.get(tab));
    if (!pillsInOrder.length || pillsInOrder.some((pill) => !pill?.isConnected)) return;
    const running = slotRow.getAnimations().find((animation) => animation.id === "still-shimmer");
    running?.cancel();
    if (!chrome.classList.contains("open") || !animationsAllowed()) return;
    placeShimmerAnchors();
    const centers = pillsInOrder.map((pill) => pill.offsetLeft + pill.offsetWidth / 2);
    const last = samples.length - 1;
    // Fades in fast (or not at all when it was already sweeping), and
    // dissolves into the new slot as it closes in: brightness follows the
    // distance still to travel, so it never lingers while settling.
    const target = samples[last];
    const frames = samples.map((x, k) => {
      const p = k / last;
      const rise = running ? 1 : Math.min(1, p / 0.1);
      const d = Math.min(1, Math.abs(target - x) / 0.4);
      const near = d * d * (3 - 2 * d);
      return { "--still-shimmer-x": `${shimmerCenterAt(x, centers).toFixed(1)}px`, "--still-shimmer-alpha": (rise * near).toFixed(3), offset: p };
    });
    // A comet: bright leading edge, soft tail behind, facing the way it goes.
    const direction = Math.sign(target - samples[0]) || 1;
    slotRow.style.setProperty("--still-shimmer-angle", direction > 0 ? "90deg" : "270deg");
    slotRow.style.setProperty("--still-shimmer-peak", direction > 0 ? "0.8" : "0.2");
    const sweep = slotRow.animate(frames, { duration: duration * 1000, easing: "linear" });
    sweep.id = "still-shimmer";
    // The new slot answers with a short soft light on its edge the moment
    // the band arrives (close enough that it has started to dissolve).
    clearTimeout(state.landTimer);
    const arrive = samples.findIndex((x) => Math.abs(target - x) < 0.18);
    const landTab = slotTabs()[Math.round(target)];
    state.landTimer = setTimeout(() => {
      const pill = pills.get(landTab);
      if (!pill || landTab !== gBrowser.selectedTab) return;
      pill.classList.remove("landed");
      void pill.offsetWidth;
      pill.classList.add("landed");
    }, Math.max(0, arrive) / last * duration * 1000);
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

  const themes = ["system", "light", "dark"];
  function applyTheme(theme) {
    if (theme === "system") {
      Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
      Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", 2);
    } else {
      Services.prefs.setIntPref("ui.systemUsesDarkTheme", theme === "dark" ? 1 : 0);
      Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", theme === "dark" ? 0 : 1);
    }
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
      showToast(`Appearance: ${next === "system" ? "follow Windows" : next}`);
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
      const url = displayUrl(tabUrl(newTab)) || newTab.label || "New page";
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
    const index = replacedTab._tPos;
    const direction = Math.sign(slotIndex(replacedTab) - slotIndex(gBrowser.selectedTab));
    gBrowser.moveTabTo(tab, { tabIndex: index, forceUngrouped: true });
    if (gBrowser.selectedTab === replacedTab || gBrowser.selectedTab !== tab) {
      state.nextDirection = direction;
      gBrowser.selectedTab = tab;
    }
    closeSlot(replacedTab);
  }

  function cancelOverflow() {
    const overflow = state.overflow;
    if (!overflow) return;
    state.overflow = null;
    hideOverflowDialog();
    closeOverflowTab(overflow.tab);
  }

  replacementCancel.addEventListener("click", cancelOverflow);
  replacementBackdrop.addEventListener("pointerdown", (event) => {
    if (event.target === replacementBackdrop) cancelOverflow();
  });

  function handleTabOpen(event) {
    const tab = event.target;
    queueRender();
    if (!state.restored || state.bypassLimit || tab.hidden) return;
    const tabs = slotTabs();
    if (tabs.length <= SLOT_COUNT) return;
    const home = tabs.find((candidate) => candidate !== tab && isHomeTab(candidate));
    if (home) {
      gBrowser.moveTabTo(tab, { tabIndex: home._tPos, forceUngrouped: true });
      const wasSelected = gBrowser.selectedTab === home;
      if (wasSelected) gBrowser.selectedTab = tab;
      gBrowser.removeTab(home, { animate: false });
      return;
    }
    showOverflow(tab);
  }

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
    hideUtilityPanel();
    queueRender();
    window.requestAnimationFrame(placeShimmerAnchors);
  });
  gBrowser.tabContainer.addEventListener("TabClose", (event) => {
    const tab = event.target;
    if (state.overflow?.tab === tab) { state.overflow = null; hideOverflowDialog(); }
    if (state.editingTab === tab) state.editingTab = null;
    if (state.vertical?.tab === tab) finishVertical(true);
    if (state.strip?.panels.includes(panelOf(tab))) finishSlide();
    window.setTimeout(queueRender, 0);
  });

  gBrowser.addTabsProgressListener({
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress.isTopLevel) return;
      if (state.overflow && browser === state.overflow.tab.linkedBrowser) state.overflow.update();
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
    if (!event.target.closest?.(".utility-button, .utility-panel")) hideUtilityPanel();
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
    replaySplash: () => runSplash({ force: true }),
    runImport
  };

  renderSlots();
  runSplash();
  applyTheme(Services.prefs.getStringPref(PREF_THEME, "system"));
  (window.SessionStore?.promiseAllWindowsRestored || Promise.resolve()).then(() => {
    state.restored = true;
    queueRender();
    // Once, when Still has settled and you are not busy with it.
    setTimeout(() => window.requestIdleCallback(() => firstRunImport().catch(console.error), { timeout: 10000 }), 6000);
  });
  lazy.StillShared.attachWindow(window, {
    onPageMessage: (...args) => window.StillChrome.onPageMessage(...args),
    onWheelGesture: (...args) => window.StillChrome.onWheelGesture(...args)
  });
})();
