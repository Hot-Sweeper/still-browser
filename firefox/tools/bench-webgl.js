// WebGL frame-rate benchmark for Still. Development only, not shipped.
//
//   node firefox/tools/bench-webgl.js launch --port 29500 [--prefs file.json] [--env file.json]
//     Starts Still's runtime (a separate copy, runtime/perf) with a disposable
//     profile and Marionette. Stays in the foreground until the browser exits,
//     then deletes the profile. Run it inside a hidden desktop, never on the
//     user's screen.
//   node firefox/tools/bench-webgl.js measure --port 29500 [--url URL] [--seconds 15] [--warmup 6]
//     Fullscreens the window, opens the page, waits for it, then records every
//     requestAnimationFrame interval and the page's own perf panel. Prints JSON.
//   node firefox/tools/bench-webgl.js quit --port 29500
//
// The default page is the LEMON three.js scene at a pinned pixel ratio of 1.5
// (3840x2160 on a 2560x1440 CSS viewport), which is CPU and WebGL-call bound.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Marionette } = require('./marionette');

const DEFAULT_URL = 'https://lemon.redemann.info:30000/?anon&pr=1.5';

function option(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

async function launch(args) {
  const { child, done } = start(args);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'));
  process.exitCode = await done;
}

function start(args, prefsOverride, envOverride) {
  // The hidden desktop has its own XDG data directory; the perf runtime lives
  // beside the user's runtimes, but is a separate copy so a running Still and
  // the UI checks are never touched.
  const home = os.homedir();
  const sessionData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  const { install, executableName } = require('../install-runtime');
  const { browserArgs, browserEnv } = require('../identity');
  const runtime = install(process.env.STILL_BENCH_RUNTIME || path.join(home, '.local', 'share', 'still', 'runtime', 'perf'));
  if (sessionData) process.env.XDG_DATA_HOME = sessionData; else delete process.env.XDG_DATA_HOME;
  const port = Number(option(args, 'port', 29500));
  const prefs = prefsOverride || (option(args, 'prefs') ? JSON.parse(fs.readFileSync(option(args, 'prefs'), 'utf8')) : {});
  const extraEnv = envOverride || (option(args, 'env') ? JSON.parse(fs.readFileSync(option(args, 'env'), 'utf8')) : {});
  const profile = fs.mkdtempSync(path.join(process.env.STILL_BENCH_TMP || os.tmpdir(), 'still-bench-'));
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("marionette.port", ${port});`,
    // Marionette otherwise applies its "recommended" automation prefs, some of
    // which change timers and process behaviour.
    'user_pref("remote.prefs.recommended", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("media.volume_scale", "0.0");',
    'user_pref("still.import.electron.done", true);',
    'user_pref("still.import.history.done", true);',
    `user_pref("still.agent.dir", ${JSON.stringify(path.join(profile, 'agent'))});`,
    'user_pref("still.agent.enabled", false);',
    ...Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
  ].join('\n'));
  const env = { ...browserEnv(), ...extraEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' };
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  console.log(JSON.stringify({ runtime, profile, port, prefs, extraEnv }));
  const child = spawn(path.join(runtime, executableName), [...browserArgs(), '-no-remote', '-profile', profile,
    '--marionette', '--remote-allow-system-access'], { stdio: 'inherit', env });
  const done = new Promise((resolve) => child.on('exit', (code) => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    resolve(code || 0);
  }));
  return { child, done, profile };
}

// Runs each configuration in its own fresh browser, one after another, and
// appends one JSON line per run to --out. Configs: [{ name, prefs, env, repeat }].
async function suite(args) {
  const configs = JSON.parse(fs.readFileSync(option(args, 'configs'), 'utf8'));
  const out = option(args, 'out');
  for (const config of configs) {
    for (let r = 0; r < (config.repeat || 1); r++) {
      const { child, done } = start(args, config.prefs || {}, config.env || {});
      let line;
      try {
        line = { name: config.name, run: r, ...await measure(args, true, config.profile, config.shot && config.shot.replace('%r', r)) };
      } catch (e) { line = { name: config.name, run: r, error: String(e.message || e) }; }
      try { await quit(args); } catch {}
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      await done; clearTimeout(timer);
      fs.appendFileSync(out, JSON.stringify(line) + '\n');
      console.log(config.name, r, line.error || `${line.fps} fps p50 ${line.p50} p99 ${line.p99}`);
      await sleep(2000);
    }
  }
}

async function connect(args) {
  const m = await new Marionette(Number(option(args, 'port', 29500))).connect(60000);
  await m.session();
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphics(m) {
  await m.chrome();
  return m.run(`
    const info = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
    const features = {};
    try { for (const f of info.getFeatureLog().features || []) features[f.name] = f.status; } catch {}
    let compositor = null;
    try { compositor = window.windowUtils.layerManagerType; } catch {}
    const prefs = {};
    for (const p of ['layout.frame_rate', 'gfx.blacklist.dmabuf-webgl', 'gfx.webrender.compositor.force-enabled',
      'layers.gpu-process.enabled', 'webgl.gl_khr_no_error', 'webgl.msaa-samples', 'widget.wayland.vsync.enabled']) {
      const t = Services.prefs.getPrefType(p);
      prefs[p] = t === 32 ? Services.prefs.getStringPref(p) : t === 64 ? Services.prefs.getIntPref(p) : t === 128 ? Services.prefs.getBoolPref(p) : null;
    }
    return { compositor, features, prefs, version: Services.appinfo.version, buildID: Services.appinfo.appBuildID,
      adapter: info.adapterDescription, driver: info.adapterDriverVersion, windowProtocol: info.windowProtocol,
      screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio } };`);
}

async function measure(args, quiet = false, profilePath = option(args, 'profile'), shotPath = option(args, 'shot')) {
  const url = option(args, 'url', DEFAULT_URL);
  const seconds = Number(option(args, 'seconds', 15));
  const warmup = Number(option(args, 'warmup', 6));
  const m = await connect(args);
  try {
    const gfx = await graphics(m);
    // Hide Still's chrome and fill the screen, like a fullscreen game.
    if (!option(args, 'windowed')) {
      try { await m.send('WebDriver:FullscreenWindow'); } catch (e) { gfx.fullscreenError = e.message; }
    }
    await m.content();
    if (!option(args, 'stay')) await m.send('WebDriver:Navigate', { url });
    const readyBy = Date.now() + 90000;
    while (!await m.run('return !!window.__ready;')) {
      if (Date.now() > readyBy) throw new Error('page did not become ready');
      await sleep(250);
    }
    // Open the page's perf panel so its table keeps updating.
    await m.run(`const b = document.getElementById('perfBtn'); const d = document.getElementById('perfDd');
      if (b && d && !d.classList.contains('show')) b.click();`);
    await sleep(warmup * 1000);
    if (profilePath) {
      await m.chrome();
      await m.run(`Services.profiler.StartProfiler(1 << 24, 1, ['js', 'stackwalk', 'ipcmessages', 'markersallthreads'],
        ['GeckoMain', 'Compositor', 'Renderer', 'Canvas', 'RenderBackend', 'SceneBuilder', 'WRWorker', 'ImageBridge', 'Vsync', 'IPC']);`);
      await m.content();
    }
    const result = await m.runAsync(`
      const [seconds, done] = [arguments[0], arguments[arguments.length - 1]];
      const times = []; const start = performance.now();
      let longtask = 0;
      try { new PerformanceObserver((l) => l.getEntries().forEach((e) => longtask += e.duration)).observe({ type: 'longtask' }); } catch {}
      const tick = (t) => {
        times.push(t);
        if (t - start < seconds * 1000) requestAnimationFrame(tick);
        else {
          const d = []; for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
          const s = [...d].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
          const c = document.querySelector('#stage canvas') || document.querySelector('canvas');
          const rows = [...document.querySelectorAll('#perfTab tr')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
          done({ fps: d.length * 1000 / (times.at(-1) - times[0]), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s.at(-1),
            frames: d.length, longtaskMs: longtask, canvas: c && [c.width, c.height], dpr: devicePixelRatio,
            inner: [innerWidth, innerHeight], panel: rows });
        }
      };
      requestAnimationFrame(tick);`, [seconds]);
    if (profilePath) {
      await m.chrome();
      await m.runAsync(`const done = arguments[arguments.length - 1];
        Services.profiler.dumpProfileToFileAsync(arguments[0]).then(() => { Services.profiler.StopProfiler(); done(true); }, (e) => done(String(e)));`, [profilePath]);
      await m.content();
    }
    if (shotPath) fs.writeFileSync(shotPath, Buffer.from(await m.screenshot(), 'base64'));
    const out = { url, gfx, ...result };
    delete out.round;
    for (const k of ['fps', 'p50', 'p90', 'p99', 'max']) out[k] = Math.round(out[k] * 100) / 100;
    if (!quiet) console.log(JSON.stringify(out, null, 1));
    return out;
  } finally {
    try { await m.send('WebDriver:DeleteSession'); } catch {}
    m.close();
  }
}

async function quit(args) {
  const m = await connect(args);
  try { await m.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch {}
  m.close();
}

const [command, ...rest] = process.argv.slice(2);
({ launch, measure, quit, suite })[command]?.(rest).catch((e) => { console.error(e.stack || e); process.exitCode = 1; })
  ?? (console.error('usage: bench-webgl.js launch|measure|quit --port N'), process.exitCode = 2);
