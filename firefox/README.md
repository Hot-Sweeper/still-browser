# Still on Firefox Desktop

This is an isolated migration prototype. It does not install Firefox, change
Windows defaults, copy cookies, or replace the existing Electron build.

Why: Google's OAuth policy rejects embedded user agents. Still needs a real
desktop browser foundation; changing Electron's user agent or view type is not
a supported fix. The prototype uses an official, signed Firefox runtime and a
WebExtension. The final five-slot window chrome requires Firefox browser UI
work after the extension proves site compatibility.

## Gates before switching the default browser

- [ ] Google sign-in and Claude desktop OAuth callback
- [ ] Google Drive preview, downloads, and popup flows
- [ ] Still's five-slot window chrome and navigation gestures
- [ ] New-tab search through local SearXNG (never silently switch to Google)
- [ ] YouTube Normal / Selective / Music / Subscriptions modes and manager
- [ ] YouTube player layout, mirror effects, download controls, and settings
- [ ] Bookmarks, history, downloads, permissions, zoom, keyboard shortcuts
- [ ] Microphone, camera, passkeys, file uploads, and external app links
- [ ] Default-browser registration, profile migration, and update/rollback path

The extension is a porting harness, **not** a parity build. It never injects
into `accounts.google.com`. It already reuses Still's YouTube page scripts and
new-tab design, and starts a separate local SearXNG service on port 48230.
It also declares Still Search as the address-bar engine. Firefox asks the user
to approve changing the default search engine when the extension is installed;
the prototype must not bypass that consent. Do not set it as your daily default
until the gates above are tested.

## Build and test

1. `npm run firefox:build` copies the current YouTube scripts, new-tab style,
   and channel catalog into `firefox/build/` without modifying Electron.
2. `npm run firefox:lint` checks the build with Mozilla's extension validator.
3. `npm run firefox:run` starts the local search sidecar and a disposable
   Firefox test profile. Set `STILL_FIREFOX_BINARY` if the signed runtime is
   not at `D:\\Still Firefox Prototype\\runtime\\core\\firefox.exe`.

The launcher uses a disposable profile by default. Do not use
`--keep-profile-changes` for a daily profile; Mozilla documents that it
disables some safety features for development.

Rollback: `git switch main` returns to the pre-migration branch, and the
current installed Still remains unchanged throughout this prototype.
