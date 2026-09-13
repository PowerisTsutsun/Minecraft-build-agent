'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Build into ANY server version over RCON - no bot, no protocol support needed.
//
//   node tools/rcon-build.js --server mc-test --what /house1 --player <name>
//   ... --no-freeze          build without stopping the tick (the old behaviour)
//   node tools/rcon-build.js --host 127.0.0.1 --port 25576 --what /house1 ...
//
// Credentials come from rcon-servers.json (which may say "${RCON_PASSWORD}" so
// the secret lives in .env). --password still works, but a password on argv is
// visible in `ps` and in shell history, so prefer --server.
//   node tools/rcon-build.js ... --what blueprints/house/house1.litematic --at 100 72 -190
//
// --what takes a blueprint name (/house1), a path to a file, or
// template:<name>. --player builds at that player's crosshair.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { connect } = require('../src/rcon/client')
const world = require('../src/rcon/world')
const { fillBlocks, verifySample } = require('../src/rcon/build')
const { withFrozenTicks } = require('../src/rcon/clear')
const schem = require('../src/building/schematic')
const machines = require('../src/building/machines')
const placer = require('../src/building/bounds')
const blueprints = require('../src/building/blueprints')
const protect = require('../src/building/protect')
const servers = require('../src/rcon/servers')

