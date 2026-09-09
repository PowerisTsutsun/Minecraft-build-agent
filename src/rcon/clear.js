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
  const rule = await dropRule(rcon)
  if (!rule) return fn()
  const before = /false/.test(await rcon.send(`gamerule ${rule}`)) ? 'false' : 'true'
  await rcon.send(`gamerule ${rule} false`)
  try { return await fn() } finally { await rcon.send(`gamerule ${rule} ${before}`) }
}

// 26.2 renamed every gamerule from camelCase to snake_case - `doTileDrops` is
// now `block_drops`, `doMobLoot` is `mob_drops`, and so on. The old names are
// not aliases: the server answers "Incorrect argument for command" and, because
// nothing read the reply, withoutDrops silently did nothing on 26.2. Every clear
// since has been spraying item entities across the site.
//
// Resolved by asking the server rather than by version number, so one binary
// works against a 26.1 sandbox and a 26.2 server. Cached per process.
const DROP_RULE_NAMES = ['block_drops', 'doTileDrops']
const REJECTED = /incorrect argument|unknown or incomplete/i
let cachedDropRule
async function dropRule (rcon) {
  if (cachedDropRule !== undefined) return cachedDropRule
  for (const name of DROP_RULE_NAMES) {
    if (!REJECTED.test(await rcon.send(`gamerule ${name}`))) {
      cachedDropRule = name
      return name
    }
  }
  console.error(`[build] this server knows none of ${DROP_RULE_NAMES.join('/')} - clearing with drops left on`)
  cachedDropRule = null
  return null
}

// Best effort, for the signal handler: put drops back without needing to know
// which name this server uses.
async function restoreDrops (rcon) {
  const rule = await dropRule(rcon)
  if (rule) await rcon.send(`gamerule ${rule} true`)
  return rule
}

// ---------------------------------------------------------------------------
// Build with the world's clock stopped.
//
// Redstone, pistons, observers and flowing water all run on *scheduled* ticks,
// and a fill takes many ticks. So every one of them evaluates against a
// half-built structure: a sticky piston filled as `extended=true` retracts
// because the redstone that holds it out has not arrived yet, and its
// piston_head pops off; an observer placed early pulses at every later fill in
// front of it; a redstone block landing between two pistons shoves itself out
// of a structure that is not finished standing.
//
// The fill phases in commander.js (phaseOf) put power sources after the
// mechanisms they drive. That is necessary but not sufficient: it controls the
// order, not whether the world is allowed to react in the middle of the build.
//
// `/tick freeze` stops scheduled ticks and entity movement while leaving block
// placement and *neighbour* updates working - fence joins and redstone dust
// shapes still compute - which is exactly the split a build wants. On unfreeze
// everything evaluates once against the finished structure, so a piston clock
// starts from its designed state instead of from whatever existed halfway
// through.
//
// Measured on 16267.schem, 38 moving parts: 26 exact as-is, 34 with this.
//
// If the server does not understand /tick (pre-1.20.2) the build goes ahead
// unfrozen, which is what it did before. If the world was ALREADY frozen when
// we arrived it is left frozen - somebody else's freeze is not ours to lift.
async function withFrozenTicks (rcon, fn) {
  let froze = false
  try {
    if (!/frozen/i.test(await rcon.send('tick query'))) {
      const out = await rcon.send('tick freeze')
      froze = /frozen/i.test(out)
      if (!froze) console.error(`[build] could not stop the tick, building live: ${out.trim().slice(0, 70)}`)
    }
  } catch (err) {
    console.error('[build] could not stop the tick, building live:', err.message)
  }
  try {
    return await fn()
  } finally {
    // An unfrozen world matters more than any error above it: a server left
    // frozen has no mob AI, no crop growth and no item transport, for everyone.
    if (froze) {
      try {
        await rcon.send('tick unfreeze')
      } catch (err) {
        console.error('[build] COULD NOT UNFREEZE - run `/tick unfreeze` by hand:', err.message)
      }
    }
  }
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

module.exports = { clearBoxes, runClear, withoutDrops, withFrozenTicks, dropRule, restoreDrops }
