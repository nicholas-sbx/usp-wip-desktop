import './assets/primary.css'

import { createApp, ref, watch } from 'vue'
import PrimaryApp from './PrimaryApp.vue'
import { Peer } from 'peerjs'
import { useStorage } from '@vueuse/core'
import { findBadWordRanges } from './censor'
import {
  acceptTypingMessage,
  createTypingState,
  DEFAULT_NOTE_LIFETIME,
  draftHoldMs,
  fontStep,
  MAX_NOTES,
  MAX_NOTES_PER_PLAYER,
  NOTE_LIFETIMES,
  TYPING,
  sanitizeTypedText
} from './typing'

const USPWIP_WEB_BASE_URL = 'http://localhost:5500/public'

// ---- limits for data coming from remote peers (anyone with the room link)
const MAX_PLAYERS = 16 // pointers shown on the overlay
const MAX_CONNECTIONS = 24 // open + pending data connections
const INTRO_TIMEOUT_MS = 10000 // must send client-introduction within this
const MSG_RATE_LIMIT = 150 // messages per peer per second (client sends <= ~60)
const JOIN_BURST = 8 // new connections allowed in a burst...
const JOIN_REFILL_MS = 1500 // ...then one every JOIN_REFILL_MS
const MAX_DELTA = 10000 // largest single mouse movement accepted, in px
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * PeerJS lets the *connecting* peer pick the serialization. The default
 * "binary" serializer reassembles chunked messages with no size/time limit
 * (a remote peer can exhaust our memory), so only JSON connections are kept
 * (each JSON message is a single, size-capped data channel message): the
 * 'connection' handler closes any other kind before its channel opens, so
 * nothing is ever parsed with another serializer. The serializer lookup table
 * is a plain object, so `serialization: "constructor"` would yield a bogus
 * connection that makes peer.destroy() throw (or a TypeError inside PeerJS
 * for other unknown names): unknown names get the JSON serializer instead.
 */
class JsonOnlyPeer extends Peer {
  constructor(...args) {
    super(...args)
    const known = Object.assign(Object.create(null), this._serializers)
    this._serializers = new Proxy(known, { get: (table, name) => table[name] ?? table.json })
  }
}

const hostName = useStorage('host-name', '')
// host settings
const censorEnabled = useStorage('censor-enabled', true)
const noteLifetime = useStorage('note-lifetime-seconds', DEFAULT_NOTE_LIFETIME)
if (!NOTE_LIFETIMES.some((o) => o.seconds === noteLifetime.value)) {
  noteLifetime.value = DEFAULT_NOTE_LIFETIME
}
const joinURL = ref('')
const pointers = ref([])
const noteCount = ref(0)
const whichScreen = ref('start')

const app = createApp(PrimaryApp)
app.provide('hostName', hostName)
app.provide('joinURL', joinURL)
app.provide('pointers', pointers)
app.provide('whichScreen', whichScreen)
app.provide('censorEnabled', censorEnabled)
app.provide('noteLifetime', noteLifetime)
app.provide('noteCount', noteCount)
app.mount('#app')

var peer
var internalPointers = {}
var notes = []
var lastNoteId = 0
// the connection each guest's pointer belongs to (kept out of the pointer
// objects, which are turned into what the overlay gets)
var pointerConns = new Map()
var overlayDimensions = { width: 0, height: 0 }
var joinTokens = JOIN_BURST
var joinRefillTimer = null

window.api.receive('overlay-dimensions', (ovd) => {
  overlayDimensions = ovd
})
window.api.send('primary-ready')

publishPointers()

// re-render everything when the host changes a setting
watch(censorEnabled, () => {
  publishPointers({ list: true })
  publishNotes()
})
watch(noteLifetime, () => {
  for (const note of notes) {
    note.expiresAt = noteExpiry(note.createdAt)
    scheduleNoteExpiry(note)
  }
  publishNotes()
})

window.clearNotes = function () {
  removeNotes(() => true)
}

window.copyJoinLink = async function () {
  try {
    await navigator.clipboard.writeText(joinURL.value)
    sendNotification('USPWIP room link copied!', '#70e976', '#000000', '#000000', '#70e976', 6000)
  } catch (e) {
    console.error(e)
    sendNotification('Failed to copy room link', '#ff6b6b', '#000000', '#000000', '#ff6b6b', 4000)
  }
}

window.kickPeer = function (peerId) {
  if (!peer || !peerId) return

  for (const conn of peer.connections[peerId] ?? []) {
    try {
      conn.close()
    } catch (err) {
      console.error(err)
      sendNotification('Failed to kick', '#ff6b6b', '#000000', '#000000', '#ff6b6b', 4000)
    }
  }

  pointerConns.delete(peerId)
  if (peerId in internalPointers) {
    clearTimeout(internalPointers[peerId].draftTimer)
    delete internalPointers[peerId]
    publishPointers({ list: true })
  }
  removeNotes((note) => note.peerId === peerId)
}

