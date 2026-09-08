'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// The chat-driven builder for servers the bot cannot log into.
//
// RCON sends commands but cannot RECEIVE chat, so this watches the server's
// own log for "<Player> !build ..." lines and answers with /tellraw. That is
// the whole trick: no player entity, no protocol version, works on 26.2.
//
//   node tools/rcon-bot.js --server mc-test
//
// Anyone who can type a command here is driving a console-level socket, so a
// server with an `allow` list in rcon-servers.json only listens to those names.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { connect } = require('../src/rcon/client')
const world = require('../src/rcon/world')
const { fillBlocks } = require('../src/rcon/build')
const { clearBoxes, runClear, withoutDrops } = require('../src/rcon/clear')
const { unloadedWarning } = require('../src/building/machine')
const journal = require('../src/rcon/journal')
const schemMod = require('../src/building/schematic')
const templates = require('../src/building/templates')
const placer = require('../src/building/placer')
const { fillCommand } = require('../src/building/commander')

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const serverName = arg('server', SERVER)
// rcon-servers.json is per-machine and gitignored (it holds the rcon password);
// the committed example works out of the box against the compose.yml in the repo.
const serversFile = ['rcon-servers.json', 'rcon-servers.example.json']
  .map(f => path.join(__dirname, '..', f)).find(f => fs.existsSync(f))
const servers = JSON.parse(fs.readFileSync(serversFile, 'utf8'))
const cfg = servers[serverName]
if (!cfg) { console.error(`unknown server "${serverName}"`); process.exit(1) }

const CHAT = /\]: (?:\[Not Secure\] )?<([^>]+)> (.+?)\s*$/
let rcon = null
let busy = false

async function say (text, colour = 'gray') {
  await rcon.send(`tellraw @a {"text":${JSON.stringify('[Builder] ' + text)},"color":"${colour}"}`)
}

function aliases () {
  return JSON.parse(fs.readFileSync(path.join(schemMod.SCHEMATIC_DIR, 'aliases.json'), 'utf8'))
}
function aliasNames () {
  return Object.keys(aliases()).filter(k => !k.startsWith('_'))
}

// catalog.json gives every file its dimensions, block count and kind. Re-read
// per command like aliases.json, so a rebuild shows up without a restart.
function catalog () {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(schemMod.SCHEMATIC_DIR, 'catalog.json'), 'utf8'))
    const by = {}
    for (const e of raw) by[e.file] = e
    return by
  } catch (err) { return {} }
}

// tellraw with components, for the list. say() stays the plain-text path.
//
// Vanilla rcon drops the connection on an oversized request - the payload cap
// is around 1446 bytes, and a single line of 16 blueprint names carrying hover
// text runs to 3281. So a line that would blow the budget is split across
// several tellraws, with the head components repeated only on the first.
const RCON_CMD_BUDGET = 1200

async function sayRich (components) {
  const cmd = 'tellraw @a ' + JSON.stringify(components)
  if (cmd.length <= RCON_CMD_BUDGET) return rcon.send(cmd)
  throw new Error(`tellraw payload ${cmd.length}b exceeds ${RCON_CMD_BUDGET} - use sayList`)
}

// head: components printed once, on the first line only.
// items: components chunked across as many lines as the budget needs.
async function sayList (head, items, indent) {
  let line = head.slice()
  let first = true
  const flush = async () => {
    if (line.length === (first ? head.length : indent.length)) return
    await rcon.send('tellraw @a ' + JSON.stringify(line))
    first = false
    line = indent.slice()
  }
  for (const item of items) {
    const trial = line.concat([item])
    if (('tellraw @a ' + JSON.stringify(trial)).length > RCON_CMD_BUDGET) await flush()
    line.push(item)
  }
  await flush()
}

const KIND_COLOUR = {
  house: 'green', tower: 'aqua', statue: 'light_purple', build: 'yellow',
  farm: 'gold', sorter: 'light_purple', redstone: 'red', template: 'gold',
  terrain: 'dark_gray', other: 'white'
}
const KIND_LABEL = {
  house: 'Houses', tower: 'Towers', statue: 'Statues', build: 'Big builds',
  farm: 'Farms', sorter: 'Sorters', redstone: 'Redstone', template: 'Machines',
  other: 'Other'
}
// Machines first - they are what someone is usually hunting for - then by size.
const KIND_ORDER = ['template', 'farm', 'sorter', 'redstone', 'house', 'tower', 'statue', 'build', 'other']

function describeAlias (name, target, cat) {
  if (target.startsWith('template:')) {
    return { kind: 'template', detail: target.slice('template:'.length) + ' - carries setup.txt (entities, container contents)' }
  }
  const e = cat[target]
  if (!e) return { kind: 'other', detail: target }
  const bits = [target]
  if (e.size) bits.push(e.size)
  if (e.blocks) bits.push(e.blocks.toLocaleString() + ' blocks')
  if (e.meta) bits.push(e.meta)
  if (e.overCap) bits.push('TOO BIG: ' + e.overCap)
  return { kind: e.kind || 'other', detail: bits.join('  -  ') }
}

