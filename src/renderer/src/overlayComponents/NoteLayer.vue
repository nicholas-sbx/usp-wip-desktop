<script setup>
// Drafts a guest pinned by clicking. They shrink into place, stay for the
// host's chosen lifetime, then fade out.
import { inject } from 'vue'
import MaskedText from '../components/MaskedText.vue'
import { FONT_STEPS } from '../typing'
import { bubblePlacement } from './bubblePlacement'

const NOTE_FADE_MS = 1000
const PIN_ANIMATION_WINDOW_MS = 500

const notes = inject('notes')
const viewport = inject('viewport')

function noteStyle(note) {
  const size = FONT_STEPS[note.step] ?? FONT_STEPS[0]
  const now = Date.now()
  const animations = []
  // only animate the "shrink into a note" for a note that was just pinned,
  // not when the overlay is recreated or the host changes the lifetime
  if (now - note.createdAt < PIN_ANIMATION_WINDOW_MS) animations.push('note-pin 180ms ease-out')
  if (note.expiresAt !== null) {
    const delay = Math.max(0, note.expiresAt - now - NOTE_FADE_MS)
    animations.push(`note-fade ${NOTE_FADE_MS}ms linear ${delay}ms forwards`)
  }
  return {
    '--bubble-color': note.color,
    // the pin animation starts at exactly the size the draft had
    '--pin-from': size.draftPx / size.notePx,
    fontSize: `${size.notePx}px`,
    animation: animations.join(', ') || 'none'
  }
}
</script>

<template>
  <div class="noteLayer">
    <div
      v-for="note in notes"
      :key="`${note.id}:${note.expiresAt}`"
      class="notePositioner"
      :style="bubblePlacement(note.x, note.y, viewport)"
    >
      <div class="bubble note" :style="noteStyle(note)">
        <MaskedText :text="note.text" :mask="note.mask" mask-color="#1d1d1d" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.noteLayer {
  z-index: var(--note-z-index);
  position: fixed;
  inset: 0;
}

.notePositioner {
  position: absolute;
  top: 0;
  left: 0;
}

.note {
  transform-origin: inherit;
}
</style>

<style>
@keyframes note-pin {
  from {
    transform: scale(var(--pin-from, 1.45));
  }
  to {
    transform: scale(1);
  }
}

@keyframes note-fade {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
</style>
