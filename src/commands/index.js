'use strict'

const { Vec3 } = require('vec3')
const primitives = require('../building/primitives')
const placer = require('../building/placer')
const session = require('../building/session')
const { undoLastBuild } = require('../building/undo')
const { loadSchematic, schematicToBlocks, listSchematics } = require('../building/schematic')
const llm = require('./llm')
const style = require('./style')
const plans = require('../plans')
const pipeline = require('../pipeline')
const inspector = require('../pipeline/inspector')
const templates = require('../building/templates')
const classify = require('../pipeline/classify')
const { configureMovements, isKnownBlock } = require('../bot')
const commander = require('../building/commander')
const { SCAFFOLD_BLOCK, MAX_SIZE, MAX_BLOCKS, DEFAULTS, BUILD_MODE } = require('../config')

// ---------------------------------------------------------------------------
// Chat command dispatch.
//
//   !build house <w> <d> <h> [material]
//   !build floor <w> <d> [material]
//   !build wall <length> <height> [material] [x|z]
//   !build box <w> <d> <h> [material] [solid]
//   !build sphere <radius> [material] [solid]
//   !schem <name> | !schem list
//   !make <plain english>          - asks Claude for a plan
//   !dry [on|off]                  - dry-run toggle
//   !undo                          - roll back the last build
//   !stop | !resetbuild | !help
//
// Chat messages are capped at 256 characters by the server, so chat gets short
// summaries and the full detail (every planned placement, every error) goes to
// the container log - `docker logs -f mc-builder-bot`.
// ---------------------------------------------------------------------------

const state = {
  building: false,
  cancelled: false,
  dryRun: false,
  lastPlan: null,    // the last validated !make plan, for !remember
  lastRequest: null
}

function register (bot) {
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return
    const args = message.trim().split(/\s+/)
    const cmd = args[0]

    try {
      switch (cmd) {
        case '!help': return help(bot)
        case '!dry': return toggleDry(bot, args[1])
        case '!stop': return stop(bot)
        case '!resetbuild': return resetBuild(bot)
        case '!undo': return await undo(bot)
        case '!schem': return await schem(bot, args, username)
        case '!style': return showStyle(bot)
        case '!remember': return remember(bot, args[1])
        case '!forget': return forget(bot, args[1])
        case '!export': return await exportTemplate(bot, args[1], username)
        case '!template': return await template(bot, args, username)
        case '!make': return await make(bot, args.slice(1).join(' '), username)
        case '!build': return await build(bot, args, username)
      }
    } catch (err) {
      console.error(`[${cmd}]`, err)
      say(bot, `Error: ${err.message}`)
      state.building = false
      state.cancelled = false
    }
  })
}

// The server truncates long chat lines, and a multi-line string sent as one
// chat message is rejected outright - so split and cap.
function say (bot, text) {
  for (const line of String(text).split('\n')) {
    if (line.trim()) bot.chat(line.slice(0, 250))
  }
}

function help (bot) {
  say(bot, 'Shapes: house floor wall box sphere cylinder cone pyramid gable arch stairs spiral. Also !make <description>, !schem <name>, !dry, !undo, !stop')
  say(bot, 'Machines: !template list | !template place <name> | !export <name> at two corners to capture one that works.')
  say(bot, 'Teach me: !remember <name> keeps the last !make as an example to build like. !style shows what I have learned. !forget <name> drops one.')
}

function toggleDry (bot, arg) {
  if (arg === 'on') state.dryRun = true
  else if (arg === 'off') state.dryRun = false
  else state.dryRun = !state.dryRun
  say(bot, `Dry run ${state.dryRun ? 'ON - I will plan but not place. Full plan goes to the container log.' : 'OFF - builds will actually place blocks.'}`)
}

function stop (bot) {
  if (!state.building) return say(bot, 'Not building anything.')
  state.cancelled = true
  say(bot, 'Stopping after this block.')
}

