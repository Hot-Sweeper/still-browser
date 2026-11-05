const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
// The pinned SearXNG source lives in searxng-pin.json; `npm run searxng:update`
// moves the pin to the newest upstream commit (with its checksum).
const pin = JSON.parse(fs.readFileSync(path.join(__dirname, 'searxng-pin.json'), 'utf8'));
const commit = pin.commit;
const shortCommit = commit.slice(0, 9);
const version = `${pin.date}+${shortCommit}`;
const recipe = 5;
const sourceSha256 = pin.sourceSha256;
const sourceUrl = `https://github.com/searxng/searxng/archive/${commit}.tar.gz`;
const output = path.join(root, 'build', 'searxng-sidecar');
const work = path.join(root, 'build', 'searxng-work');
const markerPath = path.join(output, 'still-build.json');
const executableName = process.platform === 'win32' ? 'searxng-sidecar.exe' : 'searxng-sidecar';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || 'inherit',
    env: options.env || process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status || 1}.`);
  return String(result.stdout || '').trim();
}

function pythonCommand() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['python', []]]
    : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.status === 0 && result.stdout.trim()) return { command, prefix };
  }
  throw new Error('Python 3.10 or newer is required to build the bundled SearXNG sidecar.');
}

function venvPython() {
  return path.join(work, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

async function downloadVerifiedSource(destination) {
  const response = await fetch(sourceUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`SearXNG source returned HTTP ${response.status}.`);
  const source = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== sourceSha256) throw new Error('SearXNG source checksum verification failed.');
  fs.writeFileSync(destination, source, { mode: 0o600 });
}

function alreadyBuilt() {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker.commit === commit && marker.recipe === recipe && fs.existsSync(path.join(output, executableName));
  } catch {
    return false;
  }
}

async function main() {
  if (alreadyBuilt() && process.env.STILL_REBUILD_SEARXNG !== '1') {
    console.log(`Using bundled SearXNG ${version}.`);
    return;
  }

  const resolvedWork = path.resolve(work);
  const resolvedBuild = path.resolve(root, 'build');
  if (path.dirname(resolvedWork) !== resolvedBuild) throw new Error('Unsafe SearXNG build path.');
  fs.rmSync(resolvedWork, { recursive: true, force: true });
  fs.mkdirSync(resolvedWork, { recursive: true });

  const archivePath = path.join(work, `searxng-${shortCommit}.tar.gz`);
  const sourcePath = path.join(work, 'source');
  fs.mkdirSync(sourcePath, { recursive: true });
  await downloadVerifiedSource(archivePath);

  const archiveRoot = `searxng-${commit}`;
  // Windows' own tar: Git Bash's GNU tar reads "D:\..." as a remote host.
  const systemTar = process.platform === 'win32' && path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  run(systemTar && fs.existsSync(systemTar) ? systemTar : 'tar', [
    '-xzf', archivePath,
    '-C', sourcePath,
    '--strip-components=1',
    `${archiveRoot}/searx`,
    `${archiveRoot}/setup.py`,
    `${archiveRoot}/requirements.txt`,
    `${archiveRoot}/requirements-dev.txt`,
    `${archiveRoot}/README.rst`,
    `${archiveRoot}/LICENSE`
  ]);

  const frozenVersion = [
    '# Generated from the pinned Still Browser SearXNG source archive.',
    `VERSION_STRING = ${JSON.stringify(version)}`,
    `VERSION_TAG = ${JSON.stringify(version)}`,
    `DOCKER_TAG = ${JSON.stringify(version.replace('+', '-'))}`,
    'GIT_URL = "https://github.com/searxng/searxng"',
    'GIT_BRANCH = "master"',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(sourcePath, 'searx', 'version_frozen.py'), frozenVersion, 'utf8');

  const python = pythonCommand();
  run(python.command, [...python.prefix, '-m', 'venv', path.join(work, 'venv')]);
  const venv = venvPython();
  run(venv, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel']);
  run(venv, [
    '-m', 'pip', 'install', '--disable-pip-version-check',
    '-r', path.join(sourcePath, 'requirements.txt'),
    'waitress==3.0.2',
    'tzdata==2026.3',
    'pyinstaller==6.16.0'
  ]);
  run(venv, [
    '-m', 'pip', 'install', '--disable-pip-version-check',
    '--no-deps', '--no-build-isolation', sourcePath
  ]);

  const distPath = path.join(work, 'dist');
  run(venv, [
    '-m', 'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onedir',
    '--name', 'searxng-sidecar',
    '--distpath', distPath,
    '--workpath', path.join(work, 'pyinstaller'),
    '--specpath', work,
    '--collect-all', 'searx',
    '--collect-all', 'tzdata',
    '--collect-submodules', 'searx.engines',
    '--collect-submodules', 'searx.plugins',
    '--add-data', `${path.join(sourcePath, 'searx')}${path.delimiter}searx`,
    '--copy-metadata', 'searxng',
    path.join(root, 'sidecar', 'searxng-launcher.py')
  ]);

  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(path.join(distPath, 'searxng-sidecar'), output, { recursive: true });
  fs.copyFileSync(archivePath, path.join(output, `searxng-source-${shortCommit}.tar.gz`));
  fs.copyFileSync(path.join(sourcePath, 'LICENSE'), path.join(output, 'SEARXNG-LICENSE'));
  fs.writeFileSync(markerPath, JSON.stringify({ commit, version, sourceSha256, recipe }, null, 2), 'utf8');
  console.log(`Built bundled SearXNG ${version}.`);
}

main().catch((error) => {
  console.error(`Could not build bundled SearXNG: ${error.message}`);
  process.exitCode = 1;
});