async function loadBlocks (what) {
  const version = cfg.readVersion || DATA_VERSION
  if (what.startsWith('template:')) {
    const info = await templates.load(what.slice('template:'.length), version)
    return { blocks: templates.schematicToBlocks(info.schematic).blocks, sink: Number(info.meta.ground) || 0, setup: info.setup, label: what }
  }
  const loaded = await schemMod.loadSchematic(what, version)
  return { blocks: schemMod.schematicToBlocks(loaded).blocks, sink: schemMod.groundLayers(loaded), setup: [], label: what }
}

async function doBuild (player, args) {
  const first = (args[0] || '').toLowerCase()
  if (!first || first === 'menu' || first === 'help') {
    await say('Blueprints: !build /<name>  |  !build list  |  add "at x y z" to pick the spot, "dry" to preview, "noclear" to keep what is there')
    await say('Also: !remove (the build you stand in), !undo (last), !export <name> (capture what you are standing in)')
    return
  }
  if (first === 'list') {
    const a = aliases()
    const cat = catalog()
    const want = (args[1] || '').toLowerCase().replace(/^\//, '')

    const groups = {}
    for (const name of aliasNames()) {
      const { kind, detail } = describeAlias(name, a[name], cat)
      ;(groups[kind] = groups[kind] || []).push({ name, detail })
    }
    const kinds = KIND_ORDER.filter(k => groups[k])
    for (const k of Object.keys(groups)) if (!kinds.includes(k)) kinds.push(k)

    if (want && !groups[want]) {
      return say(`No group "${want}". Try: ` + kinds.join(', '))
    }
    const shown = want ? [want] : kinds

    const total = aliasNames().length
    await sayRich([
      { text: '\u2501\u2501 ', color: 'dark_gray' },
      { text: 'Blueprints', color: 'white', bold: true },
      { text: ` ${total} ` + '\u2501\u2501', color: 'dark_gray' },
      { text: '   hover for size, click to fill in the command', color: 'dark_gray', italic: true }
    ])

    for (const kind of shown) {
      const colour = KIND_COLOUR[kind] || 'white'
      const head = [
        { text: (KIND_LABEL[kind] || kind).padEnd(12, ' '), color: colour, bold: true },
        { text: `${groups[kind].length} `.padStart(4, ' '), color: 'dark_gray' }
      ]
      // A wrapped group lines up under its own name rather than restating it.
      const indent = [{ text: ' '.repeat(16), color: 'dark_gray' }]
      // Sort house2 before house10 - plain string order puts 10 first.
      const sorted = groups[kind].sort((x, y) =>
        x.name.localeCompare(y.name, undefined, { numeric: true }))
      const items = sorted.map(({ name, detail }) => ({
        text: '/' + name + ' ',
        color: colour,
        hoverEvent: { action: 'show_text', value: detail },
        clickEvent: { action: 'suggest_command', command: `!build /${name}` }
      }))
      await sayList(head, items, indent)
    }

    if (!want) {
      await sayRich([
        { text: 'Also: ', color: 'dark_gray' },
        { text: '!build list <group>', color: 'gray' },
        { text: '  |  add ', color: 'dark_gray' },
        { text: 'dry', color: 'gray' },
        { text: ' to preview, ', color: 'dark_gray' },
        { text: 'at x y z', color: 'gray' },
        { text: ' to pick the spot', color: 'dark_gray' }
      ])
    }
    return
  }
  if (!first.startsWith('/')) return say(`I don't know "${first}". Try !build list.`)

  const key = first.slice(1)
  const target = aliases()[key]
  if (!target) return say(`No blueprint "/${key}". Try !build list.`)

  const dry = args.includes('dry')
  const noclear = args.includes('noclear')
  let corner = null
  const atIdx = args.indexOf('at')
  if (atIdx !== -1 && args.length >= atIdx + 4) {
    corner = new Vec3(parseInt(args[atIdx + 1], 10), parseInt(args[atIdx + 2], 10), parseInt(args[atIdx + 3], 10))
    if ([corner.x, corner.y, corner.z].some(v => !Number.isFinite(v))) return say('Usage: !build /name at <x> <y> <z>')
  } else {
    corner = await world.crosshairTarget(rcon, player)
    if (!corner) return say('Aim at a block and try again, or say: !build /' + key + ' at <x> <y> <z>')
  }

  const { blocks, sink, setup, label } = await loadBlocks(target)
  const footprint = placer.footprintOf(blocks)
  const origin = corner.offset(-footprint.lo.x, -footprint.lo.y - sink, -footprint.lo.z)
  await say(`${label}: ${blocks.length} blocks, ${footprint.width}x${footprint.height}x${footprint.depth}, corner ${corner.x} ${corner.y} ${corner.z}${dry ? ' (dry run)' : ''}`)

  const t0 = Date.now()

  // Empty the volume first. Schematics carry no air - schematic.js drops every
  // air cell at load - so without this the blueprint's interior keeps whatever
  // was already standing there. On land that is two builds interpenetrating;
  // in water it is a house that arrives full of ocean.
  if (!dry && !noclear) {
    // footprintOf reports lo plus width/height/depth - there is no hi field.
    const lo = origin.plus(footprint.lo)
    const hi = lo.offset(footprint.width - 1, footprint.height - 1, footprint.depth - 1)
    const res = await withoutDrops(rcon, () => runClear(rcon, clearBoxes({ lo, hi })))
    if (res.cleared) await say(`Cleared ${res.cleared.toLocaleString()} blocks out of the way first.`)
    // Clearing gets the build started dry; it cannot keep it that way. Any
    // opening in the blueprint is a hole the ocean flows straight back through,
    // and that is vanilla behaviour, not something placing blocks differently
    // can fix. Measured on mc-test: flushed to 125 cells, back to 274 in 8s.
    if (res.water > 50) {
      await say(`Heads up: ${res.water.toLocaleString()} of those were water - this site is underwater.`, 'yellow')
      await say('It will flood again through any door or window. Build above the waterline, or wall the site off first.', 'yellow')
    }
  }

  // A machine placed with empty filter hoppers looks perfect and does nothing.
  const machineWarn = unloadedWarning(blocks, setup.length)
  if (machineWarn) for (const line of machineWarn) await say(line, 'yellow')

  const stats = await fillBlocks(rcon, origin, blocks, { label, dryRun: dry })
  if (dry) return say(`Dry run: would send ${stats.boxes} fill commands.`)

  journal.record(serverName, {
    label, player, bounds: stats.bounds,
    boxes: stats.boxList.map(b => ({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }))
  })
  await say(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s - ${stats.changed} blocks changed${stats.errors ? `, ${stats.errors} commands errored` : ''}. !remove to take it back out.`, 'green')

  if (setup.length) {
    const cmds = templates.setupCommands({ setup }, origin)
    await say(`running ${cmds.length} setup commands`)
    for (const c of cmds) await rcon.send(c)
  }
}

async function doRemove (player, args) {
  const builds = journal.list(serverName)
  if (!builds.length) return say('Nothing recorded to remove.')
  let target
  if ((args[0] || '').toLowerCase() === 'last') target = builds[builds.length - 1]
  else {
    const p = await world.playerPos(rcon, player)
    const look = await world.crosshairTarget(rcon, player)
    const spot = look || (p && p.floored())
    if (spot) target = journal.findAt(serverName, spot.x, spot.z)
    if (!target) return say('Stand in (or look at) the build you want gone, or say !remove last.')
  }
  await say(`Removing "${target.label}" - ${target.boxes.length} regions.`)
  let cleared = 0
  for (let i = target.boxes.length - 1; i >= 0; i--) {
    const b = target.boxes[i]
    const out = await rcon.send(`fill ${b.min[0]} ${b.min[1]} ${b.min[2]} ${b.max[0]} ${b.max[1]} ${b.max[2]} minecraft:air`)
    const m = /([0-9]+) block/.exec(out)
    if (m) cleared += Number(m[1])
  }
  journal.drop(serverName, target.id)
  await say(`Cleared ${cleared} blocks. (I can only clear to air here - I have no record of the ground that was there.)`, 'green')
}

async function handle (player, message) {
  const parts = message.trim().split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)
  if (!['!build', '!remove', '!undo', '!help', '!export'].includes(cmd)) return
  if (Array.isArray(cfg.allow) && !cfg.allow.includes(player)) return say(`Sorry ${player}, you are not on this server's builder list.`)
  if (busy) return say('Still working on the last one - give me a moment.')

  busy = true
  try {
    if (cmd === '!help') return await doBuild(player, ['menu'])
    if (cmd === '!build') return await doBuild(player, args)
    if (cmd === '!remove') return await doRemove(player, args)
    if (cmd === '!undo') return await doRemove(player, ['last'])
    if (cmd === '!export') return await say('Capture runs from the console for now: tools/rcon-export.js --player ' + player + ' --name <name>')
  } catch (err) {
    console.error('[bot]', err)
    await say(`That failed: ${err.message}`, 'red')
  } finally {
    busy = false
  }
}

// --- tail the log -----------------------------------------------------------
async function main () {
  rcon = await connect({ host: cfg.host, port: cfg.port, password: cfg.password })
  console.log(`[bot] rcon connected to ${serverName}, watching ${cfg.log}`)
  await say('Builder online. !build list to see blueprints, !help for commands.', 'aqua')

  let pos = fs.statSync(cfg.log).size
  let carry = ''
  setInterval(() => {
    let size
    try { size = fs.statSync(cfg.log).size } catch (err) { return }
    if (size < pos) { pos = 0; carry = '' }   // log rotated
    if (size === pos) return
    const fd = fs.openSync(cfg.log, 'r')
    const buf = Buffer.alloc(size - pos)
    fs.readSync(fd, buf, 0, buf.length, pos)
    fs.closeSync(fd)
    pos = size
    const text = carry + buf.toString('utf8')
    const lines = text.split('\n')
    carry = lines.pop()
    for (const line of lines) {
      const m = CHAT.exec(line)
      if (m) handle(m[1], m[2]).catch(e => console.error('[bot]', e.message))
    }
  }, 250)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
