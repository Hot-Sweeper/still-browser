#!/usr/bin/env python3
"""Integration tests against Still's real native engine and isolated test profiles.

Install the test-only client: python -m pip install -r tests/requirements.txt
Production launches never enable Marionette or remote system access.
"""
from contextlib import contextmanager
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time

from marionette_driver.marionette import Marionette
from marionette_driver.keys import Keys

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / 'test-results'
RESULTS.mkdir(exist_ok=True)


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/download':
            body = b'Still native download test\n'
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename="still-test.txt"')
        else:
            title = self.path.lstrip('/') or 'A'
            body = f'''<!doctype html><title>{title}</title>
              <style>body{{font:28px system-ui;background:#e8efe9;padding:90px;color:#253c2b}}</style>
              <h1>{title}</h1><input id="field" placeholder="Native content input">
              <button id="popup" onclick="window.open('/auth-popup','auth','width=460,height=560')">Authentication popup</button>
              <a href="/download" id="download">Download test</a>
              <script>window.pageLoads=(window.pageLoads||0)+1;</script>'''.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@contextmanager
def browser(profile, name, headless=False, remoting=False):
    profile.mkdir(parents=True, exist_ok=True)
    port = free_port()
    (profile / 'user.js').write_text(f'user_pref("marionette.port", {port});\nuser_pref("browser.shell.checkDefaultBrowser", false);\n')
    environment = os.environ.copy()
    environment['STILL_PROFILE'] = str(profile)
    log = (RESULTS / f'{name}.log').open('w')
    command = [str(ROOT / 'dist/still-linux-x64/still'), '--marionette', '--remote-allow-system-access']
    if not remoting:
        command.append('-no-remote')
    if headless:
        command.append('-headless')
    process = subprocess.Popen(command, env=environment, stdout=log, stderr=log)
    driver = None
    try:
        driver = Marionette(host='127.0.0.1', port=port)
        driver.raise_for_port(timeout=30)
        driver.start_session()
        driver.set_context('chrome')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if driver.execute_script('return Boolean(window.StillBrowser?.ready);'):
                    break
            except Exception:
                handles = driver.chrome_window_handles
                if handles:
                    driver.switch_to_window(handles[-1])
            time.sleep(.1)
        else:
            errors = driver.execute_script('return Services.console.getMessageArray().map(x=>x.message);')
            raise AssertionError(f'Still bootstrap failed: {errors}')
        yield driver
    finally:
        if driver:
            try:
                driver.set_context('chrome')
                errors = driver.execute_script('return Services.console.getMessageArray().map(x=>x.message).filter(x=>x?.includes("Still native chrome:") || x?.includes("Still bootstrap:") || x?.includes("Still session save:"));')
                (RESULTS / f'{name}-errors.json').write_text(json.dumps(errors, indent=2))
                if errors:
                    print('Native chrome errors:', errors, flush=True)
                driver.execute_script('Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);')
            except Exception:
                pass
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
        log.close()


