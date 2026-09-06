'use strict'

// Reads the staircase back out of the WORLD and checks it is climbable.
//
// The generator having the right properties is necessary but not sufficient:
// what matters is what /fill actually left standing, after every later action
// in the plan had its turn to overwrite it.

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const O = new Vec3(
  parseInt(process.env.SCAN_X || '1164', 10),
  parseInt(process.env.SCAN_Y || '-60', 10),
  parseInt(process.env.SCAN_Z || '1196', 10))
const TOP = parseInt(process.env.SCAN_TOP || '24', 10)
const WIDE = parseInt(process.env.SCAN_W || '11', 10) // a castle footprint is not a tower's

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'Scanner',
  version: process.env.MC_VERSION || '26.1'
})

const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

bot.once('spawn', async () => {
  await bot.waitForTicks(80)
  await bot.waitForChunksToLoad().catch(() => {})
  await bot.waitForTicks(60)

  const byLevel = new Map()
  for (let dy = 0; dy <= TOP; dy++) {
    for (let dx = 0; dx <= WIDE; dx++) {
      for (let dz = 0; dz <= WIDE; dz++) {
        const b = bot.blockAt(O.offset(dx, dy, dz))
        if (!b || !b.name.includes('stairs')) continue
        let props = {}
        try { props = b.getProperties() } catch (err) {}
        if (!byLevel.has(dy)) byLevel.set(dy, [])
        byLevel.get(dy).push({ dx, dz, facing: props.facing, half: props.half })
      }
    }
  }

  // TRACE the staircase rather than collecting every stairs block. Ornament
  // uses stairs too - an eaves ring is a dozen of them on one level, with the
  // roof sitting directly on top, which is correct and which an audit that
  // just gathers stairs per level reports as a dozen blocked treads.
  //
  // The staircase is the one thing that steps: from each tread, exactly one
  // stair one level up and one orthogonal move away. Follow that chain.
  const ys = [...byLevel.keys()].sort((a, b) => a - b)
  const adjacent = (a, b) => Math.abs(a.dx - b.dx) + Math.abs(a.dz - b.dz) === 1

  let best = []
  for (const y0 of ys) {
    for (const seed of byLevel.get(y0)) {
      const chain = [{ y: y0, ...seed }]
      for (let y = y0 + 1; ; y++) {
        const candidates = (byLevel.get(y) || []).filter(c => adjacent(c, chain[chain.length - 1]))
        if (candidates.length !== 1) break
        chain.push({ y, ...candidates[0] })
      }
      if (chain.length > best.length) best = chain
    }
  }

  const run = best.map(c => c.y)
  const treadAt = new Map(best.map(c => [c.y, c]))

  let stacked = 0
  let diagonal = 0
  let headroom = 0
  let facingBad = 0
  const facings = new Map()

  for (const y of run) {
    const c = treadAt.get(y)
    const up = treadAt.get(y + 1)
    facings.set(c.facing, (facings.get(c.facing) || 0) + 1)

    for (const dy of [1, 2]) {
      const above = bot.blockAt(O.offset(c.dx, y + dy, c.dz))
      if (above && above.boundingBox === 'block') {
        headroom++
        if (headroom <= 5) console.log(`  blocked: tread (${c.dx},${y},${c.dz}) has ${above.name} ${dy} above`)
      }
    }

    if (!up) continue
    if (up.dx === c.dx && up.dz === c.dz) stacked++
    if (!adjacent(c, up)) diagonal++
    const [fx, fz] = DIRS[up.facing] || [0, 0]
    if (up.dx - c.dx !== fx || up.dz - c.dz !== fz) facingBad++
  }

  console.log(`staircase spans levels ${run[0]}..${run[run.length - 1]} (${run.length} treads)`)
  console.log(`  facings in world: ${[...facings].map(([f, n]) => `${f} x${n}`).join(', ')}`)
  console.log(`  stairs stacked directly on each other: ${stacked}`)
  console.log(`  treads with a solid block in their clearance: ${headroom}`)
  console.log(`  levels with no orthogonal step up:        ${diagonal}`)
  console.log(`  treads facing the wrong way:              ${facingBad}`)
  console.log(stacked + headroom + diagonal + facingBad === 0 ? '\nCLIMBABLE' : '\nPROBLEMS FOUND')
  bot.quit()
})
