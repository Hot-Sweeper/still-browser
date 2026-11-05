// Makes Still on Firefox launchable like an app:
// - "Still (Firefox)" shortcuts on the Desktop and in the Start menu
// - the pinned taskbar "Still" (previously the Electron build) now opens it
// Every shortcut carries Still's taskbar ID (HotSweeper.Still), so the running
// window sits on the pinned button instead of opening a second one.
// Undo: node firefox/tools/create-shortcut.js --remove (restores the old pin).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('../install-runtime');

const root = path.resolve(__dirname, '..', '..');

if (process.platform === 'linux') {
  const applications = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
  const entry = path.join(applications, 'still.desktop');
  if (process.argv.includes('--remove')) {
    fs.rmSync(entry, { force: true });
  } else {
    install();
    fs.mkdirSync(applications, { recursive: true });
    const quote = (value) => '"' + value.replace(/["`$\\]/g, '\\$&') + '"';
    fs.writeFileSync(entry, [
      '[Desktop Entry]', 'Type=Application', 'Name=Still',
      'Comment=Still Firefox browser',
      `Exec=${quote(process.execPath)} ${quote(path.join(root, 'firefox', 'launcher.js'))} %U`,
      `Icon=${path.join(root, 'src', 'assets', 'still-icon.png')}`,
      'Terminal=false', 'Categories=Network;WebBrowser;',
      'MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;',
      'StartupWMClass=still', ''
    ].join('\n'));
  }
  console.log(`Still Linux desktop entry: ${entry}`);
  process.exit(0);
}

const prototypeRoot = path.join(path.parse(root).root, 'Still Firefox Prototype');
const profile = process.env.STILL_FIREFOX_PROFILE || path.join(prototypeRoot, 'profile');
const backup = path.join(prototypeRoot, 'backup');
const name = 'Still (Firefox).lnk';
const places = [
  path.join(os.homedir(), 'Desktop'),
  path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
];
const pin = path.join(process.env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Still.lnk');
const pinBackup = path.join(backup, 'Still-taskbar-pin-before-firefox.lnk');

if (process.argv.includes('--remove')) {
  for (const dir of places) fs.rmSync(path.join(dir, name), { force: true });
  if (fs.existsSync(pinBackup)) fs.copyFileSync(pinBackup, pin);
  console.log('Removed Still (Firefox) shortcuts and restored the previous taskbar pin.');
  process.exit(0);
}

const runtime = install();
fs.mkdirSync(profile, { recursive: true });
const write = (lnk) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'shortcut.ps1'),
  '-Lnk', lnk, '-Exe', path.join(runtime, 'firefox.exe'), '-Arguments', `-profile "${profile}"`,
  '-WorkDir', runtime, '-Icon', path.join(runtime, 'still-chrome', 'still.ico')], { stdio: 'inherit' });

for (const dir of places) {
  write(path.join(dir, name));
  console.log(`Created ${path.join(dir, name)}`);
}
if (fs.existsSync(path.dirname(pin))) {
  fs.mkdirSync(backup, { recursive: true });
  if (fs.existsSync(pin) && !fs.existsSync(pinBackup)) fs.copyFileSync(pin, pinBackup);
  write(pin);
  console.log(`Taskbar pin "Still" now opens Still on Firefox (old pin saved in ${pinBackup}).`);
}
