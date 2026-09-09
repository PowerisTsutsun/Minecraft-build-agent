'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Build into ANY server version over RCON - no bot, no protocol support needed.
//
//   node tools/rcon-build.js --server mc-test --what /house1 --player <name>
//   node tools/rcon-build.js --host 127.0.0.1 --port 25576 --what /house1 ...
//
// Credentials come from rcon-servers.json (which may say "${RCON_PASSWORD}" so
// the secret lives in .env). --password still works, but a password on argv is
// visible in `ps` and in shell history, so prefer --server.
//   node tools/rcon-build.js ... --what 31497.litematic --at 100 72 -190
//
// --what takes an aliases.json name (/house1), a schematic filename, or
// template:<name>. --player builds at that player's crosshair.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { connect } = require('../src/rcon/client')
const world = require('../src/rcon/world')
const { fillBlocks, verifySample } = require('../src/rcon/build')
const schem = require('../src/building/schematic')
const templates = require('../src/building/templates')
const placer = require('../src/building/bounds')

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
    const file = path.join(__dirname, '..', 'rcon-servers.json')
    try {
      const found = JSON.parse(fs.readFileSync(file, 'utf8'))[name]
      if (!found) throw new Error(`no "${name}" entry in rcon-servers.json`)
      entry = found
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

function resolveWhat (what) {
  if (what.startsWith('/')) {
    const aliases = JSON.parse(fs.readFileSync(path.join(schem.SCHEMATIC_DIR, 'aliases.json'), 'utf8'))
    const hit = aliases[what.slice(1).toLowerCase()]
    if (!hit) throw new Error(`no blueprint "${what}" - have: ${Object.keys(aliases).filter(k => !k.startsWith('_')).join(' ')}`)
    return hit
  }
  return what
}

;(async () => {
  const version = arg('version', DATA_VERSION) // which minecraft-data to READ the file with
  const what = resolveWhat(arg('what'))
  const verifyOnly = flag('verify-only')
  const rcon = await connect(target())

  // --- load blocks -------------------------------------------------------
  let blocks, sink = 0, setup = [], label = what
  if (what.startsWith('template:')) {
    const name = what.slice('template:'.length)
    const info = await templates.load(name, version)
    blocks = templates.schematicToBlocks(info.schematic).blocks
    sink = Number(info.meta.ground) || 0
    setup = info.setup
    label = `template ${name}`
  } else {
    const loaded = await schem.loadSchematic(what, version)
    blocks = schem.schematicToBlocks(loaded).blocks
    sink = schem.groundLayers(loaded)
    label = `schematic ${what}`
  }
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
    console.log(`verified ${v.ok}/${v.checked} sampled cells exact${v.computed ? `, ${v.computed} differ only in server-computed state` : ''}${v.mismatched ? `, ${v.mismatched} genuinely wrong` : ''}`)
    for (const b of v.examples) console.log('   ' + b)
    rcon.close(); return
  }

  const t0 = Date.now()
  const stats = await fillBlocks(rcon, origin, blocks, {
    label,
    dryRun: flag('dry'),
    onProgress: (i, n) => console.log(`  ...${i}/${n} fills`)
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${flag('dry') ? 'DRY RUN' : 'placed'}: ${stats.cells} cells as ${stats.boxes} fills${flag('dry') ? '' : `, ${stats.changed} blocks changed in ${secs}s`}`)
  if (stats.errors) {
    console.log(`${stats.errors} fill commands errored:`)
    for (const e of stats.firstErrors) console.log('   ' + e)
  }

  if (!flag('dry')) {
    const v = await verifySample(rcon, origin, blocks)
    console.log(`verified ${v.ok}/${v.checked} sampled cells exact${v.computed ? `, ${v.computed} differ only in server-computed state (leaf distance, connections)` : ''}${v.mismatched ? `, ${v.mismatched} genuinely wrong` : ''}`)
    for (const b of v.examples) console.log('   ' + b)

    if (setup.length) {
      const cmds = templates.setupCommands({ setup }, origin)
      console.log(`running ${cmds.length} setup commands`)
      for (const c of cmds) {
        const out = await rcon.send(c)
        if (/error|Unknown|Expected|Failed/i.test(out)) console.log(`   ! ${c.slice(0, 60)} -> ${out.trim().slice(0, 80)}`)
      }
    }
  }
  rcon.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
