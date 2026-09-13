'use strict'

// Name resolution: aliases.json plus whatever is sitting in schematics/.
//
// The drop-in half is the bot's main promise - copy a file in, build it by its
// filename - and it is also the only place a string typed in public chat is
// used to pick a file, so the traversal cases below are not paranoia.

const fs = require('fs')
const os = require('os')
const path = require('path')

// blueprints.js reads SCHEMATIC_DIR at require time via schematic.js, so the
// env var has to be set before either is loaded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprints-test-'))
process.env.MC_SCHEMATIC_DIR = dir

const blueprints = require('../src/building/blueprints')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

function write (file, body = '') { fs.writeFileSync(path.join(dir, file), body) }
function aliasFile (obj) { write('aliases.json', JSON.stringify(obj)) }

// --- a bare folder, no aliases.json ----------------------------------------
// A fresh checkout where someone has only dropped files in must work.
write('house9.schem')
check('dropped: a file with no aliases.json resolves to itself',
  blueprints.resolve('house9') === 'house9.schem', blueprints.resolve('house9'))
check('dropped: the leading slash is optional',
  blueprints.resolve('/house9') === 'house9.schem')
check('dropped: names are case-insensitive',
  blueprints.resolve('HOUSE9') === 'house9.schem')

write('Tower.litematic')
write('old_barn.schematic')
check('dropped: .litematic counts', blueprints.resolve('tower') === 'Tower.litematic')
check('dropped: .schematic counts', blueprints.resolve('old_barn') === 'old_barn.schematic')

write('notes.txt')
write('catalog.json')
check('dropped: a non-blueprint file is not buildable',
  blueprints.resolve('notes') === null && blueprints.resolve('catalog') === null)

// --- aliases.json on top ----------------------------------------------------
aliasFile({
  house1: '13305.schematic',
  ironfarm: 'template:iron_farm',
  house9: '13305.schematic',
  _note: 'keys starting with _ are notes, not blueprints'
})
check('alias: a name maps to its file', blueprints.resolve('house1') === '13305.schematic')
check('alias: a template: value comes back intact',
  blueprints.resolve('ironfarm') === 'template:iron_farm')
check('alias: wins over a dropped file of the same name',
  blueprints.resolve('house9') === '13305.schematic',
  'a rename in schematics/ must not silently change what an existing name builds')
check('alias: _ keys are not blueprints', !blueprints.aliasNames().includes('_note'))

// --- what the list and the error message offer ------------------------------
const { named, extra } = blueprints.names()
check('names: aliases are listed', named.includes('house1') && named.includes('ironfarm'))
check('names: a dropped file with no alias is listed too', extra.includes('tower'))
check('names: a dropped file an alias already covers is not listed twice',
  !extra.includes('house9'), extra.join(','))

// --- names that are not names ----------------------------------------------
// The chat string is a key, never a path fragment. If any of these ever
// resolve, someone can read a file outside schematics/ by typing in chat.
for (const bad of ['../../etc/passwd', '../aliases', '/../secret', 'a/b', './house9']) {
  check(`traversal: "${bad}" resolves to nothing`, blueprints.resolve(bad) === null,
    String(blueprints.resolve(bad)))
}
check('inherited: "constructor" is not a blueprint', blueprints.resolve('constructor') === null)
check('inherited: "__proto__" is not a blueprint', blueprints.resolve('__proto__') === null)
check('empty: an empty name resolves to nothing',
  blueprints.resolve('') === null && blueprints.resolve(null) === null)

// --- a broken aliases.json --------------------------------------------------
// Half-written JSON should be loud, not a silent empty catalogue: a bot that
// quietly forgets every name looks like the blueprints themselves vanished.
write('aliases.json', '{ "house1": ')
let threw = false
try { blueprints.resolve('house1') } catch (err) { threw = true }
check('aliases.json: malformed JSON is reported, not swallowed', threw)

fs.rmSync(dir, { recursive: true, force: true })

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
