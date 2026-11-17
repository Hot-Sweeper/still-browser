// Checks Still's side chat on a disposable, headless profile: opening and
// closing (Ctrl+E command, the universal button, the close button), a full
// turn with a fake ACP agent (streamed text, a Still tool step, a permission
// question, Markdown, model choice), and, with --real, one plain reply from
// the real Codex adapter (no tools, so nothing touches another browser).
// Captures go to firefox/.local/checks/chat-*.png.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch } = require('./session');

const out = path.join(__dirname, '..', '.local', 'checks');
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const theme = process.env.STILL_CHECK_THEME || '';

async function until(m, script, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await m.run(script);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${script}`);
    await wait(120);
  }
}

async function main() {
  const fake = { id: 'fake', name: 'Test agent', command: process.execPath, args: [path.join(__dirname, 'fake-acp-agent.js')] };
  const s = await launch({ headless: true, prefs: { 'still.chat.agents': JSON.stringify([fake]), 'still.chat.agent': 'fake' } });
  const m = s.marionette;
  const capture = async (name) => {
    const file = path.join(out, `chat-${theme ? `${theme}-` : ''}${name}.png`);
    fs.writeFileSync(file, Buffer.from(await m.screenshot(), 'base64'));
    console.log('captured', file);
  };
  try {
    await m.chrome();
    await m.run('window.resizeTo(1400, 860);');
    if (theme) await m.run('StillChrome.applyTheme(arguments[0]);', [theme]);
    await wait(2500);
    await m.run(`gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
      ['data:text/html,' + encodeURIComponent('<title>Flight search</title><body style="margin:0;font:18px sans-serif;padding:80px;background:#f4f1ea"><h1>Flights to Lisbon</h1><p>From 89 EUR</p><button>Search</button></body>')]);
    await wait(1200);

    // ---- opening with the Ctrl+E command
    assert.ok(await m.run('return !!document.getElementById("still-cmd-chat") && document.getElementById("key_search")?.getAttribute("command") === "still-cmd-chat";'), 'Ctrl+E is bound to the chat');
    await m.run('document.getElementById("still-cmd-chat").doCommand();');
    await wait(600);
    const opened = await m.run(`const panel = document.getElementById("still-chat"); const box = panel.getBoundingClientRect();
      return { open: StillChat.isOpen(), hidden: panel.hidden, floating: panel.classList.contains("floating"), width: Math.round(box.width), right: Math.round(box.right), page: Math.round(gBrowser.selectedBrowser.getBoundingClientRect().width), context: panel.querySelector(".chat-context-title").textContent };`);
    console.log('opened', JSON.stringify(opened));
    assert.ok(opened.open && !opened.hidden && !opened.floating, 'the chat is open beside the page');
    assert.equal(opened.right, 1400);
    assert.ok(opened.page <= 1400 - opened.width + 2, 'the page makes room for it');
    assert.equal(opened.context, 'Flight search');
    await until(m, 'return document.querySelector("#still-chat .chat-choice")?.textContent;');
    await capture('empty');

    // ---- a full turn with the fake agent
    await m.run(`const input = document.querySelector("#still-chat .chat-input"); input.focus(); input.value = "Find the cheapest flight on this page"; input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`);
    await until(m, 'return !!document.querySelector("#still-chat .chat-permission .chat-option.primary");');
    const mid = await m.run(`return { steps: [...document.querySelectorAll("#still-chat .chat-step")].map((n) => n.textContent + ":" + n.dataset.status),
      text: document.querySelector("#still-chat .chat-text")?.textContent, busy: document.getElementById("still-chat").classList.contains("busy") };`);
    console.log('mid-turn', JSON.stringify(mid));
    assert.deepEqual(mid.steps, ['Read the page:completed']);
    assert.equal(mid.text, 'Looking at the page first.');
    assert.ok(mid.busy);
    await capture('permission');
    await m.run('document.querySelector("#still-chat .chat-permission .chat-option.primary").click();');
    await until(m, 'return !document.getElementById("still-chat").classList.contains("busy");');
    await wait(200);
    const done = await m.run(`const texts = [...document.querySelectorAll("#still-chat .chat-text")];
      const last = texts[texts.length - 1];
      return { blocks: texts.length, strong: last.querySelector("strong")?.textContent, items: [...last.querySelectorAll("li")].map((li) => li.textContent),
        link: last.querySelector("a.chat-link")?.getAttribute("href"), steps: [...document.querySelectorAll("#still-chat .chat-step")].map((n) => n.textContent + ":" + n.dataset.status) };`);
    console.log('done', JSON.stringify(done));
    assert.equal(done.strong, 'fast');
    assert.match(done.items[0], /^Page: tab \d+ \(slot 1\), "Flight search"/);
    assert.equal(done.items[1], 'Click: allowed');
    assert.equal(done.link, 'https://example.com/result');
    assert.deepEqual(done.steps, ['Read the page:completed', 'Clicked:completed']);
    await capture('reply');

    // ---- model choice
    await m.run('document.querySelector("#still-chat .chat-choice").click();');
    await wait(250);
    await m.run('[...document.querySelectorAll("#still-chat .chat-menu-item")].find((n) => n.textContent.includes("Deep")).click();');
    await until(m, 'return document.querySelector("#still-chat .chat-choice")?.textContent === "Deep model";');
    assert.equal(await m.run('return Services.prefs.getStringPref("still.chat.choice.fake.model", "");'), 'deep', 'the choice is remembered');

    // ---- closing: the close button, then the universal button reopens it
    await m.run('document.querySelector(\'#still-chat [aria-label="Close side chat"]\').click();');
    await wait(500);
    assert.ok(await m.run('return !StillChat.isOpen() && document.getElementById("still-chat").hidden;'), 'the close button closes it');
    assert.ok(await m.run('return Math.round(gBrowser.selectedBrowser.getBoundingClientRect().width) === 1400;'), 'the page gets its width back');
    await m.run('Services.prefs.setStringPref("still.utility.mode", "chat"); StillChrome.state.utilityMode = "chat"; document.querySelector(".utility-button").click();');
    await wait(600);
    assert.ok(await m.run('return StillChat.isOpen();'), 'the universal button opens it');
    assert.equal(await m.run('return document.querySelectorAll("#still-chat .chat-user").length;'), 1, 'the conversation is kept');
    await m.run('document.getElementById("still-cmd-chat").doCommand();');
    await wait(500);
    assert.ok(await m.run('return !StillChat.isOpen();'), 'Ctrl+E closes it again');
    console.log('chat checks passed');

    if (process.argv.includes('--real')) {
      // ---- the real Codex adapter answers (no tool use)
      await m.run('StillChat.open();');
      await wait(400);
      await m.run('[...document.querySelectorAll("#still-chat .chat-agent")][0].click();');
      await wait(250);
      await m.run('[...document.querySelectorAll("#still-chat .chat-menu-item")].find((n) => n.textContent.startsWith("Codex")).click();');
      await until(m, 'return document.querySelector("#still-chat .chat-choice")?.textContent || document.querySelector("#still-chat .chat-error")?.textContent;', 60000);
      await m.run(`const input = document.querySelector("#still-chat .chat-input"); input.value = "Without using any tools, reply with exactly the word: ready"; input.dispatchEvent(new Event("input"));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`);
      try {
        await until(m, 'return !document.getElementById("still-chat").classList.contains("busy") && document.querySelectorAll("#still-chat .chat-user").length;', 120000);
      } catch (error) {
        console.log('panel:', await m.run('return document.querySelector("#still-chat .chat-scroll").innerText;'));
        await capture('codex-stuck');
        throw error;
      }
      const reply = await m.run('const t = [...document.querySelectorAll("#still-chat .chat-text")]; return (t[t.length - 1]?.textContent || document.querySelector("#still-chat .chat-error")?.textContent || "").trim();');
      console.log('codex replied', JSON.stringify(reply));
      assert.match(reply, /ready/i);
      await capture('codex');
      console.log('codex check passed');
    }
    if (process.argv.includes('--t3')) {
      // ---- T3 Code: one real thread in T3's "No project"
      await m.run('StillChat.open();');
      await wait(300);
      await m.run('document.querySelector("#still-chat .chat-agent").click();');
      await wait(250);
      await m.run('[...document.querySelectorAll("#still-chat .chat-menu-item")].find((n) => n.textContent.startsWith("T3 Code")).click();');
      await wait(800);
      await m.run(`const input = document.querySelector("#still-chat .chat-input"); input.value = "Check from Still's side chat. Without using any tools, reply with exactly the word: ready"; input.dispatchEvent(new Event("input"));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`);
      try {
        await until(m, 'return !document.getElementById("still-chat").classList.contains("busy") && document.querySelectorAll("#still-chat .chat-user").length;', 240000);
      } catch (error) {
        console.log('panel:', await m.run('return document.querySelector("#still-chat .chat-scroll").innerText;'));
        throw error;
      }
      const reply = await m.run('const t = [...document.querySelectorAll("#still-chat .chat-text")]; return (t[t.length - 1]?.textContent || document.querySelector("#still-chat .chat-error")?.textContent || "").trim();');
      console.log('t3 replied', JSON.stringify(reply.slice(-300)), await m.run('return document.querySelector("#still-chat .chat-choice")?.textContent;'));
      assert.match(reply, /^ready\.?$/i);
      await capture('t3');
      console.log('t3 check passed');
    }
  } finally {
    await s.stop();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
