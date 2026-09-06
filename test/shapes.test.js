'use strict'

// Offline checks on the shapes added for non-boxy builds, and on the validator
// that stands between an LLM plan and someone's world.
//
// Shape assertions are deliberately about *silhouette*, not block counts: a
// cone that does not taper and a gable with no ridge are the failures that
// matter, and both would pass a "returns some blocks" test.

const primitives = require('../src/building/primitives')
const { toBoxes } = require('../src/building/commander')
const { validatePlan } = require('../src/commands/llm')
const spec = require('../src/building/blockspec')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const key = b => `${b.pos.x},${b.pos.y},${b.pos.z}`
const levels = blocks => {
  const byY = new Map()
  for (const b of blocks) {
    if (!byY.has(b.pos.y)) byY.set(b.pos.y, [])
    byY.get(b.pos.y).push(b)
  }
  return byY
}

// Every shape must still merge into a disjoint, exact set of fill boxes.
function coverOk (label, blocks) {
  const cells = new Map(blocks.map(b => [key(b), b.name]))
  const boxes = toBoxes(cells)
  let covered = 0
  const seen = new Set()
  for (const box of boxes) {
    for (let x = box.min.x; x <= box.max.x; x++) {
      for (let y = box.min.y; y <= box.max.y; y++) {
        for (let z = box.min.z; z <= box.max.z; z++) {
          const k = `${x},${y},${z}`
          if (seen.has(k) || !cells.has(k) || cells.get(k) !== box.name) return check(`${label}: fill cover`, false, `bad cell ${k}`)
          seen.add(k)
          covered++
        }
      }
    }
  }
  check(`${label}: fill cover exact (${cells.size} cells -> ${boxes.length} fills)`, covered === cells.size)
}

// --- cylinder --------------------------------------------------------------
const cyl = primitives.cylinder({ radius: 5, height: 9, material: 'stone', hollow: true })
coverOk('cylinder', cyl)
const cylLevels = levels(cyl)
check('cylinder: every level identical (it is a prism)',
  new Set([...cylLevels.values()].map(l => l.length)).size === 1)
check('cylinder: hollow leaves a middle to stand in',
  !cyl.some(b => b.pos.x === 5 && b.pos.z === 5))
check('cylinder: is round, not square',
  !cyl.some(b => b.pos.x === 0 && b.pos.z === 0))
const lying = primitives.cylinder({ radius: 3, height: 8, material: 'stone', axis: 'x' })
check('cylinder axis x: runs along x', Math.max(...lying.map(b => b.pos.x)) === 7)

// --- cone ------------------------------------------------------------------
const cone = primitives.cone({ radius: 6, height: 8, material: 'bricks', hollow: true })
coverOk('cone', cone)
const coneWidth = y => {
  const at = cone.filter(b => b.pos.y === y)
  return at.length ? Math.max(...at.map(b => b.pos.x)) - Math.min(...at.map(b => b.pos.x)) : 0
}
check('cone: tapers from base to tip', coneWidth(0) > coneWidth(4) && coneWidth(4) > coneWidth(7),
  `widths ${coneWidth(0)} ${coneWidth(4)} ${coneWidth(7)}`)
check('cone: no gap in the slope - every level has blocks',
  [...Array(8).keys()].every(y => cone.some(b => b.pos.y === y)))

// --- pyramid ---------------------------------------------------------------
const pyr = primitives.pyramid({ width: 15, depth: 15, height: 7, material: 'sandstone', hollow: false })
coverOk('pyramid', pyr)
const pyrWidth = y => {
  const at = pyr.filter(b => b.pos.y === y)
  return Math.max(...at.map(b => b.pos.x)) - Math.min(...at.map(b => b.pos.x))
}
check('pyramid: insets as it rises', pyrWidth(0) === 14 && pyrWidth(6) < pyrWidth(0))

// --- gable -----------------------------------------------------------------
const gab = primitives.gable({ width: 11, depth: 9, material: 'spruce_planks', axis: 'x' })
coverOk('gable', gab)
const gabLevels = levels(gab)
const spans = [...gabLevels.keys()].sort((a, b) => a - b).map(y => new Set(gabLevels.get(y).map(b => b.pos.z)).size)
check('gable: two slopes that converge to a ridge', spans[0] === 2 && spans[spans.length - 1] === 1,
  `z-rows per level: ${spans.join(',')}`)
