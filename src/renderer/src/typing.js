// Guest typing: shared limits, timing and text cleanup.
//
// A guest's keystrokes in the picture-in-picture controller show up as a
// "draft" next to their pointer. It stays fully visible while they type and
// for draftHoldMs() after the last change, then fades out over `fadeMs`.
// When it is gone the host tells the guest page, which clears its own copy.
// Clicking pins the draft where it is as a smaller note that lasts
// `noteLifetime`.

// How long a draft stays fully visible after the last change. Short text
// needs less time than long text, but it grows with the logarithm of the
// length, so it tapers off, and even the longest draft fades within 10 s:
// 1 char ~3.2 s, 20 ~5.5 s, 80 ~7.8 s, 200 ~9.5 s.
export const HOLD = Object.freeze({ baseMs: 3000, perLogMs: 2000, scale: 8, maxMs: 10000 })

export function draftHoldMs(text) {
  const length = Array.from(text ?? '').length
  const ms = HOLD.baseMs + HOLD.perLogMs * Math.log1p(length / HOLD.scale)
  return Math.round(Math.min(HOLD.maxMs, ms))
}

export const TYPING = Object.freeze({
  fadeMs: 1500,
  maxHoldMs: HOLD.maxMs,
  maxLength: 200, // UTF-16 code units
  maxLines: 5
})

// Longer text gets smaller in steps rather than continuously (text shrinking
// with every keystroke would be distracting). Thresholds grow ~3x, sizes
// shrink less each step. Notes use the matching smaller size.
export const FONT_STEPS = Object.freeze([
  { upTo: 20, draftPx: 24, notePx: 16 },
  { upTo: 60, draftPx: 20, notePx: 14 },
  { upTo: 120, draftPx: 17, notePx: 13 },
  { upTo: Infinity, draftPx: 15, notePx: 12 }
])
// a step only goes back up once the text is this much shorter than its
// threshold, so backspacing around a threshold doesn't flip sizes
const STEP_HYSTERESIS = 5

/** FONT_STEPS index for `text`, given the step it had before (if any). */
export function fontStep(text, previous = 0) {
  const length = Array.from(text ?? '').length
  const last = FONT_STEPS.length - 1
  let step = Number.isInteger(previous) ? Math.min(Math.max(previous, 0), last) : 0
  while (step < last && length > FONT_STEPS[step].upTo) step++
  while (step > 0 && length <= FONT_STEPS[step - 1].upTo - STEP_HYSTERESIS) step--
  return step
}

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
// how long a note (or a departed guest's text) takes to fade out
export const NOTE_FADE_MS = 1000

// Only characters that are dangerous are removed: control characters, and
// bidi controls (a right-to-left override would make "kcuf" *display* as a
// word the filter never saw). Zero-width joiners etc. are kept, since emoji
// sequences and several scripts need them; the filter ignores them instead.
const CONTROLS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu
const MARK_PILES = /(\p{M}{4})\p{M}+/gu // "zalgo": real text never needs 5+ stacked marks

/**
 * Cleans text typed by a guest without dropping anything a person could
 * have meant to type: newlines stay, tabs become spaces, only controls and
 * bidi overrides go, and huge piles of combining marks are capped. The guest
 * page enforces the same length/line limits, so those never cut normal text.
 */
export function sanitizeTypedText(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw
    .slice(0, TYPING.maxLength * 4)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, (c) => (c === '\n' ? c : c === '\t' ? ' ' : ''))
    .replace(MARK_PILES, '$1')
  text = text.split('\n').slice(0, TYPING.maxLines).join('\n')
  if (text.length > TYPING.maxLength) {
    text = text.slice(0, TYPING.maxLength)
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1) // don't split an emoji
  }
  return text
}

/** Per-guest bookkeeping for createTypingState / acceptTypingMessage. */
export function createTypingState() {
  return { textSeq: 0, pinSeqs: new Set() }
}

const REMEMBERED_PINS = 64

/**
 * Decides what a client-text / client-pin message (with the guest's `seq`)
 * does. Data channels are reliable but unordered, so:
 * - a draft update is state: only one newer than everything applied so far
 *   counts (an older one arriving late would show stale text);
 * - a pin is an event: it is never dropped for arriving late (that would lose
 *   the note), only for being a duplicate. It replaces the draft only if
 *   nothing newer has been shown since.
 * Returns null (ignore), { draft: true } or { pin: true, clearDraft }.
 */
export function acceptTypingMessage(state, type, seq) {
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  if (type === 'client-pin') {
    if (state.pinSeqs.has(seq)) return null
    state.pinSeqs.add(seq)
    if (state.pinSeqs.size > REMEMBERED_PINS) {
      state.pinSeqs.delete(state.pinSeqs.values().next().value)
    }
    const newest = seq > state.textSeq
    if (newest) state.textSeq = seq
    return { pin: true, clearDraft: newest }
  }
  if (type !== 'client-text' || seq <= state.textSeq) return null
  state.textSeq = seq
  return { draft: true }
}
