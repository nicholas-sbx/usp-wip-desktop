import './assets/primary.css'

import { createApp, ref } from 'vue'
import PrimaryApp from './PrimaryApp.vue'
import { Peer } from 'peerjs'
import { useStorage } from '@vueuse/core'

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
 * (a remote peer can exhaust our memory), and the serializer lookup table is a
 * plain object, so `serialization: "constructor"` yields a bogus connection
 * that later makes peer.destroy() throw. Only JSON is accepted: each JSON
 * message is a single, size-capped data channel message.
 */
class JsonOnlyPeer extends Peer {
  constructor(...args) {
    super(...args)
    this._serializers = Object.assign(Object.create(null), { json: this._serializers.json })
  }
}

const hostName = useStorage('host-name', '')
const joinURL = ref('')
const pointers = ref([])
const whichScreen = ref('start')

const app = createApp(PrimaryApp)
app.provide('hostName', hostName)
app.provide('joinURL', joinURL)
app.provide('pointers', pointers)
app.provide('whichScreen', whichScreen)
app.mount('#app')

var peer
var internalPointers = {}
var overlayDimensions = { width: 0, height: 0 }
var joinTokens = JOIN_BURST
var joinRefillTimer = null

window.api.receive('overlay-dimensions', (ovd) => {
  overlayDimensions = ovd
})
window.api.send('primary-ready')

sendIntPtUpdate(Object.values(internalPointers))

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

  if (peerId in internalPointers) {
    delete internalPointers[peerId]
    pointers.value = Object.values(internalPointers)
    sendIntPtUpdate(Object.values(internalPointers))
  }
}

function destroyPeer() {
  if (!peer) return
  try {
    peer.destroy()
  } catch (err) {
    console.error(err)
  }
  peer = null
  internalPointers = {}
  pointers.value = []
  sendIntPtUpdate([])
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
            active: false
          }
          pointers.value = Object.values(internalPointers)
          sendIntPtUpdate(Object.values(internalPointers))
          conn.send({
            type: 'host-introduction',
            content: { name: hostName.value }
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
            4000
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
          sendIntPtUpdate(Object.values(internalPointers))
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
      if (!introduced || peer !== thisPeer) return
      const pointerColor = internalPointers[conn.peer]?.color || '#000000'
      const pointerName = internalPointers[conn.peer]?.name || 'Unknown'
      if (conn.peer in internalPointers) {
        delete internalPointers[conn.peer]
      }
      sendNotification(
        `${pointerName} left`,
        pointerColor,
        pointerColor,
        pointerColor,
        '#FFFFFF',
        4000
      )
      pointers.value = Object.values(internalPointers)
      sendIntPtUpdate(Object.values(internalPointers))
    })
  })
}

function sendIntPtUpdate(ipValues) {
  window.api.send('update-pointers', ipValues)
}

function sendNotification(content, borderColor, textColor, shadowColor, backgroundColor, timeout) {
  window.api.send('toast-notification', {
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