function resetBuild (bot) {
  if (state.building) return say(bot, 'Still building - !stop first.')
  session.clearOrigin()
  say(bot, 'Cleared saved build spot - next build starts fresh wherever I am standing.')
}

async function undo (bot) {
  if (state.building) return say(bot, 'Still building - !stop first.')

  const build = session.lastBuild()
  if (!build || !build.blocks.length) return say(bot, 'Nothing to undo.')

  state.building = true
  state.cancelled = false
  say(bot, `Undoing "${build.label}" - ${build.blocks.length} blocks. This takes about as long as the build did.`)

  try {
    const stats = await undoLastBuild(bot, {
      onProgress: (i, total) => say(bot, `...undone ${i}/${total}`),
      shouldCancel: () => state.cancelled
    })

    const parts = [`${stats.removed} removed`]
    if (stats.changed) parts.push(`${stats.changed} left alone (changed since)`)
    if (stats.failed) parts.push(`${stats.failed} unreachable`)
    say(bot, `Undo done: ${parts.join(', ')}.`)

    // Only invite another pass if this one actually got somewhere. Telling the
    // player to "run !undo again" after a pass that removed nothing is an
    // instruction to repeat a failure forever - say it's stuck instead.
    if (stats.remaining && stats.removed > 0) {
      say(bot, `${stats.remaining} left - run !undo again to continue.`)
    } else if (stats.remaining) {
      say(bot, `Stuck on the last ${stats.remaining} - I can't reach them. Clear them by hand; I've dropped them from the undo log.`)
      session.updateLastBuild([])
    }
    if (stats.restored) {
      say(bot, `Put back ${stats.restored} block${stats.restored === 1 ? '' : 's'} of the original terrain too.`)
    } else if (stats.destroyed && stats.destroyed.size) {
      say(bot, `Note: I can't restore what the build dug out (${[...stats.destroyed].join(', ')}) - you get the hole back, not the terrain.`)
    }
    // Builds now sweep their own scaffolding when they finish, so there is
    // normally nothing left for undo to miss. Anything built before that swept
    // is the exception, and it is not worth a scary message on every rollback.
  } finally {
    state.building = false
    state.cancelled = false
  }
}

