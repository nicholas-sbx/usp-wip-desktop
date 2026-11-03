// Paints masked ranges with the CSS Custom Highlight API: the text stays a
// single, untouched text node, so the layout is *identical* with and without
// masking (splitting text into spans shifts widths by fractions of a pixel).
// One highlight per mask colour; each MaskedText owns some of its ranges.

export const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS

const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i

const byColor = new Map() // color -> Highlight
const owned = new Map() // owner -> { highlight, ranges }
let sheet = null

function highlightFor(color) {
  const safe = SAFE_COLOR.test(color) ? color : '#000000'
  let highlight = byColor.get(safe)
  if (!highlight) {
    const name = `uspwip-mask-${byColor.size}`
    highlight = new Highlight()
    CSS.highlights.set(name, highlight)
    sheet ??= document.head.appendChild(document.createElement('style')).sheet
    sheet.insertRule(
      `::highlight(${name}) { color: transparent; background-color: ${safe}; ` +
        'text-shadow: none; text-decoration: none; }'
    )
    byColor.set(safe, highlight)
  }
  return highlight
}

/** Replaces `owner`'s masked ranges with `mask` ([start, end) offsets into `node`). */
export function setMaskRanges(owner, node, mask, color) {
  const previous = owned.get(owner)
  if (previous) {
    for (const range of previous.ranges) previous.highlight.delete(range)
    owned.delete(owner)
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !mask?.length) return
  const highlight = highlightFor(color)
  const ranges = []
  for (const [start, end] of mask) {
    if (!(end > start) || start < 0 || end > node.length) continue
    const range = new Range()
    range.setStart(node, start)
    range.setEnd(node, end)
    highlight.add(range)
    ranges.push(range)
  }
  owned.set(owner, { highlight, ranges })
}
