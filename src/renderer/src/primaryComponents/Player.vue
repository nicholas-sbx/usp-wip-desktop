<script setup>
import MaskedText from '../components/MaskedText.vue'

defineProps({
  pointer: Object
})

function kick(peerId) {
  window.kickPeer(peerId)
}
</script>

<template>
  <div class="player">
    <div class="playerNumber">{{ pointer.number }}</div>
    <div class="playerName">
      <MaskedText :text="pointer.name" :mask="pointer.nameMask" mask-color="rgba(0, 0, 0, 0.8)" />
    </div>
    <button class="playerKickButton" @click="kick(pointer.peerId)">Kick</button>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  gap: 10px;
}

.player > * {
  font-weight: bold;
  border-radius: 6px;
  padding: 2px 10px;
}

.playerNumber {
  box-shadow:
    0 0 5px 0px rgba(0, 0, 0, 0.2),
    inset 0 0 5px 0px rgba(0, 0, 0, 0.2);
  text-shadow: 0 0 5px rgba(0, 0, 0, 0.2);
  color: v-bind('pointer.color');
  border: 2px solid v-bind('pointer.color');
  font-size: 20px;
}

.playerName {
  color: rgba(0, 0, 0, 0.8);
  border: 2px solid rgba(0, 0, 0, 0.6);
  font-size: v-bind('pointer?.name?.length > 10 ? "14px" : "20px"');
  line-height: 22px;
  flex-grow: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.playerKickButton:hover {
  background-color: rgb(253, 89, 89);
}
</style>