// ---------------------------------------------------------------------------
// Primitive builds.
// ---------------------------------------------------------------------------
async function build (bot, args, requester) {
  const shape = args[1]
  const material = m => (isKnownBlock(bot, m) ? m : null)

  let blocks
  let label

  if (shape === 'house') {
    const w = clamp(args[2], DEFAULTS.width)
    const d = clamp(args[3], DEFAULTS.depth)
    const h = clamp(args[4], DEFAULTS.height)
    const mat = material(args[5] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[5]}".`)
    blocks = primitives.house({ width: w, depth: d, height: h, wallBlock: mat, floorBlock: mat, roofBlock: mat })
    label = `house ${w}x${d}x${h} ${mat}`
  } else if (shape === 'floor') {
    const w = clamp(args[2], DEFAULTS.width)
    const d = clamp(args[3], DEFAULTS.depth)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    blocks = primitives.floor({ width: w, depth: d, material: mat })
    label = `floor ${w}x${d} ${mat}`
  } else if (shape === 'wall') {
    const len = clamp(args[2], DEFAULTS.width)
    const h = clamp(args[3], DEFAULTS.height)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    const axis = args[5] === 'z' ? 'z' : 'x'
    blocks = primitives.wall({ length: len, height: h, material: mat, axis })
    label = `wall ${len}x${h} ${mat} along ${axis}`
  } else if (shape === 'box') {
    const w = clamp(args[2], DEFAULTS.width)
    const d = clamp(args[3], DEFAULTS.depth)
    const h = clamp(args[4], DEFAULTS.height)
    const mat = material(args[5] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[5]}".`)
    const hollow = args[6] !== 'solid'
    blocks = primitives.box({ width: w, depth: d, height: h, material: mat, hollow })
    label = `${hollow ? 'hollow' : 'solid'} box ${w}x${d}x${h} ${mat}`
  } else if (shape === 'sphere') {
    const r = clamp(args[2], 4)
    const mat = material(args[3] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[3]}".`)
    const hollow = args[4] !== 'solid'
    blocks = primitives.sphere({ radius: r, material: mat, hollow })
    label = `${hollow ? 'hollow' : 'solid'} sphere r${r} ${mat}`
  } else if (shape === 'cylinder') {
    const r = clamp(args[2], 4)
    const h = clamp(args[3], DEFAULTS.height)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    const hollow = args[5] !== 'solid'
    blocks = primitives.cylinder({ radius: r, height: h, material: mat, hollow, axis: 'y' })
    label = `${hollow ? 'hollow' : 'solid'} cylinder r${r}x${h} ${mat}`
  } else if (shape === 'cone') {
    const r = clamp(args[2], 4)
    const h = clamp(args[3], DEFAULTS.height)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    const hollow = args[5] !== 'solid'
    blocks = primitives.cone({ radius: r, height: h, material: mat, hollow })
    label = `${hollow ? 'hollow' : 'solid'} cone r${r}x${h} ${mat}`
  } else if (shape === 'pyramid') {
    const w = clamp(args[2], DEFAULTS.width)
    const d = clamp(args[3], DEFAULTS.depth)
    const h = clamp(args[4], DEFAULTS.height)
    const mat = material(args[5] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[5]}".`)
    const hollow = args[6] === 'hollow'
    blocks = primitives.pyramid({ width: w, depth: d, height: h, material: mat, hollow })
    label = `pyramid ${w}x${d}x${h} ${mat}`
  } else if (shape === 'gable') {
    const w = clamp(args[2], DEFAULTS.width)
    const d = clamp(args[3], DEFAULTS.depth)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    const axis = args[5] === 'z' ? 'z' : 'x'
    blocks = primitives.gable({ width: w, depth: d, material: mat, axis })
    label = `gable roof ${w}x${d} ${mat} along ${axis}`
  } else if (shape === 'arch') {
    const w = clamp(args[2], 5)
    const h = clamp(args[3], DEFAULTS.height)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    const thickness = clamp(args[5], 1)
    const axis = args[6] === 'z' ? 'z' : 'x'
    blocks = primitives.arch({ width: w, height: h, depth: thickness, material: mat, axis })
    label = `arch ${w}x${h} ${mat}`
  } else if (shape === 'spiral') {
    const r = clamp(args[2], 4)
    const h = clamp(args[3], 10)
    const mat = material(args[4] || DEFAULTS.material)
    if (!mat) return say(bot, `I don't know a block called "${args[4]}".`)
    blocks = primitives.spiral({ radius: r, height: h, material: mat })
    label = `spiral stair r${r}x${h} ${mat}`
  } else {
    return say(bot, 'Usage: !build house|floor|wall|box|sphere|cylinder|cone|pyramid|gable|arch|spiral ... - try !help')
  }

  await runBuild(bot, blocks, label, requester)
}

// ---------------------------------------------------------------------------
// Schematics.
// ---------------------------------------------------------------------------
async function schem (bot, args, requester) {
  const name = args[1]

  if (!name || name === 'list') {
    const files = await listSchematics()
    return say(bot, files.length ? `Schematics: ${files.join(', ')}` : 'No schematics found in /schematics.')
  }

  say(bot, `Loading ${name}...`)
  let loaded
  try {
    loaded = await loadSchematic(name, bot.version)
  } catch (err) {
    return say(bot, `Couldn't load "${name}": ${err.message}`)
  }

  const { blocks, size, skipped } = schematicToBlocks(loaded)
  if (!blocks.length) return say(bot, `"${name}" has no non-air blocks.`)
  if (skipped) say(bot, `(${skipped} blocks in the file couldn't be read - skipping those.)`)
  say(bot, `${name}: ${size.width}x${size.height}x${size.depth}, ${blocks.length} blocks. Orientation of stairs/doors won't survive - the bot can only place plain blocks.`)

  await runBuild(bot, blocks, `schematic ${name}`, requester)
}

