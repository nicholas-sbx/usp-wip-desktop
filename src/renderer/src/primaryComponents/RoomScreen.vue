<script setup>
import { inject, computed } from 'vue'
import Player from './Player.vue'
import { NOTE_LIFETIMES } from '../typing'

const hostName = inject('hostName')
const pointers = inject('pointers')
const censorEnabled = inject('censorEnabled')
const noteLifetime = inject('noteLifetime')
const noteCount = inject('noteCount')
// const joinURL = inject('joinURL')

// inlined from @wardrakus/possessive@0.0.1 (MIT) to drop a single-maintainer dependency
function possessive(str) {
  if (!str) return str
  return str.slice(-1).toLowerCase() === 's' ? `${str}’` : `${str}’s`
}

const sortedPointers = computed(() => [...pointers.value].sort((a, b) => a.number - b.number))

function destroy() {
  window.destroyPeerJS()
}

function copyLink() {
  window.copyJoinLink()
}

function clearNotes() {
  window.clearNotes()
}
</script>

<template>
  <div class="roomScreen">
    <h1 class="roomString">{{ possessive(hostName) }} room</h1>
    <button class="copyButon" @click="copyLink()">Click to copy link again</button>
    <div class="roomSettings">
      <label title="Blacks out bad words in guest names and typed text">
        <input v-model="censorEnabled" type="checkbox" />
        Hide bad words
      </label>
      <label title="How long pinned notes stay on screen">
        Notes stay
        <select v-model.number="noteLifetime">
          <option v-for="option in NOTE_LIFETIMES" :key="option.seconds" :value="option.seconds">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button class="clearNotesButton" :disabled="!noteCount" @click="clearNotes()">
        Clear notes{{ noteCount ? ` (${noteCount})` : '' }}
      </button>
    </div>
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
  margin: 14px 14px 8px;
}

.roomSettings {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 4px 12px;
  padding: 0 10px 8px;
  font-size: 13px;
}

.roomSettings label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.roomSettings select,
.clearNotesButton {
  font-size: 12px;
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
