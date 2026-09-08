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

// /fill refuses anything over 32768 blocks. toBoxes is greedy and a big solid
// schematic can hand it a slab of planks well past that, which the server
// answers with "too many blocks" and the whole box reads back as failed.
const ATTACHABLE = /^(torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|redstone_wire|comparator|repeater|lever|.*_button|.*_pressure_plate|tripwire|tripwire_hook|rail|powered_rail|detector_rail|activator_rail|.*_sign|.*_banner|.*_carpet|moss_carpet|ladder|vine|.*_vines|bell|lantern|soul_lantern|.*_chain|iron_chain|.*_hanging_sign|item_frame|painting|snow|.*_candle|candle|flower_pot|potted_.*|.*_door|.*_trapdoor|.*_fence_gate|scaffolding|lily_pad|.*_coral_fan|.*_coral_wall_fan|sea_pickle|bamboo|sugar_cane|cactus|.*_sapling|short_grass|tall_grass|fern|large_fern|dead_bush|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|pink_petals|small_dripleaf|big_dripleaf|.*_mushroom|cave_vines.*|glow_lichen|sculk_vein|pointed_dripstone|amethyst_cluster|.*_amethyst_bud|redstone_lamp|lightning_rod|end_rod|.*_head|.*_skull|bubble_column|water|lava|kelp.*|seagrass|tall_seagrass)$/
const FILL_MAX = 32768
function splitBox (box) {
  const dx = box.max.x - box.min.x + 1
  const dy = box.max.y - box.min.y + 1
  const dz = box.max.z - box.min.z + 1
  if (dx * dy * dz <= FILL_MAX) return [box]
  // Cut along the longest axis and recurse.
  const axis = dx >= dy && dx >= dz ? 'x' : (dy >= dz ? 'y' : 'z')
  const mid = Math.floor((box.min[axis] + box.max[axis]) / 2)
  const a = { ...box, min: box.min.clone(), max: box.max.clone() }
  const b = { ...box, min: box.min.clone(), max: box.max.clone() }
  a.max[axis] = mid
  b.min[axis] = mid + 1
  return [...splitBox(a), ...splitBox(b)]
}

// Block until the client actually holds world data for a spread of the target
// cells (or we give up). Sampling beats checking all of them: a few dozen
// cells spread across the footprint prove the chunks arrived, and cost
// nothing next to reading 300k.
const WORLD_WAIT_MAX_TICKS = 400
async function waitForWorld (bot, keys, samples = 40) {
  if (!keys.length) return true
  const step = Math.max(1, Math.floor(keys.length / samples))
  const probe = []
  for (let i = 0; i < keys.length; i += step) probe.push(parseKey(keys[i]))

  for (let waited = 0; waited < WORLD_WAIT_MAX_TICKS; waited += 10) {
    const missing = probe.filter(([x, y, z]) => !bot.blockAt(new Vec3(x, y, z))).length
    if (!missing) return true
    await bot.waitForTicks(10)
  }
  const missing = probe.filter(([x, y, z]) => !bot.blockAt(new Vec3(x, y, z))).length
  console.error(`[fill] gave up waiting for world data - ${missing}/${probe.length} sample cells still empty`)
  return false
}

// The order fills are sent in. Everything is /fill, so this is the only lever
// we have over what exists when: a block placed into a cell that is not ready
// for it either pops off or gets pushed around, and nothing reports it.
//
//   0 inert solids      the shell and everything that can hold a state
//   1 mechanisms        pistons, droppers, hoppers, observers - solids that ACT
//   2 attachables       torches, rails, dust, plants - need a face to sit on
//   3 power             redstone_block, levers, buttons, plates - things that
//                       would fire a mechanism placed after them
//   4 liquids           water and lava, placed last so they cannot flow into a
//                       cell before the block that belongs there arrives. A
//                       sorter placed with water in the same phase as its dust
//                       lost the dropper circuit to a sheet of water at y62 -
//                       three cells, silently, and the whole deposit path died.
//   5 portals           nether_portal needs its obsidian frame standing first;
//                       277,499 of them vanished the one time it did not.
//
// Order within a phase is stable (the caller sorts on the original index).
const MECHANISM = /^(piston|sticky_piston|moving_piston|observer|dispenser|dropper|crafter|hopper|note_block|tnt|redstone_lamp|target|jukebox|bell)$/
const POWER = /^(redstone_block|lever|.*_button|.*_pressure_plate|redstone_torch|redstone_wall_torch|daylight_detector|sculk_sensor|calibrated_sculk_sensor|lightning_rod|tripwire_hook)$/
const LIQUID = /^(water|lava|bubble_column)$/

