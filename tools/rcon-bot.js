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
const { MAX_BLOCKS } = require('../src/config')

// Vanilla's world border and build height. The crosshair raycast already clamps
// to these; explicit `at x y z` did not.
const WORLD_LIMIT = 29999984
const MIN_Y = -64
const MAX_Y = 319
const journal = require('../src/rcon/journal')
const schemMod = require('../src/building/schematic')
const templates = require('../src/building/templates')
// bounds.js, not placer.js: the live path needs footprintOf and nothing else,
// and placer.js pulls in mineflayer-pathfinder at require time.
const placer = require('../src/building/bounds')

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const serverName = arg('server', SERVER)
// rcon-servers.json is per-machine and gitignored (it holds the rcon password);
// the committed example works out of the box against the compose.yml in the repo.
const serversFile = ['rcon-servers.json', 'rcon-servers.example.json']
  .map(f => path.join(__dirname, '..', f)).find(f => fs.existsSync(f))
const servers = JSON.parse(fs.readFileSync(serversFile, 'utf8'))
const cfg = servers[serverName]
if (!cfg) { console.error(`unknown server "${serverName}"`); process.exit(1) }

// Authorisation. RCON is console level: whoever gets a !build line into the
// log drives a console socket. The old guard only engaged when cfg.allow was an
// array, and the shipped example defines none - so the default was "everyone".
// Fail closed instead, and say clearly why when nothing is configured.
let warnedNoAllow = false
function isAllowed (player) {
  const list = cfg.allow
  if (!Array.isArray(list) || list.length === 0) {
    if (!warnedNoAllow) {
      warnedNoAllow = true
      console.error(`[bot] no "allow" list for server "${serverName}" in rcon-servers.json - refusing every builder.`)
      console.error('[bot] add e.g.  "allow": ["YourName"]  to that entry and restart.')
    }
    return false
  }
  return list.includes(player)
}

