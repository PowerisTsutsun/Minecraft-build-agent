'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

// ---------------------------------------------------------------------------
// Reading blocks straight out of the world's region files.
//
// RCON has no command that answers "what block is at this position" -
// /execute if block only tests a guess you already have. So capturing an
// existing build on a server the bot cannot log into means reading Anvil
// region files directly. The format has been stable since 1.18 and stores
// block names as strings with a per-section palette, so this works on any
// version without minecraft-data knowing the protocol.
//
// Always `save-all flush` over rcon before reading, or recent edits are still
// only in memory. Open read-only; never write here.
//
// 26.2 moved dimensions: overworld regions are now under
// world/dimensions/minecraft/overworld/region, with the old world/region as a
// fallback for older worlds.
// ---------------------------------------------------------------------------

const SECTOR = 4096

function regionDir (worldDir, dimension = 'overworld') {
  const modern = path.join(worldDir, 'dimensions', 'minecraft', dimension, 'region')
  if (fs.existsSync(modern)) return modern
  if (dimension === 'overworld') {
    const legacy = path.join(worldDir, 'region')
    if (fs.existsSync(legacy)) return legacy
  }
  throw new Error(`no region directory for ${dimension} under ${worldDir}`)
}

function toBigUint64 (pair) {
  // prismarine-nbt gives longs as [high, low] signed 32-bit ints.
  return (BigInt(pair[0] >>> 0) << 32n) | BigInt(pair[1] >>> 0)
}

// Chunk block arrays are padded: an entry never straddles two longs. (Litematica
// packs them contiguously instead - same idea, different rule, and mixing the
// two silently yields garbage blocks.)
function unpackPadded (longs, bits, count) {
  const perLong = Math.floor(64 / bits)
  const mask = (1n << BigInt(bits)) - 1n
  const out = new Uint16Array(count)
  for (let i = 0; i < count; i++) {
    const longIndex = Math.floor(i / perLong)
    if (longIndex >= longs.length) break
    const shift = BigInt((i % perLong) * bits)
    out[i] = Number((longs[longIndex] >> shift) & mask)
  }
  return out
}

function specOfPaletteEntry (entry) {
  const name = String(entry.Name || 'minecraft:air').replace(/^minecraft:/, '')
  const props = entry.Properties
  if (!props) return name
  const keys = Object.keys(props).sort()
  if (!keys.length) return name
  return `${name}[${keys.map(k => `${k}=${props[k]}`).join(',')}]`
}

class World {
  constructor (worldDir, dimension = 'overworld') {
    this.dir = regionDir(worldDir, dimension)
    this.regions = new Map()
    this.chunks = new Map()
  }

  _region (rx, rz) {
    const key = `${rx},${rz}`
    if (this.regions.has(key)) return this.regions.get(key)
    const file = path.join(this.dir, `r.${rx}.${rz}.mca`)
    let buf = null
    try { buf = fs.readFileSync(file) } catch (err) { buf = null }
    this.regions.set(key, buf)
    return buf
  }

  // Returns a Map of "sectionY" -> { palette, indices } or null if ungenerated.
  _chunk (cx, cz) {
    const key = `${cx},${cz}`
    if (this.chunks.has(key)) return this.chunks.get(key)
    const buf = this._region(cx >> 5, cz >> 5)
    let result = null
    if (buf && buf.length >= SECTOR * 2) {
      const idx = (cx & 31) + (cz & 31) * 32
      const offset = (buf.readUInt8(idx * 4) << 16 | buf.readUInt8(idx * 4 + 1) << 8 | buf.readUInt8(idx * 4 + 2)) * SECTOR
      const sectors = buf.readUInt8(idx * 4 + 3)
      if (offset > 0 && sectors > 0 && offset + 5 <= buf.length) {
        const length = buf.readInt32BE(offset)
        const compression = buf.readUInt8(offset + 4)
        const raw = buf.subarray(offset + 5, offset + 4 + length)
        let data
        try {
          if (compression === 1) data = zlib.gunzipSync(raw)
          else if (compression === 2) data = zlib.inflateSync(raw)
          else data = raw
        } catch (err) { data = null }
        if (data) {
          try {
            const root = nbt.simplify(nbt.parseUncompressed(data))
            const sections = new Map()
            for (const s of (root.sections || [])) {
              const bs = s.block_states
              if (!bs || !bs.palette) continue
              const palette = bs.palette.map(specOfPaletteEntry)
              let indices = null
              if (palette.length > 1 && bs.data) {
                const bits = Math.max(4, Math.ceil(Math.log2(palette.length)))
                const longs = bs.data.map(toBigUint64)
                indices = unpackPadded(longs, bits, 4096)
              }
              sections.set(s.Y, { palette, indices })
            }
            result = sections
          } catch (err) { result = null }
        }
      }
    }
    this.chunks.set(key, result)
    return result
  }

  // Full block spec ("oak_stairs[facing=north,...]"), or 'air' outside any
  // generated chunk. Null only when the chunk exists but the section does not.
  getBlock (x, y, z) {
    const sections = this._chunk(x >> 4, z >> 4)
    if (!sections) return 'air'
    const sy = Math.floor(y / 16)
    const section = sections.get(sy)
    if (!section) return 'air'
    if (!section.indices) return section.palette[0]
    const lx = x & 15
    const lz = z & 15
    const ly = ((y % 16) + 16) % 16
    return section.palette[section.indices[ly * 256 + lz * 16 + lx]] || 'air'
  }
}

module.exports = { World, regionDir }
