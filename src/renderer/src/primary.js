import './assets/primary.css'

import { createApp, ref } from 'vue'
import PrimaryApp from './PrimaryApp.vue'
import { Peer } from 'peerjs'
import { useStorage } from '@vueuse/core'

const USPWIP_WEB_BASE_URL = 'http://localhost:5500/public'

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

  const conn = peer.connections[peerId]?.[0]
  if (conn) {
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
  }
}

window.destroyPeerJS = function () {
  whichScreen.value = 'start'
  peer?.destroy()
}

window.startPeerJS = function () {
  whichScreen.value = 'room'
  peer?.destroy()
  const wmID = crypto.randomUUID().split('-')[0]
  peer = new Peer(`uspwip-fun-super-unique-id-${wmID}`)
  joinURL.value = `${USPWIP_WEB_BASE_URL}/join#${wmID}`
  window.copyJoinLink()

  peer.on('disconnected', () => {
    setTimeout(() => {
      if (peer.destroyed) return
      peer.reconnect() // this *will* throw errors if the room start/close buttons are spammed but that's fine
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

  peer.on('connection', (conn) => {
    console.log(`Client connected: ${conn.peer}`)

    conn.on('open', () => {
      console.log(`Connection opened: ${conn.peer}`)
    })

    conn.on('data', (data) => {
      try {
        if (data?.type === 'client-introduction') {
          if (!(conn.peer in internalPointers)) {
            internalPointers[conn.peer] = {
              peerId: conn.peer,
              number: newPointerNumber(internalPointers),
              name: data?.content?.name?.toString()?.substring(0, 15)?.trim(),
              color: data?.content?.color?.toString(),
              x: Math.round(Math.random() * overlayDimensions?.width),
              y: Math.round(Math.random() * overlayDimensions?.height),
              orgX: 0,
              orgY: 0,
              rotation: 0,
              mousedown: false
            }
          }
          pointers.value = Object.values(internalPointers)
          sendIntPtUpdate(Object.values(internalPointers))
          conn.send({
            type: 'host-introduction',
            content: { name: hostName.value }
          })
          const pointerColor = internalPointers[conn.peer]?.color || '#000000'
          const pointerName = internalPointers[conn.peer]?.name || 'Unknown'
          const pointerNumber = internalPointers[conn.peer]?.number ?? '??'
          sendNotification(
            `${pointerName} joined as player ${pointerNumber}`,
            pointerColor,
            pointerColor,
            pointerColor,
            '#FFFFFF',
            4000
          )
        } else if (data?.type === 'client-mousemove') {
          if (conn.peer in internalPointers) {
            const localPointer = internalPointers[conn.peer]
            const localX = Math.max(
              Math.min(localPointer.x + data.content.x, overlayDimensions?.width ?? 0),
              0
            )
            const localY = Math.max(
              Math.min(localPointer.y + data.content.y, overlayDimensions?.height ?? 0),
              0
            )
            const localMousedown = data.content.mousedown
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
            localPointer.active = data.content.active
            sendIntPtUpdate(Object.values(internalPointers))
          }
        } else if (data?.type === 'ping') {
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
