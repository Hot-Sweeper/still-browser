// Visual checks for the Still window layer. Opens a disposable profile,
// drives the UI through Marionette, and captures the real window so live
// page layers and glass effects are visible. Output: firefox/.local/checks/
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./session');

const out = path.join(__dirname, '..', '.local', 'checks');
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Full-window animated WebGL shader, label drawn on top.
function shaderPage(hue, label) {
  const html = `<body style="margin:0;overflow:hidden;background:#000"><canvas id=c style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>
<div style="position:fixed;inset:0;display:grid;place-items:center;color:#fff;font:700 110px Segoe UI">${label}</div><script>
const c=document.getElementById('c'),g=c.getContext('webgl');
const fit=()=>{c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;g.viewport(0,0,c.width,c.height)};fit();onresize=fit;
const sh=(t,s)=>{const o=g.createShader(t);g.shaderSource(o,s);g.compileShader(o);return o};
const p=g.createProgram();g.attachShader(p,sh(g.VERTEX_SHADER,'attribute vec2 a;void main(){gl_Position=vec4(a,0,1);}'));
g.attachShader(p,sh(g.FRAGMENT_SHADER,'precision highp float;uniform float t;uniform vec2 r;void main(){vec2 u=gl_FragCoord.xy/r;float v=0.;for(int i=0;i<24;i++){float f=float(i);v+=sin(u.x*(9.+f)+t*1.3+f)*cos(u.y*(7.+f)-t+f*.7);}gl_FragColor=vec4(.5+.5*cos(${hue}.+v*.4+vec3(0,2,4)),1);}'));
g.linkProgram(p);g.useProgram(p);const b=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,b);g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),g.STATIC_DRAW);
const l=g.getAttribLocation(p,'a');g.enableVertexAttribArray(l);g.vertexAttribPointer(l,2,g.FLOAT,false,0,0);
const T=g.getUniformLocation(p,'t'),R=g.getUniformLocation(p,'r');window.frames=0;
(function f(n){g.uniform1f(T,n/1000);g.uniform2f(R,c.width,c.height);g.drawArrays(g.TRIANGLES,0,3);window.frames++;requestAnimationFrame(f)})(0);
</script></body>`;
  return 'data:text/html,' + encodeURIComponent(html);
}

function page(color, label) {
  return `data:text/html,<body style="margin:0;background:${color};color:white;font:700 120px Segoe UI;display:grid;place-items:center;height:100vh">${label}</body>`;
}

