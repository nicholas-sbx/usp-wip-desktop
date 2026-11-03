// Paints masked ranges with the CSS Custom Highlight API: the text stays a
// single, untouched text node, so the layout is *identical* with and without
// masking (splitting text into spans shifts widths by fractions of a pixel).
// One highlight (and ::highlight rule) per mask colour, reference counted:
// colours come from guests, so unused ones are removed again.

export const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS

const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i

const byColor = new Map() // color -> { color, name, highlight, rule, users }
const owned = new Map() // owner -> { entry, ranges }
let sheet = null
let lastId = 0

function acquire(color) {
  const safe = SAFE_COLOR.test(color) ? color : '#000000'
  let entry = byColor.get(safe)
  if (!entry) {
    const name = `uspwip-mask-${++lastId}`
    const highlight = new Highlight()
    CSS.highlights.set(name, highlight)
    sheet ??= document.head.appendChild(document.createElement('style')).sheet
    const index = sheet.insertRule(
      `::highlight(${name}) { color: transparent; background-color: ${safe}; ` +
        'text-shadow: none; text-decoration: none; }',
      sheet.cssRules.length
    )
    entry = { color: safe, name, highlight, rule: sheet.cssRules[index], users: 0 }
    byColor.set(safe, entry)
  }
  entry.users++
  return entry
}

function release(entry) {
  if (--entry.users > 0) return
  CSS.highlights.delete(entry.name)
  const index = Array.prototype.indexOf.call(sheet.cssRules, entry.rule)
  if (index >= 0) sheet.deleteRule(index)
  byColor.delete(entry.color)
}

/** Replaces `owner`'s masked ranges with `mask` ([start, end) offsets into `node`). */
export function setMaskRanges(owner, node, mask, color) {
  const previous = owned.get(owner)
  owned.delete(owner)
  if (node && node.nodeType === Node.TEXT_NODE && mask?.length) {
    const entry = acquire(color) // before releasing the old one: no churn for the same colour
    const ranges = []
    for (const [start, end] of mask) {
      if (!(end > start) || start < 0 || end > node.length) continue
      const range = new Range()
      range.setStart(node, start)
      range.setEnd(node, end)
      entry.highlight.add(range)
      ranges.push(range)
    }
    owned.set(owner, { entry, ranges })
  }
  if (previous) {
    for (const range of previous.ranges) previous.entry.highlight.delete(range)
    release(previous.entry)
  }
}

/** for tests: how many colours are registered right now */
export function activeMaskColors() {
  return byColor.size
}
