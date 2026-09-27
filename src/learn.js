const STORAGE_KEY = 'still-learn-enabled-v1';
const FALLBACK_CHANNELS = [
  { id: 'UCOJIGngtr4zcPuuZX6dO8aQ', name: 'Tech2WiLD', accent: '#7c5cff' },
  { id: 'UCPix8N6PMRI4KzgyjuZeF0g', name: 'Fahd Mirza', accent: '#ff8a4c' },
  { id: 'UCOCahKBCEUuzDJawM7yN1dg', name: 'Bijan Bowen', accent: '#2ec4a6' },
  { id: 'UCIgnGlGkVRhd4qNFcEwLL4A', name: 'AI Search', accent: '#4e8cff' },
  { id: 'UCYwLV1gDwzGbg7jXQ52bVnQ', name: 'Universe of AI', accent: '#8f74ff' },
  { id: 'UC2WmuBuFq6gL08QYG-JjXKw', name: 'WorldofAI', accent: '#3eb7ff' },
  { id: 'UCsBjURrPoezykLs9EqgamOA', name: 'Fireship', accent: '#f25f4b' },
  { id: 'UCbRP3c757lWg9M-U7TyEkXA', name: 'Theo – t3.gg', accent: '#ec5da7' },
  { id: 'UCXZCJLdBC09xxGZ6gcdrc6A', name: 'OpenAI', accent: '#10a37f' },
  { id: 'UCrDwWp7EBBv4NwvScIpBDOA', name: 'Anthropic', accent: '#d29b6e' },
  { id: 'UCRaz_dquopKtb4ptswKcxTA', name: 'Mistral AI', accent: '#f7a53b' },
  { id: 'UCipPA-ZHX6UYGH_Iyti1-Jw', name: 'Qwen · Alibaba Cloud', accent: '#6f7cff' },
  { id: 'UCP7jMXSY2xbc3KCAE0MHQ-A', name: 'Google DeepMind · Gemini', accent: '#4c8bf5' },
  { id: 'UCHlNU7kIZhRgSbhHvFoy72w', name: 'Hugging Face', accent: '#ffd21e' },
  { id: 'UCBHcMCGaiJhv-ESTcWGJPcw', name: 'NVIDIA Developer', accent: '#76b900' },
  { id: 'UCwKzYuPkYJ_0v1kYOYXNmoA', name: 'Ollama', accent: '#d6d6d6' },
  { id: 'UCrpz86KspLzW2JF-feKBn-w', name: 'Local AI', accent: '#42c59a' },
  { id: 'UCCb9_Kn8F_Opb3UCGm-lILQ', name: 'Microsoft Research', accent: '#00a4ef' }
];

const elements = {
  channels: document.querySelector('#channels'),
  discoveries: document.querySelector('#discoveries'),
  discoveryStatus: document.querySelector('#discovery-status'),
  scanHistory: document.querySelector('#scan-history'),
  count: document.querySelector('#selected-count'),
  selectAll: document.querySelector('#select-all'),
  refresh: document.querySelector('#refresh'),
  status: document.querySelector('#status'),
  feed: document.querySelector('#feed')
};

let seedChannels = [];
let discoveredChannels = [];
let channels = [];
let enabledIds = new Set();
let refreshSequence = 0;
let toggleTimer;

function initials(name) {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  return words.slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase() || 'YT';
}

function readSavedChannels() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) return new Set(saved.map(String));
  } catch {}
  return null;
}

function saveChannels() {
  const selection = [...enabledIds];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  window.stillLearn?.setSelection?.(selection).catch(() => {});
}

function updateSelectionSummary() {
  const includedCount = channels.filter((channel) => enabledIds.has(channel.id)).length;
  elements.count.textContent = `${includedCount} of ${channels.length} included`;
  const allSelected = channels.length > 0 && includedCount === channels.length;
  elements.selectAll.textContent = allSelected ? 'Clear all' : 'Select all';
}

