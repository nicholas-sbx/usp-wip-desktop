// node --test src/renderer/src/censor.test.mjs   (or: npm test)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findBadWordRanges } from './censor.js'

const hidden = (text) => findBadWordRanges(text).map(([s, e]) => text.slice(s, e))

test('plain words are hidden, exact characters only', () => {
  assert.deepEqual(findBadWordRanges('hello fuck you'), [[6, 10]])
  assert.deepEqual(hidden('what the shit'), ['shit'])
  assert.deepEqual(hidden('a\nbitch\nb'), ['bitch'])
})

test('clean text and Scunthorpe-style words are left alone', () => {
  const clean = [
    'hello world',
    'assassin',
    'Scunthorpe',
    'cocktail',
    'shitake',
    'grass',
    'the cockpit',
    'Pussycat',
    'tit for tat',
    'Click the A B C buttons',
    'a b c d e f g h i j k l m n o p q r s t u v w x y z',
    'The U.S.A. and the U.K.'
  ]
  for (const text of clean) assert.deepEqual(findBadWordRanges(text), [], text)
  assert.deepEqual(hidden('cock'), ['cock'])
  assert.deepEqual(hidden('pussy'), ['pussy'])
})

test('evasions', () => {
  assert.deepEqual(hidden('sh1t'), ['sh1t'])
  assert.deepEqual(hidden('fuuuuuck'), ['fuuuuuck'])
  assert.deepEqual(hidden('b!tch'), ['b!tch'])
  assert.deepEqual(hidden('ＦＵＣＫ'), ['ＦＵＣＫ']) // fullwidth
  assert.deepEqual(hidden('𝒇𝓾𝓬𝓴 off'), ['𝒇𝓾𝓬𝓴']) // math alphanumerics (surrogate pairs)
  assert.deepEqual(hidden('fück'), ['fück'])
  assert.deepEqual(hidden('fück'), ['fück']) // decomposed accent
  assert.deepEqual(hidden('fuсk'), ['fuсk']) // Cyrillic с
  assert.deepEqual(hidden('what the f u c k'), ['f u c k'])
  assert.deepEqual(hidden('s.h.i.t happens'), ['s.h.i.t'])
})

test('ranges are UTF-16 offsets into the original text', () => {
  const text = '😀😀 fuck 😀'
  assert.deepEqual(findBadWordRanges(text), [[5, 9]])
  const fancy = 'ok 𝒇𝓾𝓬𝓴'
  const [[s, e]] = findBadWordRanges(fancy)
  assert.equal(fancy.slice(s, e), '𝒇𝓾𝓬𝓴')
  assert.equal(e, fancy.length)
})

test('masks a word as soon as it is complete while typing', () => {
  const typed = 'you are a shit'
  const masks = [...typed].map((_, i) => findBadWordRanges(typed.slice(0, i + 1)).length > 0)
  assert.equal(masks.at(-1), true)
  assert.equal(
    masks.slice(0, -1).every((m) => !m),
    true
  )
})

test('overlapping matches merge into one range', () => {
  const ranges = findBadWordRanges('fuckfuck shitshit')
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1])
})

test('fast enough to run on every keystroke', () => {
  const words = 'the quick brown fox jumps over the lazy dog hello world typing fuck shit'.split(
    ' '
  )
  const inputs = Array.from({ length: 3000 }, (_, n) =>
    Array.from({ length: 30 }, (_, k) => words[(n * 7 + k * 13) % words.length])
      .join(' ')
      .slice(0, 200)
  )
  const t0 = performance.now()
  for (const text of inputs) findBadWordRanges(text + ' ') // uncached
  const perCall = (performance.now() - t0) / inputs.length
  assert.ok(perCall < 2, `${perCall.toFixed(3)} ms per 200-char check`)
})
