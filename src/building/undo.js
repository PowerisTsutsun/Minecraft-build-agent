'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { gotoWithTimeout, digWithTimeout, stepAsideFrom } = require('./placer')
const session = require('./session')
const commander = require('./commander')
const { BUILD_MODE } = require('../config')
const { baseName } = require('./blockspec')

// ---------------------------------------------------------------------------
// Undo.
//
// Rolls the most recent build back by digging out every block it placed, in
// reverse order (top-down), which is also the only order that keeps the bot
// standing on something while it works.
//
// What undo can and cannot do, stated plainly because the difference matters:
//
//   - It removes blocks the bot placed. That part is reliable.
//   - It does NOT restore blocks the bot dug out to make room. Those are
//     recorded as `previous` in the undo log and reported at the end, but
//     putting them back would need the bot to have the materials and would
//     itself be a build. If a build ate a hillside, undo gives you back the
//     hole, not the hill.
//   - A block someone else has since changed is left alone rather than dug,
//     so undo can't eat a neighbour's later work that happens to share a
//     coordinate.
//   - It does NOT remove the bot's scaffolding. When the bot pillars up to
//     reach height, mineflayer-pathfinder places those blocks itself - they
//     never pass through placeAt, so nothing records them and undo cannot see
//     them. A tall build reliably leaves a scattering of SCAFFOLD_BLOCK behind
//     (measured: 48 dirt left after a 137-block hut). Sweep them by hand, or
//     keep SCAFFOLD_BLOCK set to something visually obvious so they are easy
//     to spot.
// ---------------------------------------------------------------------------

async function undoLastBuild (bot, opts = {}) {
  const { limit = session.UNDO_BATCH, onProgress, shouldCancel } = opts

  const build = session.lastBuild()
  if (!build || !build.blocks.length) {
    return { nothing: true }
  }

  // Reverse order: last placed is first removed.
  const ordered = build.blocks.slice().reverse()
  const batch = ordered.slice(0, limit)

  // Command-mode rollback: /fill the recorded `previous` back in. This is the
  // one path that can restore terrain the build overwrote - digging only ever
  // gave you the hole back. Needs the chunks loaded, hence the teleport.
  if (BUILD_MODE !== 'survival' && batch.length) {
    await commander.teleportTo(bot, new Vec3(batch[0].x, batch[0].y + 1, batch[0].z))
    const cmd = await commander.restore(bot, batch, { shouldCancel })
    if (cmd) {
      const stuck = new Set((cmd.stuck || []).map(entryKey))
      const undoneKeys = new Set(batch.filter(e => !stuck.has(entryKey(e))).map(entryKey))
      const left = build.blocks.filter(b => !undoneKeys.has(entryKey(b)))
      session.updateLastBuild(left)
      cmd.remaining = left.length
      cmd.total = build.blocks.length
      return cmd
    }
    console.log('[undo] command rollback unavailable - digging instead')
  }

  // Take digging away from the pathfinder for the duration - see the note on
  // configureMovements. While undo runs, this bot is the only thing digging.
  require('../bot').configureMovements(bot, [], { canDig: false })
  const stats = { removed: 0, changed: 0, failed: 0, destroyed: new Set(), total: build.blocks.length }
  const undone = new Set()

  for (let i = 0; i < batch.length; i++) {
    if (shouldCancel && shouldCancel()) { stats.cancelled = true; break }
    const entry = batch[i]
    const pos = new Vec3(entry.x, entry.y, entry.z)
    const current = bot.blockAt(pos)

    if (!current || current.name === 'air') {
      // already gone - count it as undone so it leaves the log
      undone.add(entryKey(entry))
      stats.removed++
      continue
    }

    if (current.name !== baseName(entry.placed)) {
      // someone (or something) changed this block since we placed it - leave it
      stats.changed++
      undone.add(entryKey(entry))
      continue
    }

    // Move as little as possible. The pathfinder's Movements have canDig: true,
    // so while it is active it digs blocks out of its own way - and mineflayer
    // allows only one dig at a time (`if (bot.targetDigBlock) bot.stopDigging()`
    // in plugins/digging.js), so a pathfinder dig overlapping ours cancels ours
    // with "Digging aborted". Digging in isolation, with no goal set, is
    // completely reliable - test/dig-probe.js does it 4 for 4. It was the
    // reflexive goto before every single block that made undo look broken. So:
    // if the block is already in reach and in view, dig it where we stand.
    let block = bot.blockAt(pos)
    let ready = canDigNow(bot, block)

    if (!ready) {
      try {
        await gotoWithTimeout(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3))
      } catch (err) {
        // An abandoned path takes a moment to unwind, and whatever runs next
        // inherits the wreckage - the next goto rejects instantly with "Path
        // was stopped". Let it settle instead of stacking another command on.
        await bot.waitForTicks(4)
      }
      // Standing on the block you are digging blocks line of sight to it, and
      // a floor build guarantees it: the bot walks across what it just laid.
      if (await stepAsideFrom(bot, pos, true)) await bot.waitForTicks(2)
      await settle(bot)
      block = bot.blockAt(pos)
      ready = canDigNow(bot, block)
    }

    if (!ready) {
      stats.failed++
      const reach = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5))
      if (stats.failed <= 3) console.error(`[undo] ${entry.placed} @ (${pos.x}, ${pos.y}, ${pos.z}): can't reach or see it (${reach.toFixed(1)} away)`)
      continue
    }

    let dug = false
    try {
      await digWithTimeout(bot, block)
      dug = true
    } catch (err) {
      // bot.dig waits for the same blockUpdate packet that placeBlock does, and
      // it goes missing just as often on 26.1 - so a dig timeout does not mean
      // the block survived. Re-read it before believing the error, or undo
      // reports "unreachable" for blocks it actually removed and then refuses
      // to drop them from the log.
      await bot.waitForTicks(4)
      const after = bot.blockAt(pos)
      dug = Boolean(after) && after.name !== baseName(entry.placed)
      if (!dug && stats.failed < 3) console.error(`[undo] ${entry.placed} @ (${pos.x}, ${pos.y}, ${pos.z}): ${err.message}`)
    }

    if (dug) {
      stats.removed++
      undone.add(entryKey(entry))
      if (entry.previous && entry.previous !== 'air' && entry.previous !== 'unknown') {
        stats.destroyed.add(entry.previous)
      }
    } else {
      stats.failed++
    }

    if (onProgress && i > 0 && i % 40 === 0) onProgress(i, batch.length)
  }

  // Anything not undone (failed, or beyond the batch limit) stays in the log so
  // a second !undo picks up exactly where this one stopped.
  const remaining = build.blocks.filter(b => !undone.has(entryKey(b)))
  session.updateLastBuild(remaining)
  stats.remaining = remaining.length

  return stats
}

