'use strict'

// The decorator pass: surface detection and the three habits that run on it.
//
// Definition of done for this step is visual, so these check the geometry that
// produces the look: a cornice ring that closes at the corners, a band at each
// floor line, and a frame/sill/lintel on every opening - without ever filling
// the opening it is decorating.

const primitives = require('../src/building/primitives')
const { validatePlan, renderPlan } = require('../src/commands/llm')
const surfaces = require('../src/building/surfaces')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const KNOWN = /^(stone_bricks|stone_brick_stairs|stone_brick_slab|polished_andesite|polished_andesite_stairs|polished_andesite_slab|cobblestone|dark_oak_planks|dark_oak_stairs|dark_oak_slab|glass_pane|air|oak_planks)(\[.*\])?$/
const known = n => KNOWN.test(n)

function build (plan) {
  const v = validatePlan(plan, known)
  if (v.errors.length) return { errors: v.errors, blocks: [], warnings: [] }
  return renderPlan(v, primitives, { isKnownBlock: known })
}

// A plain hollow tower with a window carved through one wall.
const tower = {
  summary: 'tower',
  decor: { style: 'medieval_stone' },
  shell: [
    { op: 'cylinder', material: 'stone_bricks', offset: { x: 10, y: 0, z: 10 }, anchor: 'center', radius: 4, height: 12, hollow: true },
    // A disc, not a square: a square slab inside a round tower pokes out at the
    // corners, and those corners are then real exposed wall tops that correctly
    // get their own cornice. Corbels on several courses are legitimate on a
    // stepped building - the fixture just should not be accidentally stepped.
    { op: 'cylinder', material: 'stone_bricks', offset: { x: 10, y: 6, z: 10 }, anchor: 'center', radius: 4, height: 1, hollow: false }
  ],
  carves: [
    { op: 'cylinder', material: 'air', offset: { x: 10, y: 1, z: 10 }, anchor: 'center', radius: 3, height: 5, hollow: false },
    { op: 'cylinder', material: 'air', offset: { x: 10, y: 7, z: 10 }, anchor: 'center', radius: 3, height: 5, hollow: false },
    { op: 'box', material: 'air', offset: { x: 10, y: 3, z: 6 }, anchor: 'center', width: 2, depth: 3, height: 2, hollow: false }
  ]
}

const decorated = build(tower)
const plain = build({ ...tower, decor: { style: 'plain' } })

check('decorator: a style adds blocks, plain adds none',
  decorated.blocks.length > plain.blocks.length && decorated.errors.length === 0,
  `${decorated.blocks.length} vs ${plain.blocks.length} | ${decorated.errors[0] || ''}`)

const applied = decorated.decor || {}
check('decorator: reports what each habit did',
  applied.corbel_edges > 0 && applied.window_frames > 0,
  JSON.stringify(applied))