// ---------------------------------------------------------------------------
// Natural language.
// ---------------------------------------------------------------------------
async function make (bot, request, requester) {
  if (!request) return say(bot, 'Usage: !make a small stone tower with a glass roof')
  if (state.building) return say(bot, 'Already building - say !stop first.')

  say(bot, 'Thinking...')

  // Architectural or functional? They need opposite treatment: a keep should be
  // invented and dressed, a farm should be placed exactly as someone proved it
  // works. Inventing a farm produces a farm-shaped building that makes nothing,
  // and reports success while doing it.
  let kind = { kind: 'architectural' }
  try {
    kind = await classify.classify(request, llm.getClient(), llm.MODEL)
  } catch (err) {
    console.error('[classify] defaulting to architectural:', err.message)
  }

  if (kind.kind === 'functional') {
    if (kind.template) {
      say(bot, `That is a machine, and I have a "${kind.template}" template - placing it rather than inventing one.`)
      return await placeTemplate(bot, kind.template, requester)
    }
    // No template. Say so plainly rather than building something that looks
    // right and does nothing.
    const have = templates.list()
    say(bot, `That is a mechanism, not a building, and I have no template for it${have.length ? ` (I have: ${have.join(', ')})` : ''}.`)
    say(bot, 'I can only invent the shape, not make it work - the redstone and mob mechanics need a proven design.')
    say(bot, 'Build one that works, then !export <name> at two opposite corners and I will place it exactly from then on.')
    return
  }

  // One check, used both to accept a plan and to tell the model what to fix.
  // Validation and the render lint are the same gate: an invented block id and
  // a wall that buries its own doorway are both things a second attempt can
  // put right, and neither is worth failing a build over.
  let rendered = null
  const run = plans.startRun(request)
  let attemptNo = 0
  const check = raw => {
    attemptNo++
    const plan = llm.validatePlan(raw, name => isKnownBlock(bot, name))
    if (plan.errors.length) { run.attempt(attemptNo, raw, plan.errors); return { errors: plan.errors } }
    let out
    try {
      out = llm.renderPlan(plan, primitives, { isKnownBlock: n => isKnownBlock(bot, n) })
    } catch (err) {
      run.attempt(attemptNo, raw, [err.message])
      return { errors: [err.message] }
    }
    if (out.errors.length) { run.attempt(attemptNo, raw, out.errors); return { errors: out.errors, plan } }
    run.attempt(attemptNo, raw, [])
    rendered = { plan, out }
    lastRaw = raw
    return { errors: [], plan, out }
  }

  // --fast skips the critic, which is the only step that costs an extra call.
  const fast = /(^|\s)--fast(\s|$)/.test(request)
  const cleanRequest = request.replace(/(^|\s)--fast(\s|$)/, ' ').trim()

  // The detailer's actions go back through exactly the same gate as everything
  // else - validation, protection, the lints. A last pass that could bypass
  // them would be the one place in the pipeline where unchecked model output
  // reaches the world.
  let lastRaw = null
  const reRender = extraDetails => {
    if (!lastRaw) return null
    const merged = {
      ...lastRaw,
      details: [...(lastRaw.details || []), ...extraDetails]
    }
    const plan = llm.validatePlan(merged, name => isKnownBlock(bot, name))
    if (plan.errors.length) {
      console.error('[detailer] rejected:', plan.errors.slice(0, 2).join('; '))
      return null
    }
    try {
      const out = llm.renderPlan(plan, primitives, { isKnownBlock: n => isKnownBlock(bot, n) })
      if (out.errors.length) {
        console.error('[detailer] rejected:', out.errors[0])
        return null
      }
      return { plan, out }
    } catch (err) {
      console.error('[detailer] rejected:', err.message)
      return null
    }
  }

  let attempt
  try {
    attempt = await pipeline.runMake({
      reRender,
      request: cleanRequest,
      check,
      archive: run,
      fast,
      client: fast ? null : llm.getClient(),
      model: llm.MODEL,
      say: text => say(bot, text),
      rendered: () => rendered
    })
  } catch (err) {
    return say(bot, `Couldn't get a plan: ${err.message}`)
  }

  if (attempt.failed || !rendered) {
    run.rejected(attempt.plan, attempt.failed || ['no plan'])
    console.error('[!make] rejected plan:', JSON.stringify(attempt.plan, null, 2))
    say(bot, `That plan didn't check out after ${attempt.attempts} attempt${attempt.attempts === 1 ? '' : 's'}: ${(attempt.failed || []).slice(0, 2).join('; ')}`)
    return
  }

  const plan = attempt.plan
  const out = attempt.out
  const blocks = out.blocks

  if (attempt.attempts > 1) say(bot, `(took ${attempt.attempts} attempts - I sent the problems back and it fixed them.)`)
  if (attempt.revised) say(bot, `Revised it after a look: ${attempt.problems.length} thing${attempt.problems.length === 1 ? '' : 's'} to fix.`)
  if (attempt.detailed) say(bot, `Added ${attempt.detailed} finishing touch${attempt.detailed === 1 ? '' : 'es'}${attempt.detailNote ? ' - ' + attempt.detailNote : ''}`)
  for (const problem of attempt.problems) console.log(`[critic] ${problem}`)
  if (plan.reordered) console.log('[!make] moved the staircase to the end of the plan')
  if (plan.dropped) console.log(`[!make] dropped ${plan.dropped} repeated action(s)`)
  for (const w of out.warnings) console.log(`[!make] ${w}`)
  if (out.decor && Object.keys(out.decor).length) {
    console.log('[!make] decorator:', Object.entries(out.decor).map(([k, v]) => `${k} ${v}`).join(', '))
  }

  run.accepted(plan, out)
  console.log(`[!make] archived to plans/${run.id}/`)
  state.lastPlan = plan
  state.lastRequest = request
  say(bot, `Plan: ${plan.summary}`)
  console.log('[!make] validated plan:', JSON.stringify(plan.actions, null, 2))
  await runBuild(bot, blocks, `make: ${request}`.slice(0, 80), requester, run, out.treads)
}

