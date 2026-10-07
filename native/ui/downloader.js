/* Explicit chrome-only media downloads; no injected webpage controls. */
(function () {
  'use strict';
  const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
  let process = null;
  let cancelled = false;
  const currentVideo = () => {
    try {
      const url = new URL(gBrowser.selectedBrowser.currentURI.spec);
      if (!['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname)) return '';
      if (url.hostname === 'youtu.be') return /^\/[\w-]{11}$/.test(url.pathname) ? url.href : '';
      return (url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') || '')) ? url.href : '';
    } catch { return ''; }
  };
  async function download(mode) {
    if (process) { window.StillBrowser.toast('A media download is already running.'); return; }
    const url = currentVideo();
    if (!url) { window.StillBrowser.toast('Open a YouTube video in this slot first.'); return; }
    if (!['video','audio','thumbnail'].includes(mode)) return;
    const file = Services.dirsvc.get('GreD', Ci.nsIFile); file.append('still'); file.append('yt-dlp');
    if (!file.exists()) { window.StillBrowser.toast('The bundled media downloader is missing. Rebuild Still.'); return; }
    const extension = { video:'mp4', audio:'mp3', thumbnail:'jpg' }[mode];
    const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
    picker.init(window.browsingContext, 'Save YouTube ' + mode, Ci.nsIFilePicker.modeSave);
    picker.defaultString = (gBrowser.selectedTab.label || 'YouTube').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0,140) + '.' + extension;
    picker.defaultExtension = extension;
    picker.appendFilter(extension.toUpperCase() + ' file', '*.' + extension);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result === Ci.nsIFilePicker.returnCancel || !picker.file) return;
    const target = picker.file.path;
    const args = ['--no-playlist','--newline','--no-overwrites','--js-runtimes','node','--progress-template','download:%(progress._percent_str)s', '-o', target];
    if (mode === 'video') args.push('-f','bv*+ba/b','--merge-output-format','mp4');
    if (mode === 'audio') args.push('-x','--audio-format','mp3','--audio-quality','0');
    if (mode === 'thumbnail') args.push('--skip-download','--write-thumbnail','--convert-thumbnails','jpg');
    // Read cookies directly from Still's own native profile only when the user
    // explicitly starts a download. Never copy account cookies between engines.
    args.push('--cookies-from-browser','firefox:' + PathUtils.profileDir,'--',url);
    cancelled = false;
    try {
      process = await Subprocess.call({ command:file.path, arguments:args, stderr:'stdout' });
      window.StillBrowser.toast('Starting media download…');
      let tail = '', lastUpdate = 0;
      while (true) {
        const chunk = await process.stdout.readString();
        if (!chunk) break;
        tail = (tail + chunk).slice(-4000);
        const percent = chunk.match(/download:\s*([\d.]+%)/g)?.at(-1);
        if (percent && performance.now() - lastUpdate > 500) {
          window.StillBrowser.toast('Downloading ' + percent.replace('download:','').trim()); lastUpdate = performance.now();
        }
      }
      const result = await process.wait();
      if (cancelled) window.StillBrowser.toast('Media download cancelled.');
      else if (result.exitCode === 0) window.StillBrowser.toast('Saved media to your chosen folder.');
      else {
        const error = tail.split('\n').reverse().find(line => /^ERROR:/.test(line));
        window.StillBrowser.toast(error?.slice(0,180) || 'Media download failed. FFmpeg may be required.');
      }
    } catch (error) { window.StillBrowser.toast('Media download: ' + error.message); }
    finally { process = null; }
  }
  window.StillDownloader = {
    download,
    cancel() { cancelled = true; process?.kill(); },
    get active() { return Boolean(process); }
  };
})();
