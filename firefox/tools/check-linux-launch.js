// Integration check: real Linux launcher, disposable profile, existing-instance
// link forwarding, and an unchanged install preserving the compiled cache.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { install, testRuntime } = require('../install-runtime');
const { Marionette } = require('./marionette');

async function main() {
  assert.equal(process.platform, 'linux');
  const runtime = install(testRuntime);
  const stamp = path.join(runtime, 'still.cfg');
  const before = fs.statSync(stamp).mtimeMs;
  // Model a cache marker already consumed by Firefox after a real update.
  fs.rmSync(path.join(runtime, '.purgecaches'), { force: true });
  install(testRuntime);
  assert.equal(fs.statSync(stamp).mtimeMs, before);
  assert.equal(fs.existsSync(path.join(runtime, '.purgecaches')), false);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'still-launch-'));
  const port = 29000 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("marionette.port", ${port});`,
    'user_pref("still.import.electron.done", true);',
    'user_pref("still.import.history.done", true);'
  ].join('\n'));
  const log = fs.openSync(path.join(profile, 'launch.log'), 'w');
  const env = { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', STILL_FIREFOX_RUNTIME: runtime, STILL_FIREFOX_PROFILE: profile };
  const launcher = path.join(__dirname, '..', 'launcher.js');
  const child = spawn(process.execPath, [launcher, '--marionette', '--remote-allow-system-access'], { env, stdio: ['ignore', log, log] });
  const m = new Marionette(port);
  try {
    await m.connect(45000);
    await m.session();
    await m.chrome();
    const pid = await m.run('return Services.appinfo.processID;');
    assert.equal(path.basename(fs.readlinkSync(`/proc/${pid}/exe`)), 'still');
    if ((process.env.XDG_CURRENT_DESKTOP || '').includes('KDE')) {
      execFileSync('qml6', [path.join(__dirname, 'check-linux-taskbar.qml'), '--', String(pid)], {
        env: { ...process.env, QT_FORCE_STDERR_LOGGING: '1' }, stdio: 'inherit', timeout: 10000
      });
    }
    const identity = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    assert.ok(identity.includes('MOZ_APP_REMOTINGNAME=still'));
    assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--name\0still\0'));
    const readyBy = Date.now() + 15000;
    while (!await m.run('return !!window.StillChrome;')) {
      assert.ok(Date.now() < readyBy, 'Still interface did not initialize');
      await new Promise(r => setTimeout(r, 100));
    }
    const uri = 'http://127.0.0.1:9/still-launch-check';
    const forwarded = spawn(process.execPath, [launcher, '--new-tab', uri], { env, stdio: ['ignore', log, log] });
    const exit = await Promise.race([once(forwarded, 'exit'), new Promise((_, reject) => {
      const timeout = setTimeout(() => { forwarded.kill(); reject(new Error('Second launch did not forward')); }, 15000);
      timeout.unref();
    })]);
    assert.equal(exit[0], 0);
    const deadline = Date.now() + 10000;
    while (!await m.run('return [...gBrowser.tabs].some(t => t.linkedBrowser.currentURI.spec === arguments[0]);', [uri])) {
      assert.ok(Date.now() < deadline, 'URL did not reach existing Still');
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(await m.run('return Services.appinfo.processID;'), pid);
    console.log('PASS: Still identity, interface startup, links reuse the same process, unchanged install preserves caches');
  } catch (error) {
    console.error(fs.readFileSync(path.join(profile, 'launch.log'), 'utf8').slice(-4000));
    throw error;
  } finally {
    try { await m.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch {}
    m.close();
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(() => { child.kill(); r(); }, 5000))]);
    fs.closeSync(log);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
