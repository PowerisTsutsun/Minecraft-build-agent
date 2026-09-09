'use strict'

// Litematica (.litematic) reader. Produces the same Schematic object that
// prismarine-schematic gives us for a .schem, so everything downstream -
// schematicToBlocks, specOf, /fill - is unchanged.
//
// The format is gzipped NBT: Regions{ <name>: { Position, Size,
// BlockStatePalette [ {Name, Properties} ], BlockStates (long[]) } }. Size may
// be negative on any axis, meaning the region extends from Position in the
// negative direction. BlockStates is Litematica's own bit array: entries of
// ceil(log2(palette)) bits (minimum 2) packed contiguously across 64-bit
// longs WITHOUT the per-long padding that vanilla 1.16+ chunks use - an entry
// can straddle two longs. Index = (y * sizeZ + z) * sizeX + x.
//
// Block entities and entities are dropped, same as the .schem path: the bot
// places names and states, nothing that lives inside a block.

const fs = require('fs')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')

// Names that moved between the version a file was made in and 26.1.
const RENAMES = {
  chain: 'iron_chain',
  grass: 'short_grass',
  // A piston caught mid-stroke when the file was saved. Without its block
  // entity it is an invisible, unbreakable nothing - leave the cell empty.
  moving_piston: 'air'
}

function toBigUint64 (pair) {
  // prismarine-nbt hands longs over as [high, low] signed 32-bit ints.
  const hi = BigInt(pair[0] >>> 0)
  const lo = BigInt(pair[1] >>> 0)
  return (hi << 32n) | lo
}

function unpack (longs, bits, count) {
  const mask = (1n << BigInt(bits)) - 1n
  const out = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    const start = i * bits
    const startIdx = start >>> 6
    const endIdx = ((i + 1) * bits - 1) >>> 6
    const shift = BigInt(start & 63)
    let v
    if (startIdx === endIdx) {
      v = (longs[startIdx] >> shift) & mask
    } else {
      v = ((longs[startIdx] >> shift) | (longs[endIdx] << (64n - shift))) & mask
    }
    out[i] = Number(v)
  }
  return out
}

function stateIdFor (Block, registry, entry, unknown) {
  let name = String(entry.Name || 'minecraft:air').replace(/^minecraft:/, '')
  if (RENAMES[name]) name = RENAMES[name]
  const def = registry.blocksByName[name]
  if (!def) {
    unknown.set(name, (unknown.get(name) || 0) + 1)
    return 0
  }
  const props = entry.Properties || {}
  try {
    return Block.fromProperties(def.id, props, 0).stateId
  } catch (err) {
    // A property this version does not know - keep the block, lose the state.
    return def.defaultState
  }
}

// Matches schematic.js's ceiling; litematics arrive by the same route.
const MAX_UNPACKED_BYTES = parseInt(process.env.MC_MAX_SCHEMATIC_UNPACKED || String(256 * 1024 * 1024), 10)
// The declared region size decides a Uint32Array allocation before any block is
// read, so a file claiming 2000x200x2000 asks for 3.2 GB up front. Cap it at the
// same block budget a build is allowed to be.
const MAX_VOLUME = parseInt(process.env.MC_MAX_BLOCKS || '150000', 10) * 8

function read (buffer, version) {
  let unpacked
  try {
    unpacked = zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (err) {
    throw new Error(`refusing this litematic: it expands past ${MAX_UNPACKED_BYTES} bytes (${err.message})`)
  }
  const raw = nbt.parseUncompressed(unpacked)
  const root = nbt.simplify(raw)
  const regions = root.Regions || {}
  const names = Object.keys(regions)
  if (!names.length) throw new Error('litematic has no regions')

  const registry = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)

  // Enclosing box over every region, in litematic coordinates.
  const lo = new Vec3(Infinity, Infinity, Infinity)
  const hi = new Vec3(-Infinity, -Infinity, -Infinity)
  const placed = []
  for (const n of names) {
    const r = regions[n]
    const pos = new Vec3(r.Position.x, r.Position.y, r.Position.z)
    const sz = new Vec3(r.Size.x, r.Size.y, r.Size.z)
    const min = new Vec3(
      pos.x + (sz.x < 0 ? sz.x + 1 : 0),
      pos.y + (sz.y < 0 ? sz.y + 1 : 0),
      pos.z + (sz.z < 0 ? sz.z + 1 : 0))
    const abs = new Vec3(Math.abs(sz.x), Math.abs(sz.y), Math.abs(sz.z))
    lo.update(lo.min(min))
    hi.update(hi.max(min.plus(abs).offset(-1, -1, -1)))
    placed.push({ name: n, r, min, abs, longs: raw.value.Regions.value[n].value.BlockStates.value })
  }
  const size = hi.minus(lo).offset(1, 1, 1)
  // INJ-008: check the declared volume BEFORE new Uint32Array(...) below.
  const volume = size.x * size.y * size.z
  if (!Number.isFinite(volume) || volume <= 0 || volume > MAX_VOLUME) {
    throw new Error(`litematic declares a ${size.x}x${size.y}x${size.z} region (${volume} cells) - over the ${MAX_VOLUME} cell limit`)
  }

  // One shared palette of state ids; index 0 is air.
  const palette = [0]
  const paletteIndex = new Map([[0, 0]])
  const blocks = new Uint32Array(size.x * size.y * size.z)
  const unknown = new Map()
  let nonAir = 0

  for (const { r, min, abs, longs } of placed) {
    const local = (r.BlockStatePalette || []).map(e => {
      const id = stateIdFor(Block, registry, e, unknown)
      if (!paletteIndex.has(id)) { paletteIndex.set(id, palette.length); palette.push(id) }
      return paletteIndex.get(id)
    })
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(local.length, 1))))
    const count = abs.x * abs.y * abs.z
    const packed = unpack(longs.map(toBigUint64), bits, count)
    for (let y = 0; y < abs.y; y++) {
      for (let z = 0; z < abs.z; z++) {
        for (let x = 0; x < abs.x; x++) {
          const li = (y * abs.z + z) * abs.x + x
          const pi = local[packed[li]]
          if (pi === undefined || pi === 0) continue
          const gx = min.x - lo.x + x
          const gy = min.y - lo.y + y
          const gz = min.z - lo.z + z
          blocks[(gy * size.z + gz) * size.x + gx] = pi
          nonAir++
        }
      }
    }
  }

  const schematic = new Schematic(version, size, new Vec3(0, 0, 0), palette, Array.from(blocks))
  schematic.litematic = {
    name: root.Metadata && root.Metadata.Name,
    author: root.Metadata && root.Metadata.Author,
    regions: names,
    nonAir,
    unknown: Object.fromEntries(unknown)
  }
  return schematic
}

async function readFile (file, version) {
  return read(await fs.promises.readFile(file), version)
}

module.exports = { read, readFile, RENAMES }
