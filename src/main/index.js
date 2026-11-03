import { app, BrowserWindow, ipcMain, screen, session, protocol, net } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import path from 'node:path'
import url from 'node:url'
import { LayerShellOverlay, probeLayerShell, resolveHelperPath } from './layerShellOverlay'

// ---------------------------------------------------------------------------
// Overlay backend selection (must happen before the app is ready)
//
//  'layer-shell'  Linux + Wayland compositor with wlr-layer-shell (KDE, Sway,
//                 Hyprland, river, labwc, Wayfire, niri, COSMIC, ...): the app
//                 runs as a native Wayland client and the overlay is drawn by
//                 the native helper on the compositor's overlay layer.
//  'x11'          Linux without layer-shell (GNOME/Mutter) or plain X11: run
//                 through X11/XWayland where always-on-top + click-through work.
//  'window'       Windows/macOS.
//
// USPWIP_OVERLAY=x11 or USPWIP_OVERLAY=layer-shell overrides the detection, and
// launching with --ozone-platform=x11 always means 'x11'.
// ---------------------------------------------------------------------------

const helperPath = process.platform === 'linux' ? resolveHelperPath(app) : null
const cliOzonePlatform = app.commandLine.getSwitchValue('ozone-platform')
const waylandSession =
  process.platform === 'linux' &&
  (!!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
const overlayMode = chooseOverlayMode()

function chooseOverlayMode() {
  if (process.platform !== 'linux') return 'window'
  const forced = process.env.USPWIP_OVERLAY
  if (cliOzonePlatform === 'x11' || forced === 'x11' || !waylandSession) return 'x11'
  if (helperPath && probeLayerShell(helperPath)) return 'layer-shell'
  if (forced === 'layer-shell') {
    console.error('USPWIP_OVERLAY=layer-shell requested but it is unavailable, using x11')
  }
  return 'x11'
}

// Electron >= 38 runs as a native Wayland client by default and picks its
// display backend *before* this file runs: app.commandLine.appendSwitch(
// 'ozone-platform', 'x11') then only reaches the GPU process, so the browser
// (Wayland) and GPU (X11) processes disagree and every window stays blank.
// The flag has to be on the real command line, so relaunch once with it.
let relaunching = false
if (overlayMode === 'x11' && waylandSession && cliOzonePlatform !== 'x11') {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    console.error('The X11 overlay needs XWayland here: use `npm run dev:x11` instead.')
  } else if (!process.env.USPWIP_OZONE_RELAUNCHED) {
    process.env.USPWIP_OZONE_RELAUNCHED = '1' // inherited by the new process, prevents loops
    app.relaunch({
      // an AppImage's mount point disappears when this process exits
      execPath: process.env.APPIMAGE || process.execPath,
      args: [...process.argv.slice(1), '--ozone-platform=x11']
    })
    app.exit(0)
    relaunching = true
  }
}

if (overlayMode !== 'layer-shell') {
  // fractional scaling messes with our pixel perfect positioning :(
  // (the layer-shell overlay renders at the native per-monitor scale instead)
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
}

// ---------------------------------------------------------------------------
// Constants / validation helpers
// ---------------------------------------------------------------------------

const RENDERER_ROOT = path.join(__dirname, '../renderer')
const DEV_RENDERER_URL = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const MAX_POINTERS = 32
const MAX_NOTES = 128
const MAX_TEXT = 400 // typed text (the renderer caps it at 200)
const MAX_MASK_RANGES = 64
const MAX_FONT_STEP = 3 // FONT_STEPS in renderer/src/typing.js
const MAX_HOLD_MS = 60000
const MAX_OVERLAY_DIM = 16384

function clampNumber(value, min, max, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : fallback
}

/** [start, end) ranges of `length`-long text to hide (from the bad word filter) */
function sanitizeMask(mask, length) {
  if (!Array.isArray(mask)) return []
  const ranges = []
  for (const r of mask.slice(0, MAX_MASK_RANGES)) {
    if (!Array.isArray(r)) continue
    const start = Math.trunc(clampNumber(r[0], 0, length))
    const end = Math.trunc(clampNumber(r[1], 0, length))
    if (end > start) ranges.push([start, end])
  }
  return ranges
}

function sanitizeMaskedText(text, mask, maxLength) {
  const clean = String(text ?? '').slice(0, maxLength)
  return { text: clean, mask: sanitizeMask(mask, clean.length) }
}

