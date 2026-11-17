// Close-up captures of the slot bar at a real display scale, for judging how
// the slots look: at rest, hovered, pressed, and picked up mid-drag.
// Disposable headless profile. Usage:
//   node firefox/tools/capture-slots.js [theme] [scale]   (theme: oled, dark, light, system)
// Output: firefox/.local/checks/slots-<theme>-<state>.png
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./session');

const out = path.join(__dirname, '..', '.local', 'checks');
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const theme = process.argv[2] || 'oled';
const scale = process.argv[3] || '1.5';

// A busy, colourful page, so edges and shadows are judged against real content.
function page(title, hue) {
  return 'data:text/html,' + encodeURIComponent(`<title>${title}</title><body style="margin:0;height:100vh;font:600 18px sans-serif;color:#fff;
    background:radial-gradient(circle at 20% 10%, hsl(${hue} 80% 55%), transparent 45%), radial-gradient(circle at 80% 30%, hsl(${hue + 60} 70% 45%), transparent 50%),
    linear-gradient(160deg, hsl(${hue + 120} 40% 18%), hsl(${hue} 30% 8%));">
    <div style="padding:120px 60px;max-width:700px;line-height:1.5">${title}<br><span style="font-weight:400;opacity:.8">Some page text under the bar, with a link and an image row.</span></div></body>`);
}

async function main() {
  const s = await launch({ headless: true, prefs: { 'layout.css.devPixelsPerPx': scale } });
  const m = s.marionette;
  const shot = async (name, clip) => {
    const png = (await m.send('WebDriver:TakeScreenshot', { full: false, ...(clip ? {} : {}) })).value;
    const file = path.join(out, `slots-${theme}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    console.log('captured', file);
  };
  const act = (actions) => m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
  try {
    await m.chrome();
    await m.run('window.resizeTo(1280, 300);');
    if (theme !== 'system') await m.run('StillChrome.applyTheme(arguments[0]);', [theme]);
    await wait(2500);
    await m.run(`
      const urls = arguments[0];
      gBrowser.selectedBrowser.fixupAndLoadURIString(urls[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      for (const url of urls.slice(1)) gBrowser.addTrustedTab(url);
      gBrowser.selectedTab = gBrowser.tabs[1];
    `, [[page('Anmelden · PostPilot', 20), page('BEAT DA FELICIDADE (official video)', 200), page('Compare Qwen Proprietary Models', 280), page('Das realistischste Spiel', 120)]]);
    await wait(1500);
    await m.run('document.querySelector("#still-reveal").dispatchEvent(new MouseEvent("mouseenter", { clientX: 300 }));');
    await wait(900);
    await shot('rest');
    const c = await m.run(`return [...document.querySelectorAll("#still-chrome .slot-row > .slot")].map((n) => { const b = n.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; });`);
    await act([{ type: 'pointerMove', x: c[2][0], y: c[2][1], origin: 'viewport' }]);
    await wait(700);
    await shot('hover');
    await act([{ type: 'pointerDown', button: 0 }]);
    await wait(60);
    await shot('press');
    for (let i = 1; i <= 8; i++) { await act([{ type: 'pointerMove', x: c[2][0] + i * 9, y: c[2][1] + 3, origin: 'viewport' }]); await wait(16); }
    await shot('grab-moving');
    await wait(700);
    await shot('grab-still');
    await act([{ type: 'pointerUp', button: 0 }]);
    await wait(1200);
    await shot('after');
  } finally {
    await s.stop();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
