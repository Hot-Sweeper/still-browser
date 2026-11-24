// Starts Still on Firefox: Still's runtime (see install-runtime.js) with a
// persistent profile. The browser starts Still Search itself. No automation or
// remote debugging is attached, so sites see an ordinary Firefox.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { install, runtime: installedRuntime, executableName, dataRoot } = require('./install-runtime');
const { browserArgs, browserEnv } = require('./identity');

const root = path.resolve(__dirname, '..');
const prototypeRoot = path.join(path.parse(root).root, 'Still Firefox Prototype');
const profile = process.env.STILL_FIREFOX_PROFILE || (process.platform === 'win32' ? path.join(prototypeRoot, 'profile') : path.join(dataRoot, 'profile'));

// Firefox marks a profile in use with a `lock` link naming the owner's pid.
function stillIsRunning() {
  if (process.platform === 'win32') return false;
  try {
    const pid = Number(fs.readlinkSync(path.join(profile, 'lock')).split('+').pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function main() {
  if (!fs.existsSync(path.join(__dirname, 'build', 'manifest.json'))) {
    throw new Error('Run npm run firefox:build before launching Still on Firefox.');
  }
  // A running Still only needs the link handed over. Updating its files now
  // would fail on its busy executable and drop the link; the update installs
  // on the next start instead.
  const runtime = stillIsRunning() && fs.existsSync(path.join(installedRuntime, executableName)) ? installedRuntime : install();
  fs.mkdirSync(profile, { recursive: true });

  console.log(`Profile: ${profile}`);
  const child = spawn(path.join(runtime, executableName), [...browserArgs(), '-profile', profile, '--wait-for-browser', ...process.argv.slice(2)], {
    cwd: runtime,
    env: browserEnv(),
    stdio: 'inherit'
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (signal && child.exitCode === null) child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    stop();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    stop();
    process.exitCode = code || 0;
  });
}

// `still mcp` and `still agent ...` talk to a running Still (see agent/);
// they never start a second browser process themselves.
const [mode, ...rest] = process.argv.slice(2);
if (mode === 'mcp') {
  require('./agent/mcp').main();
} else if (mode === 'acp') {
  // `still acp codex|claude`: an Agent Client Protocol adapter on stdio, for
  // Still's side chat (or any ACP client). Adapters are pinned in agent/.
  const adapters = {
    codex: '@agentclientprotocol/codex-acp',
    claude: '@agentclientprotocol/claude-agent-acp'
  };
  // Each adapter's own command, from its package.json "bin": newer versions
  // no longer export their files by path.
  const adapterEntry = (name) => {
    const manifest = require.resolve(`${name}/package.json`, { paths: [path.join(__dirname, 'agent')] });
    const { bin, main } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const file = typeof bin === 'string' ? bin : Object.values(bin || {})[0] || main || 'dist/index.js';
    return path.join(path.dirname(manifest), file);
  };
  const entry = adapters[rest[0]] ? adapterEntry(adapters[rest[0]]) : null;
  if (!entry) {
    console.error(`Usage: still acp ${Object.keys(adapters).join('|')}`);
    process.exitCode = 2;
  } else {
    const child = require('node:child_process').spawn(process.execPath, [entry, ...rest.slice(1)], { stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
} else if (mode === 'agent') {
  require('./agent/cli').main(rest).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