// ---------------------------------------------------------------------------
// Teaching. The player edits style/guide.md for standing instructions, and
// keeps builds they liked with !remember - both are fed back into the planner's
// prompt on the next build.
// ---------------------------------------------------------------------------
function showStyle (bot) {
  const s = style.describe()
  const guide = s.guide ? `${s.guide} chars of guide.md` : 'no guide.md yet'
  if (!s.examples.length) {
    return say(bot, `Style: ${guide}, no saved examples. Build something with !make, then !remember <name> to keep it as an example.`)
  }
  say(bot, `Style: ${guide}. Examples: ${s.examples.join(', ')}.`)
  say(bot, `Using the newest ${s.used.length}: ${s.used.join(', ')}.`)
}

function remember (bot, name) {
  if (!name) return say(bot, 'Usage: !remember <name> - keeps the last !make plan as an example to build like.')
  if (!state.lastPlan) return say(bot, 'Nothing to remember yet - run a !make first.')
  try {
    const saved = style.saveExample(name, state.lastRequest, state.lastPlan)
    say(bot, `Saved "${name}" (${saved.actions} actions). I will build in that style from now on - !style to see everything I know.`)
  } catch (err) {
    say(bot, `Couldn't save that: ${err.message}`)
  }
}

function forget (bot, name) {
  if (!name) return say(bot, 'Usage: !forget <name> - see !style for the list.')
  try {
    style.forgetExample(name)
    say(bot, `Forgot "${name}".`)
  } catch (err) {
    say(bot, `Couldn't forget "${name}": ${err.message}`)
  }
}


