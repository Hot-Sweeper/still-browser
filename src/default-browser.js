const { app, shell } = require('electron');
const { spawnSync } = require('node:child_process');

function registerStillBrowser() {
  if (process.platform !== 'win32') return false;
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const progId = 'StillURL';
  const command = `"${executable}" "%1"`;
  const entries = [
    ['HKCU\\Software\\Classes\\StillURL', '', 'Still web link'],
    ['HKCU\\Software\\Classes\\StillURL', 'URL Protocol', ''],
    ['HKCU\\Software\\Classes\\StillURL\\DefaultIcon', '', `${executable},0`],
    ['HKCU\\Software\\Classes\\StillURL\\shell\\open\\command', '', command],
    ['HKCU\\Software\\Still\\Capabilities', 'ApplicationName', 'Still'],
    ['HKCU\\Software\\Still\\Capabilities', 'ApplicationDescription', 'A calm five-slot Chromium browser'],
    ['HKCU\\Software\\Still\\Capabilities', 'ApplicationIcon', `${executable},0`],
    ['HKCU\\Software\\Still\\Capabilities\\URLAssociations', 'http', progId],
    ['HKCU\\Software\\Still\\Capabilities\\URLAssociations', 'https', progId],
    ['HKCU\\Software\\Still\\Capabilities\\FileAssociations', '.htm', progId],
    ['HKCU\\Software\\Still\\Capabilities\\FileAssociations', '.html', progId],
    ['HKCU\\Software\\RegisteredApplications', 'Still', 'Software\\Still\\Capabilities']
  ];
  return entries.every(([key, name, value]) => {
    const args = ['add', key, name ? '/v' : '/ve'];
    if (name) args.push(name);
    args.push('/t', 'REG_SZ', '/d', value, '/f');
    return spawnSync('reg.exe', args, { windowsHide: true }).status === 0;
  });
}

async function openDefaultBrowserSettings() {
  if (process.platform === 'win32') {
    if (!registerStillBrowser()) return false;
    try {
      await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Still');
      return true;
    } catch {
      return false;
    }
  }

  if (!app.isPackaged) return false;
  return ['http', 'https'].every((protocol) => app.setAsDefaultProtocolClient(protocol));
}

module.exports = { openDefaultBrowserSettings, registerStillBrowser };
