'use strict'

// Palettes. Two properties matter: a slot name must resolve everywhere a block
// id is accepted, and the weathering swap must be DETERMINISTIC - command mode
// skips cells that are already correct, so a random swap would make every
// re-run rewrite most of the build.

const primitives = require('../src/building/primitives')
const paletteLib = require('../src/building/palette')
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

// Every shipped palette must name only blocks this server has.
for (const name of Object.keys(paletteLib.NAMED)) {
  const built = paletteLib.build(name, real)
  check(`palette ${name}: every slot is a real block`, built.warnings.length === 0, built.warnings.join('; '))
}

// Slot names resolve wherever a material is accepted.
const slotted = build({
  summary: 'slots',
  palette: { name: 'gothic' },
  shell: [
    { op: 'box', material: 'wall', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 6, hollow: true },
    { op: 'roof', material: 'roof', offset: { x: 0, y: 6, z: 0 }, anchor: 'corner', kind: 'gable', width: 9, depth: 9, axis: 'x' }
  ],
  carves: [
    { op: 'box', material: 'air', offset: { x: 1, y: 1, z: 1 }, anchor: 'corner', width: 7, depth: 7, height: 5, hollow: false },
    { op: 'window', offset: { x: 0, y: 2, z: 0 }, anchor: 'corner', face: 'south', along: 4, width: 1, height: 2, frame: 'trim', glass: 'glass', footprint: { width: 9, depth: 9 } }
  ],
  details: [{ op: 'trim_band', material: 'trim', offset: { x: 0, y: 3, z: 0 }, anchor: 'corner', width: 9, depth: 9 }]
})
check('slots: a plan written entirely in slot names validates',
  (slotted.errors || []).length === 0, (slotted.errors || [])[0])
check('slots: "wall" became the gothic wall block',
  slotted.blocks.some(b => b.name === 'deepslate_bricks'))
check('slots: "trim" became the gothic trim block',
  slotted.blocks.some(b => b.name === 'polished_deepslate'))
check('slots: "glass" became the gothic glazing',
  slotted.blocks.some(b => /gray_stained_glass_pane/.test(b.name)))
check('slots: every rendered id is a real block',
  slotted.blocks.every(b => real(b.name)),
  [...new Set(slotted.blocks.map(b => b.name).filter(n => !real(n)))].slice(0, 3).join(' '))

// Determinism: the same plan must render identically, twice.
const planFor = seedy => ({
  summary: 'weathered',
  palette: { name: 'medieval_stone' },
  shell: [{ op: 'box', material: 'wall', offset: { x: seedy, y: 0, z: 0 }, anchor: 'corner', width: 15, depth: 15, height: 12, hollow: true }]
})
const a1 = build(planFor(0))
const a2 = build(planFor(0))
const sig = out => out.blocks.map(b => `${b.pos.x},${b.pos.y},${b.pos.z}=${b.name}`).sort().join('|')
check('weathering: the same plan renders identically twice', sig(a1) === sig(a2))
check('weathering: some wall cells were swapped for rough variants',
  a1.blocks.some(b => /cracked|mossy|cobblestone/.test(b.name)),
  [...new Set(a1.blocks.map(b => b.name))].join(','))

const variants = a1.blocks.filter(b => /cracked_stone_bricks|mossy_stone_bricks/.test(b.name))
const plainWall = a1.blocks.filter(b => b.name === 'stone_bricks')
check('weathering: stays a minority of the wall',
  variants.length < plainWall.length, `${variants.length} weathered vs ${plainWall.length} plain`)

// Weighted toward the bottom, which is where damp and damage actually collect.
const lows = variants.filter(b => b.pos.y <= 4).length
const highs = variants.filter(b => b.pos.y >= 8).length
check('weathering: weighted toward the bottom of the wall', lows > highs, `${lows} low vs ${highs} high`)

// A different plan gets different weathering.
const b1 = build(planFor(100))
check('weathering: a different plan weathers differently',
  sig(b1) !== sig(a1).replace(/(-?\d+),/g, (m, x) => `${Number(x) + 100},`))

// An unknown slot falls back rather than failing the build.
const bad = build({
  summary: 'bad palette',
  palette: { name: 'medieval_stone', trim: 'unobtanium' },
  shell: [{ op: 'trim_band', material: 'trim', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 5, depth: 5 }]
})
check('palette: an unknown block in a slot falls back and warns',
  (bad.errors || []).length === 0 && bad.warnings.some(w => /unobtanium/.test(w)),
  bad.warnings.join(' | '))

// Macros pick their materials out of the palette.
const macroed = build({
  summary: 'a desert tower',
  palette: { name: 'desert' },
  shell: [{ op: 'tower', offset: { x: 20, y: 0, z: 20 }, diameter: 9, height: 16, storeys: 2, top: 'cone' }]
})
check('palette: a macro builds out of the named palette',
  macroed.blocks.some(b => /sandstone/.test(b.name)) && macroed.blocks.every(b => real(b.name)),
  [...new Set(macroed.blocks.map(b => b.name))].slice(0, 4).join(','))



// Vanilla is inconsistent about which variants get a stairs block, and a
// palette that names one without stairs must not fail a whole build. Every
// shipped palette has to survive every macro.
const macrosToTry = [
  { op: 'tower', offset: { x: 20, y: 0, z: 20 }, diameter: 9, height: 16, storeys: 2, top: 'cone' },
  { op: 'hall', offset: { x: 0, y: 0, z: 0 }, width: 11, depth: 15, storeys: 2 }
]
for (const name of Object.keys(paletteLib.NAMED)) {
  for (const macro of macrosToTry) {
    const out = build({ summary: 'x', palette: { name }, shell: [macro] })
    const bad = [...new Set((out.blocks || []).map(b => b.name).filter(n => !real(n)))]
    check(`palette ${name} + ${macro.op}: renders with only real ids`,
      (out.errors || []).length === 0 && bad.length === 0,
      (out.errors || [])[0] || bad.slice(0, 2).join(','))
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
