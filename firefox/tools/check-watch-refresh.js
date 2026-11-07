// Real decoded 1080p60 playback + all Still YouTube helpers + native scrolling.
// This is a local watch-shell fixture, not the user's signed-in YouTube session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { launch } = require('./session');
const wait = ms => new Promise(r => setTimeout(r, ms));
const clip = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=60','-t','2','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-threads','4','-f','webm','pipe:1'],{maxBuffer:16*1024*1024});
const files = Object.fromEntries(['youtube-ui','youtube-home','youtube-filter'].map(n=>['/'+n+'.js',fs.readFileSync(path.join(__dirname,'../../src',n+'.js'))]));
const server=http.createServer((req,res)=>{
  if(req.url==='/video.webm'){res.setHeader('Content-Type','video/webm');res.end(clip);return;}
  if(files[req.url]){res.setHeader('Content-Type','text/javascript');res.end(files[req.url]);return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><style>body{margin:0;background:#000;color:white}#movie_player{position:relative;width:90vw;height:90vh}video{position:absolute;z-index:10;object-fit:contain}#top-level-buttons-computed{display:flex}button{color:white;background:#222;border:0;border-radius:16px;height:32px}ytd-comments{display:block;height:18000px;background:repeating-linear-gradient(#111 0 80px,#222 80px 81px)}</style>
  <ytd-watch-flexy theater><div id="player-theater-container"><div id="movie_player"><video class="html5-main-video" muted loop playsinline src="/video.webm"></video><span id="time"></span></div></div>
  <ytd-watch-metadata><div id="actions"><div id="top-level-buttons-computed"><button>Share</button><button>Save</button></div></div></ytd-watch-metadata><ytd-comments><span id="comment"></span></ytd-comments></ytd-watch-flexy>
  <script>
  if(!localStorage.getItem('fixture-initialized')){localStorage.setItem('still-youtube-player-lab-v1',JSON.stringify({mirror:true,height:94,brightness:100}));localStorage.setItem('fixture-initialized','1');}
  window.glContexts=0;const context=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl'||type==='webgl2')window.glContexts++;return context.call(this,type,...args)};
  window.uploads=0;window.scans=0;window.scrollUploads=[];window.scrollVisibility=[];
  const upload=WebGL2RenderingContext.prototype.texImage2D;WebGL2RenderingContext.prototype.texImage2D=function(...args){window.uploads++;return upload.apply(this,args)};
  const query=Document.prototype.querySelectorAll;Document.prototype.querySelectorAll=function(s){if(s.includes('ytd-rich-item-renderer')||s.includes('#actions'))window.scans++;return query.call(this,s)};
  window.addEventListener('scroll',()=>{window.scrollUploads.push(window.uploads);const c=document.querySelector('#still-youtube-edge-mirror');if(c)window.scrollVisibility.push(getComputedStyle(c).visibility)},{capture:true,passive:true});
  window.beginFrames=()=>{window.intervals=[];window.recording=true;let last;function frame(t){if(last)window.intervals.push(t-last);last=t;if(window.recording)requestAnimationFrame(frame)}requestAnimationFrame(frame)};
  const v=document.querySelector('video');v.play();setInterval(()=>{document.querySelector('#time').textContent=v.currentTime.toFixed(2);document.querySelector('#comment').textContent='Playback comment '+Date.now()},16);
  </script><script src="/youtube-filter.js"></script><script src="/youtube-home.js"></script><script src="/youtube-ui.js"></script>`);
});
async function main(){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let s;
  try{
    s=await launch();const m=s.marionette;await m.chrome();await m.run('window.maximize();');
    const display=await m.run(`return Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).getInfo().Display0;`);
    const hz=Number(display.match(/@(\d+(?:\.\d+)?)Hz/)[1]);
    await m.content();await m.send('WebDriver:Navigate',{url:`http://127.0.0.1:${server.address().port}/watch?v=fixture`});await wait(3500);
    await m.chrome();await m.run('window.focus();gBrowser.selectedBrowser.focus();');await m.content();
    await m.runAsync('const done=arguments[0];document.querySelector("video").play().then(()=>done(true),e=>done(String(e)));');
    assert.deepEqual(await m.run('const saved=JSON.parse(localStorage.getItem("still-youtube-player-lab-v1"));return [saved.mirror,saved.height,saved.brightness,localStorage.getItem("still-youtube-native-playback-v1")];'),[false,94,100,'1']);
    assert.deepEqual(await m.run('return [glContexts,uploads,!!document.querySelector("#still-youtube-edge-mirror")];'),[0,0,false]);
    await m.run('window.scans=0;');await wait(300);assert.equal(await m.run('return scans;'),0);
    const start=await m.run('return {now:performance.now(),q:document.querySelector("video").getVideoPlaybackQuality()};');
    await wait(2200);
    const end=await m.run('return {now:performance.now(),q:document.querySelector("video").getVideoPlaybackQuality()};');
    const frames=end.q.totalVideoFrames-start.q.totalVideoFrames,dropped=end.q.droppedVideoFrames-start.q.droppedVideoFrames;
    const fps=(frames-dropped)*1000/(end.now-start.now);
    assert.ok(fps>=50,`Native 60 fps clip only presented ${fps.toFixed(1)} fps`);
    assert.ok(dropped<=Math.max(2,frames*.05),'Native playback drops too many frames');
    await m.chrome();const rec=await m.run('return window.windowUtils.startFrameTimeRecording();');await m.content();await m.run('window.beginFrames();');
    await m.send('WebDriver:PerformActions',{actions:[{type:'wheel',id:'wheel',actions:[{type:'scroll',x:650,y:700,deltaX:0,deltaY:260,duration:1800}]}]});
    const data=await m.run('window.recording=false;return {intervals:window.intervals,scrollTop:scrollY,paused:document.querySelector("video").paused,glContexts,uploads};');
    assert.ok(data.scrollTop>100);assert.equal(data.paused,false);assert.equal(data.glContexts,0);assert.equal(data.uploads,0);
    await m.chrome();const compositor=await m.run('return Array.from(window.windowUtils.stopFrameTimeRecording(arguments[0]));',[rec]);await m.content();
    const stats=a=>{a=a.filter(v=>v>0).sort((a,b)=>a-b);return {frames:a.length,median:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)]}};
    const result={displayHz:hz,videoFps:fps,dropped,content:stats(data.intervals),compositor:stats(compositor)};console.log(JSON.stringify(result,null,2));
    assert.ok(result.compositor.median<=1000/hz*1.25);
    assert.ok(result.compositor.p95<=1000/hz*2+0.5);
    // Explicit opt-in remains possible, but decoration must stay below video.
    await m.run('scrollTo(0,0);');await wait(250);
    await m.run('const input=document.querySelector("#still-youtube-player-lab-panel").shadowRoot.querySelector("input[data-control=mirror]");input.checked=true;input.dispatchEvent(new Event("change"));');
    await wait(250);
    assert.equal(await m.run('return getComputedStyle(document.querySelector("#still-youtube-edge-mirror")).zIndex;'),'1');
    assert.equal(await m.run('return JSON.parse(localStorage.getItem("still-youtube-player-lab-v1")).mirror;'),true);
    await m.run('window.scrollUploads=[];window.scrollVisibility=[];');
    await m.send('WebDriver:PerformActions',{actions:[{type:'wheel',id:'wheel',actions:[{type:'scroll',x:650,y:700,deltaX:0,deltaY:200,duration:800}]}]});
    const held=await m.run('return {visibility:window.scrollVisibility,uploads:window.scrollUploads,paused:document.querySelector("video").paused};');
    assert.ok(held.visibility.length>10);
    assert.ok(held.visibility.every(v=>v==='visible'),'Scrolling hides the active edge fill');
    assert.ok(Math.max(...held.uploads)-Math.min(...held.uploads)>5,'Live edge updates freeze while scrolling');
    assert.equal(held.paused,false);
    await wait(250);const resume=await m.run('return uploads;');await wait(200);assert.ok(await m.run('return uploads;')>resume,'Live edges did not resume');
    await m.send('WebDriver:Refresh');await wait(350);
    assert.equal(await m.run('return JSON.parse(localStorage.getItem("still-youtube-player-lab-v1")).mirror;'),true,'Migration overwrote explicit opt-in');
    await m.run('const input=document.querySelector("#still-youtube-player-lab-panel").shadowRoot.querySelector("input[data-control=mirror]");input.checked=false;input.dispatchEvent(new Event("change"));');
    assert.equal(await m.run('return !!document.querySelector("#still-youtube-edge-mirror");'),false);
    console.log('PASS: native 60 fps playback, no default GL/video copies, saved-setting migration, native scroll and optional edge opt-in');
  }finally{if(s)await s.stop();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1});
