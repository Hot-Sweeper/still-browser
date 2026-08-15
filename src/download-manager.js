const { shell } = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function createDownloadManager({ browsingSession, userDataPath, getWindow }) {
  const statePath = path.join(userDataPath, 'still-downloads.json');
  const activeItems = new Map();
  const externalItems = new Map();
  const recoveryTimers = new Map();
  let emitTimer;
  let records = loadRecords(statePath);

  function publicRecords() {
    return records.slice(0, 80).map(({ autoRetries, ...record }) => ({ ...record }));
  }

  function persist() {
    try {
      writeFileSync(statePath, JSON.stringify(records.slice(0, 200)), 'utf8');
    } catch {}
  }

  function emit(immediate = false) {
    clearTimeout(emitTimer);
    const send = () => {
      emitTimer = undefined;
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('downloads:changed', publicRecords());
    };
    if (immediate) send();
    else emitTimer = setTimeout(send, 120);
  }

  function updateFromItem(record, item, state = '') {
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes();
    record.savePath = item.getSavePath() || record.savePath || '';
    record.updatedAt = Date.now();
    if (state === 'progressing') record.state = item.isPaused() ? 'paused' : 'progressing';
    if (state === 'interrupted') record.state = 'recovering';
  }

  function scheduleRecovery(record, item) {
    if (record.manualPaused || !item.canResume() || record.autoRetries >= 10) return;
    clearTimeout(recoveryTimers.get(record.id));
    const delay = Math.min(6000, 300 * (2 ** record.autoRetries));
    record.autoRetries += 1;
    record.state = 'recovering';
    const timer = setTimeout(() => {
      recoveryTimers.delete(record.id);
      if (record.manualPaused || !activeItems.has(record.id) || !item.canResume()) return;
      try {
        item.resume();
        record.state = 'progressing';
        emit();
      } catch {}
    }, delay);
    recoveryTimers.set(record.id, timer);
  }

  browsingSession.on('will-download', (_event, item) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      name: item.getFilename(),
      url: item.getURL(),
      savePath: '',
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      state: 'progressing',
      manualPaused: false,
      autoRetries: 0,
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    records.unshift(record);
    records = records.slice(0, 200);
    activeItems.set(id, item);
    item.setSaveDialogOptions({
      title: 'Save download',
      defaultPath: path.join(require('electron').app.getPath('downloads'), item.getFilename())
    });
    persist();
    emit(true);

    item.on('updated', (_updatedEvent, state) => {
      updateFromItem(record, item, state);
      if (state === 'interrupted') scheduleRecovery(record, item);
      persist();
      emit();
    });

    item.once('done', (_doneEvent, state) => {
      clearTimeout(recoveryTimers.get(id));
      recoveryTimers.delete(id);
      updateFromItem(record, item);
      activeItems.delete(id);
      record.state = state === 'completed' ? 'completed' : state;
      record.updatedAt = Date.now();
      persist();
      emit(true);
    });
  });

  function registerExternal(details, controller = {}) {
    const id = String(details.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const record = {
      id,
      name: details.name || 'Download',
      url: details.url || '',
      savePath: details.savePath || '',
      totalBytes: Number(details.totalBytes || 0),
      receivedBytes: Number(details.receivedBytes || 0),
      state: details.state || 'progressing',
      source: details.source || 'external',
      manualPaused: false,
      autoRetries: 0,
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    records = [record, ...records.filter((entry) => entry.id !== id)].slice(0, 200);
    externalItems.set(id, controller);
    persist();
    emit(true);
    return id;
  }

  function updateExternal(id, updates = {}) {
    const record = records.find((entry) => entry.id === id);
    if (!record) return;
    for (const key of ['name', 'savePath', 'totalBytes', 'receivedBytes', 'state', 'error']) {
      if (updates[key] !== undefined) record[key] = updates[key];
    }
    record.updatedAt = Date.now();
    persist();
    emit(Boolean(updates.immediate));
  }

  function finishExternal(id, updates = {}) {
    externalItems.delete(id);
    updateExternal(id, { ...updates, immediate: true });
  }

  async function action(id, action) {
    if (action === 'folder') return shell.openPath(require('electron').app.getPath('downloads'));
    const record = records.find((entry) => entry.id === id);
    if (!record) return 'Download not found.';
    const item = activeItems.get(id);
    const external = externalItems.get(id);
    try {
      if (action === 'cancel' && external?.cancel) {
        external.cancel();
        record.state = 'cancelled';
        externalItems.delete(id);
      } else if (action === 'pause' && item) {
        record.manualPaused = true;
        item.pause();
        record.state = 'paused';
      } else if (action === 'resume' && item && item.canResume()) {
        record.manualPaused = false;
        item.resume();
        record.state = 'progressing';
      } else if (action === 'cancel' && item) {
        record.manualPaused = true;
        item.cancel();
      } else if (action === 'retry' && record.url) {
        browsingSession.downloadURL(record.url);
      } else if (action === 'open' && record.savePath && existsSync(record.savePath)) {
        return shell.openPath(record.savePath);
      } else if (action === 'show' && record.savePath && existsSync(record.savePath)) {
        shell.showItemInFolder(record.savePath);
      } else {
        return 'That action is not available for this download.';
      }
      record.updatedAt = Date.now();
      persist();
      emit(true);
      return '';
    } catch (error) {
      return error.message;
    }
  }

  return { list: publicRecords, action, registerExternal, updateExternal, finishExternal };
}

function loadRecords(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((record) => ({
      ...record,
      state: ['progressing', 'paused', 'recovering'].includes(record.state) ? 'interrupted' : record.state,
      manualPaused: false,
      autoRetries: 0
    }));
  } catch {
    return [];
  }
}

module.exports = { createDownloadManager };
