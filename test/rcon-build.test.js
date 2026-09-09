'use strict'

// Offline checks on the RCON build path - the live one, which until now had no
// tests at all: the 15-file suite covers only the retired mineflayer/LLM code.
//
// Everything here runs against a fake rcon that records commands and answers
// them from a script, so no server is touched and no world is written. What is
// asserted is the part that has actually broken builds: the ORDER blocks are
// filled in, and whether the world is allowed to tick while they land.

const assert = require('assert')
const { Vec3 } = require('vec3')
const { phaseOf } = require('../src/building/commander')
const { withFrozenTicks } = require('../src/rcon/clear')
const { fillBlocks } = require('../src/rcon/build')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

// A recording rcon. `replies` maps a substring of the command to the answer.
function fakeRcon (replies = {}) {
  const sent = []
  return {
    sent,
    async send (cmd) {
      sent.push(cmd)
      for (const [needle, reply] of Object.entries(replies)) {
        if (cmd.includes(needle)) return reply
      }
      return 'Changed 1 block'
    },
    close () {}
  }
}

// --- phase order -----------------------------------------------------------
//
// A power source that lands before the mechanism it drives fires into a
// half-built structure. These are the pairs that have actually gone wrong.

check('phase: a redstone block fills after the piston it drives',
  phaseOf('redstone_block') > phaseOf('sticky_piston'),
  `redstone_block=${phaseOf('redstone_block')} sticky_piston=${phaseOf('sticky_piston')}`)

check('phase: a redstone torch fills after its mechanism',
  phaseOf('redstone_torch') > phaseOf('dropper') &&
  phaseOf('redstone_wall_torch') > phaseOf('dispenser'))

check('phase: levers, buttons and plates all count as power',
  ['lever', 'stone_button', 'oak_button', 'stone_pressure_plate', 'heavy_weighted_pressure_plate']
    .every(n => phaseOf(n) === phaseOf('redstone_block')),
  JSON.stringify(['lever', 'stone_button', 'stone_pressure_plate'].map(n => [n, phaseOf(n)])))

check('phase: block state does not change the phase',
  phaseOf('sticky_piston[extended=true,facing=west]') === phaseOf('sticky_piston') &&
  phaseOf('lever[face=wall,powered=true]') === phaseOf('lever'))

check('phase: an attachable fills after the solid it hangs on',
  phaseOf('redstone_wire') > phaseOf('stone') && phaseOf('comparator') > phaseOf('stone'))

check('phase: an observer fills before the dust that sits on top of it',
  phaseOf('observer') < phaseOf('redstone_wire'),
  'dust on an observer needs the observer as support first')

check('phase: liquids fill after everything they could flow into',
  phaseOf('water') > phaseOf('redstone_wire') && phaseOf('lava') > phaseOf('redstone_block'))

check('phase: a nether portal fills last of all',
  phaseOf('nether_portal') > phaseOf('water') && phaseOf('nether_portal') > phaseOf('obsidian'))

// --- the order actually used by a fill -------------------------------------