function destroyPeer() {
  if (!peer) return
  try {
    peer.destroy()
  } catch (err) {
    console.error(err)
  }
  peer = null
  for (const p of Object.values(internalPointers)) clearTimeout(p.draftTimer)
  internalPointers = {}
  pointerConns.clear()
  publishPointers({ list: true })
  removeNotes(() => true)
}

window.destroyPeerJS = function () {
  whichScreen.value = 'start'
  destroyPeer()
}

function newRoomId() {
  // 64 bits: short enough to share, not practical to guess
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// every tracked connection, including ones still negotiating (each already
// holds an RTCPeerConnection, so pending ones count against the cap too)
function connectionCount() {
  if (!peer) return 0
  return Object.values(peer.connections).reduce((n, list) => n + list.length, 0)
}

function takeJoinToken() {
  if (!joinRefillTimer) {
    joinRefillTimer = setInterval(() => {
      joinTokens = Math.min(JOIN_BURST, joinTokens + 1)
      if (joinTokens === JOIN_BURST) {
        clearInterval(joinRefillTimer)
        joinRefillTimer = null
      }
    }, JOIN_REFILL_MS)
  }
  if (joinTokens <= 0) return false
  joinTokens--
  return true
}

function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '') // control + bidi/format characters
    .substring(0, 15)
    .trim()
}

