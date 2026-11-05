// Minimal Marionette client used to test Still's Firefox chrome in a
// disposable profile. Not shipped; development only.
const net = require('node:net');

class Marionette {
  constructor(port = 2828, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.id = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  async connect(timeoutMs = 30000) {
    const started = Date.now();
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          this.socket = net.connect(this.port, this.host);
          this.socket.once('error', reject);
          this.greeting = new Promise((ready) => { this.onGreeting = ready; });
          this.socket.on('data', (chunk) => this.receive(chunk));
          this.socket.once('connect', resolve);
        });
        await this.greeting;
        return this;
      } catch (error) {
        this.socket?.destroy();
        if (Date.now() - started > timeoutMs) throw error;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(':');
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (this.buffer.length < colon + 1 + length) return;
      const body = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.buffer = this.buffer.subarray(colon + 1 + length);
      if (!Array.isArray(body)) { this.onGreeting?.(body); continue; }
      const [, id, error, result] = body;
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (!waiter) continue;
      if (error) waiter.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace || ''}`));
      else waiter.resolve(result);
    }
  }

  send(name, params = {}) {
    const id = ++this.id;
    const payload = JSON.stringify([0, id, name, params]);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    });
  }

  async session() {
    await this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } });
    return this;
  }

  chrome() { return this.send('Marionette:SetContext', { value: 'chrome' }); }
  content() { return this.send('Marionette:SetContext', { value: 'content' }); }
  async run(script, args = []) { return (await this.send('WebDriver:ExecuteScript', { script, args })).value; }
  async runAsync(script, args = []) { return (await this.send('WebDriver:ExecuteAsyncScript', { script, args, scriptTimeout: 240000 })).value; }
  async screenshot() { return (await this.send('WebDriver:TakeScreenshot', { full: false })).value; }
  close() { this.socket?.destroy(); }
}

module.exports = { Marionette };
