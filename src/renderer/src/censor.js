// Bad word detection for guest names and typed text.
//
// Returns the exact character ranges to hide, so the overlay can cover those
// characters with a block of the same size (see MaskedText.vue) instead of
// replacing them: the text keeps its shape while the guest is typing.
//
// Detection is `obscenity` (leetspeak, look-alike letters, repeated letters,
// whitelists against the Scunthorpe problem) on a normalized view of the text,
// plus a pass for spaced out letters ("f u c k", "s.h.i.t"). Every match is
// mapped back to the original string, so the ranges are UTF-16 offsets into
// what the guest actually sent.

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'

// innocent words the stock English dataset would partly hide
const EXTRA_WHITELIST = ['cockpit', 'pussycat', 'pussy cat', 'tit for tat', 'peniston']

const dataset = englishDataset.build()
const matcher = new RegExpMatcher({
  ...dataset,
  whitelistedTerms: [...dataset.whitelistedTerms, ...EXTRA_WHITELIST],
  ...englishRecommendedTransformers
})

const MARKS = /\p{M}/gu
// zero-width and other invisible format characters: kept in the text, ignored for matching
const INVISIBLE = /^\p{Cf}$/u
// 3+ single letters, each separated by 1-2 non-alphanumeric characters
const SPACED_LETTERS = /(?<![\p{L}\p{N}])\p{L}(?:[^\p{L}\p{N}\n]{1,2}\p{L}){2,}(?![\p{L}\p{N}])/gu
const LETTER = /\p{L}/u

/**
 * Normalized copy of `text` for matching, plus for each of its UTF-16 code
 * units the [from, to) range of the original text it came from.
 * NFKD folds fancy letters (𝒇, Ｆ, ⓕ, ﬀ) to ASCII and splits off accents,
 * which are dropped (and attributed to the letter before them), like invisible
 * characters (zero-width space/joiner, soft hyphen), so they can't split a word.
 */
function normalizedView(text) {
  let view = ''
  const from = []
  const to = []
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)
    const len = cp > 0xffff ? 2 : 1
    const char = String.fromCodePoint(cp)
    const folded =
      cp < 0x80 ? text[i] : INVISIBLE.test(char) ? '' : char.normalize('NFKD').replace(MARKS, '')
    if (folded === '') {
      for (let k = to.length - 1; k >= 0 && to[k] === i; k--) to[k] = i + len
    } else {
      for (let k = 0; k < folded.length; k++) {
        from.push(i)
        to.push(i + len)
      }
      view += folded
    }
    i += len
  }
  return { view, from, to }
}

function matchRanges(view) {
  return matcher.getAllMatches(view).map((m) => [m.startIndex, m.endIndex + 1])
}

/** "f u c k" -> match on "fuck", reported over the whole spaced run */
function spacedLetterRanges(view) {
  const ranges = []
  for (const run of view.matchAll(SPACED_LETTERS)) {
    let compact = ''
    const at = []
    for (let k = 0; k < run[0].length; k++) {
      if (LETTER.test(run[0][k])) {
        compact += run[0][k]
        at.push(run.index + k)
      }
    }
    for (const [s, e] of matchRanges(compact)) ranges.push([at[s], at[e - 1] + 1])
  }
  return ranges
}

function merge(ranges) {
  ranges.sort((a, b) => a[0] - b[0])
  const out = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

function computeMask(text) {
  const { view, from, to } = normalizedView(text)
  const viewRanges = [...matchRanges(view), ...spacedLetterRanges(view)]
  return merge(viewRanges.map(([s, e]) => [from[s], to[e - 1]]))
}

// the same strings get re-checked constantly (every pointer update), so keep
// recent results; Map iteration order makes it a cheap LRU
const CACHE_SIZE = 512
const cache = new Map()

/** Sorted, non-overlapping [start, end) UTF-16 ranges of `text` to hide. */
export function findBadWordRanges(text) {
  if (typeof text !== 'string' || text === '') return []
  let mask = cache.get(text)
  if (mask) {
    cache.delete(text)
  } else {
    mask = computeMask(text)
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value)
  }
  cache.set(text, mask)
  return mask
}
