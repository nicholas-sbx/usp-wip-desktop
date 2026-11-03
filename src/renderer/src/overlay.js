import './assets/overlay.css'

import { createApp, ref } from 'vue'
import OverlayApp from './OverlayApp.vue'

const MAX_NOTIFICATIONS = 6

// On native Wayland the overlay is rendered offscreen at the monitor's physical
// resolution; zoom keeps 1 CSS px == 1 logical px so it looks identical on
// every monitor regardless of (fractional) scale.
const zoom = (() => {
  const z = Number(new URLSearchParams(window.location.search).get('zoom'))
  return Number.isFinite(z) && z >= 0.25 && z <= 8 ? z : 1
})()
if (zoom !== 1) document.documentElement.style.zoom = String(zoom)

const pointers = ref([])
const notifications = ref([])
const showLocator = ref(false)

window.api.receive('update-pointers', (newPointers) => {
  pointers.value = newPointers
})

window.api.receive('show-monitor-locator', (show) => {
  showLocator.value = show
})

window.api.receive('toast-notification', (notification) => {
  if (!notification) return
  notifications.value.unshift(notification)
  // don't let a flood of joins/leaves pile up on screen
  notifications.value.splice(MAX_NOTIFICATIONS)
  setTimeout(() => {
    // not exactly efficient but shhh
    const index = notifications.value.findIndex((n) => n.id === notification.id)
    if (index > -1) {
      notifications.value.splice(index, 1)
    }
  }, notification.timeout)
})

window.api.send('overlay-ready')
window.api.send('overlay-dimensions', {
  width: Math.round(window.innerWidth / zoom),
  height: Math.round(window.innerHeight / zoom)
})

const app = createApp(OverlayApp)
app.provide('pointers', pointers)
app.provide('notifications', notifications)
app.provide('showLocator', showLocator)
app.mount('#app')
