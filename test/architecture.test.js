'use strict'

// The architectural ops. Each takes a footprint and computes its own block
// states; the model never writes a facing for any of them. These check the
// geometry that makes each one read as architecture rather than a box.

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
const facingOf = name => (/facing=(\w+)/.exec(name) || [])[1]

// --- eaves -----------------------------------------------------------------
const ev = primitives.eaves({ width: 11, depth: 9, material: 'stone_brick_stairs', y: 8 })
check('eaves: a closed ring one block proud of the footprint',
  ev.length === 44, `${ev.length} cells`)
check('eaves: every one is upside down', ev.every(b => /half=top/.test(b.name)))
check('eaves: all four facings appear', new Set(ev.map(b => facingOf(b.name))).size === 4,
  [...new Set(ev.map(b => facingOf(b.name)))].join(','))
check('eaves: the north run faces north',
  ev.filter(b => b.pos.z === -1 && b.pos.x > -1 && b.pos.x < 11).every(b => facingOf(b.name) === 'north'))
check('eaves: sits outside the footprint, not on it',
  ev.every(b => b.pos.x === -1 || b.pos.x === 11 || b.pos.z === -1 || b.pos.z === 9))

// --- battlements -----------------------------------------------------------
const bt = primitives.battlements({ width: 9, depth: 9, material: 'cobblestone_wall', y: 10, cap: 'stone_brick_slab' })
const merlonCols = new Set(bt.filter(b => b.name === 'cobblestone_wall').map(b => `${b.pos.x},${b.pos.z}`))
const ring = primitives.perimeter(9, 9).length
check('battlements: merlons on roughly half the ring',
  merlonCols.size > ring * 0.3 && merlonCols.size < ring * 0.75, `${merlonCols.size} of ${ring}`)
check('battlements: every corner carries a merlon, so the silhouette closes',
  [[0, 0], [8, 0], [0, 8], [8, 8]].every(([x, z]) => merlonCols.has(`${x},${z}`)))
check('battlements: each merlon is capped', bt.filter(b => /slab/.test(b.name)).length === merlonCols.size)

// --- plinth / column -------------------------------------------------------
const pl = primitives.plinth({ width: 9, depth: 7, material: 'cobblestone', height: 2, grow: 1 })
check('plinth: wider than the building it carries',
  Math.min(...pl.map(b => b.pos.x)) === -1 && Math.max(...pl.map(b => b.pos.x)) === 9)
check('plinth: as many courses as asked for', new Set(pl.map(b => b.pos.y)).size === 2)
check('column: a log gets its axis from the way it runs',
  primitives.column({ height: 4, material: 'oak_log', axis: 'x' }).every(b => b.name === 'oak_log[axis=x]'))
check('column: a non-log is left alone',
  primitives.column({ height: 4, material: 'stone_bricks' }).every(b => b.name === 'stone_bricks'))

// --- roof ------------------------------------------------------------------
const gableRoof = primitives.roof({ kind: 'gable', width: 11, depth: 9, material: 'deepslate_tile_stairs', gableFill: 'deepslate_tiles', axis: 'x' })
check('roof gable: overhangs the walls by default',
  Math.min(...gableRoof.map(b => b.pos.x)) === -1 && Math.max(...gableRoof.map(b => b.pos.x)) === 11,
  `${Math.min(...gableRoof.map(b => b.pos.x))}..${Math.max(...gableRoof.map(b => b.pos.x))}`)
check('roof gable: two slopes facing opposite ways',
  new Set(gableRoof.filter(b => /stairs/.test(b.name)).map(b => facingOf(b.name))).size === 2)
check('roof gable: the ends are filled, not left open',
  gableRoof.some(b => b.name === 'deepslate_tiles'))
const flush = primitives.roof({ kind: 'gable', width: 11, depth: 9, material: 'deepslate_tile_stairs', overhang: 0, axis: 'x' })
check('roof gable: overhang 0 is respected when asked for',
  Math.min(...flush.map(b => b.pos.x)) === 0)