check('gable: ridge runs the full length along x',
  gabLevels.get(Math.max(...gabLevels.keys())).length === 11)

// --- arch ------------------------------------------------------------------
const arc = primitives.arch({ width: 9, height: 7, depth: 2, material: 'air', axis: 'x' })
coverOk('arch', arc)
const arcLevels = levels(arc)
const arcSpan = y => new Set(arcLevels.get(y).map(b => b.pos.z)).size
check('arch: straight sides then a curved head', arcSpan(0) === 9 && arcSpan(6) < arcSpan(0),
  `spans ${arcSpan(0)} -> ${arcSpan(6)}`)
check('arch: extruded through the wall', new Set(arc.map(b => b.pos.x)).size === 2)

// --- spiral ----------------------------------------------------------------
const spiAll = primitives.spiral({ radius: 4, height: 12, material: 'stone_bricks' })
const spi = spiAll.filter(b => b.name !== 'air')
coverOk('spiral', spiAll)
check('spiral: one tread per level, all 12 present',
  [...Array(12).keys()].every(y => spi.some(b => b.pos.y === y)))
// Sample the OUTERMOST block of each tread: the innermost one sits almost on
// the axis and rounds to the same cell for several levels running, which says
// nothing about whether the stair turns.
const outer = [...levels(spi).entries()].sort((a, b) => a[0] - b[0]).map(([, l]) =>
  l.slice().sort((a, b) =>
    ((b.pos.x - 4) ** 2 + (b.pos.z - 4) ** 2) - ((a.pos.x - 4) ** 2 + (a.pos.z - 4) ** 2))[0])
const angles = outer.map(b => Math.atan2(b.pos.z - 4, b.pos.x - 4))
check('spiral: rotates between treads', angles[0] !== angles[1] && angles[1] !== angles[2])

// The property that decides whether it is a staircase or a pile of confetti:
// each tread has to be reachable by stepping up one block from the last.
const climbable = [...levels(spi).entries()].sort((a, b) => a[0] - b[0])
const stepOk = climbable.slice(1).every(([y, here], i) => {
  const below = climbable[i][1]
  return here.some(h => below.some(b => Math.abs(h.pos.x - b.pos.x) <= 1 && Math.abs(h.pos.z - b.pos.z) <= 1))
})
check('spiral: every tread is one step up from the one below', stepOk)

// --- validator -------------------------------------------------------------
const known = n => ['stone', 'stone_bricks', 'glass', 'air', 'oak_planks', 'bricks', 'stone_brick_stairs'].includes(spec.baseName(n))
const plan = a => validatePlan({ summary: 's', actions: a }, known)

check('validator: accepts a cylinder and defaults it upright',
  plan([{ op: 'cylinder', material: 'stone', offset: { x: 0, y: 0, z: 0 }, radius: 4, height: 9 }]).actions[0].axis === 'y')
check('validator: keeps an explicit horizontal axis',
  plan([{ op: 'cylinder', material: 'stone', offset: { x: 0, y: 0, z: 0 }, radius: 4, height: 9, axis: 'x' }]).actions[0].axis === 'x')
check('validator: keeps arch optional depth',
  plan([{ op: 'arch', material: 'air', offset: { x: 0, y: 0, z: 0 }, width: 5, height: 5, depth: 3 }]).actions[0].depth === 3)
check('validator: air is a legal material (carving)',
  plan([{ op: 'box', material: 'air', offset: { x: 0, y: 0, z: 0 }, width: 3, depth: 3, height: 3 }]).errors.length === 0)
check('validator: rejects an invented block',
  plan([{ op: 'box', material: 'unobtanium', offset: { x: 0, y: 0, z: 0 }, width: 3, depth: 3, height: 3 }]).errors.length > 0)
check('validator: rejects an unknown op',
  plan([{ op: 'fractal', material: 'stone', offset: { x: 0, y: 0, z: 0 } }]).errors.length > 0)
check('validator: blocks op needs no top-level material',
  plan([{ op: 'blocks', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 0, y: 0, z: 0, material: 'glass' }] }]).errors.length === 0)
