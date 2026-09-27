const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalSearxng } = require('../src/searxng');

const root = path.resolve(__dirname, '..');
const searchPort = 48230;
const firefoxBinary = process.env.STILL_FIREFOX_BINARY
  || path.join(path.parse(root).root, 'Still Firefox Prototype', 'runtime', 'core', 'firefox.exe');
const webExt = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const sourceDir = path.join(__dirname, 'build');
const localData = path.join(__dirname, '.local');

async function main() {
  if (!fs.existsSync(firefoxBinary)) {
    throw new Error(`Firefox runtime not found: ${firefoxBinary}\nSet STILL_FIREFOX_BINARY to the signed Firefox executable.`);
  }
  if (!fs.existsSync(webExt)) throw new Error('Run npm install before launching the prototype.');
  if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    throw new Error('Run npm run firefox:build before launching the prototype.');
  }
  fs.mkdirSync(localData, { recursive: true });
  const search = await startLocalSearxng({
    isPackaged: false,
    appPath: root,
    userDataPath: localData,
    fixedPort: searchPort
  });
  console.log(`Still Search ready at ${search.baseUrl}`);

  const child = spawn(process.execPath, [webExt, 'run', '--source-dir', sourceDir,
    '--firefox', firefoxBinary, '--no-reload', '--no-input', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false
  });
  let stopping = false;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    search.stop();
    if (child.exitCode === null) child.kill(signal);
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    stop();
    console.error(error);
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
