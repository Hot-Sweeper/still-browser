// `still agent ...`: the agent bridge from a shell, for scripts and agents
// that prefer commands to MCP. `still agent help` lists the commands.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { StillClient } = require('./client');

const HELP = `Use Still, your own browser, from the command line.

  still agent status                     Is Still running, which agents are connected
  still agent tabs                       List tabs (ids, slots, agent tabs, popups)
  still agent open <url> [--visible]     Open a page in a hidden agent tab (or a slot)
  still agent show <tab>                 Bring a tab in front of you
  still agent close <tab>
  still agent go <tab> <url|back|forward|reload>
  still agent snapshot <tab>             Page as an accessibility tree with refs (e12)
  still agent text <tab> [--links]       Readable page text
  still agent shot <tab> [file.png]      Screenshot
  still agent click <tab> <ref>
  still agent type <tab> <ref> <text> [--submit]
  still agent press <tab> <keys>         Like "Enter" or "Control+a"
  still agent select <tab> <ref> <value...>
  still agent scroll <tab> [up|down] [pixels]
  still agent upload <tab> <ref> <file...>
  still agent dialog <tab> accept|dismiss [text]
  still agent wait <tab> <text>
  still agent eval <tab> <javascript>
  still agent login <tab> [username] [--submit]   Fill a saved password (never printed)
  still agent signed-in                  Where you are signed in
  still agent downloads
  still agent history <words>
  still agent call <method> [json]       Any bridge method directly
  still agent setup                      Register \`still mcp\` with Claude Code, Codex and T3 Code

Options: --json prints raw results. --launch starts Still if it is not running.`;

function flags(args) {
  const options = {};
  const rest = [];
  for (const arg of args) {
    if (arg.startsWith('--')) options[arg.slice(2)] = true;
    else rest.push(arg);
  }
  return { options, rest };
}

