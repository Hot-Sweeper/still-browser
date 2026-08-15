const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const panel = document.querySelector('#suggestions');

let suggestions = [];
let selectedIndex = -1;
let requestNumber = 0;

function normalizeInput(value) {
  const query = value.trim();
  if (!query) return '';
  if (/^https?:\/\//i.test(query)) return query;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(query)) return `http://${query}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(query)) return `https://${query}`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
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
  title.textContent = `Search Google for “${query}”`;
  const label = document.createElement('small');
  label.textContent = 'Google search';
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