// Operators may remove other people's builds. Defaults to the first allow entry
// when not set, so a single-player setup needs no extra config.
function isOperator (player) {
  const ops = Array.isArray(cfg.operators) ? cfg.operators
    : (Array.isArray(cfg.allow) && cfg.allow.length ? [cfg.allow[0]] : [])
  return ops.includes(player)
}

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
    // Checking before the push meant a single item bigger than the budget was
    // pushed onto an empty line and sent anyway - the oversized request that
    // drops the connection. Truncate the one offender instead.
    let entry = item
    if (('tellraw @a ' + JSON.stringify(indent.concat([entry]))).length > RCON_CMD_BUDGET) {
      entry = { ...entry, text: String(entry.text).slice(0, 80) + '...' }
      if (entry.hoverEvent) delete entry.hoverEvent
    }
    if (('tellraw @a ' + JSON.stringify(line.concat([entry]))).length > RCON_CMD_BUDGET) await flush()
    line.push(entry)
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
  // hasOwnProperty, or `!build /constructor` returns an inherited member, passes
  // this guard, and dies later with "target.startsWith is not a function".
  const table = aliases()
  const target = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null
  if (!target || typeof target !== 'string') return say(`No blueprint "/${key}". Try !build list.`)

  const dry = args.includes('dry')
  const noclear = args.includes('noclear')
  let corner = null
  const atIdx = args.indexOf('at')
  if (atIdx !== -1 && args.length >= atIdx + 4) {
    // Reject the whole token, not parseInt's prefix: '12abc' silently became 12
    // and built somewhere the player never asked for.
    const nums = args.slice(atIdx + 1, atIdx + 4).map(t => (/^-?\d+$/.test(t) ? Number(t) : NaN))
    if (nums.some(v => !Number.isFinite(v))) return say('Usage: !build /name at <x> <y> <z>')
    const [cx, cy, cz] = nums
    // Finiteness is not enough. `at 29000000 300 29000000` force-loads and
    // generates chunks at the world border; `at 0 -5000 0` builds outside the
    // world and every fill fails silently. The crosshair path already clamps
    // y to the build range (world.js) - the explicit path did not.
    if (Math.abs(cx) > WORLD_LIMIT || Math.abs(cz) > WORLD_LIMIT) {
      return say(`Those coordinates are outside the world (limit is +/-${WORLD_LIMIT.toLocaleString()}).`)
    }
    if (cy < MIN_Y || cy > MAX_Y) return say(`y must be between ${MIN_Y} and ${MAX_Y}.`)
    corner = new Vec3(cx, cy, cz)
  } else {
    corner = await world.crosshairTarget(rcon, player)
    if (!corner) return say('Aim at a block and try again, or say: !build /' + key + ' at <x> <y> <z>')
  }

  const { blocks, sink, setup, label } = await loadBlocks(target)
  if (!blocks.length) return say(`${label} has no blocks in it - nothing to build.`)
  // compose.yml says "refuse anything bigger" and the README repeats it; until
  // now nothing on this path read the cap, so /sorter1 (371k blocks) went
  // straight through. The retired mineflayer path enforced it; this one did not.
  if (blocks.length > MAX_BLOCKS) {
    return say(`${label} is ${blocks.length.toLocaleString()} blocks - over the ${MAX_BLOCKS.toLocaleString()} limit (MC_MAX_BLOCKS). Refusing.`, 'red')
  }
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
  // setup.length counts every line including /summon; the warning wants the
  // number of containers actually loaded, or a template with enough summons
  // silently loses the warning it exists for.
  const loadedContainers = setup.filter(l => /^\/?data merge block/.test(l.trim())).length
  const machineWarn = unloadedWarning(blocks, loadedContainers)
  if (machineWarn) for (const line of machineWarn) await say(line, 'yellow')

  // Journal the plan BEFORE filling. Recording afterwards meant a build whose
  // socket dropped mid-fill was never journalled at all: the blocks that landed
  // were permanently un-removable by !remove. A dry-run entry costs nothing;
  // an unrecorded partial build cannot be undone.
  const plan = await fillBlocks(rcon, origin, blocks, { label, dryRun: true })
  if (dry) return say(`Dry run: would send ${plan.boxes} fill commands.`)
  const entryId = journal.record(serverName, {
    label, player, bounds: plan.bounds, partial: true,
    boxes: plan.boxList.map(b => ({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }))
  })

  const stats = await fillBlocks(rcon, origin, blocks, { label })
  journal.update(serverName, entryId, { partial: false })
  await say(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s - ${stats.changed} blocks changed${stats.errors ? `, ${stats.errors} commands errored` : ''}. !remove to take it back out.`, 'green')

  if (setup.length) {
    const cmds = templates.setupCommands({ setup }, origin)
    await say(`running ${cmds.length} setup commands`)
    // rcon-build.js checks these replies; the live bot did not, so a machine
    // whose villagers all failed to summon still reported success.
    const failed = []
    for (const c of cmds) {
      const reply = (await rcon.send(c)).trim()
      if (/error|unknown|expected|failed|incorrect/i.test(reply)) failed.push(`${c.slice(0, 50)} -> ${reply.slice(0, 60)}`)
    }
    if (failed.length) {
      await say(`${failed.length} of ${cmds.length} setup commands failed - the machine may not work.`, 'red')
      for (const f of failed.slice(0, 3)) await say('  ' + f, 'red')
    }
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

  // Ownership. The journal has recorded `player` since the beginning and
  // nothing ever read it, so anyone could delete anyone's build - and a /fill
  // to air is not recoverable. Operators on the allow list keep the override.
  if (target.player && target.player !== player && !isOperator(player)) {
    return say(`"${target.label}" was placed by ${target.player}. Ask them, or have an operator remove it.`)
  }

  await say(`Removing "${target.label}" - ${target.boxes.length} regions.`)
  let cleared = 0
  const failures = []
  // Suppress drops for the same reason doBuild does: a build full of chests
  // otherwise sprays item entities across the site as it comes apart.
  await withoutDrops(rcon, async () => {
    for (let i = target.boxes.length - 1; i >= 0; i--) {
      const b = target.boxes[i]
      const out = await rcon.send(`fill ${b.min[0]} ${b.min[1]} ${b.min[2]} ${b.max[0]} ${b.max[1]} ${b.max[2]} minecraft:air`)
      const m = /([0-9]+) block/.exec(out)
      if (m) cleared += Number(m[1])
      else if (!/No blocks were filled/i.test(out)) failures.push(out.trim().slice(0, 70))
    }
  })

  // Only forget the build if every region actually came out. Dropping the
  // record after a failed fill destroyed the only way to find the leftovers.
  if (failures.length) {
    await say(`${failures.length} of ${target.boxes.length} regions failed - keeping the record so you can retry.`, 'red')
    await say('  ' + failures[0], 'red')
    return
  }
  journal.drop(serverName, target.id)
  await say(`Cleared ${cleared} blocks. (I can only clear to air here - I have no record of the ground that was there.)`, 'green')
}

async function handle (player, message) {
  const parts = message.trim().split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)
  if (!['!build', '!remove', '!undo', '!help', '!export'].includes(cmd)) return
  if (!isAllowed(player)) {
    return say(`Sorry ${player}, you are not on this server's builder list. An operator can add you to "allow" in rcon-servers.json.`)
  }
  if (busy) return say('Still working on the last one - give me a moment.')

  busy = true
  try {
    if (cmd === '!help') return await doBuild(player, ['menu'])
    if (cmd === '!build') return await doBuild(player, args)
    if (cmd === '!remove') return await doRemove(player, args)
    if (cmd === '!undo') return await doRemove(player, ['last'])
    if (cmd === '!export') return await say('Capture runs from the console for now: tools/rcon-export.js --player ' + player + ' --name <name>')
  } catch (err) {
    // The message carries container paths, library internals and the shape of
    // the deployment; chat is readable by everyone on the server. Keep the
    // detail in stderr where the operator reads it.
    console.error('[bot]', err)
    await say('That failed - the operator can see why in the log.', 'red')
  } finally {
    busy = false
  }
}