function sanitizePointer(p) {
  if (!p || typeof p !== 'object') return null
  const name = sanitizeMaskedText(p.name, p.nameMask, 15)
  const draft =
    p.draft && typeof p.draft === 'object'
      ? {
          ...sanitizeMaskedText(p.draft.text, p.draft.mask, MAX_TEXT),
          rev: Math.trunc(clampNumber(p.draft.rev, 0, Number.MAX_SAFE_INTEGER)),
          holdMs: Math.trunc(clampNumber(p.draft.holdMs, 0, MAX_HOLD_MS, 3000)),
          step: Math.trunc(clampNumber(p.draft.step, 0, MAX_FONT_STEP))
        }
      : null
  return {
    peerId: String(p.peerId ?? '').slice(0, 64),
    number: Math.trunc(clampNumber(p.number, 0, 999)),
    name: name.text,
    nameMask: name.mask,
    color: HEX_COLOR.test(p.color) ? p.color : '#000000',
    x: clampNumber(p.x, 0, MAX_OVERLAY_DIM),
    y: clampNumber(p.y, 0, MAX_OVERLAY_DIM),
    rotation: clampNumber(p.rotation, -1e6, 1e6),
    mousedown: p.mousedown === true,
    active: p.active === true,
    draft: draft?.text ? draft : null
  }
}

function sanitizeNote(n) {
  if (!n || typeof n !== 'object') return null
  const { text, mask } = sanitizeMaskedText(n.text, n.mask, MAX_TEXT)
  if (!text) return null
  const time = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : null)
  return {
    id: Math.trunc(clampNumber(n.id, 0, Number.MAX_SAFE_INTEGER)),
    number: Math.trunc(clampNumber(n.number, 0, 999)),
    color: HEX_COLOR.test(n.color) ? n.color : '#000000',
    x: clampNumber(n.x, 0, MAX_OVERLAY_DIM),
    y: clampNumber(n.y, 0, MAX_OVERLAY_DIM),
    text,
    mask,
    step: Math.trunc(clampNumber(n.step, 0, MAX_FONT_STEP)),
    createdAt: time(n.createdAt) ?? Date.now(),
    expiresAt: time(n.expiresAt)
  }
}

let notificationSeq = 0
function sanitizeNotification(n) {
  if (!n || typeof n !== 'object') return null
  const color = (c, fallback) => (HEX_COLOR.test(c) ? c : fallback)
  const { text, mask } = sanitizeMaskedText(n.content, n.mask, 120)
  return {
    id: ++notificationSeq,
    content: text,
    mask,
    colors: {
      border: color(n.colors?.border, '#000000'),
      text: color(n.colors?.text, '#000000'),
      shadow: color(n.colors?.shadow, '#000000'),
      background: color(n.colors?.background, '#FFFFFF')
    },
    timeout: clampNumber(n.timeout, 500, 15000, 4000)
  }
}

function isTrustedRendererUrl(target) {
  if (typeof target !== 'string') return false
  if (target.startsWith('app://renderer/')) return true
  try {
    return !!DEV_RENDERER_URL && new URL(target).origin === new URL(DEV_RENDERER_URL).origin
  } catch {
    return false
  }
}

/** true only for IPC from the main frame of `win` showing our own page */
function isFrom(win, event) {
  return (
    !!win &&
    !win.isDestroyed() &&
    event.sender === win.webContents &&
    !!event.senderFrame &&
    event.senderFrame.parent === null &&
    isTrustedRendererUrl(event.senderFrame.url)
  )
}

function secureWebPreferences() {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    backgroundThrottling: false,
    devTools: is.dev
  }
}

function loadRenderer(win, page, query = {}) {
  const qs = new URLSearchParams(query).toString()
  const suffix = qs ? `${page}?${qs}` : page
  if (DEV_RENDERER_URL) {
    win.loadURL(`${DEV_RENDERER_URL}/${suffix}`)
  } else {
    win.loadURL(`app://renderer/${suffix}`)
  }
}

// ---------------------------------------------------------------------------
// Global web-contents lockdown
// ---------------------------------------------------------------------------

