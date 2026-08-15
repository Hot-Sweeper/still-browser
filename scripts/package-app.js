const { spawnSync } = require('node:child_process');
const path = require('node:path');

const mode = process.argv[2] || process.platform;
const targetPlatform = mode === 'pack' ? process.platform : mode;
const supportedPlatforms = new Set(['win32', 'linux', 'darwin']);

if (!supportedPlatforms.has(targetPlatform)) {
  console.error(`Packaging is not configured for ${targetPlatform}.`);
  process.exit(1);
}

if (targetPlatform !== process.platform) {
  console.error(`Build ${targetPlatform} packages on a ${targetPlatform} runner.`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

if (targetPlatform === 'win32') {
  run('dotnet', [
    'publish',
    'native/mouse-navigation-helper/MouseNavigationHelper.csproj',
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:PublishTrimmed=true',
    '-p:DebugType=None',
    '-p:DebugSymbols=false',
    '-o', 'build/mouse-helper'
  ]);
}

const builder = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js');
const args = mode === 'pack'
  ? ['--dir']
  : targetPlatform === 'win32'
    ? ['--win', 'portable']
    : targetPlatform === 'linux'
      ? ['--linux', 'AppImage', 'deb']
      : ['--mac', 'dmg', 'zip'];
run(process.execPath, [builder, ...args]);
