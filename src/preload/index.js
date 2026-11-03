import { contextBridge, ipcRenderer } from 'electron'

// Only these channels can cross the bridge. The main process additionally
// checks which window each message came from and validates every payload.
const SEND_CHANNELS = new Set([
  'update-pointers',
  'update-notes',
  'toast-notification',
  'overlay-ready',
  'overlay-dimensions',
  'primary-ready',
  'titlebar-move-overlay',
  'titlebar-move-overlay-hint',
  'titlebar-minimize',
  'titlebar-close'
])

const RECEIVE_CHANNELS = new Set([
  'update-pointers',
  'update-notes',
  'show-monitor-locator',
  'toast-notification',
  'overlay-dimensions'
])

contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    if (SEND_CHANNELS.has(channel)) ipcRenderer.send(channel, data)
  },
  receive: (channel, func) => {
    if (RECEIVE_CHANNELS.has(channel) && typeof func === 'function') {
      // never hand the IpcRendererEvent (and its `sender`) to the page
      ipcRenderer.on(channel, (_, ...args) => func(...args))
    }
  }
})
