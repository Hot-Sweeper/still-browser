#!/usr/bin/env python3
"""Real OS shortcuts in an isolated X11/XWayland window, using XTEST.

WebDriver send_keys synthesizes content DOM input without browser accelerators.
"""
import os
import shutil
import subprocess
import threading
import time
import http.server

from native_smoke import browser, Page, wait, check, RESULTS


def main():
    if not shutil.which('xdotool') or not os.environ.get('DISPLAY'):
        raise SystemExit('This test requires xdotool and an X11/XWayland DISPLAY.')
    os.environ.pop('WAYLAND_DISPLAY', None)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = RESULTS / f'keyboard-profile-{int(time.time())}'
    with browser(profile, 'native-keys') as driver:
        for i in range(5):
            driver.execute_script('window.openWebLinkIn(arguments[0],"current",{targetBrowser:window.StillBrowser.slots[arguments[1]].linkedBrowser});', [f'http://127.0.0.1:{server.server_port}/StillKeyFixture-{i+1}', i])
        wait(driver, 'return window.StillBrowser.slots.every(t=>!t.hasAttribute("busy"));')
        driver.execute_script('window.StillBrowser.select(1);')
        candidates = subprocess.run(['xdotool','search','--onlyvisible','--class','com.tim.still'], capture_output=True, text=True).stdout.splitlines()
        selected = None
        for identifier in candidates:
            title = subprocess.run(['xdotool','getwindowname',identifier], capture_output=True,text=True).stdout
            if 'StillKeyFixture-' in title:
                selected = identifier
                break
        if selected is None:
            raise AssertionError('The isolated fixture window was not found.')
        subprocess.run(['xdotool','windowactivate','--sync',selected], capture_output=True, check=False)
        subprocess.run(['xdotool','windowfocus','--sync',selected], check=True)
        def key(value):
            subprocess.run(['xdotool','key','--clearmodifiers',value],check=True)
            time.sleep(.12)
        key('ctrl+3')
        check('real Ctrl+3 from content switches slots', driver.execute_script('return window.StillBrowser.selectedIndex===2;'))
        key('ctrl+Tab')
        check('real Ctrl+Tab commits the quick-switch dock', driver.execute_script('return window.StillBrowser.selectedIndex===3 && !window.StillBrowser.dockOpen;'))
        driver.execute_script('window.StillBrowser._clearCount=0; const old=window.StillBrowser.clear; window.StillBrowser.clear=function(i){this._clearCount++;return old.call(this,i);};')
        key('ctrl+w')
        check('real Ctrl+W clears exactly once', driver.execute_script('return window.StillBrowser._clearCount===1 && gBrowser.tabs.length===5 && window.StillBrowser.slots[3].linkedBrowser.currentURI.spec.endsWith("/start.html");'))
        key('ctrl+t')
        check('real Ctrl+T uses an empty slot and focuses native address entry', driver.execute_script('return window.StillBrowser.selectedIndex===3 && window.gURLBar.focused;'))
        check('no native shortcut errors', driver.execute_script('return !Services.console.getMessageArray().some(x=>/Still (native chrome|bootstrap|session save):/.test(x.message||""));'))
    server.shutdown()
    print('Native OS keyboard tests passed.', flush=True)


if __name__ == '__main__':
    main()
