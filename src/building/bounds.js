'use strict'

// Footprint arithmetic, with no dependencies.
//
// This lived in placer.js, whose first two lines pull in mineflayer-pathfinder
// and src/config.js. The live RCON bot needs exactly these fifteen lines and
// nothing else from that module, so requiring it dragged the whole retired
// mineflayer stack into the running process - which is why `npm install
// --omit=dev` has to fetch it in production and why eight advisories in the
// mineflayer subtree cannot simply be dropped.

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