app.on('web-contents-created', (_, contents) => {
  const blockNavigation = (event, navigationUrl) => {
    let allowed = false
    try {
      allowed =
        !!DEV_RENDERER_URL && new URL(navigationUrl).origin === new URL(DEV_RENDERER_URL).origin
    } catch {
      allowed = false
    }
    if (!allowed) {
      console.error('Illegal navigation prevented')
      event.preventDefault()
    }
  }
  contents.on('will-navigate', blockNavigation)
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) {
      console.error('Illegal subframe navigation prevented')
      event.preventDefault()
    }
  })
  contents.on('will-redirect', blockNavigation)
  contents.on('will-attach-webview', (event) => event.preventDefault())

  contents.setWindowOpenHandler(() => {
    console.error('Illegal window.open prevented')
    return { action: 'deny' }
  })
})

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

var overlayWindow
var primaryWindow
var newPointers = []
var newNotes = []
var overlayDimensions = { width: 0, height: 0 }
var overlayDisplayId = 0
var overlayMoveHint = false

// layer-shell state
var layerShell = null
var overlayOutputName = null
var overlaySurfaceRequested = false
var overlayCfg = null
var helperRestarts = 0
var recentCloses = []

function destroyOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy()
  overlayWindow = null
}

function createOverlayWindow(display) {
  const { bounds } = display
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: secureWebPreferences(),
    alwaysOnTop: true,
    minimizable: false,
    transparent: true,
    closable: true,
    fullscreen: true,
    frame: false,
    hasShadow: false,
    roundedCorners: false,
    focusable: false,
    skipTaskbar: true
  })

  overlayWindow.setVisibleOnAllWorkspaces(true)
  overlayWindow.setIgnoreMouseEvents(true)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  loadRenderer(overlayWindow, 'overlay.html')
}

function createOffscreenOverlayWindow(cfg) {
  overlayWindow = new BrowserWindow({
    width: cfg.bufferWidth,
    height: cfg.bufferHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    focusable: false,
    skipTaskbar: true,
    webPreferences: { ...secureWebPreferences(), offscreen: true }
  })
  // the constructor clamps the size to the screen the app is on, which is too
  // small for a higher-resolution monitor; resizing afterwards isn't clamped
  overlayWindow.setSize(cfg.bufferWidth, cfg.bufferHeight)
  // the helper renders at the monitor's native scale; the page uses CSS zoom so
  // that 1 CSS px is still 1 logical px (Electron's offscreen deviceScaleFactor
  // is not honoured as of Electron 45). Derive it from the size we really got.
  const [contentWidth] = overlayWindow.getContentSize()
  const zoom = cfg.width > 0 && contentWidth > 0 ? contentWidth / cfg.width : cfg.scale
  loadRenderer(overlayWindow, 'overlay.html', { zoom: String(zoom) })
}

