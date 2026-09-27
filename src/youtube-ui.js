(() => {
  const UI_VERSION = 31;
  if (window.__stillDownloadUi?.version === UI_VERSION && window.__stillDownloadUi?.mount) {
    window.__stillDownloadUi.mount();
    return;
  }

  // YouTube keeps the same document alive while navigating. Remove an older
  // injected control so visual updates never get stuck behind that cached UI.
  try { window.__stillDownloadUi?.destroy?.(); } catch {}
  document.querySelector('#still-youtube-download-host')?.remove();
  document.querySelector('#still-youtube-saturation-host')?.remove();

  let currentUi = null;
  let busy = false;
  let mountTimer;
  let mountObserver;
  let tooltipTimer;
  let tooltipHideTimer;
  let cornerHome = null;
  let playerLab = null;
  let edgeMirrorTimer = 0;
  let edgeMirrorFrameVideo = null;
  let edgeMirrorFrameHandle = 0;
  let edgeMirrorLastState = '';
  let edgeMirrorLastVideo = null;
  const PLAYER_LAB_STORAGE_KEY = 'still-youtube-player-lab-v1';
  const PLAYER_LAB_DEFAULTS = {
    height: 94,
    mirror: true,
    edgeFill: 'mirror',
    strength: 100,
    brightness: 100,
    fade: false,
    fadeCurve: 'soft',
    softness: 0
  };
  let playerLabSettings = loadPlayerLabSettings();
  let mutedColors = false;
  try { mutedColors = localStorage.getItem('still-youtube-muted-colors') === 'true'; } catch {}

  function isWatchPage() {
    const url = new URL(location.href);
    return url.pathname === '/watch' && Boolean(url.searchParams.get('v'));
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }

  function loadPlayerLabSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(PLAYER_LAB_STORAGE_KEY) || '{}');
      return {
        height: clamp(saved.height, 82, 99.5, PLAYER_LAB_DEFAULTS.height),
        mirror: saved.mirror !== false,
        edgeFill: ['mirror', 'zoom'].includes(saved.edgeFill)
          ? saved.edgeFill : PLAYER_LAB_DEFAULTS.edgeFill,
        strength: clamp(saved.strength, 0, 100, PLAYER_LAB_DEFAULTS.strength),
        brightness: clamp(saved.brightness, 0, 100, PLAYER_LAB_DEFAULTS.brightness),
        fade: saved.fade === true,
        fadeCurve: ['soft', 'late', 'linear', 'early'].includes(saved.fadeCurve)
          ? saved.fadeCurve : PLAYER_LAB_DEFAULTS.fadeCurve,
        softness: clamp(saved.softness, 0, 24, PLAYER_LAB_DEFAULTS.softness)
      };
    } catch {
      return { ...PLAYER_LAB_DEFAULTS };
    }
  }

  function savePlayerLabSettings() {
    try { localStorage.setItem(PLAYER_LAB_STORAGE_KEY, JSON.stringify(playerLabSettings)); } catch {}
  }

  function applyPlayerLabSettings() {
    document.documentElement.style.setProperty(
      '--still-player-lab-height',
      `${playerLabSettings.height}vh`,
      'important'
    );
    if (!playerLab) return;
    const { controls } = playerLab;
    controls.height.value = String(playerLabSettings.height);
    controls.heightValue.textContent = `${playerLabSettings.height.toFixed(2).replace(/\.?0+$/, '')} vh`;
    controls.mirror.checked = playerLabSettings.mirror;
    controls.edgeFill.value = playerLabSettings.edgeFill;
    controls.edgeFill.disabled = !playerLabSettings.mirror;
    controls.mutedColors.checked = mutedColors;
    controls.strength.value = String(playerLabSettings.strength);
    controls.strengthValue.textContent = `${Math.round(playerLabSettings.strength)}%`;
    controls.brightness.value = String(playerLabSettings.brightness);
    controls.brightnessValue.textContent = `${Math.round(playerLabSettings.brightness)}%`;
    controls.fade.checked = playerLabSettings.fade;
    controls.fadeCurve.value = playerLabSettings.fadeCurve;
    controls.fadeCurve.disabled = !playerLabSettings.fade;
    controls.fadeCurvePreview.setAttribute('points', Array.from({ length: 21 }, (_, index) => {
      const x = index * 2.2;
      return `${x.toFixed(1)},${(20 - fadeAmount(index / 20) * 20).toFixed(1)}`;
    }).join(' '));
    controls.softness.value = String(playerLabSettings.softness);
    controls.softnessValue.textContent = `${playerLabSettings.softness.toFixed(1).replace(/\.0$/, '')} px`;
  }

  function stopEdgeMirror() {
    if (edgeMirrorTimer) clearTimeout(edgeMirrorTimer);
    if (edgeMirrorFrameVideo && edgeMirrorFrameHandle) {
      try { edgeMirrorFrameVideo.cancelVideoFrameCallback(edgeMirrorFrameHandle); } catch {}
    }
    edgeMirrorTimer = 0;
    edgeMirrorFrameVideo = null;
    edgeMirrorFrameHandle = 0;
    edgeMirrorLastState = '';
    edgeMirrorLastVideo = null;
    document.querySelector('#still-youtube-edge-mirror')?.remove();
  }

  function ensureEdgeMirrorCanvas(player) {
    let canvas = player.querySelector(':scope > #still-youtube-edge-mirror');
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'still-youtube-edge-mirror';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'pointer-events:none',
      'z-index:1',
      'background:transparent',
      'contain:strict'
    ].join(';');
    player.prepend(canvas);
    return canvas;
  }

  function fadeAmount(distance) {
    const t = Math.max(0, Math.min(1, distance));
    switch (playerLabSettings.fadeCurve) {
      case 'late': return t * t * t * t;
      case 'linear': return t;
      case 'early': return Math.sqrt(t);
      default: return t * t;
    }
  }

  function fillEdgeFade(context, x0, y0, x1, y1, rect, outerAtStart) {
    if (rect.width < 0.5 || rect.height < 0.5) return;
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    for (let step = 0; step <= 32; step += 1) {
      const position = step / 32;
      const distance = outerAtStart ? 1 - position : position;
      gradient.addColorStop(position, `rgba(0,0,0,${fadeAmount(distance).toFixed(4)})`);
    }
    context.fillStyle = gradient;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  function fitVideoToStage(player, video) {
    if (player.classList.contains('ytp-fullscreen') || document.fullscreenElement
        || !video.videoWidth || !video.videoHeight) return;
    const stage = player.getBoundingClientRect();
    const parent = video.offsetParent?.getBoundingClientRect();
    if (!parent || stage.width < 2 || stage.height < 2) return;
    const ratio = video.videoWidth / video.videoHeight;
    const width = Math.min(stage.width, stage.height * ratio);
    const height = width / ratio;
    const values = {
      '--still-video-left': `${(stage.left - parent.left + (stage.width - width) / 2).toFixed(2)}px`,
      '--still-video-top': `${(stage.top - parent.top + (stage.height - height) / 2).toFixed(2)}px`,
      '--still-video-width': `${width.toFixed(2)}px`,
      '--still-video-height': `${height.toFixed(2)}px`,
      '--still-video-fit': 'fill'
    };
    for (const [name, value] of Object.entries(values)) {
      if (video.style.getPropertyValue(name) !== value) video.style.setProperty(name, value);
    }
  }

  function displayedVideoRect(video) {
    const elementRect = video.getBoundingClientRect();
    const intrinsicRatio = video.videoWidth / video.videoHeight;
    const elementRatio = elementRect.width / elementRect.height;
    const fit = getComputedStyle(video).objectFit;
    if (!Number.isFinite(intrinsicRatio) || !Number.isFinite(elementRatio)
        || !elementRect.width || !elementRect.height
        || fit === 'cover' || fit === 'fill') return elementRect;

    // getBoundingClientRect() includes the black bars *inside* a video whose
    // object-fit is contain. Measure the picture itself so those bars become
    // gutters for the edge canvas too.
    let width = elementRect.width;
    let height = elementRect.height;
    if (intrinsicRatio > elementRatio) height = width / intrinsicRatio;
    else width = height * intrinsicRatio;
    return {
      left: elementRect.left + (elementRect.width - width) / 2,
      top: elementRect.top + (elementRect.height - height) / 2,
      right: elementRect.left + (elementRect.width + width) / 2,
      bottom: elementRect.top + (elementRect.height + height) / 2
    };
  }

  function paintEdgeMirror(frame = null) {
    if (!isWatchPage() || document.hidden) return;
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video.html5-main-video, video');
    if (!player || !video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
    fitVideoToStage(player, video);
    if (video !== edgeMirrorLastVideo) {
      edgeMirrorLastVideo = video;
      edgeMirrorLastState = '';
    }
    const canvas = ensureEdgeMirrorCanvas(player);
    const width = player.clientWidth;
    const height = player.clientHeight;
    if (width < 2 || height < 2) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, playerLabSettings.softness ? 1 : 1.5);
    const bitmapWidth = Math.max(1, Math.round(width * pixelRatio));
    const bitmapHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const playerRect = player.getBoundingClientRect();
    const videoRect = displayedVideoRect(video);
    const left = Math.max(0, Math.min(width, videoRect.left - playerRect.left));
    const top = Math.max(0, Math.min(height, videoRect.top - playerRect.top));
    const right = Math.max(left, Math.min(width, videoRect.right - playerRect.left));
    const bottom = Math.max(top, Math.min(height, videoRect.bottom - playerRect.top));
    const contentWidth = right - left;
    const contentHeight = bottom - top;
    const renderState = [
      frame?.presentedFrames ?? video.currentTime.toFixed(3), width, height, bitmapWidth, bitmapHeight,
      video.videoWidth, video.videoHeight, left.toFixed(2), top.toFixed(2),
      right.toFixed(2), bottom.toFixed(2),
      playerLabSettings.mirror, playerLabSettings.edgeFill, playerLabSettings.strength,
      playerLabSettings.brightness, playerLabSettings.fade, playerLabSettings.fadeCurve,
      playerLabSettings.softness, mutedColors
    ].join('|');
    if (renderState === edgeMirrorLastState) return;
    edgeMirrorLastState = renderState;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.globalAlpha = 1;
    context.filter = 'none';
    context.clearRect(0, 0, width, height);
    if (!playerLabSettings.mirror || playerLabSettings.strength <= 0) return;

    if (contentWidth < 1 || contentHeight < 1) return;
    const leftGap = left;
    const rightGap = width - right;
    const topGap = top;
    const bottomGap = height - bottom;
    if (Math.max(leftGap, rightGap, topGap, bottomGap) < 0.5) return;

    const leftSourceWidth = Math.min(video.videoWidth / 2, leftGap * video.videoWidth / contentWidth);
    const rightSourceWidth = Math.min(video.videoWidth / 2, rightGap * video.videoWidth / contentWidth);
    const topSourceHeight = Math.min(video.videoHeight / 2, topGap * video.videoHeight / contentHeight);
    const bottomSourceHeight = Math.min(video.videoHeight / 2, bottomGap * video.videoHeight / contentHeight);
    const toneParts = [`brightness(${playerLabSettings.brightness / 100})`];
    if (mutedColors) toneParts.push('saturate(.28)', 'contrast(1.04)', 'brightness(.97)');
    const toneFilter = toneParts.join(' ');
    const mirrorFilter = playerLabSettings.softness > 0
      ? `blur(${playerLabSettings.softness}px) ${toneFilter}` : toneFilter;
    const coverBlur = playerLabSettings.edgeFill === 'zoom'
      ? playerLabSettings.softness : Math.max(12, playerLabSettings.softness);
    const coverFilter = coverBlur > 0 ? `blur(${coverBlur}px) ${toneFilter}` : toneFilter;

    try {
      // A proportional cover pass fills every gutter without stretching.
      // Mirror mode overlays edge slices; Zoom mode leaves this full frame.
      const padding = Math.max(36, Math.ceil(playerLabSettings.softness * 4));
      const coverWidth = width + padding * 2;
      const coverHeight = height + padding * 2;
      const coverRatio = coverWidth / coverHeight;
      let sourceWidth = video.videoWidth;
      let sourceHeight = video.videoHeight;
      if (sourceWidth / sourceHeight > coverRatio) sourceWidth = sourceHeight * coverRatio;
      else sourceHeight = sourceWidth / coverRatio;
      const sourceX = (video.videoWidth - sourceWidth) / 2;
      const sourceY = (video.videoHeight - sourceHeight) / 2;
      context.save();
      context.beginPath();
      context.rect(0, 0, width, height);
      context.rect(left + .5, top + .5, Math.max(0, contentWidth - 1), Math.max(0, contentHeight - 1));
      context.clip('evenodd');
      context.globalAlpha = playerLabSettings.strength / 100;
      context.filter = coverFilter;
      context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight,
        -padding, -padding, coverWidth, coverHeight);
      context.restore();

      if (playerLabSettings.edgeFill === 'mirror' && leftGap >= 0.5 && leftSourceWidth > 0) {
        context.save();
        context.beginPath();
        context.rect(0, top, Math.ceil(leftGap), contentHeight);
        context.clip();
        context.globalAlpha = playerLabSettings.strength / 100;
        context.filter = mirrorFilter;
        context.translate(left * 2, 0);
        context.scale(-1, 1);
        context.drawImage(
          video,
          0, 0, leftSourceWidth, video.videoHeight,
          left, top, leftGap, contentHeight
        );
        context.restore();
      }
      if (playerLabSettings.edgeFill === 'mirror' && rightGap >= 0.5 && rightSourceWidth > 0) {
        context.save();
        context.beginPath();
        context.rect(Math.floor(right), top, Math.ceil(rightGap), contentHeight);
        context.clip();
        context.globalAlpha = playerLabSettings.strength / 100;
        context.filter = mirrorFilter;
        context.translate(right * 2, 0);
        context.scale(-1, 1);
        context.drawImage(
          video,
          video.videoWidth - rightSourceWidth, 0, rightSourceWidth, video.videoHeight,
          right - rightGap, top, rightGap, contentHeight
        );
        context.restore();
      }
      if (playerLabSettings.edgeFill === 'mirror' && topGap >= 0.5 && topSourceHeight > 0) {
        context.save();
        context.beginPath();
        context.rect(left, 0, contentWidth, Math.ceil(topGap));
        context.clip();
        context.globalAlpha = playerLabSettings.strength / 100;
        context.filter = mirrorFilter;
        context.translate(0, top * 2);
        context.scale(1, -1);
        context.drawImage(video, 0, 0, video.videoWidth, topSourceHeight,
          left, top, contentWidth, topGap);
        context.restore();
      }
      if (playerLabSettings.edgeFill === 'mirror' && bottomGap >= 0.5 && bottomSourceHeight > 0) {
        context.save();
        context.beginPath();
        context.rect(left, Math.floor(bottom), contentWidth, Math.ceil(bottomGap));
        context.clip();
        context.globalAlpha = playerLabSettings.strength / 100;
        context.filter = mirrorFilter;
        context.translate(0, bottom * 2);
        context.scale(1, -1);
        context.drawImage(video, 0, video.videoHeight - bottomSourceHeight,
          video.videoWidth, bottomSourceHeight,
          left, bottom - bottomGap, contentWidth, bottomGap);
        context.restore();
      }
      if (playerLabSettings.fade) {
        context.save();
        context.globalAlpha = 1;
        context.filter = 'none';
        fillEdgeFade(context, 0, 0, left, 0,
          { x: 0, y: 0, width: leftGap, height }, true);
        fillEdgeFade(context, right, 0, width, 0,
          { x: right, y: 0, width: rightGap, height }, false);
        fillEdgeFade(context, 0, 0, 0, top,
          { x: left, y: 0, width: contentWidth, height: topGap }, true);
        fillEdgeFade(context, 0, bottom, 0, height,
          { x: left, y: bottom, width: contentWidth, height: bottomGap }, false);
        context.restore();
      }
    } catch {
      // A protected stream can reject canvas drawing. Keep its gutters OLED black.
    }
  }

  function scheduleEdgeMirror() {
    if (!isWatchPage()) return;
    const video = document.querySelector('#movie_player video.html5-main-video, #movie_player video');
    if (!document.hidden && video?.requestVideoFrameCallback) {
      edgeMirrorFrameVideo = video;
      edgeMirrorFrameHandle = video.requestVideoFrameCallback((_now, frame) => {
        edgeMirrorFrameHandle = 0;
        edgeMirrorFrameVideo = null;
        paintEdgeMirror(frame);
        scheduleEdgeMirror();
      });
      return;
    }
    edgeMirrorTimer = setTimeout(() => {
      edgeMirrorTimer = 0;
      paintEdgeMirror();
      scheduleEdgeMirror();
    }, document.hidden ? 500 : 16);
  }

  function startEdgeMirror(immediate = false) {
    if (edgeMirrorFrameVideo
      && edgeMirrorFrameVideo !== document.querySelector('#movie_player video.html5-main-video, #movie_player video')) {
      immediate = true;
    }
    if (immediate) {
      if (edgeMirrorTimer) clearTimeout(edgeMirrorTimer);
      if (edgeMirrorFrameVideo && edgeMirrorFrameHandle) {
        try { edgeMirrorFrameVideo.cancelVideoFrameCallback(edgeMirrorFrameHandle); } catch {}
      }
      edgeMirrorTimer = 0;
      edgeMirrorFrameVideo = null;
      edgeMirrorFrameHandle = 0;
      paintEdgeMirror();
    }
    if (!edgeMirrorTimer && !edgeMirrorFrameHandle) scheduleEdgeMirror();
  }

  function positionPlayerLabPanel() {
    if (!playerLab || playerLab.panel.hidden) return;
    const rect = playerLab.handle.getBoundingClientRect();
    const width = Math.min(320, innerWidth - 24);
    playerLab.panel.style.width = `${width}px`;
    const panelHeight = Math.min(playerLab.panel.scrollHeight, innerHeight - 24);
    const left = Math.max(12, Math.min(innerWidth - width - 12, rect.right - width));
    const above = rect.top - panelHeight - 10;
    const opensAbove = above >= 12;
    const top = opensAbove
      ? above
      : Math.min(innerHeight - panelHeight - 12, rect.bottom + 10);
    playerLab.panel.style.left = `${left}px`;
    playerLab.panel.style.top = `${Math.max(12, top)}px`;
    playerLab.panel.style.transformOrigin = opensAbove ? 'bottom right' : 'top right';
  }

  function createPlayerLab() {
    const host = document.createElement('span');
    host.id = 'still-youtube-player-lab';
    host.style.setProperty('display', 'inline-flex', 'important');
    host.style.setProperty('flex', '0 0 auto', 'important');
    host.style.setProperty('margin-inline-start', '2px', 'important');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display:inline-flex;position:relative;flex:0 0 auto;align-self:center;min-width:max-content;margin-inline:2px 0;vertical-align:middle;color:#f1f1f1;font:500 12px/1.35 Roboto,Arial,sans-serif;color-scheme:dark }
      * { box-sizing:border-box }
      .handle { position:relative;width:38px;height:32px;padding:0;border:0;border-radius:16px;display:grid;place-items:center;color:var(--still-action-color,#f1f1f1);background:transparent;cursor:pointer;transition:background-color 120ms ease }
      .handle::before { content:'';position:absolute;left:0;top:7px;bottom:7px;width:1px;background:rgba(255,255,255,.12) }
      .handle:hover,.handle[aria-expanded='true'] { background:#242424 }
      .handle:focus-visible { outline:2px solid #fff;outline-offset:-3px }
      .handle svg { width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round }
      .panel { position:fixed;z-index:2147483647;width:320px;padding:14px;border:1px solid #292929;border-radius:16px;background:rgba(12,12,12,.98);box-shadow:0 18px 54px rgba(0,0,0,.62);backdrop-filter:blur(18px);animation:panel-in 120ms cubic-bezier(.2,0,0,1) both }
      .panel[hidden] { display:none }
      @keyframes panel-in { from { opacity:0;transform:translateY(5px) scale(.98) } to { opacity:1;transform:none } }
      header { display:flex;align-items:center;justify-content:space-between;margin-bottom:11px }
      h2 { margin:0;font:600 14px/20px Roboto,Arial,sans-serif;letter-spacing:.1px }
      .reset { border:0;padding:5px 8px;border-radius:7px;color:#aaa;background:transparent;font:500 11px/16px Roboto,Arial,sans-serif;cursor:pointer }
      .reset:hover { color:#fff;background:#252525 }
      .control { display:grid;gap:5px;margin-top:10px }
      .control:first-of-type { margin-top:0 }
      .line { display:flex;align-items:center;justify-content:space-between;gap:12px }
      .value { min-width:52px;color:#aaa;text-align:right;font-variant-numeric:tabular-nums }
      input[type='range'] { width:100%;height:13px;margin:0;accent-color:#f1f1f1;cursor:ew-resize }
      .curve-line { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;font-size:11px }
      .curve-line svg { width:44px;height:20px;margin-left:auto;flex:none;overflow:visible }
      .curve-line polyline { fill:none;stroke:#aaa;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round }
      .curve-line select { min-width:108px;height:28px;padding:0 8px;border:1px solid #333;border-radius:8px;background:#1d1d1d;color:#f1f1f1;font:500 11px Roboto,Arial,sans-serif;cursor:pointer }
      .curve-line select:disabled { opacity:.45;cursor:default }
      .edge-style-line { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;font-size:11px }
      .edge-style-line select { width:158px;height:28px;padding:0 8px;border:1px solid #333;border-radius:8px;background:#1d1d1d;color:#f1f1f1;font:500 11px Roboto,Arial,sans-serif;cursor:pointer }
      .edge-style-line select:disabled { opacity:.45;cursor:default }
      .switch-grid { display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px }
      .switch-line { min-width:0;min-height:32px;margin:0;padding:0 7px;border:1px solid #262626;border-radius:10px;background:#151515;font-size:11px }
      input[type='checkbox'] { width:32px;height:18px;margin:0;appearance:none;border:1px solid #444;border-radius:10px;background:#202020;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease }
      input[type='checkbox']::after { content:'';display:block;width:12px;height:12px;margin:2px;border-radius:50%;background:#888;transition:transform 120ms ease,background-color 120ms ease }
      input[type='checkbox']:checked { border-color:#f1f1f1;background:#f1f1f1 }
      input[type='checkbox']:checked::after { background:#111;transform:translateX(14px) }
      .hint { margin:11px 0 0;color:#777;font:400 10px/14px Roboto,Arial,sans-serif }
    `;
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'handle';
    handle.setAttribute('aria-label', 'Player Lab');
    handle.setAttribute('aria-expanded', 'false');
    handle.title = 'Player Lab';
    const handleIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    handleIcon.setAttribute('viewBox', '0 0 24 24');
    handleIcon.setAttribute('aria-hidden', 'true');
    const handlePath = document.createElementNS(handleIcon.namespaceURI, 'path');
    handlePath.setAttribute('d', 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6');
    handleIcon.appendChild(handlePath);
    handle.appendChild(handleIcon);
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = 'Player Lab';
    const reset = document.createElement('button');
    reset.className = 'reset';
    reset.type = 'button';
    reset.textContent = 'Reset';
    header.append(title, reset);

    function createRangeControl(labelText, key, minimum, maximum, step) {
      const label = document.createElement('label');
      label.className = 'control';
      const line = document.createElement('span');
      line.className = 'line';
      const text = document.createElement('span');
      text.textContent = labelText;
      const output = document.createElement('output');
      output.className = 'value';
      output.dataset.value = key;
      line.append(text, output);
      const input = document.createElement('input');
      input.dataset.control = key;
      input.type = 'range';
      input.min = String(minimum);
      input.max = String(maximum);
      input.step = String(step);
      label.append(line, input);
      return { label, input, output };
    }

    const heightControl = createRangeControl('Video height', 'height', 82, 99.5, .25);
    const mirrorLabel = document.createElement('label');
    mirrorLabel.className = 'switch-line line';
    const mirrorText = document.createElement('span');
    mirrorText.textContent = 'Fill edges';
    const mirrorInput = document.createElement('input');
    mirrorInput.dataset.control = 'mirror';
    mirrorInput.type = 'checkbox';
    mirrorLabel.append(mirrorText, mirrorInput);
    const fadeLabel = document.createElement('label');
    fadeLabel.className = 'switch-line line';
    const fadeText = document.createElement('span');
    fadeText.textContent = 'Fade to black';
    const fadeInput = document.createElement('input');
    fadeInput.dataset.control = 'fade';
    fadeInput.type = 'checkbox';
    fadeLabel.append(fadeText, fadeInput);
    const mutedLabel = document.createElement('label');
    mutedLabel.className = 'switch-line line';
    const mutedText = document.createElement('span');
    mutedText.textContent = 'Muted colors';
    const mutedInput = document.createElement('input');
    mutedInput.dataset.control = 'mutedColors';
    mutedInput.type = 'checkbox';
    mutedLabel.append(mutedText, mutedInput);
    const switchGrid = document.createElement('div');
    switchGrid.className = 'switch-grid';
    switchGrid.append(mirrorLabel, mutedLabel, fadeLabel);
    fadeLabel.style.gridColumn = '1 / -1';
    const edgeStyleLabel = document.createElement('label');
    edgeStyleLabel.className = 'edge-style-line';
    const edgeStyleText = document.createElement('span');
    edgeStyleText.textContent = 'Edge style';
    const edgeStyleSelect = document.createElement('select');
    edgeStyleSelect.dataset.control = 'edgeFill';
    for (const [value, name] of [['mirror', 'Mirrored edges'], ['zoom', 'Zoomed video']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = name;
      edgeStyleSelect.appendChild(option);
    }
    edgeStyleLabel.append(edgeStyleText, edgeStyleSelect);
    const strengthControl = createRangeControl('Edge strength', 'strength', 0, 100, 1);
    const brightnessControl = createRangeControl('Edge brightness', 'brightness', 0, 100, 1);
    const softnessControl = createRangeControl('Edge softness', 'softness', 0, 24, .5);
    const curveLabel = document.createElement('label');
    curveLabel.className = 'curve-line';
    const curveText = document.createElement('span');
    curveText.textContent = 'Fade curve';
    const curveGraph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    curveGraph.setAttribute('viewBox', '0 0 44 20');
    curveGraph.setAttribute('aria-hidden', 'true');
    const curvePreview = document.createElementNS(curveGraph.namespaceURI, 'polyline');
    curveGraph.appendChild(curvePreview);
    const curveSelect = document.createElement('select');
    curveSelect.dataset.control = 'fadeCurve';
    for (const [value, name] of [
      ['soft', 'Soft · eased'], ['late', 'Late · gentle'],
      ['linear', 'Linear'], ['early', 'Early · dark']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = name;
      curveSelect.appendChild(option);
    }
    curveLabel.append(curveText, curveGraph, curveSelect);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Live values are saved for every YouTube video.';
    panel.append(
      header,
      heightControl.label,
      switchGrid,
      edgeStyleLabel,
      strengthControl.label,
      brightnessControl.label,
      softnessControl.label,
      curveLabel,
      hint
    );
    const portal = document.createElement('span');
    portal.id = 'still-youtube-player-lab-panel';
    const panelRoot = portal.attachShadow({ mode: 'open' });
    root.append(style, handle);
    panelRoot.append(style.cloneNode(true), panel);
    (document.body || document.documentElement).appendChild(portal);
    const controls = {
      height: heightControl.input,
      heightValue: heightControl.output,
      mirror: mirrorInput,
      mutedColors: mutedInput,
      edgeFill: edgeStyleSelect,
      fade: fadeInput,
      fadeCurve: curveSelect,
      fadeCurvePreview: curvePreview,
      strength: strengthControl.input,
      strengthValue: strengthControl.output,
      brightness: brightnessControl.input,
      brightnessValue: brightnessControl.output,
      softness: softnessControl.input,
      softnessValue: softnessControl.output
    };
    function updateSetting(key, value) {
      playerLabSettings[key] = value;
      savePlayerLabSettings();
      applyPlayerLabSettings();
      edgeMirrorLastState = '';
      startEdgeMirror(true);
    }
    controls.height.addEventListener('input', () => updateSetting('height', Number(controls.height.value)));
    controls.mirror.addEventListener('change', () => updateSetting('mirror', controls.mirror.checked));
    controls.mutedColors.addEventListener('change', toggleMutedColors);
    controls.edgeFill.addEventListener('change', () => updateSetting('edgeFill', controls.edgeFill.value));
    controls.fade.addEventListener('change', () => updateSetting('fade', controls.fade.checked));
    controls.fadeCurve.addEventListener('change', () => updateSetting('fadeCurve', controls.fadeCurve.value));
    controls.strength.addEventListener('input', () => updateSetting('strength', Number(controls.strength.value)));
    controls.brightness.addEventListener('input', () => updateSetting('brightness', Number(controls.brightness.value)));
    controls.softness.addEventListener('input', () => updateSetting('softness', Number(controls.softness.value)));
    handle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.hidden = !panel.hidden;
      handle.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) positionPlayerLabPanel();
    });
    reset.addEventListener('click', () => {
      playerLabSettings = { ...PLAYER_LAB_DEFAULTS };
      mutedColors = false;
      try { localStorage.setItem('still-youtube-muted-colors', 'false'); } catch {}
      savePlayerLabSettings();
      applyPlayerLabSettings();
      applyMutedColors();
      edgeMirrorLastState = '';
      startEdgeMirror(true);
    });
    panelRoot.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      panel.hidden = true;
      handle.setAttribute('aria-expanded', 'false');
      handle.focus();
    });
    playerLab = { host, root, handle, portal, panelRoot, panel, controls };
    applyPlayerLabSettings();
    return host;
  }

  function mountPlayerLab(placement) {
    if (!placement?.row) return;
    const existing = document.querySelector('#still-youtube-player-lab');
    const host = playerLab?.host?.isConnected ? playerLab.host : existing || createPlayerLab();
    if (playerLab?.portal && !playerLab.portal.isConnected) {
      (document.body || document.documentElement).appendChild(playerLab.portal);
    }
    if (host.parentElement !== placement.row || host.nextSibling !== placement.before) {
      placement.row.insertBefore(host, placement.before);
    }
    applyPlayerLabSettings();
    startEdgeMirror();
    requestAnimationFrame(() => syncNativeActionStyle(host, playerLab?.handle));
  }

  function label(text) {
    if (currentUi) currentUi.trigger.querySelector('.trigger-label').textContent = text;
  }

  function triggerState(value = '') {
    if (currentUi) currentUi.trigger.dataset.state = value;
  }

  function ensureVideoColorStyle() {
    let style = document.querySelector('#still-youtube-video-color-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'still-youtube-video-color-style';
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.dataset.stillVersion !== String(UI_VERSION)) {
      style.dataset.stillVersion = String(UI_VERSION);
      style.textContent = `
        html.still-youtube-muted-colors #movie_player video,
        html.still-youtube-muted-colors video.html5-main-video {
          filter: saturate(.28) contrast(1.04) brightness(.97) !important;
        }
        #movie_player video, video.html5-main-video {
          transition: filter 180ms ease !important;
        }
        [data-still-thanks-hidden='true'] {
          display: none !important;
        }
        #still-youtube-corner-home {
          position: fixed;
          z-index: 2147483646;
          top: 0;
          left: 0;
          display: grid;
          place-items: start;
          box-sizing: border-box;
          width: 112px;
          height: 78px;
          padding: 18px 0 0 20px;
          overflow: hidden;
          border-radius: 0 0 22px 0;
          background: transparent;
          opacity: 1;
          text-decoration: none;
          cursor: pointer;
        }
        #still-youtube-corner-home svg {
          width: 42px;
          height: 30px;
          opacity: 0;
          filter: none;
          transform: translate(-10px,-7px) scale(.78);
          transition: opacity 160ms ease,transform 190ms cubic-bezier(.2,.8,.2,1);
        }
        #still-youtube-corner-home:hover svg,
        #still-youtube-corner-home:focus-visible svg {
          opacity: 1;
          transform: translate(0,0) scale(1);
        }
        #still-youtube-corner-home:focus-visible { outline: 2px solid #3ea6ff;outline-offset: -5px; }
      `;
    }
  }

  function createCornerHome() {
    const link = document.createElement('a');
    link.id = 'still-youtube-corner-home';
    link.href = 'https://www.youtube.com/';
    link.setAttribute('aria-label', 'YouTube home');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 68 48');
    svg.setAttribute('aria-hidden', 'true');
    const background = document.createElementNS(svg.namespaceURI, 'path');
    background.setAttribute('fill', '#ff0033');
    background.setAttribute('d', 'M66.5 7.5A8.4 8.4 0 0 0 60.6 1.6C55.4 0 34 0 34 0S12.6 0 7.4 1.4A8.6 8.6 0 0 0 1.5 7.5C0 12.8 0 24 0 24s0 11.2 1.5 16.5a8.4 8.4 0 0 0 5.9 5.9C12.6 48 34 48 34 48s21.4 0 26.6-1.4a8.4 8.4 0 0 0 5.9-5.9C68 35.4 68 24.2 68 24.2s0-11.4-1.5-16.7Z');
    const triangle = document.createElementNS(svg.namespaceURI, 'path');
    triangle.setAttribute('fill', '#fff');
    triangle.setAttribute('d', 'm27 34 18-10-18-10Z');
    svg.append(background, triangle);
    link.appendChild(svg);
    return link;
  }

  function applyMutedColors() {
    ensureVideoColorStyle();
    document.documentElement.classList.toggle('still-youtube-muted-colors', mutedColors);
    if (playerLab) playerLab.controls.mutedColors.checked = mutedColors;
    edgeMirrorLastState = '';
    startEdgeMirror(true);
  }

  function toggleMutedColors() {
    mutedColors = !mutedColors;
    try { localStorage.setItem('still-youtube-muted-colors', String(mutedColors)); } catch {}
    applyMutedColors();
  }

  function status(text, kind = '') {
    if (!currentUi) return;
    currentUi.status.textContent = text;
    currentUi.status.dataset.kind = kind;
    currentUi.panel.dataset.status = text === 'Choose a format to save it.' ? 'false' : 'true';
  }

  function disableChoices(disabled) {
    currentUi?.root.querySelectorAll('.choice').forEach((choice) => { choice.disabled = disabled; });
  }

  function selectFormat(mode, option) {
    if (busy || !currentUi) return;
    busy = true;
    triggerState('busy');
    currentUi.panel.hidden = false;
    disableChoices(true);
    label('Starting…');
    status('Preparing your download…');
    currentUi.bar.style.width = '3%';
    window.postMessage({ type: 'still-youtube-download', mode, option }, location.origin);
  }

  function handleProgress(event) {
    const update = event.detail || {};
    if (!currentUi) return;
    if (update.state === 'starting') {
      triggerState('busy');
      busy = true;
      disableChoices(true);
      label('Starting…');
      status('Preparing your download…');
      currentUi.bar.style.width = '3%';
    } else if (update.state === 'downloading') {
      triggerState('busy');
      const percent = Math.max(0, Math.min(100, Number.parseFloat(update.percent) || 0));
      const details = [update.speed, update.eta && `ETA ${update.eta}`].filter(Boolean).join(' · ');
      label(update.percent || 'Downloading');
      status(`Downloading${details ? ` · ${details}` : ''}`);
      currentUi.bar.style.width = `${percent}%`;
    } else if (update.state === 'complete') {
      triggerState('success');
      busy = false;
      disableChoices(false);
      label('Downloaded');
      status('Saved where you chose.', 'success');
      currentUi.bar.style.width = '100%';
      setTimeout(() => label('Download'), 2600);
    } else if (update.state === 'cancelled') {
      triggerState();
      busy = false;
      disableChoices(false);
      label('Download');
      status('Download cancelled.');
      currentUi.bar.style.width = '0%';
    } else if (update.state === 'error') {
      triggerState('error');
      busy = false;
      disableChoices(false);
      label('Retry');
      status(update.message || 'The download failed.', 'error');
      currentUi.bar.style.width = '0%';
    }
  }

  function syncNativeActionStyle(host, trigger) {
    if (host.dataset.stillStyleSynced === 'true') return;
    const candidates = [...document.querySelectorAll(
      '#actions #top-level-buttons-computed button, #actions button-view-model button, #actions yt-button-shape button'
    )];
    const visible = (button) => button.getBoundingClientRect().width > 0;
    const description = (button) => `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`;
    // Copy a complete tonal pill, never the segmented Like half (its right radius is zero).
    const reference = candidates.find((button) => visible(button) && /share|teilen/i.test(description(button)))
      || candidates.find((button) => visible(button) && /save|speichern/i.test(description(button)))
      || candidates.find((button) => visible(button) && !button.className.includes('Segmented'));
    if (!reference || reference === trigger) return;
    const textStyle = getComputedStyle(reference);
    const rootStyle = getComputedStyle(document.documentElement);
    const nativeBase = rootStyle
      .getPropertyValue('--yt-sys-color-baseline--overlay-button-secondary').trim();
    host.style.setProperty('--still-action-bg', nativeBase || 'rgba(255,255,255,.1)');
    host.style.setProperty('--still-action-radius', textStyle.borderRadius || '20px');
    host.style.setProperty('--still-action-color', textStyle.color);
    host.style.setProperty('--still-action-font', textStyle.fontFamily);
    host.style.setProperty('--still-action-size', textStyle.fontSize || '14px');
    host.style.setProperty('--still-action-weight', textStyle.fontWeight || '500');
    host.style.setProperty('--still-action-padding', textStyle.padding || '0 16px');
    host.style.setProperty('--still-action-line-height', textStyle.lineHeight || '40px');
    const nativeHover = rootStyle
      .getPropertyValue('--yt-sys-color-baseline--mono-tonal-hover').trim();
    host.style.setProperty('--still-action-hover', nativeHover || 'rgba(255,255,255,.2)');
    if (reference.getBoundingClientRect().height > 28) {
      host.style.setProperty('--still-action-height', `${reference.getBoundingClientRect().height}px`);
    }
    host.dataset.stillStyleSynced = 'true';
  }

  function positionCurrentPanel() {
    if (!currentUi || currentUi.panel.hidden) return;
    const rect = currentUi.trigger.getBoundingClientRect();
    const width = Math.min(304, innerWidth - 24);
    const left = Math.max(12, Math.min(innerWidth - width - 12, rect.right - width));
    currentUi.panel.style.width = `${width}px`;
    const menuHeight = Math.min(currentUi.panel.scrollHeight, 420, innerHeight - 24);
    const below = rect.bottom + 8;
    const opensBelow = below + menuHeight <= innerHeight - 12;
    const top = opensBelow ? below : Math.max(12, rect.top - menuHeight - 8);
    currentUi.panel.style.transformOrigin = opensBelow ? 'top right' : 'bottom right';
    currentUi.panel.style.left = `${left}px`;
    currentUi.panel.style.top = `${top}px`;
  }

  function positionCurrentTooltip() {
    if (!currentUi || currentUi.tooltip.hidden) return;
    const triggerRect = currentUi.trigger.getBoundingClientRect();
    const tooltipRect = currentUi.tooltip.getBoundingClientRect();
    const gap = 16;
    const belowTop = triggerRect.bottom + gap;
    const fitsBelow = belowTop + tooltipRect.height <= innerHeight - 8;
    currentUi.tooltip.dataset.side = fitsBelow ? 'below' : 'above';
    const top = fitsBelow
      ? belowTop
      : Math.max(8, triggerRect.top - gap - tooltipRect.height);
    const left = Math.max(8, Math.min(
      innerWidth - tooltipRect.width - 8,
      triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
    ));
    currentUi.tooltip.style.left = `${left}px`;
    currentUi.tooltip.style.top = `${top}px`;
  }

  function hideTooltip(immediate = false) {
    clearTimeout(tooltipTimer);
    clearTimeout(tooltipHideTimer);
    if (!currentUi) return;
    currentUi.tooltip.dataset.visible = 'false';
    if (immediate) {
      currentUi.tooltip.hidden = true;
      return;
    }
    tooltipHideTimer = setTimeout(() => {
      if (currentUi) currentUi.tooltip.hidden = true;
    }, 90);
  }

  function queueTooltip() {
    clearTimeout(tooltipTimer);
    clearTimeout(tooltipHideTimer);
    if (!currentUi || !currentUi.panel.hidden) return;
    if (currentUi && !currentUi.tooltip.hidden) {
      currentUi.tooltip.dataset.visible = 'true';
      return;
    }
    currentUi.tooltip.hidden = false;
    positionCurrentTooltip();
    requestAnimationFrame(() => {
      if (currentUi && !currentUi.tooltip.hidden) currentUi.tooltip.dataset.visible = 'true';
    });
  }

  function createUi() {
    const host = document.createElement('span');
    host.id = 'still-youtube-download-host';
    host.style.setProperty('display', 'inline-flex', 'important');
    host.style.setProperty('flex', '0 0 auto', 'important');
    host.style.setProperty('margin-inline-start', '2px', 'important');
    host.style.setProperty('margin-inline-end', '0', 'important');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display:inline-flex;position:relative;flex:0 0 auto;min-width:max-content;margin-inline:2px 0;overflow:visible;vertical-align:middle;color-scheme:light dark;font-family:var(--still-action-font,Roboto,Arial,sans-serif);--menu-bg:#fff;--menu-text:#0f0f0f;--menu-secondary:#606060;--menu-hover:rgba(0,0,0,.1);--menu-divider:rgba(0,0,0,.1) }
      :host([data-theme='dark']) { color-scheme:dark;--menu-bg:#282828;--menu-text:#f1f1f1;--menu-secondary:#aaa;--menu-hover:rgba(255,255,255,.2);--menu-divider:rgba(255,255,255,.12) }
      * { box-sizing:border-box }
      .trigger { position:relative;height:var(--still-action-height,32px);width:112px;min-width:112px;overflow:hidden;border:0;border-radius:var(--still-action-radius,16px);padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;font-family:var(--still-action-font,Roboto,Arial,sans-serif);font-size:var(--still-action-size,13px);font-weight:var(--still-action-weight,500);line-height:32px;letter-spacing:normal;color:var(--still-action-color,var(--yt-spec-text-primary,#0f0f0f));background:transparent;white-space:nowrap;appearance:none;transition:background-color 120ms ease }
      .trigger::before { content:'';position:absolute;left:0;top:7px;bottom:7px;width:1px;pointer-events:none;background:var(--menu-divider) }
      .trigger::after { content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:currentColor;opacity:0 }
      .trigger:hover { background:var(--still-action-hover,var(--yt-sys-color-baseline--mono-tonal-hover,rgba(0,0,0,.2))) }
      .trigger:active::after { opacity:.1 }
      .trigger:focus-visible { outline:2px solid var(--yt-spec-call-to-action,#3ea6ff);outline-offset:2px }
      .trigger[data-state='error'] { color:var(--yt-spec-call-to-action,#3ea6ff);background:transparent;box-shadow:inset 0 0 0 1px currentColor }
      .trigger-label { min-width:0;overflow:hidden;text-overflow:ellipsis;font:inherit;letter-spacing:inherit }
      .trigger svg { width:20px;height:20px;fill:currentColor }
      .trigger > svg { fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round }
      .panel { position:fixed;z-index:2147483647;width:304px;max-height:min(420px,calc(100vh - 24px));padding:14px;overflow:auto;border:1px solid var(--menu-divider);border-radius:16px;color:var(--menu-text);background:var(--menu-bg);box-shadow:0 18px 54px rgba(0,0,0,.46);font-family:Roboto,Noto,Arial,sans-serif;scrollbar-width:thin;transform-origin:bottom right;animation:menu-in 120ms cubic-bezier(.2,0,0,1) both }
      .panel[hidden] { display:none }
      @keyframes menu-in { from { opacity:0;transform:scale(.96) translateY(-4px) } to { opacity:1;transform:scale(1) translateY(0) } }
      h3 { display:block;margin:0 0 12px;font:600 15px/20px Roboto,Noto,Arial,sans-serif }
      .section-label { display:block;margin:11px 0 6px;color:var(--menu-secondary);font:500 10px/14px Roboto,Noto,Arial,sans-serif;letter-spacing:.7px;text-transform:uppercase }
      h3 + .section-label { margin-top:0 }
      .choices { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px }
      .choices.audio { grid-template-columns:repeat(2,minmax(0,1fr)) }
      .choices.thumbnail { grid-template-columns:1fr }
      .choice { width:100%;height:32px;min-height:32px;padding:0 8px;border:1px solid var(--menu-divider);border-radius:9px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;text-align:center;color:var(--menu-text);background:rgba(127,127,127,.08);font:500 12px/16px Roboto,Noto,Arial,sans-serif;transition:background-color 80ms ease,border-color 80ms ease }
      .choice:hover { background:var(--menu-hover) }
      .choice:active { background:var(--menu-hover) }
      .choice:focus-visible { outline:2px solid var(--yt-spec-call-to-action,#3ea6ff);outline-offset:-2px }
      .choice-icon { display:none }
      .choice:disabled { opacity:.45;cursor:default }
      .track { display:none;height:3px;margin:12px 0 0;overflow:hidden;border-radius:2px;background:var(--menu-divider) }
      .bar { width:0;height:100%;border-radius:inherit;background:#3ea6ff;transition:width 180ms ease }
      .status { display:none;min-height:16px;margin:8px 0 0;overflow-wrap:anywhere;color:var(--menu-secondary);font-size:12px;line-height:16px }
      .panel[data-status='true'] .track,.panel[data-status='true'] .status { display:block }
      .status[data-kind='success'] { color:#2ba640 }
      .status[data-kind='error'] { color:#ff4e45 }
      .folder { display:none }
      .tooltip { position:fixed;z-index:2147483647;padding:8px;border-radius:4px;pointer-events:none;white-space:nowrap;color:#fff;background:#606060;font:400 12px/18px Roboto,Arial,sans-serif;opacity:0;transition:opacity 110ms ease-out }
      .tooltip[data-visible='true'] { opacity:.9 }
      .tooltip[hidden] { display:none }
    `;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'trigger';
    trigger.setAttribute('aria-label', 'Download this video');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 24 24');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3');
    svg.appendChild(iconPath);
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'trigger-label';
    triggerLabel.textContent = 'Download';
    trigger.append(svg, triggerLabel);

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    panel.dataset.status = 'false';
    const heading = document.createElement('h3');
    heading.textContent = 'Download';
    panel.appendChild(heading);

    function appendChoices(sectionTitle, choices) {
      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'section-label';
      sectionLabel.textContent = sectionTitle;
      const row = document.createElement('div');
      row.className = `choices ${choices[0]?.mode || ''}`;
      for (const choice of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice';
        button.dataset.mode = choice.mode;
        button.dataset.option = choice.option;
        const choiceIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        choiceIcon.setAttribute('class', 'choice-icon');
        choiceIcon.setAttribute('aria-hidden', 'true');
        choiceIcon.setAttribute('viewBox', '0 0 24 24');
        const choicePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        choicePath.setAttribute('d', choice.mode === 'audio'
          ? 'M12 3v10.55A4 4 0 1 0 14 17V7h5V3h-7Z'
          : choice.mode === 'thumbnail'
            ? 'M4 4h16v16H4V4Zm2 2v9.17l2.59-2.58L11 15l3.59-3.59L18 14.83V6H6Zm2.5 1.5A1.5 1.5 0 1 1 7 9a1.5 1.5 0 0 1 1.5-1.5Z'
            : 'M4 5h16v14H4V5Zm2 2v10h12V7H6Zm4 2 5 3-5 3V9Z');
        choiceIcon.appendChild(choicePath);
        const choiceLabel = document.createElement('span');
        choiceLabel.textContent = choice.label;
        button.append(choiceIcon, choiceLabel);
        row.appendChild(button);
      }
      panel.append(sectionLabel, row);
    }

    appendChoices('Video quality', [
      { mode: 'video', option: 'best', label: 'Best' },
      { mode: 'video', option: '2160', label: '4K' },
      { mode: 'video', option: '1440', label: '1440p' },
      { mode: 'video', option: '1080', label: '1080p' },
      { mode: 'video', option: '720', label: '720p' },
      { mode: 'video', option: '480', label: '480p' },
      { mode: 'video', option: '360', label: '360p' }
    ]);
    appendChoices('Audio', [
      { mode: 'audio', option: 'mp3', label: 'MP3' },
      { mode: 'audio', option: 'm4a', label: 'M4A' }
    ]);
    appendChoices('Thumbnail', [
      { mode: 'thumbnail', option: 'jpg', label: 'Thumbnail' }
    ]);

    const track = document.createElement('div');
    track.className = 'track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    track.appendChild(bar);
    const statusText = document.createElement('div');
    statusText.className = 'status';
    statusText.textContent = 'Choose a format to save it.';
    const folder = document.createElement('div');
    folder.className = 'folder';
    folder.textContent = 'Saves to your Downloads folder';
    panel.append(track, statusText, folder);
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = 'Download';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    root.append(style, trigger, panel, tooltip);
    currentUi = {
      host,
      root,
      trigger,
      panel,
      tooltip,
      status: root.querySelector('.status'),
      bar: root.querySelector('.bar')
    };
    const syncTheme = () => {
      const dark = document.documentElement.hasAttribute('dark')
        || document.documentElement.getAttribute('data-theme') === 'dark'
        || document.body?.classList.contains('dark')
        || matchMedia('(prefers-color-scheme: dark)').matches;
      host.dataset.theme = dark ? 'dark' : 'light';
    };
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['dark', 'data-theme', 'class']
    });
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideTooltip(true);
      const opening = panel.hidden;
      panel.hidden = !opening;
      if (opening) positionCurrentPanel();
    });
    trigger.addEventListener('mouseenter', queueTooltip);
    trigger.addEventListener('mouseleave', () => hideTooltip());
    trigger.addEventListener('focus', queueTooltip);
    trigger.addEventListener('blur', () => hideTooltip());
    root.querySelectorAll('.choice').forEach((choice) => {
      choice.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectFormat(choice.dataset.mode, choice.dataset.option);
      });
    });
    return host;
  }

  function actionRows() {
    return [...document.querySelectorAll(
      'ytd-watch-metadata #actions #top-level-buttons-computed, #actions #top-level-buttons-computed, '
      + 'ytd-watch-metadata #actions #flexible-item-buttons, #actions #flexible-item-buttons'
    )];
  }

  function directChildFor(row, element) {
    let child = element;
    while (child?.parentElement && child.parentElement !== row) child = child.parentElement;
    return child?.parentElement === row ? child : null;
  }

  function hideThanksButtons() {
    for (const row of actionRows()) {
      for (const button of row.querySelectorAll('button')) {
        const description = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`;
        if (!/thanks|danke|support/i.test(description)) continue;
        const item = directChildFor(row, button);
        if (item) item.dataset.stillThanksHidden = 'true';
      }
    }
  }

  function restoreThanksButtons() {
    document.querySelectorAll('[data-still-thanks-hidden="true"]').forEach((item) => {
      delete item.dataset.stillThanksHidden;
    });
  }

  function findActionPlacement() {
    const rows = actionRows();
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || rows[0];
    if (!row) return null;
    const buttons = [...row.querySelectorAll('button')];
    const description = (button) => `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`;
    const saveButton = buttons.find((button) => /save|speichern|playlist/i.test(description(button)));
    const shareButton = buttons.find((button) => /share|teilen/i.test(description(button)));
    const saveItem = directChildFor(row, saveButton);
    if (saveItem) return { row, before: saveItem };
    const shareItem = directChildFor(row, shareButton);
    if (shareItem) return { row, before: shareItem.nextSibling };
    return null;
  }

  function mount() {
    clearTimeout(mountTimer);
    const existing = document.querySelector('#still-youtube-download-host');
    const existingSaturation = document.querySelector('#still-youtube-saturation-host');
    const existingCornerHome = document.querySelector('#still-youtube-corner-home');
    const existingPlayerLab = document.querySelector('#still-youtube-player-lab');
    const existingPlayerLabPanel = document.querySelector('#still-youtube-player-lab-panel');
    if (!isWatchPage()) {
      existing?.remove();
      existingSaturation?.remove();
      existingCornerHome?.remove();
      existingPlayerLab?.remove();
      existingPlayerLabPanel?.remove();
      stopEdgeMirror();
      currentUi = null;
      cornerHome = null;
      playerLab = null;
      restoreThanksButtons();
      document.documentElement.classList.remove('still-youtube-muted-colors');
      return;
    }
    ensureVideoColorStyle();
    startEdgeMirror();
    try { mutedColors = localStorage.getItem('still-youtube-muted-colors') === 'true'; } catch {}
    cornerHome = existingCornerHome || cornerHome || createCornerHome();
    if (!cornerHome.isConnected) (document.body || document.documentElement).appendChild(cornerHome);
    const placement = findActionPlacement();
    if (!placement) return;
    hideThanksButtons();
    const host = currentUi?.host || (existing?.isConnected ? existing : null) || createUi();
    if (host.parentElement !== placement.row || host.nextSibling !== placement.before) {
      placement.row.insertBefore(host, placement.before);
    }
    requestAnimationFrame(() => syncNativeActionStyle(host, currentUi?.trigger));
    mountPlayerLab(placement);
    if (document.documentElement.classList.contains('still-youtube-muted-colors') !== mutedColors
      || playerLab?.controls.mutedColors.checked !== mutedColors) applyMutedColors();
  }

  function scheduleMount() {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(mount, 120);
  }

  window.__stillDownloadUi = {
    version: UI_VERSION,
    mount,
    destroy() {
      clearTimeout(mountTimer);
      clearTimeout(tooltipTimer);
      clearTimeout(tooltipHideTimer);
      mountObserver?.disconnect();
      window.removeEventListener('still-download-progress', handleProgress);
      currentUi?.host.remove();
      cornerHome?.remove();
      playerLab?.host.remove();
      playerLab?.portal.remove();
      stopEdgeMirror();
      currentUi = null;
      cornerHome = null;
      playerLab = null;
      restoreThanksButtons();
      document.documentElement.classList.remove('still-youtube-muted-colors');
    }
  };
  window.addEventListener('still-download-progress', handleProgress);
  document.addEventListener('click', (event) => {
    if (currentUi && event.target !== currentUi.host && !currentUi.host.contains(event.target)) {
      currentUi.panel.hidden = true;
    }
    if (playerLab
      && !playerLab.panel.hidden
      && event.target !== playerLab.host
      && !playerLab.host.contains(event.target)
      && event.target !== playerLab.portal
      && !playerLab.portal.contains(event.target)) {
      playerLab.panel.hidden = true;
      playerLab.handle.setAttribute('aria-expanded', 'false');
    }
  }, true);
  document.addEventListener('yt-navigate-finish', scheduleMount);
  window.addEventListener('resize', positionCurrentPanel);
  window.addEventListener('resize', positionCurrentTooltip);
  window.addEventListener('resize', positionPlayerLabPanel);
  window.addEventListener('resize', () => startEdgeMirror(true));
  document.addEventListener('fullscreenchange', () => startEdgeMirror(true));
  document.addEventListener('visibilitychange', () => startEdgeMirror(true));
  window.addEventListener('scroll', positionCurrentPanel, true);
  window.addEventListener('scroll', positionCurrentTooltip, true);
  window.addEventListener('scroll', positionPlayerLabPanel, true);
  mountObserver = new MutationObserver(() => {
    if (!isWatchPage()) return;
    const placement = findActionPlacement();
    if (!currentUi?.host?.isConnected
      || !document.querySelector('#still-youtube-corner-home')
      || !document.querySelector('#still-youtube-player-lab')
      || !document.querySelector('#still-youtube-player-lab-panel')
      || (placement && currentUi.host.parentElement !== placement.row)
      ) {
      scheduleMount();
    } else {
      hideThanksButtons();
    }
  });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });
  mount();
})();
