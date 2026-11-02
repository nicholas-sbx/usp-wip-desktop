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

### Linux overlay backends

| Session | Overlay |
| --- | --- |
| Wayland with `wlr-layer-shell` (KDE Plasma, Sway, Hyprland, river, labwc, Wayfire, niri, COSMIC) | Native Wayland: always on top (incl. fullscreen), click-through, native per-monitor (fractional) scale and refresh rate. See [native/wayland-overlay](native/wayland-overlay/README.md). |
| Wayland without layer-shell (GNOME) | X11 overlay through XWayland. Electron >= 38 picks its display backend before our code runs, so the app relaunches itself once with `--ozone-platform=x11`. |
| X11 | X11 overlay |

Set `USPWIP_OVERLAY=x11` or `USPWIP_OVERLAY=layer-shell` to override the detection.