window.startPeerJS = function () {
  whichScreen.value = 'room'
  destroyPeer()
  const wmID = newRoomId()
  const thisPeer = new JsonOnlyPeer(`uspwip-fun-super-unique-id-${wmID}`)
  peer = thisPeer
  joinURL.value = `${USPWIP_WEB_BASE_URL}/join#${wmID}`
  window.copyJoinLink()

  thisPeer.on('error', (err) => {
    console.error(err)
    if (err?.type === 'unavailable-id' && peer === thisPeer) {
      // astronomically unlikely, but just get a fresh room id
      window.startPeerJS()
    }
  })

  thisPeer.on('disconnected', () => {
    setTimeout(() => {
      if (thisPeer.destroyed || peer !== thisPeer) return
      try {
        thisPeer.reconnect()
      } catch (err) {
        console.error(err)
      }
      sendNotification(
        'Connection to signaling server lost, reconnecting....',
        '#ff6b6b',
        '#000000',
        '#000000',
        '#ff6b6b',
        1500
      )
    }, 2000)
  })

  // we never accept media calls
  thisPeer.on('call', (call) => {
    try {
      call.close()
    } catch (err) {
      console.error(err)
    }
  })

  thisPeer.on('connection', (conn) => {
    if (typeof conn?.on !== 'function' || conn.serialization !== 'json') {
      try {
        conn?.close?.()
      } catch {
        // ignore
      }
      return
    }

    const alreadyConnected = (thisPeer.connections[conn.peer] ?? []).some(
      (c) => c !== conn && c.open
    )
    // (the new connection is already in peer.connections, hence `>`)
    if (alreadyConnected || connectionCount() > MAX_CONNECTIONS || !takeJoinToken()) {
      console.warn(`Rejected connection from ${conn.peer}`)
      conn.close()
      return
    }

    console.log(`Client connected: ${conn.peer}`)

    let introduced = false
    let msgWindowStart = Date.now()
    let msgCount = 0
    const introTimer = setTimeout(() => {
      if (!introduced) {
        console.warn(`Removed ${conn.peer}: no introduction`)
        conn.close()
      }
    }, INTRO_TIMEOUT_MS)

    conn.on('open', () => {
      console.log(`Connection opened: ${conn.peer}`)
    })

    conn.on('error', (err) => {
      console.error(err)
    })

    conn.on('data', (data) => {
      const now = Date.now()
      if (now - msgWindowStart >= 1000) {
        msgWindowStart = now
        msgCount = 0
      }
      if (++msgCount > MSG_RATE_LIMIT) {
        console.error(`Removed ${conn.peer} for flooding`)
        conn.close()
        return
      }
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return

      try {
        if (data.type === 'client-introduction') {
          if (introduced) return // one introduction per connection
          if (internalPointers[conn.peer]) {
            // one connection per guest (two racing connections from the same
            // peer would otherwise share, and then delete, one pointer)
            conn.close()
            return
          }
          if (Object.keys(internalPointers).length >= MAX_PLAYERS) {
            sendNotification('Room is full', '#ff6b6b', '#000000', '#000000', '#ff6b6b', 4000)
            conn.close()
            return
          }
          introduced = true
          clearTimeout(introTimer)
          const color = data.content?.color
          internalPointers[conn.peer] = {
            peerId: conn.peer,
            number: newPointerNumber(internalPointers),
            name: sanitizeName(data.content?.name) || 'Unknown',
            color: HEX_COLOR.test(color) ? color : '#000000',
            x: Math.round(Math.random() * overlayDimensions?.width),
            y: Math.round(Math.random() * overlayDimensions?.height),
            orgX: 0,
            orgY: 0,
            rotation: 0,
            mousedown: false,
            active: false,
            draft: null, // { text, rev, seq, holdMs, step } while the guest is typing
            draftTimer: null,
            typing: createTypingState()
          }
          pointerConns.set(conn.peer, conn)
          publishPointers({ list: true })
          conn.send({
            type: 'host-introduction',
            content: { name: hostName.value, typing: TYPING }
          })
          const {
            color: pointerColor,
            name: pointerName,
            number: pointerNumber
          } = internalPointers[conn.peer]
          sendNotification(
            `${pointerName} joined as player ${pointerNumber}`,
            pointerColor,
            pointerColor,
            pointerColor,
            '#FFFFFF',
            4000,
            maskFor(pointerName)
          )
        } else if (data.type === 'client-mousemove') {
          const localPointer = internalPointers[conn.peer]
          const dx = data.content?.x
          const dy = data.content?.y
          if (!localPointer || !Number.isFinite(dx) || !Number.isFinite(dy)) return
          if (Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) return
          const localX = Math.max(Math.min(localPointer.x + dx, overlayDimensions?.width ?? 0), 0)
          const localY = Math.max(Math.min(localPointer.y + dy, overlayDimensions?.height ?? 0), 0)
          const localMousedown = data.content.mousedown === true
          if (localMousedown && !localPointer.mousedown) {
            localPointer.orgX = localPointer.x
            localPointer.orgY = localPointer.y
          }
          localPointer.x = localX
          localPointer.y = localY
          if (localMousedown) {
            const deltaX = localPointer.x - localPointer.orgX
            const deltaY = localPointer.y - localPointer.orgY
            if (deltaX ** 2 + deltaY ** 2 >= 100) {
              const targetDeg = Math.atan2(deltaX, deltaY) * (-180 / Math.PI)
              localPointer.rotation = shortestRotation(localPointer.rotation, targetDeg)
            }
          }
          if (!localMousedown && localPointer.mousedown) {
            localPointer.rotation = shortestRotation(localPointer.rotation, 0)
          }
          localPointer.mousedown = localMousedown
          localPointer.active = data.content.active === true
          publishPointers()
        } else if (data.type === 'client-text' || data.type === 'client-pin') {
          // content: { text: <the guest's whole draft>, seq }; see acceptTypingMessage
          const localPointer = internalPointers[conn.peer]
          if (!localPointer) return
          const action = acceptTypingMessage(localPointer.typing, data.type, data.content?.seq)
          if (!action) return
          const text = sanitizeTypedText(data.content?.text)
          if (action.draft) {
            if (setDraft(localPointer, text)) publishPointers()
          } else {
            pinNote(localPointer, text, action.clearDraft)
          }
        } else if (data.type === 'ping') {
          conn.send({
            type: 'pong'
          })
        }
      } catch (e) {
        console.error(e)
        console.error(`Removed ${conn?.peer} for sending invalid data`)
        conn?.close()
      }
    })

    conn.on('close', () => {
      clearTimeout(introTimer)
      if (!introduced || peer !== thisPeer || pointerConns.get(conn.peer) !== conn) return
      pointerConns.delete(conn.peer)
      const pointerColor = internalPointers[conn.peer]?.color || '#000000'
      const pointerName = internalPointers[conn.peer]?.name || 'Unknown'
      if (conn.peer in internalPointers) {
        clearTimeout(internalPointers[conn.peer].draftTimer)
        delete internalPointers[conn.peer]
      }
      sendNotification(
        `${pointerName} left`,
        pointerColor,
        pointerColor,
        pointerColor,
        '#FFFFFF',
        4000,
        maskFor(pointerName)
      )
      // (their pinned notes stay until they expire; kicking removes them)
      publishPointers({ list: true })
    })
  })
}

// ---- typing: drafts and pinned notes

/** ranges of `text` to hide, if the host has the filter on */
function maskFor(text) {
  return censorEnabled.value ? findBadWordRanges(text) : []
}

