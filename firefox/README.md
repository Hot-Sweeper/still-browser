# Still on Firefox Desktop

Still running on a real, signed Firefox instead of Electron. It does not
install Firefox, change Windows defaults, copy cookies, or replace the
existing Electron build.

Why: Google's OAuth policy rejects embedded user agents. Still needs a real
desktop browser foundation; changing Electron's user agent or view type is not
a supported fix.

## How it is built

Two layers on top of an unmodified Firefox desktop runtime. The daily Windows
deployment currently uses signed Firefox **159.0.1**; the extension's minimum
version is 156. Linux migration must use the Firefox implementation below,
with a matching or newer native Linux runtime and a copy of the existing
profile. The older `dist:linux` target packages the Electron implementation.

1. **Window layer** (`chrome/`). Firefox's enterprise autoconfig hook
   (`still-autoconfig.js` + `still.cfg`) loads `chrome/content/still-window.js`
   and `still-window.css` into every normal browser window. This replaces the
   Firefox toolbars with Still's chrome: the auto-hiding five-slot bar, window
   controls, utility button and panels, slot dock, new-slot edge, wall bumps,
   slot editor with history suggestions, and the five-slot limit dialog.
   Firefox tabs *are* the slots, so session restore, permissions prompts,
   downloads, zoom, find, and sign-in popups stay native Firefox.
2. **Page layer** (`extension/`). The WebExtension with Still's start page,
   local SearXNG search, YouTube scripts, and channel manager. The window layer
   loads it as a temporary add-on at each start (release Firefox only runs
   unsigned extensions that way); its storage and address are kept between
   starts. It never injects into `accounts.google.com`.

`install-runtime.js` copies the signed runtime from
`D:\Still Firefox Prototype\runtime\core` to `runtime\still` once and installs
both layers there. The original runtime folder is never modified.

### Slot switching

All slots sit side by side on one strip moved by a spring. Each input
(Ctrl+wheel, dock, Ctrl+1..5, Ctrl+Tab, slot clicks) retargets the spring from
its current position and speed, so a fast wheel spin glides through slots with
momentum instead of restarting an animation per notch. At the first or last
slot a notch pushes the strip and it rubber-bands back; quick repeated notches
stretch further (capped). Past the last slot, the strip leans toward a "+" and
one more notch opens a slot that slides in.

The spring is sampled ahead of time into keyframes that run on Firefox's
compositor at the display refresh rate. Firefox keeps the five most recent
tabs painted (`browser.tabs.remote.tabCacheSize = 5`), so the strip shows live
pages. Back/forward slides vertically with the same spring curve. Reduced
motion turns all slides off.

Ctrl+wheel over pages comes from Still's existing mouse helper
(`npm run build:mouse-helper`), which the window layer starts automatically when
it was built.

### Performance budget

`npm run firefox:check-ui` ends with a benchmark on three animated WebGL shader
pages. Last measured on this machine (Firefox 156, Windows 11):

| Measure | Result |
| --- | --- |
| Input to slide start | 3 to 4 ms |
| Slide runs on the compositor (not blocked by a busy UI thread) | yes, both pages |
| Shader frame rate while its slot slides in | ~150 fps, same as at rest |
| Reversing mid-slide | continues from the on-screen position (1 px difference) |
| Frame interval during a Ctrl+wheel spin | 6.9 ms (144 Hz display) |
| Edge rubber band | stretches ~80 px, settles with ~1 px overshoot |
| Back/forward snapshot | ~8 to 40 ms on normal pages, capped at 90 ms |

Rules that keep it that way:

- No `backdrop-filter`: it cannot see page content in Firefox but still costs a
  render pass every frame.
- No page captures for decoration: surfaces are solid tints. A capture can
  never be live and costs a full repaint of the page (on a video tab, a copy of
  the video frame through the CPU).
- Nothing copies a video frame with a 2D canvas or `-moz-element`: in Firefox
  each copy of a hardware-decoded frame goes through the CPU (10 ms or more at
  1080p). The YouTube edge fill uses WebGL and uploads each newly presented video
  frame once, gated by the native presented-frame counter. It samples during
  the paint cycle without uploading a 24/30 fps frame again on every 144 Hz
  display refresh.
- Neighbouring slots and hovered slots are warmed so their first paint is ready
  before the switch.

### Startup