function arg (name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

// Prefer the named entry in rcon-servers.json - same source of truth as the
// bot, and the only one that can hold "${RCON_PASSWORD}". Explicit flags still
// override it, for a one-off against a server that is not in the file.
function target () {
  const name = arg('server', process.argv.includes('--password') ? null : SERVER)
  let entry = {}
  if (name) {
    try {
      entry = servers.load(name)
    } catch (err) {
      console.error(`[rcon-build] ${err.message}`)
      process.exit(1)
    }
  }
  const password = arg('password', entry.password)
  if (!password) {
    console.error('[rcon-build] no password: pass --server <name> (see rcon-servers.json) or --password')
    process.exit(1)
  }
  return { host: arg('host', entry.host || '127.0.0.1'), port: Number(arg('port', entry.port || 25575)), password }
}
const flag = name => process.argv.includes(`--${name}`)

// --what takes a blueprint name (/house1, or house/house1 to disambiguate) or a
// path to a file that is not in the folder at all. The name form resolves
// exactly the way chat does, so the console and the bot cannot drift.
function resolveWhat (what) {
  if (what.startsWith('/') && !what.includes('.')) {
    const hit = blueprints.resolve(what)
    if (!hit) throw new Error(`no blueprint "${what}" - have: ${blueprints.names().join(' ')}`)
    return hit
  }
  const hit = blueprints.resolve(what)
  if (hit) return hit
  // Not a known name: treat it as a file path and let the loader judge it.
  return { name: what, path: what, file: what, group: 'other', setup: null, meta: null }
}

;(async () => {
  const version = arg('version', DATA_VERSION) // which minecraft-data to READ the file with
  const what = resolveWhat(arg('what'))
  const verifyOnly = flag('verify-only')
  const rcon = await connect(target())

  // --- load blocks -------------------------------------------------------
  let setup = []
  if (what.setup) {
    setup = fs.readFileSync(what.setup, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  }
  let meta = {}
  if (what.meta) {
    try { meta = JSON.parse(fs.readFileSync(what.meta, 'utf8')) } catch (err) {
      console.error(`[rcon-build] ignoring ${what.meta}: ${err.message}`)
    }
  }
  const loaded = await schem.loadSchematic(what.path, version)
  const blocks = schem.schematicToBlocks(loaded).blocks
  const sink = meta.ground !== undefined ? Number(meta.ground) || 0 : schem.groundLayers(loaded)
  const label = `${what.name}${setup.length ? ' (+ setup)' : ''}`
  const footprint = placer.footprintOf(blocks)
  console.log(`${label}: ${blocks.length} blocks, ${footprint.width}x${footprint.height}x${footprint.depth}, ground sink ${sink}`)

  // --- where -------------------------------------------------------------
  let corner
  const at = arg('at')
  if (at !== null) {
    const i = process.argv.indexOf('--at')
    corner = new Vec3(Number(process.argv[i + 1]), Number(process.argv[i + 2]), Number(process.argv[i + 3]))
  } else if (arg('player')) {
    corner = await world.crosshairTarget(rcon, arg('player'))
    if (!corner) throw new Error('that player is looking at open sky - aim at a block, or pass --at x y z')
    console.log(`crosshair corner: ${corner.x}, ${corner.y}, ${corner.z}`)
  } else {
    throw new Error('need --at x y z or --player <name>')
  }
  const origin = corner.offset(-footprint.lo.x, -footprint.lo.y - sink, -footprint.lo.z)

  // --- build -------------------------------------------------------------
  if (verifyOnly) {
    const v = await verifySample(rcon, origin, blocks)
    console.log(`verified ${v.ok}/${v.checked} sampled cells exact${v.computed ? `, ${v.computed} differ only in server-computed state` : ''}${v.settled ? `, ${v.settled} moving parts that have settled since the fill` : ''}${v.unloaded ? `, ${v.unloaded} in chunks that would not stay loaded` : ''}${v.mismatched ? `, ${v.mismatched} genuinely wrong` : ''}`)
    for (const b of v.examples) console.log('   ' + b)
    rcon.close(); return
  }

  // Same protected-volume guard the chat path uses.
  {
    const pre = await fillBlocks(rcon, origin, blocks, { label, dryRun: true })
    const clashes = protect.conflicts(arg('server', SERVER), pre.bounds)
    if (clashes.length) {
      const c = clashes[0]
      console.error(c.error
        ? `[rcon-build] refusing: ${c.label}'s protect file is unreadable (${c.error})`
        : `[rcon-build] refusing: this would cut into /${c.label} - ${c.why}\n  its protected volume is ${c.lo.x} ${c.lo.y} ${c.lo.z} to ${c.hi.x} ${c.hi.y} ${c.hi.z}`)
      process.exit(3)
    }
  }

  // Frozen for the fill, exactly as the chat path does it - see withFrozenTicks
  // in src/rcon/clear.js. Verification deliberately runs after the tick resumes:
  // a piston that is *meant* to be extended only reaches that state once the
  // redstone holding it has been evaluated.
  const t0 = Date.now()
  const fill = () => fillBlocks(rcon, origin, blocks, {
    label,
    dryRun: flag('dry'),
    onProgress: (i, n) => console.log(`  ...${i}/${n} fills`)
  })
  // --no-freeze builds the old way, so the two can be compared on the same
  // blueprint. It is the only way to tell a placement bug from a machine simply
  // settling into its rest state.
  const stats = (flag('dry') || flag('no-freeze')) ? await fill() : await withFrozenTicks(rcon, fill)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${flag('dry') ? 'DRY RUN' : 'placed'}: ${stats.cells} cells as ${stats.boxes} fills${flag('dry') ? '' : `, ${stats.changed} blocks changed in ${secs}s`}`)
  if (stats.errors) {
    console.log(`${stats.errors} fill commands errored:`)
    for (const e of stats.firstErrors) console.log('   ' + e)
  }

  if (!flag('dry')) {
    const v = await verifySample(rcon, origin, blocks)
    console.log(`verified ${v.ok}/${v.checked} sampled cells exact${v.computed ? `, ${v.computed} differ only in server-computed state (leaf distance, connections)` : ''}${v.settled ? `, ${v.settled} moving parts that have settled since the fill` : ''}${v.unloaded ? `, ${v.unloaded} in chunks that would not stay loaded` : ''}${v.mismatched ? `, ${v.mismatched} genuinely wrong` : ''}`)
    for (const b of v.examples) console.log('   ' + b)

    if (setup.length) {
      const cmds = machines.setupCommands({ setup }, origin)
      console.log(`running ${cmds.length} setup commands`)
      for (const c of cmds) {
        const out = await rcon.send(c)
        if (/error|Unknown|Expected|Failed/i.test(out)) console.log(`   ! ${c.slice(0, 60)} -> ${out.trim().slice(0, 80)}`)
      }
    }
  }
  rcon.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