def wait(driver, script, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = driver.execute_script(script)
        if value:
            return value
        time.sleep(.07)
    windows = driver.execute_script('return Array.from(Services.wm.getEnumerator("navigator:browser")).map(w=>({chromehidden:w.document.documentElement.getAttribute("chromehidden"), toolbar:w.toolbar.visible, popup:w.StillBrowser?.popup, slots:w.StillBrowser?.slots?.length, url:w.gBrowser?.selectedBrowser?.currentURI.spec}));')
    raise AssertionError(f'Timed out waiting: {script}; windows: {windows}')


def check(label, condition):
    assert condition, label
    print('PASS', label, flush=True)


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    profile = RESULTS / f'native-profile-{int(time.time())}'
    profile.mkdir()
    (profile / 'legacy-import.json').write_text(json.dumps({'history':[{'url':'https://example.org/imported','title':'Imported Still test','lastVisit':int(time.time()*1000)}], 'bookmarks':[{'url':'https://example.org/bookmark','name':'Still bookmark'}]}))
    report = {'engine': json.loads((ROOT / 'native/engine.json').read_text())['version'], 'performance': {}}
    with browser(profile, 'native-smoke') as m:
        check('five native slots and active chrome', m.execute_script('return window.StillBrowser.slots.length===5 && gBrowser.tabs.length===5 && document.documentElement.hasAttribute("still-native");'))
        check('start page loads in a normal content process', wait(m, 'return gBrowser.selectedBrowser.currentURI.spec.endsWith("/start.html") && !gBrowser.selectedTab.hasAttribute("busy");'))
        wait(m, 'return Services.prefs.getBoolPref("still.legacyImported",false);')
        imported = m.execute_async_script('const done=arguments[arguments.length-1];const {PlacesUtils}=ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");Promise.all([PlacesUtils.history.fetch("https://example.org/imported"),PlacesUtils.bookmarks.fetch({url:"https://example.org/bookmark"})]).then(x=>done(x.map(Boolean)));')
        check('legacy history and bookmarks import into native Places', imported == [True, True])
        m.execute_script('window.StillBrowser.showChrome();')
        (RESULTS / 'native-start.png').write_bytes(m.screenshot(format='binary'))
        m.set_context('content')
        m.find_element('css selector', 'input').send_keys(origin + '/SearchSubmission', Keys.RETURN)
        m.set_context('chrome')
        wait(m, 'return !gBrowser.selectedTab.hasAttribute("busy") && gBrowser.selectedBrowser.currentURI.spec.endsWith("/SearchSubmission") && gBrowser.selectedBrowser.hasLayers && gBrowser.selectedBrowser.docShellIsActive;')
        m.set_context('content')
        check('start-page Enter submits and renders the destination', m.find_element('css selector', 'h1').text == 'SearchSubmission')
        m.set_context('chrome')
        m.execute_script('StillBrowser.showChrome();gURLBar.value=arguments[0];gURLBar.handleCommand();', [origin + '/AddressSubmission'])
        wait(m, 'return !gBrowser.selectedTab.hasAttribute("busy") && gBrowser.selectedBrowser.currentURI.spec.endsWith("/AddressSubmission") && gBrowser.selectedBrowser.hasLayers && gBrowser.selectedBrowser.docShellIsActive;')
        m.set_context('content')
        check('native address-bar submission renders the destination', m.find_element('css selector', 'h1').text == 'AddressSubmission')
        m.set_context('chrome')
        m.execute_async_script('StillBrowser.saveState().then(arguments[arguments.length-1]);')
        saved_before_window = (profile / 'still-slots.json').read_text()
        m.execute_script('Services.prefs.setBoolPref("browser.tabs.warnOnClose",false);openWebLinkIn(arguments[0],"window");', [origin + '/NewWindow'])
        wait(m, 'return Array.from(Services.wm.getEnumerator("navigator:browser")).some(w=>w!==window && w.StillBrowser?.ready && w.gBrowser.selectedBrowser.currentURI.spec.endsWith("/NewWindow") && !w.gBrowser.selectedTab.hasAttribute("busy"));')
        m.execute_async_script('const other=Array.from(Services.wm.getEnumerator("navigator:browser")).find(w=>w!==window && w.StillBrowser?.ready);other.StillBrowser.saveState().then(arguments[arguments.length-1]);')
        check('new windows retain their requested page and preserve the migration fallback', saved_before_window == (profile / 'still-slots.json').read_text())
        m.execute_script('for(const w of Services.wm.getEnumerator("navigator:browser")){if(w!==window)w.close();}Services.prefs.clearUserPref("browser.tabs.warnOnClose");')
        wait(m, 'return Array.from(Services.wm.getEnumerator("navigator:browser")).length===1;')
        for i in range(5):
            m.execute_script('window.openWebLinkIn(arguments[0],"current",{targetBrowser:window.StillBrowser.slots[arguments[1]].linkedBrowser,inBackground:true});', [f'{origin}/Page-{i+1}', i])
        wait(m, 'return window.StillBrowser.slots.every(t=>!t.hasAttribute("busy") && t.linkedBrowser.currentURI.spec.includes("/Page-"));')
        m.set_context('content')
        check('web content has no chrome, Node, or Still bridge', m.execute_script('return typeof window.StillBrowser==="undefined" && typeof require==="undefined" && typeof window.ChromeUtils==="undefined";'))
        check('genuine engine identity', 'Firefox/157.' in m.execute_script('return navigator.userAgent;'))
        m.set_context('chrome')
        m.find_element('css selector', '#still-slots button:nth-child(2)').click()
        check('clicking the rail selects a real native tab', m.execute_script('return window.StillBrowser.selectedIndex===1;'))
        m.execute_script('document.getElementById("still-command-slot-2").doCommand();')
        check('native reserved slot command selects slot three', m.execute_script('return window.StillBrowser.selectedIndex===2;'))
        m.execute_script('StillBrowser.select(0,false);StillBrowser.setMotion("elastic");')
        wait(m, 'return gBrowser.selectedBrowser.hasLayers;')
        m.execute_script('StillBrowser.select(1);')
        wait(m, 'return StillBrowser.effects.animation?.playState==="running";')
        motion = m.execute_async_script('''const done=arguments[arguments.length-1],effect=StillBrowser.effects;
          const started=performance.now();let runningFrames=0;const shifts=[];
          function sample(){
            if(effect.animation?.playState==='running')runningFrames++;
            if(effect.target)shifts.push(new DOMMatrixReadOnly(getComputedStyle(effect.target).transform).m41);
            if(performance.now()-started<650)requestAnimationFrame(sample);
            else done({runningFrames,shifts,clean:!effect.animation&&!document.querySelector('[still-entering],[still-exiting],[still-transition]')});
          }requestAnimationFrame(sample);''')
        check('native content focus leaves a visible, multi-frame transition running', motion['runningFrames'] >= 4 and len(motion['shifts']) >= 4 and max(motion['shifts']) - min(motion['shifts']) > 30)
        check('completed slide releases both native panels and all transition attributes', motion['clean'])
        for mode in ['slide', 'elastic', 'ripple', 'off']:
            m.execute_script('window.StillBrowser.setMotion(arguments[0]);', [mode])
            if mode == 'ripple':
                time.sleep(.25)
            m.timeout.script = 15
            result = m.execute_async_script('window.StillBrowser.measureFrames(2500,true).then(arguments[arguments.length-1]);')
            report['performance'][mode] = result
            print('FRAMES', mode, json.dumps(result), flush=True)
            time.sleep(.65)
            check(f'{mode} settles without an idle shader loop', m.execute_script('return window.StillBrowser.effects.frame===0 && document.getElementById("still-effects").hidden && gBrowser.tabpanels.getAnimations({subtree:true}).length===0 && !document.querySelector("[still-entering],[still-exiting],[still-transition]");'))
        gpu = m.execute_script('return Boolean(window.StillBrowser.effects.gl) && !window.StillBrowser.effects.failed;')
        report['gpuShader'] = gpu
        check('ripple has a GPU shader or a clean compositor fallback', gpu or m.execute_script('return window.StillBrowser.effects.failed && window.StillBrowser.effects.frame===0;'))
        if os.environ.get('STILL_REQUIRE_GPU') == '1':
            check('hardware test requires a working GPU shader', gpu)
        m.execute_script('window.StillBrowser.setMotion("elastic"); for(let i=0;i<150;i++) window.StillBrowser.select(i%5);')
        check('rapid switching commits the newest selection', m.execute_script('return window.StillBrowser.selectedIndex===4 && gBrowser.tabpanels.getAnimations({subtree:true}).length<=1;'))
        time.sleep(.65)
        check('rapid switching leaves no animations behind', m.execute_script('return gBrowser.tabpanels.getAnimations({subtree:true}).length===0 && !document.querySelector("[still-entering],[still-exiting],[still-transition]");'))
        m.execute_script('window.openWebLinkIn(arguments[0],"tab");', [origin + '/Incoming'])
        wait(m, 'return !document.getElementById("still-replace").hidden;')
        check('full slots prompt without losing any original page', m.execute_script('return window.StillBrowser.slots.length===5 && window.StillBrowser.overflow.length===1 && gBrowser.tabs.length===6;'))
        m.execute_script('window.StillBrowser.cancelReplacement();')
        wait(m, 'return gBrowser.tabs.length===5 && window.StillBrowser.overflow.length===0;')
        m.execute_script('window.StillBrowser.clear(1);')
        wait(m, 'return window.StillBrowser.slots[1].linkedBrowser.currentURI.spec.endsWith("/start.html");')
        m.execute_script('window.openWebLinkIn(arguments[0],"tab");', [origin + '/Fresh'])
        check('new native tab fills an empty slot', wait(m, 'return window.StillBrowser.slots[1].linkedBrowser.currentURI.spec.endsWith("/Fresh") && gBrowser.tabs.length===5;'))
        m.execute_script('window.StillBrowser.reorder(0,3); window.StillBrowser.select(3);')
        check('slot reorder preserves the actual tab', m.execute_script('return window.StillBrowser.slots[3].linkedBrowser.currentURI.spec.endsWith("/Page-1");'))
        m.execute_script('window.StillBrowser.toggleMenu();')
        (RESULTS / 'native-tools.png').write_bytes(m.screenshot(format='binary'))
        m.execute_script('document.getElementById("still-menu").hidden=true;')
        m.set_context('content')
        m.find_element('id','popup').click()
        m.set_context('chrome')
        check('auth popup remains a native window', wait(m, 'return Array.from(Services.wm.getEnumerator("navigator:browser")).some(w=>w!==window && w.StillBrowser?.popup);'))
        m.execute_script('for(const w of Services.wm.getEnumerator("navigator:browser")){if(w!==window && w.StillBrowser?.popup)w.close();}')
        wait(m, 'return Array.from(Services.wm.getEnumerator("navigator:browser")).length===1;')
        m.execute_script('window.StillBrowser.setTheme("dark"); window.StillBrowser.showChrome();')
        (RESULTS / 'native-page.png').write_bytes(m.screenshot(format='binary'))
        m.execute_script('Services.prefs.setIntPref("browser.download.folderList",2);Services.prefs.setCharPref("browser.download.dir",arguments[0]);Services.prefs.setBoolPref("browser.download.useDownloadDir",true);', [str(profile)])
        m.set_context('content')
        m.find_element('id','download').click()
        m.set_context('chrome')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not (profile / 'still-test.txt').exists():
            time.sleep(.1)
        check('normal file downloads use the native download manager', (profile / 'still-test.txt').read_bytes() == b'Still native download test\n')
        m.execute_script('window.BrowserCommands.downloadsUI();')
        m.execute_script('window.SidebarController.toggle("viewHistorySidebar");')
        check('native history sidebar opens', m.execute_script('return !document.getElementById("sidebar-box").hidden;'))
        m.execute_script('window.SidebarController.toggle("viewBookmarksSidebar");')
        check('native bookmarks sidebar opens', m.execute_script('return !document.getElementById("sidebar-box").hidden;'))
        m.execute_script('window.SidebarController.hide();')
        m.execute_async_script('window.StillBrowser.saveState().then(arguments[arguments.length-1]);')
        report['beforeRestore'] = m.execute_script('return {selected:window.StillBrowser.selectedIndex, urls:window.StillBrowser.slots.map(t=>t.linkedBrowser.currentURI.spec)};')
        report['sessionWindows'] = m.execute_script('return JSON.parse(ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs").SessionStore.getBrowserState()).windows.map(w=>({popup:w.isPopup, selected:w.selected,urls:w.tabs.map(t=>t.entries.at(-1)?.url)}));')
        (RESULTS / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        check('no Still exceptions during integration tests', m.execute_script('return !Services.console.getMessageArray().some(x=>/Still (native chrome|bootstrap|session save):/.test(x.message||""));'))
    with browser(profile, 'native-restore') as m:
        restored = m.execute_script('return {selected:window.StillBrowser.selectedIndex, urls:window.StillBrowser.slots.map(t=>t.linkedBrowser.currentURI.spec)};')
        print('RESTORE', json.dumps({'before':report['beforeRestore'],'after':restored}), flush=True)
        check('native session restores slot order and active slot', restored == report['beforeRestore'])
        check('exactly five tabs after restart', m.execute_script('return gBrowser.tabs.length===5;'))
    (RESULTS / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    server.shutdown()
    print('Native integration tests passed.', flush=True)


if __name__ == '__main__':
    main()
