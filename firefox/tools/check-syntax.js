// Syntax check for Still's Firefox layer (chrome scripts are not CommonJS,
// and still.cfg has no .js extension).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'chrome');
for (const file of ['still.cfg', 'still-autoconfig.js', 'content/still-window.js']) {
  new vm.Script(fs.readFileSync(path.join(dir, file), 'utf8'), { filename: file });
}
for (const file of fs.readdirSync(path.join(dir, 'content')).filter((name) => name.endsWith('.mjs'))) {
  execFileSync(process.execPath, ['--check', path.join(dir, 'content', file)], { stdio: 'inherit' });
}
for (const file of ['launcher.js', 'identity.js', 'install-runtime.js', 'tools/create-shortcut.js', 'tools/session.js', 'tools/check-linux-launch.js', 'tools/check-scrolling.js', 'tools/check-refresh.js', 'tools/check-watch-refresh.js', 'tools/check-youtube-startup.js']) {
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', file)], { stdio: 'inherit' });
}
console.log('Still Firefox layer: syntax OK');
