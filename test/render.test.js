'use strict'

// The phased renderer: phase order, carve protection, the overwrite lint, the
// anchor/diameter conveniences, and the orientation pass.
//
// These are the checks that are supposed to make "a later action silently
// destroyed an earlier one" impossible rather than merely discouraged, so they
// are written as the failures that actually happened: a wall re-emitted over
// its own doorway, and a floor laid across a carved shaft.

const primitives = require('../src/building/primitives')
const { validatePlan, renderPlan } = require('../src/commands/llm')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const known = n => /^[a-z_]+(\[.*\])?$/.test(n)
const at = (blocks, x, y, z) => {
  const b = blocks.find(b => b.pos.x === x && b.pos.y === y && b.pos.z === z)
  return b ? b.name : null
}

function build (plan) {
  const v = validatePlan(plan, known)
  if (v.errors.length) return { errors: v.errors, blocks: [], warnings: [] }
  return renderPlan(v, primitives)
}

const cell = (x, y, z, material) => ({ op: 'blocks', material, offset: { x: 0, y: 0, z: 0 }, cells: [{ x, y, z }] })

// --- phase order -----------------------------------------------------------
const phased = build({
  summary: 'phases',
  details: [cell(0, 0, 0, 'gold_block')],
  shell: [cell(0, 0, 0, 'stone')],
  carves: [cell(1, 0, 0, 'air')]
})
check('phases: details win over shell however the plan is written',
  at(phased.blocks, 0, 0, 0) === 'gold_block', at(phased.blocks, 0, 0, 0))
check('phases: a carve stays carved', at(phased.blocks, 1, 0, 0) === 'air')

// --- carve protection ------------------------------------------------------
// A doorway cut through a wall, then a bulk detail laid straight over it.
const sealed = build({
  summary: 'sealed doorway',
  shell: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5, height: 5, hollow: true }],
  carves: [{ op: 'arch', material: 'air', offset: { x: 1, y: 0, z: 0 }, anchor: 'corner', width: 3, height: 3, depth: 5 }],
  details: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5, height: 5, hollow: true }]
})
check('protection: a bulk detail cannot refill a carved doorway',
  sealed.errors.length === 0 && sealed.drops > 0 && at(sealed.blocks, 2, 1, 0) === 'air',
  `drops=${sealed.drops} cell=${at(sealed.blocks, 2, 1, 0)}`)
check('protection: the drop is reported, not silent',
  sealed.warnings.some(w => /tried to fill/.test(w)), sealed.warnings.join(' | '))

// Precise ops are exempt - furniture and stairs belong inside carved space.
const furnished = build({
  summary: 'furnished',
  shell: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5, height: 5, hollow: false }],
  carves: [{ op: 'box', material: 'air', offset: { x: 1, y: 1, z: 1 }, anchor: 'corner', width: 3, depth: 3, height: 3, hollow: false }],
  details: [cell(2, 1, 2, 'crafting_table')]
})
check('protection: a blocks detail may still furnish a carved room',
  at(furnished.blocks, 2, 1, 2) === 'crafting_table', at(furnished.blocks, 2, 1, 2))

const staired = build({
  summary: 'stairs in a shaft',
  shell: [{ op: 'cylinder', material: 'stone', offset: { x: 6, y: 0, z: 6 }, anchor: 'center', radius: 5, height: 12, hollow: true }],
  carves: [{ op: 'cylinder', material: 'air', offset: { x: 6, y: 0, z: 6 }, anchor: 'center', radius: 4, height: 12, hollow: false }],
  details: [{ op: 'spiral', material: 'stone_brick_stairs', offset: { x: 6, y: 0, z: 6 }, anchor: 'center', radius: 3, height: 10 }]
})
const treads = staired.blocks.filter(b => /stairs/.test(b.name))
check('protection: a spiral may still climb a carved shaft', treads.length === 10, `${treads.length} treads`)
check('protection: spiral treads are oriented', treads.every(b => /facing=/.test(b.name)))

// --- overwrite lint --------------------------------------------------------
const buried = build({
  summary: 'buried',
  shell: [
    { op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 6, depth: 6, height: 6, hollow: true },
    { op: 'box', material: 'deepslate', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 6, depth: 6, height: 6, hollow: true }
  ]
})
check('lint: a shape burying another in the same phase is refused',
  buried.errors.length > 0 && /overwrites/.test(buried.errors[0]), buried.errors[0])
