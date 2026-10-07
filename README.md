# Still Native

Still is a calm browser with five persistent slots. This native edition replaces the Electron webviews with a complete Firefox/Gecko runtime and custom browser chrome. Websites run in native, sandboxed browser tabs. Google sign-in stays inside Still; there is no external-login handoff, cookie transplantation, user-agent spoof, or injected page bridge.

Based on the latest upstream Still source at `7b114e4` (release `v0.1.4`). The initial native engine is Mozilla Firefox **157.0.1**, the stable release reported by Mozilla on October 7, 2026. This branch currently packages **Linux x86-64**. The older Windows/Electron release remains in Git history and upstream releases.

## What works

- Five fixed slots with keyboard switching, drag reorder, middle-click clearing, a quick-switch dock, and session restoration.
- A rail that appears at the top edge; double-click a slot or press Ctrl+L to use the native address bar, history suggestions, and connection/security information.
- Native bookmarks, history, downloads, extensions, developer tools, private windows, camera/microphone/location prompts, password management, and content sandboxing.
- Native authentication popups with their original opener, principal, and cookies. Authentication popups are temporary and aren't revived as browsing windows on restart.
- YouTube video, MP3, and thumbnail downloads through a SHA-256-verified bundled `yt-dlp`. FFmpeg is required for format conversion and merging.
- System/light/dark themes and selectable Instant, Quick Slide, Elastic/Squish, and Ripple transition modes. OS reduced-motion settings take precedence.

The browser has a separate profile at `~/.config/Still Native`. Your existing Firefox installation and profile are independent. Installing over Still updates the Still desktop launchers and leaves its original AppImage and profile available for rollback.

## Build and run

Build requirements: Python 3.12+, Node.js 22.12+, tar/xz support, and network access for the engine and downloader. The installed application needs Python and the standard Firefox Linux runtime libraries; it does **not** run Electron or Node for browsing.

```sh
npm ci
npm run check
npm test
npm run pack
npm start
```

`pack` downloads the pinned engine from Mozilla, verifies its SHA-512 against Mozilla's release checksums, and bundles Still's UI and the verified downloader into `dist/still-linux-x64`. Repeated builds reuse verified downloads. `npm run dist:linux` also creates a distributable `.tar.xz` archive. Generated binaries and profiles are not committed.

```sh
npm run install:native
```

The installer switches the Still launchers to `~/.local/opt/still-browser/native/still`. Previous launchers and replaced native builds are preserved under `~/.local/opt/still-browser/backups/<timestamp>`. It reads the old Still localStorage database without opening it for writing, migrates five slot addresses and browsing history/bookmarks, and imports history/bookmarks into native Places on the first launch. Existing native profiles aren't re-imported. Login sessions, saved passwords, and extensions from Electron require fresh sign-in or native installation.

## Controls

| Action | Shortcut |
| --- | --- |
| Switch slots | Ctrl+1 through Ctrl+5 |
| Previous / next slot | Ctrl+Left / Ctrl+Right |
| Address and native suggestions | Ctrl+L |
| Next empty slot | Ctrl+T |
| Clear current slot | Ctrl+W |
| Undo closed slot | Ctrl+Shift+T |
| Quick-switch dock | Hold Ctrl and press Tab; release Ctrl to commit |
| Previous/next slot | Alt+Up / Alt+Down |
| Back/forward | Alt+Left / Alt+Right |
| Reload / bypass cache | Ctrl+R / Ctrl+Shift+R |
| Downloads / bookmarks / history | Ctrl+J / Ctrl+B / Ctrl+H |

New links occupy an empty slot. If all five are used, Still asks which slot to replace. Cancelling closes only the incoming page. Website-requested popup windows remain native windows so authentication flows retain their opener. Before-unload prompts remain active when clearing or replacing a slot.

## Motion and performance

The native tab switches immediately. Still then applies a cancellable transform to Gecko's composited tab panel; it never captures page screenshots, copies full-page textures through JavaScript, or waits for an animation to finish before selecting another tab. Elastic mode adds a small GPU-composited squish. Ripple adds a procedural WebGL light wave over the native page, **not pixel-level distortion of webpage content**. The shader reuses its program, geometry, and buffers, caps resolution, stops after 220 ms, and falls back to the transform if WebGL is unavailable or lost.

Gecko retains up to five tab layer caches, warms tabs on pointer hover, and keeps its normal memory-pressure behavior. The native Wayland path and hardware acceleration remain enabled. There are no `--disable-gpu`, `--no-sandbox`, or permanent animation loops. Web content and videos retain their own native compositor and accessibility tree.

Open Tools → Measure transition frame rate for an explicit short `requestAnimationFrame` timing measurement. This measures browser chrome frame callbacks; it is **not** a guarantee of every frame reaching the screen or of arbitrary websites maintaining 120 fps. Results depend on page load, GPU, other applications, and display refresh rate.

## Engine updates

Firefox's native update mechanism is retained. Also use the reproducible build route to refresh the pinned stable engine and validate Still's chrome against new engine APIs:

```sh
npm run update:engine
npm run check
npm test
npm run test:native
npm run install:native
```

The browser UI uses native chrome APIs, some of which can change between engine versions. Run the integration suite when updating. Mozilla's runtime includes its original license and notices; engine source is linked in `native/engine.json`. This is a Still application distribution built around Mozilla's full runtime, not a claim that this branch rewrites Gecko or is an official Mozilla product.

## Native integration tests

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r tests/requirements.txt
.venv/bin/python tests/native_smoke.py
.venv/bin/python tests/native_keys.py
```

Tests create their own profiles and local HTTP fixtures. They cover start-page and native address-bar submission, rendering after navigation, requested URLs in new windows, migration fallback ownership, real native tabs, page/chrome separation, transition/shader lifecycle, rapid cancellation, overflow and replacement, authentication popups, native downloads, migration, and session restore. The separate keyboard suite requires `xdotool` and an X11/XWayland display and checks real OS accelerators; WebDriver content key synthesis does not exercise browser shortcuts. Artifacts and measurements go into ignored `test-results/`. Only these test launches enable Marionette and remote system access; normal Still launches enable neither. Account passwords and Google authentication are never automated by the suite.

## License

Still's code is MIT-licensed. The bundled Mozilla runtime retains Mozilla's MPL and other third-party notices, and `yt-dlp` retains its own upstream licensing. Runtime source and provenance are included in `engine.json`.
