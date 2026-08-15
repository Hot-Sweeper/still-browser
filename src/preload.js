const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusSlots', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  windowAction: (action) => ipcRenderer.send('window:action', action),
  setActiveGuest: (guestId) => ipcRenderer.send('slot:active-guest', guestId),
  setSuggestionHistory: (entries) => ipcRenderer.send('history:suggestions', entries),
  downloadAction: (id, action) => ipcRenderer.invoke('downloads:action', id, action),
  getSitePermissions: (url) => ipcRenderer.invoke('permissions:get', url),
  resetSitePermission: (url, kind) => ipcRenderer.invoke('permissions:reset', url, kind),
  respondPermission: (id, decision) => ipcRenderer.send('permissions:respond', id, decision),
  prepareFavicon: (source) => ipcRenderer.invoke('favicon:prepare', source),
  storeFavicon: (source, dataUrl) => ipcRenderer.invoke('favicon:store', source, dataUrl),
  openDefaultBrowserSettings: () => ipcRenderer.invoke('browser:default-settings'),
  onNewWindow: (callback) => {
    const handler = (_event, details) => callback(details);
    ipcRenderer.on('slot:new-window', handler);
    return () => ipcRenderer.removeListener('slot:new-window', handler);
  },
  onMiddleClick: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('slot:middle-click', handler);
    return () => ipcRenderer.removeListener('slot:middle-click', handler);
  },
  onShortcut: (callback) => {
    const handler = (_event, shortcut) => callback(shortcut);
    ipcRenderer.on('app:shortcut', handler);
    return () => ipcRenderer.removeListener('app:shortcut', handler);
  },
  onChromeShow: (callback) => {
    const handler = (_event, cursorRatio) => callback(cursorRatio);
    ipcRenderer.on('chrome:show', handler);
    return () => ipcRenderer.removeListener('chrome:show', handler);
  },
  onChromeHide: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('chrome:hide', handler);
    return () => ipcRenderer.removeListener('chrome:hide', handler);
  },
  onDownloadsChanged: (callback) => {
    const handler = (_event, downloads) => callback(downloads);
    ipcRenderer.on('downloads:changed', handler);
    return () => ipcRenderer.removeListener('downloads:changed', handler);
  },
  onPermissionRequest: (callback) => {
    const handler = (_event, request) => callback(request);
    ipcRenderer.on('permissions:request', handler);
    return () => ipcRenderer.removeListener('permissions:request', handler);
  },
  onPermissionChanged: (callback) => {
    const handler = (_event, details) => callback(details);
    ipcRenderer.on('permissions:changed', handler);
    return () => ipcRenderer.removeListener('permissions:changed', handler);
  },
  onPermissionActivity: (callback) => {
    const handler = (_event, details) => callback(details);
    ipcRenderer.on('permissions:activity', handler);
    return () => ipcRenderer.removeListener('permissions:activity', handler);
  },
  onOpenUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('app:open-url', handler);
    return () => ipcRenderer.removeListener('app:open-url', handler);
  }
});
