(() => {
  const VERSION = 19;
  const existing = window.__stillLearningFilter;
  if (existing?.version === VERSION) {
    existing.update(window.__stillLearningFilterConfig || {});
    return;
  }
  existing?.destroy?.();

  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-grid-video-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model'
  ].join(',');
  const AD_SELECTOR = 'ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-in-feed-ad-layout-renderer';
  let config = { enabled: [], musicChannels: [] };
  let allowedIds = new Set();
  let allowedNames = new Set();
  let scanTimer;
  let cinemaTimer;
  let cinemaVideoKey = '';
  let observer;

  const OLED_VARIABLES = [
    '--yt-spec-base-background',
    '--yt-spec-brand-background-solid',
    '--yt-spec-brand-background-primary',
    '--yt-spec-brand-background-secondary',
    '--yt-spec-general-background-a',
    '--yt-spec-general-background-b',
    '--yt-spec-general-background-c',
    '--yt-spec-raised-background',
    '--yt-spec-menu-background',
    '--yt-spec-additive-background',
    '--ytd-searchbox-background'
  ];

  function applyOledTheme() {
    const root = document.documentElement;
    const watchPage = location.pathname === '/watch' && Boolean(new URLSearchParams(location.search).get('v'));
    root.classList.toggle('still-youtube-watch-cinema', watchPage);
    root.style.setProperty('color-scheme', 'dark', 'important');
    root.style.setProperty('scrollbar-color', '#000000 #000000', 'important');
    OLED_VARIABLES.forEach((variable) => root.style.setProperty(variable, '#000000', 'important'));
    root.style.setProperty('--yt-spec-text-primary', '#f1f1f1', 'important');
    root.style.setProperty('--yt-spec-text-secondary', '#aaaaaa', 'important');

    let style = document.querySelector('#still-youtube-oled-theme');
    if (!style) {
      style = document.createElement('style');
      style.id = 'still-youtube-oled-theme';
      (document.head || root).appendChild(style);
    }
    if (style.dataset.stillVersion !== String(VERSION)) {
      style.dataset.stillVersion = String(VERSION);
      style.textContent = `
        html, body, ytd-app, #content.ytd-app, ytd-page-manager,
        ytd-browse, ytd-watch-flexy, ytd-search, ytd-shorts,
        ytd-two-column-browse-results-renderer, ytd-two-column-search-results-renderer,
        ytd-watch-flexy > #columns, ytd-watch-flexy > #columns > #primary,
        ytd-watch-flexy > #columns > #secondary, #guide-content,
        ytd-mini-guide-renderer, tp-yt-app-drawer, ytd-masthead,
        ytd-masthead #background, ytd-masthead #container,
        ytd-feed-filter-chip-bar-renderer, #chips-wrapper {
          background-color: #000000 !important;
          background: #000000 !important;
        }
        html { scrollbar-color: #000000 #000000 !important; }
        ::-webkit-scrollbar,
        ::-webkit-scrollbar-track,
        ::-webkit-scrollbar-track-piece,
        ::-webkit-scrollbar-thumb,
        ::-webkit-scrollbar-corner {
          background: #000000 !important;
          background-color: #000000 !important;
          border-color: #000000 !important;
          box-shadow: none !important;
        }

        /* A focused, edge-to-edge watch layout. The page below the video begins
           after a full viewport, so descriptions and comments cannot peek in. */
        html.still-youtube-watch-cinema {
          --still-watch-header-height: 0px;
          --still-player-lab-height: 94vh;
          --still-watch-stage-height: min(
            var(--still-player-lab-height),
            calc(100dvh - 88px),
            56.25vw
          );
          --ytd-masthead-height: var(--still-watch-header-height) !important;
          --ytd-toolbar-height: var(--still-watch-header-height) !important;
        }
        html.still-youtube-watch-cinema ytd-masthead,
        html.still-youtube-watch-cinema ytd-masthead #container,
        html.still-youtube-watch-cinema #masthead-container {
          height: var(--still-watch-header-height) !important;
          min-height: var(--still-watch-header-height) !important;
          max-height: var(--still-watch-header-height) !important;
        }
        html.still-youtube-watch-cinema ytd-masthead,
        html.still-youtube-watch-cinema #masthead-container {
          display: none !important;
        }
        html.still-youtube-watch-cinema ytd-page-manager,
        html.still-youtube-watch-cinema ytd-watch-flexy {
          margin-top: 0 !important;
          padding-top: 0 !important;
        }
        html.still-youtube-watch-cinema ytd-masthead #center,
        html.still-youtube-watch-cinema ytd-masthead #search-container,
        html.still-youtube-watch-cinema ytd-masthead ytd-searchbox,
        html.still-youtube-watch-cinema ytd-masthead yt-searchbox-view-model,
        html.still-youtube-watch-cinema ytd-masthead [role='search'],
        html.still-youtube-watch-cinema ytd-masthead #voice-search-button {
          display: none !important;
        }
        html.still-youtube-watch-cinema ytd-masthead #start {
          flex: 0 0 auto !important;
          min-width: 0 !important;
        }
        html.still-youtube-watch-cinema ytd-masthead #end {
          margin-left: auto !important;
        }
        html.still-youtube-watch-cinema ytd-topbar-logo-renderer,
        html.still-youtube-watch-cinema ytd-masthead #masthead-logo {
          display: block !important;
          width: 32px !important;
          min-width: 32px !important;
          max-width: 32px !important;
          overflow: hidden !important;
        }
        html.still-youtube-watch-cinema ytd-topbar-logo-renderer #logo-icon,
        html.still-youtube-watch-cinema ytd-masthead #masthead-logo > svg {
          width: 93px !important;
          min-width: 93px !important;
          max-width: none !important;
        }
        html.still-youtube-watch-cinema ytd-masthead #country-code {
          display: none !important;
        }
        html.still-youtube-watch-cinema ytd-watch-flexy[theater] #player-theater-container,
        html.still-youtube-watch-cinema ytd-watch-flexy[full-bleed-player] #full-bleed-container,
        html.still-youtube-watch-cinema ytd-watch-flexy[full-bleed-player] #player-full-bleed-container {
          box-sizing: border-box !important;
          height: var(--still-watch-stage-height) !important;
          min-height: var(--still-watch-stage-height) !important;
          max-height: none !important;
          background: #000000 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-flexy[theater] #player-theater-container #player-container,
        html.still-youtube-watch-cinema ytd-watch-flexy[theater] #player-theater-container #movie_player,
        html.still-youtube-watch-cinema ytd-watch-flexy[full-bleed-player] #full-bleed-container #movie_player,
        html.still-youtube-watch-cinema ytd-watch-flexy[full-bleed-player] #player-full-bleed-container #movie_player {
          height: 100% !important;
          max-height: none !important;
        }
        /* The companion UI measures the decoded frame and sets these values
           to its largest undistorted fit. A full-size video box with contain
           would paint opaque internal bars over the edge-fill canvas. */
        html.still-youtube-watch-cinema ytd-watch-flexy[theater] #movie_player:not(.ytp-fullscreen) video.html5-main-video,
        html.still-youtube-watch-cinema ytd-watch-flexy[full-bleed-player] #movie_player:not(.ytp-fullscreen) video.html5-main-video,
        html.still-youtube-watch-cinema body > #player.flexy #movie_player:not(.ytp-fullscreen) video.html5-main-video {
          left: var(--still-video-left, 0px) !important;
          top: var(--still-video-top, 0px) !important;
          width: var(--still-video-width, 100%) !important;
          height: var(--still-video-height, var(--still-watch-stage-height)) !important;
          object-fit: var(--still-video-fit, contain) !important;
        }
        /* The stage cap is for the watch page only. HTML fullscreen must use
           the entire screen, even while theater mode remains set. */
        html.still-youtube-watch-cinema ytd-watch-flexy #player-theater-container #movie_player.ytp-fullscreen,
        html.still-youtube-watch-cinema ytd-watch-flexy #full-bleed-container #movie_player.ytp-fullscreen,
        html.still-youtube-watch-cinema #movie_player:fullscreen,
        html.still-youtube-watch-cinema #movie_player.ytp-fullscreen {
          width: 100vw !important;
          height: 100dvh !important;
          min-height: 100dvh !important;
          max-height: 100dvh !important;
          background: #000 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-flexy:has(#movie_player.ytp-fullscreen) #player-theater-container,
        html.still-youtube-watch-cinema ytd-watch-flexy:has(#movie_player.ytp-fullscreen) #player-container,
        html.still-youtube-watch-cinema ytd-watch-flexy:has(#movie_player.ytp-fullscreen) #full-bleed-container {
          width: 100vw !important;
          height: 100dvh !important;
          min-height: 100dvh !important;
          max-height: 100dvh !important;
        }
        html.still-youtube-watch-cinema ytd-watch-flexy #cinematics,
        html.still-youtube-watch-cinema ytd-watch-flexy ytd-cinematic-container-renderer,
        html.still-youtube-watch-cinema #movie_player .ytp-ambient-light {
          display: none !important;
        }
        html.still-youtube-watch-cinema ytd-watch-flexy[theater] > #columns,
        html.still-youtube-watch-cinema ytd-watch-flexy[full-bleed-player] > #columns {
          margin-top: 0 !important;
        }

        /* YouTube's lightweight/legacy watch shell uses these direct children. */
        html.still-youtube-watch-cinema body > #player.flexy,
        html.still-youtube-watch-cinema body > #player.skeleton {
          box-sizing: border-box !important;
          height: var(--still-watch-stage-height) !important;
          min-height: var(--still-watch-stage-height) !important;
          max-height: none !important;
          background: #000000 !important;
        }
        html.still-youtube-watch-cinema body > #player.flexy #player-wrap,
        html.still-youtube-watch-cinema body > #player.flexy #player-api,
        html.still-youtube-watch-cinema body > #player.flexy #movie_player,
        html.still-youtube-watch-cinema body > #player.skeleton #player-wrap,
        html.still-youtube-watch-cinema body > #player.skeleton #player-api,
        html.still-youtube-watch-cinema body > #player.skeleton #movie_player {
          height: 100% !important;
          max-height: none !important;
        }

        /* One low cinema rail under the player. All native controls retain
           their behavior; only their spacing and grouping change. */
        html.still-youtube-watch-cinema ytd-watch-metadata {
          box-sizing: border-box !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          padding: 0 12px !important;
          container-type: inline-size;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #above-the-fold {
          box-sizing: border-box !important;
          padding: 2px 0 3px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #title-row,
        html.still-youtube-watch-cinema ytd-watch-metadata #title,
        html.still-youtube-watch-cinema ytd-watch-metadata #title h1 {
          min-width: 0 !important;
          margin: 0 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #title h1 {
          overflow: hidden !important;
          font-size: 16px !important;
          line-height: 19px !important;
          white-space: nowrap !important;
          text-overflow: ellipsis !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #top-row {
          min-height: 34px !important;
          margin-top: 0 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #owner,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions-inner {
          min-height: 34px !important;
          height: 34px !important;
          align-items: center !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer {
          min-height: 34px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer #avatar,
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer #avatar img,
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer yt-img-shadow {
          width: 32px !important;
          height: 32px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer #upload-info {
          margin-left: 8px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer #channel-name {
          line-height: 16px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata ytd-video-owner-renderer #owner-sub-count {
          font-size: 11px !important;
          line-height: 13px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #subscribe-button button,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions button,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-shape button {
          min-height: 32px !important;
          height: 32px !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #actions-inner {
          box-sizing: border-box !important;
          width: max-content !important;
          min-width: 0 !important;
          flex: 0 0 auto !important;
          margin-left: auto !important;
          gap: 0 !important;
          padding: 0 !important;
          overflow: visible !important;
          border: 0 !important;
          border-radius: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #actions #top-level-buttons-computed,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions #flexible-item-buttons {
          gap: 0 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #actions button,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-shape button {
          border-radius: 16px !important;
          background: transparent !important;
          background-image: none !important;
          box-shadow: none !important;
          filter: none !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #actions button::before,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions button::after,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-shape button::before,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-shape button::after,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-view-model::before,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-view-model::after,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-touch-feedback-shape {
          background: transparent !important;
          background-image: none !important;
          box-shadow: none !important;
          opacity: 0 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #actions #actions-inner::before,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions #actions-inner::after {
          content: none !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #actions button:hover,
        html.still-youtube-watch-cinema ytd-watch-metadata #actions yt-button-shape button:hover {
          background: #242424 !important;
        }
        html.still-youtube-watch-cinema ytd-watch-metadata #bottom-row {
          margin-top: 8px !important;
        }

        @container (min-width: 1050px) {
          html.still-youtube-watch-cinema ytd-watch-metadata #above-the-fold {
            display: grid !important;
            grid-template-columns: minmax(0, 1fr) auto !important;
            grid-template-areas:
              'title title'
              'owner actions'
              'bottom bottom' !important;
            column-gap: 18px !important;
            row-gap: 0 !important;
            align-items: center !important;
          }
          html.still-youtube-watch-cinema ytd-watch-metadata #title-row {
            grid-area: title !important;
          }
          html.still-youtube-watch-cinema ytd-watch-metadata #top-row {
            display: contents !important;
            min-height: 34px !important;
            margin: 0 !important;
          }
          html.still-youtube-watch-cinema ytd-watch-metadata #owner {
            grid-area: owner !important;
          }
          html.still-youtube-watch-cinema ytd-watch-metadata #actions {
            grid-area: actions !important;
          }
          html.still-youtube-watch-cinema ytd-watch-metadata #middle-row {
            display: none !important;
          }
          html.still-youtube-watch-cinema ytd-watch-metadata #bottom-row {
            grid-area: bottom !important;
          }
        }
      `;
    }
  }

  function ensureCinemaMode() {
    clearTimeout(cinemaTimer);
    const videoId = location.pathname === '/watch'
      ? new URLSearchParams(location.search).get('v') || ''
      : '';
    if (!videoId) {
      cinemaVideoKey = '';
      return;
    }
    if (cinemaVideoKey === videoId) return;

    const watchFlexy = document.querySelector('ytd-watch-flexy');
    const alreadyCinema = watchFlexy?.hasAttribute('theater')
      || watchFlexy?.hasAttribute('full-bleed-player')
      || document.body.classList.contains('watch-wide');
    if (alreadyCinema) {
      cinemaVideoKey = videoId;
      return;
    }

    const theaterButton = [...document.querySelectorAll('.ytp-size-button')]
      .find((button) => button.getBoundingClientRect().width > 0);
    if (!theaterButton) {
      cinemaTimer = setTimeout(ensureCinemaMode, 250);
      return;
    }
    cinemaVideoKey = videoId;
    theaterButton.click();
  }

  function identity(value) {
    return String(value || '')
      .normalize('NFKD')
      .toLocaleLowerCase()
      .replace(/^@/, '')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function feedMode() {
    try {
      const value = localStorage.getItem('still-youtube-feed-mode');
      return ['normal', 'selective', 'music', 'subscriptions'].includes(value) ? value : 'selective';
    } catch {
      return 'selective';
    }
  }

  function syncAllowedChannels() {
    const channels = feedMode() === 'music' ? config.musicChannels : config.enabled;
    allowedIds = new Set(channels.map((channel) => channel.id));
    allowedNames = new Set(channels.map((channel) => identity(channel.name)).filter(Boolean));
  }

  function filterActive() {
    return ['selective', 'music'].includes(feedMode()) && (
      location.pathname === '/feed/subscriptions'
      || location.pathname === '/watch'
    );
  }

  function isNestedCard(card) {
    const parentCard = card.parentElement?.closest(CARD_SELECTOR);
    return Boolean(parentCard);
  }

  function channelIdentities(card) {
    const ids = new Set();
    const names = new Set();
    for (const anchor of card.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.origin); } catch { continue; }
      if (url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') continue;
      const channelId = url.pathname.match(/^\/channel\/(UC[\w-]{22})/i)?.[1];
      const isChannelPath = Boolean(channelId)
        || /^\/(?:@|c\/|user\/)/i.test(url.pathname);
      if (!isChannelPath) continue;
      if (channelId) ids.add(channelId);
      for (const value of [anchor.textContent, anchor.getAttribute('aria-label'), anchor.getAttribute('title')]) {
        const normalized = identity(value);
        if (normalized) names.add(normalized);
      }
    }
    for (const element of card.querySelectorAll('#channel-name, ytd-channel-name, .ytd-channel-name, [class*="byline"]')) {
      const normalized = identity(element.textContent);
      if (normalized) names.add(normalized);
    }
    return { ids, names };
  }

  function reveal(card) {
    if (card.dataset.stillLearningHidden === 'true') card.style.removeProperty('display');
    card.dataset.stillLearningHidden = 'false';
    card.dataset.stillLearningChannel = 'allowed';
  }

  function hide(card) {
    card.style.setProperty('display', 'none', 'important');
    card.dataset.stillLearningHidden = 'true';
    card.dataset.stillLearningChannel = 'blocked';
  }

  function restore(card) {
    if (card.dataset.stillLearningHidden === 'true') card.style.removeProperty('display');
    delete card.dataset.stillLearningHidden;
    delete card.dataset.stillLearningChannel;
  }

  function cardAllowed(card) {
    const { ids, names } = channelIdentities(card);
    return [...ids].some((id) => allowedIds.has(id))
      || [...names].some((name) => allowedNames.has(name));
  }

  function scan() {
    clearTimeout(scanTimer);
    syncAllowedChannels();
    applyOledTheme();
    ensureCinemaMode();
    const active = filterActive();
    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      if (isNestedCard(card)) return;
      if (!active) restore(card);
      else if (cardAllowed(card)) reveal(card);
      else hide(card);
    });
    document.querySelectorAll(AD_SELECTOR).forEach((ad) => {
      if (active) hide(ad);
      else restore(ad);
    });
  }

  function scheduleScan(delay = 60) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function update(nextConfig) {
    applyOledTheme();
    config = {
      enabled: Array.isArray(nextConfig?.enabled)
        ? nextConfig.enabled.filter((channel) => /^UC[\w-]{22}$/.test(channel?.id) && String(channel?.name || '').trim()).slice(0, 40)
        : [],
      musicChannels: Array.isArray(nextConfig?.musicChannels)
        ? nextConfig.musicChannels.filter((channel) => /^UC[\w-]{22}$/.test(channel?.id) && String(channel?.name || '').trim()).slice(0, 80)
        : []
    };
    scan();
  }

  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('yt-navigate-finish', () => scheduleScan(0));
  window.addEventListener('popstate', () => scheduleScan(0));
  window.addEventListener('still-youtube-mode-change', () => scheduleScan(0));
  window.__stillLearningFilter = {
    version: VERSION,
    update,
    destroy() {
      clearTimeout(scanTimer);
      clearTimeout(cinemaTimer);
      observer?.disconnect();
      document.documentElement.classList.remove('still-youtube-watch-cinema');
      document.querySelectorAll(CARD_SELECTOR).forEach(restore);
      document.querySelectorAll(AD_SELECTOR).forEach(restore);
      document.querySelector('#still-learning-filter-status')?.remove();
    }
  };
  update(window.__stillLearningFilterConfig || {});
})();