The browser starts its own Still Search service (port 48230; reuses one that
is already running) and the mouse helper, and stops both on quit. Firefox's
pre-start placeholder window, onboarding, and default-browser prompt are off.
The first window plays the Still mark: the five bars slide in from alternating
sides, a slow wave runs through them while Firefox finishes, then the mark lifts
away, the start page settles in, and the slots drop in once. The bars are images
so the animation runs on the compositor even while startup keeps the main
thread busy. It never waits longer than about three seconds, and reduced motion
shows a plain fade. On a brand-new profile Firefox's graphics self-test window
flashes once; that check protects hardware video decoding and is left on.

The window and taskbar icon is set from `build/icon.ico` through the Windows
API, because Firefox no longer reads icon overrides.

### Still Search

The start page is also the search page. Searching keeps you there: results
from the bundled SearXNG arrive in Still's design with All, Images, Videos,
and News, a topic panel (for example Wikipedia), and an in-page image
preview. SearXNG's own pages never show: when Firefox is about to open one
(right-click "Search for...", a typed address, a SearXNG link), the window layer
opens the same query in Still Search instead.

SearXNG is pinned in `scripts/searxng-pin.json` (commit plus the SHA-256 of
its source archive). `npm run searxng:update` moves the pin to the newest
upstream commit, verifies and rebuilds it, and restores the previous pin if the
build fails. The runtime copies a new build in on the next start of Still.

### Surfaces

Firefox cannot apply `backdrop-filter` to page content (pages render in another
process), so the slot bar, panels and dock use solid tints instead of blur. The
current slot is the brighter fill, and the slot you switch to gives a soft
squish. Only each slot's surface wobbles; its icon and title never scale.
`node firefox/tools/capture-slots.js [theme] [scale]` captures close-ups of
the bar at rest, hovered, pressed and mid-drag.

### YouTube

- Watch pages hide recommendations (beside and under the video, the
  fullscreen grid, the pause overlay and the end-screen wall). A playlist or
  live chat keeps its column.
- Playback always uses the native video surface. Live mirrored edges are an
  optional GPU effect, disabled by default.
- The home page has a History view (YouTube's own watch history, with watch
  progress). Channel feeds are cached across restarts, shown at once, and
  refreshed in the background only from the home page, six requests at a time.

## Agents (MCP and CLI)

AI agents such as Claude Code, Codex and T3 Code can use Still, with your own
tabs, cookies and saved sign-ins.

- `still mcp` is an MCP server (stdio). Register it once with
  `still agent setup`, which adds it to Claude Code and Codex. T3 Code runs
  those agents, so it picks it up too. Any other MCP client can use the
  command `still` with the argument `mcp`.
- `still agent <command>` does the same from a shell. Run `still agent help`
  for the list (tabs, open, snapshot, click, type, login, signed-in and more).
- Inside Still, `chrome/content/StillAgent.sys.mjs` listens on
  `$XDG_RUNTIME_DIR/still/agent.sock`, which only your user can open. When an
  agent connects, it starts Firefox's own WebDriver BiDi engine in its
  "dynamic" mode, which Firefox built for AI assistants: `navigator.webdriver`
  stays false and no preferences change. It connects to that engine
  in-process. Firefox puts these sessions in a separate container, so Still
  points them at the default one to keep your sign-ins.
- Page snapshots (an accessibility tree with refs like `e12`, including
  cross-origin frames) come from Playwright's injected script. It is vendored
  as `chrome/content/still-agent-playwright.js` (Apache-2.0), and
  `tools/agent/extract-playwright-injected.js` refreshes it from a
  playwright-core package.
- Pages an agent opens are hidden agent tabs, outside the five slots. A mark
  in the bar shows that an agent is connected and turns while it works, with
  the agent's tabs as small icons beside it. Its panel lists the agent's
  tabs (drag one into the slots, or click to show it in a slot), the recent
  steps and where they happened, and stops agent access.
- On the page in front of you the agent has its own pointer: it moves to the
  element the agent is about to use, rings it and says what it does
  ("Clicking “Sign in”"). Other steps are told at the bottom left, and a thin
  light runs along the top edge. A slot behind the current one that the
  agent works in is outlined.
- When the agent works in a tab you are not looking at, a live view at the
  bottom right shows that page as it changes, with the agent's pointer on it
  and the current step. "Show" brings it into a slot; the panel's Live view
  switch (pref `still.agent.liveView`) turns it off and on. It captures the
  page only while the agent works, a few times a second at most.
