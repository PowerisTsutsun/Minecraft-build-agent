'use strict'

const { Vec3 } = require('vec3')
const session = require('./session')
const { baseName } = require('./blockspec')
const { CMD_SETTLE_TICKS, RESUME_RADIUS } = require('../config')

// How many times to re-check unconfirmed cells before calling them failed.
const VERIFY_ROUNDS = 3

// ---------------------------------------------------------------------------
// Command-mode building: /fill instead of walking.
//
// The survival placer walks the bot to every single block, and measurement is
// brutal about what that costs - a 37-second sample of a live build was 55%
// spent pathfinding, 88 blocks travelled, and not one block confirmed placed.
// The bot is not slow at placing; it is slow at *going places*. An OP'd bot
// skips the walk entirely: /fill sets a whole cuboid server-side, instantly.
//
// Measured on this sandbox (test/cmd-rate-probe.js, 26.1 vanilla): 300 slash
// commands sent in 44ms with no spam kick and the connection intact. The
// command path is effectively free. Two constraints came out of the same probe
// and both shape the code below:
//
//   1. CHUNKS MUST BE LOADED. /setblock and /fill fail with "That position is
//      not loaded" outside a player's view distance, and a /fill whose box
//      touches even one unloaded chunk does nothing at all - the probe's
//      300-block fill cleared exactly zero. So the bot teleports to its build
//      site first and waits for chunks. This is not optional politeness; it is
//      the difference between building and silently doing nothing.
//   2. OP IS NOT JUST A PERMISSION, IT IS THE SPAM EXEMPTION. Vanilla kicks on
//      `chatSpamTickCount > 200 && !isOp(player)` - the counter climbs 20 per
//      message and decays 1 per tick, so ~10 messages in quick succession ends
//      a non-op session with `disconnect.spam`. An op is never checked. That is
//      the only reason a 114-command burst is safe, and it is why the burst is
//      sent ONLY after a single probe command has proved this bot is op.
//      Learned the hard way: de-opping the bot mid-session left the counter
//      sky-high from a legitimate op-time burst, and the very next message it
//      sent got it kicked instantly.
//   3. FEWER, BIGGER COMMANDS. Merging runs into cuboids turns a 200-block
//      house into a dozen fills - fewer commands to verify, and a shorter
//      window in which a build can be interrupted half-applied.
//
// Undo still works exactly as before: every cell's previous block is read out
// of the client's own world copy before the fill lands, and recorded through
// the same session log the survival placer writes. Command mode can actually
// undo *better* - it can put back terrain the build overwrote, which digging
// never could.
// ---------------------------------------------------------------------------

const key = (x, y, z) => `${x},${y},${z}`
const parseKey = k => k.split(',').map(Number)

// Greedy 3D merge: grow along x, then extend that run across z, then lift the
// whole rectangle through y. Every cell is consumed exactly once, so the result
// is a disjoint cover of the plan - no cell filled twice, no fill fighting
// another fill over the same coordinate.
function toBoxes (cells) {
  const used = new Set()
  const boxes = []

  const keys = [...cells.keys()].sort((a, b) => {
    const [ax, ay, az] = parseKey(a)
    const [bx, by, bz] = parseKey(b)
    return ay - by || az - bz || ax - bx
  })

  for (const start of keys) {
    if (used.has(start)) continue
    const [x0, y0, z0] = parseKey(start)
    const name = cells.get(start)

    const free = (x, y, z) => {
      const k = key(x, y, z)
      return !used.has(k) && cells.get(k) === name
    }
    const rowFree = (y, z) => {
      for (let x = x0; x <= x1; x++) if (!free(x, y, z)) return false
      return true
    }
    const layerFree = y => {
      for (let z = z0; z <= z1; z++) if (!rowFree(y, z)) return false
      return true
    }

    let x1 = x0
    while (free(x1 + 1, y0, z0)) x1++

    let z1 = z0
    while (rowFree(y0, z1 + 1)) z1++

    let y1 = y0
    while (layerFree(y1 + 1)) y1++

    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) used.add(key(x, y, z))
      }
    }

    boxes.push({ min: new Vec3(x0, y0, z0), max: new Vec3(x1, y1, z1), name })
  }

  return boxes
}

function boxCells (box) {
  const out = []
  for (let x = box.min.x; x <= box.max.x; x++) {
    for (let y = box.min.y; y <= box.max.y; y++) {
      for (let z = box.min.z; z <= box.max.z; z++) out.push(key(x, y, z))
    }
  }
  return out
}

// Did any cell of this box actually become what the fill asked for? One landed
// cell is enough - it proves the command ran, which is the only question.
function anyLanded (bot, cells, want) {
  return cells.some(k => {
    const [x, y, z] = parseKey(k)
    const now = bot.blockAt(new Vec3(x, y, z))
    // blockAt reports the id only, so a spec carrying a state has to be
    // compared by its base name or every stair would read back as a failure.
    return Boolean(now) && now.name === baseName(want(k))
  })
}

