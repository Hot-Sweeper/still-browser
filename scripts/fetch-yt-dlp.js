const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const assets = {
  'win32-x64': 'yt-dlp.exe',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos'
};

const platformKey = `${process.platform}-${process.arch}`;
const asset = assets[platformKey];
if (!asset) {
  console.log(`Skipping bundled yt-dlp: ${platformKey} is not a supported release target.`);
  process.exit(0);
}

const destinationName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const destinationDirectory = path.join(__dirname, '..', 'build', 'vendor');
const destination = path.join(destinationDirectory, destinationName);
const releaseBase = process.env.STILL_YTDLP_RELEASE_BASE
  || 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function expectedDigest(checksums, filename) {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = checksums.match(new RegExp(`^([a-f0-9]{64})\\s+\\*?${escaped}$`, 'mi'));
  return match?.[1]?.toLowerCase() || '';
}

async function main() {
  if (fs.existsSync(destination) && process.env.STILL_REFRESH_YTDLP !== '1') {
    console.log(`Using existing ${path.relative(process.cwd(), destination)}.`);
    return;
  }

  const [binary, checksumBytes] = await Promise.all([
    download(`${releaseBase}/${asset}`),
    download(`${releaseBase}/SHA2-256SUMS`)
  ]);
  const expected = expectedDigest(checksumBytes.toString('utf8'), asset);
  const actual = crypto.createHash('sha256').update(binary).digest('hex');
  if (!expected || actual !== expected) throw new Error(`Checksum verification failed for ${asset}.`);

  await fs.promises.mkdir(destinationDirectory, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, binary, { mode: 0o755 });
  if (process.platform !== 'win32') await fs.promises.chmod(temporary, 0o755);
  await fs.promises.rename(temporary, destination);
  console.log(`Downloaded and verified ${asset}.`);
}

main().catch((error) => {
  console.error(`Could not prepare yt-dlp: ${error.message}`);
  process.exitCode = 1;
});
