'use strict'

// The inspector, against a stub world. It is the only component that asks the
// server what is actually there, so what matters is that it reports the gap
// honestly: a fill that never landed, a doorway that got sealed, a staircase
// with something on top of it.

const { Vec3 } = require('vec3')
const inspector = require('../src/pipeline/inspector')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

// A stub bot whose world is a map we control, so we can make the world differ
// from the plan in exactly one way at a time.
function stubBot (world) {
  return {
    waitForTicks: async () => {},
    chat: () => {},
    blockAt: pos => {
      const stored = world.get(`${pos.x},${pos.y},${pos.z}`)
      if (stored === undefined) return { name: 'air', boundingBox: 'empty' }
      // A real bot.blockAt().name is the block id with no state suffix; a stub
      // that returns the state makes every stated block look like a mismatch.
      const name = stored.split('[')[0]
      return { name, boundingBox: name === 'air' ? 'empty' : 'block' }
    }
  }
}

// A little walled box with a doorway, and a stair inside.
function makePlan () {
  const blocks = []
  for (let x = 0; x < 7; x++) {
    for (let z = 0; z < 7; z++) {
      for (let y = 0; y < 5; y++) {
        const edge = x === 0 || x === 6 || z === 0 || z === 6
        blocks.push({ pos: new Vec3(x, y, z), name: y === 0 || edge ? 'stone_bricks' : 'air' })
      }
    }
  }
  // Doorway through the north wall at y 1-2.
  for (const y of [1, 2]) blocks.push({ pos: new Vec3(3, y, 0), name: 'air' })
  // Three treads with clearance.
  for (let i = 0; i < 3; i++) {
    blocks.push({ pos: new Vec3(2 + i, 1 + i, 2), name: 'stone_brick_stairs[facing=east,half=bottom]' })
  }
  return blocks
}

const plan = makePlan()
const worldFrom = blocks => {
  const w = new Map()
  for (const b of blocks) w.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name)
  return w
}