check('validator: blocks op rejects an unknown cell material',
  plan([{ op: 'blocks', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 0, y: 0, z: 0, material: 'nope' }] }]).errors.length > 0)
check('validator: blocks op rejects a cell far from its offset',
  plan([{ op: 'blocks', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 5000, y: 0, z: 0, material: 'glass' }] }]).errors.length > 0)
check('validator: blocks op caps the cell count',
  plan([{ op: 'blocks', offset: { x: 0, y: 0, z: 0 }, cells: Array.from({ length: 600 }, (_, i) => ({ x: i % 20, y: 0, z: 0, material: 'glass' })) }]).errors.length > 0)
check('validator: still clamps oversized dimensions',
  plan([{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, width: 9999, depth: 3, height: 3 }]).errors.length > 0)



// --- block specs and stair orientation -------------------------------------
// Regression cover for the wizard tower coming out with all 23 staircase
// blocks facing north, and for the injection surface that block states open up.
const { fillCommand } = require('../src/building/commander')
const { Vec3 } = require('vec3')

check('spec: plain id parses', spec.parse('stone_bricks').base === 'stone_bricks')
check('spec: state is split off', spec.parse('oak_log[axis=x]').base === 'oak_log' && spec.hasState('oak_log[axis=x]'))
check('spec: rejects a command-injection attempt', !spec.isValidSpec('stone] ; /op someone'))
check('spec: rejects an unclosed bracket', !spec.isValidSpec('stone['))
check('spec: rejects a malformed pair', !spec.isValidSpec('stone[a=b,c]'))
check('spec: rejects uppercase', !spec.isValidSpec('Stone'))

const stair = primitives.spiral({ radius: 3, height: 20, material: 'stone_brick_stairs' }).filter(b => b.name !== 'air')
const facings = new Set(stair.map(b => /facing=(\w+)/.exec(b.name)[1]))
check('spiral: treads are oriented, not all default north', facings.size >= 3, `facings seen: ${[...facings].join(',')}`)
check('spiral: every tread carries half=bottom', stair.every(b => b.name.includes('half=bottom')))
check('spiral: an explicit state is left alone',
  primitives.spiral({ radius: 2, height: 3, material: 'oak_stairs[facing=west]' })
    .filter(b => b.name !== 'air').every(b => b.name === 'oak_stairs[facing=west]'))
check('spiral: a non-stairs material is untouched',
  primitives.spiral({ radius: 2, height: 3, material: 'stone' })
    .filter(b => b.name !== 'air').every(b => b.name === 'stone'))

// The properties that decide whether this is a staircase or a sculpture. The
// first spiral passed "has blocks at every level" and was still unclimbable:
// consecutive treads landed on the same cells, stacking stairs on top of each
// other with no headroom. These three checks are what that bug had to fail.
const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

function stairAudit (r, h) {
  const blocks = primitives.spiral({ radius: r, height: h, material: 'stone_brick_stairs' })
    .filter(b => b.name !== 'air') // the audit is about treads; clearance is checked separately
  const byY = levels(blocks)
  const at = y => byY.get(y) || []
  const cell = b => `${b.pos.x},${b.pos.z}`
  const out = { stacked: 0, blockedHead: 0, nonOrthogonal: 0, wrongFacing: 0, levels: h }

  for (let y = 0; y < h; y++) {
    const here = at(y)
    const up = at(y + 1)
    if (!here.length) { out.blockedHead++; continue }

    // Nothing may sit directly on top of a tread, for two levels - that is the
    // player's headroom.
    for (const c of here) {
      if (up.some(u => cell(u) === cell(c))) out.stacked++
      if (at(y + 2).some(u => cell(u) === cell(c))) out.blockedHead++
    }

    if (!up.length) continue

    // The step up has to be orthogonal: a diagonal step up cannot be walked.
    const step = here.some(c => up.some(u => Math.abs(u.pos.x - c.pos.x) + Math.abs(u.pos.z - c.pos.z) === 1))
    if (!step) out.nonOrthogonal++

    // The tread you arrive on must face the way you travelled to reach it.
    const facing = /facing=(\w+)/.exec(up[0].name)[1]
    const [fx, fz] = dirs[facing]
    const consistent = here.some(c => up.some(u =>
      u.pos.x - c.pos.x === fx && u.pos.z - c.pos.z === fz))
    if (!consistent) out.wrongFacing++
  }
  return out
}

