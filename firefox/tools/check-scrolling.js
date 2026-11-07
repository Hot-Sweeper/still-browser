// Real browser checks on local fixtures; never uses the personal profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const clip = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-t','3','-c:v','libvpx','-f','webm','pipe:1']);
const { launch } = require('./session');
const wait = ms => new Promise(r => setTimeout(r, ms));
const ui = fs.readFileSync(path.join(__dirname, '../../src/youtube-ui.js'));
const server = http.createServer((req, res) => {
  if (req.url === '/video.webm') { res.setHeader('Content-Type', 'video/webm'); res.end(clip); return; }
  if (req.url === '/ui.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(ui); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><style>body{margin:0;background:#111;color:white}#scroll{height:90vh;overflow:auto}#long{height:180000px;background:repeating-linear-gradient(#123 0 100px,#345 100px 200px)}#movie_player{position:relative;width:900px;height:600px}video{position:relative;z-index:10;width:100%;height:100%;object-fit:contain}</style>
    <div id="scroll" style="${req.url.startsWith('/watch') ? 'display:none' : ''}"><div id="long">Scroll fixture</div></div>
    <div id="movie_player"><video muted autoplay playsinline></video></div>
    <script>window.captures=[];const capture=HTMLMediaElement.prototype.captureStream;HTMLMediaElement.prototype.captureStream=function(){const s=capture.call(this);captures.push(s);return s};</script>`);
});
async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let s;
  try {
    s = await launch();
    const m = s.marionette;
    await m.chrome();
    const prefs = await m.run(`return ['general.autoScroll','middlemouse.paste','apz.autoscroll.enabled','general.smoothScroll'].map(n=>Services.prefs.getBoolPref(n));`);
    assert.deepEqual(prefs, [true, false, true, true]);
    await m.content();
    const base = `http://127.0.0.1:${server.address().port}`;
    await m.send('WebDriver:Navigate', { url: base + '/scroll' });
    await wait(3500); // Let Still's startup overlay stop intercepting input.
    await m.chrome();
    await m.run('window.focus();gBrowser.selectedBrowser.focus();');
    await m.content();
    // Native trusted middle-button hold: move from the anchor, then release.
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', x: 350, y: 220 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
      { type: 'pause', duration: 200 }, { type: 'pointerDown', button: 1 },
      { type: 'pause', duration: 400 }, { type: 'pointerMove', x: 350, y: 340, duration: 150 },
      { type: 'pause', duration: 700 }
    ] }] });
    await m.chrome();
    assert.equal(await m.run('const b=gBrowser.selectedBrowser;return !!b._autoScrollBrowsingContext && b._autoScrollPopup.state === "open";'), true, 'Native autoscroll did not activate');
    await m.content();
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerUp', button: 1 }] }] });
    // WebDriver dispatches directly into content, bypassing the native popup
    // that receives physical mouseup. Cancel through that popup's browser API.
    await m.chrome();
    await m.run('if (gBrowser.selectedBrowser._autoScrollBrowsingContext) gBrowser.selectedBrowser.cancelScroll();');
    await m.content();
    await wait(200);
    const released = await m.run('return document.querySelector("#scroll").scrollTop;');
    await wait(200);
    assert.equal(await m.run('return document.querySelector("#scroll").scrollTop;'), released, 'Native cancellation did not stop autoscroll');
    await m.run('document.querySelector("#scroll").scrollTop = 0;');
    // Wheel events must keep normal native scrolling and Ctrl+wheel slots.
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'wheel', id: 'wheel', actions: [
      { type: 'scroll', x: 350, y: 220, deltaX: 0, deltaY: 400, duration: 200 }
    ] }] });
    await wait(400);
    assert.ok(await m.run('return document.querySelector("#scroll").scrollTop;') > 0);
    console.log('PASS: native middle-button activation, cancellation, nested scrolling and wheel scrolling');
    await m.chrome();
    await m.run('gBrowser.addTrustedTab(arguments[0]);', [base + '/scroll?second']);
    const selected = await m.run('return Array.from(gBrowser.tabs).indexOf(gBrowser.selectedTab);');
    await m.content();
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE009' }] }] });
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x: 350, y: 220, deltaX: 0, deltaY: 100, duration: 20 }] }] });
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: '\uE009' }] }] });
    await wait(500);
    await m.chrome();
    assert.notEqual(await m.run('return Array.from(gBrowser.tabs).indexOf(gBrowser.selectedTab);'), selected, 'Passive Ctrl+wheel no longer switches slots');
    assert.equal(await m.run('return gBrowser.selectedBrowser.fullZoom;'), 1);
    console.log('PASS: passive Ctrl+wheel still switches slots without zooming');
    // WebDriver keeps its original browsing context when chrome switches tabs.
    // Return the native selected tab to that context before the next fixture.
    await m.run('gBrowser.selectedTab = gBrowser.tabs[arguments[0]];', [selected]);
    await wait(500);
    await m.content();
    await m.send('WebDriver:Navigate', { url: base + '/watch?v=fixture' });
    await m.runAsync(`const done=arguments[0];(async()=>{
      localStorage.setItem('still-youtube-native-playback-v1','1');
      localStorage.setItem('still-youtube-player-lab-v1',JSON.stringify({mirror:true}));
      const v=document.querySelector('video');v.src='/video.webm';v.loop=true;await v.play();
      const script=document.createElement('script');script.src='/ui.js';script.onload=()=>done(true);document.head.append(script);
    })().catch(e=>done(String(e)));`);
    await wait(400);
    const live = 'return captures.some(s => s.getVideoTracks().some(t => t.readyState === "live"));';
    assert.equal(await m.run('const e=document.querySelector("#still-youtube-edge-mirror");return !!e && getComputedStyle(e).visibility === "visible" && getComputedStyle(e).display !== "none";'), true, 'Edges are not showing');
    assert.equal(await m.run(live), true, 'Edges do not share the video frames');
    // The copies stay out of page queries, and the native video keeps its sound.
    assert.equal(await m.run('return document.querySelectorAll("video").length;'), 1, 'Edge copies are visible to page queries');
    assert.equal(await m.run('return document.querySelector("video").mozAudioCaptured;'), false, 'Edges took the video\'s audio');
    // Offscreen edges release the capture and resume when visible again.
    await m.run('document.querySelector("#movie_player").style.transform="translateY(-5000px)";');
    await wait(400);
    assert.equal(await m.run(live), false, 'Offscreen edges keep capturing');
    await m.run('document.querySelector("#movie_player").style.transform="";');
    await wait(400);
    assert.equal(await m.run(live), true, 'Edges did not resume when visible');
    await m.run('window.__stillDownloadUi.destroy();document.querySelector("video").pause();');
    assert.equal(await m.run('return !!document.querySelector("#still-youtube-edge-mirror");'), false);
    assert.equal(await m.run(live), false, 'Destroyed edges keep capturing');
    console.log('PASS: YouTube edges share native frames, stay hidden from page queries, keep audio native and release when offscreen');
  } finally {
    if (s) await s.stop();
    await new Promise(r => server.close(r));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
