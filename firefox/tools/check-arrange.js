// Checks rearranging slots and the agent visuals on a disposable, headless
// profile: dragging a slot with the pointer, moving one with the keyboard,
// Escape cancelling a drag, dropping an agent tab into the row, and a real
// agent client clicking on the page in front (its pointer, ring, steps).
// Captures go to firefox/.local/checks/arrange-*.png.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch } = require('./session');

const out = path.join(__dirname, '..', '.local', 'checks');
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page(color, label, extra = '') {
  return 'data:text/html,' + encodeURIComponent(`<title>${label}</title><body style="margin:0;background:${color};color:white;font:700 64px sans-serif;display:grid;place-items:center;height:100vh"><div>${label}${extra}</div></body>`);
}

async function main() {
  const s = await launch({ headless: true });
  const m = s.marionette;
  const run = m.run.bind(m);
  // Still's agent engine and Marionette share Firefox's remote agent; when
  // the agent starts its engine, Marionette's session ends. Start a new one.
  const rebind = async () => {
    try { await m.send('WebDriver:DeleteSession', {}); } catch {}
    await m.session();
    await m.chrome();
  };
  m.run = (script, args) => run(script, args).catch(async (error) => {
    if (!/discarded|no such window|currentSession|session/i.test(error.message)) { error.message += `\n(in: ${script.trim().slice(0, 90)})`; throw error; }
    await rebind();
    return run(script, args);
  });
  const capture = async (name) => {
    const file = path.join(out, `arrange-${process.env.STILL_CHECK_THEME ? `${process.env.STILL_CHECK_THEME}-` : ''}${name}.png`);
    fs.writeFileSync(file, Buffer.from(await m.screenshot(), 'base64'));
    console.log('captured', file);
  };
  const order = () => m.run('return StillChrome.slotTabs().map((tab) => tab.label);');
  try {
    await m.chrome();
    await m.run('window.resizeTo(1400, 860);');
    // STILL_CHECK_THEME=dark (or oled, light) checks another appearance.
    if (process.env.STILL_CHECK_THEME) await m.run('StillChrome.applyTheme(arguments[0]);', [process.env.STILL_CHECK_THEME]);
    await wait(2500);
    await m.run(`
      const urls = arguments[0];
      gBrowser.selectedBrowser.fixupAndLoadURIString(urls[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      for (const url of urls.slice(1)) gBrowser.addTrustedTab(url);
      gBrowser.selectedTab = gBrowser.tabs[0];
    `, [[page('#b4462c', 'ONE'), page('#2c6cb4', 'TWO'), page('#2c8f55', 'THREE'), page('#7a4fb4', 'FOUR')]]);
    await wait(1500);
    assert.deepEqual(await order(), ['ONE', 'TWO', 'THREE', 'FOUR']);

    // ---- pointer drag: ONE to the third place
    const open = 'document.querySelector("#still-reveal").dispatchEvent(new MouseEvent("mouseenter", { clientX: 300 }));';
    await m.run(open);
    await wait(700);
    const centers = await m.run(`return [...document.querySelectorAll("#still-chrome .slot-row > .slot")].map((node) => {
      const box = node.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; });`);
    // Real pointer input through Marionette's actions (chrome coordinates).
    const mouse = (type, x, y) => m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: type === 'mousedown' ? [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }, { type: 'pointerDown', button: 0 }]
        : type === 'mouseup' ? [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }, { type: 'pointerUp', button: 0 }]
        : [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }] }] });
    const [x0, y0] = centers[0];
    await mouse('mousedown', x0, y0);
    for (let i = 1; i <= 12; i++) { await mouse('mousemove', x0 + (centers[2][0] - x0) * i / 12, y0 + i * 0.6); await wait(16); }
    await wait(120);
    const mid = await m.run(`return { lifted: !!document.querySelector(".slot.lifted"), shifted: [...document.querySelectorAll("#still-chrome .slot-row > .slot")].map((node) => node.style.translate || "") };`);
    console.log('mid-drag', JSON.stringify(mid));
    assert.ok(mid.lifted, 'the dragged slot lifts');
    await capture('drag-mid');
    await mouse('mouseup', centers[2][0], y0 + 7);
    await wait(900);
    assert.deepEqual(await order(), ['TWO', 'THREE', 'ONE', 'FOUR'], 'drop moves the slot');
    const settled = await m.run('return [...document.querySelectorAll("#still-chrome .slot-row > .slot")].every((node) => !node.style.translate);');
    assert.ok(settled, 'slots settle with no leftover offsets');
    assert.equal(await m.run('return gBrowser.selectedTab.label;'), 'ONE', 'a drag does not switch slots');

    // ---- Escape cancels a drag
    await mouse('mousedown', centers[0][0], y0);
    for (let i = 1; i <= 8; i++) { await mouse('mousemove', centers[0][0] + (centers[3][0] - centers[0][0]) * i / 8, y0); await wait(16); }
    await m.run('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));');
    await mouse('mouseup', centers[3][0], y0);
    await wait(900);
    assert.deepEqual(await order(), ['TWO', 'THREE', 'ONE', 'FOUR'], 'Escape keeps the order');

    // ---- keyboard: Ctrl+Shift+Left on FOUR
    await m.run(`const pill = document.querySelectorAll("#still-chrome .slot-row > .slot")[3]; pill.focus();
      pill.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, shiftKey: true, bubbles: true }));`);
    await wait(700);
    assert.deepEqual(await order(), ['TWO', 'THREE', 'FOUR', 'ONE'], 'Ctrl+Shift+Left moves the focused slot');

    // ---- a plain click still switches, a double-click still edits
    await m.run(open);
    await wait(500);
    const now = await m.run(`return [...document.querySelectorAll("#still-chrome .slot-row > .slot")].map((node) => {
      const box = node.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; });`);
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', x: Math.round(now[1][0]), y: Math.round(now[1][1]), origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    await wait(500);
    assert.equal(await m.run('return gBrowser.selectedTab.label;'), 'THREE', 'a click switches slots');
    await m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    await wait(400);
    assert.ok(await m.run('return !!document.querySelector(".slot.editing");'), 'a double-click edits the address');
    await m.run('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.querySelector(".slot-inline input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));');
    await m.run('gBrowser.selectedTab = StillChrome.slotTabs()[3];');
    await wait(500);

    // ---- agent visuals (the window side; a real agent runs further below).
    // Marionette and Still's agent engine cannot hold sessions at once, so
    // this part feeds the window the same updates StillAgent sends.
    const agentTab = await m.run(`const tab = StillChrome.agent.openTab(arguments[0]); return tab.linkedBrowser.browserId;`, [page('#333', 'AGENT')]);
    await m.run(`StillChrome.agent.update({ clients: ["Check"], engine: true });`);
    await wait(500);
    assert.equal(await m.run('return document.querySelectorAll(".agent-chip").length;'), 1, 'the agent tab shows beside the mark');
    const front = await m.run('return gBrowser.selectedBrowser.browserId;');
    const send = (activity) => m.run(`StillChrome.agent.update({ clients: ["Check"], engine: true, activity: arguments[0] });`, [activity]);
    await send({ tab: agentTab, label: "Opening", target: "example.com" });
    await send({ tab: front, label: "Reading the page", target: "" });
    await wait(250);
    assert.ok(await m.run('return document.querySelector("#still-agent-narration").classList.contains("visible");'), 'steps without an element are narrated');
    await capture('agent-narrate');
    const box = await m.run(`const area = gBrowser.selectedBrowser.getBoundingClientRect(); return { x: area.width / 2 - 90, y: area.height / 2 + 30, width: 180, height: 56 };`);
    await send({ tab: front, label: "Clicking", target: "Sign in", box });
    await wait(130);
    await capture('agent-aim');
    await wait(400);
    const visuals = await m.run(`return { pointer: document.querySelector("#still-agent-pointer").classList.contains("visible"),
      label: document.querySelector(".agent-pointer-label").textContent,
      ring: document.querySelector("#still-agent-focus").classList.contains("visible"),
      narration: document.querySelector("#still-agent-narration").classList.contains("visible") };`);
    console.log('agent visuals', JSON.stringify(visuals));
    assert.ok(visuals.pointer && visuals.ring, 'pointer and ring show on the page in front');
    assert.ok(!visuals.narration, 'the pointer label replaces the narration');
    assert.match(visuals.label, /Clicking.*Sign in/);
    await capture('agent-aimed');
    await send({ tab: front, label: "Typing in", target: "Search", box: { ...box, y: box.y + 90, width: 320 } });
    await wait(500);
    await capture('agent-typing');
    // Working in a slot behind the current one marks that slot.
    const behind = await m.run('return StillChrome.slotTabs()[1].linkedBrowser.browserId;');
    await send({ tab: behind, label: "Scrolling", target: "" });
    assert.ok(await m.run('return !!document.querySelector(".slot.agent-busy");'), 'a slot behind is marked');
    const opened = { tab: { id: agentTab } };

    // ---- the panel lists steps
    await m.run(open);
    await wait(500);
    await m.run('document.querySelector(".agent-control").click();');
    await wait(400);
    const steps = await m.run('return [...document.querySelectorAll(".agent-step-text")].map((node) => node.textContent);');
    console.log('steps', JSON.stringify(steps));
    assert.ok(steps.some((step) => /Clicking “Sign in”/.test(step)), 'the click is in the steps');
    assert.equal(steps.filter((step) => /Reading the page/.test(step)).length, 1);
    await capture('agent-panel');

    // ---- drop the agent tab into the row (synthetic drag events)
    const dropped = await m.run(`
      const id = arguments[0];
      const tab = gBrowser.tabs.find((t) => t.linkedBrowser.browserId === id);
      StillChrome.state.draggingAgentTab = tab;
      const row = document.querySelector("#still-chrome .slot-row");
      const target = row.children[1].getBoundingClientRect();
      const data = new DataTransfer();
      data.setData("application/x-still-agent-tab", String(id));
      const fire = (type) => row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: target.left + 20, clientY: target.top + 10, dataTransfer: data }));
      fire("dragenter"); fire("dragover");
      return { ghost: document.querySelector(".still-slot-ghost").classList.contains("visible"), dt: data.types.join(",") };
    `, [opened.tab.id]);
    console.log('drag preview', JSON.stringify(dropped));
    await wait(350);
    await capture('agent-drop-preview');
    await m.run(`
      const row = document.querySelector("#still-chrome .slot-row");
      // Layout position: the preview has already slid this slot aside.
      const box = row.getBoundingClientRect();
      const target = { left: box.left + row.children[1].offsetLeft, top: box.top };
      const data = new DataTransfer();
      data.setData("application/x-still-agent-tab", String(arguments[0]));
      row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: target.left + 20, clientY: target.top + 10, dataTransfer: data }));
      StillChrome.state.draggingAgentTab = null;
    `, [opened.tab.id]);
    await wait(900);
    const after = await order();
    console.log('after agent drop', JSON.stringify(after));
    assert.equal(after[1], 'AGENT', 'the agent tab lands where it was dropped');
    assert.equal(await m.run('return document.querySelectorAll(".agent-chip").length;'), 0, 'it leaves the agent tabs');
    await capture('agent-dropped');
    // ---- links and text dropped from a page
    const dropText = (index, type, value) => m.run(`
      const row = document.querySelector("#still-chrome .slot-row");
      const box = row.getBoundingClientRect();
      const node = row.children[arguments[0]];
      const at = { clientX: box.left + node.offsetLeft + 30, clientY: box.top + 12 };
      const data = new DataTransfer();
      data.setData(arguments[1], arguments[2]);
      for (const type of ["dragenter", "dragover"]) row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, ...at, dataTransfer: data }));
      const hint = node.querySelector(".slot-drop-hint")?.textContent;
      row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, ...at, dataTransfer: data }));
      return hint;
    `, [index, type, value]);
    const hintLoad = await dropText(0, 'text/uri-list', 'https://example.com/dropped');
    assert.equal(hintLoad, 'Open here');
    let firstUrl = '';
    for (let i = 0; i < 40 && !/example\.com/.test(firstUrl); i++) {
      await wait(250);
      firstUrl = await m.run('const browser = StillChrome.slotTabs()[0].linkedBrowser; return browser.currentURI.spec + " " + (browser.userTypedValue || "");');
    }
    console.log('dropped link', firstUrl);
    assert.match(firstUrl, /example\.com\/dropped/, 'a link dropped on a slot opens there');
    await m.run('for (const tab of StillChrome.slotTabs().slice(3)) gBrowser.removeTab(tab);');
    await wait(400);
    const hintNew = await dropText(4, 'text/plain', 'still browser slots');
    assert.equal(hintNew, 'Open in a new slot');
    await wait(1200);
    const lastUrl = await m.run('const tabs = StillChrome.slotTabs(); return [tabs.length, tabs[tabs.length - 1].linkedBrowser.currentURI.spec];');
    console.log('dropped text', JSON.stringify(lastUrl));
    assert.equal(lastUrl[0], 4, 'text on an empty slot opens a new slot');
    assert.match(lastUrl[1], /still(%20|\+)browser(%20|\+)slots/, 'and searches for it');
    console.log('window checks passed');
  } finally {
    await s.stop();
  }
  await realAgent();
}