for (const r of [2, 3, 4, 5, 6, 8, 12]) {
  const a = stairAudit(r, 40)
  check(`spiral r${r}: no tread stacked on the one below`, a.stacked === 0, `${a.stacked} stacked`)
  check(`spiral r${r}: two blocks of headroom over every tread`, a.blockedHead === 0, `${a.blockedHead} blocked`)
  check(`spiral r${r}: every step up is orthogonal`, a.nonOrthogonal === 0, `${a.nonOrthogonal} diagonal-only`)
  check(`spiral r${r}: treads face the way they are climbed`, a.wrongFacing === 0, `${a.wrongFacing} wrong`)
}

// --- a staircase has to own the space above it ----------------------------
// The tower whose stairs were geometrically perfect and still unclimbable: the
// plan laid a solid floor disc across the shaft, which sat directly on top of
// the treads. Checking stairs against stairs passes this; checking the treads
// against the FINISHED build is what catches it.
function collapse (actions) {
  // Same last-wins collapse the fill path does, so this tests what gets built.
  const cells = new Map()
  for (const blocks of actions) {
    for (const b of blocks) cells.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name)
  }
  return cells
}

function passageOk (cells, treadCells) {
  let blocked = 0
  for (const t of treadCells) {
    for (const up of [1, 2]) {
      const name = cells.get(`${t.pos.x},${t.pos.y + up},${t.pos.z}`)
      if (name && name !== 'air') blocked++
    }
  }
  return blocked
}

const stairsOnly = primitives.spiral({ radius: 3, height: 24, material: 'stone_brick_stairs' })
const treadsOnly = stairsOnly.filter(b => b.name !== 'air')
check('spiral: carves two blocks of clearance per tread',
  stairsOnly.filter(b => b.name === 'air').length === treadsOnly.length * 2)
check('spiral: clearance never lands on a tread',
  passageOk(collapse([stairsOnly]), treadsOnly) === 0)

// Floors laid across the shaft at three storeys, then the stairs.
const storeys = [5, 11, 17].map(fy =>
  primitives.floor({ width: 7, depth: 7, material: 'polished_andesite', y: fy }))
const withStorey = collapse([...storeys, stairsOnly])
check('spiral: a floor laid across the shaft does not seal the climb',
  passageOk(withStorey, treadsOnly) === 0, `${passageOk(withStorey, treadsOnly)} treads blocked overhead`)

// And the floors must survive everywhere the stairs do not pass - the stairs
// punch a hole, they do not delete the storey.
const floorCells = [...collapse(storeys).keys()]
const survived = floorCells.filter(k => withStorey.get(k) === 'polished_andesite').length
check('spiral: floors survive except where the stairs pass through',
  survived > floorCells.length * 0.8 && survived < floorCells.length,
  `${survived} of ${floorCells.length} floor cells left`)

// Order matters: the stairs must be emitted after the floor, or the floor wins.
const wrongOrder = collapse([stairsOnly, ...storeys])
check('spiral: emitted BEFORE a floor, the floor does seal it (ordering matters)',
  passageOk(wrongOrder, treadsOnly) > 0)

// --- plan deduplication ----------------------------------------------------
// The missing-door bug: build a wall, carve a door through it, then re-emit the
// identical wall - which seals the door. The repeat must be dropped.
const wall = { op: 'cylinder', material: 'stone', offset: { x: 0, y: 0, z: 0 }, radius: 5, height: 10 }
const doorway = { op: 'arch', material: 'air', offset: { x: 3, y: 0, z: -1 }, width: 3, height: 4, depth: 12 }
const sealed = plan([wall, doorway, { ...wall }])
check('dedupe: a wall re-emitted after the door is carved gets dropped',
  sealed.actions.length === 2 && sealed.dropped === 1, `${sealed.actions.length} actions kept`)
check('dedupe: the doorway survives, and stays last',
  sealed.actions[sealed.actions.length - 1].material === 'air')
