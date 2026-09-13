'use strict'

// The setup path: resolving a server entry, and noticing when the blueprint
// catalogue has fallen behind the folder.
//
// Both exist so that a fresh clone needs no hand-edited files. The failure they
// guard against is not a crash - it is a bot that comes up looking healthy and
// then ignores the person typing at it, which is exactly what an unresolved
// ${BUILDER} used to produce.

const fs = require('fs')
const os = require('os')
const path = require('path')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

// --- server entries ---------------------------------------------------------
const servers = require('../src/rcon/servers')

check('servers: the committed example is loadable with nothing copied',
  Boolean(servers.all()), 'a fresh clone must work without rcon-servers.json')

// expand() is the whole mechanism: .env supplies what the JSON cannot know.
process.env.SETUP_TEST_NAME = 'Steve'
delete process.env.SETUP_TEST_MISSING
check('expand: a set variable is substituted',
  servers.expand('${SETUP_TEST_NAME}') === 'Steve')
check('expand: a plain string is untouched',
  servers.expand('PlainName') === 'PlainName')
check('expand: an unset variable is left alone, not blanked',
  servers.expand('${SETUP_TEST_MISSING}') === '${SETUP_TEST_MISSING}',
  'client.js reports a missing password BY NAME - blanking it loses that')

// The allow list is the security boundary. RCON is console level, so an
// unresolved name must vanish rather than become a literal player name.
check('allow: an unresolved name is dropped, not taken literally',
  servers.nameList(['${SETUP_TEST_MISSING}']).length === 0,
  'a player called "${SETUP_TEST_MISSING}" must never be authorised')
check('allow: dropping the only entry leaves an empty list (the bot fails closed)',
  Array.isArray(servers.nameList(['${SETUP_TEST_MISSING}'])))
check('allow: resolved names survive, in order',
  servers.nameList(['${SETUP_TEST_NAME}', 'Alex']).join(',') === 'Steve,Alex')
check('allow: blanks and whitespace are dropped',
  servers.nameList(['', '   ', 'Alex']).join(',') === 'Alex')
check('allow: a missing list stays missing rather than becoming empty',
  servers.nameList(undefined) === undefined,
  'undefined and [] mean different things to isOperator')

check('servers: an unknown name reports what does exist', (() => {
  try { servers.load('no-such-server'); return false } catch (err) {
    return /defines:/.test(err.message)
  }
})())

// --- catalogue staleness ----------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-test-'))
process.env.MC_BLUEPRINT_DIR = dir
const catalogue = require('../src/building/catalogue')

const touch = (file, mtime) => {
  const p = path.join(dir, file)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000)
}

check('stale: an empty folder is not stale',
  catalogue.isStale() === false, 'a fresh clone must not rebuild on every boot')

const now = Date.now()
touch('house/house9.schem', now)
check('stale: a blueprint with no catalogue at all is stale',
  catalogue.isStale() === true)

touch('catalog.json', now + 60000)
check('stale: a catalogue newer than every file is current',
  catalogue.isStale() === false)

touch('house/dropped-in.litematic', now + 120000)
check('stale: a file dropped into a group folder makes it stale',
  catalogue.isStale() === true, 'a flat scan would miss this - blueprints live in subfolders')

touch('catalog.json', now + 180000)
touch('house/notes.txt', now + 240000)
check('stale: a non-blueprint file does not trigger a rebuild',
  catalogue.isStale() === false)

fs.rmSync(dir, { recursive: true, force: true })

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
