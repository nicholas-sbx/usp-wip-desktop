<script setup>
import { inject } from 'vue'
import PointerPositioner from './PointerPositioner.vue'
const pointers = inject('pointers')
</script>

<template>
  <div class="pointerLayer">
    <!-- currently, we aren't intentionally controlling the pointer stacking order -->
    <PointerPositioner v-for="pointer in pointers" :key="pointer.number" :pointer="pointer" />
  </div>
</template>

<style scoped>
.pointerLayer {
  z-index: var(--pointer-z-index);
  position: fixed;
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
}
</style>