// ---------------------------------------------------------------------------
// Templates. A build that has to WORK is not planned - it is placed from a
// design someone proved, and its entities are summoned by a setup script.
// ---------------------------------------------------------------------------
function templateList (bot) {
  const names = templates.list()
  if (!names.length) {
    return say(bot, 'No templates yet. Build something that works, stand at one corner, !export <name>, then walk to the opposite corner and !export <name> again.')
  }
  say(bot, `Templates: ${names.join(', ')}`)
  for (const name of names.slice(0, 3)) {
    const info = templates.describe(name)
    const s = info.meta.size
    say(bot, `  ${name}: ${s ? `${s.x}x${s.y}x${s.z}` : '?'}, ${info.setup.length} setup command${info.setup.length === 1 ? '' : 's'}`)
  }
}

// Two calls mark the corners, which is the only way to pick a region in chat
// without a selection tool.
const exportCorners = new Map()

async function exportTemplate (bot, name, requester) {
  if (!name) return say(bot, 'Usage: !export <name> - call it twice, at opposite corners of the region.')
  if (!templates.NAME.test(name)) return say(bot, 'A template name is lowercase letters, digits, - or _')

  const player = bot.players[requester]
  const at = player && player.entity ? player.entity.position.floored() : bot.entity.position.floored()

  const first = exportCorners.get(name)
  if (!first) {
    exportCorners.set(name, at)
    return say(bot, `Corner one of "${name}" at (${at.x}, ${at.y}, ${at.z}). Walk to the opposite corner and !export ${name} again.`)
  }

  exportCorners.delete(name)
  say(bot, `Corner two at (${at.x}, ${at.y}, ${at.z}) - reading the region...`)
  try {
    const meta = await templates.exportRegion(bot, name, first, at)
    say(bot, `Saved "${name}": ${meta.size.x}x${meta.size.y}x${meta.size.z}, ${meta.blocks} blocks.`)
    const notable = Object.keys(meta.notable || {})
    if (notable.length) say(bot, `Mechanism parts captured: ${notable.slice(0, 6).join(', ')}`)
    say(bot, `Add the /summon lines to templates/${name}/setup.txt - blocks alone will not make it run.`)
  } catch (err) {
    say(bot, `Couldn't export: ${err.message}`)
  }
}

async function template (bot, args, requester) {
  const verb = args[1]
  if (!verb || verb === 'list') return templateList(bot)
  if (verb === 'place') return await placeTemplate(bot, args[2], requester)
  if (verb === 'import') return say(bot, `Use !export ${args[2] || '<name>'} at two opposite corners - that is the import.`)
  say(bot, 'Usage: !template list | !template place <name>')
}

async function placeTemplate (bot, name, requester) {
  if (!name) return say(bot, 'Usage: !template place <name>')
  if (state.building) return say(bot, 'Already building - say !stop first.')

  let info
  try {
    info = await templates.load(name, bot.version)
  } catch (err) {
    return say(bot, `Couldn't load "${name}": ${err.message}`)
  }

  const { blocks, skipped } = templates.schematicToBlocks(info.schematic)
  if (!blocks.length) return say(bot, `"${name}" has no blocks in it.`)
  if (skipped) say(bot, `(${skipped} blocks in the file could not be read.)`)

  say(bot, `Placing ${name}: ${blocks.length} blocks.`)
  const origin = await runBuild(bot, blocks, `template ${name}`, requester, null)

  // The blocks are only half of a working machine.
  if (info.setup.length && state.lastOrigin) {
    const commands = templates.setupCommands(info, state.lastOrigin)
    say(bot, `Running ${commands.length} setup command${commands.length === 1 ? '' : 's'} - villagers, mobs, chest contents.`)
    for (const command of commands) {
      bot.chat(command.startsWith('/') ? command : `/${command}`)
      await bot.waitForTicks(4)
    }
    say(bot, 'Setup done. Give it a few minutes before judging whether it runs.')
  } else if (!info.setup.length) {
    say(bot, `No setup commands for "${name}" - if it needs villagers or mobs, add them to templates/${name}/setup.txt`)
  }
  return origin
}

