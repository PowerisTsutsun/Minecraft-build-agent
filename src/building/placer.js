'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { ACTION_TIMEOUT_MS, SCAFFOLD_BLOCK, BUILD_MODE } = require('../config')
const session = require('./session')
const commander = require('./commander')
const { baseName } = require('./blockspec')

// ---------------------------------------------------------------------------
// Block placement.
//
// mineflayer's network-facing calls (pathfinding, digging, equipping, placing)
// have each independently been observed to hang forever - never resolving *or*
// rejecting - rather than failing fast, on server versions newer than the
// library was tested against. This first showed up in pathfinder.goto(); fixing
// only that one call site still let the bot wedge permanently on
// dig()/equip()/placeBlock() a build later. So every blocking bot call in the
// placement path goes through the same race: whichever one hangs becomes an
// ordinary rejected promise (and thus a 'failed' block) instead of freezing the
// build loop - and the whole process - forever with no error in the log.
// ---------------------------------------------------------------------------

function withTimeout (promise, label, onTimeout) {
  // The timer MUST be cleared when the operation wins the race. Promise.race
  // settles on the first promise but does not cancel the loser, so a bare
  // setTimeout here keeps running after a perfectly successful call and fires
  // its cleanup 15 seconds later - by which point that cleanup lands on
  // whatever operation is running *then*. Since the cleanups are
  // bot.stopDigging() and bot.pathfinder.stop(), every successful dig left a
  // delayed charge that aborted a later one ("Digging aborted"), and every
  // successful goto left one that killed a later path ("Path was stopped
  // before it could be completed"). The symptom was an undo that removed the
  // first block and then failed every remaining block, which reads exactly
  // like "the bot can't reach them" and is nothing of the sort.
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // A genuine timeout still needs its cleanup: Promise.race can't cancel
      // the losing promise, so without this the abandoned call (a search, a
      // dig) keeps running in the background even after we've moved on.
      if (onTimeout) { try { onTimeout() } catch (err) { /* nothing to clean up - fine */ } }
      reject(new Error(`${label} timed out`))
    }, ACTION_TIMEOUT_MS)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const gotoWithTimeout = (bot, goal) =>
  withTimeout(bot.pathfinder.goto(goal), 'pathfinder', () => bot.pathfinder.stop())
const digWithTimeout = (bot, block) =>
  withTimeout(bot.dig(block), 'dig', () => bot.stopDigging())
const equipWithTimeout = (bot, item, destination) =>
  withTimeout(bot.equip(item, destination), 'equip')
const placeBlockWithTimeout = (bot, ref, face) =>
  withTimeout(bot.placeBlock(ref, face), 'placeBlock')

const NEIGHBOR_OFFSETS = [
  new Vec3(0, -1, 0), // block below first - the most reliable face to click
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  new Vec3(0, 1, 0)
]

async function walkTo (bot, target, face) {
  // GoalPlaceBlock knows where a player has to stand to legally click a given
  // face, including standing on top of the structure. Fall back to a plain
  // proximity goal if this version of pathfinder doesn't export it.
  if (goals.GoalPlaceBlock) {
    try {
      await gotoWithTimeout(bot, new goals.GoalPlaceBlock(target.clone(), bot.world, {
        range: 4,
        faces: [face],
        half: 'top'
      }))
      return
    } catch (err) {
      // no standing spot for that face (or the search timed out) - fall through
    }
  }
  await gotoWithTimeout(bot, new goals.GoalNear(target.x, target.y, target.z, 3))
}

