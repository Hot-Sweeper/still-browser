(() => {
  const VERSION = 23;
  const existing = window.__stillYouTubeHome;
  if (existing?.version === VERSION) {
    existing.update(window.__stillLearningFilterConfig || {});
    return;
  }
  existing?.destroy?.();

  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-grid-video-renderer',
    'ytd-video-renderer',
    'yt-lockup-view-model'
  ].join(',');
  const AI_TERMS = /(?:\bai\b|artificial intelligence|machine learning|deep learning|\bllm(?:s)?\b|large language model|openai|anthropic|claude|chatgpt|\bgpt[-\s]?\d|gemini|gemma|google deepmind|qwen|mistral|llama|deepseek|hugging face|transformers?|diffusion|stable diffusion|flux|comfyui|ollama|local ai|local llm|lm studio|vllm|agentic|ai agent|computer use|multimodal|vision model|text.to.video|image generation|robotics|neural network)/i;
  const nativePicks = new Map();
  const pageDataCache = new Map();
  const pageDataJobs = new Map();
  const channelAvatarCache = new Map();
  const channelAvatarJobs = new Map();
  const badAvatarUrls = new Set();
  const MUSIC_RELEASE = /\b(?:official\s+(?:music\s+)?(?:video|audio|visualizer)|music\s+video|lyric(?:s)?\s+video|visualizer|full\s+album|new\s+single)\b/i;
  const MUSIC_CHANNEL = /(?:\s-\sTopic|\bVEVO\b|\bRecords\b|\bMusic\b|\bSounds\b)$/i;
  const NOT_A_SONG = /\b(?:tutorial|review|reaction|breakdown|how\s+to|podcast|interview|behind\s+the\s+scenes)\b/i;
  let config = {
    enabled: [],
    musicChannels: [],
    homeFeed: { videos: [], failed: [], loading: true },
    musicHomeFeed: { videos: [], failed: [], loading: true }
  };
  let observer;
  let destroyed = false;
  let renderTimer;
  let renderedSignature = '';
  let lastChannelLoadRequest = 0;
  let lastHomeLoadRequest = 0;
  let nativeDataUrl = location.href;
  let subscriptionVideos = [];
  let subscriptionState = 'idle';
  let subscriptionUpdatedAt = 0;
  let musicHistoryChannels = new Map();
  let personalMusicVideos = [];
  let musicDiscoveryState = 'idle';
  let mutedColors = false;
  let feedMode = 'selective';
  try { mutedColors = localStorage.getItem('still-youtube-muted-colors') === 'true'; } catch {}
  try {
    const storedMode = localStorage.getItem('still-youtube-feed-mode');
    if (['normal', 'selective', 'music', 'subscriptions'].includes(storedMode)) feedMode = storedMode;
  } catch {}
  if (window.ytInitialData) pageDataCache.set(location.href, window.ytInitialData);

  function isHome() {
    return location.pathname === '/';
  }

  function isChannel() {
    return /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/|$)/i.test(location.pathname);
  }

  function isSearch() {
    return location.pathname === '/results' && Boolean(new URLSearchParams(location.search).get('search_query'));
  }

  function isCustomRoute(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return false;
      return url.pathname === '/'
        || (url.pathname === '/results' && Boolean(url.searchParams.get('search_query')))
        || /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|shorts|streams))?\/?$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function routeData() {
    return pageDataCache.get(location.href)
      || (nativeDataUrl === location.href ? window.ytInitialData : null)
      || null;
  }

  function assignedJson(html) {
    const markers = ['var ytInitialData =', 'window["ytInitialData"] =', "window['ytInitialData'] =", 'ytInitialData ='];
    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex < 0) continue;
      const start = html.indexOf('{', markerIndex + marker.length);
      if (start < 0) continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < html.length; index += 1) {
        const character = html[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) {
          try { return JSON.parse(html.slice(start, index + 1)); } catch { break; }
        }
      }
    }
    return null;
  }

  function fetchRouteData(value) {
    const url = new URL(value, location.origin).href;
    if (pageDataCache.has(url)) return Promise.resolve(pageDataCache.get(url));
    if (pageDataJobs.has(url)) return pageDataJobs.get(url);
    const job = fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    }).then((response) => {
      if (!response.ok) throw new Error(`YouTube returned ${response.status}`);
      return response.text();
    }).then((html) => {
      const data = assignedJson(html);
      if (!data) throw new Error('YouTube page data was missing');
      pageDataCache.set(url, data);
      if (pageDataCache.size > 14) pageDataCache.delete(pageDataCache.keys().next().value);
      return data;
    }).finally(() => pageDataJobs.delete(url));
    pageDataJobs.set(url, job);
    return job;
  }

  function ensureRouteData() {
    if (isHome() || routeData() || (!isChannel() && !isSearch())) return;
    const requestedUrl = location.href;
    fetchRouteData(requestedUrl).then(() => {
      if (location.href !== requestedUrl) return;
      renderedSignature = '';
      renderHome();
    }).catch(() => {
      if (location.href !== requestedUrl) return;
      renderedSignature = '';
      renderHome();
    });
  }

  function customNavigate(value, { replace = false } = {}) {
    const url = new URL(value, location.origin);
    if (!isCustomRoute(url.href)) {
      location.href = url.href;
      return;
    }
    if (url.href !== location.href) {
      history[replace ? 'replaceState' : 'pushState']({ stillYouTubeRoute: true }, '', url.href);
    }
    renderedSignature = '';
    renderHome();
    ensureRouteData();
  }

  function handleCustomLinkClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.('#still-youtube-home a[href],#still-youtube-search a[href],#still-youtube-channel a[href]');
    if (!anchor || anchor.target === '_blank' || !isCustomRoute(anchor.href)) return;
    event.preventDefault();
    event.stopPropagation();
    customNavigate(anchor.href);
  }

  function handleNativeNavigateFinish() {
    if (location.pathname === '/' && nativeDataUrl !== location.href) nativePicks.clear();
    nativeDataUrl = location.href;
    if (window.ytInitialData) pageDataCache.set(location.href, window.ytInitialData);
    scheduleRender(0);
  }

  function handleHistoryChange() {
    renderedSignature = '';
    renderHome();
    ensureRouteData();
  }

  function cleanText(value, limit = 300) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function normalize(value) {
    return cleanText(value).normalize('NFKD').toLocaleLowerCase().replace(/^@/, '').replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function compactViews(count) {
    const scales = [
      [1e9, 'Mrd.'],
      [1e6, 'Mio.'],
      [1e3, 'K']
    ];
    const scale = scales.find(([threshold]) => count >= threshold);
    if (!scale) return new Intl.NumberFormat().format(count);
    const value = count / scale[0];
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 100 ? 1 : 0 }).format(value)}${scale[1]}`;
  }

  function compactViewPart(part) {
    const match = cleanText(part).match(/^(\d[\d.,\s]*?)\s*(thousand|million|billion|mio\.?|mrd\.?|[kmb])?\s+(views?|aufrufe)$/i);
    if (!match) return part;
    const multiplier = {
      thousand: 1e3, k: 1e3, million: 1e6, mio: 1e6,
      billion: 1e9, mrd: 1e9, m: 1e6, b: 1e9
    }[match[2]?.toLowerCase().replace(/\.$/, '')] || 1;
    const number = multiplier === 1
      ? Number(match[1].replace(/[^\d]/g, ''))
      : Number(match[1].replace(/\s/g, '').replace(',', '.')) * multiplier;
    return Number.isFinite(number) ? `${compactViews(number)} ${match[3]}` : part;
  }

  function cleanVideoMeta(value, channel) {
    const seen = new Set();
    return cleanText(value, 220).split(/\s*[·•]\s*/).map((part) => cleanText(part)).filter((part) => {
      const key = normalize(part);
      if (!key || key === normalize(channel) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(compactViewPart).join(' · ');
  }

  function safeAvatar(value) {
    const decoded = cleanText(value, 1800).replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    return /^https:\/\/yt3\.(?:googleusercontent\.com|ggpht\.com)\//i.test(decoded)
      && !badAvatarUrls.has(decoded) ? decoded : '';
  }

  function avatarFromHtml(html) {
    const source = String(html || '');
    const data = assignedJson(source);
    const candidates = [
      largestImage(data?.metadata?.channelMetadataRenderer?.avatar?.thumbnails),
      largestImage(data?.header?.c4TabbedHeaderRenderer?.avatar?.thumbnails),
      largestImage(data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
        ?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources),
      source.match(/<meta\s+property="og:image"\s+content="([^"]+)/i)?.[1],
      source.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i)?.[1],
      source.match(/<meta\s+name="twitter:image"\s+content="([^"]+)/i)?.[1],
      source.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)/)?.[1],
      source.match(/"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)/)?.[1],
      source.match(/"decoratedAvatarViewModel":\{"avatar":\{"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)/)?.[1]
    ];
    return candidates.map(safeAvatar).find(Boolean) || '';
  }

  function avatarCacheKey(video) {
    return video.channelId || video.channelUrl || normalize(video.channel) || video.id;
  }

  function fetchChannelAvatar(video) {
    const key = avatarCacheKey(video);
    if (!key) return Promise.resolve('');
    if (channelAvatarCache.has(key)) return Promise.resolve(channelAvatarCache.get(key));
    if (channelAvatarJobs.has(key)) return channelAvatarJobs.get(key);
    const target = video.channelUrl || (video.channelId ? `/channel/${video.channelId}` : '');
    const targetJob = target ? Promise.resolve(target) : fetch(
      `/oembed?url=${encodeURIComponent(video.url)}&format=json`,
      { credentials: 'include', signal: AbortSignal.timeout(10000) }
    ).then((response) => response.ok ? response.json() : null)
      .then((data) => data?.author_url || '');
    const job = targetJob.then((channelPage) => {
      if (!channelPage) return '';
      return fetch(channelPage, {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(10000)
      });
    }).then((response) => {
      if (!response) return '';
      if (!response.ok) throw new Error(`YouTube returned ${response.status}`);
      return response.text();
    }).then((html) => {
      const avatar = avatarFromHtml(html);
      if (avatar) channelAvatarCache.set(key, avatar);
      return avatar;
    }).catch(() => '').finally(() => channelAvatarJobs.delete(key));
    channelAvatarJobs.set(key, job);
    return job;
  }

  function hydrateAvatar(element, video) {
    if (!element) return;
    fetchChannelAvatar(video).then((avatar) => {
      if (!avatar || !element.isConnected || element.querySelector('img')) return;
      const image = document.createElement('img');
      image.src = avatar;
      image.alt = `${video.channel} profile picture`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        badAvatarUrls.add(image.src);
        channelAvatarCache.delete(avatarCacheKey(video));
        element.textContent = video.channel.slice(0, 1).toLocaleUpperCase();
        element.classList.add('still-channel-avatar-fallback');
      }, { once: true });
      element.replaceChildren(image);
      element.classList.remove('still-channel-avatar-fallback');
    });
  }

  function safeVideo(value, source = 'selected') {
    const id = cleanText(value?.id, 20);
    const channelId = cleanText(value?.channelId, 32);
    const title = cleanText(value?.title, 500);
    const channel = cleanText(value?.channel, 160);
    if (!/^[\w-]{11}$/.test(id) || !title || !channel) return null;
    const published = Number.isFinite(Date.parse(value?.published)) ? new Date(value.published).toISOString() : '';
    const avatar = safeAvatar(value?.avatar)
      || channelAvatarCache.get(channelId || value?.channelUrl || normalize(channel)) || '';
    const suppliedThumbnail = cleanText(value?.thumbnail, 1400);
    const suppliedUrl = cleanText(value?.url, 1000);
    const suppliedChannelUrl = cleanText(value?.channelUrl, 1000);
    let url = `https://www.youtube.com/watch?v=${id}`;
    try {
      const parsed = new URL(suppliedUrl);
      if ((parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com'))
          && (parsed.searchParams.get('v') === id || parsed.pathname === `/shorts/${id}`)) url = parsed.href;
    } catch {}
    let channelUrl = /^UC[\w-]{22}$/.test(channelId)
      ? `https://www.youtube.com/channel/${channelId}`
      : '';
    try {
      const parsed = new URL(suppliedChannelUrl, location.origin);
      if ((parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com'))
          && /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/i.test(parsed.pathname)) {
        channelUrl = parsed.href;
      }
    } catch {}
    return {
      id,
      channelId: /^UC[\w-]{22}$/.test(channelId) ? channelId : '',
      title,
      channel,
      channelUrl,
      published,
      url,
      thumbnail: /^https:\/\/i\.ytimg\.com\/vi\//i.test(suppliedThumbnail)
        ? suppliedThumbnail
        : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      avatar,
      meta: cleanVideoMeta(value?.meta, channel),
      duration: cleanText(value?.duration, 24),
      source
    };
  }

  function friendlyDate(value) {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return '';
    const elapsed = Math.max(0, Date.now() - time);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 8) return `${weeks}w ago`;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(time));
  }

  function subscribedChannelNames() {
    const names = new Set();
    document.querySelectorAll('ytd-guide-section-renderer').forEach((section) => {
      const heading = cleanText(section.querySelector('#guide-section-title, h3')?.textContent);
      if (!/subscriptions|abos|abonnements/i.test(heading)) return;
      section.querySelectorAll('a[href]').forEach((anchor) => {
        const name = normalize(anchor.getAttribute('title') || anchor.textContent);
        if (name) names.add(name);
      });
    });
    return names;
  }

  function nativeCardVideo(card, subscribed) {
    if (card.closest('#still-youtube-home')) return null;
    const link = [...card.querySelectorAll('a[href*="/watch"]')].find((anchor) => {
      try { return /^[\w-]{11}$/.test(new URL(anchor.href, location.origin).searchParams.get('v') || ''); } catch { return false; }
    });
    if (!link) return null;
    let id = '';
    try { id = new URL(link.href, location.origin).searchParams.get('v') || ''; } catch { return null; }
    const title = cleanText(
      card.querySelector('#video-title, #video-title-link, h3 a, yt-lockup-metadata-view-model h3')?.textContent
      || link.getAttribute('title')
      || link.getAttribute('aria-label')
    );
    const channelElement = card.querySelector('#channel-name a, ytd-channel-name a, .yt-content-metadata-view-model__metadata-row a, .ytContentMetadataViewModelMetadataRow a[href^="/channel/"], .ytContentMetadataViewModelMetadataRow a[href^="/@"], [class*="byline"] a, a[href^="/channel/"], a[href^="/@"]');
    const channel = cleanText(channelElement?.textContent || card.querySelector('#channel-name, ytd-channel-name, [class*="byline"]')?.textContent);
    if (!title || !channel) return null;
    const text = `${title} ${channel}`;
    const isAi = AI_TERMS.test(text);
    const isSubscribed = subscribed.has(normalize(channel));
    const isMusic = isMusicVideo({ title, channel });
    if (feedMode === 'music' && !isMusic) return null;
    if (feedMode === 'selective' && !isAi && !isSubscribed) return null;
    if (feedMode === 'selective' && !isAi && isSubscribed) {
      const sample = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
      if (sample % 5 !== 0) return null;
    }
    const avatar = card.querySelector('#avatar img, ytd-channel-name img, yt-img-shadow img, img.yt-spec-avatar-shape__image, .ytLockupMetadataViewModelAvatar img, yt-avatar-shape img')?.src || '';
    const channelId = cleanText(channelElement?.href?.match(/\/channel\/(UC[\w-]{22})/)?.[1], 32);
    const meta = cleanText(card.querySelector('#metadata-line, .inline-metadata-item, yt-content-metadata-view-model, .ytLockupMetadataViewModelMetadata')?.textContent, 220);
    const duration = cleanText(card.querySelector('ytd-thumbnail-overlay-time-status-renderer, badge-shape')?.textContent, 24);
    return safeVideo({ id, title, channel, channelId, channelUrl: channelElement?.href, avatar, published: '', meta, duration },
      isMusic && feedMode === 'music' ? 'music' : isAi ? 'ai' : isSubscribed ? 'subscription' : 'recommended');
  }

  function harvestNativePicks() {
    if (!isHome()) return;
    const subscribed = subscribedChannelNames();
    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      const video = nativeCardVideo(card, subscribed);
      if (video && !nativePicks.has(video.id)) nativePicks.set(video.id, video);
    });
    if (nativePicks.size > 200) {
      [...nativePicks.keys()].slice(0, nativePicks.size - 200).forEach((id) => nativePicks.delete(id));
    }
  }

  function largestImage(sources) {
    return (Array.isArray(sources) ? sources : [])
      .filter((source) => /^https:\/\/(?:yt3\.(?:googleusercontent\.com|ggpht\.com)|i\.ytimg\.com)\//i.test(source?.url || ''))
      .sort((left, right) => (Number(right.width) * Number(right.height)) - (Number(left.width) * Number(left.height)))[0]?.url || '';
  }

  function textValue(value) {
    return cleanText(value?.simpleText || value?.content || value?.runs?.map((run) => run?.text).join(''), 500);
  }

  function rendererVideo(renderer, fallbackChannel = null) {
    const id = cleanText(renderer?.videoId, 20);
    const title = textValue(renderer?.title);
    const channelRun = renderer?.ownerText?.runs?.[0] || renderer?.longBylineText?.runs?.[0] || renderer?.shortBylineText?.runs?.[0];
    const channel = cleanText(channelRun?.text || fallbackChannel?.title, 160);
    const channelId = cleanText(channelRun?.navigationEndpoint?.browseEndpoint?.browseId, 32);
    const channelUrl = cleanText(
      channelRun?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url
      || fallbackChannel?.baseUrl,
      1000
    );
    const target = cleanText(renderer?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url, 1000);
    const thumbnail = largestImage(renderer?.thumbnail?.thumbnails);
    const avatar = largestImage(
      renderer?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails
      || renderer?.avatar?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources
    ) || fallbackChannel?.avatar || '';
    const meta = [textValue(renderer?.viewCountText), textValue(renderer?.publishedTimeText)].filter(Boolean).join(' · ');
    const duration = textValue(renderer?.lengthText)
      || textValue(renderer?.thumbnailOverlays?.find((overlay) => overlay?.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer?.text);
    return safeVideo({
      id,
      title,
      channel,
      channelId,
      channelUrl: new URL(channelUrl || `/channel/${channelId}`, location.origin).href,
      avatar,
      thumbnail,
      url: new URL(target || `/watch?v=${id}`, location.origin).href,
      meta,
      duration
    }, fallbackChannel ? 'channel' : 'search');
  }

  function lockupVideo(model, fallbackChannel = null) {
    if (!model || (model.contentType && !/VIDEO/i.test(model.contentType))) return null;
    const id = cleanText(model.contentId || model.videoId, 20);
    const metadata = model.metadata?.lockupMetadataViewModel || {};
    const title = cleanText(metadata.title?.content || metadata.title?.runs?.map((run) => run.text).join(''), 500);
    const metadataParts = (metadata.metadata?.contentMetadataViewModel?.metadataRows || [])
      .flatMap((row) => row?.metadataParts || []);
    const channelCommand = metadataParts.flatMap((part) => part?.text?.commandRuns || [])
      .map((run) => run?.onTap?.innertubeCommand)
      .find((command) => command?.browseEndpoint) || null;
    const channelId = cleanText(channelCommand?.browseEndpoint?.browseId, 32);
    const channelUrl = cleanText(channelCommand?.commandMetadata?.webCommandMetadata?.url, 1000);
    const parts = metadataParts
      .map((part) => cleanText(/views|aufrufe/i.test(part?.accessibilityLabel || '')
        ? part.accessibilityLabel : part?.text?.content, 160))
      .filter(Boolean);
    const command = model.onTap?.innertubeCommand
      || model.rendererContext?.commandContext?.onTap?.innertubeCommand
      || metadata.rendererContext?.commandContext?.onTap?.innertubeCommand;
    const target = cleanText(command?.commandMetadata?.webCommandMetadata?.url, 1000);
    const thumbnail = largestImage(
      model.contentImage?.thumbnailViewModel?.image?.sources
      || model.image?.thumbnailViewModel?.image?.sources
      || model.thumbnailViewModel?.image?.sources
    );
    const avatar = largestImage(
      metadata.avatar?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources
      || model.avatar?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources
      || model.channelAvatar?.avatarViewModel?.image?.sources
    );
    return safeVideo({
      id,
      title,
      channel: fallbackChannel?.title || parts[0],
      channelId: fallbackChannel?.id || channelId,
      channelUrl: fallbackChannel?.baseUrl || channelUrl,
      avatar: fallbackChannel?.avatar || avatar,
      thumbnail,
      url: new URL(target || `/watch?v=${id}`, location.origin).href,
      meta: parts.filter((part) => normalize(part) !== normalize(fallbackChannel?.title)).join(' · ')
    }, fallbackChannel ? 'channel' : 'search');
  }

  function initialVideos(data, fallbackChannel = null) {
    if (!data) return [];
    const videos = new Map();
    const visited = new WeakSet();
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 30 || visited.has(value)) return;
      visited.add(value);
      const candidate = rendererVideo(value.videoRenderer || value.gridVideoRenderer, fallbackChannel)
        || lockupVideo(value.lockupViewModel, fallbackChannel);
      if (candidate && !videos.has(candidate.id)) videos.set(candidate.id, candidate);
      Object.values(value).forEach((child) => walk(child, depth + 1));
    };
    walk(data);
    return [...videos.values()].slice(0, 200);
  }

  function musicChannelKey(video) {
    return video.channelId || normalize(video.channel);
  }

  function isMusicVideo(video) {
    if (!video) return false;
    const known = config.musicChannels.some((channel) =>
      channel.id === video.channelId || normalize(channel.name) === normalize(video.channel));
    return (known || MUSIC_CHANNEL.test(video.channel) || MUSIC_RELEASE.test(video.title))
      && !NOT_A_SONG.test(video.title);
  }

  function loadSubscriptions(force = false) {
    if (subscriptionState === 'loading') return;
    if (!force && subscriptionUpdatedAt && Date.now() - subscriptionUpdatedAt < 5 * 60 * 1000) return;
    subscriptionState = 'loading';
    const url = new URL('/feed/subscriptions', location.origin).href;
    pageDataCache.delete(url);
    fetchRouteData(url).then((data) => {
      if (destroyed) return;
      subscriptionVideos = initialVideos(data).map((video) => ({ ...video, source: 'subscription' }));
      subscriptionState = 'ready';
      subscriptionUpdatedAt = Date.now();
      renderedSignature = '';
      renderHome();
    }).catch(() => {
      if (destroyed) return;
      subscriptionState = 'error';
      renderedSignature = '';
      renderHome();
    });
  }

  async function musicChannelUploads(channel) {
    const response = await fetch(`/feeds/videos.xml?channel_id=${encodeURIComponent(channel.id)}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const decode = (value) => String(value || '')
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const field = (entry, tag) => decode(entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]);
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
      const entry = match[1];
      const id = field(entry, 'yt:videoId');
      const title = field(entry, 'title');
      const published = field(entry, 'published');
      const views = entry.match(/<media:statistics\b[^>]*\bviews="(\d+)"/i)?.[1];
      return safeVideo({
        id, title, published, channelId: channel.id, channel: channel.name,
        meta: /^\d+$/.test(views || '')
          ? `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(views))} views` : ''
      }, 'music');
    }).filter((video) => video && !NOT_A_SONG.test(video.title));
  }

  function loadMusicDiscovery() {
    if (musicDiscoveryState !== 'idle') return;
    musicDiscoveryState = 'loading';
    fetchRouteData('/feed/history').then(async (data) => {
      const history = initialVideos(data).filter(isMusicVideo);
      const channels = new Map();
      history.forEach((video) => {
        const key = musicChannelKey(video);
        musicHistoryChannels.set(key, (musicHistoryChannels.get(key) || 0) + 1);
        if (/^UC[\w-]{22}$/.test(video.channelId)) channels.set(video.channelId, {
          id: video.channelId, name: video.channel
        });
      });
      const ranked = [...channels.values()]
        .filter((channel) => !config.musicChannels.some((known) => known.id === channel.id))
        .sort((left, right) => (musicHistoryChannels.get(right.id) || 0) - (musicHistoryChannels.get(left.id) || 0))
        .slice(0, 10);
      const results = await Promise.allSettled(ranked.map(musicChannelUploads));
      if (destroyed) return;
      personalMusicVideos = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      musicDiscoveryState = 'ready';
      renderedSignature = '';
      renderHome();
    }).catch(() => {
      if (destroyed) return;
      musicDiscoveryState = 'error';
      renderedSignature = '';
      renderHome();
    });
  }

  function nativeSubscribeButton() {
    const header = document.querySelector('yt-page-header-renderer,ytd-c4-tabbed-header-renderer');
    return [...(header?.querySelectorAll('button') || [])].find((button) => {
      const text = cleanText(button.textContent, 80);
      const label = cleanText(button.getAttribute('aria-label'), 180);
      return /^(?:subscribe|subscribed|abonnieren|abonniert)$/i.test(text)
        || /(?:subscribe|subscription|notification setting|abonn)/i.test(label);
    }) || null;
  }

  function channelPageData() {
    const data = routeData() || {};
    const metadata = data?.metadata?.channelMetadataRenderer || {};
    const viewModel = data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel || {};
    const useNativeDom = nativeDataUrl === location.href;
    const header = useNativeDom ? document.querySelector('yt-page-header-renderer,ytd-c4-tabbed-header-renderer') : null;
    const routeName = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '').replace(/[-_]+/g, ' ');
    const title = cleanText(
      metadata.title
      || viewModel.title?.dynamicTextViewModel?.text?.content
      || header?.querySelector('h1.dynamicTextViewModelH1,h1')?.textContent
      || (useNativeDom ? document.title.replace(/\s*-\s*YouTube\s*$/i, '') : routeName),
      160
    );
    const metadataParts = (viewModel.metadata?.contentMetadataViewModel?.metadataRows || [])
      .flatMap((row) => row?.metadataParts || [])
      .map((part) => cleanText(part?.text?.content, 100))
      .filter(Boolean);
    const handle = metadataParts.find((part) => part.startsWith('@'))
      || cleanText(header?.textContent.match(/@[\p{L}\p{N}_.-]+/u)?.[0], 100);
    const stats = metadataParts.filter((part) => part !== handle).join(' · ');
    const avatar = largestImage(metadata.avatar?.thumbnails)
      || largestImage(viewModel.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources)
      || cleanText(header?.querySelector('yt-avatar-shape img,img')?.src, 1400);
    const banner = largestImage(viewModel.banner?.imageBannerViewModel?.image?.sources)
      || cleanText(useNativeDom ? document.querySelector('#page-header-banner img')?.src : '', 1400);
    const description = cleanText(
      metadata.description
      || viewModel.description?.descriptionPreviewViewModel?.description?.content
      || header?.querySelector('yt-description-preview-view-model')?.textContent,
      900
    );
    const baseUrl = cleanText(metadata.vanityChannelUrl || metadata.ownerUrls?.[0] || metadata.channelUrl || location.origin + location.pathname.split('/').slice(0, 3).join('/'), 1000)
      .replace(/^http:/i, 'https:');
    const subscribeButton = nativeSubscribeButton();
    const subscribeLabel = cleanText(subscribeButton?.textContent, 80) || 'Subscribe';
    const tabs = [...(useNativeDom ? document.querySelectorAll('yt-tab-group-shape yt-tab-shape[tab-title]') : [])]
      .map((tab) => ({
        label: cleanText(tab.getAttribute('tab-title') || tab.textContent, 40),
        selected: tab.getAttribute('aria-selected') === 'true'
      }))
      .filter((tab) => /^(?:Home|Videos|Shorts|Live|Playlists|Posts|Community)$/i.test(tab.label));
    return {
      title,
      handle,
      stats,
      avatar,
      banner,
      description,
      baseUrl,
      subscribeLabel,
      subscribed: /subscribed|abonniert/i.test(subscribeLabel),
      tabs
    };
  }

  function channelCardVideo(card, channel) {
    if (card.closest('#still-youtube-channel')) return null;
    const link = [...card.querySelectorAll('a[href*="/watch"],a[href*="/shorts/"]')].find((anchor) => {
      try {
        const parsed = new URL(anchor.href, location.origin);
        return /^[\w-]{11}$/.test(parsed.searchParams.get('v') || parsed.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] || '');
      } catch { return false; }
    });
    if (!link) return null;
    let id = '';
    try {
      const parsed = new URL(link.href, location.origin);
      id = parsed.searchParams.get('v') || parsed.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] || '';
    } catch { return null; }
    const title = cleanText(
      card.querySelector('.ytLockupMetadataViewModelTitle,#video-title,#video-title-link,h3 a')?.textContent
      || link.getAttribute('title')
      || link.getAttribute('aria-label'),
      500
    );
    if (!title) return null;
    const thumbnail = cleanText(card.querySelector('yt-thumbnail-view-model img,#thumbnail img,img')?.src, 1400);
    const meta = cleanText(
      card.querySelector('yt-content-metadata-view-model,.ytLockupMetadataViewModelMetadata,#metadata-line')?.textContent,
      220
    );
    const duration = cleanText(card.querySelector('badge-shape,.ytd-thumbnail-overlay-time-status-renderer')?.textContent, 24);
    return safeVideo({
      id,
      title,
      channel: channel.title,
      channelUrl: channel.baseUrl,
      avatar: channel.avatar,
      thumbnail,
      url: link.href,
      meta,
      duration
    }, 'channel');
  }

  function initialShortVideos(channel, data = routeData()) {
    if (!/\/shorts\/?$/i.test(location.pathname)) return [];
    const videos = new Map();
    const visited = new WeakSet();
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 28 || visited.has(value)) return;
      visited.add(value);
      const model = value.shortsLockupViewModel;
      if (model) {
        const command = model.onTap?.innertubeCommand;
        const id = cleanText(command?.reelWatchEndpoint?.videoId, 20);
        const url = cleanText(command?.commandMetadata?.webCommandMetadata?.url, 1000);
        const title = cleanText(model.overlayMetadata?.primaryText?.content || model.accessibilityText?.split(',')?.[0], 500);
        const meta = cleanText(model.overlayMetadata?.secondaryText?.content, 120);
        const thumbnail = largestImage(model.thumbnailViewModel?.thumbnailViewModel?.image?.sources)
          || largestImage(command?.reelWatchEndpoint?.thumbnail?.thumbnails);
        const video = safeVideo({
          id,
          title,
          channel: channel.title,
          channelUrl: channel.baseUrl,
          avatar: channel.avatar,
          thumbnail,
          url: new URL(url || `/shorts/${id}`, location.origin).href,
          meta
        }, 'channel');
        if (video && !videos.has(video.id)) videos.set(video.id, video);
      }
      Object.values(value).forEach((child) => walk(child, depth + 1));
    };
    walk(data);
    return [...videos.values()];
  }

  function channelVideos(channel) {
    const unique = new Map();
    initialShortVideos(channel).forEach((video) => unique.set(video.id, video));
    if (!/\/shorts\/?$/i.test(location.pathname)) {
      initialVideos(routeData(), channel).forEach((video) => unique.set(video.id, video));
    }
    if (nativeDataUrl === location.href) {
      document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
        const video = channelCardVideo(card, channel);
        if (video && !unique.has(video.id)) unique.set(video.id, video);
      });
    }
    return [...unique.values()].slice(0, 200);
  }

  function mixedVideos() {
    if (feedMode === 'normal') {
      const videos = new Map(nativePicks);
      const data = routeData();
      if (data?.contents?.twoColumnBrowseResultsRenderer) {
        initialVideos(data).forEach((video) => {
          const native = videos.get(video.id);
          videos.set(video.id, native ? {
            ...native,
            channelId: native.channelId || video.channelId,
            channelUrl: native.channelUrl || video.channelUrl,
            avatar: native.avatar || video.avatar,
            meta: video.meta || native.meta
          } : { ...video, source: 'recommended' });
        });
      }
      return [...videos.values()].slice(0, 200);
    }
    if (feedMode === 'music') {
      const unique = new Map();
      [
        ...personalMusicVideos,
        ...config.musicHomeFeed.videos.map((video) => safeVideo(video, 'music')).filter(isMusicVideo),
        ...subscriptionVideos.filter(isMusicVideo),
        ...[...nativePicks.values()].filter(isMusicVideo)
      ].filter(Boolean).forEach((video) => {
        if (!unique.has(video.id)) unique.set(video.id, video);
      });
      const score = (video) => {
        const affinity = musicHistoryChannels.get(musicChannelKey(video))
          || musicHistoryChannels.get(normalize(video.channel)) || 0;
        const age = video.published ? Date.now() - Date.parse(video.published) : Infinity;
        return Math.min(affinity, 8) * 8
          + (MUSIC_RELEASE.test(video.title) ? 18 : 0)
          + (video.source === 'subscription' ? 10 : 0)
          + (age < 7 * 86400000 ? 12 : age < 30 * 86400000 ? 6 : 0);
      };
      const buckets = new Map();
      [...unique.values()].forEach((video) => {
        const key = musicChannelKey(video);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(video);
      });
      const ranked = [...buckets.values()];
      ranked.forEach((bucket) => bucket.sort((a, b) =>
        score(b) - score(a) || Date.parse(b.published || 0) - Date.parse(a.published || 0)));
      ranked.sort((a, b) => score(b[0]) - score(a[0]));
      const result = [];
      for (let round = 0; ranked.some((bucket) => bucket[round]) && result.length < 200; round += 1) {
        ranked.forEach((bucket) => { if (bucket[round] && result.length < 200) result.push(bucket[round]); });
      }
      return result;
    }
    if (feedMode === 'subscriptions') return subscriptionVideos.slice(0, 200);
    const selected = config.homeFeed.videos.map((video) => safeVideo(video, 'selected')).filter(Boolean);
    const selectedIds = new Set(selected.map((video) => video.id));
    const discoveries = [...nativePicks.values()].filter((video) => !selectedIds.has(video.id));
    const result = [];
    let discoveryIndex = 0;
    selected.forEach((video, index) => {
      result.push(video);
      if ((index + 1) % 6 === 0 && discoveries[discoveryIndex]) result.push(discoveries[discoveryIndex++]);
    });
    if (!selected.length) result.push(...discoveries);
    return result.slice(0, 200);
  }

  function staticIcon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', path);
    svg.appendChild(shape);
    return svg;
  }

  function setFeedMode(nextMode) {
    if (!['normal', 'selective', 'music', 'subscriptions'].includes(nextMode) || feedMode === nextMode) return;
    nativePicks.clear();
    feedMode = nextMode;
    try { localStorage.setItem('still-youtube-feed-mode', feedMode); } catch {}
    window.dispatchEvent(new CustomEvent('still-youtube-mode-change', { detail: { mode: feedMode } }));
    if (feedMode === 'subscriptions') loadSubscriptions(true);
    if (feedMode === 'music') {
      loadSubscriptions();
      loadMusicDiscovery();
    }
    renderedSignature = '';
    renderHome();
  }

  function feedModeControl(native = false) {
    const control = document.createElement('nav');
    control.className = `still-feed-mode${native ? ' still-feed-mode-native' : ''}`;
    control.setAttribute('aria-label', 'YouTube feed algorithm');
    [
      ['normal', 'Normal'],
      ['selective', 'Selective'],
      ['music', 'Music'],
      ['subscriptions', 'Subscribed']
    ].forEach(([value, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.classList.toggle('selected', feedMode === value);
      button.setAttribute('aria-pressed', String(feedMode === value));
      button.addEventListener('click', () => setFeedMode(value));
      control.appendChild(button);
    });
    return control;
  }

  function showNativeModeControl() {
    let control = document.querySelector('#still-youtube-native-mode');
    if (control) return;
    control = feedModeControl(true);
    control.id = 'still-youtube-native-mode';
    (document.body || document.documentElement).appendChild(control);
  }

  function hideNativeModeControl() {
    document.querySelector('#still-youtube-native-mode')?.remove();
  }

  function navLink(label, href, iconPath) {
    const link = document.createElement('a');
    link.className = 'still-shelf-link';
    link.href = href;
    link.append(staticIcon(iconPath), document.createTextNode(label));
    return link;
  }

  function createShelf(side) {
    const edge = document.createElement('div');
    edge.className = `still-edge still-edge-${side}`;
    const shelf = document.createElement('aside');
    shelf.className = 'still-shelf';
    shelf.setAttribute('aria-label', side === 'left' ? 'YouTube navigation' : 'Curated sources');

    if (side === 'left') {
      const title = document.createElement('strong');
      title.className = 'still-shelf-title';
      title.textContent = 'YouTube';
      const subscriptionsLink = navLink('Subscriptions', 'https://www.youtube.com/', 'M4 5h16v2H4zm2 4h12v2H6zm-2 4h16v7H4z');
      subscriptionsLink.addEventListener('click', (event) => {
        event.preventDefault();
        setFeedMode('subscriptions');
        if (!isHome()) customNavigate('https://www.youtube.com/');
      });
      shelf.append(
        title,
        navLink('Home', 'https://www.youtube.com/', 'M3 11.2 12 4l9 7.2V21h-6v-6H9v6H3z'),
        subscriptionsLink
      );
      if (feedMode === 'selective') {
        const manage = document.createElement('button');
        manage.className = 'still-shelf-link';
        manage.type = 'button';
        manage.append(staticIcon('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m9 4-2.1-1 .1-2.3-2.1-2.1-2.3.1L14 3h-4L9 5.1l-2.3-.1-2.1 2.1.1 2.3L3 12l1.7 2.6-.1 2.3L6.7 19l2.3-.1 1 2.1h4l1-2.1 2.3.1 2.1-2.1-.1-2.3z'), document.createTextNode('Manage sources'));
        manage.addEventListener('click', () => window.postMessage({ type: 'still-open-learn' }, location.origin));
        shelf.appendChild(manage);
      }
    } else {
      const title = document.createElement('strong');
      title.className = 'still-shelf-title';
      title.textContent = feedMode === 'music' ? 'Music sources'
        : feedMode === 'subscriptions' ? 'Subscribed channels' : 'Your sources';
      const list = document.createElement('div');
      list.className = 'still-source-list';
      const sourceChannels = feedMode === 'music'
        ? [...config.musicChannels, ...personalMusicVideos.map((video) => ({ id: video.channelId, name: video.channel }))]
        : feedMode === 'subscriptions'
          ? subscriptionVideos.map((video) => ({ id: video.channelId, name: video.channel }))
          : config.enabled;
      const seenSources = new Set();
      sourceChannels.forEach((channel) => {
        if (!/^UC[\w-]{22}$/.test(channel.id) || seenSources.has(channel.id)) return;
        seenSources.add(channel.id);
        const link = document.createElement('a');
        link.href = `https://www.youtube.com/channel/${channel.id}`;
        link.className = 'still-source';
        const dot = document.createElement('span');
        dot.textContent = channel.name.slice(0, 1).toLocaleUpperCase();
        link.append(dot, document.createTextNode(channel.name));
        list.appendChild(link);
      });
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'still-shelf-link still-refresh';
      refresh.append(staticIcon('M20 6v5h-5M4 18v-5h5M18.7 9A7 7 0 0 0 6.2 6.2L4 8m16 8-2.2 2.2A7 7 0 0 1 5.3 15'), document.createTextNode('Refresh feed'));
      refresh.addEventListener('click', () => location.reload());
      shelf.append(title, list, refresh);
    }
    edge.appendChild(shelf);
    return edge;
  }

  function youtubeLogo() {
    const logo = document.createElement('a');
    logo.className = 'still-home-logo';
    logo.href = 'https://www.youtube.com/';
    logo.setAttribute('aria-label', 'YouTube home');
    const image = document.createElement('img');
    image.src = 'https://www.gstatic.com/youtube/img/branding/youtubelogo/svg/youtubelogo_dark.svg';
    image.alt = 'YouTube';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    logo.appendChild(image);
    return logo;
  }

  function cornerHomeButton() {
    const link = document.createElement('a');
    link.className = 'still-channel-corner-home';
    link.href = 'https://www.youtube.com/';
    link.setAttribute('aria-label', 'YouTube home');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 68 48');
    svg.setAttribute('aria-hidden', 'true');
    const background = document.createElementNS(svg.namespaceURI, 'path');
    background.setAttribute('fill', '#ff0033');
    background.setAttribute('d', 'M66.5 7.5A8.4 8.4 0 0 0 60.6 1.6C55.4 0 34 0 34 0S12.6 0 7.4 1.4A8.6 8.6 0 0 0 1.5 7.5C0 12.8 0 24 0 24s0 11.2 1.5 16.5a8.4 8.4 0 0 0 5.9 5.9C12.6 48 34 48 34 48s21.4 0 26.6-1.4a8.4 8.4 0 0 0 5.9-5.9C68 35.4 68 24.2 68 24.2s0-11.4-1.5-16.7Z');
    const triangle = document.createElementNS(svg.namespaceURI, 'path');
    triangle.setAttribute('fill', '#fff');
    triangle.setAttribute('d', 'm27 34 18-10-18-10Z');
    svg.append(background, triangle);
    link.appendChild(svg);
    return link;
  }

  function openAvatarViewer(channel) {
    if (!channel.avatar) return;
    document.querySelector('.still-channel-avatar-viewer')?.remove();
    const viewer = document.createElement('div');
    viewer.className = 'still-channel-avatar-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', `${channel.title} profile picture`);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'still-channel-avatar-close';
    close.setAttribute('aria-label', 'Close profile picture');
    close.textContent = '×';
    const image = document.createElement('img');
    image.src = channel.avatar;
    image.alt = `${channel.title} profile picture`;
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    const dismiss = () => {
      document.removeEventListener('keydown', onKeyDown);
      viewer.remove();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') dismiss();
    };
    close.addEventListener('click', dismiss);
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer) dismiss();
    });
    viewer.append(image, close);
    document.querySelector('#still-youtube-channel')?.appendChild(viewer);
    document.addEventListener('keydown', onKeyDown);
    close.focus({ preventScroll: true });
  }

  function youtubeSearch(initialValue = '') {
    const form = document.createElement('form');
    form.className = 'still-home-search';
    form.action = 'https://www.youtube.com/results';
    form.method = 'get';
    form.setAttribute('role', 'search');

    const searchIcon = staticIcon('M10.8 4.5a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6m4.6 10.9 4.1 4.1');
    searchIcon.classList.add('still-home-search-icon');

    const input = document.createElement('input');
    input.type = 'search';
    input.name = 'search_query';
    input.placeholder = 'Search YouTube';
    input.value = cleanText(initialValue, 300);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.enterKeyHint = 'search';
    input.setAttribute('aria-label', 'Search YouTube');

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.setAttribute('aria-label', 'Search');
    submit.appendChild(staticIcon('M10.8 4.5a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6m4.6 10.9 4.1 4.1'));

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) {
        input.focus({ preventScroll: true });
        return;
      }
      customNavigate(`/results?search_query=${encodeURIComponent(query)}`);
    });
    form.append(searchIcon, input, submit);
    return form;
  }

  function focusSearchShortcut(event) {
    if ((!isHome() && !isChannel() && !isSearch()) || event.defaultPrevented || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    const input = document.querySelector('#still-youtube-home .still-home-search input,#still-youtube-search .still-home-search input');
    if (!input) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
  }

  function applyMutedColors(root, button) {
    root?.classList.toggle('still-home-muted-colors', mutedColors);
    button?.setAttribute('aria-pressed', String(mutedColors));
    button?.setAttribute('aria-label', mutedColors ? 'Use normal video colors' : 'Mute video colors');
  }

  function colorToggle() {
    const edge = document.createElement('div');
    edge.className = 'still-home-color-edge';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'still-home-color-toggle';
    button.setAttribute('aria-pressed', 'false');
    const moon = staticIcon('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z');
    moon.classList.add('still-color-moon');
    const sun = staticIcon('M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z');
    sun.classList.add('still-color-sun');
    button.append(moon, sun, document.createTextNode('Muted colors'));
    button.addEventListener('click', () => {
      mutedColors = !mutedColors;
      try { localStorage.setItem('still-youtube-muted-colors', String(mutedColors)); } catch {}
      applyMutedColors(document.querySelector('#still-youtube-home,#still-youtube-search,#still-youtube-channel'), button);
    });
    applyMutedColors(document.querySelector('#still-youtube-home,#still-youtube-search,#still-youtube-channel'), button);
    edge.appendChild(button);
    return edge;
  }

  function videoCard(video, { channelView = false, shorts = false } = {}) {
    const card = document.createElement('article');
    card.className = 'still-video-card';
    card.classList.toggle('still-video-card-channel', channelView);
    card.classList.toggle('still-video-card-short', shorts);
    const videoLink = document.createElement('a');
    videoLink.className = 'still-video-link';
    videoLink.href = video.url;
    videoLink.setAttribute('aria-label', video.title);
    const picture = document.createElement('div');
    picture.className = 'still-video-picture';
    const image = document.createElement('img');
    image.src = video.thumbnail;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    picture.appendChild(image);
    if (video.duration) {
      const duration = document.createElement('span');
      duration.className = 'still-video-duration';
      duration.textContent = video.duration;
      picture.appendChild(duration);
    }
    videoLink.appendChild(picture);

    const details = document.createElement('div');
    details.className = 'still-video-details';
    if (!channelView) {
      const avatar = document.createElement(video.channelUrl ? 'a' : 'span');
      avatar.className = 'still-channel-avatar';
      if (video.channelUrl) {
        avatar.href = video.channelUrl;
        avatar.setAttribute('aria-label', `Open ${video.channel} channel`);
      }
      if (video.avatar) {
        const avatarImage = document.createElement('img');
        avatarImage.src = video.avatar;
        avatarImage.alt = `${video.channel} profile picture`;
        avatarImage.loading = 'lazy';
        avatarImage.decoding = 'async';
        avatarImage.referrerPolicy = 'no-referrer';
        avatarImage.addEventListener('error', () => {
          badAvatarUrls.add(avatarImage.src);
          avatar.classList.add('still-channel-avatar-fallback');
          avatar.textContent = video.channel.slice(0, 1).toLocaleUpperCase();
          channelAvatarCache.delete(avatarCacheKey(video));
          hydrateAvatar(avatar, video);
        }, { once: true });
        avatar.appendChild(avatarImage);
      } else {
        avatar.classList.add('still-channel-avatar-fallback');
        avatar.textContent = video.channel.slice(0, 1).toLocaleUpperCase();
        hydrateAvatar(avatar, video);
      }
      details.appendChild(avatar);
    }
    const info = document.createElement('div');
    info.className = 'still-video-info';
    const titleLink = document.createElement('a');
    titleLink.className = 'still-video-title-link';
    titleLink.href = video.url;
    const title = document.createElement('h2');
    title.textContent = video.title;
    titleLink.appendChild(title);
    const meta = document.createElement('p');
    const source = video.source === 'ai' ? 'AI pick' : video.source === 'subscription' ? 'From subscriptions' : '';
    if (!channelView) {
      const channelLink = document.createElement(video.channelUrl ? 'a' : 'span');
      channelLink.className = 'still-video-channel-link';
      if (video.channelUrl) channelLink.href = video.channelUrl;
      channelLink.textContent = video.channel;
      meta.appendChild(channelLink);
      [video.meta, friendlyDate(video.published), source].filter(Boolean).forEach((part) => {
        meta.append(document.createTextNode(' · '), document.createTextNode(part));
      });
    } else {
      meta.textContent = [video.meta, friendlyDate(video.published)].filter(Boolean).join(' · ');
    }
    info.append(titleLink, meta);
    details.appendChild(info);
    card.append(videoLink, details);
    return card;
  }

  function loadingCard({ channelView = false, shorts = false } = {}) {
    const card = document.createElement('div');
    card.className = 'still-video-card still-skeleton';
    card.classList.toggle('still-video-card-channel', channelView);
    card.classList.toggle('still-video-card-short', shorts);
    const picture = document.createElement('div');
    picture.className = 'still-video-picture';
    const details = document.createElement('div');
    details.className = 'still-video-details';
    const info = document.createElement('div');
    info.className = 'still-video-info';
    info.append(document.createElement('i'), document.createElement('i'));
    if (!channelView) {
      const avatar = document.createElement('i');
      avatar.className = 'still-channel-avatar';
      details.appendChild(avatar);
    }
    details.appendChild(info);
    card.append(picture, details);
    return card;
  }

  function channelTabHref(channel, label) {
    const suffixes = {
      home: '',
      videos: '/videos',
      shorts: '/shorts',
      live: '/streams'
    };
    return `${channel.baseUrl.replace(/\/+$/, '')}${suffixes[label.toLocaleLowerCase()] || ''}`;
  }

  function channelHeader(channel) {
    const hero = document.createElement('header');
    hero.className = 'still-channel-hero';
    if (channel.banner) {
      const banner = document.createElement('img');
      banner.className = 'still-channel-banner';
      banner.src = channel.banner;
      banner.alt = '';
      banner.decoding = 'async';
      banner.referrerPolicy = 'no-referrer';
      hero.appendChild(banner);
    }

    const identity = document.createElement('div');
    identity.className = 'still-channel-identity';
    const avatar = document.createElement('button');
    avatar.type = 'button';
    avatar.className = 'still-channel-hero-avatar';
    avatar.setAttribute('aria-label', channel.avatar ? `View ${channel.title} profile picture` : channel.title);
    avatar.disabled = !channel.avatar;
    if (channel.avatar) {
      const image = document.createElement('img');
      image.src = channel.avatar;
      image.alt = `${channel.title} profile picture`;
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      avatar.appendChild(image);
    } else {
      avatar.textContent = channel.title.slice(0, 1).toLocaleUpperCase();
    }
    avatar.addEventListener('click', () => openAvatarViewer(channel));
    const copy = document.createElement('div');
    copy.className = 'still-channel-copy';
    const title = document.createElement('h1');
    title.textContent = channel.title;
    const metadata = document.createElement('p');
    metadata.className = 'still-channel-metadata';
    metadata.textContent = [channel.handle, channel.stats].filter(Boolean).join(' · ');
    const description = document.createElement('button');
    description.type = 'button';
    description.className = 'still-channel-description';
    description.textContent = channel.description;
    description.setAttribute('aria-label', 'Expand channel description');
    description.addEventListener('click', () => {
      const expanded = description.classList.toggle('expanded');
      description.setAttribute('aria-label', expanded ? 'Collapse channel description' : 'Expand channel description');
    });
    copy.append(title, metadata);
    if (channel.description) copy.appendChild(description);

    const subscribe = document.createElement('button');
    subscribe.type = 'button';
    subscribe.className = 'still-channel-subscribe';
    subscribe.classList.toggle('subscribed', channel.subscribed);
    subscribe.textContent = channel.subscribeLabel;
    subscribe.setAttribute('aria-label', channel.subscribed ? `${channel.title} subscription settings` : `Subscribe to ${channel.title}`);
    subscribe.addEventListener('click', () => {
      const native = nativeSubscribeButton();
      if (!native) return;
      native.click();
      renderedSignature = '';
      scheduleRender(500);
    });
    identity.append(avatar, copy, subscribe);
    hero.appendChild(identity);
    return hero;
  }

  function channelTabs(channel) {
    const nav = document.createElement('nav');
    nav.className = 'still-channel-tabs';
    nav.setAttribute('aria-label', `${channel.title} sections`);
    const tabs = channel.tabs.length ? channel.tabs : [
      { label: 'Home', selected: !/\/(?:videos|shorts|streams)\/?$/i.test(location.pathname) },
      { label: 'Videos', selected: /\/videos\/?$/i.test(location.pathname) },
      { label: 'Shorts', selected: /\/shorts\/?$/i.test(location.pathname) },
      { label: 'Live', selected: /\/streams\/?$/i.test(location.pathname) }
    ];
    tabs.filter((tab) => /^(?:Home|Videos|Shorts|Live)$/i.test(tab.label)).forEach((tab) => {
      const link = document.createElement('a');
      link.href = channelTabHref(channel, tab.label);
      link.textContent = tab.label;
      link.classList.toggle('selected', tab.selected);
      if (tab.selected) link.setAttribute('aria-current', 'page');
      nav.appendChild(link);
    });
    return nav;
  }

  function requestMoreChannelVideos(root) {
    if (root.scrollTop + root.clientHeight < root.scrollHeight - 1200) return;
    const now = Date.now();
    if (now - lastChannelLoadRequest < 1400) return;
    lastChannelLoadRequest = now;
    const nativeScroller = document.scrollingElement;
    if (!nativeScroller) return;
    nativeScroller.scrollTop = nativeScroller.scrollHeight;
    setTimeout(() => {
      nativeScroller.scrollTop = nativeScroller.scrollHeight;
      scheduleRender(300);
    }, 280);
  }

  function requestMoreHomeVideos(root) {
    if (feedMode !== 'normal' || root.scrollTop + root.clientHeight < root.scrollHeight - 1100) return;
    const now = Date.now();
    if (now - lastHomeLoadRequest < 1400) return;
    lastHomeLoadRequest = now;
    const nativeScroller = document.scrollingElement;
    if (!nativeScroller) return;
    nativeScroller.scrollTop = nativeScroller.scrollHeight;
    setTimeout(() => {
      nativeScroller.scrollTop = nativeScroller.scrollHeight;
      harvestNativePicks();
      renderedSignature = '';
      scheduleRender(240);
    }, 320);
  }

  function renderSearch() {
    const query = cleanText(new URLSearchParams(location.search).get('search_query'), 300);
    const data = routeData();
    const videos = initialVideos(data);
    const route = location.href;
    const signature = JSON.stringify({ route, ready: Boolean(data), videos: videos.map((video) => `${video.id}:${video.thumbnail}`) });
    if (signature === renderedSignature && document.querySelector('#still-youtube-search')) return;
    renderedSignature = signature;
    document.documentElement.classList.remove('still-youtube-custom-home', 'still-youtube-custom-channel');
    document.documentElement.classList.add('still-youtube-custom-search');
    document.querySelector('#still-youtube-home')?.remove();
    document.querySelector('#still-youtube-channel')?.remove();

    let root = document.querySelector('#still-youtube-search');
    if (!root) {
      root = document.createElement('main');
      root.id = 'still-youtube-search';
      document.body.appendChild(root);
    }
    const previousRoute = root.dataset.route;
    const previousScrollTop = root.scrollTop;
    root.dataset.route = route;
    root.replaceChildren();

    const hero = document.createElement('header');
    hero.className = 'still-search-hero';
    const heroContent = document.createElement('div');
    heroContent.className = 'still-search-hero-content';
    heroContent.append(youtubeLogo(), youtubeSearch(query));
    hero.appendChild(heroContent);

    const heading = document.createElement('div');
    heading.className = 'still-search-heading';
    const title = document.createElement('h1');
    title.textContent = `Results for “${query}”`;
    const count = document.createElement('span');
    count.textContent = data ? `${videos.length} videos` : 'Searching…';
    heading.append(title, count);

    const feed = document.createElement('section');
    feed.className = 'still-search-feed';
    feed.setAttribute('aria-label', `Search results for ${query}`);
    if (videos.length) videos.forEach((video) => feed.appendChild(videoCard(video)));
    else if (!data) for (let index = 0; index < 12; index += 1) feed.appendChild(loadingCard());
    else {
      const empty = document.createElement('div');
      empty.className = 'still-home-empty';
      empty.textContent = 'No videos found. Try another search.';
      feed.appendChild(empty);
    }
    const colorControl = colorToggle();
    root.append(hero, heading, feed, colorControl, createShelf('left'), createShelf('right'));
    applyMutedColors(root, colorControl.querySelector('.still-home-color-toggle'));
    root.scrollTop = previousRoute === route ? previousScrollTop : 0;
    ensureRouteData();
  }

  function renderChannel() {
    const channel = channelPageData();
    const videos = channelVideos(channel);
    const route = location.href;
    const shorts = /\/shorts\/?$/i.test(location.pathname);
    const signature = JSON.stringify({
      route,
      title: channel.title,
      handle: channel.handle,
      stats: channel.stats,
      avatar: channel.avatar,
      banner: channel.banner,
      subscribeLabel: channel.subscribeLabel,
      tabs: channel.tabs,
      videos: videos.map((video) => `${video.id}:${video.thumbnail}:${video.meta}`)
    });
    if (signature === renderedSignature && document.querySelector('#still-youtube-channel')) return;
    renderedSignature = signature;
    document.documentElement.classList.remove('still-youtube-custom-home', 'still-youtube-custom-search');
    document.documentElement.classList.add('still-youtube-custom-channel');
    document.querySelector('#still-youtube-home')?.remove();
    document.querySelector('#still-youtube-search')?.remove();

    let root = document.querySelector('#still-youtube-channel');
    if (!root) {
      root = document.createElement('main');
      root.id = 'still-youtube-channel';
      document.body.appendChild(root);
    }
    const previousRoute = root.dataset.route;
    const previousScrollTop = root.scrollTop;
    root.dataset.route = route;
    root.replaceChildren();
    const feed = document.createElement('section');
    feed.className = 'still-channel-feed';
    feed.classList.toggle('still-channel-shorts-feed', shorts);
    feed.setAttribute('aria-label', `${channel.title} ${shorts ? 'Shorts' : 'videos'}`);
    if (videos.length) {
      videos.forEach((video) => feed.appendChild(videoCard(video, { channelView: true, shorts })));
    } else if (routeData()) {
      const empty = document.createElement('div');
      empty.className = 'still-home-empty';
      empty.textContent = shorts ? 'No Shorts here yet.' : 'No uploads here yet.';
      feed.appendChild(empty);
    } else {
      for (let index = 0; index < 12; index += 1) feed.appendChild(loadingCard({ channelView: true, shorts }));
    }
    const colorControl = colorToggle();
    root.append(channelHeader(channel), channelTabs(channel), feed, cornerHomeButton(), colorControl, createShelf('left'), createShelf('right'));
    applyMutedColors(root, colorControl.querySelector('.still-home-color-toggle'));
    root.scrollTop = previousRoute === route ? previousScrollTop : 0;
    root.onscroll = () => requestMoreChannelVideos(root);
    ensureRouteData();
  }

  function renderHome() {
    if (destroyed) return;
    clearTimeout(renderTimer);
    if (isHome() && feedMode === 'subscriptions' && subscriptionState === 'idle') loadSubscriptions();
    if (isHome() && feedMode === 'music') {
      if (subscriptionState === 'idle') loadSubscriptions();
      if (musicDiscoveryState === 'idle') loadMusicDiscovery();
    }
    if (feedMode === 'normal' && !isHome()) {
      renderedSignature = '';
      document.documentElement.classList.remove('still-youtube-custom-home', 'still-youtube-custom-search', 'still-youtube-custom-channel');
      document.querySelector('#still-youtube-home')?.remove();
      document.querySelector('#still-youtube-search')?.remove();
      document.querySelector('#still-youtube-channel')?.remove();
      showNativeModeControl();
      return;
    }
    hideNativeModeControl();
    if (isSearch()) {
      renderSearch();
      return;
    }
    if (isChannel()) {
      renderChannel();
      return;
    }
    if (!isHome()) {
      renderedSignature = '';
      document.documentElement.classList.remove('still-youtube-custom-home');
      document.documentElement.classList.remove('still-youtube-custom-search');
      document.documentElement.classList.remove('still-youtube-custom-channel');
      document.querySelector('#still-youtube-home')?.remove();
      document.querySelector('#still-youtube-search')?.remove();
      document.querySelector('#still-youtube-channel')?.remove();
      return;
    }
    harvestNativePicks();
    const videos = mixedVideos();
    const activeFeed = feedMode === 'music' ? config.musicHomeFeed : config.homeFeed;
    const activeChannels = feedMode === 'music' ? config.musicChannels : config.enabled;
    const signature = JSON.stringify({
      mode: feedMode,
      ids: videos.map((video) => `${video.id}:${video.source}:${video.avatar || ''}:${video.meta || ''}`),
      enabled: activeChannels.map((channel) => channel.id),
      loading: activeFeed.loading,
      subscriptionState,
      musicDiscoveryState
    });
    if (signature === renderedSignature && document.querySelector('#still-youtube-home')) return;
    renderedSignature = signature;
    document.documentElement.classList.add('still-youtube-custom-home');
    document.documentElement.classList.remove('still-youtube-custom-search');
    document.documentElement.classList.remove('still-youtube-custom-channel');
    document.querySelector('#still-youtube-search')?.remove();
    document.querySelector('#still-youtube-channel')?.remove();

    let root = document.querySelector('#still-youtube-home');
    if (!root) {
      root = document.createElement('main');
      root.id = 'still-youtube-home';
      document.body.appendChild(root);
    }
    root.classList.toggle('still-home-music', feedMode === 'music');
    let hero = root.querySelector('.still-home-hero');
    if (!hero) {
      hero = document.createElement('header');
      hero.className = 'still-home-hero';
      const heroContent = document.createElement('div');
      heroContent.className = 'still-home-hero-content';
      heroContent.append(youtubeLogo(), youtubeSearch(), feedModeControl());
      hero.appendChild(heroContent);
    }
    hero.querySelectorAll('.still-feed-mode button').forEach((button) => {
      const selected = button.textContent.trim().toLocaleLowerCase() === feedMode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    let feed = root.querySelector('.still-home-feed');
    if (!feed) {
      feed = document.createElement('section');
      feed.className = 'still-home-feed';
    }
    feed.replaceChildren();
    feed.setAttribute('aria-label', feedMode === 'music' ? 'Music picked for you'
      : feedMode === 'subscriptions' ? 'Videos from your subscriptions' : 'Latest videos from your channels');
    if (videos.length) videos.forEach((video) => feed.appendChild(videoCard(video)));
    else if ((feedMode === 'music' && (activeFeed.loading || musicDiscoveryState === 'loading'))
      || (feedMode === 'subscriptions' && subscriptionState === 'loading')
      || (feedMode === 'selective' && activeFeed.loading)) {
      for (let index = 0; index < 12; index += 1) feed.appendChild(loadingCard());
    } else {
      const empty = document.createElement('div');
      empty.className = 'still-home-empty';
      empty.textContent = feedMode === 'music'
        ? 'No fresh music releases found yet.'
        : feedMode === 'subscriptions'
          ? subscriptionState === 'error'
            ? 'Could not load your subscriptions. Check that YouTube is signed in.'
            : 'No videos found in your YouTube subscriptions.'
        : feedMode === 'normal'
          ? 'YouTube did not provide recommendations for this page.'
          : 'No fresh uploads yet. Hover on the left edge to manage your sources.';
      feed.appendChild(empty);
      if (feedMode === 'normal') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'still-home-retry';
        retry.textContent = 'Reload recommendations';
        retry.addEventListener('click', () => location.reload());
        empty.appendChild(retry);
      } else if (feedMode === 'subscriptions' && subscriptionState === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'still-home-retry';
        retry.textContent = 'Retry subscriptions';
        retry.addEventListener('click', () => loadSubscriptions(true));
        empty.appendChild(retry);
      }
    }
    const colorControl = root.querySelector('.still-home-color-edge') || colorToggle();
    const previousScrollTop = root.scrollTop;
    const leftShelf = root.querySelector('.still-edge-left') || createShelf('left');
    const rightShelf = root.querySelector('.still-edge-right') || createShelf('right');
    root.replaceChildren(hero, feed, colorControl, leftShelf, rightShelf);
    applyMutedColors(root, colorControl.querySelector('.still-home-color-toggle'));
    root.scrollTop = previousScrollTop;
    root.onscroll = () => requestMoreHomeVideos(root);
  }

  function ensureStyle() {
    let style = document.querySelector('#still-youtube-home-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'still-youtube-home-style';
      style.textContent = `
        html.still-youtube-custom-home,html.still-youtube-custom-home body,html.still-youtube-custom-search,html.still-youtube-custom-search body,html.still-youtube-custom-channel,html.still-youtube-custom-channel body { overflow:hidden !important;background:#000 !important }
        #still-youtube-home,#still-youtube-search,#still-youtube-channel { position:fixed;z-index:2147482000;inset:0;overflow-x:hidden;overflow-y:auto;background:#000;color:#f5f5f5;font-family:Roboto,Arial,sans-serif;font-feature-settings:'kern';scrollbar-color:#000 #000;isolation:isolate }
        #still-youtube-home::-webkit-scrollbar,#still-youtube-home::-webkit-scrollbar-track,#still-youtube-home::-webkit-scrollbar-thumb,#still-youtube-search::-webkit-scrollbar,#still-youtube-search::-webkit-scrollbar-track,#still-youtube-search::-webkit-scrollbar-thumb,#still-youtube-channel::-webkit-scrollbar,#still-youtube-channel::-webkit-scrollbar-track,#still-youtube-channel::-webkit-scrollbar-thumb { width:10px;background:#000 }
        .still-home-hero { position:relative;display:grid;place-items:center;height:clamp(430px,56vh,680px);overflow:hidden;background:radial-gradient(ellipse 72% 62% at 50% -4%,rgba(255,0,51,.25),transparent 64%),linear-gradient(180deg,#101010 0%,#070707 43%,#000 100%) }
        .still-home-hero::before { content:'';position:absolute;inset:0;background:linear-gradient(115deg,transparent 20%,rgba(255,255,255,.022) 42%,transparent 64%),radial-gradient(ellipse at 50% 32%,rgba(255,0,51,.085),transparent 58%);pointer-events:none }
        .still-home-hero::after { content:'';position:absolute;inset:auto 0 0;height:56%;background:linear-gradient(transparent,#000 88%);pointer-events:none }
        .still-home-hero-content { position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;width:min(920px,calc(100% - 40px));margin-top:-5vh }
        .still-home-logo { display:block;width:clamp(390px,38vw,720px);text-decoration:none;filter:drop-shadow(0 34px 82px rgba(255,0,51,.15));opacity:.99 }
        .still-home-logo img { display:block;width:100%;height:auto }
        .still-home-search { display:grid;grid-template-columns:26px minmax(0,1fr) 58px;align-items:center;overflow:hidden;width:min(760px,82vw);height:62px;margin-top:34px;padding-left:20px;border:1px solid rgba(255,255,255,.16);border-radius:31px;background:rgba(10,10,10,.84);box-shadow:0 18px 54px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.055);transition:border-color 160ms ease,background-color 160ms ease,box-shadow 180ms ease;backdrop-filter:blur(18px) }
        .still-home-search:hover { border-color:rgba(255,255,255,.26);background:rgba(14,14,14,.91) }
        .still-home-search:focus-within { border-color:#3ea6ff;background:#0d0d0d;box-shadow:0 18px 54px rgba(0,0,0,.5),0 0 0 1px rgba(62,166,255,.24) }
        .still-home-search-icon { width:23px;height:23px;fill:none;stroke:#aaa;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;transition:stroke 150ms ease }
        .still-home-search:focus-within .still-home-search-icon { stroke:#e7e7e7 }
        .still-home-search input { min-width:0;height:100%;padding:0 14px;border:0;outline:0;color:#f7f7f7;background:transparent;font:400 19px/1 Roboto,Arial,sans-serif;caret-color:#fff }
        .still-home-search input::placeholder { color:#898989;opacity:1 }
        .still-home-search input::-webkit-search-cancel-button { filter:invert(1);opacity:.62;cursor:pointer }
        .still-home-search button { display:grid;place-items:center;align-self:stretch;width:58px;margin:0;padding:0;border:0;border-left:1px solid rgba(255,255,255,.12);border-radius:0;color:#e9e9e9;background:#202020;cursor:pointer;transition:background-color 140ms ease,color 140ms ease }
        .still-home-search button:hover { color:#fff;background:#2b2b2b }.still-home-search button:focus-visible { outline:2px solid #3ea6ff;outline-offset:-4px }
        .still-home-search button svg { width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round }
        .still-feed-mode { display:inline-flex;align-items:center;gap:3px;margin-top:18px;padding:4px;border:1px solid rgba(255,255,255,.12);border-radius:22px;background:rgba(12,12,12,.82);box-shadow:0 12px 34px rgba(0,0,0,.34);font-family:Roboto,Arial,sans-serif;backdrop-filter:blur(16px) }
        .still-feed-mode button { min-width:94px;height:34px;padding:0 15px;border:0;border-radius:17px;color:#999;background:transparent;font:500 14px/34px Roboto,Arial,sans-serif;cursor:pointer;transition:color 130ms ease,background-color 130ms ease }
        .still-feed-mode button:hover { color:#f1f1f1;background:rgba(255,255,255,.07) }.still-feed-mode button.selected { color:#0b0b0b;background:#f1f1f1 }.still-feed-mode button:focus-visible { outline:2px solid #3ea6ff;outline-offset:1px }
        .still-feed-mode-native { position:fixed;z-index:2147483400;top:12px;right:92px;margin:0;background:rgba(8,8,8,.92);box-shadow:0 10px 38px rgba(0,0,0,.55);opacity:0;transform:translateY(-7px);transition:opacity 160ms ease,transform 160ms ease }
        .still-feed-mode-native:hover,.still-feed-mode-native:focus-within { opacity:1;transform:none }
        #still-youtube-home.still-home-music .still-home-hero { background:radial-gradient(ellipse 72% 62% at 50% -4%,rgba(130,66,255,.24),transparent 64%),linear-gradient(180deg,#0d0a12 0%,#050407 43%,#000 100%) }
        #still-youtube-home.still-home-music .still-home-hero::before { background:linear-gradient(115deg,transparent 20%,rgba(255,255,255,.022) 42%,transparent 64%),radial-gradient(ellipse at 50% 32%,rgba(113,74,255,.1),transparent 58%) }
        #still-youtube-home.still-home-music .still-home-logo { filter:drop-shadow(0 34px 82px rgba(123,78,255,.16)) }
        .still-home-feed { position:relative;z-index:2;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:34px 18px;width:min(1900px,calc(100% - 64px));margin:-54px auto 100px }
        .still-video-card { display:block;min-width:0;color:inherit;outline:none }
        .still-video-link,.still-video-title-link { display:block;color:inherit;text-decoration:none;outline:none }
        .still-video-picture { position:relative;overflow:hidden;width:100%;aspect-ratio:16/9;border-radius:12px;background:#080808;box-shadow:0 0 0 1px rgba(255,255,255,.045);transition:border-radius 180ms ease,box-shadow 180ms ease,transform 220ms cubic-bezier(.2,.8,.2,1) }
        .still-video-picture img { display:block;width:100%;height:100%;object-fit:cover;transform:scale(1.001);transition:filter 180ms ease,transform 360ms cubic-bezier(.2,.8,.2,1) }
        .still-video-duration { position:absolute;right:7px;bottom:7px;padding:3px 5px;border-radius:4px;color:#fff;background:rgba(0,0,0,.82);font:600 12px/15px Roboto,Arial,sans-serif;letter-spacing:.01em }
        .still-video-card:hover .still-video-picture,.still-video-link:focus-visible .still-video-picture { border-radius:9px;box-shadow:0 0 0 1px rgba(255,255,255,.14);transform:translateY(-2px) }
        .still-video-card:hover .still-video-picture img,.still-video-link:focus-visible .still-video-picture img { filter:brightness(1.045);transform:scale(1.018) }
        #still-youtube-home.still-home-muted-colors .still-video-picture img,#still-youtube-search.still-home-muted-colors .still-video-picture img,#still-youtube-channel.still-home-muted-colors .still-video-picture img,#still-youtube-channel.still-home-muted-colors .still-channel-banner { filter:saturate(.28) contrast(1.04) brightness(.97) }
        #still-youtube-home.still-home-muted-colors .still-video-card:hover .still-video-picture img,#still-youtube-search.still-home-muted-colors .still-video-card:hover .still-video-picture img,#still-youtube-channel.still-home-muted-colors .still-video-card:hover .still-video-picture img { filter:saturate(.28) contrast(1.04) brightness(1.01) }
        .still-video-details { display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;padding:12px 4px 0 }
        .still-channel-avatar { display:grid;place-items:center;width:38px;height:38px;margin-top:1px;overflow:hidden;border-radius:50%;background:#171717;color:#ddd;font-size:13px;font-weight:700;box-shadow:0 0 0 1px rgba(255,255,255,.08) }
        .still-channel-avatar img { display:block;width:100%;height:100%;object-fit:cover }
        .still-video-info { min-width:0;padding:0 }
        .still-video-info h2 { display:-webkit-box;overflow:hidden;margin:0;color:#f1f1f1;font:500 16px/22px Roboto,Arial,sans-serif;-webkit-line-clamp:2;-webkit-box-orient:vertical }
        .still-video-info p { overflow:hidden;margin:3px 0 0;color:#aaa;font:400 13px/18px Roboto,Arial,sans-serif;text-overflow:ellipsis;white-space:nowrap }
        .still-video-title-link:focus-visible h2 { color:#fff;text-decoration:underline;text-underline-offset:3px }
        .still-video-channel-link { color:#aaa;text-decoration:none }.still-video-channel-link:hover,.still-video-channel-link:focus-visible { color:#fff;text-decoration:underline;text-underline-offset:2px;outline:none }
        .still-video-card-channel .still-video-details { grid-template-columns:minmax(0,1fr);padding-right:2px;padding-left:2px }
        .still-home-color-edge { position:fixed;z-index:2147483100;top:0;right:0;width:190px;height:82px;background:transparent }
        .still-home-color-toggle { position:absolute;top:20px;right:28px;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border:0;border-radius:20px;color:#f1f1f1;background:rgba(255,255,255,.1);font:500 14px/40px Roboto,Arial,sans-serif;cursor:pointer;box-shadow:none;backdrop-filter:none;opacity:0;pointer-events:none;transform:translate(8px,-7px) scale(.94);transition:opacity 150ms ease,transform 180ms cubic-bezier(.2,.8,.2,1),background-color 140ms ease }
        .still-home-color-edge:hover .still-home-color-toggle,.still-home-color-edge:focus-within .still-home-color-toggle { opacity:1;pointer-events:auto;transform:translate(0,0) scale(1) }
        .still-home-color-toggle:hover { background:rgba(255,255,255,.2) }.still-home-color-toggle:focus-visible { outline:2px solid #3ea6ff;outline-offset:2px }
        .still-home-color-toggle svg { width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round }
        .still-home-color-toggle .still-color-sun { display:none }.still-home-color-toggle[aria-pressed='true'] .still-color-moon { display:none }.still-home-color-toggle[aria-pressed='true'] .still-color-sun { display:block }
        .still-edge { position:fixed;z-index:2147483000;top:0;bottom:0;width:18px }
        .still-edge-left { left:0 }.still-edge-right { right:0 }
        .still-edge::before { content:'';position:absolute;top:42%;width:3px;height:84px;border-radius:4px;background:rgba(255,255,255,.13);opacity:.45;transition:opacity 160ms ease }
        .still-edge-left::before { left:4px }.still-edge-right::before { right:4px }
        .still-edge:hover::before,.still-edge:focus-within::before { opacity:0 }
        .still-shelf { position:absolute;top:18px;bottom:18px;width:min(330px,86vw);padding:24px 14px;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(14,14,14,.94);box-shadow:0 24px 90px rgba(0,0,0,.8);backdrop-filter:blur(24px);transition:transform 220ms cubic-bezier(.2,.8,.2,1);overflow:auto;scrollbar-width:none }
        .still-shelf::-webkit-scrollbar { display:none }.still-edge-left .still-shelf { left:8px;transform:translateX(calc(-100% - 24px)) }.still-edge-right .still-shelf { right:8px;transform:translateX(calc(100% + 24px)) }
        .still-edge:hover .still-shelf,.still-edge:focus-within .still-shelf { transform:translateX(0) }
        .still-shelf-title { display:block;padding:4px 14px 18px;color:#fff;font-size:22px;font-weight:700;letter-spacing:-.03em }
        .still-shelf-link { display:flex;align-items:center;gap:14px;width:100%;min-height:48px;padding:0 14px;border:0;border-radius:11px;color:#e8e8e8;background:transparent;font:500 14px/1 Roboto,Arial,sans-serif;text-align:left;text-decoration:none;cursor:pointer }
        .still-shelf-link:hover,.still-shelf-link:focus-visible { color:#fff;background:#242424;outline:none }.still-shelf-link svg { width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round }
        .still-source-list { display:grid;gap:3px }.still-source { display:flex;align-items:center;gap:12px;min-height:43px;padding:5px 10px;border-radius:10px;color:#cfcfcf;font-size:13px;text-decoration:none }.still-source:hover { color:#fff;background:#232323 }
        .still-source span { display:grid;place-items:center;flex:none;width:29px;height:29px;border-radius:50%;color:#fff;background:#292929;font-size:11px;font-weight:700 }
        .still-refresh { margin-top:16px;border-top:1px solid rgba(255,255,255,.08);border-radius:0;padding-top:12px }
        .still-skeleton .still-video-picture,.still-skeleton .still-channel-avatar,.still-skeleton .still-video-info i { display:block;background:linear-gradient(100deg,#080808 25%,#151515 43%,#080808 61%);background-size:300% 100%;animation:still-shimmer 1.4s linear infinite }
        .still-skeleton .still-video-info i { height:14px;margin:0 0 0;border-radius:5px }.still-skeleton .still-video-info i:last-child { width:56%;height:10px;margin-top:9px }
        @keyframes still-shimmer { to { background-position:-150% 0 } }
        .still-home-empty { grid-column:1/-1;min-height:280px;display:grid;place-items:center;color:#777;font-size:16px;text-align:center }
        .still-home-retry { display:block;margin:12px auto 0;padding:10px 16px;border:1px solid #333;border-radius:10px;background:#171717;color:#eee;font:500 13px Roboto,Arial,sans-serif;cursor:pointer }
        .still-home-retry:hover { background:#242424 }
        .still-search-hero { position:relative;display:grid;place-items:center;min-height:430px;overflow:hidden;background:radial-gradient(ellipse 72% 78% at 50% -14%,rgba(255,0,51,.2),transparent 66%),linear-gradient(180deg,#101010 0%,#070707 48%,#000 100%) }
        .still-search-hero::after { content:'';position:absolute;right:0;bottom:0;left:0;height:48%;background:linear-gradient(transparent,#000 92%);pointer-events:none }
        .still-search-hero-content { position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:min(980px,calc(100% - 60px));padding:34px 0 38px }
        .still-search-hero-content .still-home-logo { flex:none;width:clamp(380px,34vw,590px);filter:drop-shadow(0 28px 70px rgba(255,0,51,.13)) }
        .still-search-hero-content .still-home-search { flex:none;width:min(760px,82vw);max-width:none;margin:30px 0 0 }
        .still-search-heading { position:relative;z-index:2;display:flex;align-items:baseline;justify-content:space-between;gap:24px;box-sizing:border-box;width:min(1840px,calc(100% - 76px));min-height:52px;margin:0 auto 26px;padding-top:12px;overflow:visible }
        .still-search-heading h1 { margin:0;color:#f3f3f3;font:650 clamp(24px,2.2vw,36px)/1.2 Roboto,Arial,sans-serif;letter-spacing:-.025em }.still-search-heading span { flex:none;color:#777;font:500 13px/1 Roboto,Arial,sans-serif }
        .still-search-feed { display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:36px 18px;width:min(1840px,calc(100% - 76px));min-height:440px;margin:0 auto;padding:0 0 110px }
        .still-channel-hero { position:relative;min-height:clamp(470px,54vh,620px);overflow:hidden;background:radial-gradient(ellipse 70% 65% at 50% 0,rgba(255,0,51,.13),transparent 70%),#050505 }
        .still-channel-hero::before { content:'';position:absolute;z-index:1;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.22) 0%,rgba(0,0,0,.05) 32%,rgba(0,0,0,.68) 72%,#000 100%),linear-gradient(90deg,rgba(0,0,0,.28),transparent 32%,transparent 68%,rgba(0,0,0,.28));pointer-events:none }
        .still-channel-banner { position:absolute;inset:0 0 auto;width:100%;height:min(31vw,430px);object-fit:cover;object-position:center;transform:scale(1.015);transition:filter 210ms ease }
        .still-channel-identity { position:absolute;z-index:2;right:max(38px,calc((100% - 1840px)/2));bottom:34px;left:max(38px,calc((100% - 1840px)/2));display:grid;grid-template-columns:132px minmax(0,1fr) auto;align-items:end;gap:24px }
        .still-channel-hero-avatar { display:grid;place-items:center;width:132px;height:132px;padding:0;overflow:hidden;border:4px solid rgba(255,255,255,.92);border-radius:50%;color:#fff;background:#171717;font-size:42px;font-weight:700;box-shadow:0 18px 48px rgba(0,0,0,.55);cursor:zoom-in;transition:transform 180ms cubic-bezier(.2,.8,.2,1),border-color 140ms ease }
        .still-channel-hero-avatar:hover { transform:scale(1.025);border-color:#fff }.still-channel-hero-avatar:focus-visible { outline:3px solid #3ea6ff;outline-offset:3px }.still-channel-hero-avatar:disabled { cursor:default }
        .still-channel-hero-avatar img { width:100%;height:100%;object-fit:cover }
        .still-channel-copy { min-width:0;padding-bottom:3px;text-shadow:0 2px 18px rgba(0,0,0,.8) }
        .still-channel-copy h1 { overflow:hidden;margin:0;color:#fff;font:700 clamp(34px,4vw,58px)/1.03 Roboto,Arial,sans-serif;letter-spacing:-.035em;text-overflow:ellipsis;white-space:nowrap }
        .still-channel-metadata { margin:10px 0 0;color:#d0d0d0;font:500 14px/20px Roboto,Arial,sans-serif }
        .still-channel-description { display:-webkit-box;overflow:hidden;max-width:820px;margin:8px 0 0;padding:0;border:0;color:#aaa;background:transparent;font:400 14px/20px Roboto,Arial,sans-serif;text-align:left;text-shadow:0 2px 12px #000;cursor:pointer;-webkit-box-orient:vertical;-webkit-line-clamp:1 }
        .still-channel-description:hover { color:#ddd }.still-channel-description.expanded { -webkit-line-clamp:5 }
        .still-channel-subscribe { min-width:118px;height:44px;margin-bottom:5px;padding:0 21px;border:0;border-radius:22px;color:#0f0f0f;background:#f1f1f1;font:600 14px/44px Roboto,Arial,sans-serif;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.35);transition:background-color 140ms ease,transform 160ms cubic-bezier(.2,.8,.2,1) }
        .still-channel-subscribe:hover { background:#fff;transform:translateY(-1px) }.still-channel-subscribe.subscribed { color:#f1f1f1;background:rgba(255,255,255,.15);backdrop-filter:blur(14px) }.still-channel-subscribe.subscribed:hover { background:rgba(255,255,255,.22) }
        .still-channel-tabs { position:sticky;z-index:20;top:0;display:flex;align-items:center;gap:28px;height:66px;padding:0 max(38px,calc((100% - 1840px)/2));border-bottom:1px solid rgba(255,255,255,.075);background:rgba(0,0,0,.92);backdrop-filter:blur(20px) }
        .still-channel-tabs a { position:relative;display:grid;align-items:center;height:100%;color:#8f8f8f;font:600 14px/1 Roboto,Arial,sans-serif;text-decoration:none;transition:color 140ms ease }.still-channel-tabs a:hover { color:#e8e8e8 }.still-channel-tabs a.selected { color:#fff }
        .still-channel-tabs a.selected::after { content:'';position:absolute;right:0;bottom:0;left:0;height:3px;border-radius:3px 3px 0 0;background:#f1f1f1 }
        .still-channel-feed { display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:36px 18px;width:min(1840px,calc(100% - 76px));min-height:440px;margin:0 auto;padding:38px 0 110px }
        .still-channel-shorts-feed { grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:34px 16px;width:min(1760px,calc(100% - 76px)) }
        .still-channel-shorts-feed .still-video-picture { aspect-ratio:9/16;border-radius:12px }.still-channel-shorts-feed .still-video-info h2 { -webkit-line-clamp:2 }
        .still-channel-corner-home { position:fixed;z-index:2147483150;top:0;left:0;display:grid;place-items:start;width:112px;height:78px;padding:18px 0 0 20px;box-sizing:border-box;overflow:hidden;border-radius:0 0 22px 0;background:transparent;text-decoration:none;cursor:pointer }
        .still-channel-corner-home svg { width:42px;height:30px;opacity:0;filter:none;transform:translate(-10px,-7px) scale(.78);transition:opacity 160ms ease,transform 190ms cubic-bezier(.2,.8,.2,1) }
        .still-channel-corner-home:hover svg,.still-channel-corner-home:focus-visible svg { opacity:1;transform:translate(0,0) scale(1) }.still-channel-corner-home:focus-visible { outline:2px solid #3ea6ff;outline-offset:-5px }
        .still-channel-avatar-viewer { position:fixed;z-index:2147483600;inset:0;display:grid;place-items:center;padding:48px;background:rgba(0,0,0,.9);backdrop-filter:blur(18px);cursor:zoom-out;animation:still-avatar-in 150ms ease-out }
        .still-channel-avatar-viewer img { display:block;width:min(720px,78vw,78vh);height:min(720px,78vw,78vh);border-radius:50%;object-fit:cover;box-shadow:0 28px 100px rgba(0,0,0,.8) }
        .still-channel-avatar-close { position:fixed;top:24px;right:28px;display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;color:#fff;background:#202020;font:300 32px/1 Arial,sans-serif;cursor:pointer }.still-channel-avatar-close:hover { background:#303030 }.still-channel-avatar-close:focus-visible { outline:2px solid #3ea6ff;outline-offset:3px }
        @keyframes still-avatar-in { from { opacity:0 } to { opacity:1 } }
        @media(max-width:700px) { .still-home-hero { height:410px }.still-home-hero-content { margin-top:-3vh }.still-home-logo { width:min(76vw,460px) }.still-home-search { grid-template-columns:23px minmax(0,1fr) 48px;width:min(92vw,620px);height:54px;margin-top:26px;padding-left:16px }.still-home-search input { padding:0 10px;font-size:17px }.still-home-search button { width:48px }.still-feed-mode button { min-width:78px;padding:0 11px;font-size:13px }.still-feed-mode-native { top:auto;right:14px;bottom:18px }.still-home-feed { width:calc(100% - 28px);gap:28px;margin-top:-30px }.still-video-picture { border-radius:11px }.still-home-color-edge { width:76px;height:68px }.still-home-color-toggle { top:14px;right:16px;width:40px;padding:0;justify-content:center;font-size:0;gap:0 }.still-search-hero { min-height:360px }.still-search-hero-content { width:calc(100% - 28px);padding:30px 0 }.still-search-hero-content .still-home-logo { width:min(76vw,430px) }.still-search-hero-content .still-home-search { width:100%;margin-top:24px }.still-search-heading,.still-search-feed { width:calc(100% - 28px) }.still-search-heading { padding-top:10px }.still-search-heading span { display:none } }
        @media(max-width:900px) { .still-channel-hero { min-height:520px }.still-channel-identity { right:24px;bottom:28px;left:24px;grid-template-columns:96px minmax(0,1fr);gap:18px }.still-channel-hero-avatar { width:96px;height:96px }.still-channel-copy h1 { font-size:34px }.still-channel-description { -webkit-line-clamp:2 }.still-channel-subscribe { grid-column:2;justify-self:start;margin:3px 0 0 }.still-channel-tabs { gap:23px;padding:0 24px;overflow-x:auto;scrollbar-width:none }.still-channel-feed { width:calc(100% - 36px) }.still-channel-shorts-feed { grid-template-columns:repeat(auto-fill,minmax(170px,1fr)) } }
        @media(max-width:560px) { .still-channel-hero { min-height:550px }.still-channel-identity { grid-template-columns:76px minmax(0,1fr) }.still-channel-hero-avatar { width:76px;height:76px;border-width:3px }.still-channel-copy h1 { font-size:29px }.still-channel-metadata { margin-top:6px }.still-channel-description { grid-column:1/-1 }.still-channel-subscribe { grid-column:1/-1 }.still-channel-feed { grid-template-columns:1fr }.still-channel-shorts-feed { grid-template-columns:repeat(2,minmax(0,1fr));gap:26px 10px }.still-channel-avatar-viewer { padding:22px } }
        @media(prefers-reduced-motion:reduce) { #still-youtube-home *,#still-youtube-search *,#still-youtube-channel * { animation:none !important;transition:none !important } }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function scheduleRender(delay = 80) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderHome, delay);
  }

  function update(nextConfig) {
    if (destroyed) return;
    ensureStyle();
    config = {
      enabled: Array.isArray(nextConfig?.enabled)
        ? nextConfig.enabled.filter((channel) => /^UC[\w-]{22}$/.test(channel?.id) && cleanText(channel?.name)).slice(0, 80).map((channel) => ({ id: channel.id, name: cleanText(channel.name, 160) }))
        : [],
      musicChannels: Array.isArray(nextConfig?.musicChannels)
        ? nextConfig.musicChannels.filter((channel) => /^UC[\w-]{22}$/.test(channel?.id) && cleanText(channel?.name)).slice(0, 80).map((channel) => ({ id: channel.id, name: cleanText(channel.name, 160) }))
        : [],
      homeFeed: {
        videos: Array.isArray(nextConfig?.homeFeed?.videos) ? nextConfig.homeFeed.videos.slice(0, 200) : [],
        failed: Array.isArray(nextConfig?.homeFeed?.failed) ? nextConfig.homeFeed.failed.map((name) => cleanText(name, 160)).slice(0, 80) : [],
        loading: nextConfig?.homeFeed?.loading !== false
      },
      musicHomeFeed: {
        videos: Array.isArray(nextConfig?.musicHomeFeed?.videos) ? nextConfig.musicHomeFeed.videos.slice(0, 200) : [],
        failed: Array.isArray(nextConfig?.musicHomeFeed?.failed) ? nextConfig.musicHomeFeed.failed.map((name) => cleanText(name, 160)).slice(0, 80) : [],
        loading: nextConfig?.musicHomeFeed?.loading !== false
      }
    };
    renderHome();
  }

  observer = new MutationObserver(() => scheduleRender());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('yt-navigate-finish', handleNativeNavigateFinish);
  document.addEventListener('keydown', focusSearchShortcut);
  document.addEventListener('click', handleCustomLinkClick, true);
  window.addEventListener('popstate', handleHistoryChange);
  window.__stillYouTubeHome = {
    version: VERSION,
    update,
    destroy() {
      destroyed = true;
      clearTimeout(renderTimer);
      observer?.disconnect();
      document.removeEventListener('keydown', focusSearchShortcut);
      document.removeEventListener('yt-navigate-finish', handleNativeNavigateFinish);
      document.removeEventListener('click', handleCustomLinkClick, true);
      window.removeEventListener('popstate', handleHistoryChange);
      document.documentElement.classList.remove('still-youtube-custom-home', 'still-youtube-custom-search', 'still-youtube-custom-channel');
      document.querySelector('#still-youtube-home')?.remove();
      document.querySelector('#still-youtube-search')?.remove();
      document.querySelector('#still-youtube-channel')?.remove();
      document.querySelector('#still-youtube-native-mode')?.remove();
      document.querySelector('#still-youtube-home-style')?.remove();
    }
  };
  update(window.__stillLearningFilterConfig || {});
})();
