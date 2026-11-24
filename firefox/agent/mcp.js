// `still mcp`: an MCP server (stdio) that lets agents such as Claude Code,
// Codex or T3 Code use Still, the person's own browser, with their sign-ins.
// Every tool forwards to the agent bridge inside Still (StillAgent.sys.mjs).
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
const { StillClient } = require('./client');

const INSTRUCTIONS = `Still is the user's own web browser (Firefox based), with their tabs, cookies and saved sign-ins. Use it when a task needs the web as the user sees it: their accounts, mail, dashboards, or sites that need a login.

How to work:
- Call tabs to see what is open. Tabs have numeric ids. open_tab opens a page in a hidden agent tab, so the user's five visible slots are not disturbed; show_tab brings a tab to the user when they need to see or do something (a captcha, a payment, a confirmation).
- Call snapshot to read a page as an accessibility tree. Elements you can use carry refs like [ref=e12] (refs inside frames look like f2e5). Pass a ref to click, type, fill_form, select_option, hover, drag or upload_files. Refs come from the latest snapshot of that tab; after the page changes, take a new one.
- Actions return the page's new snapshot, so you usually do not need to call snapshot again.
- read_page returns the page text (faster than a snapshot for reading mail or articles). screenshot returns an image.
- Popups (for example "Sign in with Google") open as new tabs or popup windows; they show up in tabs and in the events after an action. Dialogs (alert, confirm, prompt) must be answered with handle_dialog.
- signed_in_sites tells you where the user is signed in. log_in fills a page's sign-in form from Firefox's saved passwords without revealing them to you; prefer it to asking for passwords.
- Close the tabs you opened with close_tab as soon as you no longer need them, and when your task is done. Still also closes agent tabs nobody has used for 15 minutes, and the tabs of an agent that disconnects.
- Be careful with irreversible actions (sending mail, buying, deleting, posting): confirm with the user first unless they clearly asked for it.`;

const FRIENDLY = { 'claude-code': 'Claude Code', claude: 'Claude', codex: 'Codex', 'codex-mcp-client': 'Codex', t3: 'T3 Code', 't3-code': 'T3 Code', cursor: 'Cursor', vscode: 'VS Code' };

function friendlyName(info) {
  const raw = String(info?.name || '').trim();
  if (!raw) return 'An agent';
  const key = raw.toLowerCase();
  for (const [needle, name] of Object.entries(FRIENDLY)) if (key === needle || key.startsWith(needle)) return name;
  if (key.includes('t3')) return 'T3 Code';
  return raw.slice(0, 40);
}

