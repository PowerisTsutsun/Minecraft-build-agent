'use strict'

// Templates and the classifier. The point of both is that a build which has to
// WORK is never invented: a language model will produce something farm-shaped
// that makes no iron and report success, because nothing downstream can tell a
// hopper in the right place from a hopper one block over.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const templates = require('../src/building/templates')
const classify = require('../src/pipeline/classify')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

// --- the classifier --------------------------------------------------------
const cases = [
  ['an iron farm', 'functional'],
  ['a mob grinder', 'functional'],
  ['an automatic item sorter', 'functional'],
  ['a villager trading hall', 'functional'],
  ['a creeper farm', 'functional'],
  // These name farms and are buildings: a barn is architecture.
  ['a farmhouse with a barn', 'architectural'],
  ['a windmill on a hill', 'architectural'],
  ['a granary', 'architectural']
]
for (const [request, want] of cases) {
  const got = classify.byKeyword(request)
  check(`classify: "${request}" is ${want}`, got && got.kind === want,
    got ? got.kind : 'no keyword matched')
}
check('classify: an ordinary building is left to the model',
  classify.byKeyword('a gothic keep with two towers') === null)

// --- the registry ----------------------------------------------------------
// iron_farm is no longer a scaffold: it was exported from a farm on the
// sandbox that was producing iron (53 ingots in the chest when captured). These
// used to assert the opposite and correctly failed the moment that happened.
check('templates: iron_farm has a .schem and is placeable',
  templates.list().includes('iron_farm'), templates.list().join(','))
check('templates: iron_farm is matched by a plain request',
  classify.matchTemplate('build me an iron farm') === 'iron_farm')
check('templates: iron_farm carries its entities in setup.txt',
  templates.describe('iron_farm').setup.length === 4,
  `${templates.describe('iron_farm').setup.length} setup commands`)
check('templates: the setup summons a zombie WITH its AI (a NoAI one is never registered as hostile)',
  templates.describe('iron_farm').setup.some(l => /zombie/.test(l) && !/NoAI:1b/.test(l)))
check('templates: a bad name is refused', (() => {
  try { templates.describe('../../etc'); return false } catch (err) { return true }
})())

// --- setup commands --------------------------------------------------------
// Blocks alone never make a machine work; the entities come from setup.txt, and
// its offsets have to resolve against wherever the template actually landed.
const fake = {
  name: 't',
  meta: { protect: { from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 1, z: 2 } } },
  setup: [
    '/summon minecraft:villager ~5 ~2 ~5 {PersistenceRequired:1b}',
    '/summon minecraft:zombie ~6 ~5 ~6 {NoAI:1b}'
  ]
}
const resolved = templates.setupCommands(fake, new Vec3(100, 60, 200))
check('setup: relative offsets resolve against the placement origin',
  resolved[0].includes('105 62 205') && resolved[1].includes('106 65 206'),
  resolved.join(' | '))
check('setup: the rest of the command is untouched',
  resolved[0].includes('{PersistenceRequired:1b}'))

// Entities sit at fractional positions. The iron farm's boat is at ~2.5 ~2 ~5.7,
// and an integer-only pattern passed that line through UNRESOLVED - so the bot
// would have summoned the boat relative to its own feet, not the template.
const boat = templates.setupCommands(
  { setup: ['/summon minecraft:oak_boat ~2.5 ~2 ~5.7 {Passengers:[{id:"minecraft:zombie"}]}'] },
  new Vec3(1908, -59, 1105))[0]
check('setup: fractional offsets resolve too',
  boat.includes('1910.5 -57 1110.7'), boat.slice(0, 60))
check('setup: no unresolved ~ survives', !/~/.test(boat))
// And the real template's setup must have nothing left unresolved either.
const realSetup = templates.setupCommands(templates.describe('iron_farm'), new Vec3(0, 0, 0))
check('iron_farm: every setup line resolves fully', realSetup.every(l => !/~/.test(l)),
  realSetup.filter(l => /~/.test(l)).join(' | '))

// --- the protect region ----------------------------------------------------
const guarded = templates.protectedCells(fake, new Vec3(10, 0, 10))
check('protect: covers the declared box',
  guarded.size === 3 * 2 * 3, `${guarded.size}`)
check('protect: is in world coordinates',
  guarded.has('10,0,10') && guarded.has('12,1,12'),
  [...guarded].slice(0, 3).join(' '))
check('protect: a decorator cell outside it is not protected',
  !guarded.has('13,0,13'))

// --- the shipped scaffold --------------------------------------------------
const dir = path.join(templates.DIR, 'iron_farm')
check('iron_farm: setup summons three villagers with beds to claim',
  templates.describe('iron_farm').setup.filter(l => /villager/.test(l)).length === 3)

// The bug that made the first placed copy a dead farm: block STATES were
// dropped, so every bed landed as a default unpaired foot facing north and
// every trapdoor lay flat on the floor. Villagers had no home; the zombie
// walked free and killed one of them.
const { specOf } = require('../src/building/blockspec')
check('specOf: carries block state into the spec string',
  specOf({ name: 'white_bed', getProperties: () => ({ facing: 'east', part: 'foot', occupied: false }) }) ===
    'white_bed[facing=east,occupied=false,part=foot]')
check('specOf: a stateless block is just its name',
  specOf({ name: 'stone_bricks', getProperties: () => ({}) }) === 'stone_bricks')

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