/** Updates a guest's draft; returns whether anything visible changed. */
function setDraft(pointer, text) {
  if (!text.trim()) {
    clearTimeout(pointer.draftTimer)
    const had = pointer.draft !== null
    pointer.draft = null
    return had
  }
  if (pointer.draft?.text === text) return false
  clearTimeout(pointer.draftTimer)
  const holdMs = draftHoldMs(text)
  pointer.draft = {
    text,
    rev: (pointer.draft?.rev ?? 0) + 1,
    seq: pointer.typing.textSeq,
    holdMs,
    step: fontStep(text, pointer.draft?.step)
  }
  pointer.draftTimer = setTimeout(() => expireDraft(pointer), holdMs + TYPING.fadeMs)
  return true
}

/** The overlay has faded the draft out: drop it and tell the guest to clear theirs. */
function expireDraft(pointer) {
  const seq = pointer.draft?.seq
  pointer.draft = null
  publishPointers()
  try {
    pointerConns.get(pointer.peerId)?.send({ type: 'host-draft-expired', content: { seq } })
  } catch (err) {
    console.error(err)
  }
}

function noteExpiry(createdAt) {
  return noteLifetime.value > 0 ? createdAt + noteLifetime.value * 1000 : null
}

function scheduleNoteExpiry(note) {
  clearTimeout(note.timer)
  note.timer =
    note.expiresAt === null
      ? null
      : setTimeout(() => removeNotes((n) => n === note), Math.max(0, note.expiresAt - Date.now()))
}

function removeNotes(predicate) {
  const kept = notes.filter((note) => !predicate(note))
  if (kept.length === notes.length) return
  for (const note of notes) if (!kept.includes(note)) clearTimeout(note.timer)
  notes = kept
  publishNotes()
}

/** Pins `text` where the guest's pointer is (replacing their draft, unless a newer one is showing). */
function pinNote(pointer, text, clearDraft = true) {
  const step = pointer.draft?.step ?? fontStep(text)
  if (clearDraft) setDraft(pointer, '')
  text = text.trim()
  if (text) {
    const createdAt = Date.now()
    const note = {
      id: ++lastNoteId,
      peerId: pointer.peerId,
      number: pointer.number,
      color: pointer.color,
      x: pointer.x,
      y: pointer.y,
      text,
      step,
      createdAt,
      expiresAt: noteExpiry(createdAt),
      timer: null
    }
    notes.push(note)
    scheduleNoteExpiry(note)
    // too many notes: the oldest go first
    const theirs = notes.filter((n) => n.peerId === pointer.peerId)
    const dropped = new Set(theirs.slice(0, Math.max(0, theirs.length - MAX_NOTES_PER_PLAYER)))
    const rest = notes.filter((n) => !dropped.has(n))
    for (const n of rest.slice(0, Math.max(0, rest.length - MAX_NOTES))) dropped.add(n)
    if (dropped.size) removeNotes((n) => dropped.has(n))
    else publishNotes()
  }
  publishPointers()
}

function publishNotes() {
  noteCount.value = notes.length
  window.api.send(
    'update-notes',
    notes.map((note) => ({
      id: note.id,
      number: note.number,
      color: note.color,
      x: note.x,
      y: note.y,
      text: note.text,
      mask: maskFor(note.text),
      step: note.step,
      createdAt: note.createdAt,
      expiresAt: note.expiresAt
    }))
  )
}

/**
 * Sends every pointer (with its draft) to the overlay. `list` also refreshes
 * the player list in this window, which only shows names, so mouse movement
 * doesn't need to re-render it.
 */
function publishPointers({ list = false } = {}) {
  const views = Object.values(internalPointers).map((p) => ({
    peerId: p.peerId,
    number: p.number,
    name: p.name,
    nameMask: maskFor(p.name),
    color: p.color,
    x: p.x,
    y: p.y,
    rotation: p.rotation,
    mousedown: p.mousedown,
    active: p.active,
    draft: p.draft
      ? {
          text: p.draft.text,
          mask: maskFor(p.draft.text),
          rev: p.draft.rev,
          holdMs: p.draft.holdMs,
          step: p.draft.step
        }
      : null
  }))
  if (list) pointers.value = views
  window.api.send('update-pointers', views)
}

function sendNotification(
  content,
  borderColor,
  textColor,
  shadowColor,
  backgroundColor,
  timeout,
  mask = []
) {
  window.api.send('toast-notification', {
    content: content,
    mask: mask,
    colors: {
      border: borderColor,
      text: textColor,
      shadow: shadowColor,
      background: backgroundColor
    },
    timeout: timeout
  })
}

function shortestRotation(current, target) {
  return current + ((((target - current) % 360) + 540) % 360) - 180
}

function newPointerNumber(intrPoints) {
  const usedNums = Object.values(intrPoints).map((p) => p?.number)
  var i = 1
  while (usedNums.includes(i)) {
    i++
  }
  return i
}
