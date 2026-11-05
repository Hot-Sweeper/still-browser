// Prepares Still's Firefox runtime: a copy of the signed Firefox build with
// Still's window layer installed through Firefox's enterprise autoconfig hook.
// The original runtime folder is never modified.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const prototypeRoot = path.join(path.parse(root).root, 'Still Firefox Prototype', 'runtime');
const sourceRuntime = process.env.STILL_FIREFOX_SOURCE_RUNTIME || path.join(prototypeRoot, 'core');
const userRuntime = process.env.STILL_FIREFOX_RUNTIME || path.join(prototypeRoot, 'still');
// Automated checks use their own copy, so they never change the files of a
// Still that is open (a running Still mixing old and new files breaks).
const testRuntime = path.join(prototypeRoot, 'test');
const chromeSource = path.join(__dirname, 'chrome');

// A running Still keeps some files open (Still Search). Those are left in
// place when unchanged; anything else that cannot be replaced is an error.
function copyFile(source, target) {
  try {
    fs.copyFileSync(source, target);
  } catch (error) {
    const same = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size;
    if (!same || !['EPERM', 'EBUSY'].includes(error.code)) {
      throw new Error(`Could not update ${target} (${error.code}). Close Still and try again.`);
    }
  }
}

function copyDirectory(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(source, target, skip);
    else copyFile(source, target);
  }
}

function syncDirectory(from, to, keep = []) {
  copyDirectory(from, to);
  const wanted = new Set(fs.readdirSync(from));
  for (const name of fs.readdirSync(to)) {
    if (wanted.has(name) || keep.includes(name)) continue;
    try { fs.rmSync(path.join(to, name), { recursive: true, force: true }); } catch {}
  }
}

function install(runtime = userRuntime) {
  if (!fs.existsSync(path.join(runtime, 'firefox.exe'))) {
    if (!fs.existsSync(path.join(sourceRuntime, 'firefox.exe'))) {
      throw new Error(`Firefox runtime not found: ${sourceRuntime}`);
    }
    console.log(`Copying Firefox runtime to ${runtime}`);
    copyDirectory(sourceRuntime, runtime);
  }
  fs.rmSync(path.join(runtime, 'autoconfig-ok.txt'), { force: true });
  fs.mkdirSync(path.join(runtime, 'defaults', 'pref'), { recursive: true });
  fs.copyFileSync(path.join(chromeSource, 'still-autoconfig.js'), path.join(runtime, 'defaults', 'pref', 'still-autoconfig.js'));
  fs.copyFileSync(path.join(chromeSource, 'still.cfg'), path.join(runtime, 'still.cfg'));
  const target = path.join(runtime, 'still-chrome');
  // Never delete files under a running Still: files are overwritten in place,
  // and only files that no longer exist in the source are removed.
  syncDirectory(path.join(chromeSource, 'content'), target, ['searxng', 'extension', 'still-icon.png', 'still.ico', 'mouse-navigation-helper.exe']);
  // Firefox caches compiled chrome scripts per profile. This marker makes the
  // next start drop that cache once (still.cfg removes it), so updates apply.
  fs.writeFileSync(path.join(runtime, '.purgecaches'), '');
  const searchSource = path.join(root, 'build', 'searxng-sidecar');
  const searchTarget = path.join(target, 'searxng');
  const stamp = (dir) => { try { return fs.readFileSync(path.join(dir, 'still-build.json'), 'utf8'); } catch { return ''; } };
  if (fs.existsSync(path.join(searchSource, 'searxng-sidecar.exe')) && stamp(searchSource) !== stamp(searchTarget)) {
    fs.rmSync(searchTarget, { recursive: true, force: true });
    copyDirectory(searchSource, searchTarget, (name) => name.endsWith('.tar.gz'));
  }
  copyFile(path.join(root, 'src', 'assets', 'still-icon.png'), path.join(target, 'still-icon.png'));
  const extension = path.join(__dirname, 'build');
  if (fs.existsSync(path.join(extension, 'manifest.json'))) syncDirectory(extension, path.join(target, 'extension'));
  // Window and taskbar icon, applied by StillShared.sys.mjs.
  const icon = path.join(root, 'build', 'icon.ico');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(target, 'still.ico'));
  console.log(`Installed Still window layer in ${runtime}`);
  return runtime;
}

if (require.main === module) {
  try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { install, runtime: userRuntime, testRuntime };