function fillCommand (box) {
  const { min, max, name } = box
  return `/fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} minecraft:${name} replace`
}

// Teleport by coordinates and wait for the world to arrive. Without the wait,
// bot.blockAt() answers from a world the bot has not received yet - every cell
// reads as null, every "previous" lands in the undo log as unknown, and the
// fill goes out against chunks the server has not sent us.
async function teleportTo (bot, pos) {
  bot.chat(`/tp ${bot.username} ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`)
  await bot.waitForTicks(CMD_SETTLE_TICKS)
  try {
    await bot.waitForChunksToLoad()
  } catch (err) {
    // Best effort - a slow chunk send shows up as failed cells below, which is
    // reported honestly rather than pretended away.
  }
  await bot.waitForTicks(CMD_SETTLE_TICKS)
}

// Teleport to a named player. Coordinates aren't an option here: a player
// outside the bot's view distance has no loaded entity, so bot.players[name]
// .entity is null and there is nothing to read a position from. /tp by name is
// resolved server-side and works at any distance.
async function teleportToPlayer (bot, username) {
  bot.chat(`/tp ${bot.username} ${username}`)
  await bot.waitForTicks(CMD_SETTLE_TICKS)
  try {
    await bot.waitForChunksToLoad()
  } catch (err) { /* see teleportTo */ }
  await bot.waitForTicks(CMD_SETTLE_TICKS)
  return bot.entity.position.clone()
}

// Is this position close enough to the requester that resuming there makes
// sense? A saved origin from an interrupted build used to hijack every later
// build forever, which is how a "!make a small stone house" ended up being
// built 280 blocks from the player who asked for it, out of sight, looking for
// all the world like the bot was doing nothing at all.
function nearEnough (a, b) {
  return Boolean(a) && Boolean(b) && a.distanceTo(b) <= RESUME_RADIUS
}

// ---------------------------------------------------------------------------
// The fill build.
//
// Returns stats in the same shape the survival placer returns, or null to mean
// "commands aren't available here, fall back to walking". The availability test
// is the first fill itself: send it, read the block back, and see whether the
// world changed. That is stronger than parsing chat for a permission error and
// it costs nothing - a bot that IS op has just done real work.
// ---------------------------------------------------------------------------
async function fillStructure (bot, origin, blocks, opts = {}) {
  const { label = 'structure', onProgress, shouldCancel } = opts
  const stats = { placed: 0, skipped: 0, failed: 0, missing: new Set(), mode: 'command' }

  // Last write wins, matching the survival placer: an LLM plan that puts a
  // glass dome through a stone ceiling names some coordinates twice.
  const cells = new Map()
  for (const { pos, name } of blocks) {
    const t = origin.plus(pos)
    cells.set(key(t.x, t.y, t.z), name)
  }

  // Anything already correct is skipped rather than refilled, so a re-run over
  // an existing build reports honestly instead of claiming to rebuild it.
  const todo = new Map()
  const previous = new Map()
  let unknownWorld = 0
  for (const [k, name] of cells) {
    const [x, y, z] = parseKey(k)
    const here = bot.blockAt(new Vec3(x, y, z))
    if (!here) { unknownWorld++; previous.set(k, 'unknown') } else previous.set(k, here.name)
    if (here && here.name === baseName(name)) { stats.skipped++; continue }
    todo.set(k, name)
  }

  if (unknownWorld) {
    console.error(`[fill] ${unknownWorld} target cells have no world data - chunks may not be loaded`)
  }
  if (!todo.size) return stats

  const boxes = toBoxes(todo)
  const totalCells = todo.size
  console.log(`[fill] ${label}: ${totalCells} blocks as ${boxes.length} fill command${boxes.length === 1 ? '' : 's'}`)

  const buildId = session.startBuild(label)

  // One write at the end rather than one per 25 blocks - see session.js.
  session.setBuffering(true)

  try {
    // ONE command first, and wait for it. If this bot is not op the fill does
    // nothing and - crucially - one message is far too few to trip the spam
    // counter, so the fallback costs a wasted 300ms instead of a kick.
    bot.chat(fillCommand(boxes[0]))
    await bot.waitForTicks(CMD_SETTLE_TICKS)

    if (!anyLanded(bot, boxCells(boxes[0]), k => todo.get(k))) {
      console.error('[fill] probe fill changed nothing - not op, or chunks unloaded. Falling back to survival placement.')
      session.updateLastBuild([])
      return null
    }

    // Op confirmed, so the rest can go out in one burst. Waiting for each
    // command in turn is what a first draft does and it gives the entire win
    // back: a radius-6 sphere is 114 fills, and at one 300ms settle apiece
    // that is 34 seconds to do work the server finishes in a single tick.
    for (let i = 1; i < boxes.length; i++) {
      if (shouldCancel && shouldCancel()) { stats.cancelled = true; break }
      bot.chat(fillCommand(boxes[i]))
    }

    // Block updates for a big burst arrive over several ticks. Verify, then
    // give anything still unconfirmed another look rather than calling it
    // failed - a slow packet and a rejected command look identical for the
    // first few ticks and only one of them is a problem.
    let pending = [...todo.keys()]
    for (let round = 0; round < VERIFY_ROUNDS && pending.length; round++) {
      await bot.waitForTicks(CMD_SETTLE_TICKS)
      const stillWrong = []
      for (const k of pending) {
        const [x, y, z] = parseKey(k)
        const want = todo.get(k)
        const now = bot.blockAt(new Vec3(x, y, z))
        if (now && now.name === baseName(want)) {
          stats.placed++
          session.recordPlacement(buildId, new Vec3(x, y, z), want, previous.get(k) || 'unknown')
        } else {
          stillWrong.push(k)
        }
      }
      pending = stillWrong
    }

    for (const k of pending) {
      const [x, y, z] = parseKey(k)
      stats.failed++
      const now = bot.blockAt(new Vec3(x, y, z))
      if (stats.failed <= 3) console.error(`[fill] ${todo.get(k)} @ (${x}, ${y}, ${z}): world still shows ${now ? now.name : 'no data'}`)
    }

    console.log(`[fill] ${label}: ${stats.placed} placed, ${stats.failed} failed, ${stats.skipped} already correct`)
    if (onProgress) onProgress(totalCells, totalCells)
  } finally {
    session.setBuffering(false)
    session.flush()
  }

  return stats
}

