// YouTube checks in a disposable profile that borrows the persistent
// profile's cookies (so YouTube is signed in and skips the consent page).
// Usage: node tools/yt.js <url> [content-script.js] [capture-name]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launch } = require('./session');

const persistent = 'D:\\Still Firefox Prototype\\profile';
const out = path.join(os.tmpdir(), 'still-yt');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const [url = 'https://www.youtube.com/', scriptFile, name = 'yt'] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'still-yt-'));
  if (process.env.YT_PROFILE === 'full') {
    // The whole persistent profile (site storage, prefs), without caches.
    const skip = new Set(['cache2', 'startupCache', 'parent.lock', 'lock', 'user.js', 'sessionstore.jsonlz4', 'sessionstore-backups']);
    fs.cpSync(persistent, profile, { recursive: true, filter: (from) => !skip.has(path.basename(from)) });
    for (const drop of (process.env.YT_DROP || '').split(',').filter(Boolean)) fs.rmSync(path.join(profile, drop), { recursive: true, force: true });
  } else {
    for (const file of ['cookies.sqlite', 'cookies.sqlite-wal']) {
      const from = path.join(persistent, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(profile, file));
    }
  }
  const s = await launch({ profile, cleanup: true });
  const m = s.marionette;
  try {
    await m.chrome();
    await wait(2500);
    const pid = await m.run('return Services.appinfo.processID;');
    const [width, height] = (process.env.YT_SIZE || '1700x940').split('x').map(Number);
    await m.run('window.moveTo(0, 0); window.resizeTo(arguments[0], arguments[1]);', [width, height]);
    await m.run(`gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [url]);
    await wait(Number(process.env.YT_WAIT || 9000));
    await m.content();
    if (process.env.YT_PRE) {
      // Run a setup script, then load the page again before the probe.
      console.log('pre:', JSON.stringify(await m.run(fs.readFileSync(process.env.YT_PRE, 'utf8'))));
      await m.chrome();
      await m.run(`gBrowser.selectedBrowser.reload();`);
      await wait(Number(process.env.YT_WAIT || 9000));
      await m.content();
    }
    if (scriptFile) {
      const script = fs.readFileSync(scriptFile, 'utf8');
      const result = await m.runAsync(`(async () => { ${script} })().then(arguments[0], (e) => arguments[0]("ERR " + e + " " + e.stack));`);
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    }
    const shots = Number(process.env.YT_SHOTS || 1);
    for (let shot = 0; shot < shots; shot++) {
      const file = path.join(out, shots > 1 ? `${name}-${shot}.png` : `${name}.png`);
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'capture.ps1'), String(pid), file]);
      console.log('captured', file);
    }
  } catch (error) { console.error(error.message); }
  await s.stop();
})();
