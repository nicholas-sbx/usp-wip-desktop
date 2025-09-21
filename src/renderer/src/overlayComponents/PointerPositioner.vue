<script setup>
import { computed } from 'vue'
import Pointer from './Pointer.vue'
const props = defineProps({
  pointer: Object
})

const state = computed(() => {
  if (!props.pointer.active) {
    return 'inactive'
  } else if (props.pointer.mousedown) {
    return 'clicking'
  } else {
    return 'normal'
  }
})
</script>

<template>
  <div class="pointerPositioner">
    <div>
      <Pointer :pointer="pointer" :state="state" />
    </div>
  </div>
</template>

<style scoped>
.pointerPositioner {
  position: absolute;
  transform: v-bind(
    '`translate(${Math.round(pointer.x)}px, ${Math.round(pointer.y)}px) rotate(${Math.round(pointer.rotation)}deg)`'
  );
  transition: transform 100ms ease-out;
  width: 0;
  height: 0;
  display: grid;
  place-items: center;
}

.pointerPositioner > div {
  /* don't ask me why grid + absoute works but it does*/
  position: absolute;
}
</style>
