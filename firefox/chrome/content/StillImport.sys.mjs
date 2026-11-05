// Brings sign-ins (cookies) into Still on Firefox from:
// - the Electron build of Still (stored unencrypted in its profile)
// - Opera GX (encrypted with the Windows account key; Opera must be closed,
//   because it locks its cookie file while running)
// Cookies that already exist in Firefox are never overwritten. Nothing is
// written to disk in plain text: the source database is copied to a temp
// file, read, and deleted.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs"
});

const CHROME_EPOCH_MS = 11644473600000;

function appData(...parts) {
  return PathUtils.join(Services.dirsvc.get("AppData", Ci.nsIFile).path, ...parts);
}

export const SOURCES = {
  electron: { label: "Still (Electron)", cookies: () => appData("Focus Slots", "Partitions", "focus", "Network", "Cookies") },
  opera: {
    label: "Opera GX",
    cookies: () => appData("Opera Software", "Opera GX Stable", "Default", "Network", "Cookies"),
    localState: () => appData("Opera Software", "Opera GX Stable", "Local State")
  }
};

// Windows DPAPI: unwraps Opera's cookie key with the signed-in user's key.
function unprotect(bytes) {
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const crypt32 = ctypes.open("crypt32.dll");
  const kernel32 = ctypes.open("kernel32.dll");
  const BLOB = new ctypes.StructType("DATA_BLOB", [{ cbData: ctypes.uint32_t }, { pbData: ctypes.uint8_t.ptr }]);
  const CryptUnprotectData = crypt32.declare("CryptUnprotectData", ctypes.winapi_abi, ctypes.int32_t,
    BLOB.ptr, ctypes.voidptr_t, BLOB.ptr, ctypes.voidptr_t, ctypes.voidptr_t, ctypes.uint32_t, BLOB.ptr);
  const LocalFree = kernel32.declare("LocalFree", ctypes.winapi_abi, ctypes.voidptr_t, ctypes.voidptr_t);
  const input = ctypes.uint8_t.array(bytes.length)(Array.from(bytes));
  const inBlob = new BLOB(bytes.length, input);
  const outBlob = new BLOB(0, null);
  if (!CryptUnprotectData(inBlob.address(), null, null, null, null, 0, outBlob.address())) {
    throw new Error("Windows could not unlock the Opera GX key for this account.");
  }
  const view = ctypes.cast(outBlob.pbData, ctypes.uint8_t.array(outBlob.cbData).ptr).contents;
  const result = Uint8Array.from(view);
  LocalFree(ctypes.cast(outBlob.pbData, ctypes.voidptr_t));
  return result;
}

async function operaKey(win) {
  const state = JSON.parse(await IOUtils.readUTF8(SOURCES.opera.localState()));
  const wrapped = Uint8Array.from(win.atob(state.os_crypt.encrypted_key), (c) => c.charCodeAt(0));
  const raw = unprotect(wrapped.subarray(5)); // strip "DPAPI"
  return win.crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}

async function decryptValue(win, key, blob, host, schema) {
  const bytes = Uint8Array.from(blob);
  const prefix = String.fromCharCode(...bytes.subarray(0, 3));
  if (prefix !== "v10" && prefix !== "v11") return null; // v20 is bound to Opera itself
  const plain = new Uint8Array(await win.crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(3, 15) }, key, bytes.subarray(15)));
  let body = plain;
  if (schema >= 24 && plain.length >= 32) {
    const hash = new Uint8Array(await win.crypto.subtle.digest("SHA-256", new TextEncoder().encode(host)));
    if (hash.every((value, index) => value === plain[index])) body = plain.subarray(32);
  }
  return new TextDecoder().decode(body);
}

function sameSite(value) {
  if (value === 0) return Ci.nsICookie.SAMESITE_NONE;
  if (value === 1) return Ci.nsICookie.SAMESITE_LAX;
  if (value === 2) return Ci.nsICookie.SAMESITE_STRICT;
  return Ci.nsICookie.SAMESITE_UNSET ?? Ci.nsICookie.SAMESITE_NONE;
}

