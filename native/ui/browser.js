/* Still's native chrome. There is deliberately no script bridge into webpages. */
(async function () {
  'use strict';
  if (window.StillBrowser) return;
  const Services = window.Services;
  const { SessionStore } = ChromeUtils.importESModule('moz-src:///browser/components/sessionstore/SessionStore.sys.mjs');
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
  const M = window.StillModel;
  const START = window.StillStartURI;
  const ICON = window.StillRootURI + 'assets/still-icon.png';
  const SLOT_KEY = 'still-slot';
  const doc = window.document, root = doc.documentElement;
  const isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
  const html = (tag, props = {}, text = '') => {
    const element = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
    for (const [key, value] of Object.entries(props)) element.setAttribute(key, value);
    if (text) element.textContent = text;
    return element;
  };
  const tabGet = (tab) => {
    try { return SessionStore.getCustomTabValue(tab, SLOT_KEY); } catch { return ''; }
  };
  const tabSet = (tab, index) => SessionStore.setCustomTabValue(tab, SLOT_KEY, String(index));
  const actualUrl = (tab) => tab?.linkedBrowser?.currentURI?.spec || '';
  const isEmpty = (tab) => {
    const uri = actualUrl(tab);
    return !uri || uri === 'about:blank' || uri === 'about:newtab' || uri === 'about:home' || uri === START;
  };
  // Native authentication/pop-up windows retain their complete original UI,
  // window.opener relationship, principal, and lifecycle. Never reparent them.
  if (root.hasAttribute('popup-window') || !window.toolbar.visible || root.getAttribute('chromehidden')?.includes('toolbar')) {
    // An authentication popup cannot restore its live opener after a restart.
    // Native SessionStore may include a closing window in a shutdown snapshot.
    SessionStore.setCustomWindowValue(window, 'still-transient', '1');
    window.StillBrowser = { popup: true, engine: 'Gecko', ready: true };
    return;
  }
  await SessionStore.promiseInitialized;
  if (SessionStore.promiseAllWindowsRestored) await SessionStore.promiseAllWindowsRestored;
  if (window.closed) return;
  if (SessionStore.getCustomWindowValue(window, 'still-transient') === '1') {
    const other = Array.from(Services.wm.getEnumerator('navigator:browser')).find(win => win !== window && !win.closed && SessionStore.getCustomWindowValue(win, 'still-transient') !== '1');
    if (other) { other.focus(); window.close(); return; }
    // If this is the only restored window, keep a usable browser but discard
    // the obsolete authentication page. Never restore its expired callback.
    SessionStore.deleteCustomWindowValue(window, 'still-transient');
    window.openTrustedLinkIn(START, 'current');
  }
  const stylesheet = html('link', { rel: 'stylesheet', href: window.StillRootURI + 'browser.css' });
  root.append(stylesheet);
  root.setAttribute('still-native', '');
  root.setAttribute('still-theme', Services.prefs.getStringPref('still.theme', 'system'));

  const toolbox = doc.getElementById('navigator-toolbox');
  const rail = html('div', { id: 'still-rail', 'aria-label': 'Still browser controls' });
  rail.append(html('img', { id: 'still-brand', src: ICON, alt: 'Still', draggable: 'false' }));
  const slotRow = html('div', { id: 'still-slots', role: 'tablist', 'aria-label': 'Five browsing slots' });
  rail.append(slotRow);
  const controls = html('div', { class: 'still-controls' });
  rail.append(controls);
  toolbox.prepend(rail);
  const canvas = html('canvas', { id: 'still-effects', 'aria-hidden': 'true', hidden: '' });
  const menu = html('div', { id: 'still-menu', role: 'dialog', 'aria-label': 'Still tools and appearance', hidden: '' });
  const replacement = html('div', { id: 'still-replace', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a slot', hidden: '' });
  const toastElement = html('div', { id: 'still-toast', role: 'status', 'aria-live': 'polite', hidden: '' });
  const dock = html('div', { id: 'still-dock', role: 'tablist', 'aria-label': 'Switch slots', hidden: '' });
  root.append(canvas, menu, replacement, toastElement, dock);
  const effects = new window.StillEffects(window, canvas, gBrowser.tabpanels);
  const controller = {
    engine: 'Gecko', ready: false, slots: [], overflow: [], effects,
    switching: false, reconciling: false, shuttingDown: false,
    previousIndex: 0, dragIndex: -1, dockIndex: 0, dockOpen: false,
    popupCount: 0, hideTimer: 0, toastTimer: 0, reconcileTimer: 0,
    mutationTimer: 0, saveTimer: 0, animationsStarted: 0,
    buttons: [], abort: new window.AbortController(),
    renderSignatures: Array(M.SLOT_COUNT).fill(''),
    get selectedIndex() { return this.slots.indexOf(gBrowser.selectedTab); },
    toast(text) {
      clearTimeout(this.toastTimer);
      toastElement.textContent = text; toastElement.hidden = false;
      this.toastTimer = setTimeout(() => { toastElement.hidden = true; }, 2400);
    },
    showChrome() { clearTimeout(this.hideTimer); root.setAttribute('still-chrome-open', ''); },
    hideChrome() {
      if (this.popupCount || !menu.hidden || !replacement.hidden || toolbox.contains(doc.activeElement)) return;
      root.removeAttribute('still-chrome-open');
    },
    scheduleHide() { clearTimeout(this.hideTimer); this.hideTimer = setTimeout(() => this.hideChrome(), 700); },
    createStart() {
      return gBrowser.addTrustedTab(START, { inBackground: true, skipAnimation: true });
    },
    tagSlots() {
      this.slots.forEach((tab, index) => {
        if (tab) { tabSet(tab, index); tab.setAttribute('still-slot', index); }
      });
    },
    render() {
      this.slots.forEach((tab, index) => {
        const button = this.buttons[index];
        if (!tab || !button) return;
        const empty = isEmpty(tab);
        const text = empty ? (index === this.selectedIndex ? 'Still' : 'New slot') : tab.label || 'Loading…';
        const selected = gBrowser.selectedTab === tab;
        const signature = [text,actualUrl(tab),selected,tab.getAttribute('image'),tab.hasAttribute('soundplaying'),tab.hasAttribute('busy')].join('\n');
        if (this.renderSignatures[index] === signature) return;
        this.renderSignatures[index] = signature;
        const image = button.querySelector('img');
        const favicon = M.safeFavicon(tab.getAttribute('image'));
        button.querySelector('span').textContent = text;
        button.querySelector('small').textContent = tab.hasAttribute('soundplaying') ? '♪' : String(index + 1);
        button.title = empty ? `Slot ${index + 1} · Ctrl+${index + 1}` : `${text}\n${actualUrl(tab)}\nCtrl+${index + 1}`;
        button.setAttribute('aria-label', `Slot ${index + 1}: ${text}`);
        button.setAttribute('aria-selected', String(selected));
        if (tab.linkedPanel) button.setAttribute('aria-controls', tab.linkedPanel);
        button.tabIndex = selected ? 0 : -1;
        button.toggleAttribute('data-busy', tab.hasAttribute('busy'));
        if (image.getAttribute('src') !== (favicon || ICON)) image.setAttribute('src', favicon || ICON);
      });
      this.saveSoon();
    },
    select(index, animate = true) {
      const tab = this.slots[index];
      if (!tab || tab.closing) return;
      const previous = this.selectedIndex;
      if (gBrowser.selectedTab !== tab) gBrowser.selectedTab = tab;
      else if (animate && previous !== index) effects.play(index - previous);
      if (isEmpty(tab)) {
        if (actualUrl(tab) !== START) window.openTrustedLinkIn(START, 'current', { targetBrowser: tab.linkedBrowser });
        this.showChrome();
      }
      tab.linkedBrowser.focus();
      this.scheduleHide();
      this.render();
    },
    onSelect() {
      const index = this.selectedIndex;
      if (index < 0) { this.showReplacement(); return; }
      if (this.ready && index !== this.previousIndex) {
        effects.play(index - this.previousIndex);
        this.animationsStarted++;
      }
      this.previousIndex = index;
      this.render();
    },
    clear(index) {
      const tab = this.slots[index];
      if (!tab) return;
      if (!tab.linkedBrowser.permitUnload().permitUnload) return;
      // Close the old tab, rather than navigating it: native unload prompts,
      // session history, media cleanup, and Undo Close Tab remain intact.
      this.reconciling = true;
      const fresh = this.createStart();
      this.slots[index] = fresh; tabSet(fresh, index);
      if (gBrowser.selectedTab === tab) gBrowser.selectedTab = fresh;
      SessionStore.deleteCustomTabValue(tab, SLOT_KEY);
      gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
      this.reconciling = false;
      this.render();
    },
    newSlot() {
      const index = this.slots.findIndex(isEmpty);
      if (index >= 0) { this.select(index); this.showChrome(); window.gURLBar.focus(); window.gURLBar.select(); }
      else { this.toast('All five slots are in use. Clear one with Ctrl+W.'); this.showChrome(); }
    },
    reorder(from, to) {
      if (from < 0 || to < 0 || from === to) return;
      [this.slots[from], this.slots[to]] = [this.slots[to], this.slots[from]];
      this.tagSlots();
      this.slots.forEach((tab, i) => gBrowser.moveTabTo(tab, { tabIndex: i }));
      this.previousIndex = this.selectedIndex;
      this.render();
    },
    reconcile() {
      if (this.reconciling || this.shuttingDown) return;
      this.reconciling = true;
      try {
        const tabs = Array.from(gBrowser.tabs).filter(tab => !tab.closing);
        const allocation = M.allocate(tabs, tabGet);
        // Empty placeholders yield their position to a newly opened native tab.
        const newcomers = allocation.overflow.slice();
        for (const incoming of newcomers) {
          const blank = allocation.slots.findIndex(isEmpty);
          if (blank < 0) break;
          const previous = allocation.slots[blank];
          allocation.slots[blank] = incoming;
          allocation.overflow.splice(allocation.overflow.indexOf(incoming), 1);
          SessionStore.deleteCustomTabValue(previous, SLOT_KEY);
          gBrowser.removeTab(previous, { animate: false });
        }
        this.slots = allocation.slots.map(tab => tab || this.createStart());
        this.overflow = allocation.overflow;
        this.tagSlots();
      } finally { this.reconciling = false; }
      this.render();
      if (this.overflow.length) this.showReplacement();
    },
    scheduleReconcile() {
      if (this.reconciling || this.shuttingDown) return;
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = setTimeout(() => this.reconcile(), 0);
    },
    showReplacement() {
      if (!this.ready || !this.overflow.length || !replacement.hidden) return;
      const incoming = this.overflow[0];
      const section = html('section');
      section.append(html('h2', {}, 'Choose a slot'));
      section.append(html('p', {}, 'Five slots are in use. Choose which one this new page replaces.'));
      section.append(html('p', {}, incoming.label || actualUrl(incoming)));
      this.slots.forEach((tab, i) => {
        const button = html('button', { type: 'button' }, `${i + 1} · ${isEmpty(tab) ? 'New slot' : tab.label}`);
        button.addEventListener('click', () => {
          if (!gBrowser.tabs.includes(incoming)) { replacement.hidden = true; this.reconcile(); return; }
          if (!tab.linkedBrowser.permitUnload().permitUnload) return;
          this.reconciling = true;
          SessionStore.deleteCustomTabValue(tab, SLOT_KEY);
          this.slots[i] = incoming; tabSet(incoming, i);
          gBrowser.selectedTab = incoming;
          gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
          this.overflow.shift(); replacement.hidden = true;
          this.reconciling = false; this.render();
          if (this.overflow.length) this.showReplacement();
        });
        section.append(button);
      });
      const cancel = html('button', { type: 'button' }, 'Cancel new page');
      cancel.addEventListener('click', () => this.cancelReplacement()); section.append(cancel);
      replacement.replaceChildren(section); replacement.hidden = false;
      this.showChrome(); section.querySelector('button').focus();
    },
    cancelReplacement() {
      const incoming = this.overflow.shift(); replacement.hidden = true;
      if (incoming && gBrowser.tabs.includes(incoming)) gBrowser.removeTab(incoming, { animate: false });
      this.select(Math.max(0, this.previousIndex), false);
      if (this.overflow.length) this.showReplacement();
    },
    toggleMenu() { menu.hidden = !menu.hidden; this.showChrome(); if (!menu.hidden) menu.querySelector('button').focus(); },
    setMotion(value) {
      if (!['off', 'slide', 'elastic', 'ripple'].includes(value)) return;
      Services.prefs.setStringPref('still.motion', value);
      effects.cancel();
      if (value === 'ripple') window.requestIdleCallback(() => effects.initialize());
    },
    setTheme(value) {
      if (!['system', 'light', 'dark'].includes(value)) return;
      Services.prefs.setStringPref('still.theme', value); root.setAttribute('still-theme', value);
      Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', { system: 2, light: 1, dark: 0 }[value]);
    },
    openDock(reverse) {
      if (!this.dockOpen) { this.dockOpen = true; this.dockIndex = Math.max(0, this.selectedIndex); }
      this.dockIndex = (this.dockIndex + (reverse ? -1 : 1) + M.SLOT_COUNT) % M.SLOT_COUNT;
      dock.replaceChildren();
      this.slots.forEach((tab, index) => {
        const button = html('button', { role: 'tab', 'aria-selected': String(index === this.dockIndex), type: 'button' });
        button.append(html('img', { src: M.safeFavicon(tab.getAttribute('image')) || ICON, alt: '' }), html('span', {}, isEmpty(tab) ? 'New slot' : tab.label));
        button.addEventListener('click', () => { this.dockIndex = index; this.commitDock(); });
        dock.append(button);
      });
      dock.hidden = false;
    },
    commitDock() { if (this.dockOpen) { this.dockOpen = false; dock.hidden = true; this.select(this.dockIndex); } },
    saveSoon() {
      if (isPrivate || !this.ready) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveState(), 500);
    },
    async saveState() {
      if (isPrivate) return;
      const state = { version: 2, selected: Math.max(0, this.selectedIndex), slots: this.slots.map(tab => ({ url: isEmpty(tab) ? '' : actualUrl(tab), title: tab.label || '' })) };
      try { await IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, 'still-slots.json'), state, { tmpPath: PathUtils.join(PathUtils.profileDir, 'still-slots.json.tmp') }); }
      catch (error) { Cu.reportError('Still session save: ' + error); }
    },
    async measureFrames(duration = 2000, switching = false) {
      // Explicit diagnostics only; never a permanent frame loop.
      const deltas = []; let last = 0, start = 0, lastSwitch = 0, n = 0;
      return new Promise(resolve => {
        const tick = (now) => {
          if (!start) start = now;
          if (last) deltas.push(now - last); last = now;
          if (switching && now - lastSwitch >= 110) { this.select((n++) % M.SLOT_COUNT); lastSwitch = now; }
          if (now - start < duration) window.requestAnimationFrame(tick);
          else {
            const sorted = deltas.slice().sort((a, b) => a - b);
            const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
            resolve({ frames: deltas.length, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: Math.max(...deltas, 0), averageFps: 1000 / (deltas.reduce((a,b) => a+b, 0) / Math.max(1,deltas.length)), over16ms: deltas.filter(x => x > 16.67).length });
          }
        };
        window.requestAnimationFrame(tick);
      });
    },
    destroy() {
      this.shuttingDown = true; this.abort.abort(); this.mutations.disconnect();
      window.StillDownloader.cancel();
      for (const timer of ['hideTimer', 'toastTimer', 'reconcileTimer', 'mutationTimer', 'saveTimer']) clearTimeout(this[timer]);
      Services.obs.removeObserver(this.quitObserver, 'quit-application-granted');
      gBrowser.removeTabsProgressListener(this.progress);
      effects.destroy();
    }
  };
  window.StillBrowser = controller;
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: controller.abort.signal });
  // Reserved native keys are routed out of remote content processes before a
  // webpage can consume them. A chrome DOM keydown listener alone isn't enough.
  const commands = doc.createXULElement('commandset'); commands.id = 'still-commandset';
  const keys = doc.createXULElement('keyset'); keys.id = 'still-keyset';
  const shortcut = (id, key, modifiers, callback, keycode = false) => {
    const command = doc.createXULElement('command'); command.id = 'still-command-' + id;
    listen(command, 'command', callback); commands.append(command);
    const element = doc.createXULElement('key');
    element.id = 'still-key-' + id;
    element.setAttribute(keycode ? 'keycode' : 'key', key);
    element.setAttribute('modifiers', modifiers);
    element.setAttribute('reserved', 'true');
    element.setAttribute('command', command.id); keys.append(element);
  };
  for (let i = 0; i < M.SLOT_COUNT; i++) shortcut('slot-' + i, String(i + 1), 'accel', () => controller.select(i));
  shortcut('new', 't', 'accel', () => controller.newSlot());
  shortcut('clear', 'w', 'accel', () => controller.clear(controller.selectedIndex));
  shortcut('downloads', 'j', 'accel', () => window.BrowserCommands.downloadsUI());
  shortcut('dock', 'VK_TAB', 'accel', () => controller.openDock(false), true);
  shortcut('dock-reverse', 'VK_TAB', 'accel,shift', () => controller.openDock(true), true);
  shortcut('previous', 'VK_UP', 'alt', () => controller.select(M.boundedStep(controller.selectedIndex,-1)), true);
  shortcut('next', 'VK_DOWN', 'alt', () => controller.select(M.boundedStep(controller.selectedIndex,1)), true);
  root.append(commands, keys);
  for (let index = 0; index < M.SLOT_COUNT; index++) {
    const button = html('button', { class: 'still-slot', role: 'tab', type: 'button', draggable: 'true' });
    button.append(html('img', { src: ICON, alt: '', draggable: 'false' }), html('span'), html('small'));
    listen(button, 'click', () => controller.select(index));
    listen(button, 'pointerenter', () => { if (controller.slots[index]) gBrowser.warmupTab(controller.slots[index]); });
    listen(button, 'dblclick', () => { controller.select(index); controller.showChrome(); window.gURLBar.focus(); window.gURLBar.select(); });
    listen(button, 'auxclick', (event) => { if (event.button === 1) { event.preventDefault(); controller.clear(index); } });
    listen(button, 'contextmenu', (event) => { event.preventDefault(); const tab = controller.slots[index]; if (tab.hasAttribute('soundplaying') || tab.hasAttribute('muted')) tab.toggleMuteAudio(); else controller.clear(index); });
    listen(button, 'dragstart', (event) => { controller.dragIndex = index; event.dataTransfer.setData('application/x-still-slot', String(index)); event.dataTransfer.effectAllowed = 'move'; });
    listen(button, 'dragover', event => { if (controller.dragIndex >= 0) event.preventDefault(); });
    listen(button, 'drop', event => { event.preventDefault(); controller.reorder(controller.dragIndex, index); controller.dragIndex = -1; });
    listen(button, 'dragend', () => { controller.dragIndex = -1; });
    listen(button, 'keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault(); event.stopPropagation(); const next = M.boundedStep(index, event.key === 'ArrowRight' ? 1 : -1);
        controller.select(next); controller.buttons[next].focus();
      }
    });
    slotRow.append(button); controller.buttons.push(button);
  }
  const control = (action, symbol, label, callback) => {
    const button = html('button', { class: 'still-control', type: 'button', 'data-action': action, 'aria-label': label, title: label }, symbol);
    listen(button, 'click', callback); controls.append(button);
  };
  control('tools', '⋯', 'Tools and appearance', () => controller.toggleMenu());
  control('minimize', '−', 'Minimize', () => window.minimize());
  control('maximize', '□', 'Maximize or restore', () => window.windowState === window.STATE_MAXIMIZED ? window.restore() : window.maximize());
  control('close', '×', 'Close Still', () => window.BrowserCommands.tryToCloseWindow());
  const menuAction = (label, action) => {
    const button = html('button', { type: 'button' }, label);
    listen(button, 'click', () => { menu.hidden = true; controller.showChrome(); action(); }); menu.append(button);
  };
  menuAction('Downloads                         Ctrl+J', () => window.BrowserCommands.downloadsUI());
  menuAction('Bookmarks                         Ctrl+B', () => window.SidebarController.toggle('viewBookmarksSidebar'));
  menuAction('History                                Ctrl+H', () => window.SidebarController.toggle('viewHistorySidebar'));
  menuAction('Bookmark this page              Ctrl+D', () => window.PlacesCommandHook.bookmarkPage());
  menuAction('Site permissions and security', () => window.gIdentityHandler.handleMoreInfoClick());
  menuAction('Undo closed slot             Ctrl+Shift+T', () => doc.getElementById('History:UndoCloseTab').doCommand());
  menu.append(html('hr'));
  menuAction('Download YouTube video', () => window.StillDownloader.download('video'));
  menuAction('Download YouTube audio', () => window.StillDownloader.download('audio'));
  menuAction('Download YouTube thumbnail', () => window.StillDownloader.download('thumbnail'));
  menuAction('Cancel media download', () => window.StillDownloader.cancel());
  menu.append(html('hr'));
  const selectSetting = (labelText, id, values, current, onChange) => {
    const label = html('label', { for: id }, labelText);
    const select = html('select', { id });
    for (const [value, title] of values) select.append(html('option', { value }, title));
    select.value = current; listen(select, 'change', () => onChange(select.value)); label.append(select); menu.append(label);
  };
  selectSetting('Motion', 'still-motion', [['elastic','Elastic / squish'],['slide','Quick slide'],['ripple','Ripple'],['off','Instant']], Services.prefs.getStringPref('still.motion', 'elastic'), value => controller.setMotion(value));
  selectSetting('Theme', 'still-theme', [['system','System'],['light','Light'],['dark','Dark']], Services.prefs.getStringPref('still.theme','system'), value => controller.setTheme(value));
  menu.append(html('hr'));
  menuAction('Browser settings', () => window.openTrustedLinkIn('about:preferences', 'tab'));
  menuAction('Extensions', () => window.openTrustedLinkIn('about:addons', 'tab'));
  menuAction('Private Still window', () => window.OpenBrowserWindow({ private: true }));
  menuAction('Native browser menu', () => window.PanelUI.show());
  menuAction('Measure transition frame rate', async () => {
    const result = await controller.measureFrames(2500, true);
    controller.toast(`${result.averageFps.toFixed(0)} fps · median ${result.medianMs.toFixed(2)} ms · p95 ${result.p95Ms.toFixed(2)} ms`);
  });
  listen(toolbox, 'pointerenter', () => controller.showChrome());
  listen(toolbox, 'pointerleave', () => controller.scheduleHide());
  listen(window, 'pointermove', event => { if (event.clientY <= 7) controller.showChrome(); }, { passive: true });
  listen(window, 'mousedown', event => {
    if (!menu.hidden && !menu.contains(event.target) && !controls.contains(event.target)) menu.hidden = true;
    if (!toolbox.contains(event.target) && !menu.contains(event.target) && replacement.hidden) {
      if (toolbox.contains(doc.activeElement)) gBrowser.selectedBrowser.focus();
      controller.hideChrome();
    }
  }, { capture: true });
  listen(window, 'popupshown', () => { controller.popupCount++; controller.showChrome(); });
  listen(window, 'popuphidden', () => { controller.popupCount = Math.max(0, controller.popupCount - 1); controller.scheduleHide(); });
  listen(window, 'keydown', event => {
    const accel = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (accel && !event.altKey && /^\d$/.test(key) && Number(key) >= 1 && Number(key) <= M.SLOT_COUNT) {
      consume(); controller.select(Number(key) - 1); return;
    }
    if (accel && key === 't' && !event.shiftKey) { consume(); controller.newSlot(); return; }
    if (accel && key === 'w' && !event.shiftKey) { consume(); controller.clear(controller.selectedIndex); return; }
    if (accel && key === 'tab') { consume(); controller.openDock(event.shiftKey); return; }
    if (accel && key === 'j' && !event.shiftKey) { consume(); window.BrowserCommands.downloadsUI(); return; }
    if (accel && (key === 'l' || key === 'k')) controller.showChrome();
    if (event.altKey && !accel && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      consume(); controller.select(M.boundedStep(controller.selectedIndex, event.key === 'ArrowUp' ? -1 : 1)); return;
    }
    if (event.key === 'Escape') {
      if (!replacement.hidden) { consume(); controller.cancelReplacement(); }
      else if (controller.dockOpen) { consume(); controller.dockOpen = false; dock.hidden = true; }
      else if (!menu.hidden) { consume(); menu.hidden = true; controls.firstChild.focus(); }
      else controller.hideChrome();
    }
  }, { capture: true });
  listen(window, 'keyup', event => { if (event.key === 'Control' || event.key === 'Meta') controller.commitDock(); }, { capture: true });
  listen(window, 'blur', () => { controller.dockOpen = false; dock.hidden = true; effects.cancel(); });
  listen(gBrowser.tabContainer, 'TabOpen', () => controller.scheduleReconcile());
  listen(gBrowser.tabContainer, 'TabClose', () => controller.scheduleReconcile());
  listen(gBrowser.tabContainer, 'SSTabRestored', () => controller.scheduleReconcile());
  listen(gBrowser.tabContainer, 'TabSelect', () => controller.onSelect());
  controller.mutations = new window.MutationObserver(() => {
    if (controller.mutationTimer) return;
    controller.mutationTimer = setTimeout(() => { controller.mutationTimer = 0; controller.render(); }, 45);
  });
  controller.mutations.observe(gBrowser.tabContainer, { subtree: true, attributes: true, attributeFilter: ['label','image','busy','soundplaying','muted'] });
  controller.progress = { onLocationChange() { controller.render(); } };
  gBrowser.addTabsProgressListener(controller.progress);
  controller.quitObserver = { observe() { controller.shuttingDown = true; effects.cancel(); controller.saveState(); } };
  Services.obs.addObserver(controller.quitObserver, 'quit-application-granted');
  listen(window, 'unload', () => controller.destroy(), { once: true });
  // SessionStore owns full session history. The small Still JSON is a fallback
  // for clean profiles and migrations, never a source of cookies or passwords.
  let saved;
  try { saved = await IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, 'still-slots.json')); } catch {}
  const onlyEmptyTabs = Array.from(gBrowser.tabs).every(isEmpty);
  if (saved?.slots && onlyEmptyTabs && !isPrivate) {
    controller.reconciling = true;
    const first = gBrowser.selectedTab;
    for (let i = 0; i < M.SLOT_COUNT; i++) {
      const url = saved.slots[i]?.url;
      const tab = i === 0 ? first : controller.createStart();
      tabSet(tab, i);
      if (url && /^https?:\/\//i.test(url)) window.openWebLinkIn(url, 'current', { targetBrowser: tab.linkedBrowser, inBackground: true });
      else window.openTrustedLinkIn(START, 'current', { targetBrowser: tab.linkedBrowser, inBackground: true });
    }
    controller.reconciling = false;
  }
  controller.reconcile(); controller.ready = true;
  const startIndex = onlyEmptyTabs && saved ? M.slotIndex(saved.selected) : controller.selectedIndex;
  controller.select(Math.max(0, startIndex), false);
  controller.previousIndex = controller.selectedIndex;
  controller.showChrome(); controller.scheduleHide();
  if (!isPrivate) window.requestIdleCallback(async () => {
    if (Services.prefs.getBoolPref('still.legacyImported', false)) return;
    let imported;
    try { imported = await IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, 'legacy-import.json')); }
    catch { return; }
    try {
      const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
      if (imported.history?.length) {
        const entries = imported.history.filter(item => /^https?:\/\//i.test(item.url)).map(item => ({
          url: item.url, title: String(item.title || item.url),
          visits: [{ date: new Date(Math.min(Date.now(), Number(item.lastVisit) || Date.now())), transition: PlacesUtils.history.TRANSITION_LINK }]
        }));
        for (let i = 0; i < entries.length; i += 100) await PlacesUtils.history.insertMany(entries.slice(i, i + 100));
      }
      if (imported.bookmarks?.length) {
        let parentGuid = Services.prefs.getStringPref('still.legacyBookmarkFolder', '');
        if (!parentGuid) {
          const folder = await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.menuGuid, type: PlacesUtils.bookmarks.TYPE_FOLDER, title: 'Imported from Still' });
          parentGuid = folder.guid; Services.prefs.setStringPref('still.legacyBookmarkFolder', parentGuid);
        }
        for (const item of imported.bookmarks) {
          if (/^https?:\/\//i.test(item.url)) await PlacesUtils.bookmarks.insert({ parentGuid, url: item.url, title: String(item.name || item.title || item.url) });
        }
      }
      Services.prefs.setBoolPref('still.legacyImported', true);
      await IOUtils.remove(PathUtils.join(PathUtils.profileDir, 'legacy-import.json'));
    } catch (error) { Cu.reportError('Still legacy import: ' + error); }
  });
  if (Services.prefs.getStringPref('still.motion','elastic') === 'ripple') window.requestIdleCallback(() => effects.initialize());
})().catch(error => { Cu.reportError('Still native chrome: ' + error + '\n' + error.stack); });
