// Where a text bubble goes relative to a pointer tip at (x, y): below-right of
// the arrow, flipped to the left / above near the right / bottom screen edge.

const OFFSET_X = 28
const OFFSET_Y = 20
const FLIP_X_MARGIN = 320
const FLIP_Y_MARGIN = 140

export function bubblePlacement(x, y, viewport) {
  const flipX = x > viewport.width - FLIP_X_MARGIN
  const flipY = y > viewport.height - FLIP_Y_MARGIN
  const left = Math.round(flipX ? x - OFFSET_X : x + OFFSET_X)
  const top = Math.round(flipY ? y - OFFSET_Y : y + OFFSET_Y)
  return {
    transform: `translate(${left}px, ${top}px) translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
    transformOrigin: `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`
  }
}