// ---------------------------------------------------------------------------
// Shared build runner: origin, material check, dry-run, execution, reporting.
// ---------------------------------------------------------------------------
async function runBuild (bot, blocks, label, requester, buildRun, treads) {
  if (state.building) return say(bot, 'Already building - say !stop first.')
  if (blocks.length > MAX_BLOCKS) {
    return say(bot, `That's ${blocks.length} blocks, over the ${MAX_BLOCKS} cap.`)
  }

  const materials = [...placer.countMaterials(blocks).keys()]
  configureMovements(bot, materials)

  // Go to whoever asked. The bot used to build wherever it happened to be
  // standing, which is wherever its last build left it - so a request typed
  // from spawn got built 280 blocks away, out of sight, and looked exactly
  // like a bot that was ignoring the command. /tp by name (not by coordinates)
  // because a player outside view distance has no loaded entity to read a
  // position from. It also loads the chunks that /fill refuses to work without.
  let here = bot.entity.position
  if (requester && BUILD_MODE !== 'survival') {
    try {
      here = await commander.teleportToPlayer(bot, requester)
    } catch (err) {
      console.error('[build] could not teleport to requester:', err.message)
    }
  }

  // Build alongside the player, not on top of them, so nobody gets walled in.
  // Ground Y comes from scanning downward, NOT from bot.entity.position.y
  // directly: after a restart mid-build, the bot's saved position can be
  // standing on top of whatever it half-built last time rather than the true
  // floor, which silently replans the whole structure at the wrong height.
  let origin = session.loadOrigin()
  if (origin && commander.nearEnough(origin, here)) {
    say(bot, 'Resuming at the previous build spot.')
  } else {
    if (origin) say(bot, 'Old build spot is far from here - starting fresh where you are.')
    const floored = here.floored()
    origin = new Vec3(floored.x + 2, placer.findGroundY(bot, here), floored.z)
    session.saveOrigin(origin)
  }
  state.lastOrigin = origin

  if (state.dryRun) {
    const stats = await placer.buildStructure(bot, origin, blocks, { dryRun: true, label })
    const mats = [...stats.plan.materials].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([n, c]) => `${c} ${n}`).join(', ')
    const b = stats.plan.bounds
    say(bot, `DRY RUN ${label}: ${blocks.length} blocks (${mats}${stats.plan.materials.size > 3 ? ', ...' : ''})`)
    say(bot, `Would fill (${b.min.x},${b.min.y},${b.min.z}) to (${b.max.x},${b.max.y},${b.max.z}). Full list in the container log. !dry off to build for real.`)
    // A dry run reserves nothing - drop the origin so the real build picks its
    // own spot from wherever the bot is standing when it runs.
    session.clearOrigin()
    return
  }

  // Warn up front rather than discovering it 200 blocks in. Only meaningful
  // when the bot has to physically carry and place the blocks - /fill conjures
  // them server-side and never touches the inventory.
  if (BUILD_MODE === 'survival') {
    const short = []
    for (const [name, count] of placer.countMaterials(blocks)) {
      const have = placer.countInInventory(bot, name)
      if (have < count) short.push(`${name} (have ${have}, need ${count})`)
    }
    const scaffoldHave = placer.countInInventory(bot, SCAFFOLD_BLOCK)
    if (scaffoldHave < 12) short.push(`${SCAFFOLD_BLOCK} for scaffolding (have ${scaffoldHave})`)
    if (short.length) say(bot, `Short on: ${short.join(', ')} - building what I can.`)
  }

  // Stand clear of the footprint. Primitives grow in +x/+z from the origin, so
  // a few blocks back along both is outside anything about to be filled - and
  // near enough to keep the chunks loaded, which /fill requires.
  if (BUILD_MODE !== 'survival') {
    await commander.teleportTo(bot, origin.offset(-3, 0, -3))
  }

  state.building = true
  state.cancelled = false
  const startedAt = Date.now()
  say(bot, `Building ${label} - ${blocks.length} blocks.`)

  try {
    const stats = await placer.buildStructure(bot, origin, blocks, {
      label,
      onProgress: (i, total) => say(bot, `...${i}/${total} blocks`),
      shouldCancel: () => state.cancelled
    })

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
    const parts = [`${stats.placed} placed`]
    if (stats.skipped) parts.push(`${stats.skipped} already there`)
    if (stats.failed) parts.push(`${stats.failed} unreachable`)
    if (stats.missing.size) parts.push(`ran out of ${[...stats.missing].join(', ')}`)
    say(bot, state.cancelled
      ? `Stopped. ${parts.join(', ')} in ${secs}s.`
      : `Done in ${secs}s! ${parts.join(', ')}. !undo to roll it back.`)
    if (stats.failed && stats.lastWhy) say(bot, `Why they failed: ${stats.lastWhy}`)

    // Take the pillaring scaffolding back out. Without this the inside of
    // anything with a roof is left full of the blocks the bot climbed on.
    // Only the walking placer pillars up, so only it leaves scaffolding behind.
    if (stats.placed && stats.mode !== 'command') {
      const swept = await placer.sweepScaffolding(bot, origin, blocks, {
        shouldCancel: () => state.cancelled
      })
      if (swept.count || swept.failed) {
        say(bot, `Cleared ${swept.count} scaffolding block${swept.count === 1 ? '' : 's'}${swept.failed ? `, ${swept.failed} I couldn't reach` : ''}.`)
      }
      // Movements were switched to canDig:false for the sweep - put them back.
      configureMovements(bot, materials)
    }

    // Inspect what actually landed. Everything upstream reasons about a cell
    // map; this is the only step that asks the server, and the gap between the
    // two is where silent failures live - fills into unloaded chunks, blocks
    // the server deleted for want of support, fluids that flowed away.
    if (stats.mode === 'command' && !state.cancelled && stats.placed) {
      try {
        const worldBlocks = blocks.map(b => ({ pos: origin.plus(b.pos), name: b.name }))
        const worldTreads = (treads || []).map(t => ({ x: origin.x + t.x, y: origin.y + t.y, z: origin.z + t.z }))
        let report = await inspector.inspect(bot, origin, worldBlocks, { treads: worldTreads })

        if (!report.pass && report.detail.length) {
          const fix = await inspector.repair(bot, report, worldBlocks, commander)
          if (fix.fixed) {
            say(bot, `Fixed ${fix.fixed} block${fix.fixed === 1 ? '' : 's'} that had not landed.`)
            report = await inspector.inspect(bot, origin, worldBlocks, { treads: worldTreads })
          }
        }

        console.log('[inspect]', inspector.summarise(report))
        if (buildRun) buildRun.note('inspection.json', JSON.stringify(report, null, 2) + '\n')

        if (!report.pass) {
          const issues = []
          if (report.missing) issues.push(`${report.missing} blocks missing`)
          if (report.wrong) issues.push(`${report.wrong} wrong`)
          if (!report.openings) issues.push('no way in at ground level')
          if (report.stairs.blocked) issues.push(`${report.stairs.blocked} stair treads blocked`)
          if (issues.length) say(bot, `Inspection: ${issues.join(', ')}.`)
        }
      } catch (err) {
        console.error('[inspect] skipped:', err.message)
      }
    }

    // Only an interrupted build should resume at the same spot next time. A
    // finished one must release the origin, or every later build stacks itself
    // on top of the first.
    if (!state.cancelled) session.clearOrigin()
  } finally {
    state.building = false
    state.cancelled = false
  }
}

function clamp (raw, fallback) {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(MAX_SIZE, n))
}

module.exports = { register, state }
