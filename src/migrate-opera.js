const fs = require('node:fs');
const path = require('node:path');

const WEBSITE_DATA = [
  ['Network', 'Trust Tokens'],
  ['Network', 'Trust Tokens-journal'],
  ['Local Storage'],
  ['Session Storage'],
  ['IndexedDB'],
  ['Service Worker'],
  ['WebStorage'],
  ['shared_proto_db']
];

function operaProfilePath() {
  return path.join(process.env.APPDATA || '', 'Opera Software', 'Opera GX Stable');
}

function flattenBookmarks(node, output = []) {
  if (!node) return output;
  if (node.type === 'url' && node.url) {
    output.push({ name: node.name || node.url, url: node.url });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) flattenBookmarks(child, output);
  }
  return output;
}

async function copyIfPresent(source, destination) {
  try {
    const stat = await fs.promises.stat(source);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) {
      await fs.promises.cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (candidate) => !/(^|[\\/])(Cache|Code Cache|GPUCache)([\\/]|$)/i.test(candidate)
      });
    } else {
      await fs.promises.copyFile(source, destination);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function importBookmarks(operaDefault, userDataPath, report) {
  const source = path.join(operaDefault, 'Bookmarks');
  const raw = await fs.promises.readFile(source, 'utf8');
  const parsed = JSON.parse(raw);
  const bookmarks = [];
  for (const root of Object.values(parsed.roots || {})) flattenBookmarks(root, bookmarks);
  await fs.promises.writeFile(
    path.join(userDataPath, 'opera-bookmarks.json'),
    JSON.stringify(bookmarks, null, 2),
    'utf8'
  );
  report.bookmarks = bookmarks.length;
}

async function importEncryptionState(operaRoot, userDataPath, report) {
  const source = JSON.parse(await fs.promises.readFile(path.join(operaRoot, 'Local State'), 'utf8'));
  if (!source.os_crypt) return;

  const destination = path.join(userDataPath, 'Local State');
  let target = {};
  try {
    target = JSON.parse(await fs.promises.readFile(destination, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  target.os_crypt = source.os_crypt;
  await fs.promises.writeFile(destination, JSON.stringify(target), 'utf8');
  report.encryptionState = true;
}

async function prepareOperaImport(userDataPath, { force = false } = {}) {
  const marker = path.join(userDataPath, 'opera-import.json');
  if (!force && fs.existsSync(marker)) {
    const previous = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
    if (previous.complete) return previous;
  }

  const operaRoot = operaProfilePath();
  const operaDefault = path.join(operaRoot, 'Default');
  const report = {
    attemptedAt: new Date().toISOString(),
    sourceFound: fs.existsSync(operaDefault),
    bookmarks: 0,
    websiteData: [],
    encryptionState: false,
    complete: false,
    errors: []
  };

  await fs.promises.mkdir(userDataPath, { recursive: true });
  if (!report.sourceFound) {
    report.errors.push('Opera GX profile was not found.');
    await fs.promises.writeFile(marker, JSON.stringify(report, null, 2), 'utf8');
    return report;
  }

  try {
    await importBookmarks(operaDefault, userDataPath, report);
  } catch (error) {
    report.errors.push(`Bookmarks: ${error.message}`);
  }

  try {
    await importEncryptionState(operaRoot, userDataPath, report);
  } catch (error) {
    report.errors.push(`Cookie encryption state: ${error.message}`);
  }

  const partitionPath = path.join(userDataPath, 'Partitions', 'focus');
  for (const relativeParts of WEBSITE_DATA) {
    const label = relativeParts.join('/');
    try {
      const copied = await copyIfPresent(
        path.join(operaDefault, ...relativeParts),
        path.join(partitionPath, ...relativeParts)
      );
      if (copied) report.websiteData.push(label);
    } catch (error) {
      report.errors.push(`${label}: ${error.message}`);
    }
  }

  report.complete = report.errors.length === 0;
  await fs.promises.writeFile(marker, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

function readImportedBookmarks(userDataPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataPath, 'opera-bookmarks.json'), 'utf8'));
  } catch {
    return [];
  }
}

module.exports = { prepareOperaImport, readImportedBookmarks };
