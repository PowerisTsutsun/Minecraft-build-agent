'use strict'

const fs = require('fs').promises
const path = require('path')
const { Vec3 } = require('vec3')
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
//   - Block *states* are flattened to plain block names. A schematic's stairs
//     know which way they face; mineflayer's placeBlock does not let us
//     control that, so orientation is lost. Better to say so than to pretend.
// ---------------------------------------------------------------------------

const SCHEMATIC_DIR = process.env.MC_SCHEMATIC_DIR || path.join(__dirname, '..', '..', 'schematics')

async function listSchematics () {
  try {
    const files = await fs.readdir(SCHEMATIC_DIR)
    return files.filter(f => /\.(schem|schematic)$/i.test(f))
  } catch (err) {
    return []
  }
}

function resolveSchematicPath (name) {
  // Names come from chat, so keep them inside the schematics dir - no
  // ../../etc/passwd, no absolute paths.
  const safe = path.basename(name)
  const withExt = /\.(schem|schematic)$/i.test(safe) ? safe : `${safe}.schem`
  return path.join(SCHEMATIC_DIR, withExt)
}

async function loadSchematic (name, version) {
  const { Schematic } = require('prismarine-schematic')
  const file = resolveSchematicPath(name)
  const buffer = await fs.readFile(file)
  const schematic = await Schematic.read(buffer, version)
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
        byLayer.get(rel.y).push({ pos: rel, name: block.name })
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

module.exports = { loadSchematic, schematicToBlocks, listSchematics, SCHEMATIC_DIR }
