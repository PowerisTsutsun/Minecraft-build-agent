'use strict'

// Footprint arithmetic, with no dependencies.
//
// Split out of the old walking placer, which pulled mineflayer-pathfinder in at
// require time and dragged the whole networking stack into any process that
// wanted one pure function. That placer is gone; the split stays because
// footprint maths belongs with the blocks, not with whatever places them.

// -> { width, depth, height, lo, hi } over an array of { pos: {x,y,z} }.
function footprintOf (blocks) {
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const b of blocks) {
    lo.x = Math.min(lo.x, b.pos.x); hi.x = Math.max(hi.x, b.pos.x)
    lo.y = Math.min(lo.y, b.pos.y); hi.y = Math.max(hi.y, b.pos.y)
    lo.z = Math.min(lo.z, b.pos.z); hi.z = Math.max(hi.z, b.pos.z)
  }
  // An empty list has no footprint. Returning Infinity here is how a build with
  // no blocks reached `forceload add Infinity ...` and journalled bounds that
  // serialise to null - permanently un-findable by journal.findAt.
  if (!Number.isFinite(lo.x)) {
    return { width: 1, depth: 1, height: 1, empty: true, lo: { x: 0, y: 0, z: 0 }, hi: { x: 0, y: 0, z: 0 } }
  }
  return { width: hi.x - lo.x + 1, depth: hi.z - lo.z + 1, height: hi.y - lo.y + 1, empty: false, lo, hi }
}

module.exports = { footprintOf }