function channelToggle(channel, target, fromHistory = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'channel-toggle';
  wrapper.style.setProperty('--accent', channel.accent);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `channel-${channel.id}`;
  input.checked = enabledIds.has(channel.id);

  const card = document.createElement('label');
  card.className = 'channel-card';
  card.htmlFor = input.id;

  const avatar = document.createElement('span');
  avatar.className = 'channel-avatar';
  avatar.textContent = initials(channel.name);

  const copy = document.createElement('span');
  copy.className = 'channel-copy';
  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = channel.name;
  copy.appendChild(name);
  if (fromHistory) {
    const reason = document.createElement('small');
    reason.className = 'channel-reason';
    reason.textContent = channel.recentVideo
      ? `Recently watched: ${channel.recentVideo}`
      : `${channel.watched || 1} recent video${channel.watched === 1 ? '' : 's'}`;
    copy.appendChild(reason);
  }

  const toggle = document.createElement('span');
  toggle.className = 'switch';
  toggle.setAttribute('aria-hidden', 'true');

  card.append(avatar, copy, toggle);
  wrapper.append(input, card);
  target.appendChild(wrapper);

  input.addEventListener('change', () => {
    if (input.checked) enabledIds.add(channel.id);
    else enabledIds.delete(channel.id);
    saveChannels();
    updateSelectionSummary();
    clearTimeout(toggleTimer);
    toggleTimer = setTimeout(refreshFeed, 180);
  });
}

function renderChannels() {
  elements.channels.replaceChildren();
  seedChannels.forEach((channel) => channelToggle(channel, elements.channels));
  updateSelectionSummary();
}

function renderDiscoveries() {
  elements.discoveries.replaceChildren();
  if (!discoveredChannels.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No additional channels found yet.';
    elements.discoveries.appendChild(empty);
  } else {
    discoveredChannels.forEach((channel) => channelToggle(channel, elements.discoveries, true));
  }
  updateSelectionSummary();
}

function balancedVideos(videos) {
  const buckets = new Map(channels.map((channel) => [channel.id, []]));
  videos.forEach((video) => {
    if (enabledIds.has(video.channelId) && buckets.has(video.channelId)) buckets.get(video.channelId).push(video);
  });
  buckets.forEach((bucket) => bucket.sort((left, right) => Date.parse(right.published) - Date.parse(left.published)));

  const activeBuckets = [...buckets.entries()]
    .filter(([, bucket]) => bucket.length)
    .sort((left, right) => Date.parse(right[1][0].published) - Date.parse(left[1][0].published));
  const result = [];
  let round = 0;
  while (activeBuckets.some(([, bucket]) => bucket[round])) {
    activeBuckets.forEach(([, bucket]) => {
      if (bucket[round]) result.push(bucket[round]);
    });
    round += 1;
  }
  return result;
}

function friendlyDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const elapsed = timestamp - Date.now();
  const absolute = Math.abs(elapsed);
  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000]
  ];
  const [unit, size] = units.find(([, unitSize]) => absolute >= unitSize) || ['minute', 60 * 1000];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(elapsed / size), unit);
}

function emptyState(title, message) {
  const container = document.createElement('div');
  container.className = 'empty-state';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const description = document.createElement('p');
  description.textContent = message;
  container.append(heading, description);
  return container;
}

function renderLoading() {
  elements.feed.replaceChildren();
  const count = Math.min(6, Math.max(3, enabledIds.size));
  for (let index = 0; index < count; index += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    elements.feed.appendChild(skeleton);
  }
}

function videoCard(video) {
  const channel = channels.find((item) => item.id === video.channelId);
  const link = document.createElement('a');
  link.className = 'video-card';
  link.href = video.url;
  link.style.setProperty('--accent', channel?.accent || '#bbc1bc');

  const picture = document.createElement('div');
  picture.className = 'thumbnail-wrap';
  const image = document.createElement('img');
  image.className = 'thumbnail';
  image.src = video.thumbnail;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  const play = document.createElement('span');
  play.className = 'play';
  play.setAttribute('aria-hidden', 'true');
  picture.append(image, play);

  const info = document.createElement('div');
  info.className = 'video-info';
  const title = document.createElement('h3');
  title.className = 'video-title';
  title.textContent = video.title;
  const meta = document.createElement('div');
  meta.className = 'video-meta';
  const name = document.createElement('span');
  name.className = 'video-channel';
  name.textContent = video.channel;
  const dot = document.createElement('span');
  dot.className = 'meta-dot';
  const date = document.createElement('time');
  date.dateTime = video.published;
  date.textContent = friendlyDate(video.published);
  meta.append(name, dot, date);
  info.append(title, meta);
  link.append(picture, info);
  return link;
}

