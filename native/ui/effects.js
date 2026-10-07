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
    }
    cancel() {
      this.generation++;
      if (this.frame) this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.animation?.cancel();
      this.animation = null;
      this.target?.removeAttribute('still-entering');
      this.outgoing?.removeAttribute('still-exiting');
      this.panel.removeAttribute('still-transition');
      this.target = this.outgoing = this.pendingTab = null;
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
    prepare(tab, previousTab, direction = 1) {
      this.cancel();
      const mode = this.win.Services.prefs.getStringPref('still.motion', 'elastic');
      if (this.win.document.hidden || this.win.matchMedia('(prefers-reduced-motion: reduce)').matches || mode === 'off') return;
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
      this.panel.setAttribute('still-transition', '');
      target.setAttribute('still-entering', '');
      const distance = `${sign * 100}%`;
      const squash = mode === 'slide' ? '' : ' scaleX(.992) scaleY(1.004)';
      const transformOrigin = sign > 0 ? 'left center' : 'right center';
      const speed = this.win.Services.prefs.getStringPref('still.motion.speed', 'smooth');
      const duration = ({ fast: 240, normal: 400, smooth: 560 })[speed] || 560;
      const timing = { duration, easing: 'cubic-bezier(.32,0,.2,1)', fill: 'both' };
      this.animation = target.animate([
        { transform: `translateX(${distance})${squash}`, transformOrigin },
        { transform: 'translateX(0) scale(1)', transformOrigin }
      ], timing);
      this.animation.pause();
      if (paired) {
        this.outgoing = outgoing;
        outgoing.setAttribute('still-exiting', '');
        // Keep the full cached surface underneath until the incoming page
        // covers it. Fractional scaling and cold paints cannot open a seam.
      }
      const token = this.generation;
      this.animation.onfinish = () => { if (token === this.generation) this.cancel(); };
      // A hung/cold tab must never leave an overlay or paused animation behind.
      this.readyTimer = this.win.setTimeout(() => { if (token === this.generation) this.cancel(); }, 700);
    }
    present(tab) {
      if (tab !== this.pendingTab || this.animation?.playState !== 'paused' || this.panel.selectedPanel !== this.target) return;
      const browser = tab.linkedBrowser;
      if (!browser.hasLayers || browser.hasAttribute('blank') || browser.hasAttribute('pendingpaint')) return;
      this.win.clearTimeout(this.readyTimer); this.readyTimer = 0;
      this.animation.play();
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