;(async () => {
  const blocks = [
    { pos: new Vec3(0, 0, 0), name: 'stone' },
    { pos: new Vec3(1, 0, 0), name: 'redstone_block' },
    { pos: new Vec3(2, 0, 0), name: 'sticky_piston[extended=false,facing=east]' },
    { pos: new Vec3(3, 0, 0), name: 'water' },
    { pos: new Vec3(4, 0, 0), name: 'redstone_wire' }
  ]
  const rcon = fakeRcon()
  await fillBlocks(rcon, new Vec3(0, 64, 0), blocks, { label: 'order' })
  // fillCommand emits a leading slash - vanilla rcon accepts it either way.
  const fills = rcon.sent.filter(c => /^\/?fill /.test(c))
  const order = fills.map(c => c.split(' ').slice(7).join(' ').replace(' replace', ''))
  const idx = n => order.findIndex(o => o.startsWith('minecraft:' + n))
  check('fill: sends stone, then the piston, then dust, then power, then water',
    idx('stone') < idx('sticky_piston') &&
    idx('sticky_piston') < idx('redstone_wire') &&
    idx('redstone_wire') < idx('redstone_block') &&
    idx('redstone_block') < idx('water'),
    order.join(' | '))

  // --- withFrozenTicks ----------------------------------------------------

  const running = fakeRcon({ 'tick query': 'The game is running normally', 'tick freeze': 'The game is frozen' })
  const seen = await withFrozenTicks(running, async () => {
    running.sent.push('<body ran here>')
    return 'result'
  })
  check('freeze: returns the body\'s value', seen === 'result')
  check('freeze: freezes before the body and unfreezes after it',
    running.sent.indexOf('tick freeze') < running.sent.indexOf('<body ran here>') &&
    running.sent.indexOf('<body ran here>') < running.sent.indexOf('tick unfreeze'),
    running.sent.join(' | '))

  const already = fakeRcon({ 'tick query': 'The game is frozen' })
  await withFrozenTicks(already, async () => 'x')
  check('freeze: a world that was already frozen is left frozen',
    !already.sent.includes('tick freeze') && !already.sent.includes('tick unfreeze'),
    already.sent.join(' | '))

  const failed = fakeRcon({ 'tick query': 'Unknown or incomplete command', 'tick freeze': 'Unknown or incomplete command' })
  const out = await withFrozenTicks(failed, async () => 'built anyway')
  check('freeze: a server with no /tick still builds, and is not unfrozen',
    out === 'built anyway' && !failed.sent.includes('tick unfreeze'),
    failed.sent.join(' | '))

  const throwing = fakeRcon({ 'tick query': 'The game is running normally', 'tick freeze': 'The game is frozen' })
  await assert.rejects(() => withFrozenTicks(throwing, async () => { throw new Error('fill blew up') }))
  check('freeze: unfreezes even when the build throws',
    throwing.sent.includes('tick unfreeze'),
    throwing.sent.join(' | '))

  // --- an empty block list is not a build ---------------------------------

  const empty = fakeRcon()
  const stats = await fillBlocks(empty, new Vec3(0, 64, 0), [], { label: 'nothing' })
  check('fill: an empty list sends no commands and reports null bounds',
    stats.cells === 0 && stats.bounds === null && empty.sent.length === 0)

  // --- injection guard on the live path -----------------------------------

  const hostile = fakeRcon()
  const dropped = await fillBlocks(hostile, new Vec3(0, 64, 0), [
    { pos: new Vec3(0, 0, 0), name: 'stone] ; /op someone' },
    { pos: new Vec3(1, 0, 0), name: 'stone' }
  ], { label: 'hostile' })
  check('fill: a block spec that is not a block spec never reaches a command',
    dropped.rejected === 1 && dropped.cells === 1 &&
    !hostile.sent.some(c => c.includes('/op')),
    hostile.sent.join(' | '))

  // --- the gamerule rename ------------------------------------------------
  //
  // 26.2 calls it block_drops; 26.1 and earlier call it doTileDrops, and neither
  // server accepts the other's name. The module caches its answer, so each case
  // needs a fresh copy of it.
  const freshClear = () => {
    delete require.cache[require.resolve('../src/rcon/clear')]
    return require('../src/rcon/clear')
  }
  const REJECT = 'Incorrect argument for command'

  const modern = fakeRcon({ 'gamerule doTileDrops': REJECT, 'gamerule block_drops': 'Gamerule block_drops is currently set to: true' })
  const c1 = freshClear()
  check('gamerule: a 26.2 server resolves to block_drops',
    (await c1.dropRule(modern)) === 'block_drops', modern.sent.join(' | '))

  const legacy = fakeRcon({ 'gamerule block_drops': REJECT, 'gamerule doTileDrops': 'Gamerule doTileDrops is currently set to: true' })
  const c2 = freshClear()
  check('gamerule: an older server falls back to doTileDrops',
    (await c2.dropRule(legacy)) === 'doTileDrops', legacy.sent.join(' | '))

  const modern2 = fakeRcon({ 'gamerule doTileDrops': REJECT, 'gamerule block_drops': 'Gamerule block_drops is currently set to: true' })
  const c3 = freshClear()
  await c3.withoutDrops(modern2, async () => 'cleared')
  check('gamerule: withoutDrops turns the resolved rule off and back on',
    modern2.sent.includes('gamerule block_drops false') &&
    modern2.sent.includes('gamerule block_drops true') &&
    !modern2.sent.includes('gamerule doTileDrops false'),
    modern2.sent.join(' | '))

  const neither = fakeRcon({ 'gamerule': REJECT })
  const c4 = freshClear()
  const ran = await c4.withoutDrops(neither, async () => 'still cleared')
  check('gamerule: a server with neither name still clears, with drops left on',
    ran === 'still cleared' && !neither.sent.some(c => / false$/.test(c)),
    neither.sent.join(' | '))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
