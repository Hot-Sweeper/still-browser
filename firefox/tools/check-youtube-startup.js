// Declarative extension injection on a slow local YouTube-shaped fixture.
// Uses the shipping scripts/manifest, with local matches and no feed network.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
const {launch}=require('./session');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/slow.js'){setTimeout(()=>{res.setHeader('Content-Type','text/javascript');res.end('window.slowScriptFinished=true;');},800);return;}
  if(url.pathname==='/slow.gif'){setTimeout(()=>{res.setHeader('Content-Type','image/gif');res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));},1400);return;}
  res.setHeader('Content-Type','text/html');
  res.setHeader('Content-Security-Policy',"script-src 'self' 'nonce-probe'; img-src 'self' data:");
  if(url.pathname==='/setup'){res.end(`<script nonce="probe">localStorage.setItem('still-youtube-feed-mode',${JSON.stringify(url.searchParams.get('mode')||'selective')});</script>`);return;}
  res.end(`<!doctype html><html><head><script nonce="probe">
    window.ytInitialData={contents:{}};
    window.firstProbe={staticHome:!!window.__stillYouTubeHome,guard:document.documentElement.dataset.stillYoutubeSurface,body:!!document.body};
    window.samples=[];window.probeStart=performance.now();
    function sample(){const native=document.querySelector('#native-feed');samples.push({ready:document.readyState,native:!!native&&getComputedStyle(native).visibility==='visible',custom:!!document.querySelector('#still-youtube-home,#still-youtube-search,#still-youtube-channel')});if(performance.now()-probeStart<2200)requestAnimationFrame(sample)}requestAnimationFrame(sample);
  </script></head><body><ytd-app><ytd-masthead>Native toolbar</ytd-masthead><ytd-page-manager><div id="native-feed" style="background:red;height:1000px;visibility:visible!important">ORIGINAL FEED</div></ytd-page-manager></ytd-app><script src="/slow.js"></script><img src="/slow.gif"></body></html>`);
});
async function main(){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let s;
  try{
    s=await launch();const m=s.marionette;
    const addon=path.join(s.profileDir,'first-paint-addon');fs.cpSync(path.join(__dirname,'../build'),addon,{recursive:true});
    const file=path.join(addon,'manifest.json');const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
    manifest.browser_specific_settings.gecko.id='still-first-paint-test@tim.local';delete manifest.background;
    manifest.host_permissions=['http://127.0.0.1/*'];
    for(const entry of manifest.content_scripts)entry.matches=['http://127.0.0.1/*'];
    fs.writeFileSync(file,JSON.stringify(manifest));
    await m.send('Addon:Install',{path:addon,temporary:true});await m.content();
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const route of ['/','/results?search_query=fixture','/@fixture/videos']){
      await m.send('WebDriver:Navigate',{url:base+route});
      const data=await m.run('return {first:window.firstProbe,samples:window.samples,root:document.documentElement.dataset.stillYoutubeSurface};');
      assert.equal(data.first.staticHome,true,'Main-world shell was not installed before page scripts');assert.equal(data.first.guard,'custom');
      assert.equal(data.root,'custom');assert.ok(data.samples.some(x=>x.custom&&x.ready==='loading'),'Still waited for DOM/resource completion');
      assert.ok(data.samples.every(x=>!x.native),'Original feed was exposed before replacement');
    }
    // Early route changes must hide the native feed before SPA rendering.
    await m.run('document.dispatchEvent(new CustomEvent("yt-navigate-start",{detail:{url:"/watch?v=fixture"}}));history.pushState({},"","/watch?v=fixture");document.dispatchEvent(new Event("yt-navigate-finish"));');await wait(100);
    assert.equal(await m.run('return document.documentElement.dataset.stillYoutubeSurface;'),'watch');
    await m.run('document.dispatchEvent(new CustomEvent("yt-navigate-start",{detail:{url:"/"}}));history.pushState({},"","/");document.dispatchEvent(new Event("yt-navigate-finish"));');
    assert.equal(await m.run('return getComputedStyle(document.querySelector("#native-feed")).visibility;'),'hidden');await wait(100);
    assert.equal(await m.run('return !!document.querySelector("#still-youtube-home");'),true);
    await m.send('WebDriver:Navigate',{url:base+'/setup?mode=normal'});await m.send('WebDriver:Navigate',{url:base+'/results?search_query=normal'});
    assert.equal(await m.run('return document.documentElement.dataset.stillYoutubeSurface;'),'native');
    assert.equal(await m.run('return getComputedStyle(document.querySelector("#native-feed")).visibility;'),'visible');
    // Missing shell: reveal native UI after a bounded wait, never blank forever.
    await m.send('Addon:Uninstall',{id:manifest.browser_specific_settings.gecko.id});
    manifest.content_scripts=manifest.content_scripts.map(entry=>({...entry,js:entry.js.filter(name=>name!=='youtube-home.js')}));
    fs.writeFileSync(file,JSON.stringify(manifest));await m.send('Addon:Install',{path:addon,temporary:true});
    await m.send('WebDriver:Navigate',{url:base+'/setup?mode=selective'});await m.send('WebDriver:Navigate',{url:base+'/'});await wait(1800);
    assert.equal(await m.run('return document.documentElement.dataset.stillYoutubeSurface;'),'native','Failed shell leaves a blank page');
    assert.equal(await m.run('return getComputedStyle(document.querySelector("#native-feed")).visibility;'),'visible');
    console.log('PASS: pre-page-script startup, no native-feed flash, early Still shell, SPA routes, native mode and bounded failure fallback');
  }finally{if(s)await s.stop();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1});
