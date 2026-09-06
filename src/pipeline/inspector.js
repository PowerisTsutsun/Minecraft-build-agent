'use strict'

const { Vec3 } = require('vec3')
const { baseName } = require('../building/blockspec')

// ---------------------------------------------------------------------------
// The inspector.
//
// Everything upstream reasons about a cell map. This is the only thing that
// asks the SERVER what is actually there, after the fill commands have landed,
// and diffs it against what was planned.
//
// That gap is real and has bitten repeatedly: /fill silently places nothing in
// an unloaded chunk, blocks that need support are deleted the instant they are
// set, and fluids flow away from where they were put. All three report success.
//
// The diff runs on the building bot rather than a second connection: it needs
// no movement, the chunks are already loaded because the bot just built there,
// and a second login is a second thing to go wrong. Reachability - can a player
// get to the door and up the stairs - is a separate question and is checked
// structurally here rather than by walking, because walking needs a bot that
// wanders and this one has a job.
// ---------------------------------------------------------------------------

const SETTLE_TICKS = 8

// Blocks the server is entitled to change out from under us. A torch that had
// its support removed, water that flowed, a sapling that grew: reporting these
// as build failures would drown the real ones.
const VOLATILE = /water|lava|torch|lantern|vine|leaves|sapling|fire|snow|button|pressure_plate/

async function inspect (bot, origin, blocks, opts = {}) {
  const treadCells = opts.treads || null
  const expected = new Map()
  for (const b of blocks) {
    const p = b.pos
    expected.set(`${p.x},${p.y},${p.z}`, baseName(b.name))
  }

  await bot.waitForTicks(SETTLE_TICKS)

  const missing = []
  const wrong = []
  const volatile = []
  let checked = 0
  let matched = 0

  for (const [key, want] of expected) {
    const [x, y, z] = key.split(',').map(Number)
    const here = bot.blockAt(new Vec3(x, y, z))
    checked++

    if (!here) {
      missing.push({ x, y, z, want, got: 'no data' })
      continue
    }
    if (here.name === want) { matched++; continue }

    const entry = { x, y, z, want, got: here.name }
    if (VOLATILE.test(want) || VOLATILE.test(here.name)) volatile.push(entry)
    else if (here.name === 'air') missing.push(entry)
    else wrong.push(entry)
  }

  // Reachability, structurally: is there a way in, and does every staircase
  // still have unobstructed headroom?
  const openings = countGroundOpenings(bot, origin, blocks)
  const stairs = auditStairs(bot, blocks, treadCells)

  const report = {
    checked,
    matched,
    missing: missing.length,
    wrong: wrong.length,
    volatile: volatile.length,
    openings,
    stairs,
    samples: {
      missing: missing.slice(0, 8),
      wrong: wrong.slice(0, 8),
      volatile: volatile.slice(0, 4)
    },
    pass: missing.length === 0 && wrong.length === 0 && openings > 0 && stairs.blocked === 0
  }
  report.detail = missing.concat(wrong)
  return report
}

// A doorway is a player-sized gap through a wall near the ground.
//
// "Near the ground" cannot be the lowest solid block: a plinth with a course
// below grade puts that two levels under the floor, and a tower with a
// perfectly good south door was reported as having no way in because the search
// band sat in the foundations. The band is the bottom of the build plus a
// storey, which covers a doorway wherever the plinth happens to start.
const GROUND_BAND = 6

function countGroundOpenings (bot, origin, blocks) {
  let lowest = Infinity
  for (const b of blocks) if (baseName(b.name) !== 'air') lowest = Math.min(lowest, b.pos.y)
  if (!Number.isFinite(lowest)) return 0

  let found = 0
  const seen = new Set()
  for (const b of blocks) {
    if (baseName(b.name) !== 'air') continue
    if (b.pos.y < lowest || b.pos.y > lowest + GROUND_BAND) continue
    const key = `${b.pos.x},${b.pos.z},${b.pos.y}`
    if (seen.has(key)) continue

    const here = bot.blockAt(b.pos)
    const above = bot.blockAt(b.pos.offset(0, 1, 0))
    const floor = bot.blockAt(b.pos.offset(0, -1, 0))
    // Two clear blocks to stand in, something to stand on, and a wall beside
    // it - otherwise this is open sky next to the building, not a way through.
    if (!here || here.name !== 'air') continue
    if (!above || above.name !== 'air') continue
    if (!floor || floor.boundingBox !== 'block') continue
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
      const n = bot.blockAt(b.pos.offset(dx, 0, dz))
      return n && n.boundingBox === 'block'
    })
    if (!beside) continue

    seen.add(key)
    found++
  }
  return found
}

// Only cells the renderer says came from a stairs or spiral op count as treads.
//
// A roof is made of stairs facing a direction too, and a gable's slope steps
// diagonally so the cell above each course is empty - indistinguishable from a
// tread by any geometric test. Counting every stair block reported 637 of 903
// "blocked" on a keep whose staircases were fine. Provenance is the only honest
// answer, so the renderer hands the tread list over.
function auditStairs (bot, blocks, treadCells) {
  if (!treadCells || !treadCells.length) return { treads: 0, blocked: 0, where: [] }

  let blocked = 0
  const where = []
  for (const t of treadCells) {
    for (const dy of [1, 2]) {
      const above = bot.blockAt(new Vec3(t.x, t.y + dy, t.z))
      if (above && above.boundingBox === 'block') {
        blocked++
        if (where.length < 4) where.push({ x: t.x, y: t.y, z: t.z, by: above.name })
        break
      }
    }
  }
  return { treads: treadCells.length, blocked, where }
}

// ---------------------------------------------------------------------------
// Repair.
//
// A missing or wrong cell is re-filled from the plan we already have - no model
// call, because nothing about the design is in question. Only the cells that
// differ, so a repair after a 12,000-block castle is a handful of commands.
// ---------------------------------------------------------------------------
async function repair (bot, report, blocks, commander) {
  if (!report.detail.length) return { fixed: 0, remaining: 0 }

  const byKey = new Map()
  for (const b of blocks) byKey.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name)

  const cells = new Map()
  for (const entry of report.detail) {
    const key = `${entry.x},${entry.y},${entry.z}`
    const want = byKey.get(key)
    if (want) cells.set(key, want)
  }
  if (!cells.size) return { fixed: 0, remaining: report.detail.length }

  for (const box of commander.toBoxes(cells)) bot.chat(commander.fillCommand(box))
  await bot.waitForTicks(SETTLE_TICKS * 2)

  let fixed = 0
  let remaining = 0
  for (const [key, want] of cells) {
    const [x, y, z] = key.split(',').map(Number)
    const here = bot.blockAt(new Vec3(x, y, z))
    if (here && here.name === baseName(want)) fixed++
    else remaining++
  }
  return { fixed, remaining }
}

function summarise (report) {
  const parts = [`${report.matched}/${report.checked} blocks as planned`]
  if (report.missing) parts.push(`${report.missing} missing`)
  if (report.wrong) parts.push(`${report.wrong} wrong`)
  if (report.volatile) parts.push(`${report.volatile} settled differently`)
  parts.push(`${report.openings} way${report.openings === 1 ? '' : 's'} in`)
  if (report.stairs.treads) {
    parts.push(report.stairs.blocked
      ? `${report.stairs.blocked} of ${report.stairs.treads} treads blocked`
      : `${report.stairs.treads} treads clear`)
  }
  return parts.join(', ')
}

module.exports = { inspect, repair, summarise, VOLATILE }
