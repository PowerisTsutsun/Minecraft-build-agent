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
check('templates: a scaffold with no .schem is not offered as placeable',
  !templates.list().includes('iron_farm'),
  templates.list().join(','))
check('templates: but it can still be described',
  templates.describe('iron_farm').meta.scaffold === true)
check('templates: an unusable template is not matched by a request',
  classify.matchTemplate('build me an iron farm') === null)
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
check('iron_farm: ships a readme that says it is not a working farm',
  fs.readFileSync(path.join(dir, 'readme.md'), 'utf8').includes('not a working farm'))
check('iron_farm: ships a setup.txt with summon examples',
  fs.readFileSync(path.join(dir, 'setup.txt'), 'utf8').includes('/summon minecraft:villager'))
check('iron_farm: its setup lines are all commented out until someone fills them in',
  templates.describe('iron_farm').setup.length === 0)

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
