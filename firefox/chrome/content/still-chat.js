// Still's side chat: a panel on the right where you tell an agent what to do
// on the web, and it does it in Still with your sign-ins (StillChat.sys.mjs
// runs the agent). Loaded after still-window.js into each browser window.
//
// Opening: Ctrl+E, the universal button's "Side chat" mode, or resting the
// pointer at the window's right edge. Closing takes the close button (or
// Ctrl+E again), so it never disappears while you read.
(function stillChat() {
  "use strict";
  if (window.StillChat || !window.StillChrome) return;

  const HTML = "http://www.w3.org/1999/xhtml";
  const SVG = "http://www.w3.org/2000/svg";
  const PREF_AGENT = "still.chat.agent";
  const PREF_WIDTH = "still.chat.width";
  const PREF_EDGE = "still.chat.edgeOpen";
  const PREF_CHOICE = "still.chat.choice.";
  const EDGE_DWELL_MS = 280;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    StillChat: "resource://still/StillChat.sys.mjs",
    StillShared: "resource://still/StillShared.sys.mjs"
  });
  const still = window.StillChrome;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function h(tag, props = {}, ...children) {
    const element = document.createElementNS(HTML, tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? "" : String(value));
    }
    element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return element;
  }

  function icon(paths, className = "") {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    for (const d of paths) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  const ICONS = {
    close: ["m7.5 7.5 9 9m0-9-9 9"],
    plus: ["M12 6.5v11M6.5 12h11"],
    send: ["M12 18.5v-13m-5 5 5-5 5 5"],
    stop: ["M8.5 8.5h7v7h-7z"],
    chevron: ["m8 10 4 4 4-4"],
    check: ["m6.5 12.5 3.5 3.5 7.5-8"],
    cross: ["m8 8 8 8m0-8-8 8"],
    page: ["M7 4.5h7l3.5 3.5v11.5H7z", "M13.5 4.5V8.5h4"],
    link: ["M10 14 14 10", "M9 7.5h-1a4.5 4.5 0 0 0 0 9h1M15 7.5h1a4.5 4.5 0 0 1 0 9h-1"]
  };

  function tabUrl(tab) {
    try { return tab.linkedBrowser.currentURI.spec; } catch { return ""; }
  }

  // ----------------------------------------------------------------- DOM

  const agentLabel = h("span", { class: "chat-agent-name" });
  const agentButton = h("button", { type: "button", class: "chat-agent", "aria-haspopup": "menu", title: "Choose the agent" },
    agentLabel, icon(ICONS.chevron, "chat-chevron"));
  const choiceRow = h("div", { class: "chat-choices" });
  const newButton = h("button", { type: "button", class: "chat-icon-button", title: "New chat", "aria-label": "New chat" }, icon(ICONS.plus));
  const closeButton = h("button", { type: "button", class: "chat-icon-button", title: "Close (Ctrl+E)", "aria-label": "Close side chat" }, icon(ICONS.close));
  const header = h("header", { class: "chat-head" }, agentButton, choiceRow, h("span", { class: "chat-spacer" }), newButton, closeButton);
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  const empty = h("div", { class: "chat-empty" });
  const scroller = h("div", { class: "chat-scroll" }, empty, log);
  const contextIcon = h("span", { class: "chat-context-icon" });
  const contextTitle = h("span", { class: "chat-context-title" });
  const contextToggle = h("button", { type: "button", class: "chat-context", "aria-pressed": "true", title: "The agent knows which page you are looking at. Click to leave it out." },
    contextIcon, contextTitle);
  const input = h("textarea", { class: "chat-input", rows: "1", placeholder: "Tell it what to do on the web", "aria-label": "Message" });
  const sendButton = h("button", { type: "button", class: "chat-send", title: "Send (Enter)", "aria-label": "Send" }, icon(ICONS.send));
  const composer = h("div", { class: "chat-composer" }, contextToggle, h("div", { class: "chat-field" }, input, sendButton));
  const resizer = h("div", { class: "chat-resizer", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize side chat", tabindex: "0" });
  const menu = h("div", { class: "chat-menu", role: "menu", hidden: true });
  const panel = h("aside", { id: "still-chat", hidden: true, "aria-label": "Side chat" }, resizer, header, scroller, composer, menu);

  const host = document.getElementById("browser") || document.getElementById("tabbrowser-tabbox")?.parentNode;
  host?.append(panel);

  // ---------------------------------------------------------------- state

  const state = {
    open: false,
    agent: null,
    chat: null,
    busy: false,
    withPage: true,
    current: null,       // the agent turn being written: { el, texts: Map, tools: Map }
    widthFrame: 0,
    edgeTimer: 0
  };

  function agents() {
    return lazy.StillChat.chatAgents();
  }

  function currentAgent() {
    const id = Services.prefs.getStringPref(PREF_AGENT, "codex");
    return agents().find((agent) => agent.id === id) || agents()[0];
  }

  function width() {
    const value = Services.prefs.getIntPref(PREF_WIDTH, 400);
    return Math.max(320, Math.min(Math.round(window.innerWidth * 0.6), value));
  }

  function applyWidth() {
    const w = width();
    panel.style.width = `${w}px`;
    document.documentElement.style.setProperty("--still-chat-open", state.open ? `${w}px` : "0px");
  }

  // ----------------------------------------------------------- open/close
  // The panel slides in over the page first, then takes its place beside
  // it, so the page reflows once instead of on every frame of the slide.

  function open({ focus = true } = {}) {
    if (state.open) { if (focus) input.focus(); return; }
    state.open = true;
    applyWidth();
    panel.hidden = false;
    panel.classList.add("floating");
    renderContext();
    renderEmpty();
    ensureChat();
    const settle = () => { if (state.open) panel.classList.remove("floating"); };
    if (reducedMotion.matches) { panel.classList.add("shown"); settle(); }
    else {
      panel.getBoundingClientRect();
      panel.classList.add("shown");
      panel.addEventListener("transitionend", settle, { once: true });
      setTimeout(settle, 420);
    }
    if (focus) setTimeout(() => input.focus(), 40);
    still.state.chatOpen = true;
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    hideMenu();
    panel.classList.add("floating");
    applyWidth();
    panel.getBoundingClientRect();
    panel.classList.remove("shown");
    const done = () => { if (!state.open) panel.hidden = true; };
    if (reducedMotion.matches) done();
    else { panel.addEventListener("transitionend", done, { once: true }); setTimeout(done, 380); }
    still.state.chatOpen = false;
    if (panel.contains(document.activeElement)) gBrowser.selectedBrowser.focus();
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  closeButton.addEventListener("click", close);

  // Ctrl+E: Firefox uses it to focus a search bar that Still does not have.
  const commandSet = document.getElementById("mainCommandSet");
  const command = document.createXULElement("command");
  command.id = "still-cmd-chat";
  command.addEventListener("command", toggle);
  commandSet?.append(command);
  document.getElementById("key_search")?.setAttribute("command", "still-cmd-chat");

  // Resting the pointer at the window's right edge opens the chat (without
  // taking the keyboard from the page). A short dwell keeps a quick pass to
  // a page's scrollbar from opening it.
  const edgeTimer = setInterval(() => {
    if (state.open || document.hidden || !Services.prefs.getBoolPref(PREF_EDGE, true) || !document.hasFocus()) {
      clearTimeout(state.edgeTimer); state.edgeTimer = 0; return;
    }
    const cursor = lazy.StillShared.cursorInWindow(window);
    const scale = window.devicePixelRatio || 1;
    const atEdge = cursor && cursor.y / scale > 90 && cursor.y < cursor.height - 8
      && cursor.x >= cursor.width - Math.max(2, Math.round(2 * scale)) && cursor.x < cursor.width + 1;
    if (!atEdge) { clearTimeout(state.edgeTimer); state.edgeTimer = 0; return; }
    if (!state.edgeTimer) state.edgeTimer = setTimeout(() => { state.edgeTimer = 0; open({ focus: false }); }, EDGE_DWELL_MS);
  }, 50);
  window.addEventListener("unload", () => { clearInterval(edgeTimer); state.chat?.stop(); });

  // Drag the left edge to resize; arrow keys on it do the same.
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    panel.classList.add("resizing");
    const startX = event.clientX;
    const startW = panel.getBoundingClientRect().width;
    const move = (e) => {
      const next = Math.max(320, Math.min(window.innerWidth * 0.6, startW + startX - e.clientX));
      cancelAnimationFrame(state.widthFrame);
      state.widthFrame = requestAnimationFrame(() => { panel.style.width = `${Math.round(next)}px`; });
    };
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      panel.classList.remove("resizing");
      Services.prefs.setIntPref(PREF_WIDTH, Math.round(panel.getBoundingClientRect().width));
      applyWidth();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
    resizer.addEventListener("pointercancel", up, { once: true });
  });
  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    Services.prefs.setIntPref(PREF_WIDTH, width() + (event.key === "ArrowLeft" ? 24 : -24));
    applyWidth();
  });
  window.addEventListener("resize", () => { if (state.open) applyWidth(); });

  // ------------------------------------------------------------- agents

  function hideMenu() {
    menu.hidden = true;
    agentButton.setAttribute("aria-expanded", "false");
    for (const button of choiceRow.querySelectorAll("[aria-expanded]")) button.setAttribute("aria-expanded", "false");
  }

  function showMenu(anchor, items, onPick) {
    if (!menu.hidden && menu.anchor === anchor) { hideMenu(); return; }
    hideMenu();
    menu.anchor = anchor;
    menu.replaceChildren(...items.map((item) => {
      const row = h("button", { type: "button", role: "menuitemradio", class: "chat-menu-item", "aria-checked": String(Boolean(item.checked)) },
        h("span", { class: "chat-menu-check" }, item.checked ? icon(ICONS.check) : null),
        h("span", { class: "chat-menu-copy" }, h("strong", { text: item.name }), item.detail ? h("small", { text: item.detail }) : null));
      row.addEventListener("click", () => { hideMenu(); onPick(item); });
      return row;
    }));
    const box = anchor.getBoundingClientRect();
    const own = panel.getBoundingClientRect();
    menu.style.left = `${Math.max(8, box.left - own.left)}px`;
    menu.style.top = `${box.bottom - own.top + 6}px`;
    menu.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true }) || menu.firstElementChild?.focus();
  }

  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll(".chat-menu-item")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); const anchor = menu.anchor; hideMenu(); anchor?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== menu.anchor && !menu.anchor?.contains(event.target)) hideMenu();
  }, true);

  agentButton.addEventListener("click", () => {
    const active = currentAgent();
    showMenu(agentButton, agents().map((agent) => ({
      id: agent.id, name: agent.name, checked: agent.id === active.id,
      detail: agent.kind === "t3" ? "Runs as a T3 Code thread, with T3's model" : "Runs here, directly"
    })), (item) => {
      if (item.id === active.id) return;
      Services.prefs.setStringPref(PREF_AGENT, item.id);
      switchAgent();
    });
  });

  function switchAgent() {
    state.chat?.stop();
    state.chat = null;
    state.agent = null;
    state.busy = false;
    setBusy(false);
    log.replaceChildren();
    state.current = null;
    renderEmpty();
    ensureChat();
  }

  newButton.addEventListener("click", async () => {
    if (state.busy) state.chat?.cancel();
    log.replaceChildren();
    state.current = null;
    renderEmpty();
    try { await state.chat?.reset(); } catch (error) { showError(error); }
    input.focus();
  });

  function ensureChat() {
    if (state.chat) return state.chat;
    const agent = currentAgent();
    state.agent = agent;
    agentLabel.textContent = agent.name;
    choiceRow.replaceChildren();
    const chat = lazy.StillChat.createChat(agent, (event) => { if (state.chat === chat) onEvent(event); });
    state.chat = chat;
    // Start the agent as the panel opens, so the first reply is quick.
    chat.start().catch((error) => { if (state.chat === chat) showError(error); });
    return chat;
  }

  // Model and reasoning choices from the agent, remembered per agent.
  function renderChoices(options) {
    const agent = state.agent;
    // The panel shows model and reasoning; Settings has every option.
    const shown = options.filter((choice) => !choice.category || ["model", "thought_level"].includes(choice.category));
    choiceRow.replaceChildren(...shown.map((choice) => {
      const current = choice.values.find((item) => item.value === choice.value);
      const button = h("button", { type: "button", class: "chat-choice", "aria-haspopup": "menu", title: choice.name },
        h("span", { text: current?.name || choice.value || choice.name }), icon(ICONS.chevron, "chat-chevron"));
      button.addEventListener("click", () => showMenu(button, choice.values.map((item) => ({ ...item, checked: item.value === choice.value })), (item) => {
        Services.prefs.setStringPref(`${PREF_CHOICE}${agent.id}.${choice.id}`, item.value);
        state.chat?.choose(choice.id, item.value).catch(showError);
      }));
      return button;
    }));
    // Apply what you chose last time, once per new session.
    for (const choice of options) {
      const saved = Services.prefs.getStringPref(`${PREF_CHOICE}${agent.id}.${choice.id}`, "");
      if (saved && saved !== choice.value && choice.values.some((item) => item.value === saved)) {
        state.chat?.choose(choice.id, saved).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------- context

  // The page in front of you, which the agent is told about with each
  // message (unless you switch it off for the chat).
  function pageContext() {
    const tab = gBrowser.selectedTab;
    const url = tabUrl(tab);
    if (!url || url === "about:blank" || /^moz-extension:\/\/[^/]+\/newtab\.html$/.test(url) || url.startsWith("about:")) return null;
    const slot = still.slotIndex(tab);
    return { id: tab.linkedBrowser.browserId, slot: slot >= 0 ? slot + 1 : null, title: tab.label || url, url, image: tab.getAttribute("image") || "" };
  }

  function renderContext() {
    const page = pageContext();
    contextToggle.hidden = !page;
    if (!page) return;
    contextTitle.textContent = page.title;
    contextIcon.replaceChildren(page.image ? h("img", { src: page.image, alt: "" }) : icon(ICONS.page));
    contextToggle.setAttribute("aria-pressed", String(state.withPage));
    contextToggle.title = state.withPage
      ? `The agent knows you are looking at ${page.title}. Click to leave it out.`
      : "The page is left out. Click to tell the agent about it.";
  }

  contextToggle.addEventListener("click", () => { state.withPage = !state.withPage; renderContext(); });
  gBrowser.tabContainer.addEventListener("TabSelect", () => { if (state.open) renderContext(); });
  gBrowser.tabContainer.addEventListener("TabAttrModified", (event) => { if (state.open && event.target === gBrowser.selectedTab) renderContext(); });

  const GUIDE = [
    "You are the side chat of Still, the user's own web browser.",
    "Do what the user asks on the web with the \"still\" MCP tools (tabs, open_tab, navigate, snapshot, read_page, click, type, fill_form, press_keys, scroll, screenshot, wait_for, log_in and the rest). They use the user's real tabs, cookies and saved sign-ins.",
    "When the user says \"this page\" or \"here\", work in the tab named below; the user watches the agent's pointer there. For lookups elsewhere, open hidden agent tabs with open_tab instead of taking the user's slots.",
    "Take a snapshot before acting on a page and a fresh one after it changes. Prefer refs from the latest snapshot.",
    "Ask before anything that cannot be undone or costs money: sending messages or mail, posting, buying, deleting, changing account settings.",
    "Answer briefly in plain language. Do not edit files on this computer unless asked."
  ].join("\n");

  function promptBlocks(text, first) {
    const blocks = [];
    const page = state.withPage ? pageContext() : null;
    const lines = [];
    if (first) lines.push(GUIDE);
    if (page) lines.push(`The page in front of the user: tab ${page.id}${page.slot ? ` (slot ${page.slot})` : ""}, "${page.title}", ${page.url}`);
    if (lines.length) blocks.push({ type: "text", text: `<still-context>\n${lines.join("\n\n")}\n</still-context>` });
    blocks.push({ type: "text", text });
    return blocks;
  }

  // ----------------------------------------------------------------- send

  function setBusy(busy) {
    state.busy = busy;
    panel.classList.toggle("busy", busy);
    sendButton.replaceChildren(icon(busy ? ICONS.stop : ICONS.send));
    sendButton.title = busy ? "Stop" : "Send (Enter)";
    sendButton.setAttribute("aria-label", busy ? "Stop" : "Send");
  }

  async function send() {
    const text = input.value.trim();
    if (!text || state.busy) return;
    const chat = ensureChat();
    const first = !log.querySelector(".chat-user");
    input.value = "";
    fitInput();
    empty.hidden = true;
    const page = state.withPage ? pageContext() : null;
    appendUser(text, page);
    state.current = beginTurn();
    setBusy(true);
    try {
      const reason = await chat.prompt(promptBlocks(text, first));
      if (state.chat !== chat) return;
      finishTurn(reason);
    } catch (error) {
      if (state.chat !== chat) return;
      finishTurn("failed");
      showError(error);
    } finally {
      if (state.chat === chat) setBusy(false);
    }
  }

  sendButton.addEventListener("click", () => {
    if (state.busy) state.chat?.cancel();
    else send();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    else if (event.key === "Escape" && state.busy) { event.preventDefault(); state.chat?.cancel(); }
  });
  function fitInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
    sendButton.disabled = !input.value.trim() && !state.busy;
  }
  input.addEventListener("input", fitInput);

  // ------------------------------------------------------------- rendering

  function renderEmpty() {
    const agent = currentAgent();
    empty.hidden = Boolean(log.childElementCount);
    empty.replaceChildren(
      h("p", { class: "chat-empty-title", text: `Ask ${agent.name} to do something on the web.` }),
      h("p", { class: "chat-empty-note", text: agent.kind === "t3"
        ? "This chat runs as a T3 Code thread. Replies arrive when each step is done."
        : "It uses your tabs and sign-ins. You can watch its pointer on the page." }),
      h("div", { class: "chat-suggestions" }, ...[
        "Summarize this page",
        "Find the cheapest option on this page",
        "Fill in this form with my details"
      ].map((text) => h("button", { type: "button", class: "chat-suggestion", text, onclick: () => { input.value = text; fitInput(); input.focus(); } }))));
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  function keepScrolled(stick) {
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function appendUser(text, page) {
    const stick = true;
    log.append(h("div", { class: "chat-user" },
      h("div", { class: "chat-bubble", text }),
      page ? h("div", { class: "chat-user-page", text: page.title }) : null));
    keepScrolled(stick);
  }

  function beginTurn() {
    const el = h("div", { class: "chat-turn" });
    const status = h("div", { class: "chat-status" }, h("span", { class: "chat-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { text: "Working" }));
    el.append(status);
    log.append(el);
    keepScrolled(true);
    return { el, status, tools: new Map(), steps: null, thought: null, frame: 0, dirty: new Set(), lastKind: "", lastText: null };
  }

  function finishTurn(reason) {
    const turn = state.current;
    if (!turn) return;
    turn.status.remove();
    if (reason === "cancelled") turn.el.append(h("p", { class: "chat-note", text: "Stopped." }));
    else if (reason === "max_tokens") turn.el.append(h("p", { class: "chat-note", text: "The reply was cut off because it got too long." }));
    else if (reason === "refusal") turn.el.append(h("p", { class: "chat-note", text: "The agent declined this request." }));
    for (const [, tool] of turn.tools) if (tool.status === "in_progress" || tool.status === "pending") setToolStatus(tool, reason === "cancelled" ? "failed" : "completed");
    if (turn.thought) turn.thought.classList.remove("live");
    state.current = null;
  }

  function showError(error) {
    const message = error?.message || String(error);
    const row = h("div", { class: "chat-error", role: "alert" }, h("p", { text: message }));
    const retry = h("button", { type: "button", class: "chat-retry", text: "Start again" });
    retry.addEventListener("click", () => { row.remove(); switchAgent(); });
    row.append(retry);
    log.append(row);
    empty.hidden = true;
    keepScrolled(true);
  }

  function onEvent(event) {
    const turn = state.current;
    switch (event.type) {
      case "options":
        renderChoices(event.options || []);
        rememberChoices(state.agent, event.options || []);
        break;
      case "text":
        if (turn) addText(turn, event);
        break;
      case "thought":
        if (turn) addThought(turn, event.text);
        break;
      case "tool":
        if (turn) addTool(turn, event.call);
        break;
      case "plan":
        if (turn) renderPlan(turn, event.entries);
        break;
      case "permission":
        askPermission(event);
        break;
      case "notice":
        log.append(h("p", { class: "chat-note", text: event.text }));
        break;
      case "title":
        if (event.link) panel.dataset.link = event.link;
        break;
      case "exit":
        if (state.busy) return;
        log.append(h("p", { class: "chat-note", text: `${state.agent?.name || "The agent"} stopped. It starts again with your next message.` }));
        state.chat = null;
        break;
    }
  }

  // Text after a tool step (or from a new message) starts a new block, so
  // the reply reads in the order things happened.
  function addText(turn, event) {
    const stick = nearBottom();
    let entry = turn.lastKind === "text" ? turn.lastText : null;
    if (entry && event.id && entry.id && entry.id !== event.id) entry = null;
    if (!entry) {
      entry = { id: event.id, text: "", el: h("div", { class: "chat-text" }) };
      turn.el.insertBefore(entry.el, turn.status.isConnected ? turn.status : null);
    }
    entry.text = event.whole ? event.text : entry.text + event.text;
    turn.lastKind = "text";
    turn.lastText = entry;
    turn.dirty.add(entry);
    if (!turn.frame) {
      turn.frame = requestAnimationFrame(() => {
        turn.frame = 0;
        for (const item of turn.dirty) item.el.replaceChildren(markdown(item.text));
        turn.dirty.clear();
        keepScrolled(stick);
      });
    }
  }

  function addThought(turn, text) {
    if (!turn.thought) {
      const body = h("div", { class: "chat-thought-body" });
      turn.thought = h("details", { class: "chat-thought live" }, h("summary", { text: "Thinking" }), body);
      turn.thought.body = body;
      turn.thought.raw = "";
      turn.el.insertBefore(turn.thought, turn.status);
    }
    turn.thought.raw += text;
    turn.thought.body.textContent = turn.thought.raw;
    turn.lastKind = "thought";
  }

  // Still's own tools get plain names; anything else keeps the agent's title.
  const TOOL_NAMES = {
    tabs: "Looked at the tabs", open_tab: "Opened a tab", navigate: "Opened a page", show_tab: "Showed a tab", close_tab: "Closed a tab",
    snapshot: "Read the page", read_page: "Read the page", screenshot: "Looked at the page", click: "Clicked", type: "Typed",
    fill_form: "Filled in a form", press_keys: "Pressed keys", select_option: "Chose an option", hover: "Pointed at something",
    drag: "Dragged", scroll: "Scrolled", wait_for: "Waited", evaluate: "Ran a script on the page", log_in: "Signed in",
    upload_files: "Uploaded files", handle_dialog: "Answered a dialog", bookmarks: "Searched bookmarks", history: "Searched history",
    downloads: "Checked downloads", signed_in_sites: "Checked sign-ins", cookies: "Checked cookies"
  };

  // The same tools as a request, for permission questions.
  const TOOL_ASKS = {
    open_tab: "open a tab", navigate: "open a page", close_tab: "close a tab", click: "click on the page", type: "type on the page",
    fill_form: "fill in a form", press_keys: "press keys", select_option: "choose an option", drag: "drag something",
    evaluate: "run a script on the page", log_in: "sign in with your saved password", upload_files: "upload files",
    handle_dialog: "answer a dialog", cookies: "read cookies", show_tab: "show you a tab"
  };

  function toolAsk(call) {
    const raw = call.rawInput || {};
    const tool = raw.tool || ((call.title || "").match(/(?:mcp[._]+still[._]+|still[:._]\s*)(\w+)/) || [])[1];
    return tool && TOOL_ASKS[tool] ? `wants to ${TOOL_ASKS[tool]}` : call.title ? `wants to run: ${call.title}` : "asks to continue";
  }

  function toolName(call) {
    const raw = call.rawInput || {};
    const title = call.title || "";
    const tool = raw.tool || (title.match(/(?:mcp[._]+still[._]+|still[:._]\s*)(\w+)/) || [])[1];
    if (tool && TOOL_NAMES[tool]) {
      const args = raw.arguments || {};
      const detail = args.url ? ` · ${String(args.url).replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}`
        : args.text && tool === "type" ? ` · “${String(args.text).slice(0, 30)}”`
        : args.keys ? ` · ${String(args.keys).slice(0, 20)}` : "";
      return TOOL_NAMES[tool] + detail;
    }
    if (/^mcp__still__startup|mcp_startup/.test(title)) return null;
    return title || "Working";
  }

  function stepsBlock(turn) {
    if (!turn.steps || turn.lastKind !== "tool") {
      turn.steps = h("ol", { class: "chat-steps" });
      turn.el.insertBefore(turn.steps, turn.status);
    }
    return turn.steps;
  }

  function addTool(turn, call) {
    let tool = turn.tools.get(call.toolCallId);
    if (!tool) {
      const name = toolName(call);
      if (name === null) return;
      const glyph = h("span", { class: "chat-step-glyph", "aria-hidden": "true" });
      const label = h("span", { class: "chat-step-name", text: name });
      tool = { el: h("li", { class: "chat-step" }, glyph, label), glyph, label, status: "" };
      turn.tools.set(call.toolCallId, tool);
      stepsBlock(turn).append(tool.el);
      turn.lastKind = "tool";
      keepScrolled(nearBottom() || true);
    } else if (call.title) {
      const name = toolName(call);
      if (name) tool.label.textContent = name;
    }
    if (call.status) setToolStatus(tool, call.status);
  }

  function setToolStatus(tool, status) {
    if (tool.status === status) return;
    tool.status = status;
    tool.el.dataset.status = status;
    tool.glyph.replaceChildren(status === "completed" ? icon(ICONS.check) : status === "failed" ? icon(ICONS.cross) : h("span", { class: "chat-spinner" }));
  }

  function renderPlan(turn, entries) {
    if (!turn.plan) {
      turn.plan = h("ol", { class: "chat-plan", "aria-label": "Plan" });
      turn.el.insertBefore(turn.plan, turn.status);
    }
    turn.plan.replaceChildren(...entries.map((entry) => h("li", { class: `chat-plan-item ${entry.status}` },
      h("span", { class: "chat-plan-box", "aria-hidden": "true" }, entry.status === "completed" ? icon(ICONS.check) : null),
      h("span", { text: entry.content }))));
  }

  // The agent asks before a step. The question waits in the chat with the
  // agent's own choices; nothing happens until you pick one.
  function askPermission({ request, respond }) {
    open({ focus: false });
    const call = request.toolCall || {};
    const card = h("div", { class: "chat-permission", role: "group", "aria-label": "The agent asks for permission" },
      h("p", { class: "chat-permission-title", text: `${state.agent?.name || "The agent"} ${toolAsk(call)}` }));
    const row = h("div", { class: "chat-permission-options" });
    const options = request.options || [];
    options.forEach((option, index) => {
      const button = h("button", { type: "button", class: `chat-option ${/reject/.test(option.kind) ? "reject" : index === 0 ? "primary" : ""}`, text: option.name });
      button.addEventListener("click", () => {
        respond(option.optionId);
        card.classList.add("answered");
        row.replaceChildren(h("span", { class: "chat-note", text: option.name }));
      });
      row.append(button);
    });
    if (!options.length) {
      const deny = h("button", { type: "button", class: "chat-option reject", text: "Stop" });
      deny.addEventListener("click", () => { respond(null); card.classList.add("answered"); });
      row.append(deny);
    }
    card.append(row);
    (state.current?.el || log).insertBefore(card, state.current?.status?.isConnected ? state.current.status : null);
    keepScrolled(true);
    row.querySelector(".primary")?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- markdown
  // Enough Markdown for chat replies, built as DOM nodes (never parsed as
  // HTML): paragraphs, headings, lists, code blocks, inline code, bold,
  // italics and links (which open in a slot).

  function inline(text) {
    const out = document.createDocumentFragment();
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*]*\*)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) out.append(text.slice(last, match.index));
      const [token] = match;
      if (match[1]) out.append(h("code", { text: token.slice(1, -1) }));
      else if (match[2]) out.append(h("strong", { text: token.slice(2, -2) }));
      else if (match[3]) out.append(linkNode(token.slice(1, token.indexOf("](")), match[4]));
      else if (match[5]) out.append(linkNode(token, token));
      else if (match[6]) out.append(h("em", { text: token.slice(1, -1) }));
      last = match.index + token.length;
    }
    if (last < text.length) out.append(text.slice(last));
    return out;
  }

  function linkNode(label, url) {
    const a = h("a", { href: url, class: "chat-link", title: url, text: label });
    a.addEventListener("click", (event) => {
      event.preventDefault();
      still.openNewSlot({ url });
    });
    return a;
  }

  function markdown(source) {
    const root = document.createDocumentFragment();
    const lines = source.replace(/\r/g, "").split("\n");
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) { root.append(h("p", {}, inline(para.join(" ")))); para = []; }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flush(); list = null;
        const body = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
        root.append(h("pre", { class: "chat-code" }, h("code", { text: body.join("\n") })));
        continue;
      }
      const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (bullet) {
        flush();
        const ordered = Boolean(bullet[1]);
        if (!list || list.ordered !== ordered) { list = h(ordered ? "ol" : "ul"); list.ordered = ordered; root.append(list); }
        list.append(h("li", {}, inline(bullet[2])));
        continue;
      }
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) { flush(); list = null; root.append(h("p", { class: "chat-heading" }, inline(heading[1]))); continue; }
      if (!line.trim()) { flush(); list = null; continue; }
      if (list && /^\s{2,}\S/.test(line)) { list.lastElementChild?.append(" ", inline(line.trim())); continue; }
      list = null;
      para.push(line.trim());
    }
    flush();
    return root;
  }

  // ------------------------------------------------------------- startup

  setBusy(false);
  fitInput();
  agentLabel.textContent = currentAgent().name;
  // What each agent offers (models, reasoning effort), kept so Settings can
  // show them without starting the agent.
  const PREF_OPTIONS = "still.chat.options.";
  function rememberChoices(agent, options) {
    if (!agent || !options.length) return;
    try { Services.prefs.setStringPref(`${PREF_OPTIONS}${agent.id}`, JSON.stringify({ at: Date.now(), options })); } catch {}
  }

  function knownChoices(agentId) {
    try {
      const saved = JSON.parse(Services.prefs.getStringPref(`${PREF_OPTIONS}${agentId}`, "[]"));
      return Array.isArray(saved) ? saved : saved.options || [];
    } catch { return []; }
  }

  // How old the remembered choices are (Infinity when there are none).
  function choicesAge(agentId) {
    try { return Date.now() - (JSON.parse(Services.prefs.getStringPref(`${PREF_OPTIONS}${agentId}`, "{}")).at || 0); } catch { return Infinity; }
  }

  // Settings asks for an agent's choices it has not seen yet: a short-lived
  // session reports them, then stops.
  function loadChoices(agentId) {
    const agent = agents().find((candidate) => candidate.id === agentId);
    if (!agent) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      let chat = null;
      const timer = setTimeout(() => { chat?.stop(); reject(new Error(`${agent.name} did not answer`)); }, 45000);
      chat = lazy.StillChat.createChat(agent, (event) => {
        if (event.type !== "options" || !event.options?.length) return;
        clearTimeout(timer);
        rememberChoices(agent, event.options);
        chat.stop();
        resolve(event.options);
      });
      chat.start().catch((error) => { clearTimeout(timer); chat.stop(); reject(error); });
    });
  }

  // A choice made in Settings: saved for the agent, applied to its open chat.
  function applyChoice(agentId, id, value) {
    Services.prefs.setStringPref(`${PREF_CHOICE}${agentId}.${id}`, value);
    if (state.chat && state.agent?.id === agentId) state.chat.choose(id, value).catch(showError);
  }

  function selectAgent(id) {
    if (Services.prefs.getStringPref(PREF_AGENT, "codex") === id) return;
    Services.prefs.setStringPref(PREF_AGENT, id);
    if (state.chat) switchAgent();
  }

  window.StillChat = { open, close, toggle, isOpen: () => state.open, agents: () => agents(), knownChoices, choicesAge, loadChoices, applyChoice, selectAgent,
    savedChoice: (agentId, id) => Services.prefs.getStringPref(`${PREF_CHOICE}${agentId}.${id}`, "") };
})();
