'use strict'

// Wall-relative openings. The point of these ops is that the model names a face
// and a distance along it rather than working out a coordinate, and that the
// carve stops at the back of the wall - a window that bores straight on into
// the room is how a three-deep window carve once ate four treads off a
// staircase inside a tower.

const primitives = require('../src/building/primitives')
const { validatePlan, renderPlan } = require('../src/commands/llm')
const mcData = require('minecraft-data')('26.1')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}
const real = n => Boolean(mcData.blocksByName[n.split('[')[0]])
const build = plan => {
  const v = validatePlan(plan, real)
  if (v.errors.length) return { errors: v.errors, blocks: [] }
  return renderPlan(v, primitives, { isKnownBlock: real })
}
const at = (blocks, x, y, z) => {
  const b = blocks.find(b => b.pos.x === x && b.pos.y === y && b.pos.z === z)
  return b ? b.name : null
}

// A hall with a one-thick wall, a window in the south face and a door in the north.
const hall = {
  summary: 'openings',
  shell: [{ op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 11, depth: 9, height: 6, hollow: true }],
  carves: [
    { op: 'box', material: 'air', offset: { x: 1, y: 1, z: 1 }, anchor: 'corner', width: 9, depth: 7, height: 5, hollow: false },
    { op: 'window', offset: { x: 0, y: 2, z: 0 }, anchor: 'corner', face: 'south', along: 4, width: 2, height: 3, style: 'arched', frame: 'polished_andesite', footprint: { width: 11, depth: 9 } },
    { op: 'door', offset: { x: 0, y: 1, z: 0 }, anchor: 'corner', face: 'north', along: 5, width: 2, height: 3, arched: true, door_block: 'oak_door', frame: 'polished_andesite', footprint: { width: 11, depth: 9 } }
  ]
}
const out = build(hall)
check('openings: the plan validates', out.errors === undefined || out.errors.length === 0, (out.errors || [])[0])

// The window sits in the south wall (z = depth-1 = 8), found from face+along.
const panes = out.blocks.filter(b => /glass_pane/.test(b.name))
check('window: glazed on the face it named', panes.length > 0 && panes.every(b => b.pos.z === 8),
  panes.map(b => `${b.pos.x},${b.pos.y},${b.pos.z}`).slice(0, 3).join(' '))
check('window: positioned by `along`, not by hand',
  panes.every(b => b.pos.x >= 4 && b.pos.x <= 5), [...new Set(panes.map(b => b.pos.x))].join(','))
check('window: an arched head is narrower than its base',
  new Set(panes.filter(b => b.pos.y === 2).map(b => b.pos.x)).size >=
  new Set(panes.filter(b => b.pos.y === 4).map(b => b.pos.x)).size)
check('window: framed in trim', out.blocks.some(b => b.name === 'polished_andesite'))
check('window: a sill stands proud of the wall',
  out.blocks.some(b => /polished_andesite_stairs/.test(b.name) && b.pos.z === 9),
  'no sill outside the south wall')

// The carve must not reach past the wall into the room. This has to be asked of
// the window's OWN output: in the finished map the room behind it is air
// anyway, because the interior carve put it there.
const oneThick = primitives.window({
  face: 'south', along: 4, width: 2, height: 3, glass: 'glass_pane',
  footprint: { width: 11, depth: 9 }, y: 2,
  isSolid: pos => pos.z === 8 // a single course of wall, nothing behind it
})
const bored = oneThick.filter(b => b.name === 'air' && b.pos.z !== 8)
check('window: carves the wall plane only, not the room behind it',
  bored.length === 0, `${bored.length} cells carved off the wall plane`)

const twoThick = primitives.window({
  face: 'south', along: 4, width: 2, height: 3, glass: 'glass_pane',
  footprint: { width: 11, depth: 9 }, y: 2,
  isSolid: pos => pos.z === 8 || pos.z === 7 // two courses
})
check('window: a two-thick wall gets a two-deep reveal',
  new Set(twoThick.filter(b => b.name === 'air').map(b => b.pos.z)).size === 2,
  [...new Set(twoThick.filter(b => b.name === 'air').map(b => b.pos.z))].join(','))

// Door: real door blocks with computed state, reaching the ground.
const doors = out.blocks.filter(b => /oak_door/.test(b.name))
check('door: two halves per leaf, hinged left and right',
  doors.length === 4 &&
  doors.filter(b => /half=lower/.test(b.name)).length === 2 &&
  new Set(doors.map(b => /hinge=(\w+)/.exec(b.name)[1])).size === 2,
  doors.map(b => b.name).join(' '))
check('door: faces the wall it was cut into',
  doors.every(b => /facing=north/.test(b.name)))
check('door: sits in the north wall at ground level',
  doors.every(b => b.pos.z === 0) && doors.some(b => b.pos.y === 1))

// Everything emitted must be a real block.
const bogus = [...new Set(out.blocks.map(b => b.name).filter(n => !real(n)))]
check('openings: emit only real block ids', bogus.length === 0, bogus.slice(0, 3).join(' '))

// Thickness detection: a two-thick wall gets a two-deep reveal.
const thick = build({
  summary: 'thick wall',
  shell: [{ op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 6, hollow: false }],
  carves: [{ op: 'window', offset: { x: 0, y: 2, z: 0 }, anchor: 'corner', face: 'south', along: 4, width: 1, height: 2, footprint: { width: 9, depth: 9 } }]
})
const holes = thick.blocks.filter(b => b.name === 'air' && b.pos.x === 4 && b.pos.y === 2)
check('window: carves as deep as the wall is, and stops',
  holes.length >= 2 && holes.length <= 4, `${holes.length} cells deep`)

// A mullion leaves a column of wall standing.
const mullioned = primitives.openingShape(3, 4, 'mullion')
check('window: a mullion leaves a divider standing',
  !mullioned.some(c => c.a === 1 && c.level === 0) && mullioned.some(c => c.a === 1 && c.level === 3))

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