// Returns { imported, skipped, failed } or throws with a readable message.
export async function importCookies(win, sourceName) {
  const source = SOURCES[sourceName];
  const file = source.cookies();
  if (!(await IOUtils.exists(file))) throw new Error(`${source.label} has no saved sign-ins on this computer.`);
  const copy = PathUtils.join(PathUtils.tempDir, `still-import-${Date.now()}.sqlite`);
  try {
    await IOUtils.copy(file, copy);
  } catch {
    throw new Error(`Close ${source.label} first: it locks its sign-ins while it runs.`);
  }
  const report = { imported: 0, skipped: 0, failed: 0 };
  let db;
  try {
    db = await lazy.Sqlite.openConnection({ path: copy, readOnly: true });
    const schema = Number((await db.execute("SELECT value FROM meta WHERE key = 'version'"))[0]?.getResultByName("value") || 0);
    const key = sourceName === "opera" ? await operaKey(win) : null;
    const rows = await db.execute(`SELECT host_key, name, value, encrypted_value, path, expires_utc, is_persistent,
      is_secure, is_httponly, samesite, source_scheme, top_frame_site_key FROM cookies`);
    const now = Date.now();
    for (const row of rows) {
      const host = row.getResultByName("host_key");
      const name = row.getResultByName("name");
      const path = row.getResultByName("path") || "/";
      try {
        if (row.getResultByName("top_frame_site_key")) { report.skipped++; continue; } // partitioned
        let value = row.getResultByName("value");
        if (!value) {
          const blob = row.getResultByName("encrypted_value");
          value = key && blob?.length ? await decryptValue(win, key, blob, host, schema) : null;
        }
        if (value === null || value === undefined) { report.failed++; continue; }
        const persistent = Boolean(row.getResultByName("is_persistent"));
        const expiresUtc = Number(row.getResultByName("expires_utc") || 0);
        const expiry = persistent && expiresUtc ? Math.floor(expiresUtc / 1000) - CHROME_EPOCH_MS : 0;
        if (persistent && expiry && expiry < now) { report.skipped++; continue; }
        if (Services.cookies.cookieExists(host, path, name, {})) { report.skipped++; continue; }
        const secure = Boolean(row.getResultByName("is_secure"));
        const scheme = row.getResultByName("source_scheme") === 2 || secure ? Ci.nsICookie.SCHEME_HTTPS : Ci.nsICookie.SCHEME_HTTP;
        const result = Services.cookies.add(host, path, name, value, secure, Boolean(row.getResultByName("is_httponly")),
          !persistent, persistent ? Services.cookies.maybeCapExpiry(expiry) : Number.MAX_SAFE_INTEGER, {},
          sameSite(row.getResultByName("samesite")), scheme, false);
        if (result && result.result !== undefined && result.result !== Ci.nsICookieValidation.eOK) report.failed++;
        else report.imported++;
      } catch {
        report.failed++;
      }
    }
  } finally {
    await db?.close();
    await IOUtils.remove(copy, { ignoreAbsent: true });
  }
  return report;
}

// ------------------------------------------------------------- history
// Browsing history (with visit times, so Firefox ranks sites the way you use
// them) and site icons from Chromium-based browsers: the Electron build of
// Still and Opera GX. Pages already in Firefox only gain the older visits.

// The Electron build kept no history database of its own (its pages ran in
// web views), so Opera GX, where that history came from, is the source.
const HISTORY_SOURCES = {
  opera: { label: "Opera GX", dir: () => appData("Opera Software", "Opera GX Stable", "Default") }
};

const CHROME_TRANSITION_TYPED = 1;

// Copies left by an import that was cut short (the browser quit mid-way).
async function sweepCopies() {
  try {
    for (const path of await IOUtils.getChildren(PathUtils.tempDir)) {
      const stamp = Number(PathUtils.filename(path).match(/^still-import-(\d+)/)?.[1]);
      if (stamp && Date.now() - stamp > 600000) await IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {});
    }
  } catch {}
}

