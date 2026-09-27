const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const panel = document.querySelector('#suggestions');
const SEARCH_BASE = 'http://127.0.0.1:48230/';

function destination(value) {
  const query = value.trim();
  if (!query) return '';
  if (/^https?:\/\//i.test(query)) return query;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(query)) return `http://${query}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(query)) return `https://${query}`;
  const search = new URL('search', SEARCH_BASE);
  search.searchParams.set('q', query);
  return search.href;
}

function navigate() {
  const target = destination(input.value);
  if (target) location.href = target;
}

function renderSuggestion() {
  const query = input.value.trim();
  panel.replaceChildren();
  panel.hidden = !query;
  if (!query) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'suggestion search-option';
  const title = document.createElement('span');
  title.textContent = `Search Still Search for “${query}”`;
  const label = document.createElement('small');
  label.textContent = 'Private local metasearch';
  button.append(title, label);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', navigate);
  panel.append(button);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  navigate();
});
input.addEventListener('input', renderSuggestion);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') panel.hidden = true;
});
requestAnimationFrame(() => input.focus({ preventScroll: true }));
window.addEventListener('pageshow', () => input.focus({ preventScroll: true }));
