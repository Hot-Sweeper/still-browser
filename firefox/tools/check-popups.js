// Regression check for website windows, using an isolated Firefox profile.
const assert = require('node:assert/strict');
const http = require('node:http');
const { launch } = require('./session');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const server = http.createServer((req, res) => res.end('<!doctype html><title>Popup check</title>Popup opener'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let session;
  try {
    session = await launch({ headless: true });
    const m = session.marionette;
    await m.chrome();
    await wait(1500);
    // Simulate a user-authorized popup without relying on input timing.
    await m.run("Services.prefs.setBoolPref('dom.disable_open_during_load', false);");
    await m.content();
    await m.send('WebDriver:Navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (const features of ['width=500,height=500', 'toolbar=yes,width=500,height=500']) {
      assert.equal(await m.run(`
        window.reply = null;
        window.onmessage = (event) => { window.reply = event.data; };
        window.child = window.open('about:blank', 'still-popup-check', arguments[0]);
        return !!window.child;
      `, [features]), true);
      await wait(500);
      assert.equal(await m.run('return window.child.closed;'), false, 'Still must not close script-created windows');
      assert.equal(await m.run(`
        window.child.document.body.textContent = 'Sign-in result';
        window.child.opener.postMessage('signed-in', location.origin);
        return window.child.opener === window;
      `), true, 'The opener must survive');
      await wait(100);
      assert.equal(await m.run('return window.reply;'), 'signed-in');
      await m.chrome();
      assert.deepEqual(await m.run(`return [...Services.wm.getEnumerator('navigator:browser')].map(w => !!w.StillChrome);`), [true, false], 'Popup must retain native Firefox chrome');
      await m.content();
      await m.run('window.child.close();');
      await wait(100);
    }
    await m.chrome();
    await m.run('OpenBrowserWindow();');
    await wait(700);
    assert.equal(await m.run("return [...Services.wm.getEnumerator('navigator:browser')].length;"), 1, 'Ordinary browser windows must still reuse Still');
    console.log('PASS: native popup and full-toolbar child stay open, retain their opener, send messages, and close.');
  } finally {
    if (session) await session.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
