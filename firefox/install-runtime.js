// Prepares Still's Firefox runtime: a copy of the signed Firefox build with
// Still's window layer installed through Firefox's enterprise autoconfig hook.
// The original runtime folder is never modified.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const sourceExecutableName = windows ? 'firefox.exe' : 'firefox';
const executableName = windows ? 'firefox.exe' : 'still';
const dataRoot = path.join(process.env.XDG_DATA_HOME || path.join(require('node:os').homedir(), '.local', 'share'), 'still');
const prototypeRoot = windows ? path.join(path.parse(root).root, 'Still Firefox Prototype', 'runtime') : path.join(dataRoot, 'runtime');
const sourceRuntime = process.env.STILL_FIREFOX_SOURCE_RUNTIME || (windows ? path.join(prototypeRoot, 'core') : '/usr/lib/firefox');
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
    if (!windows) fs.chmodSync(target, fs.statSync(source).mode & 0o777);
  } catch (error) {
    const same = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size;
    if (!same || !['EPERM', 'EBUSY', 'ETXTBSY'].includes(error.code)) {
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
    if (entry.isSymbolicLink() && !windows) {
      // Distro runtimes can contain optional dangling library links. Preserve
      // the source target without turning a relative link into a broken copy.
      const link = fs.readlinkSync(source);
      const resolved = path.resolve(path.dirname(source), link);
      fs.rmSync(target, { force: true });
      fs.symlinkSync(resolved, target);
    }
    else if (entry.isDirectory()) copyDirectory(source, target, skip);
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

// Hash only deployable Still inputs, not the large Firefox engine or sidecar.
// An unchanged launch must preserve Firefox's compiled startup caches.
function layerVersion() {
  const hash = createHash('sha256');
  function add(file) {
    hash.update(path.relative(root, file));
    if (!fs.existsSync(file)) { hash.update('missing'); return; }
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) add(path.join(file, name));
    } else hash.update(fs.readFileSync(file));
  }
  for (const file of [__filename, chromeSource, path.join(__dirname, 'build'),
    path.join(root, 'src', 'assets', 'still-icon.png'), path.join(root, 'build', 'icon.ico'),
    path.join(root, 'build', 'searxng-sidecar', 'still-build.json')]) add(file);
  return hash.digest('hex');
}

function install(runtime = userRuntime) {
  let engineInstalled = false;
  if (!fs.existsSync(path.join(runtime, '.still-runtime-complete'))) {
    if (!fs.existsSync(path.join(sourceRuntime, sourceExecutableName))) {
      throw new Error(`Firefox runtime not found: ${sourceRuntime}`);
    }
    console.log(`Copying Firefox runtime to ${runtime}`);
    copyDirectory(sourceRuntime, runtime);
    fs.writeFileSync(path.join(runtime, '.still-runtime-complete'), '1\n');
    engineInstalled = true;
  }
  const version = layerVersion();
  const versionFile = path.join(runtime, '.still-layer-version');
  if (!engineInstalled && fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf8') === version) return runtime;
  fs.rmSync(path.join(runtime, 'autoconfig-ok.txt'), { force: true });
  fs.mkdirSync(path.join(runtime, 'defaults', 'pref'), { recursive: true });
  fs.copyFileSync(path.join(chromeSource, 'still-autoconfig.js'), path.join(runtime, 'defaults', 'pref', 'still-autoconfig.js'));
  fs.copyFileSync(path.join(chromeSource, 'still.cfg'), path.join(runtime, 'still.cfg'));
  // Plasma also matches the executable basename, before the Wayland app ID.
  // Use a real Still executable (a symlink still resolves to firefox in /proc).
  if (!windows) copyFile(path.join(runtime, sourceExecutableName), path.join(runtime, executableName));
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
  if (fs.existsSync(path.join(searchSource, windows ? 'searxng-sidecar.exe' : 'searxng-sidecar')) && stamp(searchSource) !== stamp(searchTarget)) {
    fs.rmSync(searchTarget, { recursive: true, force: true });
    copyDirectory(searchSource, searchTarget, (name) => name.endsWith('.tar.gz'));
  }
  copyFile(path.join(root, 'src', 'assets', 'still-icon.png'), path.join(target, 'still-icon.png'));
  const extension = path.join(__dirname, 'build');
  if (fs.existsSync(path.join(extension, 'manifest.json'))) syncDirectory(extension, path.join(target, 'extension'));
  // Window and taskbar icon, applied by StillShared.sys.mjs.
  const icon = path.join(root, 'build', 'icon.ico');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(target, 'still.ico'));
  fs.writeFileSync(versionFile, version);
  console.log(`Installed Still window layer in ${runtime}`);
  return runtime;
}

if (require.main === module) {
  try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { install, runtime: userRuntime, testRuntime, executableName, dataRoot };