// A player cannot place a block inside their own hitbox. A floor laid at the
// bot's own standing level hits this constantly: GoalPlaceBlock's `half: 'top'`
// deliberately stands the bot ON the reference block, which for a floor course
// is the exact square it is trying to fill. The placement is then refused by
// the server, no blockUpdate ever arrives, and it surfaces as a bogus
// "unreachable". Stepping one block clear first is what makes a floor at foot
// level buildable at all.
// `includeSupport` also treats the block the bot is standing ON as a conflict.
// Placing wants that block (it is the reference face); digging does not - a bot
// standing on the block it is removing has no clean line of sight to it, the
// server refuses the dig, and no blockUpdate ever comes back.
async function stepAsideFrom (bot, target, includeSupport = false) {
  const feet = bot.entity.position.floored()
  const occupies = target.equals(feet) ||
    target.equals(feet.offset(0, 1, 0)) ||
    (includeSupport && target.equals(feet.offset(0, -1, 0)))
  if (!occupies) return false

  try {
    // GoalInvert turns "get near" into "get away from" - the bot picks its own
    // escape square rather than us guessing one that might be a wall.
    await gotoWithTimeout(bot, new goals.GoalInvert(
      new goals.GoalNear(target.x, target.y, target.z, 2)
    ))
  } catch (err) {
    // Couldn't path away - the caller still tries; worst case it fails as before.
  }
  return true
}

function countInInventory (bot, name) {
  return bot.inventory.items()
    .filter(i => i.name === name)
    .reduce((sum, i) => sum + i.count, 0)
}

function countMaterials (blocks) {
  const needed = new Map()
  for (const { name } of blocks) needed.set(name, (needed.get(name) || 0) + 1)
  return needed
}

// Scans straight down from `from` to find the first solid block, returning the
// Y just above it - i.e. true standing/floor level, regardless of whether the
// bot happens to currently be a block or two higher (standing on scaffolding,
// rubble, or its own half-built wall).
const GROUND_SCAN_MAX_DROP = 8

function findGroundY (bot, from) {
  const x = Math.floor(from.x)
  const z = Math.floor(from.z)
  let y = Math.floor(from.y)
  for (let dropped = 0; dropped < GROUND_SCAN_MAX_DROP; dropped++) {
    const below = bot.blockAt(new Vec3(x, y - 1, z))
    if (below && below.boundingBox === 'block') return y
    y--
  }
  // Nothing solid within range (bot is high up, or world data isn't loaded
  // yet) - fall back to its raw current level rather than guessing further.
  return Math.floor(from.y)
}

// Returns { result: 'placed'|'skipped'|'no-material'|'failed', previous, why }
//
// `why` carries the reason a block failed. Without it a failed build reports
// only "16 unreachable", which is indistinguishable between "no solid
// neighbour to click", "chunk isn't loaded", and "the server rejected the
// placement" - three problems with three different fixes.
async function placeAt (bot, target, spec) {
  // The walking placer cannot honour a block state - it places an item and the
  // server orients it from where the bot is standing. So it works in base ids
  // throughout and a stair placed this way lands however the server decides.
  const blockName = baseName(spec)
  const existing = bot.blockAt(target)
  const previous = existing ? existing.name : 'unknown'

  if (!existing) {
    return { result: 'failed', previous, why: 'world data not loaded at target' }
  }
  if (existing.name === blockName) return { result: 'skipped', previous }

  if (existing.boundingBox === 'block') {
    // Something solid is in the way (a hill, a re-run with the wrong material).
    try {
      await gotoWithTimeout(bot, new goals.GoalNear(target.x, target.y, target.z, 3))
      await digWithTimeout(bot, bot.blockAt(target))
    } catch (err) {
      return { result: 'failed', previous, why: `couldn't clear ${previous}: ${err.message}` }
    }
  }

  if (!bot.inventory.items().some(i => i.name === blockName)) {
    return { result: 'no-material', previous }
  }

  let why = 'no solid neighbour to place against'
  for (const offset of NEIGHBOR_OFFSETS) {
    const ref = bot.blockAt(target.plus(offset))
    if (!ref || ref.boundingBox !== 'block') continue

    const face = offset.scaled(-1) // points from the reference block at the target
    try {
      await walkTo(bot, target, face)
      // walkTo may have parked the bot in the target square itself (see
      // stepAsideFrom) - check after moving, not before.
      await stepAsideFrom(bot, target)
      if (!bot.heldItem || bot.heldItem.name !== blockName) {
        const held = bot.inventory.items().find(i => i.name === blockName)
        if (!held) return { result: 'no-material', previous }
        await equipWithTimeout(bot, held, 'hand')
      }
      await placeBlockWithTimeout(bot, ref, face)
      await bot.waitForTicks(2)
      return { result: 'placed', previous }
    } catch (err) {
      // mineflayer confirms a placement by waiting for a blockUpdate packet
      // naming the target. On 26.1 that packet frequently never arrives for
      // the placing player - the client is expected to predict the change
      // itself - so placeBlock rejects with "Event blockUpdate:(x,y,z) did not
      // fire within timeout" even though the server placed the block just
      // fine. Trusting that rejection is worse than a wrong progress count:
      // the block is really in the world but never reaches the undo log, so
      // !undo silently leaves it behind. Re-read the target before believing
      // the error.
      await bot.waitForTicks(4)
      const settled = bot.blockAt(target)
      if (settled && settled.name === blockName) {
        return { result: 'placed', previous }
      }
      why = `against ${ref.name}: ${err.message}` // keep the last real reason
    }
  }

  return { result: 'failed', previous, why }
}

