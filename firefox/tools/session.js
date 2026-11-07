// Launches Still's Firefox runtime with a profile and a Marionette connection.
// Used by the launcher (persistent profile) and by the UI checks (disposable).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Marionette } = require('./marionette');
const { install, testRuntime, executableName } = require('../install-runtime');
const { browserArgs, browserEnv } = require('../identity');

const extensionDir = path.join(__dirname, '..', 'build');

async function launch({ profile, port = 2828 + Math.floor(Math.random() * 500), headless = false, extension = false, imports = false, cleanup = false, args = [] } = {}) {
  const runtime = install(testRuntime);
  const disposable = !profile;
  const profileDir = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'still-ff-'));
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'user.js'), [
    `user_pref("marionette.port", ${port});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    // Test windows sit behind other apps; keep them painting and playing.
    'user_pref("widget.windows.window_occlusion_tracking.enabled", false);',
    'user_pref("media.autoplay.default", 0);',
    // Checks never make sound; the personal profile keeps its own volume.
    ...(disposable ? ['user_pref("media.volume_scale", "0.0");'] : []),
    // The first-start imports copy and read large databases; only the import
    // checks want them.
    ...(imports ? [] : ['user_pref("still.import.electron.done", true);', 'user_pref("still.import.history.done", true);'])
  ].join('\n'));
  const child = spawn(path.join(runtime, executableName), [
    ...browserArgs(), '-no-remote', '-profile', profileDir, '--marionette', '--remote-allow-system-access',
    ...(headless ? ['--headless'] : []), ...args
  ], { stdio: 'ignore', windowsHide: false, env: { ...browserEnv(), MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
  const marionette = await new Marionette(port).connect(45000);
  await marionette.session();
  if (extension && fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    await marionette.send('Addon:Install', { path: extensionDir, temporary: true });
  }
  return {
    child, marionette, profileDir, runtime,
    async stop() {
      try { await marionette.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch {}
      marionette.close();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      // Disposable profiles hold a full cache; never leave them behind.
      if (disposable || cleanup) {
        for (let attempt = 0; attempt < 20; attempt++) {
          try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
        }
      }
    }
  };
}

module.exports = { launch };
