'use strict'

const fs = require('fs').promises
const fsSync = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { specOf } = require('./blockspec')
const { outsideIn } = require('./primitives')

// ---------------------------------------------------------------------------
// Schematic loading (.schem / .schematic) via prismarine-schematic.
//
// Converts a schematic into the same { pos, name } relative-coordinate array
// every primitive produces, so the placer, dry-run and undo paths need no
// special case for schematics at all.
//
// Two conversions matter:
//
//   - Schematics store an arbitrary origin (often negative). We rebase every
//     block against the schematic's own minimum corner so the result is
//     non-negative and origin-anchored, matching the primitives' contract.
//   - Block *states* are carried through as full specs (specOf), so a
//     schematic's stairs keep the way they face. The walking placer cannot
//     honour that, but the command/fill path can, and that is the live one.
// ---------------------------------------------------------------------------

const SCHEMATIC_DIR = process.env.MC_SCHEMATIC_DIR || path.join(__dirname, '..', '..', 'schematics')

// Blueprints are downloaded from the internet and dropped in by hand - that is
// the documented workflow - and `!build /<alias>` decompresses one straight from
// chat. Both bounds are far above any real file (the largest here is ~2 MB
// packed) and far below what would OOM-kill the bot on a Pi.
const MAX_FILE_BYTES = parseInt(process.env.MC_MAX_SCHEMATIC_BYTES || String(64 * 1024 * 1024), 10)
const MAX_UNPACKED_BYTES = parseInt(process.env.MC_MAX_SCHEMATIC_UNPACKED || String(256 * 1024 * 1024), 10)

// gunzip/inflate with an explicit ceiling, so a decompression bomb throws
// instead of consuming the machine. Anything already plain NBT passes through.
function decompress (buffer) {
  const zlib = require('zlib')
  const opts = { maxOutputLength: MAX_UNPACKED_BYTES }
  try {
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) return zlib.gunzipSync(buffer, opts)
    if (buffer[0] === 0x78) return zlib.inflateSync(buffer, opts)
  } catch (err) {
    throw new Error(`refusing this file: it expands past ${MAX_UNPACKED_BYTES} bytes (${err.message})`)
  }
  return buffer
}

async function listSchematics () {
  try {
    const files = await fs.readdir(SCHEMATIC_DIR)
    return files.filter(f => /\.(schem|schematic|litematic)$/i.test(f))
  } catch (err) {
    return []
  }
}

function resolveSchematicPath (name) {
  // Names come from chat, so keep them inside the schematics dir - no
  // ../../etc/passwd, no absolute paths.
  const safe = path.basename(name)
  if (/\.(schem|schematic|litematic)$/i.test(safe)) return path.join(SCHEMATIC_DIR, safe)
  // Bare name: prefer .schem, then .schematic, then .litematic.
  for (const ext of ['schem', 'schematic', 'litematic']) {
    const candidate = path.join(SCHEMATIC_DIR, `${safe}.${ext}`)
    if (fsSync.existsSync(candidate)) return candidate
  }
  return path.join(SCHEMATIC_DIR, `${safe}.schem`)
}

async function loadSchematic (name, version) {
  const file = resolveSchematicPath(name)
  const size = fsSync.statSync(file).size
  if (size > MAX_FILE_BYTES) {
    throw new Error(`${path.basename(file)} is ${size} bytes, over the ${MAX_FILE_BYTES} byte limit`)
  }
  const buffer = await fs.readFile(file)
  if (/\.litematic$/i.test(file)) {
    // Litematica's own format - see litematic.js. Same Schematic object out.
    return require('./litematic').read(buffer, version)
  }
  // Sponge v3 has to be intercepted before prismarine-schematic sees it: its
  // reader only knows v1/v2 and fails with an error that looks like corruption.
  // See sponge3.js - v3 is a field rename, not a new encoding.
  const nbt = require('prismarine-nbt')
  // Decompress ourselves rather than letting prismarine-nbt do it unbounded.
  const { parsed } = await nbt.parse(decompress(buffer))
  const simplified = nbt.simplify(parsed)
  const v3 = require('./sponge3').read(simplified, version)
  if (v3) return v3

  const { Schematic } = require('prismarine-schematic')
  const schematic = await Schematic.read(decompress(buffer), version)
  return schematic
}

// Returns { blocks, size, skipped } where blocks is [{ pos, name }].
function schematicToBlocks (schematic) {
  const start = schematic.start()
  const end = schematic.end()

  const byLayer = new Map()
  let skipped = 0

  for (let y = start.y; y <= end.y; y++) {
    for (let x = start.x; x <= end.x; x++) {
      for (let z = start.z; z <= end.z; z++) {
        let block
        try {
          block = schematic.getBlock(new Vec3(x, y, z))
        } catch (err) {
          skipped++
          continue
        }
        if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue

        const rel = new Vec3(x - start.x, y - start.y, z - start.z)
        if (!byLayer.has(rel.y)) byLayer.set(rel.y, [])
        byLayer.get(rel.y).push({ pos: rel, name: specOf(block) })
      }
    }
  }

  // Bottom-up, and each layer outside-in, for the same reason the primitives
  // do it: the placer can only click a face that already has a solid neighbor,
  // and the bot must never strand itself over a hole it still has to fill.
  const width = end.x - start.x + 1
  const depth = end.z - start.z + 1
  const blocks = []
  for (const y of [...byLayer.keys()].sort((a, b) => a - b)) {
    blocks.push(...outsideIn(byLayer.get(y), width, depth))
  }

  return {
    blocks,
    size: { width, height: end.y - start.y + 1, depth },
    skipped
  }
}

// How many of the schematic's bottom layers are the ground it was built on.
//
// Most downloaded builds include a slice of terrain: the author selected from
// the grass down so the foundations came along. Placed as-is, that slice sits
// ON the natural grass and the whole build stands on a plinth - the medieval
// house at 2473,1251 did exactly that (2026-09-06). A layer counts as ground
// when it is nearly solid AND mostly terrain blocks; a town whose bottom
// layers are solid but full of foundations and walls (30808: 39% terrain)
// stays put, because sinking it would bury its ground floors. The caller
// lowers the origin by this many so the top ground layer replaces the grass.
const TERRAIN = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mud|mycelium|stone|deepslate|cobblestone|andesite|diorite|granite|tuff|gravel|sand|red_sand|sandstone|red_sandstone|clay|moss_block|pale_moss_block|dirt_path|farmland|water|snow_block|short_grass|tall_grass|fern|large_fern|moss_carpet|dandelion|poppy|azure_bluet|cornflower|oxeye_daisy|.*_flower|.*_leaves|.*_log|.*_sapling)$/
const GROUND_MAX_LAYERS = 6

function groundLayers (schematic) {
  const start = schematic.start()
  const end = schematic.end()
  const area = schematic.size.x * schematic.size.z
  let layers = 0
  for (let y = start.y; y <= end.y && layers < GROUND_MAX_LAYERS; y++) {
    let filled = 0
    let terrain = 0
    for (let z = start.z; z <= end.z; z++) {
      for (let x = start.x; x <= end.x; x++) {
        let b
        try { b = schematic.getBlock(new Vec3(x, y, z)) } catch (err) { continue }
        if (!b || b.name === 'air') continue
        filled++
        if (TERRAIN.test(b.name)) terrain++
      }
    }
    if (filled / area >= 0.9 && terrain / filled >= 0.5) layers++
    else break
  }
  return layers
}

module.exports = { loadSchematic, schematicToBlocks, listSchematics, groundLayers, SCHEMATIC_DIR }
