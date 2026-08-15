const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const CHROME_EPOCH_OFFSET_SECONDS = 11644473600;

function operaRoot() {
  return path.join(process.env.APPDATA || '', 'Opera Software', 'Opera GX Stable');
}

function decryptMasterKey(localStatePath) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "$state = Get-Content -Raw -LiteralPath $env:FOCUS_OPERA_LOCAL_STATE | ConvertFrom-Json",
    "$wrapped = [Convert]::FromBase64String($state.os_crypt.encrypted_key)",
    "$payload = $wrapped[5..($wrapped.Length - 1)]",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($plain)"
  ].join('; ');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedScript
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, FOCUS_OPERA_LOCAL_STATE: localStatePath }
  });
  return Buffer.from(output.trim(), 'base64');
}

function decryptCookie(row, key, schemaVersion) {
  const encrypted = Buffer.from(row.encrypted_value);
  const prefix = encrypted.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    throw new Error(`Unsupported cookie encryption prefix: ${prefix || 'unknown'}`);
  }

  const nonce = encrypted.subarray(3, 15);
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(15, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (schemaVersion >= 24 && plaintext.length >= 32) {
    const expectedHostHash = crypto.createHash('sha256').update(row.host_key).digest();
    if (crypto.timingSafeEqual(plaintext.subarray(0, 32), expectedHostHash)) {
      plaintext = plaintext.subarray(32);
    }
  }
  return plaintext.toString('utf8');
}

function chromeTimeToUnixSeconds(value) {
  const raw = typeof value === 'bigint' ? Number(value) : Number(value || 0);
  if (!raw) return undefined;
  return raw / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
}

function sameSiteName(value) {
  if (value === 0) return 'no_restriction';
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  return 'unspecified';
}

function priorityName(value) {
  if (value === 0) return 'low';
  if (value === 2) return 'high';
  return 'medium';
}

async function setInBatches(cookieSession, cookies, report) {
  for (let start = 0; start < cookies.length; start += 40) {
    const batch = cookies.slice(start, start + 40);
    const results = await Promise.allSettled(batch.map((cookie) => cookieSession.cookies.set(cookie)));
    for (const result of results) {
      if (result.status === 'fulfilled') report.imported += 1;
      else report.rejected += 1;
    }
  }
}

async function importOperaCookies(cookieSession, userDataPath) {
  await fs.promises.mkdir(userDataPath, { recursive: true });
  const marker = path.join(userDataPath, 'cookie-import.json');
  try {
    const previous = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
    if (previous.complete) return previous;
  } catch {}

  const report = {
    attemptedAt: new Date().toISOString(),
    complete: false,
    found: 0,
    decrypted: 0,
    imported: 0,
    rejected: 0,
    decryptFailed: 0,
    error: null
  };

  let database;
  try {
    const root = operaRoot();
    const cookiesPath = path.join(root, 'Default', 'Network', 'Cookies');
    const key = decryptMasterKey(path.join(root, 'Local State'));
    database = new DatabaseSync(cookiesPath, { readOnly: true });
    const meta = database.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const schemaVersion = Number(meta?.value || 0);
    const cookieQuery = database.prepare(`
      SELECT host_key, name, path, encrypted_value, expires_utc,
             is_secure, is_httponly, samesite, priority
      FROM cookies
    `);
    cookieQuery.setReadBigInts(true);
    const rows = cookieQuery.all();
    report.found = rows.length;

    const now = Date.now() / 1000;
    const cookies = [];
    for (const row of rows) {
      try {
        const host = row.host_key.replace(/^\./, '');
        const cookiePath = row.path?.startsWith('/') ? row.path : '/';
        const expirationDate = chromeTimeToUnixSeconds(row.expires_utc);
        if (expirationDate && expirationDate <= now) continue;
        const secure = Boolean(row.is_secure);
        const cookie = {
          url: `${secure ? 'https' : 'http'}://${host}${cookiePath}`,
          name: row.name,
          value: decryptCookie(row, key, schemaVersion),
          domain: row.host_key,
          path: cookiePath,
          secure,
          httpOnly: Boolean(row.is_httponly),
          sameSite: sameSiteName(Number(row.samesite)),
          priority: priorityName(Number(row.priority))
        };
        if (expirationDate) cookie.expirationDate = expirationDate;
        cookies.push(cookie);
        report.decrypted += 1;
      } catch {
        report.decryptFailed += 1;
      }
    }

    await setInBatches(cookieSession, cookies, report);
    report.complete = true;
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR') {
      report.error = 'Opera GX is still using its cookie database. Close Opera GX and restart Still once.';
    } else if (typeof error.status === 'number') {
      report.error = 'Windows could not unlock the Opera GX cookie key.';
    } else {
      report.error = error.message;
    }
  } finally {
    database?.close();
  }

  await fs.promises.writeFile(marker, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

module.exports = { importOperaCookies };
