'use strict'

const { Vec3 } = require('vec3')
const { baseName } = require('../building/blockspec')
const { toBoxes, splitBox, fillCommand } = require('../building/commander')
const { isValidSpec } = require('../building/blockspec')

// ---------------------------------------------------------------------------
// Building over RCON.
//
// Same pipeline as the mineflayer path - greedy boxes, split to the /fill cap,
// solids before attachables before portals - but the transport is a console
// socket, so it works on any server version and needs no bot in the world.
//
// Two things get BETTER by dropping the player client:
//   - /fill answers with the number of blocks it actually changed, server-side
//     truth. The mineflayer path had to read its own lagging copy of the world
//     and wrongly called 240,786 placed blocks failures.
//   - There is no chat spam limit and no keepalive to starve, so no bursting
//     and no pauses.
// What gets worse: there is no bulk world read. Every query is one command, so
// the already-correct scan is gone and verification is sampled instead.
// ---------------------------------------------------------------------------

// Vanilla refuses a /forceload add covering more than 256 chunks. commander.js
// holds the same constant for the mineflayer path; they must not drift.
const FORCELOAD_CHUNK_LIMIT = 256

// Fill phases live in commander.js so the rcon path and the mineflayer path
// cannot drift apart on what has to exist before what.
const { phaseOf } = require('../building/commander')

function boundsOf (cellKeys) {
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const k of cellKeys) {
    const [x, y, z] = k.split(',').map(Number)
    lo.x = Math.min(lo.x, x); hi.x = Math.max(hi.x, x)
    lo.y = Math.min(lo.y, y); hi.y = Math.max(hi.y, y)
    lo.z = Math.min(lo.z, z); hi.z = Math.max(hi.z, z)
  }
  return { lo, hi }
}

// /forceload takes at most 256 chunks per call, so a big footprint is added in
// strips. Returns the strips so they can be released again.
async function forceload (rcon, bounds, add = true) {
  const c0 = { x: Math.floor(bounds.lo.x / 16), z: Math.floor(bounds.lo.z / 16) }
  const c1 = { x: Math.floor(bounds.hi.x / 16), z: Math.floor(bounds.hi.z / 16) }
  // A footprint wider than the limit cannot be covered by a full-width strip at
  // all: `floor(256 / width)` clamps to 1 row and still emits width chunks, so
  // every call was refused. Tile in both axes instead.
  const width = c1.x - c0.x + 1
  const cols = Math.min(width, FORCELOAD_CHUNK_LIMIT)
  const rows = Math.max(1, Math.floor(FORCELOAD_CHUNK_LIMIT / cols))
  const strips = []
  for (let x = c0.x; x <= c1.x; x += cols) {
    const x1 = Math.min(c1.x, x + cols - 1)
    for (let z = c0.z; z <= c1.z; z += rows) {
      const z1 = Math.min(c1.z, z + rows - 1)
      strips.push([x * 16, z * 16, x1 * 16 + 15, z1 * 16 + 15])
    }
  }
  for (const [x0, z0, x1, z1] of strips) {
    await rcon.send(`forceload ${add ? 'add' : 'remove'} ${x0} ${z0} ${x1} ${z1}`)
  }
  return strips
}

const FILLED = /([0-9]+) block/

