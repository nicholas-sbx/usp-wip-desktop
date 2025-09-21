<script setup>
import { inject } from 'vue'

const hostName = inject('hostName')

function start() {
  window.startPeerJS()
}
</script>

<template>
  <div class="startScreen">
    <div class="startScreenContent">
      <h1>Start new room as:</h1>
      <input
        v-model.trim="hostName"
        class="nameInput"
        type="text"
        placeholder="Name"
        maxlength="15"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="startButton" :disabled="!hostName?.length" @click="start()">Start</button>
    </div>
  </div>
</template>

<style scoped>
.startScreen {
  height: 100%;
  width: 100%;
  display: grid;
  align-items: center;
  text-align: center;
}

.nameInput {
  font-size: x-large;
  border-radius: 10px;
  padding: 5px 20px 5px 20px;
  text-align: center;
  width: 220px;
}

.nameInput:focus {
  border-color: black;
  outline-color: black;
}

.startButton {
  padding: 10px 30px 10px 30px;
  border-radius: 9999px;
  font-size: x-large;
  margin: 20px;
}
</style>
