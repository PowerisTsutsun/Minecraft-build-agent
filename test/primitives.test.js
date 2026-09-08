'use strict'

// Offline checks for the pure parts - shape generators and plan validation.
// No server, no API key, no network: `npm test` inside the container.

const assert = require('assert')
const primitives = require('../src/building/primitives')
const llm = require('../src/commands/llm')

let passed = 0
function check (name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

console.log('primitives:')

check('floor is width*depth blocks, all at y=0', () => {
  const b = primitives.floor({ width: 5, depth: 4, material: 'stone' })
  assert.strictEqual(b.length, 20)
  assert.ok(b.every(x => x.pos.y === 0))
  assert.ok(b.every(x => x.name === 'stone'))
})

check('floor is ordered outside-in (corner before centre)', () => {
  const b = primitives.floor({ width: 5, depth: 5, material: 'stone' })
  const centreIndex = b.findIndex(x => x.pos.x === 2 && x.pos.z === 2)
  assert.strictEqual(centreIndex, b.length - 1, 'centre block should be placed last')
})

check('wall runs along the requested axis', () => {
  const x = primitives.wall({ length: 6, height: 3, material: 'stone', axis: 'x' })
  assert.strictEqual(x.length, 18)
  assert.ok(x.every(b => b.pos.z === 0))

  const z = primitives.wall({ length: 6, height: 3, material: 'stone', axis: 'z' })
  assert.ok(z.every(b => b.pos.x === 0))
})

check('wall is ordered bottom-up', () => {
  const b = primitives.wall({ length: 4, height: 3, material: 'stone' })
  for (let i = 1; i < b.length; i++) {
    assert.ok(b[i].pos.y >= b[i - 1].pos.y, 'y must never decrease')
  }
})

check('hollow box is a shell, solid box is filled', () => {
  const solid = primitives.box({ width: 4, depth: 4, height: 4, material: 'stone', hollow: false })
  assert.strictEqual(solid.length, 64)

  const hollow = primitives.box({ width: 4, depth: 4, height: 4, material: 'stone', hollow: true })
  // 64 minus the 2x2x2 interior of a 4x4x4 shell
  assert.strictEqual(hollow.length, 64 - 8)
})

check('hollow box has no interior blocks on middle layers', () => {
  const b = primitives.box({ width: 5, depth: 5, height: 5, material: 'stone', hollow: true })
  const interior = b.filter(x => x.pos.y === 2 && x.pos.x === 2 && x.pos.z === 2)
  assert.strictEqual(interior.length, 0)
})

check('sphere fits inside its bounding box and is non-negative', () => {
  const b = primitives.sphere({ radius: 4, material: 'glass' })
  assert.ok(b.length > 0)
  for (const { pos } of b) {
    assert.ok(pos.x >= 0 && pos.y >= 0 && pos.z >= 0, `negative coord ${pos}`)
    assert.ok(pos.x <= 8 && pos.y <= 8 && pos.z <= 8, `out of bounds ${pos}`)
  }
})

check('hollow sphere has fewer blocks than solid', () => {
  const hollow = primitives.sphere({ radius: 5, material: 'glass', hollow: true })
  const solid = primitives.sphere({ radius: 5, material: 'glass', hollow: false })
  assert.ok(hollow.length < solid.length, `${hollow.length} should be < ${solid.length}`)
})

check('hollow sphere shell has no diagonal gaps', () => {
  // Every solid voxel that has a neighbour outside the sphere must be present
  // in the shell - that is the property the 6-neighbour test guarantees.
  const r = 5
  const shell = new Set(primitives.sphere({ radius: r, material: 'glass', hollow: true })
    .map(b => `${b.pos.x},${b.pos.y},${b.pos.z}`))
  // Use the primitive's OWN definition of inside, not a copy of it. This test
  // hardcoded `<= r * r` and started failing the moment circles were widened to
  // `<= (r + 0.5)^2` to match the conventional Minecraft circle widths - cells
  // it believed were exposed had become genuinely interior. The property being
  // checked is still right; the definition has to come from one place.
  const limit = primitives.circleLimit(r)
  const inside = (x, y, z) => (x * x + y * y + z * z) <= limit

  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (!inside(dx, dy, dz)) continue
        const exposed = !inside(dx + 1, dy, dz) || !inside(dx - 1, dy, dz) ||
          !inside(dx, dy + 1, dz) || !inside(dx, dy - 1, dz) ||
          !inside(dx, dy, dz + 1) || !inside(dx, dy, dz - 1)
        if (exposed) {
          assert.ok(shell.has(`${dx + r},${dy + r},${dz + r}`), `missing shell block at ${dx},${dy},${dz}`)
        }
      }
    }
  }
})