// --- tail the log -----------------------------------------------------------
async function main () {
  rcon = await connect({ host: cfg.host, port: cfg.port, password: cfg.password })
  console.log(`[bot] rcon connected to ${serverName}, watching ${cfg.log}`)
  await say('Builder online. !build list to see blueprints, !help for commands.', 'aqua')

  // Start from wherever the log is now, or from zero if the server has not
  // written it yet - statSync outside a guard turned "bot started before the
  // server" into a restart loop under compose.
  const logSize = () => { try { return fs.statSync(cfg.log).size } catch (err) { return null } }
  // Server-wide state the bot toggles (doTileDrops, forceload) is restored in a
  // `finally` - which does not run for SIGTERM. `docker compose down` mid-build
  // therefore left drops off and chunks pinned on a live server, and there were
  // no signal handlers anywhere in the repo. The retired entry point swept
  // forceloads at startup; this one never did.
  let shuttingDown = false
  const shutdown = async (sig) => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[bot] ${sig} - restoring server state before exit`)
    try {
      await rcon.send('gamerule doTileDrops true')
      await rcon.send('forceload remove all')
    } catch (err) {
      console.error('[bot] could not restore state:', err.message)
    }
    try { rcon.close() } catch (e) {}
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // And sweep anything a previous crash left pinned.
  try {
    const swept = await rcon.send('forceload remove all')
    if (/Removed/i.test(swept)) console.error('[bot] swept forceloads left by a previous run')
  } catch (err) {}

  let pos = logSize() ?? 0
  let carry = ''
  const MAX_READ = 4 * 1024 * 1024   // one tick's worth; the rest waits for the next
  const MAX_CARRY = 1 * 1024 * 1024  // a line that never terminates must not grow forever

  setInterval(() => {
    const size = logSize()
    if (size === null) return
    if (size < pos) { pos = 0; carry = '' }   // log rotated
    if (size === pos) return

    // Read at most MAX_READ per tick. Allocating (size - pos) meant a large
    // catch-up - or a log that grew while the bot was busy - allocated that
    // much in one go, every 250 ms.
    const want = Math.min(size - pos, MAX_READ)
    let fd = null
    let read = 0
    const buf = Buffer.alloc(want)
    try {
      fd = fs.openSync(cfg.log, 'r')
      // readSync's return value is the byte count actually read. Discarding it
      // meant a short read silently appended NUL padding into the parsed text.
      read = fs.readSync(fd, buf, 0, want, pos)
    } catch (err) {
      return
    } finally {
      // Without finally, a throw leaked the fd - and this runs four times a second.
      if (fd !== null) { try { fs.closeSync(fd) } catch (e) {} }
    }
    if (read <= 0) return
    pos += read

    const text = carry + buf.subarray(0, read).toString('utf8')
    const lines = text.split('\n')
    carry = lines.pop()
    if (carry.length > MAX_CARRY) carry = ''
    for (const line of lines) {
      const m = CHAT.exec(line)
      if (m) handle(m[1], m[2]).catch(e => console.error('[bot]', e.message))
    }
  }, 250)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