function phaseOf (name) {
  const base = baseName(name)
  if (base === 'nether_portal') return 5
  if (LIQUID.test(base)) return 4
  if (POWER.test(base)) return 3
  if (ATTACHABLE.test(base)) return 2
  if (MECHANISM.test(base)) return 1
  return 0
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
// Chunk residency.
//
// /fill does nothing at all in an unloaded chunk - measured at 300 commands
// sent, 192 landed, no error either way. Teleporting the bot to the site covers
// a building; it does not cover a build wider than the server's view distance,
// which is now reachable with a 96-block size limit.
//
// forceload is the guarantee. It is also server state that outlives this
// process, so it is removed in a finally AND swept at startup: a crash between
// add and remove would otherwise pin chunks loaded forever and quietly tax the
// server for the rest of its life.
// ---------------------------------------------------------------------------
const FORCELOAD_CHUNK_LIMIT = 256

function boundsOf (keys) {
  const lo = { x: Infinity, z: Infinity }
  const hi = { x: -Infinity, z: -Infinity }
  for (const k of keys) {
    const [x, , z] = parseKey(k)
    if (x < lo.x) lo.x = x
    if (x > hi.x) hi.x = x
    if (z < lo.z) lo.z = z
    if (z > hi.z) hi.z = z
  }
  return { lo, hi }
}

async function forceloadAdd (bot, keys) {
  if (!keys.length) return null
  const { lo, hi } = boundsOf(keys)
  const chunks = (Math.floor(hi.x / 16) - Math.floor(lo.x / 16) + 1) *
    (Math.floor(hi.z / 16) - Math.floor(lo.z / 16) + 1)
  if (chunks > FORCELOAD_CHUNK_LIMIT) {
    console.error(`[fill] build spans ${chunks} chunks, over the ${FORCELOAD_CHUNK_LIMIT} forceload limit - relying on the teleport instead`)
    return null
  }
  const region = { lo, hi }
  bot.chat(`/forceload add ${lo.x} ${lo.z} ${hi.x} ${hi.z}`)
  await bot.waitForTicks(CMD_SETTLE_TICKS)
  try { await bot.waitForChunksToLoad() } catch (err) { /* best effort */ }
  await bot.waitForTicks(CMD_SETTLE_TICKS)
  console.log(`[fill] forceloaded ${chunks} chunk${chunks === 1 ? '' : 's'}`)
  return region
}

function forceloadRemove (bot, region) {
  if (!region) return
  bot.chat(`/forceload remove ${region.lo.x} ${region.lo.z} ${region.hi.x} ${region.hi.z}`)
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

  // Force-load the whole footprint and WAIT for the chunks to actually reach
  // this client BEFORE reading a single cell. The scan below and the probe
  // both use bot.blockAt, which answers null for a chunk the client has not
  // received - and a teleport only buys ~300ms. Rebuilding the gold farm from
  // across the map, 120,423 of 306,397 cells read as "no world data", the
  // probe fill could not be verified, and a working command build fell back to
  // walking (2026-09-06). Loading first costs a second and removes the whole
  // class of failure.
  const region = await forceloadAdd(bot, [...cells.keys()])
  await waitForWorld(bot, [...cells.keys()])

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
  if (!todo.size) { forceloadRemove(bot, region); return stats }

  // Placement order matters for two kinds of block. Anything that needs a
  // support or a frame gets removed by the server the instant it is placed
  // without one - and /fill runs its neighbour updates immediately, so a
  // torch, comparator or portal block set before the block it sits on is
  // simply gone. toBoxes already goes bottom-up, which covers most support
  // cases, but not same-layer ones (comparator beside its wall) and not
  // portals, whose obsidian frame is finished several layers ABOVE them: the
  // gold farm (27169) lost 277,499 of 306,399 blocks that way on 2026-09-06.
  // So: solid blocks first, attachables second, portals last.
  // Ordering lives in phaseOf() above - one definition for every fill path.
  const phase = phaseOf
  const boxes = toBoxes(todo).flatMap(splitBox)
    .map((b, i) => ({ b, i, p: phase(b.name) }))
    .sort((u, v) => u.p - v.p || u.i - v.i)
    .map(o => o.b)
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
    //
    // ...up to a point. A 320k-block schematic is 68,000 fill commands, and
    // shoving those down the socket in one synchronous loop starves the
    // client's own keepalive replies: the server dropped BuilderBot with a
    // keepalive timeout two minutes in (2026-09-06) and the build died with
    // it. So: bursts of BURST commands, then yield a couple of ticks so the
    // keepalive - and the server - get a word in. Small builds never notice.
    const BURST = 100
    const BURST_PAUSE_TICKS = 2
    for (let i = 1; i < boxes.length; i++) {
      if (shouldCancel && shouldCancel()) { stats.cancelled = true; break }
      bot.chat(fillCommand(boxes[i]))
      if (i % BURST === 0) {
        await bot.waitForTicks(BURST_PAUSE_TICKS)
        if (onProgress && i % (BURST * 100) === 0) onProgress(Math.round(totalCells * i / boxes.length), totalCells)
      }
    }

    // Block updates for a big burst arrive over several ticks. Verify, then
    // give anything still unconfirmed another look rather than calling it
    // failed - a slow packet and a rejected command look identical for the
    // first few ticks and only one of them is a problem.
    //
    // How long "several ticks" is scales with the burst. 820 fill commands
    // covering 300k cells produce a flood of block-change packets, and a fixed
    // settle read the client's stale world: the gold farm reported 240,786 of
    // 306,397 blocks FAILED while the server had placed essentially all of
    // them (2026-09-06). Wait proportionally before believing the world.
    const settleTicks = Math.min(600, CMD_SETTLE_TICKS * VERIFY_ROUNDS + Math.floor(boxes.length / 4))
    if (settleTicks > CMD_SETTLE_TICKS * VERIFY_ROUNDS) {
      await bot.waitForTicks(settleTicks - CMD_SETTLE_TICKS * VERIFY_ROUNDS)
    }
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

    // One re-issue for anything still unconfirmed. A fill that did not land is
    // usually a chunk that was not ready yet rather than a command the server
    // refused, and the second attempt costs a handful of commands.
    if (pending.length) {
      console.log(`[fill] re-issuing ${pending.length} unconfirmed block${pending.length === 1 ? '' : 's'}`)
      const retryCells = new Map(pending.map(k => [k, todo.get(k)]))
      for (const box of toBoxes(retryCells)) bot.chat(fillCommand(box))
      await bot.waitForTicks(CMD_SETTLE_TICKS * 2)

      const stillWrong = []
      for (const k of pending) {
        const [x, y, z] = parseKey(k)
        const now = bot.blockAt(new Vec3(x, y, z))
        if (now && now.name === baseName(todo.get(k))) {
          stats.placed++
          session.recordPlacement(buildId, new Vec3(x, y, z), todo.get(k), previous.get(k) || 'unknown')
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
    forceloadRemove(bot, region)
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
  const toFill = []

  for (const entry of entries) {
    const pos = new Vec3(entry.x, entry.y, entry.z)
    const current = bot.blockAt(pos)

    // What we placed here, compared the only way that works: by base name.
    // The undo log stores the full spec ("cherry_stairs[facing=north,...]")
    // while blockAt reports the plain id, so comparing the two raw strings
    // made EVERY stateful block look like someone else's later edit. Undo
    // then skipped it as "changed since" and left it standing - which is why
    // rolling a schematic back used to leave most of it in the world.
    const want = baseName(entry.placed)

    if (!current) { stats.failed++; continue }
    if (current.name === 'air' && want !== 'air') {
      // already gone - nothing to roll back, but it leaves the log
      stats.removed++
      continue
    }
    if (current.name !== want) {
      // changed by someone else since - leave it exactly alone
      stats.changed++
      continue
    }

    const back = (!entry.previous || entry.previous === 'unknown') ? 'air' : entry.previous
    cells.set(key(entry.x, entry.y, entry.z), back)
    toFill.push(entry)
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

    // Bursts with a breather, for the keepalive reason in fillStructure: a
    // big rollback is as many commands as the build was.
    const BURST = 100
    const BURST_PAUSE_TICKS = 2
    for (let i = 1; i < boxes.length; i++) {
      if (shouldCancel && shouldCancel()) { stats.cancelled = true; break }
      bot.chat(fillCommand(boxes[i]))
      if (i % BURST === 0) {
        await bot.waitForTicks(BURST_PAUSE_TICKS)
      }
    }
    await bot.waitForTicks(CMD_SETTLE_TICKS * VERIFY_ROUNDS)

    // Count what actually reverted, and hand back anything that did not so a
    // second pass can retry exactly those.
    const stuck = []
    for (const entry of toFill) {
      const pos = new Vec3(entry.x, entry.y, entry.z)
      const now = bot.blockAt(pos)
      if (now && now.name === baseName(entry.placed)) {
        stats.failed++
        stuck.push(entry)
        continue
      }
      stats.removed++
      const back = cells.get(key(entry.x, entry.y, entry.z))
      if (back && back !== 'air') stats.restored++
    }
    // Same honest availability test as fillStructure: if not one cell reverted,
    // the fills did nothing and this bot cannot roll back by command.
    if (stuck.length === toFill.length) {
      console.error('[fill] undo fills changed nothing - not op, or chunks unloaded.')
      return null
    }
    stats.stuck = stuck
  }

  return stats
}

module.exports = {
  phaseOf, MECHANISM, POWER, LIQUID, fillStructure, restore, toBoxes, splitBox, ATTACHABLE, FILL_MAX, boxCells, fillCommand, forceloadAdd, forceloadRemove, teleportTo, teleportToPlayer, nearEnough }
