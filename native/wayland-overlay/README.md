# uspwip-wl-overlay

Native Wayland overlay helper used on Linux when the compositor supports
`wlr-layer-shell` (KDE Plasma, Sway, Hyprland, river, labwc, Wayfire, niri,
COSMIC, ...). GNOME/Mutter does not implement layer-shell, so there the app
falls back to the X11/XWayland overlay.

Chromium can't create layer-shell surfaces, so Electron renders the overlay
page offscreen and streams only the changed rectangles to this helper over a
pipe. The helper shows them on a single layer surface that is:

- on the **overlay** layer, above normal _and_ fullscreen windows,
- **click-through**: empty input region, no keyboard interactivity,
- not pushed around by panels (`exclusive_zone = -1`),
- rendered at the monitor's **native (fractional) scale**
  (`wp_fractional_scale_v1` + `wp_viewporter`), and
- paced by **that monitor's** frame callbacks, so mixed refresh rates each run
  at their own rate.

The helper exits when its stdin closes, so it can't outlive the app. The wire
protocol is documented at the top of `uspwip-wl-overlay.c`.

## Build

```bash
# Debian/Ubuntu: sudo apt install gcc make pkg-config libwayland-dev
make            # -> build/uspwip-wl-overlay
```

`npm run build:linux` builds it automatically and electron-builder ships it as
`resources/uspwip-wl-overlay`. Runtime dependency: `libwayland-client.so.0`.

`protocols/` holds vendored protocol XML (MIT-style licenses in each file):
`wlr-layer-shell-unstable-v1` from wlr-protocols, the rest from
wayland-protocols.

## Debugging

```bash
./build/uspwip-wl-overlay --probe      # capabilities as JSON, exit 0 = usable
USPWIP_WL_DEBUG=1 npm run dev          # per-second frames/commits/MB stats
USPWIP_OVERLAY=x11 ./uspwip-desktop    # force the X11/XWayland overlay instead
```
