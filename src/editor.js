const editor = document.querySelector('#editor');

editor.focus({ preventScroll: true });

editor.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText('  ', start, end, 'end');
});