function main() {
  const server = new McpServer({ name: 'still', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  let client = null;
  let connecting = null;

  async function still() {
    if (client?.socket) return client;
    connecting ||= (async () => {
      // Still's side chat names its agent itself ("Codex (side chat)").
      const name = process.env.STILL_AGENT_CLIENT || friendlyName(server.server.getClientVersion?.());
      const next = new StillClient({ client: name });
      await next.connect({ launch: true });
      client = next;
      return next;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function describeEvents(events) {
    const lines = [];
    for (const event of events) {
      if (event.type === 'dialog') lines.push(`- A ${event.dialog} dialog opened on tab ${event.tab}: "${event.message}". Answer it with handle_dialog.`);
      else if (event.type === 'tab-opened') lines.push(`- New ${event.tab.place === 'popup' ? 'popup window' : 'tab'} ${event.tab.id}${event.tab.opener ? ` (opened by tab ${event.tab.opener})` : ''}: ${event.tab.title || event.tab.url}`);
      else if (event.type === 'tab-closed') lines.push('- A tab closed.');
      else if (event.type === 'download') lines.push(`- Download started: ${event.file} (see downloads)`);
    }
    return lines.length ? `\n\nEvents:\n${lines.join('\n')}` : '';
  }

  function tabLine(tab) {
    if (!tab) return '';
    const where = tab.slot ? `slot ${tab.slot}` : tab.place === 'popup' ? 'popup window' : tab.place === 'agent' ? 'agent tab' : tab.place;
    return `Tab ${tab.id} (${where}${tab.active ? ', in front' : ''}${tab.loading ? ', loading' : ''}): ${tab.title || 'Untitled'}\n${tab.url}`;
  }

  // Run a bridge method and turn the result into MCP content.
  async function run(method, params, format) {
    try {
      const c = await still();
      const result = await c.call(method, params);
      const content = await format(result, c);
      const events = describeEvents(c.takeEvents());
      if (events) {
        const text = content.find((item) => item.type === 'text');
        if (text) text.text += events;
        else content.push({ type: 'text', text: events.trim() });
      }
      return { content };
    } catch (error) {
      const events = client ? describeEvents(client.takeEvents()) : '';
      return { content: [{ type: 'text', text: `${error.message}${events}` }], isError: true };
    }
  }

  const text = (value) => [{ type: 'text', text: value }];
  const json = (value) => text(JSON.stringify(value, null, 2));

  // After an action, show where things stand: the page's new snapshot.
  async function afterAction(result, c, params) {
    if (params.snapshot === false || !result?.tab) return text(tabLine(result?.tab) || 'Done.');
    try {
      const snap = await c.call('page.snapshot', { tab: result.tab.id, max_chars: params.max_chars || 20000 });
      return text(snap.text);
    } catch (error) {
      return text(`${tabLine(result.tab)}\n(Could not read the page afterwards: ${error.message})`);
    }
  }

  const tab = z.number().int().describe('Tab id from tabs');
  const ref = z.string().describe('Element ref from the latest snapshot, like e12 or f2e5');
  const snapshotOption = { snapshot: z.boolean().optional().describe('Return the page snapshot afterwards (default true)') };
  const read = { readOnlyHint: true, openWorldHint: true };
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  const tools = [
    ['tabs', 'List the open tabs in Still: the five visible slots, hidden agent tabs, and popup windows.', {}, read,
      () => run('tabs.list', {}, (r) => text(r.tabs.map(tabLine).join('\n\n') || 'No tabs.'))],
    ['open_tab', 'Open a page in a new hidden agent tab (outside the user\'s five slots) and return its snapshot. Set visible to put it in a slot in front of the user instead.',
      { url: z.string().describe('Address or search words'), visible: z.boolean().optional() }, act,
      (p) => run('tabs.open', p, (r, c) => afterAction(r, c, p))],
    ['show_tab', 'Bring a tab in front of the user. A hidden agent tab joins the slots (Still asks the user which slot to replace when all five are full). Use when the user needs to see or do something.',
      { tab }, act, (p) => run('tabs.select', p, (r) => text(tabLine(r.tab)))],
    ['close_tab', 'Close a tab. Close your agent tabs when you are done with them.', { tab }, { ...act, destructiveHint: true }, (p) => run('tabs.close', p, (r) => text(`Closed tab ${r.closed.id}: ${r.closed.title}`))],
    ['navigate', 'Go to an address in a tab, or go back, forward, or reload.',
      { tab, url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional(), ...snapshotOption }, act,
      (p) => run('tabs.navigate', p, (r, c) => afterAction(r, c, p))],
    ['snapshot', 'Read a page as an accessibility tree with refs for the elements you can use.',
      { tab, max_chars: z.number().int().optional().describe('Cut the snapshot at this length (default 60000)') }, read,
      (p) => run('page.snapshot', p, (r) => text(r.text))],
    ['read_page', 'Get the readable text of a page (main content first), optionally with its links. Good for mail, articles and documentation.',
      { tab, links: z.boolean().optional(), max_chars: z.number().int().optional() }, read,
      (p) => run('page.text', p, (r) => text(r.text + (r.links?.length ? `\n\nLinks:\n${r.links.map((l) => `- ${l.text}: ${l.href}`).join('\n')}` : '')))],
    ['screenshot', 'Take a screenshot of a tab (or of one element).',
      { tab, ref: ref.optional(), full_page: z.boolean().optional() }, read,
      (p) => run('page.screenshot', p, (r) => [{ type: 'image', data: r.image, mimeType: r.mimeType }, { type: 'text', text: tabLine(r.tab) }])],
    ['click', 'Click an element.',
      { tab, ref, button: z.enum(['left', 'middle', 'right']).optional(), double: z.boolean().optional(), modifiers: z.array(z.string()).optional().describe('Keys held while clicking, like Control or Shift'), force: z.boolean().optional().describe('Click even if something covers the element'), ...snapshotOption }, act,
      (p) => run('input.click', p, (r, c) => afterAction(r, c, p))],
    ['type', 'Type text into a field (it is cleared first unless clear is false). Without a ref, types into whatever has focus.',
      { tab, ref: ref.optional(), text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional().describe('Press Enter afterwards'), slowly: z.boolean().optional().describe('Type one key at a time, for fields that react to each key'), ...snapshotOption }, act,
      (p) => run('input.type', p, (r, c) => afterAction(r, c, p))],
    ['fill_form', 'Fill several fields at once. Text fields and selects take a string; checkboxes and radio buttons take true or false.',
      { tab, fields: z.array(z.object({ ref, value: z.union([z.string(), z.boolean()]) })), ...snapshotOption }, act,
      (p) => run('input.fill', p, (r, c) => afterAction(r, c, p))],
    ['press_keys', 'Press keys or shortcuts on a tab, separated by spaces: "Enter", "Escape", "Control+a", "ArrowDown ArrowDown Enter".',
      { tab, keys: z.string(), ...snapshotOption }, act, (p) => run('input.press', p, (r, c) => afterAction(r, c, p))],
    ['hover', 'Move the mouse over an element (for menus and tooltips).', { tab, ref, ...snapshotOption }, act,
      (p) => run('input.hover', p, (r, c) => afterAction(r, c, p))],
    ['select_option', 'Choose option(s) in a select element, by value or label.', { tab, ref, values: z.array(z.string()), ...snapshotOption }, act,
      (p) => run('input.select', p, (r, c) => afterAction(r, c, p))],
    ['scroll', 'Scroll the page, or the scrollable element under a ref.',
      { tab, ref: ref.optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional().describe('Pixels, default 600'), ...snapshotOption }, act,
      (p) => run('input.scroll', p, (r, c) => afterAction(r, c, p))],
    ['drag', 'Drag one element onto another.', { tab, from: ref, to: ref, ...snapshotOption }, act,
      (p) => run('input.drag', p, (r, c) => afterAction(r, c, p))],
    ['upload_files', 'Put local files into a file input (the ref of an input type=file, or the button that opens it).',
      { tab, ref, paths: z.array(z.string()).describe('Absolute file paths'), ...snapshotOption }, act,
      (p) => run('input.upload', p, (r, c) => afterAction(r, c, p))],
    ['handle_dialog', 'Accept or dismiss an alert, confirm or prompt dialog. For a prompt, text is the answer.',
      { tab, accept: z.boolean(), text: z.string().optional(), ...snapshotOption }, act,
      (p) => run('dialog.handle', p, (r, c) => afterAction(r, c, p))],
    ['wait_for', 'Wait until text appears or disappears on a page, or for a number of seconds.',
      { tab, text: z.string().optional(), gone: z.string().optional(), seconds: z.number().optional(), timeout: z.number().optional().describe('Milliseconds, default 15000') }, read,
      (p) => run('page.wait', { ...p, time: p.seconds }, (r, c) => afterAction(r, c, p))],
    ['evaluate', 'Run JavaScript in a page and return its JSON result. Pass an expression or a function such as "() => document.title".',
      { tab, script: z.string(), args: z.array(z.any()).optional() }, act,
      (p) => run('page.evaluate', p, (r) => json(r.result ?? null))],
    ['downloads', 'List recent downloads with their state, progress and file path.', { limit: z.number().int().optional() }, read,
      (p) => run('downloads', p, (r) => json(r.downloads))],
    ['signed_in_sites', 'Find out where the user is signed in (from their cookies) and which sites have saved passwords (usernames only).', {}, read,
      () => run('account.signedIn', {}, (r) => text([
        ...r.sites.filter((s) => s.likely !== 'saved password only').map((s) => `- ${s.name || s.site} (${s.site}): ${s.likely}${s.savedLogins.length ? `; saved login: ${s.savedLogins.join(', ')}` : ''}`),
        ...(r.sites.some((s) => s.likely === 'saved password only') ? ['', 'Saved passwords only:', ...r.sites.filter((s) => s.likely === 'saved password only').map((s) => `- ${s.site}: ${s.savedLogins.join(', ')}`)] : []),
        ...(r.note ? ['', r.note] : [])
      ].join('\n') || 'No sign-ins found.'))],
    ['log_in', 'Fill the sign-in form on a tab from Firefox\'s saved passwords. The password is typed into the page and never shown to you. For two-step sign-ins call it again on the password page.',
      { tab, username: z.string().optional().describe('Which saved account, when there are several'), submit: z.boolean().optional().describe('Press Enter afterwards'), ...snapshotOption }, act,
      (p) => run('account.fillLogin', p, async (r, c) => {
        const note = `Filled ${r.filled.join(' and ')} for ${r.username}.${r.next ? ` ${r.next}` : ''}`;
        const rest = await afterAction(r, c, p);
        rest[0].text = `${note}\n\n${rest[0].text}`;
        return rest;
      })],
    ['cookies', 'List cookies for a domain. Values are hidden unless values is true.', { domain: z.string(), values: z.boolean().optional() }, read,
      (p) => run('account.cookies', p, (r) => json(r.cookies))],
    ['history', 'Search the user\'s browsing history.', { query: z.string(), limit: z.number().int().optional() }, read,
      (p) => run('history.search', p, (r) => text(r.results.map((h) => `- ${h.title || h.url}\n  ${h.url} (${h.visited})`).join('\n') || 'Nothing found.'))],
    ['bookmarks', 'Search the user\'s bookmarks (recent ones without a query).', { query: z.string().optional(), limit: z.number().int().optional() }, read,
      (p) => run('bookmarks.search', p, (r) => text(r.results.map((b) => `- ${b.title}: ${b.url}`).join('\n') || 'Nothing found.'))]
  ];

  for (const [name, description, shape, annotations, handler] of tools) {
    server.registerTool(name, { description, inputSchema: shape, annotations }, handler);
  }

  server.connect(new StdioServerTransport()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
  process.stdin.on('close', () => { client?.close(); process.exit(0); });
}

module.exports = { main };
if (require.main === module) main();
