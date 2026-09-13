'use strict'

// Protected volumes: the guard that stops a build being placed through a
// machine.
//
// This exists because of a real failure. A house terrace was sited by checking
// the SURFACE block of each column; the ridge it chose was terrain lying on top
// of a sorting bank. The grass said "clean ground", the terrace cut and filled
// through the machinery underneath, and 16 hoppers, 4 comparators, 2 repeaters,
// 2 redstone torches and 10 dust went with it. The machine still looked right.
//
// So the cases below are mostly about failing CLOSED: an unreadable protect
// file must not read as "nothing is protected", and a volume must travel with
// its blueprint rather than being pinned to the coordinates it was authored at.

const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-test-'))
process.env.MC_BLUEPRINT_DIR = dir
const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-journal-'))
process.env.MC_JOURNAL_DIR = journalDir

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const put = (rel, body = '') => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }

put('sorter/machine.schem')
put('sorter/machine.protect.json', JSON.stringify({
  why: 'the sorting banks',
  protect: [{ from: { x: 10, y: 2, z: 10 }, to: { x: 20, y: 6, z: 20 } }]
}))
put('house/plain.schem')

const blueprints = require('../src/building/blueprints')
const protect = require('../src/building/protect')

// --- reading the sidecar ----------------------------------------------------
const boxes = protect.boxesFor(blueprints.resolve('machine'))
check('sidecar: a .protect.json beside the blueprint is found', boxes.length === 1)
check('sidecar: its box is read in blueprint coordinates',
  boxes[0].from.x === 10 && boxes[0].to.z === 20, JSON.stringify(boxes[0]))
check('sidecar: the reason travels with it', boxes[0].why === 'the sorting banks')
check('sidecar: a blueprint without one protects nothing',
  protect.boxesFor(blueprints.resolve('plain')).length === 0)

// A box written back-to-front still describes the same volume.
put('sorter/reversed.schem')
put('sorter/reversed.protect.json', JSON.stringify({ protect: [{ from: { x: 20, y: 6, z: 20 }, to: { x: 10, y: 2, z: 10 } }] }))
const rev = protect.boxesFor(blueprints.resolve('reversed'))[0]
check('sidecar: from/to are normalised, so a reversed box still guards',
  rev.from.x === 10 && rev.to.x === 20)

// --- overlap maths ----------------------------------------------------------
const vol = { lo: { x: 100, y: 10, z: 100 }, hi: { x: 110, y: 20, z: 110 } }
check('overlap: a box inside is caught', protect.overlaps({ lo: { x: 102, y: 12, z: 102 }, hi: { x: 104, y: 14, z: 104 } }, vol))
check('overlap: a box merely touching a face is caught',
  protect.overlaps({ lo: { x: 110, y: 20, z: 110 }, hi: { x: 115, y: 25, z: 115 } }, vol),
  'a build flush against machinery still fills its edge cells')
check('overlap: a box one block clear is not', !protect.overlaps({ lo: { x: 111, y: 21, z: 111 }, hi: { x: 115, y: 25, z: 115 } }, vol))
check('overlap: passing above is not caught', !protect.overlaps({ lo: { x: 100, y: 21, z: 100 }, hi: { x: 110, y: 30, z: 110 } }, vol))

// --- the volume travels with the build --------------------------------------
const journal = require('../src/rcon/journal')
const SERVER = 'test-server'
journal.record(SERVER, { label: 'machine', bounds: { lo: { x: 500, y: 60, z: 500 }, hi: { x: 560, y: 90, z: 560 } }, origin: [500, 60, 500] })
const standing = protect.placed(SERVER)
check('placed: a standing machine contributes its volume', standing.length === 1, JSON.stringify(standing))
check('placed: the volume is offset to where the build actually landed',
  standing[0].lo.x === 510 && standing[0].lo.y === 62 && standing[0].hi.z === 520,
  JSON.stringify(standing[0]))

// the same blueprint placed somewhere else guards there instead
journal.record(SERVER, { label: 'machine', bounds: { lo: { x: 900, y: 70, z: 900 }, hi: { x: 960, y: 100, z: 960 } }, origin: [900, 70, 900] })
check('placed: a second copy guards its own position',
  protect.placed(SERVER).some(p => p.lo.x === 910 && p.lo.y === 72))

// --- the decision -----------------------------------------------------------
check('conflict: a build through the machinery is refused',
  protect.conflicts(SERVER, { lo: { x: 512, y: 63, z: 512 }, hi: { x: 515, y: 66, z: 515 } }).length > 0,
  'this is the case that actually happened')
check('conflict: a build beside it is allowed',
  protect.conflicts(SERVER, { lo: { x: 400, y: 63, z: 400 }, hi: { x: 420, y: 80, z: 420 } }).length === 0)
check('conflict: a build above the machine, not touching it, is allowed',
  protect.conflicts(SERVER, { lo: { x: 510, y: 80, z: 510 }, hi: { x: 520, y: 90, z: 520 } }).length === 0,
  'the hilltop above a buried machine is still buildable')
check('conflict: ignoreId lets a build be re-placed over its own volume',
  protect.conflicts(SERVER, { lo: { x: 512, y: 63, z: 512 }, hi: { x: 515, y: 66, z: 515 } },
    { ignoreId: journal.list(SERVER)[0].id }).length === 0)

// --- failing closed ---------------------------------------------------------
put('sorter/broken.schem')
put('sorter/broken.protect.json', '{ "protect": [ ')
let threw = false
try { protect.boxesFor(blueprints.resolve('broken')) } catch (err) { threw = true }
check('broken: a malformed protect file throws rather than protecting nothing', threw,
  'silently reading "unprotected" is how a machine gets filled through')

journal.record(SERVER, { label: 'broken', bounds: { lo: { x: 0, y: 0, z: 0 }, hi: { x: 9, y: 9, z: 9 } }, origin: [0, 0, 0] })
const withBroken = protect.conflicts(SERVER, { lo: { x: 400, y: 63, z: 400 }, hi: { x: 401, y: 64, z: 401 } })
check('broken: a standing build with an unreadable file blocks every build until fixed',
  withBroken.some(c => c.error), JSON.stringify(withBroken))

fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(journalDir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