// ---------------------------------------------------------------------------
// Command-mode undo.
//
// Digging every block back out is what made undo take as long as the build.
// With commands the rollback is the same greedy boxing in reverse, and it can
// do something the digging undo never could: put back what the build
// overwrote. `previous` was always recorded - it just had no way to be used.
// ---------------------------------------------------------------------------
async function restore (bot, entries, opts = {}) {
  const { shouldCancel } = opts
  const stats = { removed: 0, changed: 0, failed: 0, restored: 0, destroyed: new Set(), mode: 'command' }

  const cells = new Map()
  const undone = []

  for (const entry of entries) {
    const pos = new Vec3(entry.x, entry.y, entry.z)
    const current = bot.blockAt(pos)

    if (!current) { stats.failed++; continue }
    if (current.name === 'air' && entry.placed !== 'air') {
      // already gone - nothing to roll back, but it leaves the log
      undone.push(entry)
      stats.removed++
      continue
    }
    if (current.name !== entry.placed) {
      // changed by someone else since - leave it exactly alone
      stats.changed++
      undone.push(entry)
      continue
    }

    const back = (!entry.previous || entry.previous === 'unknown') ? 'air' : entry.previous
    cells.set(key(entry.x, entry.y, entry.z), back)
    if (back !== 'air') stats.restored++
    undone.push(entry)
  }

  if (cells.size) {
    const boxes = toBoxes(cells)
    console.log(`[fill] undo: ${cells.size} blocks as ${boxes.length} fill command${boxes.length === 1 ? '' : 's'}`)
    // Probe first, exactly as fillStructure does, and for the same reason: a
    // non-op bot that bursts 114 rollback commands gets kicked for spam.
    bot.chat(fillCommand(boxes[0]))
    await bot.waitForTicks(CMD_SETTLE_TICKS)
    if (!anyLanded(bot, boxCells(boxes[0]), k => cells.get(k))) {
      console.error('[fill] probe fill changed nothing - not op, or chunks unloaded.')
      return null
    }

    for (let i = 1; i < boxes.length; i++) {
      if (shouldCancel && shouldCancel()) { stats.cancelled = true; break }
      bot.chat(fillCommand(boxes[i]))
    }
    await bot.waitForTicks(CMD_SETTLE_TICKS * VERIFY_ROUNDS)

    // Count what actually reverted, and hand back anything that did not so a
    // second !undo can retry exactly those.
    const stuck = []
    for (const entry of undone) {
      const pos = new Vec3(entry.x, entry.y, entry.z)
      const now = bot.blockAt(pos)
      if (now && now.name === baseName(entry.placed)) {
        stats.failed++
        stats.removed--
        stuck.push(entry)
      }
    }
    // Same honest availability test as fillStructure: if not one cell reverted,
    // the fills did nothing and this bot cannot roll back by command.
    if (stuck.length === cells.size) {
      console.error('[fill] undo fills changed nothing - not op, or chunks unloaded.')
      return null
    }
    stats.removed += cells.size - stuck.length
    stats.stuck = stuck
  }

  return stats
}

module.exports = { fillStructure, restore, toBoxes, boxCells, fillCommand, teleportTo, teleportToPlayer, nearEnough }
