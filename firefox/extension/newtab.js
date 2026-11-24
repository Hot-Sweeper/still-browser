// Still start page and Still Search.
// Home: brand and search box; typing shows matching history instantly.
// Searching stays on this page: the box glides to the top and results from
// the local SearXNG service arrive in Still's own design, with All, Images,
// Videos, and News. The query and kind live in the URL (?q=&c=), so back,
// reload, and session restore work. Every SearXNG page Firefox would show is
// redirected here by the window layer, so Still Search is the only search UI.
const SEARCH_BASE = 'http://127.0.0.1:48230/';
const CATEGORIES = ['general', 'images', 'videos', 'news'];
const root = document.documentElement;
const bar = document.querySelector('#bar');
const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const panel = document.querySelector('#suggestions');
const tabs = document.querySelector('#tabs');
const layout = document.querySelector('#layout');
const results = document.querySelector('#results');
const infobox = document.querySelector('#infobox');
const brand = document.querySelector('#brand');
const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.16, 1, .3, 1)';

let suggestions = [];
let suggestionsFor = '';
let selected = -1;
let suggestToken = 0;
let searchController = null;
let current = { query: '', category: 'general', page: 1 };
let gallery = [];

// ------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

// Small line icons, built as elements (no markup parsing).
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(shapes) {
  const span = el('span', { class: 'glyph', 'aria-hidden': 'true' });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const [name, attributes] of shapes) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    svg.append(node);
  }
  span.append(svg);
  return span;
}

const SEARCH_GLYPH = [['circle', { cx: '10.8', cy: '10.8', r: '6.8' }], ['path', { d: 'm16 16 4.2 4.2' }]];
const GO_GLYPH = [['path', { d: 'M5 12h13m-5-5 5 5-5 5' }]];

function asAddress(value) {
  const text = value.trim();
  if (/^(https?|about|file|moz-extension):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text) && !/\s/.test(text)) return `https://${text}`;
  return '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function prettyUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = decodeURI(parsed.pathname).split('/').filter(Boolean).slice(0, 3);
    return [parsed.hostname.replace(/^www\./, ''), ...parts].join(' › ');
  } catch {
    return url;
  }
}

// A site letter, not a favicon: extension pages cannot read Firefox's icon
// cache, and a third-party favicon service would leak every result host.
function siteLetter(url) {
  const parts = hostOf(url).split('.').filter(Boolean);
  const name = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts.at(-2)) ? parts.at(-3) : parts.at(-2) || parts[0] || '';
  return el('span', { class: 'letter', 'aria-hidden': 'true', 'data-icon-for': url, text: (name[0] || '·').toUpperCase() });
}

// Real site icons replace the letters once Still has them (from Firefox's
// icon store or through Still Search); the letter stays when there is none.
const iconsKnown = new Map();
function applyIcons(scope = document) {
  for (const letter of scope.querySelectorAll('.letter[data-icon-for]')) {
    const icon = iconsKnown.get(letter.dataset.iconFor);
    if (!icon) continue;
    const img = el('img', { class: 'site-icon', src: icon, alt: '', width: 16, height: 16 });
    img.addEventListener('load', () => letter.replaceWith(img), { once: true });
  }
}

function requestIcons(scope = document) {
  const urls = [...new Set([...scope.querySelectorAll('.letter[data-icon-for]')].map((node) => node.dataset.iconFor))]
    .filter((url) => !iconsKnown.has(url));
  if (urls.length) window.dispatchEvent(new CustomEvent('still-favicons-request', { bubbles: true, detail: JSON.stringify(urls.slice(0, 80)) }));
  applyIcons(scope);
}

