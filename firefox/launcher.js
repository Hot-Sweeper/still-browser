// Starts Still on Firefox: Still's runtime (see install-runtime.js) with a
// persistent profile. The browser starts Still Search itself. No automation or
// remote debugging is attached, so sites see an ordinary Firefox.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { install, executableName, dataRoot } = require('./install-runtime');

const root = path.resolve(__dirname, '..');
const prototypeRoot = path.join(path.parse(root).root, 'Still Firefox Prototype');
const profile = process.env.STILL_FIREFOX_PROFILE || (process.platform === 'win32' ? path.join(prototypeRoot, 'profile') : path.join(dataRoot, 'profile'));

async function main() {
  if (!fs.existsSync(path.join(__dirname, 'build', 'manifest.json'))) {
    throw new Error('Run npm run firefox:build before launching Still on Firefox.');
  }
  const runtime = install();
  fs.mkdirSync(profile, { recursive: true });

  console.log(`Profile: ${profile}`);
  const child = spawn(path.join(runtime, executableName), ['-profile', profile, '--wait-for-browser', ...process.argv.slice(2)], {
    cwd: runtime,
    stdio: 'inherit'
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (signal && child.exitCode === null) child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    stop();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    stop();
    process.exitCode = code || 0;
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