// A real agent client on a second disposable profile without Marionette:
// the aim pause and target names must not change what the agent does.
async function realAgent() {
  const s = await launch({ headless: true, marionette: false });
  const { StillClient } = require('../agent/client');
  try {
    let agent = null;
    for (let i = 0; i < 60 && !agent; i++) {
      await wait(500);
      try { agent = await new StillClient({ dir: s.agentDir, client: 'Check' }).connect(); } catch {}
    }
    assert.ok(agent, 'agent connects');
    const form = page('#2c6cb4', 'FORM', '<br><input placeholder="Search" style="font-size:24px"><button style="font-size:28px" onclick="this.textContent=\'Done \'+document.querySelector(\'input\').value">Sign in</button>');
    const { tab } = await agent.call('tabs.open', { url: form });
    await agent.call('page.wait', { tab: tab.id, text: 'FORM' });
    const snap = await agent.call('page.snapshot', { tab: tab.id });
    const field = /textbox "Search" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
    const button = /button "Sign in" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
    assert.ok(field && button, `snapshot has the field and the button:\n${snap.text}`);
    await agent.call('input.type', { tab: tab.id, ref: field, text: 'still' });
    await agent.call('input.click', { tab: tab.id, ref: button });
    const text = await agent.call('page.text', { tab: tab.id });
    assert.match(text.text, /Done still/, 'typing and clicking still land');
    agent.close();
    console.log('agent checks passed');
  } finally {
    await s.stop();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
