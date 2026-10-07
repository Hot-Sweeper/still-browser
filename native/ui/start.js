'use strict';
document.getElementById('search-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = StillModel.safeAddress(document.getElementById('search-input').value);
  if (url) location.assign(url);
});
