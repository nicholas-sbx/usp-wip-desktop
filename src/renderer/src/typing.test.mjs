// npm test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptTypingMessage, createTypingState, sanitizeTypedText, TYPING } from './typing.js'

test('sanitizer keeps everything a person could have meant to type', () => {
  for (const text of [
    'hello world',
    'line one\nline two',
    'family 👨\u200D👩\u200D👧 and flag 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} and keycap 1\uFE0F\u20E3',
    'می\u200Cخواهم', // Persian, needs the zero-width non-joiner
    'Tiếng Việt',
    'e\u0323\u0302', // decomposed Vietnamese ệ (two marks)
    '  leading and trailing spaces  ',
    '😀'.repeat(100) // exactly 200 UTF-16 code units
  ]) {
    assert.equal(sanitizeTypedText(text), text, JSON.stringify(text))
  }
  assert.equal(sanitizeTypedText('a\tb'), 'a b')
  assert.equal(sanitizeTypedText('a\r\nb\rc'), 'a\nb\nc')
})

test('sanitizer only removes controls, bidi overrides and zalgo piles', () => {
  assert.equal(sanitizeTypedText('\u202Ekcuf\u202C'), 'kcuf')
  assert.equal(sanitizeTypedText('a\u0000b\u0007c\u200Fd'), 'abcd')
  assert.equal(sanitizeTypedText('z' + '\u0301'.repeat(30)), 'z' + '\u0301'.repeat(4))
  assert.equal(sanitizeTypedText(42), '')
  assert.equal(sanitizeTypedText({ text: 'x' }), '')
})

test('sanitizer limits length and lines without splitting a character', () => {
  assert.equal(sanitizeTypedText('x'.repeat(5000)).length, TYPING.maxLength)
  const emoji = sanitizeTypedText('a' + '😀'.repeat(150))
  assert.ok(emoji.length <= TYPING.maxLength)
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji), 'ends on a whole emoji')
  assert.equal(sanitizeTypedText('1\n2\n3\n4\n5\n6\n7').split('\n').length, TYPING.maxLines)
})

// What the guest sends: the whole draft after every change, a pin on click
// (after which the draft is empty), each with an increasing seq.
function guestSession(steps) {
  const messages = []
  let seq = 0
  let draft = ''
  for (const step of steps) {
    if (step === 'pin') {
      messages.push({ type: 'client-pin', seq: ++seq, text: draft })
      draft = ''
    } else {
      draft = step === 'clear' ? '' : draft + step
      messages.push({ type: 'client-text', seq: ++seq, text: draft })
    }
  }
  return messages
}

// What the host shows after receiving `delivered` in that order.
function hostView(delivered) {
  const state = createTypingState()
  let draft = ''
  const notes = []
  for (const m of delivered) {
    const action = acceptTypingMessage(state, m.type, m.seq)
    if (action?.draft) draft = m.text
    if (action?.pin) {
      if (m.text) notes.push(m.text)
      if (action.clearDraft) draft = ''
    }
  }
  return { draft, notes: notes.sort() }
}

function shuffled(list, seed) {
  const out = [...list]
  let x = seed
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648
    const j = x % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

test('no text or pin is lost however the messages are reordered', () => {
  const sessions = [
    ['h', 'e', 'l', 'l', 'o', 'pin', 'w', 'o', 'r', 'l', 'd'],
    ['a', 'b', 'pin', 'c', 'pin', 'd', 'e', 'pin'],
    ['x', 'clear', 'y', 'z', 'pin', 'pin', 'q'],
    ['1', '2', '3']
  ]
  for (const steps of sessions) {
    const sent = guestSession(steps)
    const inOrder = hostView(sent)
    const last = sent.at(-1)
    assert.equal(inOrder.draft, last.type === 'client-pin' ? '' : last.text)
    for (let seed = 1; seed <= 500; seed++) {
      assert.deepEqual(hostView(shuffled(sent, seed)), inOrder, `${steps.join('')} seed ${seed}`)
    }
  }
})

test('a pin that arrives after newer typing still becomes a note', () => {
  const [, pin, next] = guestSession(['hi', 'pin', 'x'])
  const { draft, notes } = hostView([next, pin])
  assert.deepEqual(notes, ['hi'])
  assert.equal(draft, 'x') // the newer draft stays
})

test('duplicate and malformed messages are ignored', () => {
  const state = createTypingState()
  assert.deepEqual(acceptTypingMessage(state, 'client-pin', 3), { pin: true, clearDraft: true })
  assert.equal(acceptTypingMessage(state, 'client-pin', 3), null)
  assert.equal(acceptTypingMessage(state, 'client-text', 2), null)
  for (const seq of [0, -1, 1.5, '4', null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(acceptTypingMessage(state, 'client-text', seq), null, String(seq))
  }
  assert.equal(acceptTypingMessage(state, 'something-else', 9), null)
})