async function refreshFeed() {
  const currentSequence = ++refreshSequence;
  elements.refresh.classList.add('loading');
  elements.refresh.disabled = true;

  if (!enabledIds.size) {
    elements.status.textContent = '';
    elements.feed.replaceChildren(emptyState('No channels included', 'Turn on at least one source above to build your feed.'));
    elements.refresh.classList.remove('loading');
    elements.refresh.disabled = false;
    return;
  }

  if (!window.stillLearn) {
    elements.status.textContent = '';
    elements.feed.replaceChildren(emptyState('Open this inside Still', 'The live YouTube feed is connected through the Still browser.'));
    elements.refresh.classList.remove('loading');
    elements.refresh.disabled = false;
    return;
  }

  elements.status.textContent = 'Checking the newest uploads…';
  renderLoading();
  try {
    const result = await window.stillLearn.feed([...enabledIds]);
    if (currentSequence !== refreshSequence) return;
    const videos = balancedVideos(Array.isArray(result?.videos) ? result.videos : []);
    elements.feed.replaceChildren();
    videos.forEach((video) => elements.feed.appendChild(videoCard(video)));
    if (!videos.length) elements.feed.appendChild(emptyState('No uploads found yet', 'Try refreshing in a moment or include another channel.'));
    const failures = Array.isArray(result?.failed) ? result.failed : [];
    elements.status.textContent = failures.length
      ? `Could not update ${failures.join(', ')}. The other channels are up to date.`
      : `${videos.length} recent videos · rotated evenly across ${enabledIds.size} channel${enabledIds.size === 1 ? '' : 's'}`;
  } catch {
    if (currentSequence !== refreshSequence) return;
    elements.status.textContent = 'The feed could not update right now.';
    elements.feed.replaceChildren(emptyState('Could not reach YouTube', 'Your channel choices are safe. Check the connection and try Refresh.'));
  } finally {
    if (currentSequence === refreshSequence) {
      elements.refresh.classList.remove('loading');
      elements.refresh.disabled = false;
    }
  }
}

elements.selectAll.addEventListener('click', () => {
  const allSelected = channels.length && channels.every((channel) => enabledIds.has(channel.id));
  if (allSelected) enabledIds.clear();
  else enabledIds = new Set(channels.map((channel) => channel.id));
  saveChannels();
  renderChannels();
  renderDiscoveries();
  refreshFeed();
});

elements.refresh.addEventListener('click', refreshFeed);

async function discoverFromHistory(force = false) {
  if (!window.stillLearn?.discover) {
    elements.discoveryStatus.textContent = 'History discovery is available inside Still.';
    renderDiscoveries();
    return;
  }
  elements.scanHistory.classList.add('loading');
  elements.scanHistory.disabled = true;
  elements.discoveryStatus.textContent = 'Checking your recent YouTube history locally…';
  try {
    const result = await window.stillLearn.discover(force);
    discoveredChannels = Array.isArray(result?.channels) ? result.channels : [];
    const seedIds = new Set(seedChannels.map((channel) => channel.id));
    discoveredChannels = discoveredChannels.filter((channel) => !seedIds.has(channel.id));
    channels = [...seedChannels, ...discoveredChannels];
    saveChannels();
    renderDiscoveries();
    if (result?.message) elements.discoveryStatus.textContent = result.message;
    else if (discoveredChannels.length) {
      elements.discoveryStatus.textContent = `Found ${discoveredChannels.length} other channel${discoveredChannels.length === 1 ? '' : 's'} from ${result?.scanned || 0} recent videos. They stay off until you include them.`;
    } else {
      elements.discoveryStatus.textContent = 'No additional channels were found in recent YouTube history.';
    }
    refreshFeed();
  } catch {
    elements.discoveryStatus.textContent = 'Could not scan watch history right now. Your saved choices were not changed.';
    renderDiscoveries();
  } finally {
    elements.scanHistory.classList.remove('loading');
    elements.scanHistory.disabled = false;
  }
}

elements.scanHistory.addEventListener('click', () => discoverFromHistory(true));

async function initialize() {
  let catalog = [];
  let browserSelection = [];
  try { catalog = await window.stillLearn?.catalog(); } catch {}
  try { browserSelection = await window.stillLearn?.selection?.(); } catch {}
  seedChannels = Array.isArray(catalog) && catalog.length ? catalog : FALLBACK_CHANNELS;
  channels = [...seedChannels];
  const saved = readSavedChannels();
  enabledIds = window.stillLearn && Array.isArray(browserSelection)
    ? new Set(browserSelection)
    : saved
      ? new Set(saved)
      : new Set(seedChannels.map((channel) => channel.id));
  saveChannels();
  renderChannels();
  renderDiscoveries();
  refreshFeed();
  discoverFromHistory();
}

initialize();