const num = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name || 'tab'} must be a number (see still agent tabs)`);
  return n;
};

function tabLine(tab) {
  const where = tab.slot ? `slot ${tab.slot}` : tab.place;
  return `${String(tab.id).padEnd(12)} ${where.padEnd(14)} ${(tab.title || '').slice(0, 60)}\n${' '.repeat(28)}${tab.url}`;
}

async function setup() {
  const still = path.join(process.env.HOME || '', '.local', 'bin', 'still');
  const command = fs.existsSync(still) ? still : 'still';
  const done = [];
  const tryRun = (label, file, args) => {
    try {
      execFileSync(file, args, { stdio: 'pipe' });
      done.push(`${label}: added`);
    } catch (error) {
      const out = String(error.stderr || error.stdout || error.message);
      done.push(`${label}: ${/already exists/i.test(out) ? 'already set up' : /ENOENT/.test(out) ? 'not installed' : out.trim().split('\n')[0]}`);
    }
  };
  tryRun('Claude Code', 'claude', ['mcp', 'add', '--scope', 'user', 'still', '--', command, 'mcp']);
  tryRun('Codex', 'codex', ['mcp', 'add', 'still', '--', command, 'mcp']);
  console.log(done.join('\n'));
  console.log(`\nT3 Code runs Claude Code and Codex, so it uses the same setup.\nAny other MCP client: command "${command}" with argument "mcp".`);
}

async function main(argv) {
  const { options, rest } = flags(argv);
  const [command = 'help', ...args] = rest;
  if (command === 'help' || options.help) { console.log(HELP); return; }
  if (command === 'setup') { await setup(); return; }

  const client = new StillClient({ client: process.env.STILL_AGENT_NAME || 'Terminal' });
  await client.connect({ launch: Boolean(options.launch) });
  const out = (value, plain) => console.log(options.json || plain === undefined ? JSON.stringify(value, null, 2) : plain);
  const call = (method, params) => client.call(method, params);
  try {
    switch (command) {
      case 'status': { const r = await call('status'); out(r, `Still ${r.version} is running. Agents: ${r.clients.join(', ') || 'none'}. Tabs: ${r.tabs}.`); break; }
      case 'tabs': { const r = await call('tabs.list'); out(r, r.tabs.map(tabLine).join('\n')); break; }
      case 'open': { const r = await call('tabs.open', { url: args.join(' '), visible: Boolean(options.visible) }); out(r, tabLine(r.tab)); break; }
      case 'show': { const r = await call('tabs.select', { tab: num(args[0]) }); out(r, tabLine(r.tab)); break; }
      case 'close': { const r = await call('tabs.close', { tab: num(args[0]) }); out(r, `Closed ${r.closed.title}`); break; }
      case 'go': {
        const action = ['back', 'forward', 'reload'].includes(args[1]) ? args[1] : undefined;
        const r = await call('tabs.navigate', { tab: num(args[0]), action, url: action ? undefined : args.slice(1).join(' ') });
        out(r, tabLine(r.tab));
        break;
      }
      case 'snapshot': { const r = await call('page.snapshot', { tab: num(args[0]) }); out(r, r.text); break; }
      case 'text': { const r = await call('page.text', { tab: num(args[0]), links: Boolean(options.links) }); out(r, r.text + (r.links ? '\n\n' + r.links.map((l) => `${l.text}: ${l.href}`).join('\n') : '')); break; }
      case 'shot': {
        const r = await call('page.screenshot', { tab: num(args[0]), full_page: Boolean(options.full) });
        const file = path.resolve(args[1] || `still-tab-${args[0]}.png`);
        fs.writeFileSync(file, Buffer.from(r.image, 'base64'));
        out({ file }, file);
        break;
      }
      case 'click': { const r = await call('input.click', { tab: num(args[0]), ref: args[1], force: Boolean(options.force) }); out(r, tabLine(r.tab)); break; }
      case 'type': { const r = await call('input.type', { tab: num(args[0]), ref: args[1], text: args.slice(2).join(' '), submit: Boolean(options.submit) }); out(r, tabLine(r.tab)); break; }
      case 'press': { const r = await call('input.press', { tab: num(args[0]), keys: args.slice(1).join(' ') }); out(r, tabLine(r.tab)); break; }
      case 'select': { const r = await call('input.select', { tab: num(args[0]), ref: args[1], values: args.slice(2) }); out(r, `Selected ${r.selected.join(', ')}`); break; }
      case 'scroll': { const r = await call('input.scroll', { tab: num(args[0]), direction: args[1] || 'down', amount: args[2] ? num(args[2], 'pixels') : undefined }); out(r, tabLine(r.tab)); break; }
      case 'upload': { const r = await call('input.upload', { tab: num(args[0]), ref: args[1], paths: args.slice(2).map((file) => path.resolve(file)) }); out(r, `Added ${r.files} file(s)`); break; }
      case 'dialog': { const r = await call('dialog.handle', { tab: num(args[0]), accept: args[1] !== 'dismiss', text: args[2] }); out(r, `Handled the ${r.handled}`); break; }
      case 'wait': { const r = await call('page.wait', { tab: num(args[0]), text: args.slice(1).join(' ') }); out(r, 'Found it.'); break; }
      case 'eval': { const r = await call('page.evaluate', { tab: num(args[0]), script: args.slice(1).join(' ') }); out(r.result, JSON.stringify(r.result, null, 2)); break; }
      case 'login': { const r = await call('account.fillLogin', { tab: num(args[0]), username: args[1], submit: Boolean(options.submit) }); out(r, `Filled ${r.filled.join(' and ')} for ${r.username}.${r.next ? ' ' + r.next : ''}`); break; }
      case 'signed-in': {
        const r = await call('account.signedIn');
        out(r, r.sites.map((s) => `${(s.name || s.site).padEnd(22)} ${s.likely}${s.savedLogins.length ? `  (${s.savedLogins.join(', ')})` : ''}`).join('\n') + (r.note ? `\n\n${r.note}` : ''));
        break;
      }
      case 'downloads': { const r = await call('downloads'); out(r, r.downloads.map((d) => `${d.state.padEnd(9)} ${d.file}`).join('\n') || 'No downloads.'); break; }
      case 'history': { const r = await call('history.search', { query: args.join(' ') }); out(r, r.results.map((h) => `${h.visited.slice(0, 16)}  ${h.title || ''}\n                  ${h.url}`).join('\n')); break; }
      case 'call': { const r = await call(args[0], args[1] ? JSON.parse(args[1]) : {}); out(r); break; }
      default: throw new Error(`Unknown command "${command}". Try still agent help.`);
    }
    const events = client.takeEvents();
    if (events.length && !options.json) for (const event of events) console.error(`(${event.type}) ${event.message || event.tab?.title || event.file || ''}`);
  } finally {
    client.close();
  }
}

module.exports = { main };
if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
