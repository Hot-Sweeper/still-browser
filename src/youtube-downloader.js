const { app, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const VIDEO_QUALITIES = new Set(['best', '2160', '1440', '1080', '720', '480', '360']);
const AUDIO_FORMATS = new Set(['mp3', 'm4a']);
const THUMBNAIL_FORMATS = new Set(['jpg']);
const activeDownloads = new Map();
const COOKIE_DIRECTORY_PREFIX = 'still-ytdl-';

async function cleanupStaleCookieDirectories() {
  const temporaryRoot = path.resolve(app.getPath('temp'));
  const entries = await fs.promises.readdir(temporaryRoot, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !/^still-ytdl-[a-zA-Z0-9]{6}$/.test(entry.name)) return;
    const candidate = path.resolve(temporaryRoot, entry.name);
    if (path.dirname(candidate) !== temporaryRoot || path.basename(candidate) !== entry.name) return;
    if ((await fs.promises.lstat(candidate)).isSymbolicLink()) return;
    await fs.promises.rm(candidate, { recursive: true, force: true });
  }));
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) return '';
    if (url.pathname !== '/watch') return '';
    return url.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function binaryPath() {
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, binaryName)
    : path.join(__dirname, '..', 'build', 'vendor', binaryName);
  if (fs.existsSync(bundled)) return bundled;
  return executableOnPath(process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp']);
}

