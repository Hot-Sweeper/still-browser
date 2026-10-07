# Contributing

This branch migrates Still's Linux application from Electron to native Firefox/Gecko chrome.

Run `npm ci`, `npm run check`, `npm test`, and `npm run pack`. For native browser changes, install the test-only dependencies in `tests/requirements.txt` and run `tests/native_smoke.py` against the bundled runtime.

Website content must remain a normal native browser tab. Do not add user-agent spoofing, cookie transplantation, authentication automation, or privileged script bridges into pages. Only hard-coded browser-owned destinations may use `openTrustedLinkIn`; user and content URLs must use `openWebLinkIn` with the appropriate native principal.

Keep per-frame work out of JavaScript layout. Transition effects must cancel immediately, honor reduced motion, degrade gracefully, and stop drawing when idle. Validate at the target display refresh rate and record page/hardware conditions when reporting numbers.

Do not commit generated packages, engine binaries, tools, browser profiles, cookies, logs, screenshots, or other private browsing data. Check `git status` before committing. The native build downloads verified upstream runtimes; the local installer is reversible and preserves the previous launcher.

The current native distribution targets Linux x86-64. Other platforms require native packaging and testing before being advertised as supported.