window.addEventListener('still-favicons', (event) => {
  try {
    for (const [url, icon] of Object.entries(JSON.parse(event.detail || '{}'))) {
      if (typeof icon === 'string' && icon.startsWith('data:image/')) iconsKnown.set(url, icon);
    }
  } catch {}
  applyIcons();
});

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function when(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const seconds = (time - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return relative.format(0, 'minute');
}

// Upstream fields are sometimes the literal text "null" or padded; tidy them.
function clean(value) {
  const text = typeof value === 'string' ? value.replace(/\s*\bnull\s*$/i, '').trim() : '';
  return text === 'null' ? '' : text;
}

function safeHttp(url) {
  return /^https:\/\//i.test(url || '') ? url : '';
}

// --------------------------------------------------------- suggestions

// "(24) YouTube" -> "YouTube": unread counts are not part of a page's name.
function tidyTitle(title) {
  return String(title || '').replace(/^\(\d+\+?\)\s*/, '').trim();
}

async function historyMatches(query) {
  const lower = query.toLowerCase();
  const items = await browser.runtime.sendMessage({ type: 'history-search', text: query }).catch(() => []);
  const scored = new Map();
  const sites = new Map();
  for (const item of items || []) {
    if (!/^https?:/i.test(item.url)) continue;
    let parsed;
    try { parsed = new URL(item.url); } catch { continue; }
    const host = parsed.hostname.replace(/^www\./, '');
    const stem = host.split('.')[0];
    const title = tidyTitle(item.title);
    const visits = Number(item.visitCount) || 0;
    const typed = Number(item.typedCount) || 0;
    let score = Math.min(160, Math.log2(visits + 1) * 24) + Math.min(120, typed * 20);
    if (host.startsWith(lower)) score += 900;
    else if (host.includes(lower)) score += 500;
    if (title.toLowerCase().startsWith(lower)) score += 400;
    else if (title.toLowerCase().includes(lower)) score += 250;
    score -= Math.min(260, parsed.pathname.length * 4 + parsed.search.length * 2);
    // Typing the start of a site's name suggests the site itself first.
    if (stem.startsWith(lower) || host.startsWith(lower)) {
      const root = `${parsed.origin}/`;
      const site = sites.get(root) || { url: root, host, visits: 0, typed: 0, title: '' };
      site.visits += visits;
      site.typed += typed;
      if (parsed.pathname === '/' && title) site.title = title;
      sites.set(root, site);
    }
    // One entry per page title on a site (the same page under many URLs).
    const key = `${host}|${title.toLowerCase() || parsed.pathname}`;
    const existing = scored.get(key);
    if (!existing || existing.score < score) scored.set(key, { url: item.url, title: title || host, label: prettyUrl(item.url), score });
  }
  for (const site of sites.values()) {
    const name = site.title || site.host.split('.')[0].replace(/^./, (c) => c.toUpperCase());
    const score = 1400 + Math.min(300, Math.log2(site.visits + 1) * 40) + Math.min(200, site.typed * 25);
    scored.set(`${site.host}|site`, { url: site.url, title: name, label: site.host, score });
  }
  const unique = new Map();
  for (const match of [...scored.values()].sort((x, y) => y.score - x.score)) {
    const key = match.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    if (!unique.has(key)) unique.set(key, match);
  }
  return [...unique.values()].slice(0, 5);
}

// "youtube.com/@Cytrena": the part that tells pages on one site apart.
function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const path = decodeURI(parsed.pathname).replace(/\/$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

function paintSelection() {
  [...panel.children].forEach((node, index) => {
    node.classList.toggle('selected', index === selected);
    node.setAttribute('aria-selected', String(index === selected));
  });
}

function hideSuggestions() {
  panel.hidden = true;
  form.classList.remove('open');
  suggestions = [];
  selected = -1;
}

async function renderSuggestions() {
  const query = input.value.trim();
  const token = ++suggestToken;
  if (!query || query === current.query) { hideSuggestions(); return; }
  const address = asAddress(query);
  const matches = address ? [] : await historyMatches(query);
  if (token !== suggestToken) return;
  suggestionsFor = query;
  // Only real matches open the list; Enter already searches or opens an
  // address, so a lone "search for what you typed" row adds nothing.
  if (!matches.length) { hideSuggestions(); return; }
  suggestions = [
    ...matches.map((match) => ({ kind: 'page', ...match })),
    { kind: 'search', title: query, label: 'Search' }
  ];
  // Prefer a strong history hit (typed the start of a site) over searching.
  selected = matches[0]?.score >= 900 ? 0 : suggestions.length - 1;
  panel.replaceChildren(...suggestions.map((item, index) => {
    const glyph = item.kind === 'page' ? siteLetter(item.url) : svgIcon(SEARCH_GLYPH);
    const row = el('button', { type: 'button', role: 'option', class: `suggestion ${item.kind}` },
      glyph,
      el('span', { class: 'title', text: item.title }),
      el('span', { class: 'detail', text: item.kind === 'page' ? shortUrl(item.url) : item.label }));
    row.title = item.kind === 'page' ? `${item.title}\n${item.url}` : `Search for ${item.title}`;
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('mouseenter', () => { selected = index; paintSelection(); });
    row.addEventListener('click', () => choose(item));
    return row;
  }));
  panel.hidden = false;
  form.classList.add('open');
  paintSelection();
  requestIcons(panel);
}

function choose(item) {
  hideSuggestions();
  if (item.kind === 'search') search(input.value.trim(), { category: current.category });
  else location.href = item.url;
}

// ------------------------------------------------------- view changes

// Moves the search bar between its centered and top positions smoothly.
function setView(view, { animate = true } = {}) {
  if (root.dataset.view === view) return;
  const before = bar.getBoundingClientRect();
  root.dataset.view = view;
  tabs.hidden = view !== 'results';
  layout.hidden = view !== 'results';
  if (!animate || !motion) return;
  const after = bar.getBoundingClientRect();
  bar.animate([
    { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
    { transform: 'none' }
  ], { duration: 440, easing: EASE });
  if (view === 'results') {
    tabs.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 120, easing: EASE, fill: 'backwards' });
  } else {
    brand.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 60, easing: EASE, fill: 'backwards' });
  }
}

// The underline glides to the chosen kind of results.
function paintTabs(animate = true) {
  const indicator = tabs.querySelector('.tab-indicator');
  let active = null;
  for (const tab of tabs.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.category === current.category;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on) active = tab;
  }
  if (!active) return;
  indicator.style.transition = animate && motion ? '' : 'none';
  indicator.style.transform = `translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth / 100})`;
}