check('dedupe: genuinely different shapes are all kept',
  plan([wall, { ...wall, offset: { x: 0, y: 10, z: 0 } }]).actions.length === 2)

// Different states must never be merged into one fill - they are different blocks.
const mixedStates = new Map([
  ['0,0,0', 'oak_stairs[facing=east]'],
  ['1,0,0', 'oak_stairs[facing=west]']
])
check('fills: differing states are not merged', toBoxes(mixedStates).length === 2)
check('fill command carries the state',
  fillCommand({ min: new Vec3(0, 0, 0), max: new Vec3(0, 0, 0), name: 'oak_stairs[facing=east]' })
    .includes('minecraft:oak_stairs[facing=east]'))



// --- the staircase must outlive the rest of the plan -----------------------
// Two real failures, both of which reported every block placed successfully:
// a floor disc laid over the stairs sealed the climb, and window arches carved
// after them deleted four treads.
const stair3 = { op: 'spiral', material: 'stone_brick_stairs', offset: { x: 1, y: 2, z: 1 }, radius: 4, height: 22 }
const window3 = { op: 'arch', material: 'air', offset: { x: 3, y: 8, z: -1 }, width: 3, height: 4, depth: 3 }
const floor3 = { op: 'floor', material: 'stone_bricks', offset: { x: 0, y: 12, z: 0 }, width: 11, depth: 11 }

const ordered = plan([stair3, window3, floor3])
check('order: a spiral is moved after a later air carve',
  ordered.actions[ordered.actions.length - 1].op === 'spiral', ordered.actions.map(a => a.op).join(','))
check('order: a spiral is moved after a later floor',
  ordered.actions.findIndex(a => a.op === 'spiral') > ordered.actions.findIndex(a => a.op === 'floor'))
check('order: the reorder is reported', ordered.reordered === true)
check('order: a plan that already ends with its stairs is left alone',
  plan([floor3, window3, stair3]).reordered === false)
check('order: everything else keeps its relative order',
  plan([floor3, window3, stair3]).actions.map(a => a.op).join(',') === 'floor,arch,spiral')



// --- house style -----------------------------------------------------------
// The teaching path: guide.md and saved examples are appended to the planner's
// system prompt. The risk worth testing is unbounded growth - a prompt that
// silently gets bigger on every saved build costs more on every request.
const style = require('../src/commands/style')
const fs = require('fs')
const path = require('path')

const suffix = style.promptSuffix()
check('style: the guide reaches the prompt', suffix.includes('HOUSE STYLE'))
check('style: an untaught bot adds nothing', typeof suffix === 'string')

const examplePlan = {
  summary: 'a test cottage',
  actions: [{ op: 'house', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, width: 7, depth: 6, height: 4, axis: 'x', hollow: true }]
}
const saved = style.saveExample('zzz-test-example', 'a small cottage', examplePlan)
check('style: !remember writes a readable example', fs.existsSync(saved.file))
check('style: a saved example reaches the prompt',
  style.promptSuffix().includes('WORKED EXAMPLES') && style.promptSuffix().includes('a small cottage'))
check('style: rejects a name that would escape the directory', (() => {
  try { style.saveExample('../../etc/passwd', 'x', examplePlan); return false } catch (err) { return true }
})())
check('style: rejects an empty name', (() => {
  try { style.saveExample('', 'x', examplePlan); return false } catch (err) { return true }
})())

// Only the newest few examples are shown, however many are saved.
const extras = []
for (let i = 0; i < 6; i++) {
  extras.push(`zzz-bulk-${i}`)
  style.saveExample(`zzz-bulk-${i}`, `bulk ${i}`, examplePlan)
}
const many = style.promptSuffix()
const shown = (many.match(/Request: /g) || []).length
check(`style: shows at most ${style.MAX_EXAMPLES} examples however many are saved`,
  shown <= style.MAX_EXAMPLES, `${shown} shown`)
check('style: !style lists everything saved even when not all are used',
  style.describe().examples.length >= 7)

for (const name of ['zzz-test-example', ...extras]) {
  try { style.forgetExample(name) } catch (err) {}
}
check('style: !forget removes an example',
  !fs.existsSync(path.join(style.EXAMPLE_DIR, 'zzz-test-example.json')))