// ---------------------------------------------------------------------------
// Dry run.
//
// Pure summary - never touches the world. Prints a per-material tally, the
// bounding box in absolute world coordinates, and the first few placements, so
// a 2000-block plan can be sanity-checked in chat before it is committed.
// ---------------------------------------------------------------------------
function describePlan (origin, blocks, label) {
  const materials = countMaterials(blocks)
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const { pos } of blocks) {
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], origin[axis] + pos[axis])
      max[axis] = Math.max(max[axis], origin[axis] + pos[axis])
    }
  }

  const lines = [
    `DRY RUN: ${label}`,
    `  ${blocks.length} blocks`,
    `  bounds: (${min.x}, ${min.y}, ${min.z}) -> (${max.x}, ${max.y}, ${max.z})`,
    '  materials:'
  ]
  for (const [name, count] of [...materials].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${count} x ${name}`)
  }
  lines.push('  first placements:')
  for (const { pos, name } of blocks.slice(0, 10)) {
    lines.push(`    ${name} @ (${origin.x + pos.x}, ${origin.y + pos.y}, ${origin.z + pos.z})`)
  }
  if (blocks.length > 10) lines.push(`    ... and ${blocks.length - 10} more`)

  return { text: lines.join('\n'), materials, bounds: { min, max } }
}

// ---------------------------------------------------------------------------
// The build loop.
//
// opts: { dryRun, label, onProgress, shouldCancel }
// ---------------------------------------------------------------------------
async function buildStructure (bot, origin, blocks, opts = {}) {
  const { dryRun = false, label = 'structure', onProgress, shouldCancel } = opts
  const stats = { placed: 0, skipped: 0, failed: 0, missing: new Set(), dryRun }

  if (dryRun) {
    const plan = describePlan(origin, blocks, label)
    console.log(plan.text)
    stats.plan = plan
    return stats
  }

  // Fast path: an op'd bot fills the whole structure with a handful of
  // commands instead of walking to every block. fillStructure returns null if
  // the first command changes nothing, which is the honest test for "this bot
  // is not op" - fall through to walking in that case.
  if (BUILD_MODE !== 'survival') {
    const filled = await commander.fillStructure(bot, origin, blocks, opts)
    if (filled) return filled
    if (BUILD_MODE === 'command') {
      throw new Error('command mode is forced but /fill did nothing - is the bot op?')
    }
    console.log('[place] falling back to survival placement')
  }

  const buildId = session.startBuild(label)
  const retry = []

  try {
    for (let i = 0; i < blocks.length; i++) {
      if (shouldCancel && shouldCancel()) {
        stats.cancelled = true
        break
      }
      const { pos, name } = blocks[i]
      const target = origin.plus(pos)
      const { result, previous, why } = await placeAt(bot, target, name)

      if (result === 'placed') {
        stats.placed++
        session.recordPlacement(buildId, target, name, previous)
      } else if (result === 'skipped') stats.skipped++
      else if (result === 'no-material') stats.missing.add(name)
      else {
        stats.failed++
        retry.push(blocks[i])
        // First few only - a wholly failing build would otherwise write one log
        // line per block, and the first failure is the one that explains it.
        if (stats.failed <= 3) console.error(`[place] ${name} @ (${target.x}, ${target.y}, ${target.z}): ${why}`)
        stats.lastWhy = why
      }

      if (onProgress && i > 0 && i % 40 === 0) onProgress(i, blocks.length)
    }
    // Retry pass. A block that failed early often succeeds on a second look:
    // by now its neighbours exist to place against, and the bot is standing
    // somewhere else entirely. Only one pass - anything that fails twice is
    // genuinely out of reach, and a third attempt just burns time.
    if (retry.length && !(shouldCancel && shouldCancel())) {
      console.log(`[place] retrying ${retry.length} failed blocks`)
      for (const { pos, name } of retry) {
        if (shouldCancel && shouldCancel()) break
        const target = origin.plus(pos)
        const { result, previous } = await placeAt(bot, target, name)
        if (result === 'placed') {
          stats.placed++
          stats.failed--
          session.recordPlacement(buildId, target, name, previous)
        }
      }
    }
  } finally {
    // Always flush, even on a thrown error - otherwise up to FLUSH_EVERY
    // blocks are in the world with no undo record.
    session.flush()
  }

  return stats
}

// ---------------------------------------------------------------------------
// Scaffolding cleanup.
//
// To reach an upper course the pathfinder pillars up, placing SCAFFOLD_BLOCK
// itself. Those blocks never pass through placeAt, so nothing records them and
// undo cannot see them - they simply stay where they are. For anything with an
// interior that is not a cosmetic problem: a 7x6x4 house came out structurally
// perfect and completely full of dirt, with no way to walk in.
//
// So the builder cleans up after itself: after the last block is placed, sweep
// the build's own bounding box for scaffold blocks that are not part of the
// plan, and dig them out.
//
// Two deliberate limits keep this from eating the player's world:
//   - only inside the build's bounding box, never a margin around it
//   - only blocks matching SCAFFOLD_BLOCK that the plan does not call for, so
//     a structure legitimately built out of the scaffold material is untouched
// It still cannot tell the bot's own dirt from the player's pre-existing dirt
// inside that box, which is the reason SCAFFOLD_BLOCK should stay set to
// something the build itself never uses.
// ---------------------------------------------------------------------------
async function sweepScaffolding (bot, origin, blocks, opts = {}) {
  const { shouldCancel } = opts
  const removed = { count: 0, failed: 0 }

  const planned = new Set()
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const { pos, name } of blocks) {
    const t = origin.plus(pos)
    planned.add(`${t.x},${t.y},${t.z}`)
    if (name === SCAFFOLD_BLOCK) continue // don't sweep a build made of the scaffold material
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], t[axis])
      max[axis] = Math.max(max[axis], t[axis])
    }
  }
  if (!Number.isFinite(min.x)) return removed

  // The pathfinder must not dig during this, or it cancels our digs - the same
  // trap documented in undo.js.
  require('../bot').configureMovements(bot, [], { canDig: false })

  const targets = []
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        if (planned.has(`${x},${y},${z}`)) continue
        const here = bot.blockAt(new Vec3(x, y, z))
        if (here && here.name === SCAFFOLD_BLOCK) targets.push(new Vec3(x, y, z))
      }
    }
  }
  if (!targets.length) return removed

  // Top down: removing a pillar from the bottom drops everything above it out
  // of reach and strands the bot.
  targets.sort((a, b) => b.y - a.y)

  for (const pos of targets) {
    if (shouldCancel && shouldCancel()) break
    let block = bot.blockAt(pos)
    if (!block || block.name !== SCAFFOLD_BLOCK) continue

    if (!safeToDig(bot, block)) {
      try {
        await gotoWithTimeout(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3))
      } catch (err) {
        await bot.waitForTicks(4)
      }
      await stepAsideFrom(bot, pos, true)
      block = bot.blockAt(pos)
      if (!block || block.name !== SCAFFOLD_BLOCK) continue
      if (!safeToDig(bot, block)) { removed.failed++; continue }
    }

    try {
      await digWithTimeout(bot, block)
      removed.count++
    } catch (err) {
      await bot.waitForTicks(4)
      const after = bot.blockAt(pos)
      if (after && after.name !== SCAFFOLD_BLOCK) removed.count++
      else removed.failed++
    }
  }

  return removed
}

function safeToDig (bot, block) {
  try {
    return bot.canDigBlock(block)
  } catch (err) {
    return false
  }
}


// ---------------------------------------------------------------------------
// Finding somewhere to build.
//
// The origin used to be the player's position plus two blocks east, with no
// check on what was already there. Build twice from one spot and the second
// build lands inside the first - which is how a sandbox ends up as a pile of
// overlapping castles.
//
// So: measure the footprint the plan actually needs, then walk outward from the
// player in a widening ring until a site is clear of anything built. Ground
// level is sampled per site rather than taken from the player, because a player
// standing on a roof is not standing on the ground.
// ---------------------------------------------------------------------------

const SITE_STEP = 4
const SITE_MAX_RINGS = 12

// Is this footprint free of anything that looks built? Terrain is fine to
// build on; walls, floors and roofs are not.
function siteIsClear (bot, corner, width, depth, height) {
  const NATURAL = /^(air|grass_block|dirt|stone|gravel|sand|sandstone|deepslate|water|snow|.*_leaves|.*_log|short_grass|tall_grass|fern|.*_flower|dandelion|poppy|bedrock|coarse_dirt|podzol|clay|granite|diorite|andesite|tuff|.*_ore|moss_block|rooted_dirt|mud)$/

  // Sample rather than test every cell: a 40x40x30 box is 48,000 blockAt calls
  // per candidate site, and there can be a dozen candidates.
  const stepX = Math.max(1, Math.floor(width / 8))
  const stepZ = Math.max(1, Math.floor(depth / 8))
  const stepY = Math.max(1, Math.floor(height / 6))

  for (let x = 0; x < width; x += stepX) {
    for (let z = 0; z < depth; z += stepZ) {
      for (let y = 0; y < height; y += stepY) {
        const b = bot.blockAt(corner.offset(x, y, z))
        if (!b) continue
        if (!NATURAL.test(b.name)) return false
      }
    }
  }
  return true
}

// Walk outward from the player until the footprint fits on empty ground.
function findSite (bot, near, footprint) {
  const width = Math.max(1, footprint.width)
  const depth = Math.max(1, footprint.depth)
  const height = Math.max(1, footprint.height)
  const base = near.floored()

  for (let ring = 0; ring < SITE_MAX_RINGS; ring++) {
    const r = ring * SITE_STEP + 3
    // Ring order: east, south, west, north, then the diagonals - so the first
    // build lands beside the player rather than behind them.
    const offsets = ring === 0
      ? [[3, 0]]
      : [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]

    for (const [dx, dz] of offsets) {
      const probe = base.offset(dx, 0, dz)
      const groundY = findGroundY(bot, probe)
      const corner = new Vec3(probe.x, groundY, probe.z)
      if (siteIsClear(bot, corner, width, depth, height)) {
        return { origin: corner, ring, searched: ring * 8 }
      }
    }
  }
  // Nothing clear within range - build beside the player anyway rather than
  // refusing, and say so.
  return { origin: new Vec3(base.x + 3, findGroundY(bot, base), base.z), ring: -1, searched: SITE_MAX_RINGS * 8 }
}

// Moved to bounds.js so the live path can have it without pulling in
// mineflayer-pathfinder. Re-exported here for the retired callers.
const { footprintOf } = require('./bounds')

module.exports = {
  findSite,
  footprintOf,
  siteIsClear,
  buildStructure,
  sweepScaffolding,
  describePlan,
  placeAt,
  walkTo,
  stepAsideFrom,
  findGroundY,
  countInInventory,
  countMaterials,
  withTimeout,
  gotoWithTimeout,
  digWithTimeout,
  equipWithTimeout,
  placeBlockWithTimeout
}
