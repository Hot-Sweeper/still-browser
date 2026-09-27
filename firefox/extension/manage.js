async function render() {
  const { source, learning } = await browser.runtime.sendMessage({ type: 'get-catalog' });
  const enabled = new Set(learning.map((channel) => channel.id));
  const root = document.querySelector('#channels');
  root.replaceChildren();
  for (const channel of source.learningChannels) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled.has(channel.id);
    input.dataset.channelId = channel.id;
    const name = document.createElement('span');
    name.textContent = channel.name;
    label.append(input, name);
    root.append(label);
  }
  root.addEventListener('change', async () => {
    const ids = [...root.querySelectorAll('input:checked')].map((input) => input.dataset.channelId);
    await browser.storage.local.set({ enabledChannelIds: ids });
  });
}
render().catch((error) => {
  document.querySelector('#channels').textContent = `Could not load channels: ${error.message}`;
});
