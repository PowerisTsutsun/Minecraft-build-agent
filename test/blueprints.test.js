'use strict'

// The blueprint folder: filename is the name, folder is the group.
//
// This is the bot's whole promise to someone adding their own build - drop
// japanesehouse.schematic into blueprints/house/ and type !build /japanesehouse.
// It is also the only place a string typed in public chat picks a file, so the
// traversal cases below are not paranoia.

const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprints-test-'))
process.env.MC_BLUEPRINT_DIR = dir

const blueprints = require('../src/building/blueprints')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const put = (rel, body = '') => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
const nameOf = x => (x ? x.name : null)

// --- the filename is the name -----------------------------------------------
put('house/japanesehouse.schematic')
put('house/cottage.schem')
put('tower/wizard.litematic')

check('name: a dropped file is buildable by its filename',
  nameOf(blueprints.resolve('japanesehouse')) === 'japanesehouse')
check('name: the leading slash is optional',
  nameOf(blueprints.resolve('/japanesehouse')) === 'japanesehouse')
check('name: case does not matter',
  nameOf(blueprints.resolve('JapaneseHouse')) === 'japanesehouse')
check('name: all three extensions count',
  nameOf(blueprints.resolve('cottage')) === 'cottage' &&
  nameOf(blueprints.resolve('wizard')) === 'wizard')

// --- the folder is the group ------------------------------------------------
const g1 = blueprints.groups()
check('group: the folder becomes the group',
  blueprints.resolve('japanesehouse').group === 'house' &&
  blueprints.resolve('wizard').group === 'tower')
check('group: list is grouped by folder',
  g1.groups.house.length === 2 && g1.groups.tower.length === 1,
  JSON.stringify(Object.keys(g1.groups)))

// A group is not a fixed vocabulary in the code - inventing a folder is how a
// user adds a section to !build list.
put('ships/galleon.schem')
check('group: a folder nobody planned for becomes a group',
  blueprints.groups().groups.ships.map(e => e.name).join(',') === 'galleon')

put('loose.schem')
check('group: a file loose in the root lands in "other"',
  blueprints.resolve('loose').group === blueprints.UNGROUPED)

// --- sidecars ---------------------------------------------------------------
// A machine is dead without its contents, so setup.txt travels beside it.
put('farm/ironfarm.schem')
put('farm/ironfarm.setup.txt', '# a comment\n/summon minecraft:villager ~1 ~2 ~3\n')
put('farm/ironfarm.meta.json', '{"ground":2}')
const farm = blueprints.resolve('ironfarm')
check('sidecar: setup.txt is found beside the blueprint',
  Boolean(farm.setup) && farm.setup.endsWith('ironfarm.setup.txt'))
check('sidecar: meta.json is found beside the blueprint',
  Boolean(farm.meta) && farm.meta.endsWith('ironfarm.meta.json'))
check('sidecar: a plain house has neither',
  blueprints.resolve('cottage').setup === null && blueprints.resolve('cottage').meta === null)
check('sidecar: a .setup.txt is not itself a blueprint',
  blueprints.resolve('ironfarm.setup') === null)

// --- two folders, one name --------------------------------------------------
put('landmark/cottage.schem')
const clash = blueprints.groups()
check('clash: a duplicate name is reported, not silently shadowed',
  clash.clashes.length === 1 && clash.clashes[0].name === 'cottage',
  JSON.stringify(clash.clashes))
check('clash: resolution is stable (first folder alphabetically wins)',
  blueprints.resolve('cottage').group === 'house',
  'filesystem order must not decide which build a name means')
check('clash: group/name reaches the shadowed one',
  blueprints.resolve('landmark/cottage').group === 'landmark')
check('clash: group/name refuses a wrong pairing',
  blueprints.resolve('tower/cottage') === null)

// --- names that are not names ------------------------------------------------
// The chat string is a key in a map, never a path fragment.
for (const bad of ['../../etc/passwd', '../catalog', '/../secret', './cottage', 'house/../../etc/passwd']) {
  check(`traversal: "${bad}" resolves to nothing`, blueprints.resolve(bad) === null,
    String(nameOf(blueprints.resolve(bad))))
}
check('inherited: "constructor" is not a blueprint', blueprints.resolve('constructor') === null)
check('inherited: "__proto__" is not a blueprint', blueprints.resolve('__proto__') === null)
check('empty: an empty name resolves to nothing',
  blueprints.resolve('') === null && blueprints.resolve(null) === null)

// --- things that are not blueprints -----------------------------------------
put('house/notes.txt')
put('.hidden/secret.schem')
put('house/old/parked.schem')
check('ignored: a non-blueprint extension is not buildable',
  blueprints.resolve('notes') === null)
check('ignored: a dot-folder is skipped',
  blueprints.resolve('secret') === null)
check('ignored: nesting deeper than one folder is not flattened',
  blueprints.resolve('parked') === null,
  'blueprints/house/old/ reads as parked, not as an offer')

fs.rmSync(dir, { recursive: true, force: true })

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
