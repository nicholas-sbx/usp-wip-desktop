<script setup>
import Titlebar from './primaryComponents/Titlebar.vue'
import StartScreen from './primaryComponents/StartScreen.vue'
import RoomScreen from './primaryComponents/RoomScreen.vue'
import { inject } from 'vue'

const whichScreen = inject('whichScreen')
</script>

<template>
  <div class="flex">
    <Titlebar />
    <div class="divider"></div>
    <StartScreen v-if="whichScreen === 'start'" />
    <RoomScreen v-if="whichScreen === 'room'" />
  </div>
</template>

<style scoped>
.flex {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.divider {
  width: 100%;
  height: 2px;
  background: #333333;
  flex-shrink: 0;
}
</style>
