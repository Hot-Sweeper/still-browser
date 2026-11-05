// Moves the bundled SearXNG to the newest upstream commit, then rebuilds it.
// SearXNG has no numbered releases; its main branch is the release. The new
// commit is pinned with the SHA-256 of its source archive, so builds stay
// reproducible and verified. Usage: npm run searxng:update [-- <commit>]
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pinPath = path.join(__dirname, 'searxng-pin.json');

async function main() {
  const requested = process.argv[2];
  const api = `https://api.github.com/repos/searxng/searxng/commits/${requested || 'master'}`;
  const info = await (await fetch(api, { headers: { Accept: 'application/vnd.github+json' } })).json();
  if (!/^[0-9a-f]{40}$/.test(info.sha || '')) throw new Error(`GitHub did not return a commit (${info.message || 'unknown error'}).`);
  const previous = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  if (previous.commit === info.sha && process.env.STILL_REBUILD_SEARXNG !== '1') {
    console.log(`SearXNG is already at ${info.sha.slice(0, 9)}.`);
    return;
  }
  const archive = await fetch(`https://github.com/searxng/searxng/archive/${info.sha}.tar.gz`, { redirect: 'follow' });
  if (!archive.ok) throw new Error(`Source download failed (HTTP ${archive.status}).`);
  const sourceSha256 = createHash('sha256').update(Buffer.from(await archive.arrayBuffer())).digest('hex');
  const date = info.commit.committer.date.slice(0, 10).split('-').map(Number).join('.');
  fs.writeFileSync(pinPath, `${JSON.stringify({ commit: info.sha, date, sourceSha256 }, null, 2)}\n`);
  console.log(`Pinned SearXNG ${date}+${info.sha.slice(0, 9)} (${info.commit.message.split('\n')[0]}).`);
  const build = spawnSync(process.execPath, [path.join(__dirname, 'build-searxng.js')], { stdio: 'inherit' });
  if (build.status !== 0) {
    fs.writeFileSync(pinPath, `${JSON.stringify(previous, null, 2)}\n`);
    throw new Error('The new SearXNG did not build; the previous pin is restored.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
