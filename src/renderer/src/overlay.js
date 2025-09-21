import './assets/overlay.css'

import { createApp, ref } from 'vue'
import OverlayApp from './OverlayApp.vue'

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
  notifications.value.unshift(notification)
  setTimeout(() => {
    // not exactly efficient but shhh
    const index = notifications.value.indexOf(notification)
    if (index > -1) {
      notifications.value.splice(index, 1)
    }
  }, notification.timeout)
})

window.api.send('overlay-ready')
window.api.send('overlay-dimensions', {
  width: window.innerWidth,
  height: window.innerHeight
})

const app = createApp(OverlayApp)
app.provide('pointers', pointers)
app.provide('notifications', notifications)
app.provide('showLocator', showLocator)
app.mount('#app')