;(async () => {
  // --- a world that matches the plan ---------------------------------------
  const planTreads = plan.filter(b => /_stairs\[/.test(b.name)).map(b => ({ x: b.pos.x, y: b.pos.y, z: b.pos.z }))
  const perfect = await inspector.inspect(stubBot(worldFrom(plan)), new Vec3(0, 0, 0), plan, { treads: planTreads })
  check('inspector: a matching world passes', perfect.pass, inspector.summarise(perfect))
  // The plan has duplicate coordinates by construction (the doorway is carved
  // out of a wall), and the inspector dedupes by cell as it must.
  const distinct = new Set(plan.map(b => `${b.pos.x},${b.pos.y},${b.pos.z}`)).size
  check('inspector: counts every distinct planned cell', perfect.checked === distinct,
    `${perfect.checked} vs ${distinct}`)
  check('inspector: finds the doorway', perfect.openings > 0, `${perfect.openings}`)
  check('inspector: finds the treads clear', perfect.stairs.treads === 3 && perfect.stairs.blocked === 0)

  // --- a fill that never landed --------------------------------------------
  // Pick cells the plan says are WALL - deleting air that was already air
  // proves nothing.
  const gappy = worldFrom(plan)
  for (const key of ['0,3,3', '6,3,3', '3,3,6']) gappy.set(key, 'air')
  const missing = await inspector.inspect(stubBot(gappy), new Vec3(0, 0, 0), plan)
  check('inspector: reports blocks that never landed', missing.missing >= 1 && !missing.pass,
    inspector.summarise(missing))
  check('inspector: names where they are missing',
    missing.samples.missing.length > 0 && Number.isFinite(missing.samples.missing[0].x))

  // --- the wrong block ------------------------------------------------------
  const wrongWorld = worldFrom(plan)
  wrongWorld.set('0,2,3', 'dirt')
  const wrong = await inspector.inspect(stubBot(wrongWorld), new Vec3(0, 0, 0), plan)
  check('inspector: reports the wrong block, not just a missing one',
    wrong.wrong === 1 && wrong.missing === 0, inspector.summarise(wrong))

  // --- a sealed doorway -----------------------------------------------------
  const sealed = worldFrom(plan)
  sealed.set('3,1,0', 'stone_bricks')
  sealed.set('3,2,0', 'stone_bricks')
  const noWay = await inspector.inspect(stubBot(sealed), new Vec3(0, 0, 0), plan)
  check('inspector: a sealed doorway fails the inspection', !noWay.pass)

  // --- a blocked staircase --------------------------------------------------
  const blocked = worldFrom(plan)
  blocked.set('3,3,2', 'stone_bricks') // directly over the second tread
  const stuck = await inspector.inspect(stubBot(blocked), new Vec3(0, 0, 0), plan, { treads: planTreads })
  check('inspector: reports a tread with something on top of it',
    stuck.stairs.blocked >= 1 && !stuck.pass, JSON.stringify(stuck.stairs))
  check('inspector: says which tread', stuck.stairs.where.length > 0)

  // --- volatile blocks are not build failures -------------------------------
  const flowed = worldFrom(plan.concat([{ pos: new Vec3(3, 1, 3), name: 'water' }]))
  flowed.set('3,1,3', 'air')
  const settled = await inspector.inspect(stubBot(flowed), new Vec3(0, 0, 0),
    plan.concat([{ pos: new Vec3(3, 1, 3), name: 'water' }]))
  check('inspector: water that flowed away is reported separately, not as missing',
    settled.volatile === 1 && settled.missing === 0, inspector.summarise(settled))

  // --- repair ----------------------------------------------------------------
  const commander = {
    toBoxes: cells => [...cells.entries()].map(([k, name]) => {
      const [x, y, z] = k.split(',').map(Number)
      return { min: { x, y, z }, max: { x, y, z }, name }
    }),
    fillCommand: box => `/fill ${box.min.x} ${box.min.y} ${box.min.z} ${box.max.x} ${box.max.y} ${box.max.z} ${box.name}`
  }
  const healed = worldFrom(plan)
  for (const key of ['0,3,3', '6,3,3']) healed.set(key, 'air')
  const bot = stubBot(healed)
  const before = await inspector.inspect(bot, new Vec3(0, 0, 0), plan)
  // The stub applies nothing, so repair should report the cells as unfixed
  // rather than claiming success.
  const attempt = await inspector.repair(bot, before, plan, commander)
  check('inspector: repair reports honestly when nothing changed',
    attempt.fixed === 0 && attempt.remaining > 0, JSON.stringify(attempt))

  // A roof is made of stairs too, and every course of one has the next course
  // on top. Counting those as staircase treads reported 637 of 903 blocked on a
  // keep whose stairs were fine. A tread is a stair the PLAN gave headroom to.
  const roofy = []
  for (let i = 0; i < 5; i++) {
    // A gable slope: each stair carries the one above it.
    roofy.push({ pos: new Vec3(10 + i, 10 + i, 10), name: 'stone_brick_stairs[facing=east,half=bottom]' })
  }
  // ...and one genuine tread, with planned air above it.
  roofy.push({ pos: new Vec3(20, 5, 20), name: 'stone_brick_stairs[facing=east,half=bottom]' })
  roofy.push({ pos: new Vec3(20, 6, 20), name: 'air' })
  roofy.push({ pos: new Vec3(20, 7, 20), name: 'air' })

  // Provenance, not shape: the renderer says which cells came from a stairs op.
  const roofReport = await inspector.inspect(stubBot(worldFrom(roofy)), new Vec3(0, 0, 0), roofy,
    { treads: [{ x: 20, y: 5, z: 20 }] })
  check('inspector: only cells the renderer calls treads are audited',
    roofReport.stairs.treads === 1, `${roofReport.stairs.treads} treads counted`)
  check('inspector: and the real tread is clear', roofReport.stairs.blocked === 0)
  const noTreads = await inspector.inspect(stubBot(worldFrom(roofy)), new Vec3(0, 0, 0), roofy)
  check('inspector: with no tread list, no stairs are claimed',
    noTreads.stairs.treads === 0)

  console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
