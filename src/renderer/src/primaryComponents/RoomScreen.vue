<script setup>
import { inject, computed } from 'vue'
import possessive from '@wardrakus/possessive'
import Player from './Player.vue'

const hostName = inject('hostName')
const pointers = inject('pointers')
// const joinURL = inject('joinURL')

const sortedPointers = computed(() => [...pointers.value].sort((a, b) => a.number - b.number))

function destroy() {
  window.destroyPeerJS()
}

function copyLink() {
  window.copyJoinLink()
}
</script>

<template>
  <div class="roomScreen">
    <h1 class="roomString">{{ possessive(hostName) }} room</h1>
    <button class="copyButon" @click="copyLink()">Click to copy link again</button>
    <div class="playerListWrap">
      <div v-if="pointers?.length" class="playerList">
        <Player v-for="pointer in sortedPointers" :key="pointer.number" :pointer="pointer" />
      </div>
      <div v-else class="noPlayers">No one is here yet :(</div>
    </div>
    <button class="destroyButton" :disabled="!hostName?.length" @click="destroy()">
      Close Room
    </button>
  </div>
</template>

<style scoped>
.roomScreen {
  height: 100%;
  overflow: hidden;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.roomString {
  margin: 0;
  margin-top: 14px;
}

.copyButon {
  margin: 14px;
}

.copyButon:hover {
  background-color: #70e976;
}

.playerListWrap {
  height: 100%;
  width: 100%;
  overflow: hidden;
  box-shadow:
    inset 0px 11px 8px -10px #ccc,
    inset 0px -11px 8px -10px #ccc;
}

.playerList {
  padding: 20px;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.noPlayers {
  width: 100%;
  height: 100%;
  display: grid;
  align-items: center;
  color: #00000055;
}

.destroyButton {
  padding: 6px 18px 6px 18px;
  border-radius: 9999px;
  font-size: large;
  margin: 14px;
}
</style>