- `log_in` fills a sign-in form from Firefox's saved passwords. The password
  is typed into the page and never returned to the agent. A Primary Password,
  if you set one, still asks you first.
- Turn agent access off with the pref `still.agent.enabled` = false.
- Install the client's dependencies once with
  `npm install --prefix firefox/agent`.

## Run and check

- `npm run firefox:shortcut` creates **Still (Firefox)** shortcuts on the
  Desktop and in the Start menu that open the browser directly (no terminal).
  `node firefox/tools/create-shortcut.js --remove` deletes them.
- `npm run firefox:run` builds the extension, installs the runtime layers, and
  opens Still with the persistent profile `D:\Still Firefox Prototype\profile`
  (override with `STILL_FIREFOX_PROFILE`). No automation is attached.
- `npm run firefox:check` checks syntax and lints the extension.
- `npm run firefox:check-arrange` drags slots, drops links, text and agent
  tabs on them, and checks the agent's pointer, panel and a real agent client
  on disposable headless profiles. Set `STILL_CHECK_THEME=dark` for another
  appearance. Captures go to `firefox/.local/checks/arrange-*.png`.
- `npm run firefox:check-ui` drives a disposable profile through Marionette and
  writes window captures to `firefox/.local/checks/`. Pages there see a
  remote-controlled browser (robot icon in the window), so never use that
  harness for sign-in testing.

Rollback: `git switch main` returns to the pre-migration branch, and the
installed Electron Still is unchanged.

## Gates before switching the default browser

- [ ] Google sign-in and Claude desktop OAuth callback
- [ ] Google Drive preview, downloads, and popup flows
- [x] Five-slot window chrome, slot editor, dock, slide animations (checked in captures)
- [ ] Navigation gestures on real hardware (Ctrl+wheel, mouse back/forward)
- [x] New-tab search through local SearXNG
- [ ] YouTube Normal / Selective / Music / Subscriptions / History modes and manager
- [ ] YouTube download controls (the page buttons have no Firefox handler yet)
- [ ] Bookmarks, history, downloads, permissions, zoom, keyboard shortcuts
- [ ] Microphone, camera, passkeys, file uploads, and external app links
- [ ] Default-browser registration, profile migration, and update/rollback path

## Not ported yet

- YouTube downloads (yt-dlp bridge), the back/forward history timeline, Browser
  Setup panel, Opera import, the `editor` page.
- The page-edge stretch behind wall bumps (Firefox shows black there).

## Native fork (later)

