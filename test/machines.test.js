'use strict'

// Machines: blueprints that are dead without the contents beside them.
//
// A farm's villagers, the zombie in its boat and the 41 items that make a
// filter hopper a filter are not block data, so no .schem carries them. They
// live in <name>.setup.txt and are resolved against the placement origin here.
// Get this wrong and the machine arrives looking perfect and producing nothing.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const machines = require('../src/building/machines')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

// --- a real machine on disk -------------------------------------------------
// ironfarm1 was exported from a farm on the sandbox that was producing iron -
// 53 ingots in its chest when it was captured. Its contents live beside it.
const blueprints = require('../src/building/blueprints')
const readSetup = entry => fs.readFileSync(entry.setup, 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

const ironfarm = blueprints.resolve('ironfarm1')
check('machine: ironfarm1 is in the blueprint folder',
  Boolean(ironfarm) && ironfarm.group === 'farm', String(ironfarm && ironfarm.group))
check('machine: its setup.txt sits beside it',
  Boolean(ironfarm && ironfarm.setup), 'without it the farm arrives as a dead shell')
const ironSetup = readSetup(ironfarm)
check('machine: the setup carries its entities', ironSetup.length === 4,
  `${ironSetup.length} setup commands`)
check('machine: it summons a zombie WITH its AI (a NoAI one is never registered as hostile)',
  ironSetup.some(l => /zombie/.test(l) && !/NoAI:1b/.test(l)))
check('machine: three villagers, one per bed to claim',
  ironSetup.filter(l => /villager/.test(l)).length === 3)

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
const resolved = machines.setupCommands(fake, new Vec3(100, 60, 200))
check('setup: relative offsets resolve against the placement origin',
  resolved[0].includes('105 62 205') && resolved[1].includes('106 65 206'),
  resolved.join(' | '))
check('setup: the rest of the command is untouched',
  resolved[0].includes('{PersistenceRequired:1b}'))

// Entities sit at fractional positions. The iron farm's boat is at ~2.5 ~2 ~5.7,
// and an integer-only pattern passed that line through UNRESOLVED - so the bot
// would have summoned the boat relative to its own feet, not the template.
const boat = machines.setupCommands(
  { setup: ['/summon minecraft:oak_boat ~2.5 ~2 ~5.7 {Passengers:[{id:"minecraft:zombie"}]}'] },
  new Vec3(1908, -59, 1105))[0]
check('setup: fractional offsets resolve too',
  boat.includes('1910.5 -57 1110.7'), boat.slice(0, 60))
check('setup: no unresolved ~ survives', !/~/.test(boat))
// And the real template's setup must have nothing left unresolved either.
const realSetup = machines.setupCommands({ setup: ironSetup }, new Vec3(0, 0, 0))
check('ironfarm1: every setup line resolves fully', realSetup.every(l => !/~/.test(l)),
  realSetup.filter(l => /~/.test(l)).join(' | '))

// --- the protect region ----------------------------------------------------
const guarded = machines.protectedCells(fake, new Vec3(10, 0, 10))
check('protect: covers the declared box',
  guarded.size === 3 * 2 * 3, `${guarded.size}`)
check('protect: is in world coordinates',
  guarded.has('10,0,10') && guarded.has('12,1,12'),
  [...guarded].slice(0, 3).join(' '))
check('protect: a decorator cell outside it is not protected',
  !guarded.has('13,0,13'))

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
