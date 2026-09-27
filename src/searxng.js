const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PREFERRED_PORT = 48199;
const PORT_ATTEMPTS = 24;
const HEALTH_PATH = '/__still_searxng_health';

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function availablePort() {
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const port = PREFERRED_PORT + offset;
    if (await canListen(port)) return port;
  }
  throw new Error('No private port is available for Still Search.');
}

function yamlSettings(secret) {
  return `# Managed locally by Still Browser.
use_default_settings:
  engines:
    remove:
      - google
      - google images
      - google news
      - google videos
      - google cse
      - google cse images
      - google scholar
      - google play apps
      - google play movies
      - wikidata

general:
  debug: false
  instance_name: "Still Search"
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html

server:
  secret_key: "${secret}"
  bind_address: "127.0.0.1"
  limiter: false
  image_proxy: true
  method: "GET"
`;
}

async function settingsPath(userDataPath) {
  const directory = path.join(userDataPath, 'searxng');
  const destination = path.join(directory, 'settings.yml');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  let secret = '';
  try {
    const existing = await fs.promises.readFile(destination, 'utf8');
    secret = existing.match(/^\s*secret_key:\s*"([a-f0-9]{64})"\s*$/m)?.[1] || '';
  } catch {}
  if (!secret) secret = crypto.randomBytes(32).toString('hex');
  const temporary = `${destination}.tmp`;
  await fs.promises.writeFile(temporary, yamlSettings(secret), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporary, destination);
  try { await fs.promises.chmod(destination, 0o600); } catch {}
  return destination;
}

function sidecarExecutable({ isPackaged, resourcesPath, appPath }) {
  const name = process.platform === 'win32' ? 'searxng-sidecar.exe' : 'searxng-sidecar';
  return isPackaged
    ? path.join(resourcesPath, 'searxng', name)
    : path.join(appPath, 'build', 'searxng-sidecar', name);
}

async function waitUntilReady(baseUrl, healthToken, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Still Search stopped with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}${HEALTH_PATH}?token=${encodeURIComponent(healthToken)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(800)
      });
      if (response.ok && await response.text() === 'still-searxng-ok') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Still Search did not become ready in time.');
}

async function startLocalSearxng(options) {
  const executable = sidecarExecutable(options);
  if (!fs.existsSync(executable)) throw new Error('The bundled Still Search service is missing.');

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const healthToken = crypto.randomBytes(24).toString('hex');
  const configuration = await settingsPath(options.userDataPath);
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      SEARXNG_SETTINGS_PATH: configuration,
      SEARXNG_BIND_ADDRESS: '127.0.0.1',
      SEARXNG_PORT: String(port),
      SEARXNG_BASE_URL: baseUrl,
      SEARXNG_LIMITER: 'false',
      SEARXNG_IMAGE_PROXY: 'true',
      STILL_SEARXNG_PORT: String(port),
      STILL_SEARXNG_HEALTH_TOKEN: healthToken
    }
  });

  let recentError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    recentError = `${recentError}${chunk}`.slice(-4000);
  });

  try {
    await waitUntilReady(baseUrl, healthToken, child);
  } catch (error) {
    child.kill();
    const details = recentError.trim().split(/\r?\n/).slice(-8).join(' | ');
    throw new Error(details ? `${error.message} ${details}` : error.message);
  }

  return {
    baseUrl,
    stop() {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  };
}

module.exports = { startLocalSearxng };
