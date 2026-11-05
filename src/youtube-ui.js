(() => {
  const UI_VERSION = 32;
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
  // Edge fill renderer (WebGL). See startEdgeMirror.
  let edge = null;
  let edgeFrame = 0;
  let edgeVideo = null;
  let edgeObserver = null;
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

  function fadeAmount(distance) {
    const t = Math.max(0, Math.min(1, distance));
    switch (playerLabSettings.fadeCurve) {
      case 'late': return t * t * t * t;
      case 'linear': return t;
      case 'early': return Math.sqrt(t);
      default: return t * t;
    }
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


  // Edge fill. The video's own frame is drawn into the gutters around it
  // (mirrored, or zoomed to cover) with WebGL. WebGL takes the decoded frame
  // straight from the GPU; a 2D canvas or -moz-element copies every frame
  // through the CPU, which in Firefox costs 10 ms or more per copy and froze
  // the page at 1080p. Drawing happens in requestAnimationFrame while the
  // video plays, so each refresh shows the frame the compositor shows.
  const EDGE_VERTEX = `#version 300 es
in vec2 point;
void main() { gl_Position = vec4(point, 0.0, 1.0); }`;
  const EDGE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform vec2 size;      // canvas size in CSS pixels
uniform float scale;    // backing pixels per CSS pixel
uniform vec4 box;       // picture rectangle in CSS pixels: x, y, width, height
uniform vec4 cover;     // zoom mode: uv offset and uv scale
uniform float zoom;     // 1 = zoomed cover, 0 = mirrored
uniform float gain;     // strength times brightness
uniform float muted;
uniform float fade;
uniform float curve;    // 0 soft, 1 late, 2 linear, 3 early
out vec4 color;

float fadeAmount(float t) {
  t = clamp(t, 0.0, 1.0);
  if (curve < 0.5) return t * t;
  if (curve < 1.5) return t * t * t * t;
  if (curve < 2.5) return t;
  return sqrt(t);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, size.y * scale - gl_FragCoord.y) / scale;
  vec2 v = (px - box.xy) / box.zw;
  bool inside = v.x >= 0.0 && v.x <= 1.0 && v.y >= 0.0 && v.y <= 1.0;
  vec2 uv;
  if (inside) uv = v;
  else if (zoom > 0.5) uv = cover.xy + px / size * cover.zw;
  else uv = 1.0 - abs(1.0 - mod(abs(v), 2.0));
  vec3 rgb = texture(frame, clamp(uv, 0.0, 1.0)).rgb;
  if (!inside) {
    if (muted > 0.5) {
      float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      rgb = mix(vec3(luma), rgb, 0.28);
      rgb = ((rgb - 0.5) * 1.04 + 0.5) * 0.97;
    }
    rgb *= gain;
    if (fade > 0.5) {
      // 0 at the picture's edge, 1 at the player's outer edge.
      float dx = px.x < box.x ? (box.x - px.x) / max(box.x, 1.0)
        : px.x > box.x + box.z ? (px.x - box.x - box.z) / max(size.x - box.x - box.z, 1.0) : 0.0;
      float dy = px.y < box.y ? (box.y - px.y) / max(box.y, 1.0)
        : px.y > box.y + box.w ? (px.y - box.y - box.w) / max(size.y - box.y - box.w, 1.0) : 0.0;
      rgb *= 1.0 - fadeAmount(max(dx, dy));
    }
  }
  color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

  function createEdgeRenderer(player) {
    const canvas = document.createElement('canvas');
    canvas.id = 'still-youtube-edge-mirror';
    canvas.setAttribute('aria-hidden', 'true');
    // Below YouTube's video container (z-index 10), so the picture itself
    // always comes from the real video element.
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;contain:strict;display:none';
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance'
    });
    if (!gl) return null;
    const shader = (type, source) => {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result) || 'shader');
      return result;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, EDGE_VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, EDGE_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const point = gl.getAttribLocation(program, 'point');
    gl.enableVertexAttribArray(point);
    gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const uniforms = {};
    for (const name of ['size', 'scale', 'box', 'cover', 'zoom', 'gain', 'muted', 'fade', 'curve']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    const renderer = { canvas, gl, uniforms, player, geometry: null, broken: false };
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      if (edge === renderer) stopEdgeMirror();
    });
    player.prepend(canvas);
    return renderer;
  }

  function currentVideo() {
    return document.querySelector('#movie_player video.html5-main-video, #movie_player video');
  }

  function edgeWanted() {
    return isWatchPage() && !document.hidden && playerLabSettings.mirror && playerLabSettings.strength > 0;
  }

  // Layout work happens here, only when something changed, never per frame.
  function measureEdge() {
    if (!edge) return false;
    const { player, canvas, gl, uniforms } = edge;
    const video = edgeVideo;
    if (!video?.videoWidth || !video.videoHeight) { edge.geometry = null; return false; }
    fitVideoToStage(player, video);
    const width = player.clientWidth;
    const height = player.clientHeight;
    const playerRect = player.getBoundingClientRect();
    const picture = displayedVideoRect(video);
    const left = Math.max(0, Math.min(width, picture.left - playerRect.left));
    const top = Math.max(0, Math.min(height, picture.top - playerRect.top));
    const right = Math.max(left, Math.min(width, picture.right - playerRect.left));
    const bottom = Math.max(top, Math.min(height, picture.bottom - playerRect.top));
    const gutters = Math.max(left, top, width - right, height - bottom);
    if (width < 2 || height < 2 || right - left < 1 || bottom - top < 1 || gutters < 0.5) {
      edge.geometry = null;
      canvas.style.display = 'none';
      return false;
    }
    const zoom = playerLabSettings.edgeFill === 'zoom';
    const blur = zoom ? Math.max(12, playerLabSettings.softness) : playerLabSettings.softness;
    // A blurred fill does not need full resolution.
    const scale = blur >= 4 ? 0.5 : Math.min(window.devicePixelRatio || 1, 2);
    const bitmapWidth = Math.max(1, Math.round(width * scale));
    const bitmapHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    const filter = blur > 0 ? `blur(${blur}px)` : 'none';
    if (canvas.style.filter !== filter) canvas.style.filter = filter;
    canvas.style.display = '';
    // Zoom mode: the video scaled to cover the whole player, centred.
    const videoRatio = video.videoWidth / video.videoHeight;
    const playerRatio = width / height;
    const coverWidth = playerRatio > videoRatio ? 1 : playerRatio / videoRatio;
    const coverHeight = playerRatio > videoRatio ? videoRatio / playerRatio : 1;
    gl.viewport(0, 0, bitmapWidth, bitmapHeight);
    gl.uniform2f(uniforms.size, width, height);
    gl.uniform1f(uniforms.scale, bitmapWidth / width);
    gl.uniform4f(uniforms.box, left, top, right - left, bottom - top);
    gl.uniform4f(uniforms.cover, (1 - coverWidth) / 2, (1 - coverHeight) / 2, coverWidth, coverHeight);
    gl.uniform1f(uniforms.zoom, zoom ? 1 : 0);
    gl.uniform1f(uniforms.gain, (playerLabSettings.strength / 100) * (playerLabSettings.brightness / 100));
    gl.uniform1f(uniforms.muted, mutedColors ? 1 : 0);
    gl.uniform1f(uniforms.fade, playerLabSettings.fade ? 1 : 0);
    gl.uniform1f(uniforms.curve, ['soft', 'late', 'linear', 'early'].indexOf(playerLabSettings.fadeCurve));
    edge.geometry = { width, height };
    return true;
  }

  function drawEdge() {
    if (!edge?.geometry || edge.broken || !edgeVideo || edgeVideo.readyState < 2) return false;
    const { gl } = edge;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, edgeVideo);
    } catch {
      // A protected stream refuses to be read. Its gutters stay black.
      edge.broken = true;
      edge.canvas.style.display = 'none';
      return false;
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  function edgeTick() {
    edgeFrame = 0;
    if (!edge || !edgeWanted()) return;
    drawEdge();
    if (edgeVideo && !edgeVideo.paused && !edgeVideo.ended) edgeFrame = requestAnimationFrame(edgeTick);
  }

  // Paused: draw once now and once more when the next frame is presented
  // (after a seek the new frame arrives a little later).
  function drawEdgeOnce() {
    if (edgeFrame) return;
    drawEdge();
    try { edgeVideo?.requestVideoFrameCallback?.(() => { if (!edgeFrame) drawEdge(); }); } catch {}
  }

  function onEdgeVideoEvent(event) {
    if (!edge) return;
    if (event.type === 'resize' || event.type === 'loadeddata') measureEdge();
    if (!edgeVideo.paused && !edgeFrame) edgeFrame = requestAnimationFrame(edgeTick);
    else drawEdgeOnce();
  }

  const EDGE_EVENTS = ['play', 'playing', 'pause', 'seeked', 'loadeddata', 'resize', 'emptied'];

  function watchEdgeVideo(video) {
    if (edgeVideo === video) return;
    if (edgeVideo) EDGE_EVENTS.forEach((name) => edgeVideo.removeEventListener(name, onEdgeVideoEvent));
    edgeVideo = video;
    if (video) EDGE_EVENTS.forEach((name) => video.addEventListener(name, onEdgeVideoEvent));
  }

  function stopEdgeMirror() {
    if (edgeFrame) cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
    watchEdgeVideo(null);
    edgeObserver?.disconnect();
    edgeObserver = null;
    if (edge) {
      try { edge.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
      edge.canvas.remove();
    }
    edge = null;
    document.querySelector('#still-youtube-edge-mirror')?.remove();
  }

  function startEdgeMirror() {
    if (!edgeWanted()) {
      if (edgeFrame) cancelAnimationFrame(edgeFrame);
      edgeFrame = 0;
      if (edge) edge.canvas.style.display = 'none';
      if (!isWatchPage() || !playerLabSettings.mirror) stopEdgeMirror();
      return;
    }
    const player = document.querySelector('#movie_player');
    const video = currentVideo();
    if (!player || !video) return;
    if (edge && (edge.player !== player || !edge.canvas.isConnected)) stopEdgeMirror();
    if (!edge) {
      try { edge = createEdgeRenderer(player); } catch { edge = null; }
      if (!edge) return;
      edgeObserver = new ResizeObserver(() => { if (measureEdge()) drawEdgeOnce(); });
      edgeObserver.observe(player);
    }
    watchEdgeVideo(video);
    if (!measureEdge()) return;
    if (!video.paused && !video.ended) {
      if (!edgeFrame) edgeFrame = requestAnimationFrame(edgeTick);
    } else {
      drawEdgeOnce();
    }
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
      startEdgeMirror();
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
      startEdgeMirror();
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
    startEdgeMirror();
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
  window.addEventListener('resize', () => startEdgeMirror());
  document.addEventListener('fullscreenchange', () => startEdgeMirror());
  document.addEventListener('visibilitychange', () => startEdgeMirror());
  window.addEventListener('scroll', positionCurrentPanel, true);
  window.addEventListener('scroll', positionCurrentTooltip, true);
  window.addEventListener('scroll', positionPlayerLabPanel, true);
  // A playlist or live chat keeps the side column; recommendations never do.
  let sidePanelFrame = 0;
  function updateSidePanel() {
    sidePanelFrame = 0;
    const secondary = isWatchPage() && document.querySelector('ytd-watch-flexy #secondary');
    const playlist = secondary?.querySelector('ytd-playlist-panel-renderer:not([hidden]) #items > *');
    const chat = secondary?.querySelector('ytd-live-chat-frame:not([hidden])');
    document.documentElement.classList.toggle('still-youtube-side-panel', Boolean(playlist || chat));
  }
  // YouTube's fullscreen grid of more videos opens on scroll. Keep the wheel
  // away from the player in fullscreen so it never slides up.
  document.addEventListener('wheel', (event) => {
    if (document.fullscreenElement && event.target?.closest?.('#movie_player')) event.stopImmediatePropagation();
  }, { capture: true, passive: true });
  mountObserver = new MutationObserver(() => {
    if (!sidePanelFrame) sidePanelFrame = requestAnimationFrame(updateSidePanel);
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
