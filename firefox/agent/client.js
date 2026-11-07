// Client for Still's agent bridge (firefox/chrome/content/StillAgent.sys.mjs).
// Used by `still mcp` and `still agent`. Talks newline-delimited JSON over
// the socket Still opens in its agent folder.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function agentDir() {
  if (process.env.STILL_AGENT_DIR) return process.env.STILL_AGENT_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Still');
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'still');
  return path.join(os.tmpdir(), `still-${os.userInfo().username}`);
}

class StillError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

class StillClient {
  constructor({ dir = agentDir(), client = 'agent' } = {}) {
    this.dir = dir;
    this.client = client;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.events = [];
  }

  info() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'agent.json'), 'utf8')); } catch { return null; }
  }

  open(info) {
    return new Promise((resolve, reject) => {
      const socket = info.socket ? net.createConnection(info.socket) : net.createConnection(info.port, '127.0.0.1');
      socket.setEncoding('utf8');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  async connect({ launch = false, timeout = 45000 } = {}) {
    if (this.socket) return this;
    let info = this.info();
    let socket = null;
    if (info) socket = await this.open(info).catch(() => null);
    if (!socket && stillIsRunning()) {
      throw new StillError('Still is running without agent access. Close Still and open it again to turn it on.', 'restart_needed');
    }
    if (!socket && launch) {
      launchStill();
      const end = Date.now() + timeout;
      while (!socket && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        info = this.info();
        if (info) socket = await this.open(info).catch(() => null);
      }
    }
    if (!socket) {
      throw new StillError(launch
        ? 'Still did not start in time. Open Still, then try again.'
        : 'Still is not running. Open Still (or pass --launch), then try again.', 'not_running');
    }
    this.socket = socket;
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => {
      this.socket = null;
      for (const { reject } of this.pending.values()) reject(new StillError('Still closed the connection', 'closed'));
      this.pending.clear();
    });
    socket.on('error', () => {});
    await this.call('hello', { client: this.client, token: info.token });
    return this;
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.events) this.events.push(...message.events);
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new StillError(message.error.message, message.error.code));
      else waiter.resolve(message.result);
    }
  }

  call(method, params = {}, timeout = 120000) {
    if (!this.socket) return Promise.reject(new StillError('Not connected to Still', 'closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StillError(`${method} took too long`, 'timeout'));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  takeEvents() {
    return this.events.splice(0);
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }
}

// Is a Still browser using the profile? (Firefox's `lock` link names its pid.)
function stillIsRunning() {
  if (process.platform === 'win32' || process.env.STILL_AGENT_DIR) return false;
  try {
    const { dataRoot } = require('../install-runtime');
    const profile = process.env.STILL_FIREFOX_PROFILE || path.join(dataRoot, 'profile');
    const pid = Number(fs.readlinkSync(path.join(profile, 'lock')).split('+').pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Start Still the way the desktop entry does, detached from this process.
function launchStill() {
  const launcher = path.join(__dirname, '..', 'launcher.js');
  const child = spawn(process.execPath, [launcher], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

module.exports = { StillClient, StillError, agentDir, launchStill };
