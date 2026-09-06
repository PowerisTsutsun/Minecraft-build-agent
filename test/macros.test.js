'use strict'

// The compound macros. One action has to produce a building someone can use:
// floors, a stair that actually reaches them, windows, a door at the ground,
// and a roof - with every coordinate worked out in code rather than by the
// model. These check for the things whose absence made earlier builds shells.

const primitives = require('../src/building/primitives')
const macros = require('../src/building/macros')
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
  if (v.errors.length) return { errors: v.errors, blocks: [], actions: [] }
  return { ...renderPlan(v, primitives, { isKnownBlock: real }), actions: v.actions }
}

// --- tower -----------------------------------------------------------------
const t = build({ summary: 't', shell: [{ op: 'tower', offset: { x: 20, y: 0, z: 20 }, diameter: 9, height: 20, storeys: 3, top: 'cone' }] })
check('tower: one action expands into a whole building',
  (t.errors || []).length === 0 && t.actions.length > 10, `${t.actions.length} actions, ${(t.errors || [])[0] || ''}`)
check('tower: emits only real block ids',
  t.blocks.every(b => real(b.name)), [...new Set(t.blocks.map(b => b.name).filter(n => !real(n)))].slice(0, 3).join(' '))
check('tower: no double-stated ids', !t.blocks.some(b => (b.name.match(/\[/g) || []).length > 1))

const treads = t.blocks.filter(b => /_stairs\[facing=(north|south|east|west),half=bottom/.test(b.name) && b.pos.y < 21)
check('tower: has a staircase', treads.length >= 10, `${treads.length} treads`)
check('tower: the stair reaches the top floor',
  Math.max(...treads.map(b => b.pos.y)) >= 15, `top tread at y=${Math.max(...treads.map(b => b.pos.y))}`)
check('tower: glazed windows', t.blocks.filter(b => /glass_pane/.test(b.name)).length >= 4)
check('tower: a doorway at ground level',
  t.blocks.some(b => b.name === 'air' && b.pos.y >= 2 && b.pos.y <= 4), 'no ground-level opening')
check('tower: eaves under the roof', t.blocks.some(b => /half=top/.test(b.name)))
check('tower: a cone roof on top', t.blocks.filter(b => b.pos.y > 20).length > 20)
check('tower: a plinth wider than the shaft', t.blocks.some(b => b.name === 'cobblestone'))

// The failure that made every earlier tower a shell: a stair that stops short.
const floors = [6, 11, 16]
check('tower: floors exist at each storey',
  floors.every(fy => t.blocks.filter(b => b.pos.y === fy && b.name !== 'air').length > 10),
  floors.map(fy => `${fy}:${t.blocks.filter(b => b.pos.y === fy && b.name !== 'air').length}`).join(' '))

// --- hall ------------------------------------------------------------------
const h = build({ summary: 'h', shell: [{ op: 'hall', offset: { x: 0, y: 0, z: 0 }, width: 11, depth: 17, storeys: 2 }] })
check('hall: expands and renders', (h.errors || []).length === 0 && h.blocks.length > 500, (h.errors || [])[0])
check('hall: emits only real block ids', h.blocks.every(b => real(b.name)))
check('hall: a pitched roof, not a flat lid',
  h.blocks.filter(b => /_stairs\[facing/.test(b.name) && b.pos.y > 10).length > 10)
check('hall: windows on both storeys',
  new Set(h.blocks.filter(b => /glass_pane/.test(b.name)).map(b => b.pos.y)).size >= 2)
check('hall: an interior stair between floors',
  h.blocks.some(b => /_stairs\[facing/.test(b.name) && b.pos.y < 8))
check('hall: corner posts', h.blocks.some(b => /_log\[axis=y\]/.test(b.name)))

// --- odd footprints --------------------------------------------------------
const even = build({ summary: 'e', shell: [{ op: 'hall', offset: { x: 0, y: 0, z: 0 }, width: 10, depth: 16, storeys: 1 }] })
const span = { x: Math.max(...even.blocks.map(b => b.pos.x)) - Math.min(...even.blocks.map(b => b.pos.x)) }
check('macros: an even width is bumped to odd so features can centre',
  span.x % 2 === 0, `span ${span.x}`)

// --- curtain_wall and gatehouse --------------------------------------------
const cw = build({ summary: 'c', shell: [{ op: 'curtain_wall', offset: { x: 0, y: 0, z: 0 }, from: { x: 0, z: 0 }, to: { x: 40, z: 0 }, height: 8 }] })
check('curtain_wall: spans the two points given',
  Math.max(...cw.blocks.map(b => b.pos.x)) - Math.min(...cw.blocks.map(b => b.pos.x)) >= 40)
check('curtain_wall: crenellated on top',
  cw.blocks.some(b => /_wall/.test(b.name) && b.pos.y >= 8))
check('curtain_wall: arrow slits along its face',
  cw.blocks.filter(b => b.name === 'air').length >= 4)

const g = build({ summary: 'g', shell: [{ op: 'gatehouse', offset: { x: 0, y: 0, z: 0 }, passage_width: 3, height: 12 }] })
check('gatehouse: expands and renders', (g.errors || []).length === 0 && g.blocks.length > 300, (g.errors || [])[0])
check('gatehouse: a passage you can walk through',
  g.blocks.filter(b => b.name === 'air' && b.pos.y >= 1 && b.pos.y <= 4).length >= 9)
check('gatehouse: a portcullis', g.blocks.some(b => /iron_bars/.test(b.name)))
check('gatehouse: two flanking towers',
  g.blocks.filter(b => b.pos.y > 12).length > 20)

// --- a whole keep ----------------------------------------------------------
const keep = build({
  summary: 'a keep',
  shell: [
    { op: 'curtain_wall', offset: { x: 0, y: 0, z: 0 }, from: { x: 0, z: 0 }, to: { x: 40, z: 0 }, height: 8 },
    { op: 'tower', offset: { x: 0, y: 0, z: 0 }, diameter: 9, height: 22, storeys: 3, top: 'battlements' },
    { op: 'tower', offset: { x: 40, y: 0, z: 0 }, diameter: 9, height: 16, storeys: 2, top: 'cone' },
    { op: 'hall', offset: { x: 12, y: 0, z: 10 }, width: 13, depth: 19, storeys: 2 }
  ]
})
check('keep: four macros compose without tripping the overwrite lint',
  (keep.errors || []).length === 0, (keep.errors || [])[0])
check('keep: renders a substantial building', keep.blocks.length > 3000, `${keep.blocks.length} blocks`)
check('keep: towers of different heights',
  new Set(keep.blocks.filter(b => b.pos.x < 10 || b.pos.x > 35).map(b => b.pos.y)).size > 20)
check('keep: every id is real', keep.blocks.every(b => real(b.name)))



// A macro's own actions must never fail a build. The model cannot fix what it
// did not write: a gothic keep was refused three times running with identical
// errors naming macro-generated windows, because every retry asked the model to
// correct code rather than its plan.
const overlapping = build({
  summary: 'macro overlap is not fatal',
  shell: [
    { op: 'tower', offset: { x: 10, y: 0, z: 10 }, diameter: 9, height: 16, storeys: 2, top: 'cone' },
    { op: 'tower', offset: { x: 14, y: 0, z: 10 }, diameter: 9, height: 16, storeys: 2, top: 'cone' }
  ]
})
check('macros: two overlapping macros warn rather than fail',
  (overlapping.errors || []).length === 0 && overlapping.blocks.length > 0,
  (overlapping.errors || [])[0])
check('macros: the overlap is still reported',
  overlapping.warnings.some(w => /macro/.test(w)), overlapping.warnings.slice(0, 2).join(' | '))

// But a plain wall re-emitted over its own doorway is still fatal - that is
// what the lint is for.
const reemitted = build({
  summary: 'a wall over its own door',
  shell: [
    { op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 7, hollow: true },
    { op: 'box', material: 'deepslate_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 7, hollow: true }
  ]
})
check('lint: a bulk shape burying another is still refused',
  (reemitted.errors || []).length > 0, 'the duplicate wall was accepted')

// A tower's own door and its ground-floor window must not share a wall patch.
const t2 = build({ summary: 'x', shell: [{ op: 'tower', offset: { x: 20, y: 0, z: 20 }, diameter: 9, height: 16, storeys: 2, top: 'cone', door_face: 'south' }] })
check('tower: the doorway is not overwritten by a window',
  !t2.warnings.some(w => /door.*overwrites|overwrites.*door/.test(w)),
  t2.warnings.filter(w => /door/.test(w)).join(' | '))

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