check('house has a doorway gap in the front wall', () => {
  const w = 7; const d = 6; const h = 4
  const b = primitives.house({ width: w, depth: d, height: h, wallBlock: 'oak_planks', floorBlock: 'oak_planks', roofBlock: 'oak_planks' })
  const doorX = Math.floor(w / 2)
  const doorBlocks = b.filter(x => x.pos.x === doorX && x.pos.z === 0 && x.pos.y >= 1 && x.pos.y <= 2)
  assert.strictEqual(doorBlocks.length, 0, 'doorway should be empty')
})

check('house floor and roof are both full slabs', () => {
  const b = primitives.house({ width: 5, depth: 5, height: 3, wallBlock: 'stone', floorBlock: 'stone', roofBlock: 'stone' })
  assert.strictEqual(b.filter(x => x.pos.y === 0).length, 25)
  assert.strictEqual(b.filter(x => x.pos.y === 4).length, 25)
})

console.log('plan validation:')

const knownBlocks = new Set(['stone', 'oak_planks', 'glass'])
const isKnown = name => knownBlocks.has(name)

check('accepts a well-formed plan', () => {
  const out = llm.validatePlan({
    summary: 'a stone box',
    actions: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, width: 5, depth: 5, height: 4 }]
  }, isKnown)
  assert.strictEqual(out.errors.length, 0)
  assert.strictEqual(out.actions.length, 1)
  assert.strictEqual(out.actions[0].hollow, true, 'hollow should default true')
})

check('rejects an unknown block', () => {
  const out = llm.validatePlan({
    summary: 'x',
    actions: [{ op: 'box', material: 'unobtainium', offset: { x: 0, y: 0, z: 0 }, width: 3, depth: 3, height: 3 }]
  }, isKnown)
  assert.ok(out.errors.length > 0)
  assert.ok(/unobtainium/.test(out.errors[0]))
})

check('rejects an unknown op', () => {
  // 'pyramid' used to stand in for "unknown" here - it is a real op now, so
  // this needs a name the validator genuinely does not know.
  const out = llm.validatePlan({
    summary: 'x',
    actions: [{ op: 'fractal', material: 'stone', offset: { x: 0, y: 0, z: 0 }, width: 3, depth: 3, height: 3 }]
  }, isKnown)
  assert.ok(out.errors.length > 0)
})

check('rejects oversized dimensions', () => {
  const out = llm.validatePlan({
    summary: 'x',
    actions: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, width: 999, depth: 5, height: 5 }]
  }, isKnown)
  assert.ok(out.errors.length > 0)
  assert.ok(/exceeds/.test(out.errors[0]))
})

check('rejects a missing dimension instead of guessing one', () => {
  const out = llm.validatePlan({
    summary: 'x',
    actions: [{ op: 'sphere', material: 'glass', offset: { x: 0, y: 0, z: 0 } }]
  }, isKnown)
  assert.ok(out.errors.length > 0)
})

check('planToBlocks applies each action offset', () => {
  const plan = llm.validatePlan({
    summary: 'two floors stacked',
    actions: [
      { op: 'floor', material: 'stone', offset: { x: 0, y: 0, z: 0 }, width: 3, depth: 3 },
      { op: 'floor', material: 'stone', offset: { x: 0, y: 5, z: 0 }, width: 3, depth: 3 }
    ]
  }, isKnown)
  const blocks = llm.planToBlocks(plan, primitives)
  assert.strictEqual(blocks.length, 18)
  assert.strictEqual(blocks.filter(b => b.pos.y === 5).length, 9)
})

check('planToBlocks refuses a plan over the block cap', () => {
  const plan = llm.validatePlan({
    summary: 'huge',
    // Distinct offsets on purpose: identical actions are deduplicated by
    // validatePlan (a shape re-emitted after a carve seals it), so ten copies
    // of one box collapse to a single box and stop testing the cap at all.
    // 20 solid 32-cubes is 655k blocks - over the cap whatever MC_MAX_BLOCKS
    // is set to in compose (500k as of 2026-09-06, up from the 150k default).
    actions: Array.from({ length: 20 }, (_, i) => ({
      op: 'box', material: 'stone', offset: { x: i * 40, y: 0, z: 0 }, width: 32, depth: 32, height: 32, hollow: false
    }))
  }, isKnown)
  assert.throws(() => llm.planToBlocks(plan, primitives), /cap/)
})

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`)
