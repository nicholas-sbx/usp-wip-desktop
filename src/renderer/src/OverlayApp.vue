<script setup>
import DraftLayer from './overlayComponents/DraftLayer.vue'
import MonitorLocator from './overlayComponents/MonitorLocator.vue'
import NoteLayer from './overlayComponents/NoteLayer.vue'
import NotificationLayer from './overlayComponents/NotificationLayer.vue'
import PointerLayer from './overlayComponents/PointerLayer.vue'
</script>

<template>
  <NoteLayer />
  <PointerLayer />
  <DraftLayer />
  <MonitorLocator />
  <NotificationLayer />
</template>

<style scoped></style>