function skeleton(category) {
  if (category === 'images') {
    // Same column layout as the real grid, so nothing jumps when images land.
    const count = columnCount(results.clientWidth || Math.min(window.innerWidth - 48, 1600));
    const heights = [150, 210, 170, 240, 160, 200, 230, 150, 190, 220, 170, 160];
    return [el('div', { class: 'image-grid', 'aria-hidden': 'true' },
      ...Array.from({ length: count }, (_, column) => el('div', { class: 'image-column' },
        ...[0, 1, 2].map((row) => el('i', { class: 'skeleton-tile', style: `height:${heights[(column * 3 + row) % heights.length]}px` })))))];
  }
  return Array.from({ length: 6 }, () => el('div', { class: `skeleton${category === 'videos' ? ' with-thumb' : ''}`, 'aria-hidden': 'true' },
    category === 'videos' ? el('i', { class: 'thumb' }) : null,
    el('div', { class: 'lines' }, el('i'), el('i'), el('i'), el('i'))));
}

function notice(title, detail, retry) {
  const box = el('div', { class: 'notice', role: 'status' }, el('strong', { text: title }), document.createTextNode(detail));
  if (retry) {
    const button = el('button', { type: 'button', text: 'Try again' });
    button.addEventListener('click', retry);
    box.append(el('br'), button);
  }
  return box;
}

// ------------------------------------------------------------- search

