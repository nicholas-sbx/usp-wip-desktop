<script setup>
// What guests are typing right now, following their pointers. A draft is
// fully visible while it changes and fades out once they stop typing.
import { computed, inject } from 'vue'
import MaskedText from '../components/MaskedText.vue'
import { TYPING } from '../typing'
import { bubblePlacement } from './bubblePlacement'

const pointers = inject('pointers')
const viewport = inject('viewport')

const typing = computed(() => (pointers.value ?? []).filter((p) => p.draft?.text))
const fade = {
  animationDuration: `${TYPING.fadeMs}ms`,
  animationDelay: `${TYPING.idleMs}ms`
}
</script>

<template>
  <div class="draftLayer">
    <div
      v-for="pointer in typing"
      :key="pointer.peerId"
      class="draftPositioner"
      :style="bubblePlacement(pointer.x, pointer.y, viewport)"
    >
      <!-- keyed by revision: every change restarts the fade timer -->
      <div
        :key="pointer.draft.rev"
        class="bubble draft"
        :style="{ ...fade, '--bubble-color': pointer.color }"
      >
        <MaskedText :text="pointer.draft.text" :mask="pointer.draft.mask" mask-color="#1d1d1d" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.draftLayer {
  z-index: var(--draft-z-index);
  position: fixed;
  inset: 0;
}

.draftPositioner {
  position: absolute;
  top: 0;
  left: 0;
  /* same easing as the pointer so the text stays glued to it */
  transition: transform 100ms ease-out;
}

.draft {
  animation-name: draft-fade;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes draft-fade {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
</style>