const hipRoof = primitives.roof({ kind: 'hip', width: 11, depth: 9, material: 'deepslate_tile_stairs' })
check('roof hip: all four faces slope inward',
  new Set(hipRoof.filter(b => /stairs/.test(b.name)).map(b => facingOf(b.name))).size === 4)

const coneRoof = primitives.roof({ kind: 'cone', radius: 5, height: 9, material: 'deepslate_tiles' })
const widthAt = y => {
  const at = coneRoof.filter(b => b.pos.y === y)
  return at.length ? Math.max(...at.map(b => b.pos.x)) - Math.min(...at.map(b => b.pos.x)) : 0
}
check('roof cone: tapers as it rises', widthAt(0) > widthAt(6), `${widthAt(0)} -> ${widthAt(6)}`)

for (const kind of ['mansard', 'pagoda', 'onion']) {
  const r = primitives.roof({ kind, width: 11, depth: 11, material: 'dark_oak_stairs', height: 9 })
  const levels = [...new Set(r.map(b => b.pos.y))].sort((a, b) => a - b)
  const spanAt = y => {
    const at = r.filter(b => b.pos.y === y)
    return Math.max(...at.map(b => b.pos.x)) - Math.min(...at.map(b => b.pos.x))
  }
  check(`roof ${kind}: stacked tiers that narrow as they rise`,
    r.length > 0 && spanAt(levels[0]) > spanAt(levels[levels.length - 1]),
    `${spanAt(levels[0])} -> ${spanAt(levels[levels.length - 1])}`)
}

// --- through the whole pipeline --------------------------------------------
const dressed = build({
  summary: 'a dressed hall',
  shell: [
    { op: 'plinth', material: 'cobblestone', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 11, depth: 9, height: 1 },
    { op: 'box', material: 'stone_bricks', offset: { x: 0, y: 1, z: 0 }, anchor: 'corner', width: 11, depth: 9, height: 7, hollow: true },
    { op: 'roof', material: 'deepslate_tiles', offset: { x: 0, y: 8, z: 0 }, anchor: 'corner', kind: 'gable', width: 11, depth: 9, axis: 'x' }
  ],
  carves: [{ op: 'box', material: 'air', offset: { x: 1, y: 2, z: 1 }, anchor: 'corner', width: 9, depth: 7, height: 6, hollow: false }],
  details: [
    { op: 'eaves', material: 'stone_bricks', offset: { x: 0, y: 7, z: 0 }, anchor: 'corner', width: 11, depth: 9 },
    { op: 'trim_band', material: 'polished_andesite', offset: { x: 0, y: 4, z: 0 }, anchor: 'corner', width: 11, depth: 9 },
    { op: 'column', material: 'oak_log', offset: { x: 0, y: 1, z: 0 }, anchor: 'corner', height: 6, axis: 'y' },
    { op: 'buttress', material: 'stone_bricks', offset: { x: 0, y: 1, z: 0 }, anchor: 'corner', face: 'north', along: 4, height: 6, footprint: { width: 11, depth: 9 } }
  ]
})
check('pipeline: a fully dressed hall validates and renders',
  (dressed.errors || []).length === 0 && dressed.blocks.length > 0, (dressed.errors || [])[0])
check('pipeline: eaves resolved a stairs sibling from a plain material',
  // The state is [facing=...,half=top] - anchoring on "[half=top" never matches.
  dressed.blocks.some(b => /^stone_brick_stairs\[/.test(b.name) && /half=top/.test(b.name)),
  dressed.blocks.filter(b => /_stairs/.test(b.name)).slice(0, 2).map(b => b.name).join(' '))
check('pipeline: the roof resolved its own stairs and gable fill',
  dressed.blocks.some(b => /deepslate_tile_stairs/.test(b.name)))
const bogus = [...new Set(dressed.blocks.map(b => b.name).filter(n => !real(n)))]
check('pipeline: every id is a real block', bogus.length === 0, bogus.slice(0, 3).join(' '))
const doubled = dressed.blocks.filter(b => (b.name.match(/\[/g) || []).length > 1)
check('pipeline: no double-stated ids', doubled.length === 0, doubled.slice(0, 2).map(b => b.name).join(' '))

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
