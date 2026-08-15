(() => {
  const UI_VERSION = 13;
  if (window.__stillDownloadUi?.version === UI_VERSION && window.__stillDownloadUi?.mount) {
    window.__stillDownloadUi.mount();
    return;
  }

  // YouTube keeps the same document alive while navigating. Remove an older
  // injected control so visual updates never get stuck behind that cached UI.
  window.__stillDownloadUi?.destroy?.();
  document.querySelector('#still-youtube-download-host')?.remove();

  let currentUi = null;
  let busy = false;
  let mountTimer;
  let tooltipTimer;
  let tooltipHideTimer;

  function isWatchPage() {
    const url = new URL(location.href);
    return url.pathname === '/watch' && Boolean(url.searchParams.get('v'));
  }

  function label(text) {
    if (currentUi) currentUi.trigger.querySelector('.trigger-label').textContent = text;
  }

  function triggerState(value = '') {
    if (currentUi) currentUi.trigger.dataset.state = value;
  }

  function status(text, kind = '') {
    if (!currentUi) return;
    currentUi.status.textContent = text;
    currentUi.status.dataset.kind = kind;
    currentUi.panel.dataset.status = text === 'Choose a format to save it.' ? 'false' : 'true';
  }

  function disableChoices(disabled) {
    currentUi?.root.querySelectorAll('.choice').forEach((choice) => { choice.disabled = disabled; });
  }

  function selectFormat(mode, option) {
    if (busy || !currentUi) return;
    busy = true;
    triggerState('busy');
    currentUi.panel.hidden = false;
    disableChoices(true);
    label('Starting…');
    status('Preparing your download…');
    currentUi.bar.style.width = '3%';
    window.postMessage({ type: 'still-youtube-download', mode, option }, location.origin);
  }

  function handleProgress(event) {
    const update = event.detail || {};
    if (!currentUi) return;
    if (update.state === 'starting') {
      triggerState('busy');
      busy = true;
      disableChoices(true);
      label('Starting…');
      status('Preparing your download…');
      currentUi.bar.style.width = '3%';
    } else if (update.state === 'downloading') {
      triggerState('busy');
      const percent = Math.max(0, Math.min(100, Number.parseFloat(update.percent) || 0));
      const details = [update.speed, update.eta && `ETA ${update.eta}`].filter(Boolean).join(' · ');
      label(update.percent || 'Downloading');
      status(`Downloading${details ? ` · ${details}` : ''}`);
      currentUi.bar.style.width = `${percent}%`;
    } else if (update.state === 'complete') {
      triggerState('success');
      busy = false;
      disableChoices(false);
      label('Downloaded');
      status('Saved where you chose.', 'success');
      currentUi.bar.style.width = '100%';
      setTimeout(() => label('Download'), 2600);
    } else if (update.state === 'cancelled') {
      triggerState();
      busy = false;
      disableChoices(false);
      label('Download');
      status('Download cancelled.');
      currentUi.bar.style.width = '0%';
    } else if (update.state === 'error') {
      triggerState('error');
      busy = false;
      disableChoices(false);
      label('Retry');
      status(update.message || 'The download failed.', 'error');
      currentUi.bar.style.width = '0%';
    }
  }

  function syncNativeActionStyle(host, trigger) {
    const candidates = [...document.querySelectorAll(
      '#actions #top-level-buttons-computed button, #actions button-view-model button, #actions yt-button-shape button'
    )];
    const visible = (button) => button.getBoundingClientRect().width > 0;
    const description = (button) => `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`;
    // Copy a complete tonal pill, never the segmented Like half (its right radius is zero).
    const reference = candidates.find((button) => visible(button) && /share|teilen/i.test(description(button)))
      || candidates.find((button) => visible(button) && /save|speichern/i.test(description(button)))
      || candidates.find((button) => visible(button) && !button.className.includes('Segmented'));
    if (!reference || reference === trigger) return;
    const textStyle = getComputedStyle(reference);
    const rootStyle = getComputedStyle(document.documentElement);
    const nativeBase = rootStyle
      .getPropertyValue('--yt-sys-color-baseline--overlay-button-secondary').trim();
    host.style.setProperty('--still-action-bg', nativeBase || 'rgba(255,255,255,.1)');
    host.style.setProperty('--still-action-radius', textStyle.borderRadius || '20px');
    host.style.setProperty('--still-action-color', textStyle.color);
    host.style.setProperty('--still-action-font', textStyle.fontFamily);
    host.style.setProperty('--still-action-size', textStyle.fontSize || '14px');
    host.style.setProperty('--still-action-weight', textStyle.fontWeight || '500');
    host.style.setProperty('--still-action-padding', textStyle.padding || '0 16px');
    host.style.setProperty('--still-action-line-height', textStyle.lineHeight || '40px');
    const nativeHover = rootStyle
      .getPropertyValue('--yt-sys-color-baseline--mono-tonal-hover').trim();
    host.style.setProperty('--still-action-hover', nativeHover || 'rgba(255,255,255,.2)');
    if (reference.getBoundingClientRect().height > 28) {
      host.style.setProperty('--still-action-height', `${reference.getBoundingClientRect().height}px`);
    }
  }

  function positionCurrentPanel() {
    if (!currentUi || currentUi.panel.hidden) return;
    const rect = currentUi.trigger.getBoundingClientRect();
    const width = Math.min(232, innerWidth - 24);
    const left = Math.max(12, Math.min(innerWidth - width - 12, rect.right - width));
    currentUi.panel.style.width = `${width}px`;
    const menuHeight = Math.min(currentUi.panel.scrollHeight, 420, innerHeight - 24);
    const below = rect.bottom + 8;
    const opensBelow = below + menuHeight <= innerHeight - 12;
    const top = opensBelow ? below : Math.max(12, rect.top - menuHeight - 8);
    currentUi.panel.style.transformOrigin = opensBelow ? 'top right' : 'bottom right';
    currentUi.panel.style.left = `${left}px`;
    currentUi.panel.style.top = `${top}px`;
  }

  function positionCurrentTooltip() {
    if (!currentUi || currentUi.tooltip.hidden) return;
    const triggerRect = currentUi.trigger.getBoundingClientRect();
    const tooltipRect = currentUi.tooltip.getBoundingClientRect();
    const gap = 16;
    const belowTop = triggerRect.bottom + gap;
    const fitsBelow = belowTop + tooltipRect.height <= innerHeight - 8;
    currentUi.tooltip.dataset.side = fitsBelow ? 'below' : 'above';
    const top = fitsBelow
      ? belowTop
      : Math.max(8, triggerRect.top - gap - tooltipRect.height);
    const left = Math.max(8, Math.min(
      innerWidth - tooltipRect.width - 8,
      triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
    ));
    currentUi.tooltip.style.left = `${left}px`;
    currentUi.tooltip.style.top = `${top}px`;
  }

  function hideTooltip(immediate = false) {
    clearTimeout(tooltipTimer);
    clearTimeout(tooltipHideTimer);
    if (!currentUi) return;
    currentUi.tooltip.dataset.visible = 'false';
    if (immediate) {
      currentUi.tooltip.hidden = true;
      return;
    }
    tooltipHideTimer = setTimeout(() => {
      if (currentUi) currentUi.tooltip.hidden = true;
    }, 90);
  }

  function queueTooltip() {
    clearTimeout(tooltipTimer);
    clearTimeout(tooltipHideTimer);
    if (!currentUi || !currentUi.panel.hidden) return;
    if (currentUi && !currentUi.tooltip.hidden) {
      currentUi.tooltip.dataset.visible = 'true';
      return;
    }
    currentUi.tooltip.hidden = false;
    positionCurrentTooltip();
    requestAnimationFrame(() => {
      if (currentUi && !currentUi.tooltip.hidden) currentUi.tooltip.dataset.visible = 'true';
    });
  }

  function createUi() {
    const host = document.createElement('span');
    host.id = 'still-youtube-download-host';
    host.style.setProperty('display', 'inline-flex', 'important');
    host.style.setProperty('flex', '0 0 auto', 'important');
    host.style.setProperty('margin-inline-start', '8px', 'important');
    host.style.setProperty('margin-inline-end', '0', 'important');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display:inline-flex;position:relative;flex:0 0 auto;min-width:max-content;margin-inline:8px 0;overflow:visible;vertical-align:middle;color-scheme:light dark;font-family:var(--still-action-font,Roboto,Arial,sans-serif);--menu-bg:#fff;--menu-text:#0f0f0f;--menu-secondary:#606060;--menu-hover:rgba(0,0,0,.1);--menu-divider:rgba(0,0,0,.1) }
      :host([data-theme='dark']) { color-scheme:dark;--menu-bg:#282828;--menu-text:#f1f1f1;--menu-secondary:#aaa;--menu-hover:rgba(255,255,255,.2);--menu-divider:rgba(255,255,255,.12) }
      * { box-sizing:border-box }
      .trigger { position:relative;height:var(--still-action-height,40px);min-width:0;overflow:hidden;border:0;border-radius:var(--still-action-radius,20px);padding:var(--still-action-padding,0 16px);display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;font-family:var(--still-action-font,Roboto,Arial,sans-serif);font-size:var(--still-action-size,14px);font-weight:var(--still-action-weight,500);line-height:var(--still-action-line-height,40px);letter-spacing:normal;color:var(--still-action-color,var(--yt-spec-text-primary,#0f0f0f));background:var(--still-action-bg,var(--yt-sys-color-baseline--overlay-button-secondary,rgba(0,0,0,.1)));white-space:nowrap;appearance:none;transition:all }
      .trigger::before { content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(rgba(255,255,255,.028),transparent 75%);box-shadow:inset 0 .5px 0 rgba(255,255,255,.13) }
      .trigger::after { content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:currentColor;opacity:0 }
      .trigger:hover { background:var(--still-action-hover,var(--yt-sys-color-baseline--mono-tonal-hover,rgba(0,0,0,.2))) }
      .trigger:active::after { opacity:.1 }
      .trigger:focus-visible { outline:2px solid var(--yt-spec-call-to-action,#3ea6ff);outline-offset:2px }
      .trigger[data-state='error'] { color:var(--yt-spec-call-to-action,#3ea6ff);background:transparent;box-shadow:inset 0 0 0 1px currentColor }
      .trigger-label { font:inherit;letter-spacing:inherit }
      .trigger svg { width:24px;height:24px;fill:currentColor }
      .trigger > svg { fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round }
      .panel { position:fixed;z-index:2147483647;width:232px;max-height:min(420px,calc(100vh - 24px));padding:8px 0;overflow:auto;border:0;border-radius:12px;color:var(--menu-text);background:var(--menu-bg);box-shadow:0 4px 32px rgba(0,0,0,.1);font-family:Roboto,Noto,Arial,sans-serif;scrollbar-width:thin;transform-origin:bottom left;animation:menu-in 120ms cubic-bezier(.2,0,0,1) both }
      .panel[hidden] { display:none }
      @keyframes menu-in { from { opacity:0;transform:scale(.96) translateY(-4px) } to { opacity:1;transform:scale(1) translateY(0) } }
      h3,.section-label { display:none }
      .choices { display:grid;grid-template-columns:1fr;gap:0 }
      .choices.audio,.choices.thumbnail { margin-top:4px;padding-top:4px;border-top:1px solid var(--menu-divider) }
      .choice { width:100%;height:36px;min-height:36px;padding:0 16px;border:0;border-radius:0;display:flex;align-items:center;gap:12px;cursor:pointer;text-align:left;color:var(--menu-text);background:transparent;font:400 16px/24px Roboto,Noto,Arial,sans-serif;transition:background-color 80ms ease }
      .choice:hover { background:var(--menu-hover) }
      .choice:active { background:var(--menu-hover) }
      .choice:focus-visible { outline:2px solid var(--yt-spec-call-to-action,#3ea6ff);outline-offset:-2px }
      .choice-icon { width:24px;height:24px;flex:0 0 24px;fill:currentColor }
      .choice:disabled { opacity:.45;cursor:default }
      .track { display:none;height:3px;margin:10px 12px 0;overflow:hidden;border-radius:2px;background:var(--menu-divider) }
      .bar { width:0;height:100%;border-radius:inherit;background:#3ea6ff;transition:width 180ms ease }
      .status { display:none;min-height:16px;margin:8px 12px 6px;overflow-wrap:anywhere;color:var(--menu-secondary);font-size:12px;line-height:16px }
      .panel[data-status='true'] .track,.panel[data-status='true'] .status { display:block }
      .status[data-kind='success'] { color:#2ba640 }
      .status[data-kind='error'] { color:#ff4e45 }
      .folder { display:none }
      .tooltip { position:fixed;z-index:2147483647;padding:8px;border-radius:4px;pointer-events:none;white-space:nowrap;color:#fff;background:#606060;font:400 12px/18px Roboto,Arial,sans-serif;opacity:0;transition:opacity 110ms ease-out }
      .tooltip[data-visible='true'] { opacity:.9 }
      .tooltip[hidden] { display:none }
    `;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'trigger';
    trigger.setAttribute('aria-label', 'Download this video');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 24 24');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3');
    svg.appendChild(iconPath);
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'trigger-label';
    triggerLabel.textContent = 'Download';
    trigger.append(svg, triggerLabel);

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    panel.dataset.status = 'false';
    const heading = document.createElement('h3');
    heading.textContent = 'Download';
    panel.appendChild(heading);

    function appendChoices(sectionTitle, choices) {
      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'section-label';
      sectionLabel.textContent = sectionTitle;
      const row = document.createElement('div');
      row.className = `choices ${choices[0]?.mode || ''}`;
      for (const choice of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice';
        button.dataset.mode = choice.mode;
        button.dataset.option = choice.option;
        const choiceIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        choiceIcon.setAttribute('class', 'choice-icon');
        choiceIcon.setAttribute('aria-hidden', 'true');
        choiceIcon.setAttribute('viewBox', '0 0 24 24');
        const choicePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        choicePath.setAttribute('d', choice.mode === 'audio'
          ? 'M12 3v10.55A4 4 0 1 0 14 17V7h5V3h-7Z'
          : choice.mode === 'thumbnail'
            ? 'M4 4h16v16H4V4Zm2 2v9.17l2.59-2.58L11 15l3.59-3.59L18 14.83V6H6Zm2.5 1.5A1.5 1.5 0 1 1 7 9a1.5 1.5 0 0 1 1.5-1.5Z'
            : 'M4 5h16v14H4V5Zm2 2v10h12V7H6Zm4 2 5 3-5 3V9Z');
        choiceIcon.appendChild(choicePath);
        const choiceLabel = document.createElement('span');
        choiceLabel.textContent = choice.label;
        button.append(choiceIcon, choiceLabel);
        row.appendChild(button);
      }
      panel.append(sectionLabel, row);
    }

    appendChoices('Video · maximum resolution', [
      { mode: 'video', option: 'best', label: 'Best' },
      { mode: 'video', option: '2160', label: '4K' },
      { mode: 'video', option: '1440', label: '1440p' },
      { mode: 'video', option: '1080', label: '1080p' },
      { mode: 'video', option: '720', label: '720p' },
      { mode: 'video', option: '480', label: '480p' },
      { mode: 'video', option: '360', label: '360p' }
    ]);
    appendChoices('Audio', [
      { mode: 'audio', option: 'mp3', label: 'MP3' },
      { mode: 'audio', option: 'm4a', label: 'M4A' }
    ]);
    appendChoices('Thumbnail', [
      { mode: 'thumbnail', option: 'jpg', label: 'Thumbnail' }
    ]);

    const track = document.createElement('div');
    track.className = 'track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    track.appendChild(bar);
    const statusText = document.createElement('div');
    statusText.className = 'status';
    statusText.textContent = 'Choose a format to save it.';
    const folder = document.createElement('div');
    folder.className = 'folder';
    folder.textContent = 'Saves to your Downloads folder';
    panel.append(track, statusText, folder);
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = 'Download';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    root.append(style, trigger, panel, tooltip);
    currentUi = {
      host,
      root,
      trigger,
      panel,
      tooltip,
      status: root.querySelector('.status'),
      bar: root.querySelector('.bar')
    };
    const syncTheme = () => {
      const dark = document.documentElement.hasAttribute('dark')
        || document.documentElement.getAttribute('data-theme') === 'dark'
        || document.body?.classList.contains('dark')
        || matchMedia('(prefers-color-scheme: dark)').matches;
      host.dataset.theme = dark ? 'dark' : 'light';
    };
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['dark', 'data-theme', 'class']
    });
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideTooltip(true);
      const opening = panel.hidden;
      panel.hidden = !opening;
      if (opening) positionCurrentPanel();
    });
    trigger.addEventListener('mouseenter', queueTooltip);
    trigger.addEventListener('mouseleave', () => hideTooltip());
    trigger.addEventListener('focus', queueTooltip);
    trigger.addEventListener('blur', () => hideTooltip());
    root.querySelectorAll('.choice').forEach((choice) => {
      choice.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectFormat(choice.dataset.mode, choice.dataset.option);
      });
    });
    return host;
  }

  function findActionPlacement() {
    const rows = [...document.querySelectorAll(
      'ytd-watch-metadata #actions #top-level-buttons-computed, #actions #top-level-buttons-computed'
    )];
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || rows[0];
    if (!row) return null;
    const buttons = [...row.querySelectorAll('button')];
    const description = (button) => `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`;
    const saveButton = buttons.find((button) => /save|speichern|playlist/i.test(description(button)));
    const shareButton = buttons.find((button) => /share|teilen/i.test(description(button)));
    const directChildFor = (element) => {
      let child = element;
      while (child?.parentElement && child.parentElement !== row) child = child.parentElement;
      return child?.parentElement === row ? child : null;
    };
    const saveItem = directChildFor(saveButton);
    if (saveItem) return { row, before: saveItem };
    const shareItem = directChildFor(shareButton);
    if (shareItem) return { row, before: shareItem.nextSibling };
    return null;
  }

  function mount() {
    clearTimeout(mountTimer);
    const existing = document.querySelector('#still-youtube-download-host');
    if (!isWatchPage()) {
      existing?.remove();
      currentUi = null;
      return;
    }
    const placement = findActionPlacement();
    if (!placement) return;
    const host = currentUi?.host || (existing?.isConnected ? existing : null) || createUi();
    if (host.parentElement !== placement.row || host.nextSibling !== placement.before) {
      placement.row.insertBefore(host, placement.before);
    }
    requestAnimationFrame(() => syncNativeActionStyle(host, currentUi?.trigger));
  }

  function scheduleMount() {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(mount, 120);
  }

  window.__stillDownloadUi = {
    version: UI_VERSION,
    mount,
    destroy() {
      clearTimeout(mountTimer);
      clearTimeout(tooltipTimer);
      clearTimeout(tooltipHideTimer);
      window.removeEventListener('still-download-progress', handleProgress);
      currentUi?.host.remove();
      currentUi = null;
    }
  };
  window.addEventListener('still-download-progress', handleProgress);
  document.addEventListener('click', (event) => {
    if (currentUi && event.target !== currentUi.host && !currentUi.host.contains(event.target)) {
      currentUi.panel.hidden = true;
    }
  }, true);
  document.addEventListener('yt-navigate-finish', scheduleMount);
  window.addEventListener('resize', positionCurrentPanel);
  window.addEventListener('resize', positionCurrentTooltip);
  window.addEventListener('scroll', positionCurrentPanel, true);
  window.addEventListener('scroll', positionCurrentTooltip, true);
  new MutationObserver(() => {
    if (!isWatchPage()) return;
    const placement = findActionPlacement();
    if (!currentUi?.host?.isConnected || (placement && currentUi.host.parentElement !== placement.row)) {
      scheduleMount();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  mount();
})();
