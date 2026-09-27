const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const panel = document.querySelector('#suggestions');
const editorPageUrl = new URL('editor.html', location.href).href;
const learnPageUrl = new URL('learn.html', location.href).href;

let suggestions = [];
let selectedIndex = -1;
let requestNumber = 0;
let searchBaseUrl = '';

function focusSearchInput() {
  input.focus({ preventScroll: true });
}

requestAnimationFrame(focusSearchInput);
window.addEventListener('pageshow', focusSearchInput);

window.stillStart.searchBaseUrl().then((url) => {
  if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) searchBaseUrl = url;
}).catch(() => {});

function defaultSearchUrl(query) {
  if (!searchBaseUrl) return '';
  const target = new URL('search', searchBaseUrl);
  target.searchParams.set('q', query);
  return target.href;
}

function normalizeInput(value) {
  const query = value.trim();
  if (!query) return '';
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedQuery === 'editor') return editorPageUrl;
  if (normalizedQuery === 'learn' || normalizedQuery === 'still learn') return learnPageUrl;
  if (/^https?:\/\//i.test(query)) return query;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(query)) return `http://${query}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(query)) return `https://${query}`;
  return defaultSearchUrl(query);
}

function navigate(url) {
  if (url) location.href = url;
}

function paintSelection() {
  panel.querySelectorAll('.suggestion:not(.search-option)').forEach((element, index) => {
    element.classList.toggle('selected', index === selectedIndex);
  });
}

function suggestionButton(suggestion, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `suggestion${index === selectedIndex ? ' selected' : ''}`;
  const title = document.createElement('span');
  title.textContent = suggestion.title || suggestion.label;
  const address = document.createElement('small');
  address.textContent = suggestion.label;
  button.append(title, address);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('mouseenter', () => {
    selectedIndex = index;
    paintSelection();
  });
  button.addEventListener('click', () => navigate(suggestion.url));
  return button;
}

function renderSuggestions(query) {
  panel.replaceChildren();
  if (!query) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  suggestions.forEach((suggestion, index) => panel.appendChild(suggestionButton(suggestion, index)));

  const search = document.createElement('button');
  search.type = 'button';
  search.className = 'suggestion search-option';
  const title = document.createElement('span');
  const normalizedQuery = query.toLocaleLowerCase();
  const opensEditor = normalizedQuery === 'editor';
  const opensLearn = normalizedQuery === 'learn' || normalizedQuery === 'still learn';
  title.textContent = opensEditor
    ? 'Open blank editor'
    : opensLearn
      ? 'Open Still Learn'
      : `Search Still Search for “${query}”`;
  const label = document.createElement('small');
  label.textContent = opensEditor
    ? 'Local writing page'
    : opensLearn
      ? 'Your selected YouTube channels only'
      : 'Private local metasearch';
  search.append(title, label);
  search.addEventListener('mousedown', (event) => event.preventDefault());
  search.addEventListener('click', () => navigate(normalizeInput(query)));
  panel.appendChild(search);
}

async function updateSuggestions() {
  const query = input.value.trim();
  const currentRequest = ++requestNumber;
  if (!query) {
    suggestions = [];
    selectedIndex = -1;
    renderSuggestions('');
    return;
  }

  try {
    const matches = await window.stillStart.suggestions(query);
    if (currentRequest !== requestNumber) return;
    suggestions = Array.isArray(matches) ? matches : [];
  } catch {
    suggestions = [];
  }
  selectedIndex = suggestions.length ? 0 : -1;
  renderSuggestions(query);
}

function submitSearch() {
  const normalizedInput = input.value.trim().toLocaleLowerCase();
  if (normalizedInput === 'editor') {
    navigate(editorPageUrl);
    return;
  }
  if (normalizedInput === 'learn' || normalizedInput === 'still learn') {
    navigate(learnPageUrl);
    return;
  }
  const selected = selectedIndex >= 0 ? suggestions[selectedIndex] : null;
  const useHistory = selected && selected.score >= 620;
  navigate(useHistory ? selected.url : normalizeInput(input.value));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSearch();
});

input.addEventListener('input', updateSuggestions);
input.addEventListener('focus', updateSuggestions);
input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && suggestions.length) {
    event.preventDefault();
    selectedIndex = (selectedIndex + 1) % suggestions.length;
    paintSelection();
  } else if (event.key === 'ArrowUp' && suggestions.length) {
    event.preventDefault();
    selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
    paintSelection();
  } else if (event.key === 'Escape') {
    panel.hidden = true;
    input.select();
  }
});