A sparse upstream checkout is at `D:\StillFirefoxSource`, branch `still-chrome`,
pinned to `cdc95c93c91b09d3a4c38be355b5ef5bfd631075`. The portable MozillaBuild
toolchain is unpacked to `D:\MozillaBuild`; its installer has **not** run.
A compiled fork is only needed if autoconfig stops being enough (branding,
installer, signing Still's extension).

## Linux setup

Use Node 22.12 or newer and a native Firefox 159.0.1 or newer. On Arch and
CachyOS, the default source runtime is `/usr/lib/firefox`. Override it with
`STILL_FIREFOX_SOURCE_RUNTIME` on distributions using another directory.

```sh
npm ci --ignore-scripts
npm run firefox:check
node scripts/build-searxng.js
npm run firefox:shortcut
npm run firefox:run
```

The Linux runtime and profile live under `$XDG_DATA_HOME/still`, defaulting to
`~/.local/share/still`. Runtime executables, permissions and distro library
symlinks are preserved. Still Search uses its native Linux executable. Linux uses a private `still` executable as well as the `still` app ID and a separate remote-command namespace,
so the taskbar groups them under Still and links reach the existing Still
process even when Firefox is also running. Windows
icon APIs remain gated; page actors handle gestures inside Firefox on Wayland.
`node firefox/tools/create-shortcut.js --remove` removes the Linux desktop entry.

Copy personal profiles only while the source browser is closed. Preserve an
untouched backup and use a separate working profile. Login sessions, external
authentication, audio/video and gesture behavior still require normal manual
checks. Never attach the UI automation harness to a personal profile.

The runtime is a private copy. After a system Firefox security update, close
Still, remove only its runtime `.still-runtime-complete` marker, and rerun the
launcher to refresh the runtime. Never remove the profile to update Firefox.

Unchanged launches do not recopy the window layer or invalidate Firefox's
compiled startup caches. The installer hashes the deployable Still files and
only installs and purges caches when those inputs change.

`npm run firefox:check-linux-launch` uses a disposable profile and test runtime
to check Linux identity, startup, repeated-launch link routing and cache reuse.
On KDE it also checks Plasma’s actual task model with `qml6`, including the
application name and launcher association.
It does not attach automation to the personal profile.

### Scrolling

Middle-button hold/drag and click-to-latch use Firefox's native autoscroll,
including nested scroll containers. Still enables `general.autoScroll` and
disables Linux selection paste (`middlemouse.paste`) so it does not steal that
gesture. Smooth scrolling and APZ autoscroll are enabled as defaults; user
preferences still win. Display refresh remains automatic, with no forced FPS
or graphics-driver overrides.

The page actor's Ctrl+wheel listener is passive. Firefox's native Ctrl+wheel
action is already disabled, so ordinary wheel input does not need to wait for
Still on the content thread. YouTube action-row discovery is coalesced to one
animation frame and ignores mutations inside Still's own controls.

`npm run firefox:check-scrolling` checks native autoscroll, nested wheel
scrolling, Ctrl+wheel slot switching, and YouTube video-frame scheduling and
pause/cleanup on local fixtures using a disposable profile. WebDriver targets
content rather than native popup events, so the check cancels autoscroll via
Firefox's native browser API; physical mouse-release behavior needs a manual
check.

Still enables Firefox's native mass-spring-damper wheel physics to preserve
velocity between notches. APZ samples the motion at the display's vsync cadence;
`layout.frame_rate` stays automatic so lower-refresh displays and idle windows
do not waste work. The YouTube feed's search, mode controls and shelves use
solid tints instead of backdrop blur to avoid extra render passes while scrolling.

`npm run firefox:check-refresh` scrolls Still's actual YouTube home UI with
200 cards and local thumbnails. It records content animation intervals and
compositor frame intervals, checking both against the detected monitor refresh
rate. This is a local rendering workload, not a guarantee for arbitrary live
website scripts or network activity.

### Native watch-page playback

The native video element always supplies the picture. Still does not cover it
with a canvas, duplicate its decoder, or resample the main picture through
WebGL. The shared picture/edge renderer was removed because it added work and
could reduce playback frame rate.

Live mirrored edges are now off by default. The one-time
`still-youtube-native-playback-v1` migration also disables the earlier saved
edge default while retaining other Player Lab settings. After that migration,
an explicit opt-in is preserved. Player Lab labels this effect as extra GPU work.

If enabled, optional decoration stays below the native video, is capped at
1920 pixels/1x CSS resolution, and stops uploading only when offscreen, hidden or paused.
Live edges keep updating during scrolling, gated by video frame changes. It never replaces the picture. Perfect synchronization between separate
video/canvas
surfaces is not guaranteed; playback performance takes precedence.

Player time/control and comment mutations do not trigger broad page scans.
The home helper skips watch-page mutations. Native smooth scrolling, spring
physics and middle-button autoscroll remain enabled.

`npm run firefox:check-watch-refresh` checks a decoded 1080p60 fixture with all
three YouTube helpers. It verifies native video cadence/dropped frames, zero
WebGL contexts and texture uploads by default, no repeated playback/comment
scans, scroll frame pacing, migration of old saved settings, and explicit
optional edge opt-in/opt-out and live updates during scrolling. This local
workload does not cover all live YouTube codecs, quality levels or third-party scripts.

### YouTube first paint

The custom home shell is a declarative MAIN-world document-start script. It
mounts as soon as body exists, before DOMContentLoaded and slow resources, with
its own loading cards until cached channel data arrives. A small route-aware
user-origin stylesheet suppresses native feed/toolbars before the first paint.
The filter and player UI initialize at document_end instead of waiting for the
full page-load event. Cached configuration is hydrated independently, without
reinjecting all three scripts on every update.

The first-paint guard follows native SPA navigation and feed-mode changes,
allows native-only pages/dialogs, and has a three-second fallback if the shell
fails to mount. It never hides the native video surface during playback.

`npm run firefox:check-youtube-startup` installs a temporary copy of the actual
extension with local URL matches. Slow scripts/images and a strict page CSP
exercise pre-page-script bootstrap, no original-feed exposure, early custom
rendering, SPA route changes, normal-mode routes and failed-shell recovery.
