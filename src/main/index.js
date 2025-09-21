import { app, BrowserWindow, ipcMain, screen, session, protocol, net } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import path from 'node:path'
import url from 'node:url'

if (!app.requestSingleInstanceLock()) {
  console.error('You cannot open more than one instance of this application.')
  app.quit()
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
}
// fractional scaling messes with our pixel perfect positioning :(
app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)
    const ERURL = process.env['ELECTRON_RENDERER_URL']

    if (!is.dev || !ERURL || !parsedUrl || parsedUrl.origin !== ERURL) {
      console.error('Illegal navigation prevented')
      event.preventDefault()
    }
  })

  contents.setWindowOpenHandler(() => {
    console.error('Illegal window.open prevented')
    return { action: 'deny' }
  })
})

var overlayWindow
var primaryWindow
var newPointers = []
var overlayDimensions = { width: 0, height: 0 }
var overlayDisplayId = 0
var overlayMoveHint = false

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      devTools: is.dev
    },
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
  // overlayWindow.webContents.openDevTools()

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    overlayWindow.loadURL('app://renderer/overlay.html')
  }
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      devTools: is.dev
    }
  })

  primaryWindow.on('ready-to-show', () => {
    primaryWindow.show()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    primaryWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/primary.html`)
  } else {
    primaryWindow.loadURL('app://renderer/primary.html')
  }

  primaryWindow.on('focus', () => {
    // MASSIVE hack to fix hover state on button sticking
    // console.log('hacking')
    // primaryWindow?.webContents?.sendInputEvent({
    //   type: 'mouseMove',
    //   x: -100,
    //   y: -100
    // })
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  primaryWindow.on('blur', () => {
    // overlayMoveHint = false
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  primaryWindow.on('close', () => {
    app.quit()
  })
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const NO_HIGHER_THAN = path.join(__dirname, '../')
    let requestedPath = request.url.slice('app://'.length)
    let joinedPath = path.normalize(path.join(NO_HIGHER_THAN, requestedPath))
    if (!joinedPath.startsWith(NO_HIGHER_THAN)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(url.pathToFileURL(joinedPath).toString())
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'clipboard-sanitized-write') {
      callback(true)
    } else {
      callback(false)
      console.error(`Auto denied permission: "${permission}"`)
    }
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.uspwipdesktop.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  var primaryDisplay = screen.getPrimaryDisplay()
  overlayDisplayId = primaryDisplay.id
  createOverlayWindow(primaryDisplay)
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

  ipcMain.on('update-pointers', (_, np) => {
    newPointers = np
    overlayWindow?.webContents?.send('update-pointers', newPointers)
  })

  ipcMain.on('toast-notification', (_, nfn) => {
    overlayWindow?.webContents?.send('toast-notification', nfn)
  })

  ipcMain.on('overlay-ready', () => {
    overlayWindow?.webContents?.send('update-pointers', newPointers)
    overlayWindow?.webContents?.send('show-monitor-locator', primaryWindow?.isFocused() ?? false)
  })

  // we want the overlay to tell us its dimensions bcs display scaling could make the window size not match the "px" inside the overlay
  ipcMain.on('overlay-dimensions', (_, ovd) => {
    overlayDimensions = ovd
    primaryWindow?.webContents?.send('overlay-dimensions', overlayDimensions)
  })

  ipcMain.on('primary-ready', () => {
    primaryWindow?.webContents?.send('overlay-dimensions', overlayDimensions)
  })

  ipcMain.on('titlebar-move-overlay', () => {
    const displays = screen.getAllDisplays()
    const currentIndex = displays.findIndex((d) => d.id === overlayDisplayId)
    const nextDisplay = displays[(currentIndex + 1) % displays.length]

    overlayWindow?.close()
    overlayDisplayId = nextDisplay.id
    createOverlayWindow(nextDisplay)
  })

  ipcMain.on('titlebar-move-overlay-hint', (_, hovered) => {
    overlayMoveHint = hovered
    overlayWindow?.webContents?.send('show-monitor-locator', shouldShowOverlay())
  })

  screen.on('display-added', tryRecreatingOverlay)
  screen.on('display-removed', tryRecreatingOverlay)
  screen.on('display-metrics-changed', tryRecreatingOverlay)

  ipcMain.on('titlebar-minimize', () => {
    primaryWindow?.minimize()
  })

  ipcMain.on('titlebar-close', () => {
    primaryWindow?.close()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

function shouldShowOverlay() {
  return primaryWindow?.isFocused() && overlayMoveHint
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
  overlayWindow?.webContents?.send('toast-notification', {
    timestamp: Date.now().toString(),
    content: content,
    colors: {
      border: borderColor,
      text: textColor,
      shadow: shadowColor,
      background: backgroundColor
    },
    timeout: timeout
  })
}