// Remove ONE named build (not just the last), restoring what it overwrote.
// Command-mode only: the whole build's footprint is force-loaded, then its
// blocks are handed to commander.restore in chunks - the same fill-back the
// last-build undo uses, just aimed at any build in the log. Returns null if
// the bot cannot fill (not op), so the caller can say so.
async function removeBuild (bot, build, opts = {}) {
  const { onProgress, shouldCancel } = opts
  if (!build || !build.blocks.length) return { nothing: true }
  if (BUILD_MODE === 'survival') return null

  const bounds = session.buildBounds(build)
  const keys = []
  for (let x = bounds.lo.x; x <= bounds.hi.x; x++) {
    for (let z = bounds.lo.z; z <= bounds.hi.z; z++) keys.push(`${x},${bounds.lo.y},${z}`)
  }
  const region = await commander.forceloadAdd(bot, keys)

  const stats = { removed: 0, changed: 0, failed: 0, restored: 0, destroyed: new Set(), total: build.blocks.length }
  const stuckAll = []
  try {
    // Top-down: same reason as undo - never strand the bot over a hole, and
    // let supports outlast what rests on them until the end.
    const ordered = build.blocks.slice().reverse()
    const CHUNK = 4000
    for (let i = 0; i < ordered.length; i += CHUNK) {
      if (shouldCancel && shouldCancel()) { stats.cancelled = true; break }
      const batch = ordered.slice(i, i + CHUNK)
      await commander.teleportTo(bot, new Vec3(batch[0].x, batch[0].y + 1, batch[0].z))
      const cmd = await commander.restore(bot, batch, { shouldCancel })
      if (!cmd) { commander.forceloadRemove(bot, region); return null }
      stats.removed += cmd.removed || 0
      stats.changed += cmd.changed || 0
      stats.failed += cmd.failed || 0
      stats.restored += cmd.restored || 0
      for (const d of (cmd.destroyed || [])) stats.destroyed.add(d)
      for (const e of (cmd.stuck || [])) stuckAll.push(e)
      if (onProgress) onProgress(Math.min(i + CHUNK, ordered.length), ordered.length)
    }
  } finally {
    commander.forceloadRemove(bot, region)
  }

  const stuckKeys = new Set(stuckAll.map(entryKey))
  const left = build.blocks.filter(b => stuckKeys.has(entryKey(b)))
  session.updateBuildById(build.id, left)
  stats.remaining = left.length
  return stats
}

function entryKey (e) {
  return `${e.x},${e.y},${e.z},${e.placed}`
}

// mineflayer's own reach-and-line-of-sight test. Using it rather than a bare
// distance check means a block behind a wall is walked to instead of being
// swung at uselessly.
function canDigNow (bot, block) {
  if (!block) return false
  try {
    return bot.canDigBlock(block)
  } catch (err) {
    return false
  }
}

// Clears any standing pathfinder goal and waits for the bot to stop moving,
// so a dig isn't cancelled by its own residual momentum.
const SETTLE_MAX_TICKS = 20
const STILL_ENOUGH = 0.03

async function settle (bot) {
  try { bot.pathfinder.setGoal(null) } catch (err) { /* no goal set - fine */ }

  for (let waited = 0; waited < SETTLE_MAX_TICKS; waited += 2) {
    const v = bot.entity.velocity
    if (Math.abs(v.x) < STILL_ENOUGH && Math.abs(v.z) < STILL_ENOUGH && Math.abs(v.y) < STILL_ENOUGH) return
    await bot.waitForTicks(2)
  }
  // Still drifting after a full second - dig anyway rather than stalling the
  // whole rollback on one block.
}

module.exports = { undoLastBuild, removeBuild }
