const fs = require('node:fs');
const path = require('node:path');

const DISABLED_EXTENSION_IDS = new Set([
  'pachckjkecffpdphbpmfolblodfkgbhl' // vidIQ Vision for YouTube
]);

function operaDefaultPath() {
  return path.join(process.env.APPDATA || '', 'Opera Software', 'Opera GX Stable', 'Default');
}

function newestVersionDirectory(extensionRoot) {
  return fs.readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(extensionRoot, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
}

function resolveManifestName(manifest, extensionPath) {
  if (!/^__MSG_.+__$/.test(manifest.name || '')) return manifest.name || 'Unnamed extension';
  const key = manifest.name.slice(6, -2);
  const localeCandidates = [manifest.default_locale, 'en', 'en_US'].filter(Boolean);
  for (const locale of localeCandidates) {
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(extensionPath, '_locales', locale, 'messages.json'), 'utf8'));
      if (messages[key]?.message) return messages[key].message;
    } catch {}
  }
  return key.replaceAll('_', ' ');
}

async function prepareOperaExtensions(userDataPath) {
  const registryPath = path.join(userDataPath, 'opera-extensions.json');
  const sourceProfile = operaDefaultPath();
  const sourceRoot = path.join(sourceProfile, 'Extensions');
  const importedRoot = path.join(userDataPath, 'Imported Extensions');
  const destinationSettingsRoot = path.join(userDataPath, 'Partitions', 'focus', 'Local Extension Settings');

  if (!fs.existsSync(sourceRoot)) {
    try {
      return JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
    } catch {
      return [];
    }
  }

  let settings = {};
  try {
    const securePreferences = JSON.parse(await fs.promises.readFile(path.join(sourceProfile, 'Secure Preferences'), 'utf8'));
    settings = securePreferences.extensions?.opsettings || {};
  } catch {}

  const imported = [];
  await fs.promises.mkdir(importedRoot, { recursive: true });
  for (const idEntry of await fs.promises.readdir(sourceRoot, { withFileTypes: true })) {
    if (!idEntry.isDirectory()) continue;
    const id = idEntry.name;
    const extensionSettings = settings[id] || {};
    const enabled = !Array.isArray(extensionSettings.disable_reasons) || extensionSettings.disable_reasons.length === 0;
    if (!enabled || extensionSettings.was_installed_by_default) continue;

    const sourceExtensionRoot = path.join(sourceRoot, id);
    const versionDirectory = newestVersionDirectory(sourceExtensionRoot);
    if (!versionDirectory) continue;
    const sourcePath = path.join(sourceExtensionRoot, versionDirectory);

    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(sourcePath, 'manifest.json'), 'utf8'));
      const destinationPath = path.join(importedRoot, id, versionDirectory);
      if (!fs.existsSync(path.join(destinationPath, 'manifest.json'))) {
        await fs.promises.cp(sourcePath, destinationPath, { recursive: true, force: true });
      }

      const sourceSettings = path.join(sourceProfile, 'Local Extension Settings', id);
      const destinationSettings = path.join(destinationSettingsRoot, id);
      if (fs.existsSync(sourceSettings) && !fs.existsSync(destinationSettings)) {
        try {
          await fs.promises.cp(sourceSettings, destinationSettings, { recursive: true, force: false });
        } catch {}
      }

      imported.push({
        originalId: id,
        name: resolveManifestName(manifest, sourcePath),
        version: manifest.version || versionDirectory,
        manifestVersion: manifest.manifest_version,
        path: destinationPath
      });
    } catch {}
  }

  await fs.promises.writeFile(registryPath, JSON.stringify(imported, null, 2), 'utf8');
  return imported;
}

async function loadOperaExtensions(browsingSession, extensions) {
  const report = { discovered: extensions.length, loaded: [], disabled: [], failed: [] };
  for (const extension of extensions) {
    if (DISABLED_EXTENSION_IDS.has(extension.originalId)) {
      report.disabled.push({ name: extension.name, id: extension.originalId });
      continue;
    }
    try {
      const loaded = await browsingSession.extensions.loadExtension(extension.path);
      report.loaded.push({ name: extension.name, version: loaded.version, id: loaded.id });
    } catch (error) {
      report.failed.push({ name: extension.name, reason: error.message });
    }
  }
  return report;
}

module.exports = { prepareOperaExtensions, loadOperaExtensions };