async function copyDatabase(file, label) {
  if (!(await IOUtils.exists(file))) return null;
  await sweepCopies();
  const copy = PathUtils.join(PathUtils.tempDir, `still-import-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  try {
    await IOUtils.copy(file, copy);
    return copy;
  } catch {
    throw new Error(`Close ${label} first: it locks its history while it runs.`);
  }
}

function chromeTimeToDate(value) {
  const ms = Math.floor(Number(value || 0) / 1000) - CHROME_EPOCH_MS;
  return ms > 0 && ms <= Date.now() ? new Date(ms) : null;
}

function base64(win, bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return win.btoa(binary);
}

// Returns { pages, visits, icons }.
export async function importHistory(win, sourceName, { maxPages = 25000 } = {}) {
  const source = HISTORY_SOURCES[sourceName];
  const historyCopy = await copyDatabase(PathUtils.join(source.dir(), "History"), source.label);
  if (!historyCopy) throw new Error(`${source.label} has no browsing history on this computer.`);
  const report = { pages: 0, visits: 0, icons: 0 };
  const pages = new Map();
  let db;
  try {
    db = await lazy.Sqlite.openConnection({ path: historyCopy, readOnly: true });
    // Every page, with how often it was visited and typed.
    const urls = await db.execute(`SELECT url, title, visit_count, typed_count, last_visit_time FROM urls
      WHERE hidden = 0 AND substr(url, 1, 4) = 'http' AND length(url) < 2000 AND visit_count > 0
      ORDER BY last_visit_time DESC LIMIT :limit`, { limit: maxPages });
    for (const row of urls) {
      pages.set(row.getResultByName("url"), {
        url: row.getResultByName("url"),
        title: row.getResultByName("title") || undefined,
        count: Math.min(12, Number(row.getResultByName("visit_count")) || 1),
        typed: Number(row.getResultByName("typed_count")) || 0,
        last: chromeTimeToDate(row.getResultByName("last_visit_time")),
        visits: []
      });
    }
    // The visit times Opera still keeps (it prunes old ones).
    const visits = await db.execute(`SELECT u.url AS url, v.visit_time AS time, v.transition AS transition
      FROM visits v JOIN urls u ON u.id = v.url
      WHERE u.hidden = 0 AND substr(u.url, 1, 4) = 'http'
      ORDER BY v.visit_time DESC LIMIT 200000`);
    for (const row of visits) {
      const page = pages.get(row.getResultByName("url"));
      if (!page || page.visits.length >= page.count) continue;
      const date = chromeTimeToDate(row.getResultByName("time"));
      if (!date) continue;
      const typed = (Number(row.getResultByName("transition")) & 0xff) === CHROME_TRANSITION_TYPED;
      page.visits.push({ date, transition: typed ? lazy.PlacesUtils.history.TRANSITIONS.TYPED : lazy.PlacesUtils.history.TRANSITIONS.LINK });
    }
    // Firefox ranks by visits, so a page Opera counted 40 times but whose
    // old visit records were pruned gets visits spaced a day apart before its
    // last visit (up to 12), and typed visits where Opera counted typing.
    for (const page of pages.values()) {
      let previous = page.visits.at(-1)?.date || page.last;
      if (!previous) continue;
      let typedLeft = Math.max(0, Math.min(page.typed, page.count) - page.visits.filter((v) => v.transition === lazy.PlacesUtils.history.TRANSITIONS.TYPED).length);
      while (page.visits.length < page.count) {
        const date = page.visits.length ? new Date(previous.getTime() - 86400000) : previous;
        previous = date;
        const typed = typedLeft > 0;
        if (typed) typedLeft--;
        page.visits.push({ date, transition: typed ? lazy.PlacesUtils.history.TRANSITIONS.TYPED : lazy.PlacesUtils.history.TRANSITIONS.LINK });
      }
      for (const key of ["count", "typed", "last"]) delete page[key];
    }
  } finally {
    await db?.close();
    await IOUtils.remove(historyCopy, { ignoreAbsent: true });
  }

  const infos = [...pages.values()].filter((page) => page.visits.length);
  for (let start = 0; start < infos.length; start += 400) {
    if (start) await new Promise((resolve) => win.setTimeout(resolve, 30));
    const batch = infos.slice(start, start + 400);
    try {
      await lazy.PlacesUtils.history.insertMany(batch, () => { report.pages++; }, () => {});
    } catch {
      // A batch with no valid entries rejects; the others still count.
    }
  }
  report.visits = infos.reduce((sum, page) => sum + page.visits.length, 0);

  // Site icons for the most recent pages and their sites' home pages.
  try {
    report.icons = await importIcons(win, source, infos.slice(0, 4000).map((page) => page.url));
  } catch (error) {
    console.error("Still could not bring over site icons", error);
  }
  return report;
}

async function importIcons(win, source, urls) {
  const iconsCopy = await copyDatabase(PathUtils.join(source.dir(), "Favicons"), source.label).catch(() => null);
  if (!iconsCopy) return 0;
  let count = 0;
  let db;
  try {
    db = await lazy.Sqlite.openConnection({ path: iconsCopy });
    await db.execute("CREATE TEMP TABLE still_wanted (url TEXT PRIMARY KEY)");
    const wanted = new Set(urls);
    for (const url of urls) {
      try { wanted.add(`${new URL(url).origin}/`); } catch {}
    }
    await db.executeTransaction(async () => {
      for (const url of wanted) await db.executeCached("INSERT OR IGNORE INTO still_wanted (url) VALUES (:url)", { url });
    });
    const rows = await db.execute(`SELECT m.page_url AS page, f.url AS icon, b.image_data AS data, b.width AS width
      FROM icon_mapping m
      JOIN still_wanted w ON w.url = m.page_url
      JOIN favicons f ON f.id = m.icon_id
      JOIN favicon_bitmaps b ON b.icon_id = m.icon_id
      WHERE b.width <= 64 AND length(b.image_data) > 0
      ORDER BY b.width DESC`);
    const seen = new Set();
    let handled = 0;
    for (const row of rows) {
      // Give the browser room between small chunks so it stays responsive.
      if (++handled % 40 === 0) await new Promise((resolve) => win.setTimeout(resolve, 8));
      const page = row.getResultByName("page");
      if (seen.has(page)) continue;
      seen.add(page);
      const data = row.getResultByName("data");
      const icon = row.getResultByName("icon");
      if (!data?.length || !/^https?:/i.test(icon || "")) continue;
      try {
        const dataUri = Services.io.newURI(`data:image/png;base64,${base64(win, Uint8Array.from(data))}`);
        await lazy.PlacesUtils.favicons.setFaviconForPage(Services.io.newURI(page), Services.io.newURI(icon), dataUri);
        count++;
      } catch {
        // Pages that are not in history (or odd icon data) are skipped.
      }
    }
  } finally {
    await db?.close();
    await IOUtils.remove(iconsCopy, { ignoreAbsent: true });
  }
  return count;
}

export const StillImport = { importCookies, importHistory, SOURCES };
