// Native Wayland overlay.
//
// Chromium can't create wlr-layer-shell surfaces, and plain xdg-shell windows
// can't be forced on top or made click-through on Wayland. So on compositors
// that support wlr-layer-shell (KDE, Sway, Hyprland, river, labwc, Wayfire,
// niri, COSMIC, ...) the overlay page is rendered offscreen and each changed
// region is streamed to `native/wayland-overlay` (uspwip-wl-overlay), which
// owns an OVERLAY-layer surface with an empty input region.
//
// See native/wayland-overlay/uspwip-wl-overlay.c for the wire protocol.

import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const MAGIC = 0x57505355
const CMD_SHOW = 1
const CMD_HIDE = 2
const CMD_FRAME = 3
const HDR_WORDS = 10
const MAX_DIM = 16384

export function resolveHelperPath(app) {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'uspwip-wl-overlay')]
    : [path.join(app.getAppPath(), 'native/wayland-overlay/build/uspwip-wl-overlay')]
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // try next
    }
  }
  return null
}

/** Synchronously asks the helper whether this compositor supports wlr-layer-shell. */
export function probeLayerShell(helperPath) {
  try {
    const result = spawnSync(helperPath, ['--probe'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return result.status === 0
  } catch {
    return false
  }
}

function unionRect(a, b) {
  if (!a) return { ...b }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  }
}

function clampRect(r, size) {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const x2 = Math.min(size.width, Math.ceil(r.x + r.width))
  const y2 = Math.min(size.height, Math.ceil(r.y + r.height))
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) }
}

/**
 * Events:
 *  'outputs'    (outputs[])  monitors known to the compositor
 *  'configured' (cfg)        surface needs a cfg.bufferWidth x cfg.bufferHeight
 *                            frame rendered at cfg.scale; (re)create the
 *                            offscreen window and call attach()
 *  'closed'     (outputName) compositor removed the surface (e.g. unplugged)
 *  'exit'       (code)       helper died
 */
export class LayerShellOverlay extends EventEmitter {
  constructor(helperPath) {
    super()
    this.helperPath = helperPath
    this.proc = null
    this.outputs = []
    this.credit = true
    this.wc = null
    this.generation = -1
    this.latest = null
    this.pending = null
    this.onPaint = null
  }

  start() {
    this.credit = true
    this.proc = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    const proc = this.proc
    proc.stdin.on('error', () => {}) // EPIPE if the helper dies; 'exit' handles it
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      this.handleMessage(msg)
    })
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null
      this.emit('exit', code ?? signal)
    })
    proc.on('error', (err) => console.error('[wayland overlay] helper failed:', err.message))
  }

  stop() {
    this.detach()
    this.proc?.stdin.end()
    this.proc = null
  }

  handleMessage(msg) {
    switch (msg?.type) {
      case 'outputs':
        this.outputs = Array.isArray(msg.outputs) ? msg.outputs : []
        this.emit('outputs', this.outputs)
        break
      case 'configured':
        if (
          Number.isInteger(msg.bufferWidth) &&
          Number.isInteger(msg.bufferHeight) &&
          msg.bufferWidth > 0 &&
          msg.bufferHeight > 0 &&
          msg.bufferWidth <= MAX_DIM &&
          msg.bufferHeight <= MAX_DIM
        ) {
          this.emit('configured', msg)
        }
        break
      case 'ready':
        this.credit = true
        this.flush()
        break
      case 'closed':
        this.emit('closed', msg.output)
        break
      case 'error':
        console.error('[wayland overlay]', msg.message)
        break
    }
  }

  send(cmd, args = [], payload = null) {
    if (!this.proc) return
    const header = Buffer.alloc(HDR_WORDS * 4)
    header.writeUInt32LE(MAGIC, 0)
    header.writeUInt32LE(cmd, 4)
    header.writeUInt32LE(payload ? payload.length : 0, 8)
    args.forEach((v, i) => header.writeUInt32LE(v >>> 0, 12 + i * 4))
    this.proc.stdin.write(header)
    if (payload?.length) this.proc.stdin.write(payload)
  }

  show(outputName) {
    this.detach()
    this.credit = true
    const name = Buffer.from(String(outputName ?? ''), 'utf8')
    this.send(CMD_SHOW, [], name.length <= 255 ? name : Buffer.alloc(0))
  }

  hide() {
    this.detach()
    this.send(CMD_HIDE)
  }

  /** Streams paint events of an offscreen webContents to the layer surface. */
  attach(webContents, generation) {
    this.detach()
    this.wc = webContents
    this.generation = generation
    this.onPaint = (_event, dirty, image) => {
      this.latest = image
      this.pending = unionRect(this.pending, dirty)
      this.flush()
    }
    webContents.on('paint', this.onPaint)
    webContents.invalidate()
  }

  detach() {
    if (this.wc && this.onPaint && !this.wc.isDestroyed()) this.wc.off('paint', this.onPaint)
    this.wc = null
    this.onPaint = null
    this.latest = null
    this.pending = null
  }

  flush() {
    if (!this.credit || !this.latest || !this.pending || !this.proc) return
    const size = this.latest.getSize()
    const r = clampRect(this.pending, size)
    this.pending = null
    if (r.width === 0 || r.height === 0) return
    const whole = r.x === 0 && r.y === 0 && r.width === size.width && r.height === size.height
    let px = (whole ? this.latest : this.latest.crop(r)).toBitmap()
    const rowBytes = r.width * 4
    if (px.length !== rowBytes * r.height) {
      // padded rows: repack tightly
      const stride = px.length / r.height
      if (!Number.isInteger(stride) || stride < rowBytes) return
      const packed = Buffer.alloc(rowBytes * r.height)
      for (let row = 0; row < r.height; row++)
        px.copy(packed, row * rowBytes, row * stride, row * stride + rowBytes)
      px = packed
    }
    this.credit = false
    this.send(
      CMD_FRAME,
      [size.width, size.height, r.x, r.y, r.width, r.height, this.generation],
      px
    )
  }
}