async function main() {
  const wanted = (process.argv[2] || 'slide').split(',');
  const s = await launch({ imports: wanted.includes('import') || wanted.includes('mine') });
  const m = s.marionette;
  let pid = 0;
  const capture = (name) => {
    const file = path.join(out, `${name}.png`);
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'capture.ps1'), String(pid), file]);
    console.log('captured', file);
  };
  try {
    await m.chrome();
    await wait(2500);
    pid = await m.run('return Services.appinfo.processID;');
    const steps = (process.argv[2] || 'slide').split(',');
    await m.run(`
      const urls = arguments[0];
      gBrowser.selectedBrowser.fixupAndLoadURIString(urls[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      for (const url of urls.slice(1)) gBrowser.addTrustedTab(url);
      gBrowser.selectedTab = gBrowser.tabs[0];
    `, [[page('%23b4462c', 'ONE'), page('%232c6cb4', 'TWO'), page('%232c8f55', 'THREE')]]);
    await wait(1800);
    if (steps.includes('bar')) {
      await m.run('StillChrome.state && document.querySelector("#still-reveal").dispatchEvent(new MouseEvent("mouseenter", { clientX: 300 }));');
      await wait(700);
      capture('bar-open');
    }
    if (steps.includes('slide')) {
      // Visit all tabs once so their layers are cached, then freeze a slide mid-way.
      for (const i of [1, 2, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(500); }
      const info = await m.run(`
        StillChrome.activate(gBrowser.tabs[1], 1);
        const slide = StillChrome.state.slide;
        if (!slide) return "no slide started";
        slide.animations.forEach((a) => { a.pause(); a.currentTime = 90; });
        return "paused";
      `);
      console.log('slide:', info);
      await wait(400);
      capture('slide-mid');
      await m.run('StillChrome.state.slide?.animations.forEach((a) => a.finish());');
      await wait(300);
      capture('slide-done');
    }
    if (steps.includes('blur')) {
      await m.run(`
        const make = (parent, left) => { const d = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
          d.style.cssText = 'position:absolute;top:300px;left:' + left + 'px;width:420px;height:300px;backdrop-filter:blur(18px);background:rgba(0,0,0,.1);z-index:10;pointer-events:none';
          parent.append(d); };
        make(gBrowser.selectedBrowser.closest('.browserStack'), 200);
        make(document.querySelector('#still-layer'), 900);
      `);
      await wait(500);
      capture('blur');
    }
    if (steps.includes('newtab')) {
      await m.run('BrowserCommands.openTab();');
      await wait(1800);
      console.log('system mouse hook running (want false):', require('node:child_process').execSync('tasklist /FI "IMAGENAME eq mouse-navigation-helper.exe" /NH').toString().includes('mouse-navigation'));
      console.log('open popups:', await m.run('return [...document.querySelectorAll("panel, menupopup")].filter((p) => p.state === "open" || p.state === "showing").map((p) => p.id);'));
      console.log('hidden urlbar focused:', await m.run('return gURLBar.focused;'), 'title:', await m.run('return document.title;'));
      console.log('newtab url:', await m.run('return gBrowser.selectedBrowser.currentURI.spec;'));
      capture('newtab');
    }
    if (steps.includes('youtube')) {
      await m.run(`gBrowser.selectedBrowser.fixupAndLoadURIString('https://www.youtube.com/', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(9000);
      capture('youtube');
      await m.run('document.querySelector("#still-reveal").dispatchEvent(new MouseEvent("mouseenter", { clientX: 300 }));');
      await wait(900);
      capture('youtube-bar');
    }
    if (steps.includes('import')) {
      await wait(2500);
      console.log('import:', await m.runAsync(`const done = arguments[0];
        const count = (host) => [...Services.cookies.getCookiesFromHost(host, {})].length;
        const before = count('youtube.com') + count('.youtube.com');
        (async () => {
          const report = Services.prefs.getBoolPref('still.import.electron.done', false) ? null : 'auto pending';
          await new Promise((r) => setTimeout(r, 3000));
          done({ autoRan: Services.prefs.getBoolPref('still.import.electron.done', false), before,
            youtube: count('youtube.com') + count('.youtube.com'), google: count('google.com') + count('.google.com'),
            loginCookie: Services.cookies.cookieExists('.youtube.com', '/', 'LOGIN_INFO', {}) });
        })();`));
      capture('import-toast');
    }
    if (steps.includes('reveal')) {
      // Pretend the cursor is at the top edge; the bar must open, then close when it leaves.
      console.log('cursor reading:', JSON.stringify(await m.run(`return ChromeUtils.importESModule("resource://still/StillShared.sys.mjs").StillShared.cursorInWindow(window);`)));
      const r = await m.runAsync(`const done = arguments[0];
        const shared = ChromeUtils.importESModule("resource://still/StillShared.sys.mjs").StillShared;
        const real = shared.cursorInWindow;
        shared.cursorInWindow = () => ({ x: 400, y: 2, width: 1900, height: 1500 });
        setTimeout(() => {
          const opened = document.querySelector('#still-chrome').classList.contains('open');
          shared.cursorInWindow = () => ({ x: 400, y: 600, width: 1900, height: 1500 });
          setTimeout(() => { shared.cursorInWindow = real; done({ opened, closed: !document.querySelector('#still-chrome').classList.contains('open') }); }, 900);
        }, 300);`);
      console.log('reveal:', JSON.stringify(r));
    }
    if (steps.includes('color')) {
      await m.run(`gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [page('%23113355', 'COLOR')]);
      await wait(2500);
      console.log('page colour:', await m.run(`return [gBrowser.selectedBrowser.stillColor, getComputedStyle(gBrowser.selectedBrowser.closest('.browserContainer')).backgroundColor, gBrowser.tabpanels.style.backgroundColor].join(' | ');`));
    }
    if (steps.includes('search')) {
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[0]; gBrowser.selectedBrowser.fixupAndLoadURIString(BROWSER_NEW_TAB_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(2500);
      await m.content();
      await m.run(`const i = document.querySelector('#search-input'); i.focus(); i.value = 'git'; i.dispatchEvent(new Event('input'));`);
      await m.chrome();
      await m.run(`PlacesUtils.history.insertMany([{ url: 'https://github.com/', title: 'GitHub', visits: [{ date: new Date() }] }]);`);
      await m.content();
      await m.run(`const i = document.querySelector('#search-input'); i.value = 'gi'; i.dispatchEvent(new Event('input')); i.value = 'git'; i.dispatchEvent(new Event('input'));`);
      await wait(500);
      capture('start-suggest');
      const timing = await m.runAsync(`const done = arguments[0];
        const i = document.querySelector('#search-input'); i.value = 'firefox webrender compositor';
        const t0 = performance.now();
        document.querySelector('#search-form').requestSubmit();
        const shell = performance.now() - t0;
        const poll = () => { const r = document.querySelector('.result, .notice'); if (r) done({ shellMs: Math.round(shell), resultsMs: Math.round(performance.now() - t0), kind: r.className, count: document.querySelectorAll('.result').length, url: location.search }); else requestAnimationFrame(poll); };
        requestAnimationFrame(() => { window.__skeleton = !!document.querySelector('.skeleton'); poll(); });`);
      console.log('search timing:', JSON.stringify(timing));
      await wait(250);
      capture('start-results');
      await m.run('history.back();');
      await wait(700);
      console.log('after back:', await m.run('return document.documentElement.dataset.view + " " + location.search;'));
      await m.chrome();
      console.log('slot title:', await m.run('return document.querySelector("#still-chrome .slot.active .slot-title")?.textContent;'));
    }
    if (steps.includes('categories')) {
      // One real search per kind of result, so search engines are not hammered.
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[0]; gBrowser.selectedBrowser.fixupAndLoadURIString(BROWSER_NEW_TAB_URL + '?q=' + encodeURIComponent('mozilla firefox'), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await m.content();
      const waitFor = async (selector, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await m.run(`return Boolean(document.querySelector(arguments[0]));`, [selector])) return true; await wait(150); } return false; };
      console.log('all:', await waitFor('.result, .notice'), 'infobox:', await m.run('return !document.querySelector("#infobox").hidden;'));
      await wait(900);
      capture('search-all');
      await m.run(`document.querySelector('[data-category="images"]').click();`);
      console.log('images:', await waitFor('.image-tile, .notice'));
      await wait(1800);
      capture('search-images');
      await m.run(`document.querySelector('.image-tile')?.click();`);
      await wait(900);
      console.log('lightbox open:', await m.run('return !document.querySelector("#lightbox").hidden;'));
      capture('search-lightbox');
      await m.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
      await m.run(`document.querySelector('[data-category="videos"]').click();`);
      console.log('videos:', await waitFor('.result.video, .notice'));
      await wait(1500);
      capture('search-videos');
      await m.run(`document.querySelector('[data-category="news"]').click();`);
      console.log('news:', await waitFor('.result.news, .notice'));
      await wait(1200);
      capture('search-news');
      console.log('url:', await m.run('return location.search;'));
      await m.chrome();
      // A SearXNG page opened directly must land in Still Search instead.
      await m.run(`gBrowser.selectedBrowser.fixupAndLoadURIString('http://127.0.0.1:48230/search?q=still+redirect&categories=images', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(1500);
      console.log('redirected to:', await m.run('return gBrowser.selectedBrowser.currentURI.spec.replace(/^moz-extension:\\/\\/[^/]+/, "moz-extension://...");'));
    }
    if (steps.includes('startbox')) {
      await m.run(`gBrowser.selectedBrowser.fixupAndLoadURIString(BROWSER_NEW_TAB_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(2200);
      capture('start-box-focused');
      await m.content();
      await m.run('document.activeElement.blur();');
      await m.chrome();
      await wait(400);
      capture('start-box-idle');
      await m.run(`Services.prefs.setIntPref('ui.systemUsesDarkTheme', 0); Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', 1);`);
      await wait(900);
      capture('start-box-light');
    }
    if (steps.includes('sheet')) {
      await m.run(`document.querySelector('#still-reveal').dispatchEvent(new MouseEvent('mouseenter', { clientX: 900 }));`);
      await wait(500);
      await m.run(`document.querySelector('#still-chrome .slot.empty')?.click();`);
      await wait(1500);
      console.log('new slot:', JSON.stringify(await m.run(`return { sheet: Boolean(document.querySelector('.address-sheet')), url: gBrowser.selectedBrowser.currentURI.spec.slice(0, 16), browserFocused: document.activeElement === gBrowser.selectedBrowser };`)));
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[1];`);
      await wait(600);
      await m.run(`StillChrome.beginEdit(gBrowser.selectedTab); const i = document.querySelector('.slot-inline input'); i.value = 'git'; i.dispatchEvent(new Event('input'));`);
      await wait(700);
      console.log('sheet below row:', await m.run(`const r = document.querySelector('.slot-row').getBoundingClientRect(); const s = document.querySelector('.address-sheet').getBoundingClientRect(); return Math.round(s.top - r.bottom);`));
      capture('address-sheet');
      console.log('window move call:', await m.run(`return ChromeUtils.importESModule("resource://still/StillShared.sys.mjs").StillShared.startWindowMove(window);`));
    }
    if (steps.includes('suggestui')) {
      await m.run(`PlacesUtils.history.insertMany([
        { url: 'https://www.youtube.com/', title: '(24) YouTube', visits: [{ date: new Date() }, { date: new Date(Date.now() - 86400000) }] },
        { url: 'https://www.youtube.com/@Cytrena', title: 'Cytrena - YouTube', visits: [{ date: new Date() }] },
        { url: 'https://www.youtube.com/watch?v=abc', title: 'A very long video title that keeps going and going to test how truncation behaves in the row', visits: [{ date: new Date() }] }]);`);
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[0]; gBrowser.selectedBrowser.fixupAndLoadURIString(BROWSER_NEW_TAB_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(1800);
      await m.content();
      await m.run(`const i = document.querySelector('#search-input'); i.focus(); i.value = 'ddvsdv'; i.dispatchEvent(new Event('input'));`);
      await wait(600);
      console.log('no-match list shown:', await m.run('return !document.querySelector("#suggestions").hidden;'));
      await m.run(`const i = document.querySelector('#search-input'); i.value = 'you'; i.dispatchEvent(new Event('input'));`);
      await wait(1200);
      console.log('rows:', JSON.stringify(await m.run(`return [...document.querySelectorAll('#suggestions .suggestion')].map((n) => n.querySelector('.title').textContent + ' | ' + n.querySelector('.detail').textContent);`)));
      await m.chrome();
      capture('suggest-ui');
    }
    if (steps.includes('peek')) {
      for (const i of [1, 2, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(700); }
      await m.run(`StillChrome.onWheelGesture('slots', 1);`);
      await wait(700);
      capture('peek-settled');
      const mid = await m.run(`StillChrome.onWheelGesture('slots', 1);
        return new Promise((r) => setTimeout(() => { const a = document.querySelector('.slot-aurora');
          const pills = [...document.querySelectorAll('#still-chrome .slot')].map((p) => Math.round(p.offsetLeft));
          r({ aurora: getComputedStyle(a).transform, opacity: getComputedStyle(a).opacity, pills, open: document.querySelector('#still-chrome').className }); }, 120));`);
      console.log('peek mid-glide:', JSON.stringify(mid));
      capture('peek-mid');
      await wait(1600);
      console.log('after peek:', await m.run(`return document.querySelector('#still-chrome').className;`));
    }
    if (steps.includes('wheel')) {
      // A real Ctrl+wheel over page content: it should switch slots (through
      // the page helper, no system hook) and never zoom the page.
      await m.run('gBrowser.selectedTab = gBrowser.tabs[0];');
      await wait(800);
      const result = await m.runAsync(`const done = arguments[0];
        const before = gBrowser.tabs.indexOf(gBrowser.selectedTab);
        const rect = gBrowser.selectedBrowser.getBoundingClientRect();
        const send = (mods) => window.windowUtils.sendWheelEvent(rect.left + rect.width / 2, rect.top + rect.height / 2, 0, 3, 0, 1, mods, 0, 0, 0);
        send(Ci.nsIDOMWindowUtils.MODIFIER_CONTROL);
        setTimeout(() => {
          const after = gBrowser.tabs.indexOf(gBrowser.selectedTab);
          done({ before, after, zoom: ZoomManager.getZoomForBrowser(gBrowser.selectedBrowser) });
        }, 900);`);
      console.log('ctrl+wheel over page:', JSON.stringify(result));
      // A fast spin: three notches 35 ms apart should move three slots, with
      // the selection fill riding the strip.
      await m.run(`while (gBrowser.tabs.length < 5) gBrowser.addTrustedTab(arguments[0]); gBrowser.selectedTab = gBrowser.tabs[0];`, [page('%23aa7722', 'MORE')]);
      await wait(1500);
      const spin = await m.runAsync(`const done = arguments[0];
        const rect = gBrowser.selectedBrowser.getBoundingClientRect();
        const send = () => window.windowUtils.sendWheelEvent(rect.left + rect.width / 2, rect.top + rect.height / 2, 0, 3, 0, 1, Ci.nsIDOMWindowUtils.MODIFIER_CONTROL, 0, 0, 0);
        const row = document.querySelector('#still-chrome .slot-row');
        const track = [];
        send(); setTimeout(send, 35); setTimeout(send, 70);
        const start = performance.now();
        const tick = () => {
          const cs = getComputedStyle(row);
          track.push(Math.round(parseFloat(cs.getPropertyValue('--still-shimmer-x'))) + '/' + (+cs.getPropertyValue('--still-shimmer-alpha')).toFixed(2));
          if (performance.now() - start < 900) requestAnimationFrame(tick);
          else done({ selected: gBrowser.tabs.indexOf(gBrowser.selectedTab), shimmer: track.filter((_, i) => i % 8 === 0).join(' ') });
        };
        requestAnimationFrame(tick);`);
      console.log('fast spin:', JSON.stringify(spin));
    }
    if (steps.includes('shimmer')) {
      // Freeze a switch partway and capture the sweep.
      await m.run(`while (gBrowser.tabs.length < 5) gBrowser.addTrustedTab(arguments[0]); gBrowser.selectedTab = gBrowser.tabs[1];`, [page('%23aa7722', 'MORE')]);
      await wait(1500);
      for (const at of [0.1, 0.22]) {
        console.log('shimmer at', at, await m.runAsync(`const done = arguments[arguments.length - 1]; const at = arguments[0];
          document.querySelector('#still-reveal').dispatchEvent(new MouseEvent('mouseenter', { clientX: 600 }));
          setTimeout(() => {
          StillChrome.onWheelGesture('slots', 1);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const all = [...(StillChrome.state.strip?.animations || []), ...document.querySelector('#still-chrome .slot-row').getAnimations()];
            all.forEach((a) => { a.pause(); a.currentTime = (a.effect.getTiming().duration) * at; });
            const cs = getComputedStyle(document.querySelector('#still-chrome .slot-row'));
            done(cs.getPropertyValue('--still-shimmer-x') + ' ' + cs.getPropertyValue('--still-shimmer-alpha') + ' ' + document.querySelector('#still-chrome').className);
          }));
          }, 700);`, [at]));
        await wait(150);
        capture('shimmer-' + Math.round(at * 100));
        await m.run(`[...(StillChrome.state.strip?.animations || []), ...document.querySelector('#still-chrome .slot-row').getAnimations()].forEach((a) => a.finish());`);
        await m.run('gBrowser.selectedTab = gBrowser.tabs[1];');
        await wait(1500);
      }
    }
    if (steps.includes('soul')) {
      for (const i of [1, 2, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(700); }
      await m.run(`StillChrome.onWheelGesture('slots', 1);`);
      await wait(900);
      for (const at of [0.25, 0.5, 0.75]) {
        await m.run(`StillChrome.onWheelGesture('slots', arguments[1]);
          return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
            const s = StillChrome.state.soul; if (!s) return r('none');
            s.animations.forEach((a) => { a.pause(); a.currentTime = s.duration * 1000 * arguments[0]; }); r('paused'); })));`, [at, at === 0.5 ? -1 : 1]);
        await wait(250);
        capture('soul-' + Math.round(at * 100));
        await m.run('StillChrome.state.soul?.animations.forEach((a) => a.finish());');
        await wait(500);
      }
      await wait(150);
      capture('soul-landed');
    }
    if (steps.includes('light')) {
      for (const i of [1, 2, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(700); }
      await m.run(`StillChrome.onWheelGesture('slots', 1);`);
      await wait(700);
      console.log('bar at rest capture:', await m.run(`return document.querySelector('#still-chrome').className + ' | soul ' + getComputedStyle(document.querySelector('.slot-soul')).opacity + ' ' + document.querySelector('.slot-soul').style.width;`));
      capture('light-rest');
      await m.run(`StillChrome.onWheelGesture('slots', 1);
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const a = document.querySelector('.slot-soul').getAnimations().find((x) => x.id === 'still-soul'); if (a) { a.pause(); a.currentTime = 160; } r(Boolean(a)); })));`);
      await wait(250);
      console.log('bar at mid capture:', await m.run(`return document.querySelector('#still-chrome').className;`));
      capture('light-mid');
      await m.run(`document.querySelector('.slot-soul').getAnimations().forEach((x) => x.finish());`);
    }
    if (steps.includes('favtrip')) {
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[0]; gBrowser.selectedBrowser.fixupAndLoadURIString(BROWSER_NEW_TAB_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(2000);
      console.log('actor:', await m.run(`try { return String(gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('StillPage')) + ' ' + gBrowser.selectedBrowser.remoteType; } catch (e) { return 'ERR ' + e; }`));
      await m.content();
      console.log('page roundtrip:', await m.runAsync(`const d = arguments[0]; const t = setTimeout(() => d('no answer'), 6000);
        window.addEventListener('still-favicons', (e) => { clearTimeout(t); d('answer ' + String(e.detail).slice(0, 90)); }, { once: true });
        window.dispatchEvent(new CustomEvent('still-favicons-request', { detail: JSON.stringify(['https://github.com/']) }));`));
      await m.chrome();
      console.log('child events seen:', await m.runAsync(`const d = arguments[0]; gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('StillPage').sendQuery('Still:Color').then((r) => d(JSON.stringify(r)), (e) => d('ERR ' + e));`));
      console.log('principal:', await m.run(`return gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.documentPrincipal.addonId;`));
      console.log('console:', JSON.stringify(await m.run(`return Services.console.getMessageArray().map((x) => x.errorMessage || x.message || '').filter((x) => /avicon|StillPage|still-chrome|resource:..still/i.test(x)).slice(-5);`)));
    }
    if (steps.includes('mine')) {
      // First-start imports run on their own; wait for the history one.
      for (let i = 0; i < 60; i++) {
        const n = await m.run(`return PlacesUtils.promiseDBConnection().then((db) => db.execute('SELECT count(*) AS n FROM moz_places')).then((r) => r[0].getResultByName('n'));`);
        if (n > 2000) { console.log('history pages after import:', n); break; }
        await wait(1000);
      }
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[0]; gBrowser.selectedBrowser.fixupAndLoadURIString(BROWSER_NEW_TAB_URL, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
      await wait(1800);
      await m.content();
      await m.run(`const i = document.querySelector('#search-input'); i.focus(); i.value = 'you'; i.dispatchEvent(new Event('input'));`);
      await wait(1200);
      console.log('suggestions for "you":', JSON.stringify(await m.run(`return [...document.querySelectorAll('#suggestions .suggestion')].map((n) => n.querySelector('span').textContent + ' | ' + (n.querySelector('img.site-icon') ? 'icon' : 'letter'));`)));
      capture('suggest-you');
      await m.run(`const i = document.querySelector('#search-input'); i.value = 'minecraft'; document.querySelector('#search-form').requestSubmit();`);
      for (let i = 0; i < 60 && !(await m.run('return Boolean(document.querySelector(".result, .notice"));')); i++) await wait(200);
      await wait(4000);
      console.log('result icons:', await m.run(`return document.querySelectorAll('.result img.site-icon').length + ' of ' + document.querySelectorAll('.result').length;`));
      capture('mine-all');
      await m.run(`document.querySelector('[data-category="images"]').click();`);
      for (let i = 0; i < 60 && !(await m.run('return Boolean(document.querySelector(".image-tile, .notice"));')); i++) await wait(200);
      await wait(2500);
      console.log('image columns:', await m.run(`return document.querySelectorAll('.image-grid .image-column').length + ' columns, ' + document.querySelectorAll('.image-tile').length + ' images';`));
      capture('mine-images');
      await m.run('window.scrollTo(0, document.body.scrollHeight);');
      await wait(3500);
      console.log('after scrolling:', await m.run(`return document.querySelectorAll('.image-tile').length + ' images';`));
      await m.chrome();
    }
    if (steps.includes('icon')) {
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'window-icon.ps1'), String(pid), path.join(out, 'window-icon.png')]);
      console.log('title:', await m.run('return document.title;'));
    }
    if (steps.includes('splash')) {
      console.log('startup:', await m.run(`return { splashGone: !document.querySelector('#still-splash'), url: gBrowser.selectedBrowser.currentURI.spec, chromeOpen: document.querySelector('#still-chrome').classList.contains('open') };`));
      for (const t of [140, 330, 520, 1100]) {
        await m.run(`StillChrome.replaySplash(); const sp = document.querySelector('#still-splash');
          sp.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = arguments[0]; });`, [t]);
        await wait(250);
        capture('splash-' + t);
        await m.run(`document.querySelectorAll('#still-splash').forEach((n) => n.remove()); document.documentElement.removeAttribute('still-starting'); StillChrome.state.starting = false;`);
      }
    }
    if (steps.includes('perf')) {
      await m.run(`
        const urls = arguments[0];
        gBrowser.tabs.forEach((tab, i) => urls[i] && tab.linkedBrowser.fixupAndLoadURIString(urls[i], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));
      `, [[shaderPage(0, 'ONE'), shaderPage(2, 'TWO'), shaderPage(4, 'THREE')]]);
      await wait(2500);
      for (const i of [1, 2, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(600); }
      const result = await m.runAsync(`
        const done = arguments[0];
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const report = {};
        (async () => {
          // 1. Switch latency and compositor offload.
          const t0 = performance.now();
          StillChrome.activate(gBrowser.tabs[1], 1);
          while (!StillChrome.state.slide && performance.now() - t0 < 1000) await frame();
          report.switchToSlideMs = Math.round(performance.now() - t0);
          await frame(); await frame();
          report.onCompositor = StillChrome.state.slide?.animations.map((a) => a.isRunningOnCompositor);
          // 2. Block the chrome main thread mid-slide; a compositor slide keeps moving.
          const busyStart = performance.now(); while (performance.now() - busyStart < 120) {}
          await new Promise((r) => setTimeout(r, 400));
          // 3. Rapid switching, like spinning the wheel.
          const order = [2, 1, 0, 1, 2, 1, 0, 2];
          for (const i of order) { StillChrome.activate(gBrowser.tabs[i]); await new Promise((r) => setTimeout(r, 45)); }
          await new Promise((r) => setTimeout(r, 700));
          const panels = [...gBrowser.tabpanels.children];
          report.afterRapid = {
            selected: gBrowser.tabs.indexOf(gBrowser.selectedTab),
            leftoverClasses: panels.filter((p) => p.classList.contains('still-slide-out') || p.classList.contains('still-slide-in')).length,
            leftoverAnimations: panels.reduce((n, p) => n + p.getAnimations().length, 0)
          };
          // 4. Capture costs on a shader page.
          report.glassCaptureMs = 0;
          t = performance.now(); await StillChrome.captureBrowser(gBrowser.selectedBrowser); report.navCaptureMs = Math.round(performance.now() - t);
          // 5. Is the shader in the visible slot still animating?
          done(report);
        })().catch((e) => done('ERR ' + e));
      `);
      console.log('perf:', JSON.stringify(result));
      // Marionette's content context is the first tab: measure its shader at rest and while sliding in.
      await m.run('gBrowser.selectedTab = gBrowser.tabs[1];'); await wait(800);
      await m.run('StillChrome.activate(gBrowser.tabs[0], -1);');
      await m.content();
      const s1 = await m.run('return window.frames;'); await wait(260); const s2 = await m.run('return window.frames;');
      await wait(600);
      const f1 = await m.run('return window.frames;'); await wait(1000); const f2 = await m.run('return window.frames;');
      console.log('shader fps at rest:', f2 - f1, '| frames during slide-in (260ms):', s2 - s1);
      await m.chrome();
    }
    const variant = process.env.STILL_GLIDE_VARIANT || '';
    if (variant) await m.run(`const v = arguments[0];
      const style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.textContent = {
        noglass: ':root[still-glass] #still-chrome :is(.slot, .top-control) { background-image: none !important; }',
        noaura: '.slot-aura { display: none !important; }',
        nosoul: '.slot-soul { display: none !important; }',
        nobar: '#still-chrome { display: none !important; }'
      }[v] || '';
      document.documentElement.append(style);`, [variant]);
    if (steps.includes('glide')) {
      for (const i of [1, 2, 3, 4, 0]) { await m.run(`if (gBrowser.tabs[${i}]) gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(450); }
      await m.run(`while (gBrowser.tabs.length < 5) gBrowser.addTrustedTab(arguments[0]);`, [page('%23aa7722', 'MORE')]);
      await wait(1200);
      for (const i of [3, 4, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(450); }
      const report = await m.runAsync(`const done = arguments[0];
        const width = gBrowser.tabpanels.getBoundingClientRect().width;
        const pos = (p) => { const t = getComputedStyle(p).transform; return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41 / width; };
        const samples = [];
        let frames = 0;
        const sample = (label) => { const sel = document.getElementById(gBrowser.selectedTab.linkedPanel);
          const strip = StillChrome.state.strip; samples.push({ t: performance.now(), x: strip ? (() => { const t = (performance.now() - strip.start) / 1000; return t; })() : null,
            panels: [...gBrowser.tabpanels.children].map((p) => (p.classList.contains('deck-selected') || p.classList.contains('still-slide-out') || p.classList.contains('still-slide-in')) ? pos(p) : NaN), label }); };
        const tick = () => { frames++; sample('f'); if (frames < 140) requestAnimationFrame(tick); else finish(); };
        // Spin: 4 notches right, 55-70 ms apart (a fast wheel spin), then 2 at the right edge, then back.
        const plan = [[0, 'slots', 1], [60, 'slots', 1], [125, 'slots', 1], [190, 'slots', 1], [600, 'slots', 1], [660, 'slots', 1], [1100, 'slots', -1]];
        const t0 = performance.now();
        for (const [at, kind, dir] of plan) setTimeout(() => StillChrome.onWheelGesture(kind, dir), at);
        requestAnimationFrame(tick);
        function finish() {
          // Per frame, the largest move of any panel in slot widths. A jump shows up as a big step.
          let maxStep = 0, maxAt = 0;
          for (let k = 1; k < samples.length; k++) {
            for (let j = 0; j < samples[k].panels.length; j++) {
              const a = samples[k - 1].panels[j], b = samples[k].panels[j];
              if (Number.isNaN(a) || Number.isNaN(b)) continue; // hidden page
              if (Math.abs(a) > 1.5 && Math.abs(b) > 1.5) continue; // offscreen both
              const step = Math.abs(b - a);
              if (step > maxStep) { maxStep = step; maxAt = Math.round(samples[k].t - t0); }
            }
          }
          const intervals = samples.slice(1).map((s, k) => s.t - samples[k].t).sort((a, b) => a - b);
          const anims = [...gBrowser.tabpanels.children].flatMap((p) => p.getAnimations());
          done({ frames: samples.length, medianFrameMs: +intervals[intervals.length >> 1].toFixed(2), maxStepSlots: +maxStep.toFixed(3), maxAtMs: maxAt,
            selected: gBrowser.tabs.indexOf(gBrowser.selectedTab), leftover: anims.length,
            restOffsets: [...gBrowser.tabpanels.children].map((p) => +pos(p).toFixed(3)).join(',') });
        }`);
      console.log('glide:', JSON.stringify(report));
      // Compositor check while a glide runs.
      console.log('on compositor:', await m.runAsync(`const d = arguments[0]; StillChrome.onWheelGesture('slots', 1);
        requestAnimationFrame(() => requestAnimationFrame(() => d((StillChrome.state.strip?.animations || []).map((a) => a.isRunningOnCompositor))));`));
      await wait(800);
      // Edge rubber band: at the last slot, measure how far it stretches and that it settles.
      const edge = await m.runAsync(`const d = arguments[0];
        const width = gBrowser.tabpanels.getBoundingClientRect().width;
        const sel = () => document.getElementById(gBrowser.selectedTab.linkedPanel);
        const pos = () => { const t = getComputedStyle(sel()).transform; return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41; };
        StillChrome.activate(gBrowser.tabs[gBrowser.tabs.length - 1], 0);
        setTimeout(() => {
          let peak = 0; const trace = [];
          StillChrome.onWheelGesture('slots', 1);
          const start = performance.now();
          const tick = () => { const x = pos(); trace.push(Math.round(x)); if (Math.abs(x) > Math.abs(peak)) peak = x;
            if (performance.now() - start < 700) requestAnimationFrame(tick); else d({ peakPx: Math.round(peak), endPx: Math.round(pos()), trace: trace.filter((_, i) => i % 6 === 0).join(' ') }); };
          requestAnimationFrame(tick);
        }, 500);`);
      console.log('edge bounce:', JSON.stringify(edge));
    }
    if (steps.includes('bouncecap')) {
      await m.run(`while (gBrowser.tabs.length < 5) gBrowser.addTrustedTab(arguments[0]);`, [page('%23aa7722', 'LAST')]);
      await wait(1200);
      await m.run('StillChrome.activate(gBrowser.tabs[4], 0);');
      await wait(700);
      await m.run(`StillChrome.cycleSlot(1); const s = StillChrome.state.strip; s && s.animations.forEach((a) => { a.pause(); a.currentTime = 55; });`);
      await wait(300);
      capture('edge-bounce-mid');
      await m.run('StillChrome.state.strip?.animations.forEach((a) => a.play());');
    }
    if (steps.includes('overscroll')) {
      await m.run(`while (gBrowser.tabs.length < 5) gBrowser.addTrustedTab(arguments[0]);`, [page('%23aa7722', 'LAST')]);
      await wait(1200);
      for (const i of [1, 2, 3, 4, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(400); }
      const r = await m.runAsync(`const done = arguments[0];
        const width = gBrowser.tabpanels.getBoundingClientRect().width;
        const last = document.getElementById(gBrowser.tabs[4].linkedPanel);
        const tx = (p) => { const t = getComputedStyle(p).transform; return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41; };
        const sc = (p) => { const v = getComputedStyle(p).scale; return v === 'none' ? 1 : parseFloat(v); };
        let minLast = Infinity, maxScale = 1, minScale = 1, edgeTranslate = 0;
        const plan = [0, 60, 120, 180];
        plan.forEach((at) => setTimeout(() => StillChrome.onWheelGesture('slots', 1), at));
        // Then two quick notches at the end of the row.
        setTimeout(() => StillChrome.onWheelGesture('slots', 1), 700);
        setTimeout(() => StillChrome.onWheelGesture('slots', 1), 780);
        const start = performance.now();
        const trace = [];
        const tick = () => {
          const now = performance.now() - start;
          if (now < 700) minLast = Math.min(minLast, tx(last));
          else { const s = sc(last); maxScale = Math.max(maxScale, s); minScale = Math.min(minScale, s); edgeTranslate = Math.max(edgeTranslate, Math.abs(tx(last))); trace.push(s.toFixed(3)); }
          if (now < 1500) requestAnimationFrame(tick);
          else done({ overshootPx: Math.round(Math.min(0, minLast)), stretchPeak: +maxScale.toFixed(3), stretchMin: +minScale.toFixed(3), slidDuringBumpPx: Math.round(edgeTranslate), endScale: sc(last), trace: trace.filter((_, i) => i % 8 === 0).join(' ') });
        };
        requestAnimationFrame(tick);`);
      console.log('overscroll:', JSON.stringify(r));
    }
    if (steps.includes('rapid')) {
      for (const i of [1, 2, 0]) { await m.run(`gBrowser.selectedTab = gBrowser.tabs[${i}];`); await wait(500); }
      const r = await m.runAsync(`
        const done = arguments[0];
        const off = (p) => { const t = getComputedStyle(p).transform; return t === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(t).m41); };
        const panel = (i) => document.getElementById(gBrowser.tabs[i].linkedPanel);
        StillChrome.activate(gBrowser.tabs[1], 1);
        setTimeout(() => {
          const before = { p0: off(panel(0)), p1: off(panel(1)) };
          StillChrome.activate(gBrowser.tabs[0], -1);   // reverse mid-slide
          const after = { p0: off(panel(0)), p1: off(panel(1)) };
          setTimeout(() => done({ before, after, end: { p0: off(panel(0)), p1: off(panel(1)) } }), 600);
        }, 90);
      `);
      console.log('rapid reverse offsets (px):', JSON.stringify(r));
      const t = await m.runAsync(`const done = arguments[0]; const t0 = performance.now();
        StillChrome.captureBrowser(gBrowser.selectedBrowser).then(() => done(Math.round(performance.now() - t0)));`);
      console.log('nav snapshot on a plain page (ms):', t);
    }
    if (steps.includes('vertical')) {
      await m.run(`gBrowser.selectedTab = gBrowser.tabs[0]; gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [page('%23663399', 'NEXT')]);
      await wait(1500);
      await m.run(`
        const original = Element.prototype.animate;
        window.__stillPause = true;
        BrowserCommands.back();
      `);
      for (let i = 0; i < 30; i++) {
        const ready = await m.run('return Boolean(StillChrome.state.vertical && StillChrome.state.vertical.animations);');
        if (ready) break;
        await wait(50);
      }
      console.log('vertical:', await m.run(`
        const v = StillChrome.state.vertical; if (!v) return 'none';
        v.animations.forEach((a) => { a.pause(); a.currentTime = 70; }); return 'paused';`));
      await wait(300);
      capture('vertical-mid');
      await m.run('StillChrome.state.vertical?.animations?.forEach((a) => a.finish());');
      await wait(300);
    }
    if (steps.includes('edit')) {
      await m.run(`
        const now = Date.now() * 1000;
        PlacesUtils.history.insertMany([
          { url: 'https://github.com/Hot-Sweeper/still-browser', title: 'Hot-Sweeper/still-browser', visits: [{ date: new Date() }] },
          { url: 'https://github.com/', title: 'GitHub', visits: [{ date: new Date() }] },
          { url: 'https://www.youtube.com/', title: 'YouTube', visits: [{ date: new Date() }] }
        ]);`);
      await wait(400);
      await m.run(`StillChrome.beginEdit(gBrowser.selectedTab);
        const input = document.querySelector('.slot-inline input'); input.value = 'git'; input.dispatchEvent(new Event('input'));`);
      await wait(700);
      capture('edit');
      await m.run(`document.querySelector('.slot-inline input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
      await wait(300);
    }
    if (steps.includes('panel')) {
      await m.run(`document.querySelector('#still-reveal').dispatchEvent(new MouseEvent('mouseenter', { clientX: 1200 }));
        StillChrome.state.utilityMode = 'history'; document.querySelector('.utility-button').click();`);
      await wait(800);
      capture('panel-history');
      await m.run(`document.querySelector('.utility-button').click();`);
    }
    if (steps.includes('overflow')) {
      await m.run(`for (const c of ['%23555', '%23777', '%23999']) gBrowser.addTab(arguments[0] + c + ';"></body>', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
        ['data:text/html,<body style="background:']);
      await wait(900);
      console.log('slots:', await m.run('return StillChrome.slotTabs().length;'), 'modal:', await m.run('return !document.querySelector("#still-replacement-backdrop").hidden;'));
      capture('overflow');
      await m.run(`document.querySelector('#still-replacement-cancel').click();`);
      await wait(400);
      console.log('after cancel:', await m.run('return StillChrome.slotTabs().length;'));
    }
    if (steps.includes('edge')) {
      await m.run(`gBrowser.removeTab(gBrowser.tabs.at(-1)); StillChrome.activate(StillChrome.slotTabs().at(-1), 0);`);
      await wait(600);
      await m.run(`StillChrome.cycleSlot(1);`);
      await wait(450);
      capture('edge-new-slot');
    }
    if (steps.includes('dock')) {
      await m.run('StillChrome.showDock(); StillChrome.moveDock(1);');
      await wait(600);
      capture('dock');
      await m.run('StillChrome.releaseDock();');
    }
    const errors = await m.run(`return Services.console.getMessageArray()
      .filter((m) => m instanceof Ci.nsIScriptError && (m.flags & Ci.nsIScriptError.warningFlag) === 0)
      .map((m) => m.errorMessage + " @ " + m.sourceName + ":" + m.lineNumber)
      .filter((m) => /still/i.test(m)).slice(-20);`);
    console.log('errors:', JSON.stringify(errors, null, 1));
  } catch (error) {
    console.error(error.message);
  }
  if (!process.argv.includes('--keep')) await s.stop();
}

main();
