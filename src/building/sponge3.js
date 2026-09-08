'use strict'

// ---------------------------------------------------------------------------
// Sponge Schematic v3 -> v2 shim.
//
// prismarine-schematic 1.3.0 reads Sponge v1/v2 only. Handed a v3 file it dies
// inside its own reader with "Cannot read properties of undefined (reading
// 'length')" - which reads like a corrupt download and is not. v3 moved every
// field one level down and renamed two of them:
//
//   v2 (root)                v3 (root.Schematic)
//   Width/Height/Length      Width/Height/Length
//   Palette                  Blocks.Palette
//   BlockData                Blocks.Data
//   DataVersion              DataVersion
//
// The varint packing of the block array and the { "minecraft:stone": 3 } shape
// of the palette are byte-identical between the two versions, so this is a
// rename and nothing more. We remap the simplified NBT and hand it to
// prismarine-schematic's own sponge reader rather than reimplementing palette
// decoding and varint unpacking - the parts most likely to go subtly wrong.
//
// On the offset: v2 carries WorldEdit's paste offset at Metadata.WEOffsetX/Y/Z,
// which the sponge reader turns into schematic.start(). v3 has a bare `Offset`
// array, but that is the schematic's own origin field, NOT WorldEdit's paste
// offset - they are different things in the spec. Rather than conflate them we
// leave the offset at zero, so a v3 loads with its blocks at 0..size-1. Nothing
// downstream can tell the difference: start() is only a coordinate frame, and
// both schematicToBlocks and groundLayers rebase against it.
//
// v3 also carries Blocks.BlockEntities, which a v2 .schem structurally cannot.
// prismarine-schematic has nowhere to put them, so we hang them off the
// returned object as `blockEntities` - the chest and hopper contents that
// setup.txt currently has to supply by hand.
// ---------------------------------------------------------------------------

function isV3 (simplified) {
  const s = simplified && simplified.Schematic
  return !!(s && s.Version === 3 && s.Blocks && s.Blocks.Data)
}

// Simplified v3 NBT -> the object shape spongeSchematic.read() expects.
function toV2 (simplified) {
  const s = simplified.Schematic
  const palette = s.Blocks.Palette
  return {
    Version: 2,
    DataVersion: s.DataVersion,
    Width: s.Width,
    Height: s.Height,
    Length: s.Length,
    Palette: palette,
    PaletteMax: Object.keys(palette).length,
    BlockData: s.Blocks.Data,
    Metadata: {}
  }
}

// Returns a prismarine-schematic Schematic, or null if this is not a v3 file.
function read (simplified, version) {
  if (!isV3(simplified)) return null
  const sponge = require('prismarine-schematic/lib/spongeSchematic')
  const schematic = sponge.read(toV2(simplified), version)
  const entities = simplified.Schematic.Blocks.BlockEntities
  if (Array.isArray(entities) && entities.length) schematic.blockEntities = entities
  return schematic
}

module.exports = { isV3, toV2, read }
