'use strict'

// Empty a build's volume before filling it.
//
// Schematics carry no air: schematic.js drops every air cell at load, so the
// block list is solids only. /fill ... replace touches nothing it is not given.
// Together that means a build never clears its own interior - it is placed
// *around* whatever was already standing there.
//
// On land that shows up as one build interpenetrating another. In water it is
// unmissable: every cell the blueprint calls air keeps the ocean that was in
// it, and the house arrives full of water. Measured on mc-test - a hollow
// 5x4x5 shell built in a water tank came out 27 of 27 interior cells water.
//
// The clear is bounded below by the structure's own base, so the ground it
// stands in survives; it never digs a hole deeper than the build.

const { splitBox } = require('../building/commander')
const { Vec3 } = require('vec3')

// -> [{min: Vec3, max: Vec3, name: 'air'}], each within the /fill 32768 cap.
function clearBoxes (bounds, opts = {}) {
  const bottomY = opts.bottomY === undefined ? bounds.lo.y : Math.max(bounds.lo.y, opts.bottomY)
  const topY = opts.topY === undefined ? bounds.hi.y : Math.min(bounds.hi.y, opts.topY)
  if (topY < bottomY) return []
  const box = {
    min: new Vec3(bounds.lo.x, bottomY, bounds.lo.z),
    max: new Vec3(bounds.hi.x, topY, bounds.hi.z),
    name: 'air'
  }
  return splitBox(box)
}

// Breaking a hillside or a chest with /fill spits out hundreds of item
// entities; they lag the server and then settle inside the build you are about
// to place. Switch drops off for the duration, and put the gamerule back the
// way it was found rather than assuming it was on.
async function withoutDrops (rcon, fn) {
  const before = /false/.test(await rcon.send('gamerule doTileDrops')) ? 'false' : 'true'
  await rcon.send('gamerule doTileDrops false')
  try { return await fn() } finally { await rcon.send(`gamerule doTileDrops ${before}`) }
}

const FILLED = /([0-9]+) block/

// Two passes over the same volume rather than one, because the split is worth
// knowing: `replace water` first tells us how much of what we removed was
// liquid, and a build standing in water is about to flood back through its own
// doors and windows no matter how carefully it was placed. Costs one extra
// fill per box and buys an honest warning.
async function runClear (rcon, boxes) {
  let cleared = 0
  let water = 0
  const count = async (cmd) => {
    const m = FILLED.exec(await rcon.send(cmd))
    return m ? Number(m[1]) : 0
  }
  for (const b of boxes) {
    const at = `${b.min.x} ${b.min.y} ${b.min.z} ${b.max.x} ${b.max.y} ${b.max.z}`
    water += await count(`fill ${at} minecraft:air replace water`)
    cleared += await count(`fill ${at} minecraft:air replace`)
  }
  return { boxes: boxes.length, cleared: cleared + water, water }
}

module.exports = { clearBoxes, runClear, withoutDrops }
