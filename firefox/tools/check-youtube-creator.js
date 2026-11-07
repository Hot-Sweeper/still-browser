// Run through the hidden workspace with its dedicated agent Firefox profile.
// Local fixture navigation only, no Still profile or account writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Marionette } = require('./marionette');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const first = 'UC' + 'a'.repeat(22), second = 'UC' + 'b'.repeat(22);
const source = fs.readFileSync(path.join(__dirname, '../../src/youtube-home.js'), 'utf8');
const early = fs.readFileSync(path.join(__dirname, '../extension/youtube-early.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../extension/youtube-early.css'), 'utf8');
const server = http.createServer((req, res) => {
  const own = req.url.includes(first);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "require-trusted-types-for 'script'");
  const data = { metadata: { channelMetadataRenderer: { title: own ? 'My channel' : 'Other channel', channelUrl: `http://127.0.0.1:${server.address().port}/channel/${own ? first : second}` } }, header: own ? { pageHeaderRenderer: { actions: [{ url: `https://studio.youtube.com/channel/${first}` }] } } : {}, contents: { twoColumnBrowseResultsRenderer: { tabs: [ { tabRenderer: { title: 'Videos', selected: true, endpoint: { commandMetadata: { webCommandMetadata: { url: `/channel/${own ? first : second}/videos` } } } } }, { tabRenderer: { title: 'Beiträge', endpoint: { commandMetadata: { webCommandMetadata: { url: `/channel/${own ? first : second}/posts` } } } } } ] } } };
  res.end(`<!doctype html><html><head><style>${css}</style><script>window.ytInitialData=${JSON.stringify(data)};</script><script>${early}</script><script>${source}</script></head><body><ytd-app><ytd-masthead><button id="avatar-btn">Account</button></ytd-masthead><ytd-page-manager><form id="composer"><label>Post<textarea></textarea></label><button>Post</button></form></ytd-page-manager><ytd-popup-container></ytd-popup-container></ytd-app><script>
  window.activeChannel=${JSON.stringify(first)};
  document.querySelector('#avatar-btn').onclick=()=>{document.querySelector('ytd-popup-container').replaceChildren();setTimeout(()=>{const menu=document.createElement('ytd-multi-page-menu-renderer');menu.data={header:{activeAccountHeaderRenderer:{navigationEndpoint:{browseEndpoint:{browseId:window.activeChannel}}}}};document.querySelector('ytd-popup-container').append(menu)},100)};
  </script></body></html>`);
});
async function main() {
  let child, m;
  try {
    const port = 2828;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    child = spawn('/home/spacestation/.local/bin/agent-firefox', ['--marionette', '--remote-allow-system-access'], { stdio: ['ignore', 'inherit', 'inherit'] });
    m = await new Marionette(port).connect(); await m.session(); await m.content();
    const base = `http://127.0.0.1:${server.address().port}`;
    const navigate = async route => { await m.send('WebDriver:Navigate', { url: base + route }); await wait(250); };
    await navigate('/watch?v=abcdefghijk');
    assert.equal(await m.run('return !!document.querySelector("#still-youtube-my-channel")'), true);
    await m.run('document.querySelector("#still-youtube-my-channel").click()'); await wait(700);
    assert.equal(await m.run('return location.pathname'), `/channel/${first}`);
    assert.equal(await m.run('return document.querySelector(".still-channel-studio").href'), `https://studio.youtube.com/channel/${first}`);
    assert.equal(await m.run('return !!document.querySelector(".still-channel-subscribe:not(.still-channel-studio)")'), false);
    assert.equal(await m.run('return [...document.querySelectorAll(".still-channel-tabs a")].find(a=>a.textContent==="Beiträge").pathname'), `/channel/${first}/posts`);
    await m.run('document.querySelector("#still-youtube-my-channel").focus()'); await wait(250);
    assert.equal(await m.run('return getComputedStyle(document.querySelector("#still-youtube-my-channel svg")).opacity'), '1');
    const size = await m.run('const r=document.querySelector("#still-youtube-my-channel").getBoundingClientRect();return [r.width,r.height]');
    assert.deepEqual(size, [112,78]);
    fs.writeFileSync('/tmp/still-creator-check.png', Buffer.from(await m.screenshot(), 'base64'));
    await navigate(`/channel/${second}/videos`);
    assert.equal(await m.run('return !!document.querySelector(".still-channel-studio")'), false);
    assert.equal(await m.run('return !!document.querySelector(".still-channel-subscribe")'), true);
    await m.run(`window.activeChannel=${JSON.stringify(second)};document.querySelector('#still-youtube-my-channel').click()`); await wait(700);
    assert.equal(await m.run('return location.pathname'), `/channel/${second}`);
    await navigate(`/channel/${first}/posts`);
    assert.equal(await m.run('return document.documentElement.dataset.stillYoutubeSurface'), 'native');
    assert.equal(await m.run('return !!document.querySelector("#still-youtube-channel")'), false);
    assert.equal(await m.run('return getComputedStyle(document.querySelector("#composer")).visibility'), 'visible');
    await m.run('document.querySelector("textarea").value="Unpublished draft"');
    assert.equal(await m.run('return document.querySelector("textarea").value'), 'Unpublished draft');
    await navigate(`/channel/${first}/community`);
    assert.equal(await m.run('return !!document.querySelector("#still-youtube-channel")'), false);
    await navigate('/');
    await m.run('document.querySelector("#avatar-btn").remove();document.querySelector("#still-youtube-my-channel").click()');
    assert.match(await m.run('return document.querySelector("#still-youtube-channel-error").textContent'), /still loading/);
    if (process.argv.includes('--live')) {
      await m.send('WebDriver:Navigate', { url: 'https://www.youtube.com/@YouTube/videos' });
      await wait(2500);
      const consent = await m.run('return location.hostname === "consent.youtube.com"');
      if (consent) {
        const rejected = await m.run('const button=[...document.querySelectorAll("button")].find(b=>/Reject all|Alle ablehnen/i.test(b.textContent));if(button)button.click();return !!button');
        assert.equal(rejected, true, 'YouTube consent: Reject all button missing');
        await wait(3500);
      }
      // Inject the same shipping page scripts into this separate agent browser.
      await m.run(early); await m.run(source); await wait(500);
      const live = await m.run('return {url:location.href,title:document.title,channel:!!document.querySelector("#still-youtube-channel"),tabs:[...document.querySelectorAll(".still-channel-tabs a")].map(a=>({text:a.textContent,href:a.href}))}');
      console.log('Live anonymous channel:', JSON.stringify(live));
      assert.equal(live.channel, true);
      const posts = live.tabs.find(tab => /\/(?:posts|community)$/.test(tab.href));
      assert.ok(posts, 'Live Posts endpoint was not discovered');
      await m.send('WebDriver:Navigate', { url: posts.href });
      await m.run(early); await m.run(source); await wait(500);
      assert.equal(await m.run('return document.documentElement.dataset.stillYoutubeSurface'), 'native');
      assert.equal(await m.run('return !!document.querySelector("#still-youtube-channel")'), false);
      console.log('PASS: live YouTube Posts route remains native');
    }
    console.log('PASS: watch shortcut, active channel and account switch, owner Studio, visitor subscribe, localized Posts link, native Posts/Community composer, keyboard reveal, target size, account loading error');
  } finally {
    if (m) { try { await m.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch {} m.close(); }
    if (child && child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
