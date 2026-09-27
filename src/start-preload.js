const { contextBridge, ipcRenderer } = require('electron');

// Track actual capture/location activity in the page's main world. Permission
// decisions stay in the main process; this bridge only powers Still's visible
// "in use" indicator and never exposes device data.
const activityFrameId = crypto.randomUUID();
const activityChannel = `still-permission-activity-${crypto.randomUUID()}`;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.channel !== activityChannel) return;
  ipcRenderer.send('permissions:activity', {
    frameId: activityFrameId,
    origin: event.data.origin,
    microphone: Boolean(event.data.microphone),
    camera: Boolean(event.data.camera),
    location: Boolean(event.data.location)
  });
});

try {
  contextBridge.executeInMainWorld({
    args: [activityChannel],
    func: (channel) => {
      if (window.__stillPermissionActivityInstalled) return;
      Object.defineProperty(window, '__stillPermissionActivityInstalled', { value: true });

      const activeTracks = new Map();
      const activeLocationWatches = new Set();
      let activeLocationRequests = 0;

      const publish = () => {
        for (const [track] of activeTracks) {
          if (track.readyState === 'ended') activeTracks.delete(track);
        }
        window.postMessage({
          channel,
          origin: location.origin,
          microphone: [...activeTracks.values()].includes('audio'),
          camera: [...activeTracks.values()].includes('video'),
          location: activeLocationRequests > 0 || activeLocationWatches.size > 0
        }, '*');
      };

      const mediaDevices = navigator.mediaDevices;
      if (mediaDevices?.getUserMedia) {
        const nativeGetUserMedia = mediaDevices.getUserMedia;
        mediaDevices.getUserMedia = function (...args) {
          return Reflect.apply(nativeGetUserMedia, this, args).then((stream) => {
            stream.getTracks().forEach((track) => {
              activeTracks.set(track, track.kind);
              track.addEventListener('ended', () => {
                activeTracks.delete(track);
                publish();
              }, { once: true });
              try {
                const nativeStop = track.stop.bind(track);
                track.stop = () => {
                  nativeStop();
                  activeTracks.delete(track);
                  publish();
                };
              } catch { }
            });
            publish();
            return stream;
          });
        };
      }

      const geolocation = navigator.geolocation;
      if (geolocation) {
        const nativeGetCurrentPosition = geolocation.getCurrentPosition.bind(geolocation);
        const nativeWatchPosition = geolocation.watchPosition.bind(geolocation);
        const nativeClearWatch = geolocation.clearWatch.bind(geolocation);

        geolocation.getCurrentPosition = (success, error, options) => {
          activeLocationRequests++;
          publish();
          let finished = false;
          const finish = (callback) => (...callbackArgs) => {
            if (!finished) {
              finished = true;
              activeLocationRequests = Math.max(0, activeLocationRequests - 1);
              publish();
            }
            if (typeof callback === 'function') callback(...callbackArgs);
          };
          try {
            return nativeGetCurrentPosition(finish(success), finish(error), options);
          } catch (errorThrown) {
            finish()();
            throw errorThrown;
          }
        };

        geolocation.watchPosition = (success, error, options) => {
          const watchId = nativeWatchPosition(success, error, options);
          activeLocationWatches.add(watchId);
          publish();
          return watchId;
        };

        geolocation.clearWatch = (watchId) => {
          activeLocationWatches.delete(watchId);
          nativeClearWatch(watchId);
          publish();
        };
      }

      window.addEventListener('pagehide', () => {
        activeTracks.clear();
        activeLocationWatches.clear();
        activeLocationRequests = 0;
        publish();
      }, { once: true });
      publish();
    }
  });
} catch { }

// Match the Sec-GPC request header set by the session so feature detection and
// network privacy signals cannot disagree.
try {
  contextBridge.executeInMainWorld({
    func: () => {
      try {
        Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
          configurable: true,
          enumerable: true,
          get: () => true
        });
      } catch { }
    }
  });
} catch { }

const isStillStartPage = location.protocol === 'file:' && location.pathname.endsWith('/start.html');
const isStillLearnPage = location.protocol === 'file:' && location.pathname.endsWith('/learn.html');

if (isStillStartPage) {
  contextBridge.exposeInMainWorld('stillStart', {
    suggestions: (query) => ipcRenderer.invoke('start:suggestions', query),
    searchBaseUrl: () => ipcRenderer.invoke('search:base-url')
  });
}

if (isStillLearnPage) {
  contextBridge.exposeInMainWorld('stillLearn', {
    catalog: () => ipcRenderer.invoke('learn:catalog'),
    discover: (force = false) => ipcRenderer.invoke('learn:discover', force === true),
    selection: () => ipcRenderer.invoke('learn:selection'),
    setSelection: (channelIds) => ipcRenderer.invoke('learn:selection-set', channelIds),
    feed: (channelIds) => ipcRenderer.invoke('learn:feed', channelIds)
  });
}

const isYouTubePage = /(^|\.)youtube\.com$/i.test(location.hostname);

if (isYouTubePage) {
  function dispatchProgress(detail) {
    window.dispatchEvent(new CustomEvent('still-download-progress', { detail }));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'still-open-learn') {
      ipcRenderer.send('learn:open');
      return;
    }
    if (event.data?.type !== 'still-youtube-download') return;
    ipcRenderer.invoke('youtube:download-start', {
      url: location.href,
      title: document.title.replace(/\s*-\s*YouTube\s*$/i, ''),
      mode: event.data.mode,
      option: event.data.option
    }).catch((error) => dispatchProgress({
      state: 'error',
      message: String(error.message || error).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    }));
  });

  ipcRenderer.on('youtube:download-progress', (_event, detail) => dispatchProgress(detail));
}
