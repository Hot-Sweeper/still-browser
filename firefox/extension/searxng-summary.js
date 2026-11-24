// Summaries on SearXNG's own result pages (when SearXNG, not Still Search,
// is the chosen engine): the same short answer Still Search shows, written
// by the GridAPI Still found, from the results on the page. The asked-for
// fact is bold, each sentence carries its sources' icons, and Follow up
// asks more about the same results.
(() => {
  if (!/searxng/i.test(document.querySelector('meta[name="generator"]')?.content || '')) return;
  const main = document.querySelector('#main_results');
  const urls = document.querySelector('#urls');
  const query = new URLSearchParams(location.search).get('q') || document.querySelector('input[name="q"]')?.value || '';
  if (!main || !urls || !query.trim()) return;

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(Boolean));
    return node;
  };
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const siteName = (url) => {
    const parts = host(url).split('.');
    const name = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts.at(-2)) ? parts.at(-3) : parts.at(-2) || parts[0] || '';
    return name ? name[0].toUpperCase() + name.slice(1) : host(url);
  };

  const sources = [...urls.querySelectorAll('article.result')].map((article) => {
    const link = article.querySelector('h3 a');
    return link && /^https:/.test(link.href) ? {
      url: link.href,
      title: link.textContent.trim(),
      content: (article.querySelector('.content')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      icon: article.querySelector('.favicon img')?.src || ''
    } : null;
  }).filter((item) => item?.content).slice(0, 8);
  if (sources.length < 2) return;

  const messages = [
    { role: 'system', content: 'You answer web searches inside a browser. Use only the numbered search results. '
      + 'Answer in the language of the query, in 2 to 4 short sentences of plain text: no headings, no lists unless the query asks for steps. '
      + 'Wrap the exact fact the query asks for in **double asterisks** (for example **330 meters**, a date, a name or a price), once or twice per answer; make nothing else bold. '
      + 'Put citations like [1] or [2][3] right after the sentence they support. If the results do not answer the query, say so in one sentence.' },
    { role: 'user', content: `Query: ${query}\n\nSearch results:\n\n${sources.map((item, index) => `[${index + 1}] ${item.title}\n${item.url}\n${item.content}`).join('\n\n')}` }
  ];

  function chip(numbers) {
    const used = [];
    for (const number of numbers) {
      const source = sources[number - 1];
      if (source && !used.some((item) => host(item.url) === host(source.url))) used.push(source);
    }
    if (!used.length) return null;
    return el('a', { class: 'still-cite', href: used[0].url, title: used.map((item) => `${item.title} (${host(item.url)})`).join('\n') },
      el('span', { class: 'still-cite-icons' }, ...used.slice(0, 3).map((item) => item.icon
        ? el('img', { src: item.icon, alt: '' }) : el('span', { class: 'still-cite-letter', text: siteName(item.url)[0] || '·' }))),
      el('span', { text: siteName(used[0].url) }),
      used.length > 1 ? el('span', { class: 'still-cite-more', text: `+${used.length - 1}` }) : null);
  }

  function rich(text) {
    const out = document.createDocumentFragment();
    const plain = text.replace(/__|^#+\s*/gm, '').replace(/\s+(?=\[\d{1,2}\])/g, '').replace(/((?:\[\d{1,2}\])+)([.,;:!?])/g, '$2$1');
    let target = out;
    let last = 0;
    const flush = (end) => { if (end > last) target.append(document.createTextNode(plain.slice(last, end))); };
    for (const match of plain.matchAll(/\*\*|(?:\[\d{1,2}\])+/g)) {
      flush(match.index);
      last = match.index + match[0].length;
      if (match[0] === '**') { if (target === out) { target = el('strong'); out.append(target); } else target = out; continue; }
      const node = chip([...match[0].matchAll(/\d+/g)].map(Number));
      if (node) out.append(node);
    }
    flush(plain.length);
    return out;
  }

  async function stream(endpoint, onText) {
    const response = await fetch(new URL('v1/chat/completions', endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GridAPI-Project': 'Still', 'X-GridAPI-Title': 'SearXNG summary' },
      body: JSON.stringify({ messages, stream: true, max_tokens: 400, temperature: 0.3 })
    });
    if (!response.ok || !response.body) throw Object.assign(new Error(`status ${response.status}`), { status: response.status });
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
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try { const piece = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content; if (piece) { text += piece; onText(text); } } catch {}
      }
    }
    return text;
  }

  const turns = el('div', { class: 'still-turns' });
  const follow = el('button', { type: 'button', class: 'still-follow', hidden: true, text: 'Follow up' });
  const ask = el('input', { class: 'still-ask', type: 'text', placeholder: 'Ask about these results', 'aria-label': 'Follow-up question about these results' });
  const form = el('form', { class: 'still-form', hidden: true }, ask);
  const block = el('section', { class: 'still-summary', 'aria-label': 'Summary', 'aria-busy': 'true' }, turns, follow, form);

  async function turn(question, endpoint) {
    const body = el('p', { class: 'still-text' }, el('span', { class: 'still-wait' }, el('i'), el('i'), el('i')));
    turns.append(el('div', { class: 'still-turn' }, question ? el('p', { class: 'still-question', text: question }) : null, body));
    block.setAttribute('aria-busy', 'true');
    for (const delay of [0, 1500, 4000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      let streamed = false;
      try {
        const text = await stream(endpoint, (partial) => { streamed = true; body.replaceChildren(rich(partial)); });
        if (!text.trim()) throw new Error('empty');
        messages.push({ role: 'assistant', content: text });
        block.setAttribute('aria-busy', 'false');
        return true;
      } catch (error) {
        if (streamed) break;
      }
    }
    if (question) messages.pop();
    body.replaceChildren(el('span', { class: 'still-error', text: 'No summary: your GridAPI did not answer.' }));
    block.setAttribute('aria-busy', 'false');
    return false;
  }

  browser.runtime.sendMessage({ type: 'local-config' }).then(async (config) => {
    const endpoint = /^https?:\/\//.test(config?.aiEndpoint || '') ? config.aiEndpoint : '';
    if (!endpoint) return;
    urls.parentNode.insertBefore(block, urls);
    if (await turn('', endpoint)) follow.hidden = false;
    follow.addEventListener('click', () => { follow.hidden = true; form.hidden = false; ask.focus(); });
    ask.addEventListener('blur', () => { if (!ask.value.trim() && block.getAttribute('aria-busy') !== 'true') { form.hidden = true; follow.hidden = false; } });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const question = ask.value.trim();
      if (!question || block.getAttribute('aria-busy') === 'true') return;
      ask.value = '';
      messages.push({ role: 'user', content: question });
      await turn(question, endpoint);
      ask.focus();
    });
  }).catch(console.error);
})();
