<script setup>
import { inject } from 'vue'
const showLocator = inject('showLocator')
</script>

<template>
  <div v-if="showLocator" class="monitorLocator">
    <div class="hbar1"></div>
    <div class="hbar2"></div>
    <div class="vbar1"></div>
    <div class="vbar2"></div>
  </div>
</template>

<style scoped>
.monitorLocator {
  z-index: var(--monitor-locator-z-index);
  position: fixed;
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
  opacity: 0.6;
}

.monitorLocator > div {
  position: absolute;
  background-color: rgba(0, 255, 255);
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
  /* animation: fade 5s ease-in-out infinite alternate; */
}

@property --monitor-locator-dist-animation {
  syntax: '<length>';
  inherits: false;
  initial-value: 70px;
}

@keyframes fade {
  from {
    opacity: 0.8;
    --monitor-locator-dist-animation: 70px;
  }

  to {
    opacity: 0.3;
    --monitor-locator-dist-animation: 120px;
  }
}

.hbar1 {
  top: 0;
  bottom: 0;
  left: 0;
  transform: translateX(var(--monitor-locator-dist-animation));
  width: 3px;
}

.hbar2 {
  top: 0;
  bottom: 0;
  right: 0;
  transform: translateX(calc(-1 * var(--monitor-locator-dist-animation)));
  width: 3px;
}

.vbar1 {
  left: 0;
  right: 0;
  top: 0;
  transform: translateY(var(--monitor-locator-dist-animation));
  height: 3px;
}

.vbar2 {
  left: 0;
  right: 0;
  bottom: 0;
  transform: translateY(calc(-1 * var(--monitor-locator-dist-animation)));
  height: 3px;
}
</style>