async function fillBlocks (rcon, origin, blocks, opts = {}) {
  const { label = 'structure', onProgress, dryRun = false } = opts

  // blockspec.js:16-22 says a material string "ends up inside a slash command
  // the bot sends to the server, so it is untrusted input on a command line",
  // and test/shapes.test.js asserts that `stone] ; /op someone` is rejected -
  // but isValidSpec was only ever wired into the retired mineflayer path. Block
  // names here come out of third-party .schem files downloaded from the
  // internet, which is the project's stated workflow, so gate them here too.
  const rejected = []
  const cells = new Map()
  for (const { pos, name } of blocks) {
    if (!isValidSpec(name)) { rejected.push(name); continue }
    const t = origin.plus(pos)
    cells.set(`${t.x},${t.y},${t.z}`, name)
  }
  if (rejected.length) {
    const kinds = [...new Set(rejected)].slice(0, 5).join(', ')
    console.error(`[build] dropped ${rejected.length} cell(s) whose block spec failed validation: ${kinds}`)
  }
  // An empty map made boundsOf return Infinity, which became `forceload add
  // Infinity ...` and a journal entry whose bounds serialise to null.
  if (!cells.size) {
    return { cells: 0, boxes: 0, changed: 0, errors: 0, rejected: rejected.length, bounds: null, firstErrors: [], boxList: [] }
  }
  const bounds = boundsOf(cells.keys())

  const boxes = toBoxes(cells).flatMap(splitBox)
    .map((b, i) => ({ b, i, p: phaseOf(b.name) }))
    .sort((u, v) => u.p - v.p || u.i - v.i)
    .map(o => o.b)

  const stats = { cells: cells.size, rejected: rejected.length, boxes: boxes.length, changed: 0, errors: 0, bounds, firstErrors: [], boxList: boxes }
  if (dryRun) return stats

  await forceload(rcon, bounds, true)
  try {
    for (let i = 0; i < boxes.length; i++) {
      const out = await rcon.send(fillCommand(boxes[i]))
      const m = FILLED.exec(out)
      if (m) stats.changed += Number(m[1])
      else if (!/No blocks were filled/.test(out)) {
        stats.errors++
        if (stats.firstErrors.length < 5) stats.firstErrors.push(`${fillCommand(boxes[i]).slice(0, 70)} -> ${out.trim().slice(0, 90)}`)
      }
      if (onProgress && i % 100 === 99) onProgress(i + 1, boxes.length)
    }
  } finally {
    await forceload(rcon, bounds, false)
  }
  return stats
}

// Properties the SERVER derives and will happily disagree with us about: leaf
// distance recomputed from the nearest log, grass snowy-ness from the block
// above, fence/wall/pane connections from neighbours, redstone power, stair
// and rail shape. Asking /fill for `oak_leaves[distance=1]` and then finding
// distance=2 is not a failed placement, it is the game doing its job - so a
// mismatch is re-checked with these stripped and reported separately instead
// of being called an error.
// `enabled` is a hopper's lock, driven by redstone the moment it lands. A
// comparator-locked sorter has hundreds of them; compare it literally and a
// working machine reads as hundreds of failures.
const COMPUTED = /^(distance|snowy|north|south|east|west|up|down|power|powered|enabled|shape|in_wall|lit|occupied|triggered|crafting|signal_fire|hanging|attached|disarmed|extended|conditional|age|moisture|stage|leaves|tilt|bites|eggs|hatch|charges)$/
// Deliberately NOT stripped, though they used to be: delay (repeater timing),
// note/instrument (noteblock), inverted (daylight detector), level (cauldron)
// and has_bottle_*. Those are set by /fill and the server does not recompute
// them, so stripping them let verifySample pass a repeater placed at the wrong
// tick delay - for a project whose headline builds are sorters and farms, the
// exact class of defect verification most needs to catch.

function stripComputed (spec) {
  const i = spec.indexOf('[')
  if (i === -1) return spec
  const base = spec.slice(0, i)
  const kept = spec.slice(i + 1, -1).split(',').filter(p => !COMPUTED.test(p.split('=')[0]))
  return kept.length ? `${base}[${kept.join(',')}]` : base
}

// Confirm a random spread of cells really holds what we asked for - including
// block state, which /fill's own count cannot tell us. Cheap: an rcon round
// trip is well under a millisecond.
async function verifySample (rcon, origin, blocks, sample = 1500) {
  const step = Math.max(1, Math.floor(blocks.length / sample))
  const checked = []
  for (let i = 0; i < blocks.length; i += step) checked.push(blocks[i])
  let ok = 0
  let computed = 0
  const bad = []
  for (const b of checked) {
    const t = origin.plus(b.pos)
    const out = await rcon.send(`execute if block ${t.x} ${t.y} ${t.z} minecraft:${b.name}`)
    if (/passed/i.test(out)) { ok++; continue }
    const loose = stripComputed(b.name)
    if (loose !== b.name) {
      const out2 = await rcon.send(`execute if block ${t.x} ${t.y} ${t.z} minecraft:${loose}`)
      if (/passed/i.test(out2)) { computed++; continue }
    }
    if (bad.length < 8) bad.push(`${t.x},${t.y},${t.z} want ${b.name}`)
  }
  return { checked: checked.length, ok, computed, mismatched: checked.length - ok - computed, examples: bad }
}

module.exports = { fillBlocks, verifySample, forceload, boundsOf, phaseOf }
