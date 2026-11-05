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
  1080p). The YouTube edge fill uses WebGL, which takes the frame on the GPU
  (about 0.2 ms per frame, 144 fps on a 1080p video).
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
current slot is marked by one translucent fill that glides between slots on
the same spring as the page strip.

### YouTube

- Watch pages hide recommendations (beside and under the video, the
  fullscreen grid, the pause overlay and the end-screen wall). A playlist or
  live chat keeps its column.
- The edge fill draws the video into the gutters around it with WebGL, every
  display frame while playing, so the edges show the same frame as the video.
- The home page has a History view (YouTube's own watch history, with watch
  progress). Channel feeds are cached across restarts, shown at once, and
  refreshed in the background only from the home page, six requests at a time.

## Run and check

- `npm run firefox:shortcut` creates **Still (Firefox)** shortcuts on the
  Desktop and in the Start menu that open the browser directly (no terminal).
  `node firefox/tools/create-shortcut.js --remove` deletes them.
- `npm run firefox:run` builds the extension, installs the runtime layers, and
  opens Still with the persistent profile `D:\Still Firefox Prototype\profile`
  (override with `STILL_FIREFOX_PROFILE`). No automation is attached.
- `npm run firefox:check` checks syntax and lints the extension.
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
