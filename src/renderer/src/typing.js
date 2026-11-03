// Guest typing: shared limits and text cleanup.
//
// A guest's keystrokes in the picture-in-picture controller show up as a
// "draft" next to their pointer. It stays fully visible while they type, starts
// fading `idleMs` after the last change and is gone `fadeMs` later. Clicking
// pins the draft where it is as a smaller note that lasts `noteLifetime`.
// The guest page gets these numbers in host-introduction, so it clears its own
// draft at the same moment the overlay finishes fading it.

export const TYPING = Object.freeze({
  idleMs: 2500,
  fadeMs: 1500,
  maxLength: 200, // UTF-16 code units
  maxLines: 5
})

export const NOTE_LIFETIMES = Object.freeze([
  { seconds: 15, label: '15 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 0, label: 'until cleared' }
])
export const DEFAULT_NOTE_LIFETIME = 60

export const MAX_NOTES_PER_PLAYER = 8
export const MAX_NOTES = 64

const INVISIBLE = /[\p{Cc}\p{Cf}]/gu // control, bidi overrides, zero-width chars
const MARK_PILES = /(\p{M}{3})\p{M}+/gu // "zalgo" stacks of combining marks

/**
 * Cleans text typed by a guest. Strips control and format characters (a
 * right-to-left override could otherwise make "kcuf" *display* as a word the
 * filter never saw, and zero-width characters could split words), keeps
 * newlines, caps stacked accents, lines and length.
 */
export function sanitizeTypedText(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw
    .slice(0, TYPING.maxLength * 4)
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, (c) => (c === '\n' ? c : ''))
    .replace(MARK_PILES, '$1')
  text = text.split('\n').slice(0, TYPING.maxLines).join('\n')
  if (text.length > TYPING.maxLength) {
    text = text.slice(0, TYPING.maxLength)
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1) // don't split an emoji
  }
  return text
}
