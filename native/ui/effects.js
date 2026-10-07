/* Short-lived chrome effects. Webpages always use Gecko's native compositor. */
(function () {
  'use strict';
  class StillEffects {
    constructor(win, canvas, panel) {
      this.win = win;
      this.canvas = canvas;
      this.panel = panel;
      this.animation = null;
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
    play(direction = 1) {
      this.cancel();
      const mode = this.win.Services.prefs.getStringPref('still.motion', 'elastic');
      if (this.win.matchMedia('(prefers-reduced-motion: reduce)').matches || mode === 'off') return;
      const sign = Math.sign(direction) || 1;
      const frames = mode === 'elastic' || mode === 'ripple'
        ? [
          { transform: `translateX(${sign * 24}px) scaleX(.983) scaleY(1.009)`, offset: 0 },
          { transform: `translateX(${-sign * 3}px) scaleX(1.004) scaleY(.998)`, offset: .65 },
          { transform: 'translateX(0) scale(1)', offset: 1 }
        ]
        : [{ transform: `translateX(${sign * 18}px)` }, { transform: 'translateX(0)' }];
      this.animation = this.panel.animate(frames, { duration: mode === 'slide' ? 150 : 200, easing: 'cubic-bezier(.16,1,.3,1)' });
      this.animation.onfinish = () => { this.animation = null; };
      if (mode !== 'ripple' || !this.initialize()) return;
      const scale = Math.min(this.win.devicePixelRatio || 1, 1.5);
      const width = Math.ceil(this.win.innerWidth * scale), height = Math.ceil(this.win.innerHeight * scale);
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl.uniform1f(this.direction, direction);
      this.canvas.hidden = false;
      const began = this.win.performance.now(), token = this.generation;
      const draw = (now) => {
        if (token !== this.generation) return;
        const progress = Math.min(1, (now - began) / 220);
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