// A blocks action naming one material and listing bare coordinates - the form a
// real castle plan used, and which an earlier schema rejected outright.
const scatter = plan([{ op: 'blocks', material: 'glass', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }] }])
check('blocks: one material for the action, bare coordinates in cells',
  scatter.errors.length === 0 && scatter.actions[0].cells.every(c => c.material === 'glass'),
  JSON.stringify(scatter.errors))
check('blocks: a cell may still override the action material',
  plan([{ op: 'blocks', material: 'glass', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 1, y: 2, z: 3, material: 'stone' }] }]).actions[0].cells[0].material === 'stone')
check('blocks: with no material anywhere it is still rejected',
  plan([{ op: 'blocks', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 1, y: 2, z: 3 }] }]).errors.length > 0)
check('blocks: an unknown shared material is still rejected',
  plan([{ op: 'blocks', material: 'unobtanium', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 1, y: 2, z: 3 }] }]).errors.length > 0)



// --- circle widths and roof stairs -----------------------------------------
// The house style specifies conventional Minecraft circle widths. A bare r^2
// test pinches the cardinal extremes to one block (d5 = 1,3,5,3,1); testing the
// cell's near edge against (r+0.5)^2 reproduces the chart.
function rowWidths (r) {
  const rows = new Map()
  for (const b of primitives.cylinder({ radius: r, height: 1, material: 'stone', hollow: false })) {
    rows.set(b.pos.z, (rows.get(b.pos.z) || 0) + 1)
  }
  return [...rows.keys()].sort((a, b) => a - b).map(k => rows.get(k)).join(',')
}
check('circles: d5 matches the conventional widths', rowWidths(2) === '3,5,5,5,3', rowWidths(2))
check('circles: d7 matches', rowWidths(3) === '3,5,7,7,7,5,3', rowWidths(3))
check('circles: d9 matches', rowWidths(4) === '5,7,9,9,9,9,9,7,5', rowWidths(4))
check('circles: d11 matches', rowWidths(5) === '5,7,9,11,11,11,11,11,9,7,5', rowWidths(5))
check('circles: the bounding box is unchanged',
  Math.max(...primitives.cylinder({ radius: 5, height: 1, material: 'stone', hollow: false }).map(b => b.pos.x)) === 10)

// Roof stairs must climb toward the ridge, or the roof is a sawtooth.
const roofX = primitives.gable({ width: 9, depth: 9, material: 'dark_oak_stairs', axis: 'x' })
const roofFacings = new Set(roofX.map(b => /facing=(\w+)/.exec(b.name)[1]))
check('gable: the two slopes face opposite ways',
  roofFacings.has('south') && roofFacings.has('north') && roofFacings.size === 2,
  [...roofFacings].join(','))
check('gable: near slope climbs toward the ridge',
  roofX.filter(b => b.pos.z === 0).every(b => b.name.includes('facing=south')))
check('gable: far slope climbs toward the ridge',
  roofX.filter(b => b.pos.z === 8).every(b => b.name.includes('facing=north')))
check('gable along z faces east/west instead',
  new Set(primitives.gable({ width: 9, depth: 9, material: 'dark_oak_stairs', axis: 'z' })
    .map(b => /facing=(\w+)/.exec(b.name)[1])).size === 2 &&
  primitives.gable({ width: 9, depth: 9, material: 'dark_oak_stairs', axis: 'z' })
    .filter(b => b.pos.x === 0).every(b => b.name.includes('facing=east')))
check('pyramid as a hip roof: all four faces climb inward',
  new Set(primitives.pyramid({ width: 9, depth: 9, height: 5, material: 'dark_oak_stairs' })
    .map(b => /facing=(\w+)/.exec(b.name)[1])).size === 4)
check('roofs: a non-stairs material is left alone',
  primitives.gable({ width: 5, depth: 5, material: 'stone', axis: 'x' }).every(b => b.name === 'stone'))
check('roofs: an explicit state is respected',
  primitives.gable({ width: 5, depth: 5, material: 'oak_stairs[facing=west,half=top]', axis: 'x' })
    .every(b => b.name === 'oak_stairs[facing=west,half=top]'))

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
