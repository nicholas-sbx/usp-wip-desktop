# USPWIP Desktop README
![](demo.png)

*See https://github.com/nicholasubc/usp-wip-web for web client*

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev

# Linux: native Wayland overlay (layer-shell compositors) needs the helper built once
$ npm run build:helper

# Linux: force the X11/XWayland overlay (e.g. on GNOME)
$ npm run dev:x11
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
# soon(tm)

# For Linux (also builds native/wayland-overlay: needs gcc, make, pkg-config, libwayland-dev)
$ npm run build:linux
```

### Guest typing and notes

While a guest's picture-in-picture controller has focus, whatever they type shows up next to their pointer on the host's screen. It stays fully visible while they type and for a while after they stop, longer for longer text but tapering off (about 3 s for a word, 5.5 s for a sentence, at most 10 s), then fades out. Longer text steps down to smaller font sizes. Clicking pins the text where it is as a smaller note. In the room screen the host can:

- **Hide bad words**: blacks out bad words in guest names and typed text as they're typed, using [obscenity](https://github.com/jo3-l/obscenity) plus extra checks for fancy Unicode letters and spaced-out letters (`src/renderer/src/censor.js`, tests: `npm test`). The hidden characters keep their exact width, so text never changes shape.
- **Notes stay**: how long pinned notes last (15 seconds to "until cleared"), and **Clear notes**.

When a guest leaves (or is kicked), everything they wrote fades out: the text they were typing and their pinned notes, even ones set to stay until cleared.

### CI and releases

Every pull request and push to `main` runs lint, tests and the build in GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)), then packages the Linux AppImage and the Windows installer. Download them from the workflow run's **Artifacts** section (kept 14 days). Builds are unsigned.

**Releasing:** bump the version and merge it to `main`:

```bash
$ npm version minor --no-git-tag-version   # or patch / major, or e.g. 1.2.0-beta.1
```

When `main` has a version without a release yet, CI tags it `vX.Y.Z` and publishes both installers (plus `SHA256SUMS.txt`) as a GitHub release with notes generated from the merged pull requests. Versions with a suffix (`1.2.0-beta.1`) become pre-releases.

**Room links** point at `http://localhost:5500/public` (the web client served locally, e.g. with VS Code Live Server) unless the `USPWIP_WEB_BASE_URL` Actions variable is set to where [usp-wip-web](https://github.com/nicholas-sbx/usp-wip-web)'s `public/` folder is hosted.

### Linux overlay backends

| Session | Overlay |
| --- | --- |
| Wayland with `wlr-layer-shell` (KDE Plasma, Sway, Hyprland, river, labwc, Wayfire, niri, COSMIC) | Native Wayland: always on top (incl. fullscreen), click-through, native per-monitor (fractional) scale and refresh rate. See [native/wayland-overlay](native/wayland-overlay/README.md). |
| Wayland without layer-shell (GNOME) | X11 overlay through XWayland. Electron >= 38 picks its display backend before our code runs, so the app relaunches itself once with `--ozone-platform=x11`. |
| X11 | X11 overlay |

Set `USPWIP_OVERLAY=x11` or `USPWIP_OVERLAY=layer-shell` to override the detection.
