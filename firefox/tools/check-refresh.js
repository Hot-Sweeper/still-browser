// Frame pacing on Still's actual YouTube home UI with a full 200-card feed.
// Local thumbnails avoid network variance. No personal browser profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launch } = require('./session');
const home = fs.readFileSync(path.join(__dirname, '../../src/youtube-home.js'));
const server = http.createServer((req, res) => {
  if (req.url === '/home.js') {res.setHeader('Content-Type','text/javascript');res.end(home);return;}
  if (req.url.startsWith('/thumb')) {
    res.setHeader('Content-Type','image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g"><stop stop-color="#358"/><stop offset="1" stop-color="#b43"/></linearGradient></defs><path fill="url(#g)" d="M0 0h640v360H0z"/><circle fill="#ccc" cx="320" cy="180" r="85"/></svg>');return;
  }
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><script>
    const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value){descriptor.set.call(this,'/thumb.svg')}});
    window.__stillLearningFilterConfig={homeFeed:{loading:false,videos:Array.from({length:200},(_,i)=>({id:String(i).padStart(11,'0'),title:'Frame pacing test '+i,channel:'Still',meta:'144 Hz scrolling fixture'}))}};
    window.beginFrames=()=>{window.intervals=[];window.active=true;let last;function frame(t){if(last)window.intervals.push(t-last);last=t;if(window.active)requestAnimationFrame(frame)}requestAnimationFrame(frame)};
  </script><script src="/home.js"></script>`);
});
async function main() {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let s;
  try {
    s=await launch();const m=s.marionette;
    await m.chrome();
    const display=await m.run(`return Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).getInfo().Display0;`);
    const hz=Number(display.match(/@(\d+(?:\.\d+)?)Hz/)[1]);
    assert.equal(await m.run(`return Services.prefs.getBoolPref('general.smoothScroll.msdPhysics.enabled');`),true);
    await m.content();
    await m.send('WebDriver:Navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    await new Promise(r=>setTimeout(r,3500));
    assert.equal(await m.run('return document.querySelectorAll(".still-video-card").length;'),200);
    await m.chrome();await m.run('window.focus();gBrowser.selectedBrowser.focus();');
    const recording=await m.run('return window.windowUtils.startFrameTimeRecording();');
    await m.content();await m.run('window.beginFrames();');
    await m.send('WebDriver:PerformActions',{actions:[{type:'wheel',id:'wheel',actions:[{type:'scroll',x:650,y:700,deltaX:0,deltaY:2600,duration:2200}]}]});
    const content=await m.run('window.active=false;return {intervals:window.intervals,scrollTop:document.querySelector("#still-youtube-home").scrollTop};');
    assert.ok(content.scrollTop>1000,'Feed did not scroll');
    await m.chrome();
    const compositor=await m.run('return Array.from(window.windowUtils.stopFrameTimeRecording(arguments[0]));',[recording]);
    const stats=a=>{a=a.filter(x=>x>0).sort((a,b)=>a-b);return {frames:a.length,median:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)]};};
    const result={displayHz:hz,content:stats(content.intervals),compositor:stats(compositor)};
    console.log(JSON.stringify(result,null,2));
    assert.ok(result.content.frames>50);
    assert.ok(result.content.median<=1000/hz*1.25,'Content refresh cadence is below the display rate');
    assert.ok(result.compositor.median<=1000/hz*1.25,'Compositor cadence is below the display rate');
    assert.ok(result.compositor.p95<=1000/hz*2,'Too many missed compositor frame deadlines');
    console.log('PASS: 200-card YouTube feed scrolls at the display refresh cadence');
  } finally {if(s)await s.stop();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