function executableOnPath(names, extraDirectories = []) {
  const directories = [
    ...String(process.env.PATH || '').split(path.delimiter),
    ...extraDirectories
  ].filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function ffmpegDirectory() {
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  const executable = executableOnPath(names, process.platform === 'win32' ? ['C:\\ffmpeg\\bin'] : []);
  return executable ? path.dirname(executable) : '';
}

function nodeRuntimePath() {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node', 'nodejs'];
  const extraDirectories = process.platform === 'win32' ? ['C:\\Program Files\\nodejs'] : [];
  return executableOnPath(names, extraDirectories);
}

function relevantDownloadCookie(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return ['youtube.com', 'google.com', 'googlevideo.com'].some((root) => (
    domain === root || domain.endsWith(`.${root}`)
  ));
}

function netscapeCookieLine(cookie) {
  const clean = (value) => String(value || '').replace(/[\t\r\n]/g, '');
  const rawDomain = clean(cookie.domain);
  const domain = cookie.httpOnly ? `#HttpOnly_${rawDomain}` : rawDomain;
  const includeSubdomains = rawDomain.startsWith('.') ? 'TRUE' : 'FALSE';
  const expiry = cookie.expirationDate ? Math.max(0, Math.floor(cookie.expirationDate)) : 0;
  return [
    domain,
    includeSubdomains,
    clean(cookie.path || '/'),
    cookie.secure ? 'TRUE' : 'FALSE',
    expiry,
    clean(cookie.name),
    clean(cookie.value)
  ].join('\t');
}

async function createCookieFile(browsingSession) {
  const directory = await fs.promises.mkdtemp(path.join(app.getPath('temp'), COOKIE_DIRECTORY_PREFIX));
  const cookiePath = path.join(directory, 'cookies.txt');
  const cookies = (await browsingSession.cookies.get({})).filter(relevantDownloadCookie);
  const contents = ['# Netscape HTTP Cookie File', ...cookies.map(netscapeCookieLine), ''].join('\n');
  await fs.promises.writeFile(cookiePath, contents, { encoding: 'utf8', mode: 0o600 });
  return { directory, cookiePath };
}

async function removeCookieFile(details) {
  if (!details) return;
  try { await fs.promises.unlink(details.cookiePath); } catch {}
  try { await fs.promises.rmdir(details.directory); } catch {}
}

function safeSend(webContents, payload) {
  if (webContents.isDestroyed()) return;
  webContents.send('youtube:download-progress', payload);
}

function videoArguments(quality) {
  const selector = quality === 'best'
    ? 'bv*+ba/b'
    : `bv*[height<=${quality}]+ba/b[height<=${quality}]`;
  return ['-f', selector, '--merge-output-format', 'mp4'];
}

function audioArguments(format) {
  return ['-x', '--audio-format', format, '--audio-quality', '0'];
}

function thumbnailArguments(format) {
  return ['--skip-download', '--write-thumbnail', '--convert-thumbnails', format];
}

function readableError(lines, code) {
  const useful = lines.map((line) => line.trim()).filter(Boolean);
  const lastError = [...useful].reverse().find((line) => /error:/i.test(line));
  if (/ffmpeg/i.test(lastError || '') && /not found|not installed/i.test(lastError || '')) {
    return 'FFmpeg is required to merge this download.';
  }
  return (lastError || useful.at(-1) || `Downloader exited with code ${code}`).replace(/^ERROR:\s*/i, '');
}

function safeFilename(value) {
  const cleaned = String(value || 'YouTube download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || 'YouTube download').slice(0, 150);
}

async function beginYouTubeDownload(browsingSession, downloadManager, sender, request = {}, senderFrameUrl = '') {
    const senderUrl = senderFrameUrl || sender.getURL();
    const senderVideoId = youtubeVideoId(senderUrl);
    const requestedVideoId = youtubeVideoId(request.url);
    if (!senderVideoId || senderVideoId !== requestedVideoId) throw new Error('Open a YouTube video before downloading.');

    const mode = request.mode === 'audio'
      ? 'audio'
      : request.mode === 'video'
        ? 'video'
        : request.mode === 'thumbnail'
          ? 'thumbnail'
          : '';
    const option = String(request.option || '');
    if (!mode
      || (mode === 'video' && !VIDEO_QUALITIES.has(option))
      || (mode === 'audio' && !AUDIO_FORMATS.has(option))
      || (mode === 'thumbnail' && !THUMBNAIL_FORMATS.has(option))) {
      throw new Error('That download format is not supported.');
    }

    const senderId = sender.id;
    if (activeDownloads.has(senderId)) throw new Error('A download from this slot is already running.');
    const executable = binaryPath();
    if (!executable) throw new Error('The Still downloader is missing. Run npm install again or install yt-dlp.');

    const extension = mode === 'audio' ? option : mode === 'thumbnail' ? option : 'mp4';
    const defaultName = mode === 'thumbnail'
      ? `${safeFilename(request.title)} thumbnail.${extension}`
      : `${safeFilename(request.title)}.${extension}`;
    const destination = await dialog.showSaveDialog({
      title: mode === 'audio'
        ? 'Save YouTube audio'
        : mode === 'thumbnail'
          ? 'Save YouTube thumbnail'
          : 'Save YouTube video',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{
        name: mode === 'audio'
          ? `${extension.toUpperCase()} audio`
          : mode === 'thumbnail'
            ? 'JPG image'
            : 'MP4 video',
        extensions: [extension]
      }]
    });
    if (destination.canceled || !destination.filePath) {
      safeSend(sender, { state: 'cancelled' });
      return { cancelled: true };
    }

    const jobId = crypto.randomUUID();
    const cookieDetails = await createCookieFile(browsingSession);
    const savePath = destination.filePath.toLowerCase().endsWith(`.${extension}`)
      ? destination.filePath
      : `${destination.filePath}.${extension}`;
    const outputPath = mode === 'thumbnail'
      ? savePath.slice(0, -(extension.length + 1))
      : savePath;
    const downloadDirectory = path.dirname(savePath);
    const args = [
      '--no-config',
      '--no-playlist',
      '--newline',
      '--no-color',
      '--progress',
      '--progress-template', 'download:still-progress:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
      '--print', 'after_move:still-file:%(filepath)s',
      '--trim-filenames', '180',
      '-o', outputPath,
      '--cookies', cookieDetails.cookiePath
    ];
    if (process.platform === 'win32') args.splice(args.indexOf('--trim-filenames'), 0, '--windows-filenames');
    const ffmpeg = ffmpegDirectory();
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
    const nodeRuntime = nodeRuntimePath();
    if (nodeRuntime) args.push('--js-runtimes', `node:${nodeRuntime}`);
    args.push(...(
      mode === 'video'
        ? videoArguments(option)
        : mode === 'audio'
          ? audioArguments(option)
          : thumbnailArguments(option)
    ), '--', request.url);
    safeSend(sender, { jobId, state: 'starting', downloadDirectory });

    let finalized = false;
    let cancelRequested = false;
    downloadManager?.registerExternal({
      id: jobId,
      name: path.basename(savePath),
      url: request.url,
      savePath,
      state: 'progressing',
      source: 'youtube'
    }, {
      cancel() {
        cancelRequested = true;
        activeDownloads.get(senderId)?.child?.kill();
      }
    });
    const finish = async (payload) => {
      if (finalized) return;
      finalized = true;
      activeDownloads.delete(senderId);
      await removeCookieFile(cookieDetails);
      if (payload.state === 'complete') {
        const completedPath = payload.file || savePath;
        let completedBytes = 0;
        try { completedBytes = (await fs.promises.stat(completedPath)).size; } catch {}
        downloadManager?.finishExternal(jobId, {
          state: 'completed',
          savePath: completedPath,
          receivedBytes: completedBytes,
          totalBytes: completedBytes
        });
      } else if (payload.state === 'cancelled') {
        downloadManager?.finishExternal(jobId, { state: 'cancelled' });
      } else {
        downloadManager?.finishExternal(jobId, { state: 'interrupted', error: payload.message || '' });
      }
      safeSend(sender, { jobId, ...payload });
    };

    const withoutCookies = (values) => values.filter((value, index) => (
      value !== '--cookies' && values[index - 1] !== '--cookies'
    ));

    const launchAttempt = (attemptArgs, canRetryWithoutCookies) => {
      const child = spawn(executable, attemptArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeDownloads.set(senderId, { jobId, child });
      let savedFile = '';
      let attemptFailedToStart = false;
      const errorLines = [];
      const stdout = readline.createInterface({ input: child.stdout });
      const stderr = readline.createInterface({ input: child.stderr });
      stdout.on('line', (line) => {
        if (line.startsWith('still-progress:')) {
          const [percent = '', speed = '', eta = '', downloaded = '', total = '', estimate = ''] = line
            .slice(15).split('|').map((value) => value.trim());
          const receivedBytes = Number(downloaded) || 0;
          const totalBytes = Number(total) || Number(estimate) || 0;
          downloadManager?.updateExternal(jobId, { state: 'progressing', receivedBytes, totalBytes });
          safeSend(sender, { jobId, state: 'downloading', percent, speed, eta });
        } else if (line.startsWith('still-file:')) {
          savedFile = line.slice(11).trim();
        }
      });
      stderr.on('line', (line) => {
        errorLines.push(line);
        if (errorLines.length > 30) errorLines.shift();
      });

      child.once('error', (error) => {
        attemptFailedToStart = true;
        finish({ state: 'error', message: error.message });
      });
      child.once('exit', (code) => {
        stdout.close();
        stderr.close();
        if (attemptFailedToStart || finalized) return;
        if (cancelRequested) {
          finish({ state: 'cancelled' });
          return;
        }
        if (code === 0) {
          finish({ state: 'complete', file: savedFile || savePath, downloadDirectory });
          return;
        }
        const message = readableError(errorLines, code);
        if (canRetryWithoutCookies && /requested format is not available/i.test(message)) {
          downloadManager?.updateExternal(jobId, { state: 'recovering' });
          safeSend(sender, { jobId, state: 'starting', downloadDirectory, retrying: true });
          launchAttempt(withoutCookies(attemptArgs), false);
          return;
        }
        finish({ state: 'error', message });
      });
    };

    launchAttempt(args, true);

    return { jobId, downloadDirectory };
}

function registerYouTubeDownloader(browsingSession, downloadManager) {
  // A forced shutdown can occur before the normal finally path removes the
  // short-lived cookie export. Clear only Still-owned temp directories next run.
  cleanupStaleCookieDirectories().catch(() => {});
  ipcMain.handle('youtube:download-start', (event, request = {}) => {
    return beginYouTubeDownload(browsingSession, downloadManager, event.sender, request, event.senderFrame?.url || '');
  });
}

module.exports = { registerYouTubeDownloader };
