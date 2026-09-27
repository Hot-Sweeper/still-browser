const CATALOG_URL = browser.runtime.getURL('channel-catalog.json');
const YOUTUBE_URL = /^https?:\/\/(?:www\.|m\.)?youtube\.com\//i;
const YOUTUBE_FILES = ['youtube-filter.js', 'youtube-home.js', 'youtube-ui.js'];
const FEED_LIFETIME_MS = 60_000;
const feedCache = new Map();
const avatarCache = new Map();
let catalogPromise;

function catalog() {
  catalogPromise ||= fetch(CATALOG_URL).then((response) => response.json());
  return catalogPromise;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

function xmlValue(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(block || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return decodeXml(match?.[1]);
}

function channelAvatarFromHtml(html) {
  const source = String(html || '');
  const candidates = [
    source.match(/<meta\s+property="og:image"\s+content="([^"]+)/i)?.[1],
    source.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i)?.[1],
    source.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)/)?.[1],
    source.match(/"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)/)?.[1]
  ];
  for (const candidate of candidates) {
    const decoded = String(candidate || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    try {
      const parsed = new URL(decoded);
      if (['yt3.googleusercontent.com', 'yt3.ggpht.com'].includes(parsed.hostname.toLowerCase())) {
        return decoded.replace(/=s\d+(?:-[^/?#"']*)?$/i, '=s176-c-k-c0x00ffffff-no-rj');
      }
    } catch {}
  }
  return '';
}

async function avatarForChannel(channel) {
  const cached = avatarCache.get(channel.id);
  if (cached && Date.now() - cached.time < (cached.url ? 86_400_000 : 60_000)) return cached.url;
  let url = '';
  try {
    const response = await fetch(`https://www.youtube.com/channel/${channel.id}`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(12_000)
    });
    if (response.ok) url = channelAvatarFromHtml(await response.text());
  } catch {}
  avatarCache.set(channel.id, { time: Date.now(), url });
  return url;
}

async function videosForChannel(channel) {
  const cached = feedCache.get(channel.id);
  if (cached && Date.now() - cached.time < FEED_LIFETIME_MS) return cached.videos;
  const avatarPromise = avatarForChannel(channel);
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel.id)}`, {
    headers: { Accept: 'application/atom+xml, application/xml;q=0.9' },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`RSS ${response.status}: ${channel.name}`);
  const xml = await response.text();
  if (xml.length > 2_000_000) throw new Error(`Oversized RSS: ${channel.name}`);
  const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const entry = match[1];
    const id = xmlValue(entry, 'yt:videoId');
    const published = xmlValue(entry, 'published');
    if (!/^[\w-]{11}$/.test(id) || !Number.isFinite(Date.parse(published))) return null;
    const rawViews = entry.match(/<media:statistics\b[^>]*\bviews="(\d+)"/i)?.[1];
    const views = rawViews === undefined ? NaN : Number(rawViews);
    return {
      id, channelId: channel.id, channel: channel.name,
      title: xmlValue(entry, 'title').slice(0, 500), published,
      meta: Number.isSafeInteger(views) && views >= 0
        ? `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(views)} views`
        : '',
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    };
  }).filter(Boolean).filter((video) => !channel.feedKeywords?.length
    || channel.feedKeywords.some((term) => video.title.toLowerCase().includes(term.toLowerCase())));
  const avatar = await avatarPromise.catch(() => '');
  const finished = avatar ? videos.map((video) => ({ ...video, avatar })) : videos;
  feedCache.set(channel.id, { time: Date.now(), videos: finished });
  return finished;
}

function rotateVideos(videos, channels) {
  const buckets = new Map(channels.map((channel) => [channel.id, []]));
  for (const video of videos) buckets.get(video.channelId)?.push(video);
  buckets.forEach((bucket) => bucket.sort((a, b) => Date.parse(b.published) - Date.parse(a.published)));
  const active = [...buckets.values()].filter((bucket) => bucket.length)
    .sort((a, b) => Date.parse(b[0].published) - Date.parse(a[0].published));
  const mixed = [];
  for (let round = 0; active.some((bucket) => bucket[round]); round++) {
    for (const bucket of active) if (bucket[round]) mixed.push(bucket[round]);
  }
  return mixed.slice(0, 180);
}

async function feedFor(channels) {
  const settled = await Promise.allSettled(channels.map(videosForChannel));
  const videos = [];
  const failed = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') videos.push(...result.value);
    else failed.push(channels[index].name);
  });
  return { videos: rotateVideos(videos, channels), failed, loading: false };
}

async function currentChannels() {
  const source = await catalog();
  const { enabledChannelIds } = await browser.storage.local.get('enabledChannelIds');
  const enabled = Array.isArray(enabledChannelIds)
    ? new Set(enabledChannelIds)
    : new Set(source.learningChannels.map((channel) => channel.id));
  return { source, learning: source.learningChannels.filter((channel) => enabled.has(channel.id)) };
}

async function inject(tabId, config) {
  await browser.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (nextConfig) => { window.__stillLearningFilterConfig = nextConfig; },
    args: [config]
  });
  for (const file of YOUTUBE_FILES) {
    await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [file] });
  }
}

async function refreshTab(tabId, url) {
  if (!YOUTUBE_URL.test(url || '')) return;
  const { source, learning } = await currentChannels();
  const base = {
    enabled: learning.map(({ id, name }) => ({ id, name })),
    musicChannels: source.musicChannels.map(({ id, name }) => ({ id, name })),
    learnPageUrl: browser.runtime.getURL('manage.html'),
    homeFeed: { videos: [], failed: [], loading: true },
    musicHomeFeed: { videos: [], failed: [], loading: true }
  };
  try { await inject(tabId, base); } catch { return; }
  const [homeFeed, musicHomeFeed] = await Promise.all([
    feedFor(learning), feedFor(source.musicChannels)
  ]);
  try { await inject(tabId, { ...base, homeFeed, musicHomeFeed }); } catch {}
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && YOUTUBE_URL.test(tab.url || '')) {
    refreshTab(tabId, tab.url).catch(console.error);
  }
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.enabledChannelIds) return;
  const tabs = await browser.tabs.query({ url: ['*://*.youtube.com/*'] });
  tabs.forEach((tab) => refreshTab(tab.id, tab.url).catch(console.error));
});

browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'open-manager') return browser.runtime.openOptionsPage();
  if (message?.type === 'get-catalog') return currentChannels();
  return undefined;
});
