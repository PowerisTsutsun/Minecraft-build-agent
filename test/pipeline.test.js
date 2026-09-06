'use strict'

// The pipeline's contracts, without spending a model call.
//
// What matters here is not that the critic and detailer produce good output -
// that is a judgement call and costs money to test - but that whatever they
// produce goes through the same gate as everything else. A last pass that could
// bypass validation would be the one place unchecked model output reaches the
// world.

const detailer = require('../src/pipeline/detailer')
const critic = require('../src/pipeline/critic')
const pipeline = require('../src/pipeline')
const primitives = require('../src/building/primitives')
const { validatePlan, renderPlan } = require('../src/commands/llm')
const mcData = require('minecraft-data')('26.1')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}
const real = n => Boolean(mcData.blocksByName[n.split('[')[0]])

// A fake client that returns whatever tool input we hand it.
function fakeClient (toolName, input, text) {
  return {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...(input ? [{ type: 'tool_use', name: toolName, id: 't1', input }] : [])
        ]
      })
    }
  }
}

const someBlocks = (() => {
  const v = validatePlan({
    summary: 'x',
    shell: [{ op: 'box', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', width: 9, depth: 9, height: 6, hollow: true }]
  }, real)
  return renderPlan(v, primitives, { isKnownBlock: real }).blocks
})()

// --- detailer --------------------------------------------------------------
;(async () => {
  const tooMany = { details: Array.from({ length: 40 }, (_, i) => ({ op: 'blocks', material: 'oak_planks', offset: { x: i, y: 0, z: 0 }, cells: [{ x: 0, y: 0, z: 0 }] })) }
  const capped = await detailer.detail(fakeClient('submit_details', tooMany), 'm', someBlocks, 'r', 's')
  check('detailer: caps the number of touches',
    capped.details.length === detailer.MAX_TOUCHES, `${capped.details.length}`)

  const outOfVocab = {
    details: [
      { op: 'blocks', material: 'oak_planks', offset: { x: 0, y: 0, z: 0 }, cells: [{ x: 0, y: 0, z: 0 }] },
      { op: 'box', material: 'stone', offset: { x: 0, y: 0, z: 0 }, width: 40, depth: 40, height: 40 },
      { op: 'tower', offset: { x: 0, y: 0, z: 0 }, diameter: 9, height: 30 }
    ]
  }
  const filtered = await detailer.detail(fakeClient('submit_details', outOfVocab), 'm', someBlocks, 'r', 's')
  check('detailer: drops ops outside its vocabulary',
    filtered.details.length === 1 && filtered.details[0].op === 'blocks',
    filtered.details.map(d => d.op).join(','))
  check('detailer: reports what it dropped', filtered.dropped === 2, `${filtered.dropped}`)

  const none = await detailer.detail(fakeClient('submit_details', { details: [] }), 'm', someBlocks, 'r', 's')
  check('detailer: an empty list is fine', none.details.length === 0)

  // --- critic --------------------------------------------------------------
  const verdict = await critic.critique(
    fakeClient(null, null, '- The two towers are the same height.\n- The south wall is blank.\n- ok'),
    'm', someBlocks, 'a keep')
  check('critic: parses one problem per line', verdict.problems.length === 2, JSON.stringify(verdict.problems))
  check('critic: drops filler lines', !verdict.problems.some(p => p === 'ok'))

  const happy = await critic.critique(
    fakeClient(null, null, 'The build looks good. Nothing to fix.'),
    'm', someBlocks, 'a keep')
  check('critic: a clean verdict yields no problems', happy.problems.length === 0, JSON.stringify(happy.problems))

  // --- the gate ------------------------------------------------------------
  // A detail that would not validate must be refused, and the build must keep
  // the plan it already had.
  let rendered = null
  const rebuilt = []
  const state = await pipeline.runMake({
    request: 'x',
    fast: true,
    check: () => { rendered = { plan: { summary: 'x', actions: [] }, out: { blocks: someBlocks, errors: [], warnings: [], drops: 0 } }; return { errors: [] } },
    rendered: () => rendered,
    reRender: extra => { rebuilt.push(extra); return null }, // pretend validation refused it
    client: null,
    model: 'm'
  })
  check('pipeline: --fast skips the critic and the detailer',
    !state.problems.length && !state.detailed && rebuilt.length === 0)
  check('pipeline: returns the rendered plan', state.out && state.out.blocks.length > 0)

  console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
