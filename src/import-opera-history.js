const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function prepareOperaHistory(userDataPath) {
  const source = path.join(process.env.APPDATA || '', 'Opera Software', 'Opera GX Stable', 'Default', 'History');
  const snapshot = path.join(userDataPath, 'opera-history-snapshot');
  const destination = path.join(userDataPath, 'opera-history.json');
  let database;

  try {
    await fs.promises.mkdir(userDataPath, { recursive: true });
    await fs.promises.copyFile(source, snapshot);
    database = new DatabaseSync(snapshot, { readOnly: true });
    const query = database.prepare(`
      SELECT url, title, visit_count, typed_count, last_visit_time
      FROM urls
      WHERE hidden = 0 AND (url LIKE 'https://%' OR url LIKE 'http://%')
      ORDER BY last_visit_time DESC
      LIMIT 5000
    `);
    query.setReadBigInts(true);
    const history = query.all().map((row) => ({
      url: row.url,
      title: row.title || row.url,
      visitCount: Number(row.visit_count),
      typedCount: Number(row.typed_count),
      lastVisit: Number(row.last_visit_time / 1_000_000n)
    }));
    await fs.promises.writeFile(destination, JSON.stringify(history), 'utf8');
    return history;
  } catch {
    try {
      return JSON.parse(await fs.promises.readFile(destination, 'utf8'));
    } catch {
      return [];
    }
  } finally {
    database?.close();
    try { await fs.promises.unlink(snapshot); } catch {}
  }
}

module.exports = { prepareOperaHistory };
