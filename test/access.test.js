'use strict'

// Who may drive the bot.
//
// RCON is console level: whoever gets a !build line into the server log is
// issuing /fill as the server itself. So every case here is a security case,
// and the two that matter most are the ones where something is MISSING - an
// unreadable ops.json must not fail open, and an empty allow list must not
// either.

const fs = require('fs')
const os = require('os')
const path = require('path')
const access = require('../src/rcon/access')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-test-'))
const opsFile = path.join(dir, 'ops.json')
const writeOps = list => fs.writeFileSync(opsFile, JSON.stringify(list))

writeOps([
  { uuid: '9b55a600-0000-0000-0000-000000000000', name: 'Owner', level: 4, bypassesPlayerLimit: false },
  { uuid: '00000000-0000-0000-0000-000000000001', name: 'Helper', level: 2, bypassesPlayerLimit: false }
])

const P = extra => access.policy(Object.assign({ ops: opsFile }, extra), 'test')

// --- default: the server's own operators ------------------------------------
const ops = P({ allow: [] })
check('default mode is "ops"', ops.mode === 'ops', ops.mode)
check('ops: an opped player may build', ops.isAllowed('Owner'))
check('ops: a second op may build too', ops.isAllowed('Helper'))
check('ops: a random player may not', ops.isAllowed('Randomer') === false,
  'this is the whole point of the default')
check('ops: names match case-insensitively (Minecraft names are not case-sensitive in ops.json)',
  ops.isAllowed('owner') && ops.isAllowed('OWNER'))

// --- the allow list is additive, so a non-OP can be let in ------------------
const both = P({ allow: ['Friend'] })
check('allow+ops: a listed non-OP may build', both.isAllowed('Friend'),
  'this is how a server owner grants access without opping someone')
check('allow+ops: ops still may', both.isAllowed('Owner'))
check('allow+ops: everyone else still may not', both.isAllowed('Randomer') === false)

// --- everyone ---------------------------------------------------------------
const open = P({ access: 'everyone', allow: [] })
check('everyone: any player may build', open.isAllowed('Randomer') && open.isAllowed('Someone'))
check('everyone: says so loudly at startup',
  open.notes.some(n => /ANY player/.test(n)) && open.notes.some(n => /console level/.test(n)),
  'an operator must not discover this mode by being griefed')

// --- allow only -------------------------------------------------------------
const strict = P({ access: 'allow', allow: ['Owner'] })
check('allow: the listed name may build', strict.isAllowed('Owner'))
check('allow: an OP not on the list may NOT build', strict.isAllowed('Helper') === false,
  '"allow" is the tightest mode - being opped is not enough')

// --- failure modes: these must never fail open ------------------------------
const noFile = access.policy({ ops: path.join(dir, 'nope.json'), allow: ['Owner'] }, 'test')
check('missing ops.json: falls back to the allow list, not to everyone',
  noFile.isAllowed('Owner') === true && noFile.isAllowed('Randomer') === false)
check('missing ops.json: explains itself and names the fix',
  noFile.notes.some(n => /is it mounted/.test(n)) && noFile.notes.some(n => /compose\.yml/.test(n)),
  'silently ignoring everyone is the failure that wastes an afternoon')

const nothing = access.policy({ ops: path.join(dir, 'nope.json'), allow: [] }, 'test')
check('missing ops.json AND empty allow: refuses everyone',
  nothing.isAllowed('Owner') === false && nothing.isAllowed('Randomer') === false,
  'fail closed - RCON is console level')
check('refusing everyone is stated, not silent',
  nothing.notes.some(n => /refusing every builder/.test(n)))

fs.writeFileSync(opsFile, 'not json at all')
const broken = access.policy({ ops: opsFile, allow: ['Owner'] }, 'test')
check('corrupt ops.json: falls back rather than crashing or opening up',
  broken.isAllowed('Owner') === true && broken.isAllowed('Randomer') === false)

const bogus = P({ access: 'sudo-mode', allow: ['Owner'] })
check('an unknown access mode falls back to "allow", not to "everyone"',
  bogus.mode === 'allow' && bogus.isAllowed('Randomer') === false,
  'a typo in config must never widen access')
check('the unknown mode is reported', bogus.notes.some(n => /unknown access mode/.test(n)))

// --- operators: who may remove someone else's build -------------------------
writeOps([{ uuid: 'x', name: 'Owner', level: 4 }])
const rm = P({ allow: ['Friend'] })
check('operator: a server op may remove other people\'s builds', rm.isOperator('Owner'))
check('operator: a merely-allowed player may not', rm.isOperator('Friend') === false)
const explicit = P({ allow: ['Friend'], operators: ['Friend'] })
check('operator: an explicit operators list wins over ops.json',
  explicit.isOperator('Friend') === true && explicit.isOperator('Owner') === false)
const solo = access.policy({ ops: false, allow: ['Solo'] }, 'test')
check('operator: with no ops file, the first allow entry is the operator',
  solo.isOperator('Solo'), 'a single-player setup needs no extra config')

// --- /op takes effect without a restart -------------------------------------
writeOps([{ uuid: 'x', name: 'Owner', level: 4 }])
const live = P({ allow: [] })
check('live: a newly opped player is not yet allowed', live.isAllowed('Latecomer') === false)
// Same policy object, file changed underneath - mtime must be seen.
const later = Date.now() + 2000
writeOps([{ uuid: 'x', name: 'Owner', level: 4 }, { uuid: 'y', name: 'Latecomer', level: 4 }])
fs.utimesSync(opsFile, later / 1000, later / 1000)
check('live: /op is picked up without restarting the bot', live.isAllowed('Latecomer') === true,
  'ops.json is re-read when its mtime changes')

fs.rmSync(dir, { recursive: true, force: true })

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