check('lint: the error names both actions', /action 2 .* action 1/.test(buried.errors[0] || ''), buried.errors[0])

const trimmed = build({
  summary: 'trim band over a wall',
  shell: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 9, hollow: true }],
  details: [{ op: 'floor', material: 'polished_andesite', offset: { x: 0, y: 4, z: 0 }, anchor: 'corner', width: 9, depth: 9 }]
})
check('lint: a detail may still overwrite shell (that is what a trim band is)',
  trimmed.errors.length === 0, trimmed.errors[0])

const hollowed = build({
  summary: 'hollowing is not burying',
  shell: [{ op: 'cylinder', material: 'stone', offset: { x: 5, y: 0, z: 5 }, anchor: 'center', radius: 5, height: 10, hollow: false }],
  carves: [{ op: 'cylinder', material: 'air', offset: { x: 5, y: 0, z: 5 }, anchor: 'center', radius: 4, height: 10, hollow: false }]
})
check('lint: carving out a solid mass is not flagged', hollowed.errors.length === 0, hollowed.errors[0])

// --- anchor and diameter ---------------------------------------------------
const centred = build({ summary: 'c', shell: [{ op: 'cylinder', material: 'stone', offset: { x: 20, y: 0, z: 20 }, radius: 4, height: 1 }] })
const cx = centred.blocks.map(b => b.pos.x)
check('anchor: round shapes centre on their offset by default',
  Math.min(...cx) === 16 && Math.max(...cx) === 24, `${Math.min(...cx)}..${Math.max(...cx)}`)

const cornered = build({ summary: 'c', shell: [{ op: 'cylinder', material: 'stone', offset: { x: 20, y: 0, z: 20 }, anchor: 'corner', radius: 4, height: 1 }] })
const kx = cornered.blocks.map(b => b.pos.x)
check('anchor: corner puts the offset at the low corner',
  Math.min(...kx) === 20 && Math.max(...kx) === 28, `${Math.min(...kx)}..${Math.max(...kx)}`)

const byDiameter = build({ summary: 'd', shell: [{ op: 'cylinder', material: 'stone', offset: { x: 20, y: 0, z: 20 }, diameter: 9, height: 1 }] })
check('diameter: 9 is the same shape as radius 4', byDiameter.blocks.length === centred.blocks.length,
  `${byDiameter.blocks.length} vs ${centred.blocks.length}`)

const rect = build({ summary: 'r', shell: [{ op: 'floor', material: 'stone', offset: { x: 20, y: 0, z: 20 }, anchor: 'center', width: 5, depth: 5 }] })
const rx = rect.blocks.map(b => b.pos.x)
check('anchor: rectangles centre too when asked',
  Math.min(...rx) === 18 && Math.max(...rx) === 22, `${Math.min(...rx)}..${Math.max(...rx)}`)

// --- orientation pass ------------------------------------------------------
const oriented = build({
  summary: 'orientation',
  shell: [
    cell(0, 0, 0, 'stone'), cell(2, 0, 0, 'stone'), // pane will sit between them
    cell(5, 0, 0, 'stone'), // torch hangs on this
    cell(8, 2, 0, 'stone'), // lantern hangs under this
    cell(11, 0, 0, 'stone') // wall connects to this
  ],
  details: [
    cell(1, 0, 0, 'glass_pane'),
    cell(6, 0, 0, 'wall_torch'),
    cell(8, 1, 0, 'lantern'),
    cell(12, 0, 0, 'cobblestone_wall')
  ]
})
check('orient: a pane connects to the solids beside it',
  /east=true/.test(at(oriented.blocks, 1, 0, 0) || '') && /west=true/.test(at(oriented.blocks, 1, 0, 0) || ''),
  at(oriented.blocks, 1, 0, 0))
check('orient: a wall torch faces away from what it hangs on',
  at(oriented.blocks, 6, 0, 0) === 'wall_torch[facing=east]', at(oriented.blocks, 6, 0, 0))
check('orient: a lantern under a ceiling hangs',
  at(oriented.blocks, 8, 1, 0) === 'lantern[hanging=true]', at(oriented.blocks, 8, 1, 0))
check('orient: a wall connects to its neighbour',
  /west=low/.test(at(oriented.blocks, 12, 0, 0) || ''), at(oriented.blocks, 12, 0, 0))