async function fetchResults(query, category, page, signal) {
  const url = new URL('search', SEARCH_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', category);
  if (page > 1) url.searchParams.set('pageno', String(page));
  // The service starts with the browser; give it a moment if it is waking.
  const deadline = Date.now() + 9000;
  for (;;) {
    try {
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error(`status ${response.status}`), { status: response.status });
      return await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      if (Date.now() > deadline || error.status) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

function arrive(node, index) {
  if (!motion) return node;
  node.classList.add('arrive');
  node.style.setProperty('--delay', `${Math.min(index, 9) * 26}ms`);
  node.addEventListener('animationend', () => node.classList.remove('arrive'), { once: true });
  return node;
}

function webResult(item, index) {
  return arrive(el('a', { class: 'result', href: item.url },
    el('div', { class: 'site' }, siteLetter(item.url), el('span', { text: prettyUrl(item.url) }),
      item.publishedDate ? el('time', { text: when(item.publishedDate) }) : null),
    el('h3', { text: item.title || hostOf(item.url) }),
    clean(item.content) ? el('p', { text: clean(item.content) }) : null), index);
}

function newsResult(item, index) {
  const thumb = safeHttp(item.thumbnail || item.img_src);
  const image = thumb ? el('img', { class: 'thumb', src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
  image?.addEventListener('error', () => image.remove(), { once: true });
  return arrive(el('a', { class: `result news${thumb ? ' has-thumb' : ''}`, href: item.url },
    el('div', { class: 'body' },
      el('div', { class: 'site' }, siteLetter(item.url), el('span', { text: item.source || hostOf(item.url) }),
        item.publishedDate ? el('time', { text: when(item.publishedDate) }) : null),
      el('h3', { text: item.title || hostOf(item.url) }),
      item.content ? el('p', { text: item.content }) : null),
    image), index);
}

function videoResult(item, index) {
  const thumb = safeHttp(item.thumbnail || item.img_src);
  const meta = [item.author || item.source || hostOf(item.url), item.length, when(item.publishedDate)].filter(Boolean).join(' · ');
  const frame = el('div', { class: 'video-thumb' });
  if (thumb) {
    const img = el('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove(), { once: true });
    frame.append(img);
  }
  return arrive(el('a', { class: 'result video', href: item.url }, frame,
    el('div', { class: 'body' },
      el('h3', { text: item.title || hostOf(item.url) }),
      el('div', { class: 'site' }, siteLetter(item.url), el('span', { text: meta })),
      item.content ? el('p', { text: item.content }) : null)), index);
}

// Images keep their real proportions (space reserved from the reported
// resolution), and open in an in-page preview instead of a new tab.
function imageResult(item, index) {
  const src = safeHttp(item.thumbnail_src || item.img_src);
  if (!src) return null;
  const [width, height] = String(item.resolution || '').split(/\D+/).map(Number);
  const aspect = width && height ? Math.min(3, Math.max(0.33, width / height)) : 4 / 3;
  const ratio = `${aspect} / 1`;
  const position = gallery.push(item) - 1;
  const img = el('img', { src, alt: item.title || '', loading: 'lazy', referrerpolicy: 'no-referrer', style: `aspect-ratio:${ratio}` });
  const tile = el('button', { type: 'button', class: 'image-tile', title: item.title || '', 'aria-label': `Preview: ${item.title || hostOf(item.url)}` },
    img, el('span', { class: 'caption', text: item.source || hostOf(item.url) }));
  tile.dataset.aspect = String(aspect);
  img.addEventListener('error', () => tile.remove(), { once: true });
  tile.addEventListener('click', () => openLightbox(position, img));
  return arrive(tile, index);
}

// Pinterest-style image layout: every tile goes into the currently shortest
// column, using the image's known proportions. Columns stay level, the whole
// width is used, and loading more never moves tiles already on screen.
const masonry = { grid: null, columns: [], heights: [], tiles: [] };
const TILE_WIDTH = 236;
const TILE_GAP = 12;

function columnCount(width) {
  return Math.max(2, Math.floor((width + TILE_GAP) / (TILE_WIDTH + TILE_GAP)));
}

function createMasonry() {
  masonry.grid = el('div', { class: 'image-grid' });
  masonry.tiles = [];
  layoutMasonry();
  return masonry.grid;
}

function layoutMasonry() {
  const grid = masonry.grid;
  if (!grid) return;
  const width = (grid.isConnected ? grid.clientWidth : 0) || results.clientWidth || Math.min(window.innerWidth - 48, 1600);
  const count = columnCount(width);
  if (masonry.columns.length === count && grid.isConnected) return;
  masonry.columns = Array.from({ length: count }, () => el('div', { class: 'image-column' }));
  masonry.heights = new Array(count).fill(0);
  grid.replaceChildren(...masonry.columns);
  const tiles = masonry.tiles;
  masonry.tiles = [];
  masonryAdd(tiles, { animate: false });
}

function masonryAdd(tiles, { animate = true } = {}) {
  for (const tile of tiles) {
    let shortest = 0;
    for (let i = 1; i < masonry.heights.length; i++) if (masonry.heights[i] < masonry.heights[shortest]) shortest = i;
    masonry.columns[shortest].append(tile);
    masonry.heights[shortest] += 1 / Number(tile.dataset.aspect || 1.33) + TILE_GAP / TILE_WIDTH;
    masonry.tiles.push(tile);
    if (!animate) tile.classList.remove('arrive');
  }
}

let masonryResize = 0;
window.addEventListener('resize', () => {
  clearTimeout(masonryResize);
  masonryResize = setTimeout(() => { if (current.category === 'images') layoutMasonry(); }, 120);
});

// Images load the next batch as you near the bottom, like Pinterest.
const nearBottom = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && current.category === 'images' && !entry.target.disabled) entry.target.click();
  }
}, { rootMargin: '900px 0px' });

function renderInfobox(data) {
  const box = (data.infoboxes || [])[0];
  infobox.replaceChildren();
  infobox.hidden = !box;
  layout.classList.toggle('has-infobox', Boolean(box));
  if (!box) return;
  const image = safeHttp(box.img_src);
  const facts = (box.attributes || []).map((fact) => ({ label: clean(fact.label), value: clean(fact.value) }))
    .filter((fact) => fact.label && fact.value).slice(0, 6);
  const links = (box.urls || []).filter((link) => safeHttp(link.url)).slice(0, 5);
  const picture = image ? el('img', { class: 'infobox-image', src: image, alt: '', referrerpolicy: 'no-referrer' }) : null;
  picture?.addEventListener('error', () => picture.remove(), { once: true });
  // append() would print empty parts as the text "null"; drop them first.
  infobox.append(...[
    picture,
    el('h2', { text: clean(box.infobox) || clean(box.title) }),
    clean(box.content) ? el('p', { text: clean(box.content) }) : null,
    facts.length ? el('dl', {}, ...facts.flatMap((fact) => [el('dt', { text: fact.label }), el('dd', { text: fact.value })])) : null,
    links.length ? el('div', { class: 'infobox-links' }, ...links.map((link) => el('a', { href: link.url, text: link.title || hostOf(link.url) }))) : null
  ].filter(Boolean));
  if (motion) infobox.animate([{ opacity: 0, transform: 'translateX(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 80, easing: EASE, fill: 'backwards' });
}

function renderPage(data, query, category, page) {
  const nodes = [];
  if (page === 1) {
    for (const correction of data.corrections || []) {
      const link = el('a', { href: `?q=${encodeURIComponent(correction)}`, text: correction });
      link.addEventListener('click', (event) => { event.preventDefault(); search(correction, { category }); });
      nodes.push(el('div', { class: 'correction' }, document.createTextNode('Did you mean '), link, document.createTextNode('?')));
    }
    if (category === 'general') {
      // Skip answers that only repeat the topic panel's summary.
      const summary = clean((data.infoboxes || [])[0]?.content).slice(0, 80);
      for (const answer of data.answers || []) {
        const text = clean(typeof answer === 'string' ? answer : answer.answer);
        if (text && !(summary && text.startsWith(summary.slice(0, 60)))) nodes.push(el('div', { class: 'answer', text }));
      }
    }
  }
  const seen = new Set([...results.querySelectorAll('a[href]')].map((node) => node.href));
  const items = (data.results || []).filter((item) => /^https?:/i.test(item.url) && !seen.has(item.url));
  const make = { general: webResult, news: newsResult, videos: videoResult, images: imageResult }[category];
  const built = items.map((item, index) => make(item, index)).filter(Boolean);
  if (category === 'images') {
    const grid = page > 1 && masonry.grid?.isConnected ? masonry.grid : createMasonry();
    masonryAdd(built);
    if (page === 1) nodes.push(grid);
  } else {
    nodes.push(...built);
  }
  if (page === 1 && !built.length) {
    const refusing = (data.unresponsive_engines || []).map(([name]) => name);
    if (refusing.length) {
      // Engines that rate-limit or demand a CAPTCHA return nothing; say so
      // instead of claiming the web has no results.
      nodes.push(notice('Search engines are not answering right now',
        `${refusing.join(', ')} refused this search, usually because of too many requests from this connection. Try again in a few minutes.`,
        () => search(query, { category, push: false, animate: false })));
    } else {
      nodes.push(notice('No results', `Still Search found nothing for “${query}”. Try fewer or different words.`));
    }
  }
  return { nodes, count: built.length };
}

function moreButton(query, category, page) {
  const button = el('button', { type: 'button', class: 'more', text: 'More results' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    const controller = new AbortController();
    searchController = controller;
    try {
      const data = await fetchResults(query, category, page + 1, controller.signal);
      if (current.query !== query || current.category !== category) return;
      const { nodes, count } = renderPage(data, query, category, page + 1);
      const next = count ? moreButton(query, category, page + 1) : null;
      button.replaceWith(...nodes, ...(next ? [next] : []));
      if (next && category === 'images') nearBottom.observe(next);
      current.page = page + 1;
      requestIcons(results);
    } catch {
      if (current.query !== query) return;
      button.disabled = false;
      button.textContent = 'More results';
    }
  });
  return button;
}

function stateUrl(query, category) {
  const query_ = new URLSearchParams({ q: query });
  if (category !== 'general') query_.set('c', category);
  return `${location.pathname}?${query_}`;
}

async function search(query, { category = 'general', push = true, animate = true } = {}) {
  query = query.trim();
  if (!query) return;
  if (!CATEGORIES.includes(category)) category = 'general';
  const address = asAddress(query);
  if (address) { location.href = address; return; }
  hideSuggestions();
  input.value = query;
  // The search is made: the box lets go, so no cursor keeps blinking in it.
  // Typing anywhere on the page still goes straight back to it.
  if (document.activeElement === input) input.blur();
  summaryController?.abort();
  current = { query, category, page: 1 };
  gallery = [];
  document.title = `${query} · Still Search`;
  const url = stateUrl(query, category);
  if (push && `${location.pathname}${location.search}` !== url) history.pushState({}, '', url);
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  // Respond at once: the bar moves and result shapes appear immediately.
  results.replaceChildren(...skeleton(category));
  infobox.hidden = true;
  layout.classList.remove('has-infobox');
  root.dataset.category = category;
  const wasResults = root.dataset.view === 'results';
  setView('results', { animate });
  paintTabs(wasResults);
  window.scrollTo({ top: 0 });
  try {
    const data = await fetchResults(query, category, 1, controller.signal);
    if (controller.signal.aborted || current.query !== query || current.category !== category) return;
    const { nodes, count } = renderPage(data, query, category, 1);
    const extra = [];
    const related = category === 'general' ? (data.suggestions || []).slice(0, 6) : [];
    if (related.length) {
      const row = el('div', { class: 'related' }, document.createTextNode('Related: '));
      for (const text of related) {
        const link = el('a', { href: `?q=${encodeURIComponent(text)}`, text });
        link.addEventListener('click', (event) => { event.preventDefault(); search(text); });
        row.append(link);
      }
      extra.push(row);
    }
    const more = count >= 8 ? moreButton(query, category, 1) : null;
    results.replaceChildren(...nodes, ...(more ? [more] : []), ...extra);
    if (category === 'images') {
      layoutMasonry();
      if (more) nearBottom.observe(more);
    }
    if (category === 'general') { renderInfobox(data); renderSummary(data, query); }
    requestIcons(results);
  } catch {
    if (controller.signal.aborted || current.query !== query) return;
    results.replaceChildren(notice('Still Search is not responding',
      'The local search service did not answer. It starts with Still; if this keeps happening, restart Still.',
      () => search(query, { category, push: false, animate: false })));
  }
}

// ------------------------------------------------------------ summary
// A short answer above the results, written by the user's own GridAPI (a
// local model on their GPU server) from the results on this page. It
// streams in, cites results as [1], [2], and takes follow-up questions.
// Still writes the address into local-config.json on this machine (from
// GridUI's settings or the still.search.ai pref); without one, no summary.

const SUMMARY_SOURCES = 8;
const FOLLOW_GLYPH = [['path', { d: 'M5 7.5h9.5a4.5 4.5 0 0 1 0 9H9M8.5 4 5 7.5 8.5 11' }]];
const summaryCache = new Map();        // query -> { messages, turns }
let summaryController = null;
const aiConfig = fetch('local-config.json', { cache: 'no-store' })
  .then((response) => (response.ok ? response.json() : {}))
  .then((config) => (/^https?:\/\//.test(config.aiEndpoint || '') ? config : {}))
  .catch(() => ({}));

function summaryPrompt(query, sources) {
  const list = sources.map((item, index) => `[${index + 1}] ${item.title}\n${item.url}\n${item.content}`).join('\n\n');
  return [
    { role: 'system', content: 'You answer web searches inside a browser. Use only the numbered search results. '
      + 'Answer in the language of the query, in 2 to 4 short sentences of plain text: no headings, no lists unless the query asks for steps. '
      + 'Wrap the exact fact the query asks for in **double asterisks** (for example **330 meters**, a date, a name or a price), once or twice per answer; make nothing else bold. '
      + 'Put citations like [1] or [2][3] right after the sentence they support. If the results do not answer the query, say so in one sentence.' },
    { role: 'user', content: `Query: ${query}\n\nSearch results:\n\n${list}` }
  ];
}

// A site's short name: "en.wikipedia.org" -> "Wikipedia".
function siteName(url) {
  const parts = hostOf(url).split('.').filter(Boolean);
  const name = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts.at(-2)) ? parts.at(-3) : parts.at(-2) || parts[0] || '';
  return name ? name[0].toUpperCase() + name.slice(1) : hostOf(url);
}

// A site's icon when Still already has it, else its letter (swapped for the
// icon once it arrives).
function siteIcon(url) {
  const known = iconsKnown.get(url);
  return known ? el('img', { class: 'site-icon', src: known, alt: '', width: 16, height: 16 }) : siteLetter(url);
}

// Citations like [2][5][6] become one chip: the main source's icon with the
// others' tucked behind it, its name, and how many more back the sentence.
function citeChip(numbers, sources) {
  const used = [];
  const hosts = new Set();
  for (const number of numbers) {
    const source = sources[number - 1];
    if (!source || hosts.has(hostOf(source.url))) continue;
    hosts.add(hostOf(source.url));
    used.push(source);
  }
  if (!used.length) return null;
  const [main, ...rest] = used;
  return el('a', { class: 'cite', href: main.url, title: used.map((source) => `${source.title} (${hostOf(source.url)})`).join('\n') },
    el('span', { class: 'cite-icons', 'aria-hidden': 'true' }, ...used.slice(0, 3).map((source) => siteIcon(source.url))),
    el('span', { class: 'cite-name', text: siteName(main.url) }),
    rest.length ? el('span', { class: 'cite-more', text: `+${rest.length}` }) : null);
}

// The model's text: **the asked-for fact** in bold, citations as chips.
// While it streams, an unclosed ** stays bold up to the end.
function citedText(text, sources) {
  const out = document.createDocumentFragment();
  // Sources follow the sentence's own full stop: "tall.[1]" not "tall[1]."
  const plain = text.replace(/__|^#+\s*/gm, '').replace(/\s+(?=\[\d{1,2}\])/g, '')
    .replace(/((?:\[\d{1,2}\])+)([.,;:!?])/g, '$2$1');
  let target = out;
  let last = 0;
  const flush = (end) => { if (end > last) target.append(document.createTextNode(plain.slice(last, end))); };
  for (const match of plain.matchAll(/\*\*|(?:\[\d{1,2}\])+/g)) {
    flush(match.index);
    last = match.index + match[0].length;
    if (match[0] === '**') {
      if (target === out) { target = el('strong'); out.append(target); } else target = out;
      continue;
    }
    const chip = citeChip([...match[0].matchAll(/\d+/g)].map(Number), sources);
    if (chip) out.append(chip);
  }
  flush(plain.length);
  return [out];
}

async function streamChat(endpoint, messages, signal, onText) {
  const response = await fetch(new URL('v1/chat/completions', endpoint), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-GridAPI-Project': 'Still', 'X-GridAPI-Title': 'Search summary' },
    body: JSON.stringify({ messages, stream: true, max_tokens: 400, temperature: 0.3 })
  });
  if (!response.ok || !response.body) throw new Error(`status ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return text;
      try {
        const piece = JSON.parse(data).choices?.[0]?.delta?.content;
        if (piece) { text += piece; onText(text); }
      } catch {}
    }
  }
  return text;
}

function summaryTurn(question) {
  const body = el('p', { class: 'summary-text' }, el('span', { class: 'summary-wait', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')));
  return { node: el('div', { class: 'summary-turn' }, question ? el('p', { class: 'summary-question', text: question }) : null, body), body };
}

async function runTurn(state, turn, endpoint) {
  const { sources } = state;
  try {
    const text = await streamChat(endpoint, state.messages, state.signal, (partial) => turn.body.replaceChildren(...citedText(partial, sources)));
    if (!text.trim()) throw new Error('empty');
    turn.body.replaceChildren(...citedText(text, sources));
    requestIcons(turn.body);
    state.messages.push({ role: 'assistant', content: text });
    state.turns.push({ question: turn.question || '', text });
    return true;
  } catch (error) {
    if (turn.question) state.messages.pop();
    if (state.signal.aborted) return false;
    turn.body.replaceChildren(el('span', { class: 'summary-error', text: 'Your GridAPI did not answer, so there is no summary. It may be busy with another job.' }));
    return false;
  }
}

async function renderSummary(data, query) {
  summaryController?.abort();
  const config = await aiConfig;
  if (!config.aiEndpoint || current.query !== query || current.category !== 'general') return;
  const sources = (data.results || []).filter((item) => safeHttp(item.url) && clean(item.content))
    .slice(0, SUMMARY_SOURCES).map((item) => ({ title: clean(item.title) || hostOf(item.url), url: item.url, content: clean(item.content).slice(0, 500) }));
  if (sources.length < 2) return;
  const controller = new AbortController();
  summaryController = controller;
  const cached = summaryCache.get(query);
  const state = { sources, signal: controller.signal, messages: cached?.messages || summaryPrompt(query, sources), turns: cached?.turns || [] };
  summaryCache.set(query, state);

  const turns = el('div', { class: 'summary-turns' });
  const ask = el('input', { class: 'summary-ask', type: 'text', placeholder: 'Ask about these results', 'aria-label': 'Follow-up question about these results', autocomplete: 'off', spellcheck: 'false' });
  const form_ = el('form', { class: 'summary-form', hidden: true }, ask);
  const follow = el('button', { type: 'button', class: 'summary-follow', hidden: true }, svgIcon(FOLLOW_GLYPH), document.createTextNode('Follow up'));
  const block = el('section', { class: 'summary', 'aria-label': 'Summary', 'aria-busy': 'true' }, turns, follow, form_);
  // Follow up opens a small field in its place; leaving it empty folds it back.
  const fold = () => { form_.hidden = true; follow.hidden = false; };
  follow.addEventListener('click', () => {
    follow.hidden = true;
    form_.hidden = false;
    ask.focus();
    if (motion) form_.animate([{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE });
  });
  ask.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ask.value = ''; fold(); follow.focus(); } });
  ask.addEventListener('blur', () => { if (!ask.value.trim() && block.getAttribute('aria-busy') !== 'true') fold(); });
  results.prepend(block);
  if (motion) block.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });

  if (state.turns.length) {
    for (const past of state.turns) {
      const turn = summaryTurn(past.question);
      turn.body.replaceChildren(...citedText(past.text, sources));
      turns.append(turn.node);
    }
    requestIcons(turns);
  } else {
    const turn = summaryTurn('');
    turns.append(turn.node);
    if (!(await runTurn(state, turn, config.aiEndpoint))) { block.setAttribute('aria-busy', 'false'); return; }
  }
  block.setAttribute('aria-busy', 'false');
  follow.hidden = false;

  form_.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = ask.value.trim();
    if (!question || block.getAttribute('aria-busy') === 'true') return;
    ask.value = '';
    block.setAttribute('aria-busy', 'true');
    const turn = summaryTurn(question);
    turn.question = question;
    turns.append(turn.node);
    state.messages.push({ role: 'user', content: question });
    await runTurn(state, turn, config.aiEndpoint);
    block.setAttribute('aria-busy', 'false');
    ask.focus();
  });
}

function goHome({ push = true } = {}) {
  searchController?.abort();
  summaryController?.abort();
  current = { query: '', category: 'general', page: 1 };
  document.title = 'Still';
  input.value = '';
  results.replaceChildren();
  infobox.hidden = true;
  if (push) history.pushState({}, '', location.pathname);
  setView('home');
  input.focus({ preventScroll: true });
}

// ------------------------------------------------------------ lightbox

const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-image');
let lightboxIndex = -1;
let lightboxReturn = null;

function showInLightbox(index) {
  const item = gallery[index];
  if (!item) return;
  lightboxIndex = index;
  const full = safeHttp(item.img_src) || safeHttp(item.thumbnail_src);
  const thumb = safeHttp(item.thumbnail_src) || full;
  // Show the thumbnail at once, then swap in the full image when it is ready.
  lightboxImage.src = thumb;
  if (full && full !== thumb) {
    const loader = new Image();
    loader.referrerPolicy = 'no-referrer';
    loader.onload = () => { if (lightboxIndex === index) lightboxImage.src = full; };
    loader.src = full;
  }
  lightboxImage.alt = item.title || '';
  document.querySelector('#lightbox-title').textContent = item.title || hostOf(item.url);
  document.querySelector('#lightbox-meta').textContent = [item.source || hostOf(item.url), item.resolution].filter(Boolean).join(' · ');
  document.querySelector('#lightbox-open').href = item.url;
  document.querySelector('#lightbox-previous').disabled = index <= 0;
  document.querySelector('#lightbox-next').disabled = index >= gallery.length - 1;
}

function openLightbox(index, fromImage) {
  lightboxReturn = document.activeElement;
  showInLightbox(index);
  lightbox.hidden = false;
  document.querySelector('#lightbox-close').focus({ preventScroll: true });
  if (!motion || !fromImage) return;
  // Grow out of the tile that was clicked.
  requestAnimationFrame(() => {
    const from = fromImage.getBoundingClientRect();
    const to = lightboxImage.getBoundingClientRect();
    if (!to.width || !to.height) return;
    lightboxImage.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { transform: 'none' }
    ], { duration: 380, easing: EASE });
    lightbox.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  });
}

function closeLightbox() {
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  lightboxImage.removeAttribute('src');
  lightboxReturn?.focus?.({ preventScroll: true });
}

function stepLightbox(step) {
  const next = lightboxIndex + step;
  if (next < 0 || next >= gallery.length) return;
  showInLightbox(next);
  if (motion) lightboxImage.animate([{ opacity: 0.2, transform: `translateX(${step * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
}

document.querySelector('#lightbox-close').addEventListener('click', closeLightbox);
document.querySelector('#lightbox-previous').addEventListener('click', () => stepLightbox(-1));
document.querySelector('#lightbox-next').addEventListener('click', () => stepLightbox(1));
lightbox.addEventListener('click', (event) => { if (event.target === lightbox) closeLightbox(); });

// --------------------------------------------------------------- events

form.addEventListener('submit', (event) => {
  event.preventDefault();
  // Only trust a suggestion made for exactly what is in the box now; fast
  // typing can press Enter before matches for the last letters arrive.
  const item = suggestions[selected];
  if (item && !panel.hidden && suggestionsFor === input.value.trim()) choose(item);
  else search(input.value, { category: current.category });
});

tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !current.query || tab.dataset.category === current.category) return;
  search(current.query, { category: tab.dataset.category, animate: false });
});

tabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const index = CATEGORIES.indexOf(current.category) + (event.key === 'ArrowRight' ? 1 : -1);
  const next = CATEGORIES[(index + CATEGORIES.length) % CATEGORIES.length];
  search(current.query, { category: next, animate: false });
  tabs.querySelector(`[data-category="${next}"]`)?.focus();
});

document.querySelector('#home-mark').addEventListener('click', (event) => {
  event.preventDefault();
  goHome();
});

input.addEventListener('input', renderSuggestions);
input.addEventListener('focus', () => { if (input.value.trim() && input.value.trim() !== current.query) renderSuggestions(); });
input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) hideSuggestions(); }, 100));
input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    if (!panel.hidden && suggestions.length) {
      event.preventDefault();
      selected = (selected + 1) % suggestions.length;
      paintSelection();
    } else if (root.dataset.view === 'results') {
      const first = results.querySelector('.result, .image-tile');
      if (first) { event.preventDefault(); first.focus(); }
    }
  } else if (event.key === 'ArrowUp' && !panel.hidden && suggestions.length) {
    event.preventDefault();
    selected = (selected - 1 + suggestions.length) % suggestions.length;
    paintSelection();
  } else if (event.key === 'Escape') {
    if (!panel.hidden) { event.preventDefault(); hideSuggestions(); }
    else if (root.dataset.view === 'results') { event.preventDefault(); input.value = current.query; input.select(); }
  }
});