function createPrimaryWindow() {
  primaryWindow = new BrowserWindow({
    width: 350,
    height: 400,
    show: false,
    frame: false,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    transparent: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: secureWebPreferences()
  })

  // On native Wayland a hidden window gets no frame callbacks, so its first
  // paint (and 'ready-to-show') often never happens: also reveal on load.
  const reveal = () => {
    if (primaryWindow && !primaryWindow.isDestroyed() && !primaryWindow.isVisible()) {
      primaryWindow.show()
    }
  }
  primaryWindow.once('ready-to-show', reveal)
  primaryWindow.webContents.once('did-finish-load', reveal)
  setTimeout(reveal, 3000)

  loadRenderer(primaryWindow, 'primary.html')

  primaryWindow.on('focus', () => {
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  primaryWindow.on('blur', () => {
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  primaryWindow.on('close', () => {
    app.quit()
  })
}

// ---------------------------------------------------------------------------
// Native Wayland (layer-shell) overlay
// ---------------------------------------------------------------------------

function defaultOutput(outputs) {
  const primary = screen.getPrimaryDisplay().bounds
  return outputs.find((o) => o.x === primary.x && o.y === primary.y) ?? outputs[0]
}

function showOverlayOn(outputName) {
  overlaySurfaceRequested = true
  overlayOutputName = outputName
  overlayCfg = null
  destroyOverlayWindow()
  layerShell.show(outputName)
}

function startLayerShellOverlay() {
  layerShell = new LayerShellOverlay(helperPath)

  layerShell.on('outputs', (outputs) => {
    if (!outputs.length || overlaySurfaceRequested) return
    const target = outputs.find((o) => o.name === overlayOutputName) ?? defaultOutput(outputs)
    showOverlayOn(target.name)
  })

  layerShell.on('configured', (cfg) => {
    if (cfg.output) overlayOutputName = cfg.output
    const reuse =
      overlayWindow &&
      !overlayWindow.isDestroyed() &&
      overlayCfg?.bufferWidth === cfg.bufferWidth &&
      overlayCfg?.bufferHeight === cfg.bufferHeight &&
      overlayCfg?.scale === cfg.scale
    overlayCfg = cfg
    if (!reuse) {
      destroyOverlayWindow()
      createOffscreenOverlayWindow(cfg)
    }
    // follow the monitor's refresh rate (mixed refresh setups get their own)
    const fps = Math.round((cfg.refresh || 60000) / 1000)
    overlayWindow.webContents.setFrameRate(Math.min(240, Math.max(30, fps)))
    layerShell.attach(overlayWindow.webContents, cfg.generation)
  })

  layerShell.on('closed', () => {
    // output unplugged / compositor closed us: re-place on a remaining monitor
    overlaySurfaceRequested = false
    overlayCfg = null
    destroyOverlayWindow()
    const now = Date.now()
    recentCloses = recentCloses.filter((t) => now - t < 10000).concat(now)
    if (recentCloses.length > 5) {
      console.error('[wayland overlay] compositor keeps closing the overlay, giving up')
      return
    }
    setTimeout(() => {
      const outputs = layerShell.outputs
      if (overlaySurfaceRequested || !outputs.length) return
      showOverlayOn((outputs.find((o) => o.name === overlayOutputName) ?? outputs[0]).name)
    }, 250)
  })

  layerShell.on('exit', (code) => {
    overlaySurfaceRequested = false
    overlayCfg = null
    destroyOverlayWindow()
    if (quitting) return
    if (helperRestarts >= 5) {
      console.error(`[wayland overlay] helper exited (${code}), not restarting again`)
      return
    }
    const delay = 500 * 2 ** helperRestarts++
    console.error(`[wayland overlay] helper exited (${code}), restarting in ${delay}ms`)
    setTimeout(() => layerShell.start(), delay)
  })

  layerShell.start()
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

var quitting = false

if (relaunching) {
  // the relaunched process takes over
} else if (!app.requestSingleInstanceLock()) {
  console.error('You cannot open more than one instance of this application.')
  app.exit(0)
} else {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true } }
  ])
  app.whenReady().then(onReady)
}

function onReady() {
  // serve the built renderer only: app://renderer/<file under out/renderer>
  protocol.handle('app', async (request) => {
    let requested
    try {
      const parsed = new URL(request.url)
      if (parsed.host !== 'renderer') return new Response('Not Found', { status: 404 })
      requested = decodeURIComponent(parsed.pathname)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (requested.includes('\0')) return new Response('Bad Request', { status: 400 })
    const filePath = path.normalize(path.join(RENDERER_ROOT, requested))
    if (!filePath.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      return await net.fetch(url.pathToFileURL(filePath).toString())
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'clipboard-sanitized-write') {
      callback(true)
    } else {
      callback(false)
      console.error(`Auto denied permission: "${permission}"`)
    }
  })
  ses.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'clipboard-sanitized-write'
  )
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  // don't fetch hunspell dictionaries from Google's CDN on every start
  // (only an empty language list actually stops the download)
  ses.setSpellCheckerEnabled(false)
  ses.setSpellCheckerLanguages([])

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.uspwipdesktop.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (overlayMode === 'layer-shell') {
    startLayerShellOverlay()
  } else {
    var primaryDisplay = screen.getPrimaryDisplay()
    overlayDisplayId = primaryDisplay.id
    createOverlayWindow(primaryDisplay)
    screen.on('display-added', tryRecreatingOverlay)
    screen.on('display-removed', tryRecreatingOverlay)
    screen.on('display-metrics-changed', tryRecreatingOverlay)
  }
  createPrimaryWindow()

  app.on('second-instance', () => {
    if (primaryWindow) {
      if (primaryWindow.isMinimized()) primaryWindow.restore()
      primaryWindow.focus()
      sendNotification(
        'Multiple instances are not allowed',
        '#f5b158',
        '#000000',
        '#000000',
        '#f5b158',
        4000
      )
    }
  })

  // ----- IPC from the primary window (it talks to remote peers, so treat its
  // payloads as untrusted and re-validate before they reach the overlay)

  ipcMain.on('update-pointers', (event, np) => {
    if (!isFrom(primaryWindow, event) || !Array.isArray(np)) return
    newPointers = np.slice(0, MAX_POINTERS).map(sanitizePointer).filter(Boolean)
    overlayWindow?.webContents?.send('update-pointers', newPointers)
  })

  ipcMain.on('update-notes', (event, list) => {
    if (!isFrom(primaryWindow, event) || !Array.isArray(list)) return
    newNotes = list.slice(-MAX_NOTES).map(sanitizeNote).filter(Boolean)
    overlayWindow?.webContents?.send('update-notes', newNotes)
  })

  ipcMain.on('toast-notification', (event, nfn) => {
    if (!isFrom(primaryWindow, event)) return
    const notification = sanitizeNotification(nfn)
    if (notification) overlayWindow?.webContents?.send('toast-notification', notification)
  })

  ipcMain.on('primary-ready', (event) => {
    if (!isFrom(primaryWindow, event)) return
    primaryWindow?.webContents?.send('overlay-dimensions', overlayDimensions)
  })

  ipcMain.on('titlebar-move-overlay', (event) => {
    if (!isFrom(primaryWindow, event)) return
    moveOverlayToNextDisplay()
  })

  ipcMain.on('titlebar-move-overlay-hint', (event, hovered) => {
    if (!isFrom(primaryWindow, event)) return
    overlayMoveHint = hovered === true
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  ipcMain.on('titlebar-minimize', (event) => {
    if (!isFrom(primaryWindow, event)) return
    primaryWindow?.minimize()
  })

  ipcMain.on('titlebar-close', (event) => {
    if (!isFrom(primaryWindow, event)) return
    primaryWindow?.close()
  })

  // ----- IPC from the overlay window

  ipcMain.on('overlay-ready', (event) => {
    if (!isFrom(overlayWindow, event)) return
    overlayWindow?.webContents?.send('update-pointers', newPointers)
    overlayWindow?.webContents?.send('update-notes', newNotes)
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  // we want the overlay to tell us its dimensions bcs display scaling could make the window size not match the "px" inside the overlay
  ipcMain.on('overlay-dimensions', (event, ovd) => {
    if (!isFrom(overlayWindow, event)) return
    overlayDimensions = {
      width: Math.round(clampNumber(ovd?.width, 0, MAX_OVERLAY_DIM)),
      height: Math.round(clampNumber(ovd?.height, 0, MAX_OVERLAY_DIM))
    }
    primaryWindow?.webContents?.send('overlay-dimensions', overlayDimensions)
  })
}

app.on('before-quit', () => {
  quitting = true
  layerShell?.stop()
})

app.on('window-all-closed', () => {
  app.quit()
})

function shouldShowOverlay() {
  return (primaryWindow?.isFocused() ?? false) && overlayMoveHint
}

function moveOverlayToNextDisplay() {
  if (overlayMode === 'layer-shell') {
    const outputs = layerShell?.outputs ?? []
    if (!outputs.length) return
    const currentIndex = outputs.findIndex((o) => o.name === overlayOutputName)
    showOverlayOn(outputs[(currentIndex + 1) % outputs.length].name)
    return
  }
  const displays = screen.getAllDisplays()
  const currentIndex = displays.findIndex((d) => d.id === overlayDisplayId)
  const nextDisplay = displays[(currentIndex + 1) % displays.length]

  overlayWindow?.close()
  overlayDisplayId = nextDisplay.id
  createOverlayWindow(nextDisplay)
}

function tryRecreatingOverlay() {
  if (!overlayWindow) return

  const displays = screen.getAllDisplays()
  let targetDisplay = displays.find((d) => d.id === overlayDisplayId)

  if (!targetDisplay) {
    targetDisplay = screen.getPrimaryDisplay()
    overlayDisplayId = targetDisplay.id
  }

  overlayWindow.close()
  createOverlayWindow(targetDisplay)
}

// not great that this is pretty much duped between here and primary.js but ehhhhh
function sendNotification(content, borderColor, textColor, shadowColor, backgroundColor, timeout) {
  const notification = sanitizeNotification({
    content: content,
    colors: {
      border: borderColor,
      text: textColor,
      shadow: shadowColor,
      background: backgroundColor
    },
    timeout: timeout
  })
  overlayWindow?.webContents?.send('toast-notification', notification)
}