// corbel_edges
const corbels = decorated.blocks.filter(b => /polished_andesite_stairs\[half=top/.test(b.name))
check('corbels: a cornice ring appears at the wall top', corbels.length >= 12, `${corbels.length}`)
check('corbels: they sit outside the wall, not in it',
  corbels.every(c => !plain.blocks.some(p => p.pos.x === c.pos.x && p.pos.y === c.pos.y && p.pos.z === c.pos.z)))
check('corbels: every one faces outward',
  corbels.every(c => /facing=(north|south|east|west)/.test(c.name)))
const corbelY = new Set(corbels.map(c => c.pos.y))
check('corbels: one course, at the top of the tower', corbelY.size === 1 && corbelY.has(11), [...corbelY].join(','))

// string_courses
const band = decorated.blocks.filter(b => b.name === 'polished_andesite' && b.pos.y === 6)
check('string course: a band of trim at the floor line', band.length >= 8, `${band.length} at y=6`)

// window_frames
const sills = decorated.blocks.filter(b => /polished_andesite_stairs\[half=bottom/.test(b.name))
const lintels = decorated.blocks.filter(b => /polished_andesite_slab/.test(b.name))
check('window: a sill stands proud below the opening', sills.length >= 1, `${sills.length}`)
check('window: a lintel above it', lintels.length >= 1, `${lintels.length}`)

// The habit must never close the hole it is decorating.
const openingCells = plain.blocks.filter(b => b.name === 'air' && b.pos.y >= 3 && b.pos.y <= 4 && b.pos.z <= 7)
const stillOpen = openingCells.every(o =>
  decorated.blocks.some(b => b.pos.x === o.pos.x && b.pos.y === o.pos.y && b.pos.z === o.pos.z && b.name === 'air'))
check('window: the opening is still open after framing', stillOpen && openingCells.length > 0,
  `${openingCells.length} opening cells`)

// skip
const skipped = build({ ...tower, decor: { style: 'medieval_stone', skip: ['corbel_edges'] } })
check('decorator: skip turns a habit off',
  skipped.blocks.filter(b => /stairs\[half=top/.test(b.name)).length === 0)

// surface detection itself
const cells = new Map()
for (const b of plain.blocks) cells.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, { name: b.name, pos: b.pos })
const view = surfaces.analyse(cells, new Map())
check('surfaces: finds exterior faces', view.exteriorFaces.length > 0, `${view.exteriorFaces.length}`)
check('surfaces: wall tops are found once per column',
  view.topEdges.length > 0 && view.topEdges.every(t => t.normals.length > 0), `${view.topEdges.length}`)
check('surfaces: an interior face is not called exterior',
  view.exteriorFaces.every(f => f.pos.y >= view.minY))
check('surfaces: the floor slab is detected as a floor line',
  view.floorLines.includes(6), view.floorLines.join(','))

// A sloped roof is a column top at every one of its courses. The first cut of
// corbel_edges dressed all of them - 524 corbels on a two-building plan, a
// fifth of the whole structure - which is the difference between a cornice and
// a rash. Only the lowest course of a slope is an eave.
const roofed = build({
  summary: 'hall with a gable',
  decor: { style: 'medieval_stone' },
  shell: [
    { op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 11, depth: 9, height: 8, hollow: true },
    { op: 'gable', material: 'stone_bricks', offset: { x: -1, y: 8, z: -1 }, anchor: 'corner', width: 13, depth: 11, axis: 'x' }
  ],
  carves: [{ op: 'box', material: 'air', offset: { x: 1, y: 1, z: 1 }, anchor: 'corner', width: 9, depth: 7, height: 7, hollow: false }]
})
const roofCorbels = roofed.blocks.filter(b => /_stairs\[half=top/.test(b.name))
const courses = [...new Set(roofCorbels.map(b => b.pos.y))].sort((a, b) => a - b)
check('corbels: a gable roof gets an eaves course, not one per step',
  courses.length <= 2, `courses at y ${courses.join(',')}`)
check('corbels: the eaves course is the lowest course of the roof',
  courses.includes(8), `courses ${courses.join(',')}`)
check('corbels: they stay a small fraction of the build',
  roofCorbels.length < roofed.blocks.length * 0.1,
  `${roofCorbels.length} of ${roofed.blocks.length}`)

// A tall mass beside a low one still gets its cornice - a drop of one is a
// slope, a drop of several is a neighbouring wing.
const stepped = build({
  summary: 'tower beside a low wing',
  decor: { style: 'medieval_stone' },
  shell: [
    { op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5, height: 14, hollow: true },
    { op: 'box', material: 'stone_bricks', offset: { x: 5, y: 0, z: 0 }, anchor: 'corner', width: 7, depth: 5, height: 5, hollow: true }
  ]
})
const steppedCourses = [...new Set(stepped.blocks.filter(b => /_stairs\[half=top/.test(b.name)).map(b => b.pos.y))].sort((a, b) => a - b)
check('corbels: both a tall mass and its low neighbour get a cornice',
  steppedCourses.includes(13) && steppedCourses.includes(4), steppedCourses.join(','))

// An overhanging roof must not hide the walls under it. "Outside" was first
// defined as a clear sightline to the sky, which a one-block roof overhang
// breaks completely: every facade read as interior, no window was ever found
// and the walls went undressed. Outside is a region you can reach, not a view.
const overhung = build({
  summary: 'overhanging roof',
  decor: { style: 'medieval_stone' },
  shell: [
    { op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 8, hollow: true },
    { op: 'gable', material: 'stone_bricks', offset: { x: -1, y: 8, z: -1 }, anchor: 'corner', width: 11, depth: 11, axis: 'x' }
  ],
  carves: [
    { op: 'box', material: 'air', offset: { x: 1, y: 1, z: 1 }, anchor: 'corner', width: 7, depth: 7, height: 7, hollow: false },
    { op: 'box', material: 'air', offset: { x: 3, y: 3, z: 0 }, anchor: 'corner', width: 2, depth: 1, height: 3, hollow: false }
  ]
})
const cellsO = new Map()
for (const b of overhung.blocks) cellsO.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, { name: b.name, pos: b.pos })
const carvedO = new Map()
for (const b of overhung.blocks) if (b.name === 'air') carvedO.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, 0)
const viewO = surfaces.analyse(cellsO, carvedO)
check('surfaces: walls under an overhanging roof are still outside',
  viewO.exteriorFaces.some(f => f.pos.y < 8), `${viewO.exteriorFaces.length} faces`)
check('surfaces: a window under an overhang is still found',
  viewO.openings.length >= 1, `${viewO.openings.length} openings`)
check('surfaces: the room interior is not mistaken for a window',
  viewO.openings.every(o => o.width <= 8 && o.height <= 8),
  viewO.openings.map(o => `${o.width}x${o.height}`).join(' '))
check('decorator: the overhung build gets framed windows',
  (overhung.decor || {}).window_frames > 0, JSON.stringify(overhung.decor))

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
