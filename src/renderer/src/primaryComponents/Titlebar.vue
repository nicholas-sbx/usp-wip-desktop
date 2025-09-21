<script setup>
import TitlebarButton from './TitlebarButton.vue'

function moveOverlay() {
  window.api.send('titlebar-move-overlay')
}

function setMoveHovering(hov) {
  window.api.send('titlebar-move-overlay-hint', hov)
}

function minimize() {
  window.api.send('titlebar-minimize')
}

function close() {
  window.destroyPeerJS()
  window.api.send('titlebar-close')
}
</script>

<template>
  <div class="titlebar">
    <TitlebarButton
      style="color: #000000cc"
      @click="moveOverlay"
      @mouseenter="setMoveHovering(true)"
      @mousemove="setMoveHovering(true)"
      @mouseleave="setMoveHovering(false)"
    >
      Move overlay
    </TitlebarButton>
    <div class="spacer"></div>
    <TitlebarButton style="font-weight: bold" @click="minimize">—</TitlebarButton>
    <TitlebarButton style="font-weight: bold" @click="close">X</TitlebarButton>
  </div>
</template>

<style scoped>
.titlebar {
  -webkit-app-region: drag;
  user-select: none;
  display: flex;
  flex-grow: 0;
}

.spacer {
  flex-grow: 1;
}
</style>
