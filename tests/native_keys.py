#!/usr/bin/env python3
"""Real OS shortcuts using XTEST, or optional KDE Wayland/uinput input.

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
    wayland = os.environ.get('STILL_TEST_WAYLAND') == '1'
    if not wayland and (not shutil.which('xdotool') or not os.environ.get('DISPLAY')):
        raise SystemExit('This test requires xdotool and an X11/XWayland DISPLAY.')
    keyboard = None
    if wayland:
        if not os.environ.get('WAYLAND_DISPLAY') or not shutil.which('kdotool'):
            raise SystemExit('The Wayland test requires KDE, kdotool, and WAYLAND_DISPLAY.')
        from evdev import UInput, ecodes
        keyboard = UInput({ecodes.EV_KEY: list(range(1, 256))}, name='Still shortcut test')
        time.sleep(.8)
    else:
        os.environ.pop('WAYLAND_DISPLAY', None)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = RESULTS / f'keyboard-profile-{int(time.time())}'
    with browser(profile, 'native-keys') as driver:
        for i in range(5):
            driver.execute_script('window.openWebLinkIn(arguments[0],"current",{targetBrowser:window.StillBrowser.slots[arguments[1]].linkedBrowser});', [f'http://127.0.0.1:{server.server_port}/StillKeyFixture-{i+1}', i])
        wait(driver, 'return window.StillBrowser.slots.every(t=>!t.hasAttribute("busy"));')
        driver.execute_script('window.StillBrowser.select(1);')
        if wayland:
            pid = driver.execute_script('return Services.appinfo.processID;')
            candidates = subprocess.check_output(['kdotool','search','--all','--pid',str(pid),'--class','com.tim.still'], text=True).splitlines()
        else:
            candidates = subprocess.run(['xdotool','search','--onlyvisible','--class','com.tim.still'], capture_output=True, text=True).stdout.splitlines()
        selected = None
        for identifier in candidates:
            title = subprocess.run(['kdotool' if wayland else 'xdotool','getwindowname',identifier], capture_output=True,text=True).stdout
            if 'StillKeyFixture-' in title:
                selected = identifier
                break
        if selected is None:
            raise AssertionError('The isolated fixture window was not found.')
        if not wayland:
            subprocess.run(['xdotool','windowactivate','--sync',selected], capture_output=True, check=False)
            subprocess.run(['xdotool','windowfocus','--sync',selected], check=True)
        def key(value):
            if wayland:
                subprocess.run(['kdotool','windowstate','--remove','MINIMIZED',selected],check=True)
                subprocess.run(['kdotool','set_desktop_for_window',selected,'current_desktop'],check=True)
                focused = False
                for _ in range(5):
                    subprocess.run(['kdotool','windowraise',selected,'windowactivate',selected],check=True)
                    time.sleep(.3)
                    if subprocess.check_output(['kdotool','getactivewindow'],text=True).strip() == selected:
                        focused = True
                        break
                if not focused:
                    raise AssertionError('Test window lacks focus; no keys sent.')
                name = value.split('+')[1].upper()
                code = getattr(ecodes, 'KEY_' + name)
                try:
                    keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTCTRL, 1)
                    keyboard.syn()
                    keyboard.write(ecodes.EV_KEY, code, 1)
                    keyboard.syn()
                    time.sleep(.04)
                finally:
                    keyboard.write(ecodes.EV_KEY, code, 0)
                    keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTCTRL, 0)
                    keyboard.syn()
            else:
                subprocess.run(['xdotool','key','--clearmodifiers',value],check=True)
            time.sleep(.12)
        key('ctrl+3')
        check('real Ctrl+3 from content switches slots', driver.execute_script('return window.StillBrowser.selectedIndex===2;'))
        driver.set_context('content')
        driver.execute_script('document.getElementById("field").focus();document.addEventListener("keydown",event=>{if(event.ctrlKey && ["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();}},true);')
        driver.set_context('chrome')
        key('ctrl+Left')
        check('real Ctrl+Left switches to the previous slot', driver.execute_script('return window.StillBrowser.selectedIndex===1;'))
        key('ctrl+Right')
        check('real Ctrl+Right switches to the next slot', driver.execute_script('return window.StillBrowser.selectedIndex===2;'))
        key('ctrl+1')
        key('ctrl+Left')
        check('Ctrl+Left stays at the first slot', driver.execute_script('return window.StillBrowser.selectedIndex===0;'))
        key('ctrl+5')
        key('ctrl+Right')
        check('Ctrl+Right stays at the last slot', driver.execute_script('return window.StillBrowser.selectedIndex===4;'))
        key('ctrl+3')
        key('ctrl+Tab')
        check('real Ctrl+Tab commits the quick-switch dock', driver.execute_script('return window.StillBrowser.selectedIndex===3 && !window.StillBrowser.dockOpen;'))
        driver.execute_script('window.StillBrowser._clearCount=0; const old=window.StillBrowser.clear; window.StillBrowser.clear=function(i){this._clearCount++;return old.call(this,i);};')
        key('ctrl+w')
        check('real Ctrl+W clears exactly once', driver.execute_script('return window.StillBrowser._clearCount===1 && gBrowser.tabs.length===5 && window.StillBrowser.slots[3].linkedBrowser.currentURI.spec.endsWith("/start.html");'))
        key('ctrl+t')
        check('real Ctrl+T uses an empty slot and focuses native address entry', driver.execute_script('return window.StillBrowser.selectedIndex===3 && window.gURLBar.focused;'))
        check('no native shortcut errors', driver.execute_script('return !Services.console.getMessageArray().some(x=>/Still (native chrome|bootstrap|session save):/.test(x.message||""));'))
    server.shutdown()
    if keyboard:
        keyboard.close()
    print('Native OS keyboard tests passed.', flush=True)


if __name__ == '__main__':
    main()
