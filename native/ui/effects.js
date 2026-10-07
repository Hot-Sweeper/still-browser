/* Short-lived chrome effects. Webpages always use Gecko's native compositor. */
(function () {
  'use strict';
  class StillEffects {
    constructor(win, canvas, panel) {
      this.win = win;
      this.canvas = canvas;
      this.panel = panel;
      this.animation = null;
      this.target = null;
      this.outgoing = null;
      this.pendingTab = null;
      this.readyTimer = 0;
      this.frame = 0;
      this.gl = null;
      this.failed = false;
      this.generation = 0;
      this.panels = [];
      this.stretch = null;
    }
    cancel() {
      this.generation++;
      if (this.frame) this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.animation?.cancel();
      this.animation = null;
      this.stretch?.cancel(); this.stretch = null;
      for (const panel of this.panels) {
        panel.removeAttribute('still-strip-panel');
        panel.style.removeProperty('--still-strip-index');
      }
      this.panels = [];
      this.panel.parentElement.removeAttribute('still-strip-viewport');
      this.target?.removeAttribute('still-entering');
      this.outgoing?.removeAttribute('still-exiting');
      this.panel.removeAttribute('still-transition');
      this.target = this.outgoing = this.pendingTab = null;
      this.edge = 0; this.queuedEdge = 0;
      this.required = [];
      this.win.clearTimeout(this.readyTimer);
      this.readyTimer = 0;
      this.canvas.hidden = true;
    }
    initialize() {
      if (this.gl || this.failed) return Boolean(this.gl);
      try {
        const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, preserveDrawingBuffer: false });
        if (!gl) throw new Error('WebGL unavailable');
        const compile = (type, text) => {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, text);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
          return shader;
        };
        const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 a; varying vec2 uv; void main(){uv=a*.5+.5;gl_Position=vec4(a,0.,1.);}');
        const fragment = compile(gl.FRAGMENT_SHADER, `precision mediump float;
          varying vec2 uv; uniform float t; uniform float direction;
          void main(){
            float x=direction>0.?uv.x:1.-uv.x;
            float wave=sin(uv.y*8.+t*5.)*.016;
            float ridge=exp(-pow((x-t*1.25-wave)*12.,2.));
            float envelope=sin(t*3.14159265);
            vec3 tint=mix(vec3(.58,.70,.65),vec3(.83,.90,.86),uv.y);
            gl_FragColor=vec4(tint,ridge*envelope*.12);
          }`);
        const program = gl.createProgram();
        gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
        gl.deleteShader(vertex); gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
        const a = gl.getAttribLocation(program, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
        this.gl = gl; this.program = program; this.buffer = buffer;
        this.time = gl.getUniformLocation(program, 't'); this.direction = gl.getUniformLocation(program, 'direction');
        this.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.cancel(); this.gl = null; this.failed = true; });
        return true;
      } catch { this.failed = true; return false; }
    }
    position(fallback) {
      if (!this.animation) return fallback;
      const width = this.panel.getBoundingClientRect().width;
      return width ? -new this.win.DOMMatrixReadOnly(this.win.getComputedStyle(this.panel).transform).m41 / width : fallback;
    }
    stage(slots) {
      this.slots = slots.slice();
      this.panel.parentElement.setAttribute('still-strip-viewport', '');
      this.panel.setAttribute('still-transition', '');
      this.panels = slots.map((tab, index) => {
        const panel = this.win.gBrowser.tabContainer.getRelatedElement(tab);
        panel.style.setProperty('--still-strip-index', index);
        panel.setAttribute('still-strip-panel', '');
        return panel;
      });
    }
    enabled() {
      return !this.win.document.hidden && !this.win.matchMedia('(prefers-reduced-motion: reduce)').matches &&
        this.win.Services.prefs.getStringPref('still.motion', 'elastic') !== 'off';
    }
    prepare(tab, previousTab, direction = 1, slots) {
      const from = this.position(slots.indexOf(previousTab));
      this.cancel();
      const mode = this.win.Services.prefs.getStringPref('still.motion', 'elastic');
      if (!this.enabled() || slots.indexOf(previousTab) < 0) return;
      const target = this.win.gBrowser.tabContainer.getRelatedElement(tab);
      if (!target || target.classList.contains('split-view-panel')) return;
      const outgoing = previousTab && !previousTab.closing && previousTab.linkedBrowser?.hasLayers
        ? this.win.gBrowser.tabContainer.getRelatedElement(previousTab) : null;
      const sign = Math.sign(direction) || 1;
      const paired = outgoing && outgoing !== target && !outgoing.classList.contains('split-view-panel');
      // A discarded/closing previous tab has no reliable surface to cover the
      // viewport. Leave that cold switch entirely to Gecko instead of exposing
      // a blank strip underneath an incoming transform.
      if (!paired) return;
      this.target = target; this.pendingTab = tab; this.directionSign = sign; this.mode = mode;
      const to = slots.indexOf(tab);
      this.stage(slots);
      this.required = slots.slice(Math.max(0, Math.floor(Math.min(from, to))), Math.min(slots.length, Math.ceil(Math.max(from, to)) + 1));
      for (const item of this.required) if (item !== tab) this.win.gBrowser.warmupTab(item);
      const speed = this.win.Services.prefs.getStringPref('still.motion.speed', 'smooth');
      const duration = ({ fast: 240, normal: 400, smooth: 560 })[speed] || 560;
      const timing = { duration, easing: 'cubic-bezier(.32,0,.2,1)', fill: 'both' };
      let keys = [
        { transform: `translateX(${-from * 100}%)` },
        { transform: `translateX(${-to * 100}%)` }
      ];
      // Retargeting an end pull keeps its expanded edge until the camera is
      // back inside the row, so interruption cannot expose an empty gutter.
      if (from < 0 || from > slots.length - 1) {
        const boundary = from < 0 ? 0 : slots.length - 1;
        const stretch = []; keys = [];
        for (let step = 0; step <= 60; step++) {
          const t = step / 60;
          let lo = 0, hi = 1;
          for (let n = 0; n < 16; n++) {
            const u = (lo + hi) / 2;
            const x = 3 * (1-u)**2 * u * .32 + 3 * (1-u) * u**2 * .2 + u**3;
            if (x < t) lo = u; else hi = u;
          }
          const u = (lo + hi) / 2;
          const progress = step === 0 ? 0 : step === 60 ? 1 : 3 * (1-u) * u**2 + u**3;
          const position = from + (to - from) * progress;
          const expansion = boundary === 0 ? Math.max(0, -position) : Math.max(0, position - boundary);
          keys.push({ offset: t, transform: `translateX(${-position * 100}%)` });
          stretch.push({ offset: t, transform: `translateX(${boundary * 100}%) scaleX(${1 + expansion})`, transformOrigin: boundary === 0 ? 'right center' : 'left center' });
        }
        timing.easing = 'linear';
        this.stretch = this.panels[boundary].animate(stretch, timing);
        this.stretch.pause();
      }
      this.animation = this.panel.animate(keys, timing);
      this.animation.pause();
      if (paired) {
        this.outgoing = outgoing;
      }
      const token = this.generation;
      this.animation.onfinish = () => {
        if (token !== this.generation) return;
        const edge = this.queuedEdge;
        this.cancel();
        if (edge) this.bump(edge, slots, to);
      };
      // A hung/cold tab must never leave an overlay or paused animation behind.
      this.readyTimer = this.win.setTimeout(() => { if (token === this.generation) this.cancel(); }, 700);
      const poll = () => {
        if (token !== this.generation || this.animation?.playState !== 'paused') return;
        this.present(tab);
        if (this.animation?.playState === 'paused') this.frame = this.win.requestAnimationFrame(poll);
      };
      this.frame = this.win.requestAnimationFrame(poll);
    }
    bump(direction, slots, index) {
      if (!this.enabled() || this.edge === direction) return;
      if (this.animation && !this.edge) { this.queuedEdge = direction; return; }
      if (!slots[index]?.linkedBrowser.hasLayers) return;
      this.cancel(); this.edge = direction;
      this.stage(slots);
      this.target = this.panels[index];
      const width = this.panel.getBoundingClientRect().width;
      const pull = Math.min(96, width * .065);
      const adjacent = slots[index - direction];
      const canRebound = adjacent?.linkedBrowser.hasLayers && !adjacent.linkedBrowser.hasAttribute('blank');
      if (adjacent) this.win.gBrowser.warmupTab(adjacent);
      const keys = [], stretch = [];
      // A damped impulse: restrained pull, a small rebound, then rest.
      for (let step = 0; step <= 60; step++) {
        const t = step / 60;
        const impulse = Math.exp(-5.5 * t) * Math.sin(t * 10) / .46;
        const displacement = step === 60 ? 0 : -direction * pull * (canRebound ? impulse : Math.max(0, impulse));
        keys.push({ offset: t, transform: `translateX(calc(${-index * 100}% + ${displacement}px))` });
        stretch.push({ offset: t, transform: `translateX(${index * 100}%) scaleX(${1 + Math.max(0, -direction * displacement) / width})`, transformOrigin: direction < 0 ? 'right center' : 'left center' });
      }
      const timing = { duration: 680, fill: 'both', easing: 'linear' };
      this.animation = this.panel.animate(keys, timing);
      this.stretch = this.target.animate(stretch, timing);
      const token = this.generation;
      this.animation.onfinish = () => { if (token === this.generation) this.cancel(); };
    }
    present(tab) {
      if (tab !== this.pendingTab || this.animation?.playState !== 'paused' || this.panel.selectedPanel !== this.target) return;
      const browser = tab.linkedBrowser;
      if (!browser.hasLayers || browser.hasAttribute('blank') || browser.hasAttribute('pendingpaint')) return;
      if (this.required.some(item => !item.linkedBrowser.hasLayers || item.linkedBrowser.hasAttribute('blank') || item.linkedBrowser.hasAttribute('pendingpaint'))) return;
      this.win.clearTimeout(this.readyTimer); this.readyTimer = 0;
      if (this.frame) this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.animation.play();
      this.stretch?.play();
      const mode = this.mode, direction = this.directionSign;
      if (mode !== 'ripple' || !this.initialize()) return;
      const scale = Math.min(this.win.devicePixelRatio || 1, 1.5);
      const width = Math.ceil(this.win.innerWidth * scale), height = Math.ceil(this.win.innerHeight * scale);
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl.uniform1f(this.direction, direction);
      this.canvas.hidden = false;
      const began = this.win.performance.now(), token = this.generation;
      const duration = this.animation.effect.getTiming().duration;
      const draw = (now) => {
        if (token !== this.generation) return;
        const progress = Math.min(1, (now - began) / duration);
        this.gl.uniform1f(this.time, progress);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        if (progress < 1) this.frame = this.win.requestAnimationFrame(draw);
        else { this.frame = 0; this.canvas.hidden = true; }
      };
      this.frame = this.win.requestAnimationFrame(draw);
    }
    destroy() {
      this.cancel();
      if (this.gl) { this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program); }
      this.gl = null;
    }
  }
  window.StillEffects = StillEffects;
})();
