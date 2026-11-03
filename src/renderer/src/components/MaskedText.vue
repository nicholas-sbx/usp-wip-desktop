<script setup>
// Renders `text` with the `mask` ranges blacked out: a block exactly the size
// of the hidden characters, filled with `maskColor`.
//
// The hidden characters stay in the text and keep their exact width, so the
// text never changes shape while a word is typed, masked and unmasked. With
// the CSS Custom Highlight API (Chromium) the text is one untouched text node
// and the block is painted over the range; the fallback wraps the range in a
// span with transparent glyphs.
import { computed, onBeforeUnmount, ref, watchPostEffect } from 'vue'
import { setMaskRanges, supportsHighlights } from './maskHighlights'

const props = defineProps({
  text: { type: String, default: '' },
  mask: { type: Array, default: () => [] },
  // must be an actual color: inside the block the text itself is transparent
  maskColor: { type: String, default: '#000000' }
})

const ranges = computed(() => {
  const length = (props.text ?? '').length
  return (props.mask ?? [])
    .filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]))
    .map(([s, e]) => [Math.max(0, s), Math.min(length, e)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
})

const root = ref(null)
const owner = {}
if (supportsHighlights) {
  // runs after the DOM update and before the browser paints, so new text is
  // never shown unmasked
  watchPostEffect(() => {
    void props.text // re-apply when the text node's contents change
    setMaskRanges(owner, root.value?.firstChild, ranges.value, props.maskColor)
  })
  onBeforeUnmount(() => setMaskRanges(owner, null))
}

const segments = computed(() => {
  const text = props.text ?? ''
  const out = []
  let pos = 0
  for (const [start, end] of ranges.value) {
    const s = Math.max(start, pos)
    if (end <= s) continue
    if (s > pos) out.push({ text: text.slice(pos, s), masked: false })
    out.push({ text: text.slice(s, end), masked: true })
    pos = end
  }
  if (pos < text.length) out.push({ text: text.slice(pos), masked: false })
  return out
})
</script>

<template>
  <span v-if="supportsHighlights" ref="root" class="maskedText">{{ text }}</span>
  <span v-else class="maskedText"
    ><template v-for="(seg, i) in segments" :key="i"
      ><span v-if="seg.masked" class="masked" aria-hidden="true">{{ seg.text }}</span
      ><template v-else>{{ seg.text }}</template></template
    ></span
  >
</template>

<style scoped>
.masked {
  color: transparent;
  -webkit-text-fill-color: transparent;
  text-shadow: none;
  text-decoration: none;
  background-color: v-bind('props.maskColor');
}
</style>
