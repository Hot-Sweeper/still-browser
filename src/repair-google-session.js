const fs = require('node:fs');
const path = require('node:path');

const GOOGLE_COOKIE_ROOTS = ['google.com', 'google.de'];

function isGoogleCookie(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return GOOGLE_COOKIE_ROOTS.some((root) => domain === root || domain.endsWith(`.${root}`));
}

function removalUrl(cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '');
  const cookiePath = String(cookie.path || '/').startsWith('/') ? cookie.path || '/' : '/';
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookiePath}`;
}

async function repairGoogleSession(browsingSession, userDataPath) {
  await fs.promises.mkdir(userDataPath, { recursive: true });
  const marker = path.join(userDataPath, 'google-session-repair-v1.json');
  try {
    const previous = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
    if (previous.complete) return previous;
  } catch {}

  const report = {
    attemptedAt: new Date().toISOString(),
    complete: false,
    removed: 0,
    remaining: 0,
    cacheCleared: false,
    error: null
  };

  try {
    // Repeat because more than one cookie can share a name while differing by
    // domain or path, and Electron's remove API identifies them by URL + name.
    for (let pass = 0; pass < 3; pass += 1) {
      const cookies = (await browsingSession.cookies.get({})).filter(isGoogleCookie);
      if (!cookies.length) break;
      for (const cookie of cookies) {
        await browsingSession.cookies.remove(removalUrl(cookie), cookie.name);
        report.removed += 1;
      }
    }

    await browsingSession.clearCache();
    report.cacheCleared = true;
    report.remaining = (await browsingSession.cookies.get({})).filter(isGoogleCookie).length;
    report.complete = report.remaining === 0;
    if (!report.complete) report.error = 'Some Google cookies could not be removed; Still will retry next launch.';
  } catch (error) {
    report.error = error.message;
  }

  await fs.promises.writeFile(marker, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

module.exports = { repairGoogleSession };
