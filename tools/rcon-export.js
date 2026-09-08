'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Capture an existing build from a server the bot cannot log into, and save it
// as a blueprint. Reads the region files (see src/rcon/anvil.js) because RCON
// cannot report what block is at a position.
//
//   node tools/rcon-export.js --server mc-test --player PowerisTsutsun --name house7
//   node tools/rcon-export.js --server mc-test --center 100 70 -50 --name barn --radius 24

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')
const { connect } = require('../src/rcon/client')
const world = require('../src/rcon/world')
const { World } = require('../src/rcon/anvil')
const schemMod = require('../src/building/schematic')

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }

// Terrain the world grew on its own. Everything else is somebody's build.
const NATURAL = /^(air|cave_air|void_air|grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|stone|deepslate|granite|diorite|andesite|tuff|calcite|gravel|sand|red_sand|sandstone|red_sandstone|clay|water|lava|bedrock|snow|snow_block|ice|packed_ice|blue_ice|powder_snow|short_grass|tall_grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|kelp|kelp_plant|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|.*_leaves|.*_log|.*_wood|.*_sapling|.*_mushroom|moss_block|moss_carpet|azalea|flowering_azalea|hanging_roots|cave_vines.*|glow_lichen|vine|pointed_dripstone|dripstone_block|amethyst.*|budding_amethyst|.*_ore|raw_.*_block|obsidian|magma_block|soul_sand|soul_soil|netherrack|basalt|blackstone|end_stone|.*_coral.*|sculk.*|farmland|dirt_path|pumpkin|melon|.*_stem|sugar_cane|bamboo|cactus|lily_pad|big_dripleaf|small_dripleaf|spore_blossom|pale_moss.*|pale_hanging_moss|creaking_heart|resin.*)(\[.*)?$/

const baseOf = spec => spec.split('[')[0]

;(async () => {
  const serverName = arg('server', SERVER)
  const servers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rcon-servers.json'), 'utf8'))
  const cfg = servers[serverName]
  if (!cfg) throw new Error(`unknown server "${serverName}"`)
  const name = arg('name')
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new Error('--name must be lowercase letters, digits, - or _')

  const radius = Number(arg('radius', 32))
  const up = Number(arg('up', 40))
  const down = Number(arg('down', 6))

  const rcon = await connect({ host: cfg.host, port: cfg.port, password: cfg.password })
  // Recent edits live in memory until the server writes them out.
  await rcon.send('save-all flush')
  await new Promise(r => setTimeout(r, 1500))

  let centre
  if (arg('center') !== null) {
    const i = process.argv.indexOf('--center')
    centre = new Vec3(Number(process.argv[i + 1]), Number(process.argv[i + 2]), Number(process.argv[i + 3]))
  } else {
    const p = await world.playerPos(rcon, arg('player'))
    if (!p) throw new Error('could not read that player position - are they online?')
    centre = p.floored()
  }
  console.log(`centre ${centre.x},${centre.y},${centre.z}  window +-${radius}, ${down} down / ${up} up`)

  const w = new World(cfg.world || `/servers/${serverName}/world`)
  const lo = new Vec3(centre.x - radius, Math.max(-64, centre.y - down), centre.z - radius)
  const hi = new Vec3(centre.x + radius, Math.min(319, centre.y + up), centre.z + radius)

  // --- find the built structure nearest the player ------------------------
  const built = new Map()
  for (let y = lo.y; y <= hi.y; y++) {
    for (let z = lo.z; z <= hi.z; z++) {
      for (let x = lo.x; x <= hi.x; x++) {
        const spec = w.getBlock(x, y, z)
        if (!spec || NATURAL.test(spec)) continue
        built.set(`${x},${y},${z}`, spec)
      }
    }
  }
  if (!built.size) throw new Error('no built blocks in that window - move closer, or raise --radius')
  console.log(`${built.size} built blocks in the window`)

  // Cluster with a 2-block tolerance so a detached porch or fence still counts
  // as part of the same building, then keep the cluster nearest the centre.
  const seen = new Set()
  let best = null
  for (const startKey of built.keys()) {
    if (seen.has(startKey)) continue
    const cluster = []
    const queue = [startKey]
    seen.add(startKey)
    while (queue.length) {
      const k = queue.pop()
      cluster.push(k)
      const [x, y, z] = k.split(',').map(Number)
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const nk = `${x + dx},${y + dy},${z + dz}`
        if (built.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk) }
      }
    }
    const dist = Math.min(...cluster.map(k => {
      const [x, y, z] = k.split(',').map(Number)
      return Math.hypot(x - centre.x, (y - centre.y) * 0.5, z - centre.z)
    }))
    if (!best || dist < best.dist || (dist === best.dist && cluster.length > best.cluster.length)) best = { cluster, dist }
  }
  console.log(`nearest cluster: ${best.cluster.length} blocks, ${best.dist.toFixed(1)} away`)

  const blo = new Vec3(Infinity, Infinity, Infinity)
  const bhi = new Vec3(-Infinity, -Infinity, -Infinity)
  for (const k of best.cluster) {
    const [x, y, z] = k.split(',').map(Number)
    blo.x = Math.min(blo.x, x); bhi.x = Math.max(bhi.x, x)
    blo.y = Math.min(blo.y, y); bhi.y = Math.max(bhi.y, y)
    blo.z = Math.min(blo.z, z); bhi.z = Math.max(bhi.z, z)
  }
  // One layer of the ground it stands on, so it can be re-placed flush.
  blo.y = Math.max(-64, blo.y - 1)
  const size = bhi.minus(blo).offset(1, 1, 1)
  console.log(`capture box ${blo.x},${blo.y},${blo.z} .. ${bhi.x},${bhi.y},${bhi.z}  (${size.x}x${size.y}x${size.z})`)

  // --- write it as a .schem ----------------------------------------------
  const version = cfg.readVersion || DATA_VERSION
  const Block = require('prismarine-block')(version)
  const registry = require('minecraft-data')(version)
  const paletteIds = [0]
  const indexOf = new Map([['air', 0]])
  const data = new Array(size.x * size.y * size.z).fill(0)
  const unknown = new Map()
  let solid = 0

  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const spec = w.getBlock(blo.x + x, blo.y + y, blo.z + z)
        if (!spec || baseOf(spec) === 'air' || baseOf(spec) === 'cave_air' || baseOf(spec) === 'void_air') continue
        if (!indexOf.has(spec)) {
          const base = baseOf(spec)
          const def = registry.blocksByName[base]
          if (!def) { unknown.set(base, (unknown.get(base) || 0) + 1); continue }
          let stateId = def.defaultState
          try { stateId = Block.fromString(`minecraft:${spec}`, 0).stateId } catch (err) { /* keep default */ }
          indexOf.set(spec, paletteIds.length)
          paletteIds.push(stateId)
        }
        const pi = indexOf.get(spec)
        if (pi === undefined) continue
        data[(y * size.z + z) * size.x + x] = pi
        solid++
      }
    }
  }
  if (unknown.size) console.log('skipped blocks this version does not know:', [...unknown.keys()].join(', '))

  const schematic = new Schematic(version, size, new Vec3(0, 0, 0), paletteIds, data)
  const outFile = path.join(schemMod.SCHEMATIC_DIR, `${name}.schem`)
  fs.writeFileSync(outFile, await schematic.write())
  console.log(`wrote ${outFile}: ${solid} blocks, palette ${paletteIds.length}`)

  // --- register the alias -------------------------------------------------
  const aliasPath = path.join(schemMod.SCHEMATIC_DIR, 'aliases.json')
  const aliases = JSON.parse(fs.readFileSync(aliasPath, 'utf8'))
  aliases[name] = `${name}.schem`
  fs.writeFileSync(aliasPath, JSON.stringify(aliases, null, 2) + '\n')
  console.log(`registered as !build /${name}`)
  rcon.close()
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