// Arrow keys move between results; Escape returns to the box.
results.addEventListener('keydown', (event) => {
  const items = [...results.querySelectorAll('.result, .image-tile')];
  const index = items.indexOf(document.activeElement);
  if (index < 0) return;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowRight') && items[index + 1]) { event.preventDefault(); items[index + 1].focus(); }
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); (items[index - 1] || input).focus(); }
  else if (event.key === 'Escape') { event.preventDefault(); input.focus(); }
});

document.addEventListener('keydown', (event) => {
  if (!lightbox.hidden) {
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stepLightbox(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); stepLightbox(1); }
    return;
  }
  // Typing anywhere on the page goes to the box.
  if (event.target === input || event.target.closest?.('input, textarea') || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
  input.focus({ preventScroll: true });
});

window.addEventListener('popstate', () => {
  closeLightbox();
  const state = new URLSearchParams(location.search);
  const query = state.get('q');
  if (query) search(query, { category: state.get('c') || 'general', push: false });
  else goHome({ push: false });
});

window.addEventListener('resize', () => paintTabs(false));

// ---------------------------------------------------------------- start

const startParams = new URLSearchParams(location.search);
const initial = startParams.get('q');
if (initial) {
  search(initial, { category: startParams.get('c') || 'general', push: false, animate: false });
} else if (motion) {
  // A new slot opens with the mark settling and the box widening into place.
  // Purely visual: the box is focused and typing works from the first frame.
  brand.querySelector('img').animate([
    { transform: 'scale(.82) rotate(-6deg)', opacity: 0 },
    { transform: 'none', opacity: 1 }
  ], { duration: 520, easing: 'cubic-bezier(.22, 1.25, .36, 1)', fill: 'backwards' });
  brand.querySelector('span').animate([
    { transform: 'translateX(-10px)', opacity: 0 },
    { transform: 'none', opacity: 1 }
  ], { duration: 420, delay: 70, easing: EASE, fill: 'backwards' });
  form.querySelector('.search-box').animate([
    { transform: 'scaleX(.94)', opacity: 0 },
    { transform: 'none', opacity: 1 }
  ], { duration: 460, delay: 40, easing: EASE, fill: 'backwards' });
}
requestAnimationFrame(() => { if (!initial) input.focus({ preventScroll: true }); });
window.addEventListener('pageshow', () => { if (!current.query) input.focus({ preventScroll: true }); });