const explicit = build({ summary: 'e', shell: [cell(0, 0, 0, 'stone')], details: [cell(1, 0, 0, 'wall_torch[facing=west]')] })
check('orient: an explicit state is never overwritten',
  at(explicit.blocks, 1, 0, 0) === 'wall_torch[facing=west]', at(explicit.blocks, 1, 0, 0))

const unsupported = build({ summary: 'u', details: [cell(40, 40, 40, 'wall_torch')] })
check('orient: a torch with nothing to hang on is warned about',
  unsupported.warnings.some(w => /nothing to hang on/.test(w)), unsupported.warnings.join(' | '))

// --- legacy plans still load ----------------------------------------------
const legacy = build({ summary: 'legacy', actions: [cell(0, 0, 0, 'stone'), cell(1, 0, 0, 'stone')] })
check('legacy: a single-list plan still renders', legacy.blocks.length === 2 && legacy.errors.length === 0)



// The system prompt is a template literal, and a stray backtick in prose pasted
// into it is a syntax error that takes the whole bot down. Three separate edits
// have now introduced one, so it gets a check of its own.
const { SYSTEM_PROMPT } = require('../src/commands/llm')
check('prompt: no backticks in the system prompt body', !SYSTEM_PROMPT.includes('`'),
  (SYSTEM_PROMPT.split('\n').find(l => l.includes('`')) || '').slice(0, 60))
check('prompt: still documents every op',
  ['floor', 'wall', 'box', 'sphere', 'cylinder', 'cone', 'pyramid', 'gable', 'arch', 'stairs', 'spiral', 'blocks']
    .every(op => new RegExp('^- ?' + op + ':|^' + op + ':', 'm').test(SYSTEM_PROMPT)),
  ['floor', 'wall', 'box', 'sphere', 'cylinder', 'cone', 'pyramid', 'gable', 'arch', 'stairs', 'spiral', 'blocks']
    .filter(op => !new RegExp('^- ?' + op + ':|^' + op + ':', 'm').test(SYSTEM_PROMPT)).join(','))



// Protection stops a wall closing a doorway. It must not stop water filling a
// channel that was carved for it - an iron farm was built with its killing
// floor, hoppers, beds and chests all present and not one drop of water,
// because five carved channels were flooded from `details` and every cell was
// dropped as if it were masonry.
const flooded = build({
  summary: 'a carved channel, flooded',
  shell: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 3, hollow: false }],
  carves: [{ op: 'box', material: 'air', offset: { x: 1, y: 2, z: 1 }, anchor: 'corner', width: 7, depth: 7, height: 1, hollow: false }],
  details: [{ op: 'floor', material: 'water', offset: { x: 1, y: 2, z: 1 }, anchor: 'corner', width: 7, depth: 7 }]
})
check('protection: water may fill a channel carved for it',
  flooded.blocks.filter(b => b.name === 'water').length === 49,
  `${flooded.blocks.filter(b => b.name === 'water').length} water cells`)

const glazed = build({
  summary: 'a carved window, glazed',
  shell: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5, height: 5, hollow: true }],
  carves: [{ op: 'box', material: 'air', offset: { x: 2, y: 2, z: 0 }, anchor: 'corner', width: 1, depth: 1, height: 2, hollow: false }],
  details: [{ op: 'wall', material: 'glass_pane', offset: { x: 2, y: 2, z: 0 }, anchor: 'corner', length: 1, height: 2, axis: 'x' }]
})
check('protection: panes may glaze a carved window',
  glazed.blocks.filter(b => /glass_pane/.test(b.name)).length === 2,
  `${glazed.blocks.filter(b => /glass_pane/.test(b.name)).length} panes`)

const resealed = build({
  summary: 'a wall re-sealing its own doorway',
  shell: [{ op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5, height: 5, hollow: true }],
  carves: [{ op: 'box', material: 'air', offset: { x: 2, y: 1, z: 0 }, anchor: 'corner', width: 1, depth: 1, height: 2, hollow: false }],
  details: [{ op: 'wall', material: 'stone', offset: { x: 0, y: 1, z: 0 }, anchor: 'corner', length: 5, height: 2, axis: 'x' }]
})
check('protection: a solid wall still cannot re-seal a doorway',
  resealed.blocks.filter(b => b.pos.x === 2 && b.pos.z === 0 && b.pos.y >= 1 && b.pos.y <= 2).every(b => b.name === 'air'),
  'doorway was refilled')

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
