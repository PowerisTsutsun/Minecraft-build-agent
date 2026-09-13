'use strict'

// Sponge Schematic v3 loading. prismarine-schematic 1.3.0 reads v1/v2 only and
// dies on v3 with "Cannot read properties of undefined (reading 'length')" -
// an error that looks exactly like a corrupt download, which is how seven
// perfectly good files sat unusable in schematics/ as catalog errors.
//
// The shim is a field rename (see src/building/sponge3.js), so the risk is not
// that it throws - it is that it decodes to plausible-looking garbage. A
// mis-set palette or a misread varint stream still produces block names; they
// are just the wrong ones, in the wrong places. So these assertions go past
// "it loaded" and check that the decode is self-consistent with the file's own
// NBT header, and that stateful blocks come out with coherent states.

const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const sponge3 = require('../src/building/sponge3')
const { loadSchematic, schematicToBlocks } = require('../src/building/schematic')
const blueprints = require('../src/building/blueprints')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

// The files moved into blueprints/<group>/ and were renamed to their names, so
// they are looked up the way the bot looks them up rather than by filename.
const V3 = blueprints.resolve('house13')   // WorldEdit 7.3.5, cherry/quartz garden house
const V2 = blueprints.resolve('house7')    // a known-good v2, as the negative control
if (!V3 || !V2) { console.log('FAIL fixtures missing from blueprints/'); process.exit(1) }

async function simplifiedOf (file) {
  const buf = fs.readFileSync(file.path || file)
  const { parsed } = await nbt.parse(buf)
  return nbt.simplify(parsed)
}

;(async () => {
  // --- detection ------------------------------------------------------------
  const v3nbt = await simplifiedOf(V3)
  const v2nbt = await simplifiedOf(V2)

  check('isV3 recognises a v3 file', sponge3.isV3(v3nbt) === true)
  check('isV3 leaves a v2 file alone', sponge3.isV3(v2nbt) === false)
  check('isV3 tolerates junk', sponge3.isV3(null) === false && sponge3.isV3({}) === false)

  // --- the remap matches the file's own header ------------------------------
  // If these drift, every block position is silently wrong by a stride.
  const head = v3nbt.Schematic
  const mapped = sponge3.toV2(v3nbt)
  check('remap carries the dimensions across',
    mapped.Width === head.Width && mapped.Height === head.Height && mapped.Length === head.Length,
    `${mapped.Width}x${mapped.Height}x${mapped.Length} vs ${head.Width}x${head.Height}x${head.Length}`)
  check('remap carries DataVersion across', mapped.DataVersion === head.DataVersion)
  check('remap points BlockData at Blocks.Data', mapped.BlockData === head.Blocks.Data)
  check('remap points Palette at Blocks.Palette', mapped.Palette === head.Blocks.Palette)
  check('remap declares PaletteMax to match the palette',
    mapped.PaletteMax === Object.keys(head.Blocks.Palette).length)
  // The offset is deliberately dropped, not mapped - v3's Offset is the
  // schematic's own origin, not WorldEdit's paste offset. Blocks must land at
  // 0..size-1 so the rest of the pipeline sees what it sees for any other file.
  check('remap leaves the offset at zero', Object.keys(mapped.Metadata).length === 0)

  // --- the decode ------------------------------------------------------------
  const v2pre = await loadSchematic(V2.path, '26.1')   // baseline for the fidelity check below
  const s = await loadSchematic(V3.path, '26.1')
  check('loaded size matches the NBT header',
    s.size.x === head.Width && s.size.y === head.Height && s.size.z === head.Length,
    `${s.size.x}x${s.size.y}x${s.size.z}`)
  check('blocks start at the origin',
    s.start().x === 0 && s.start().y === 0 && s.start().z === 0,
    `start ${s.start()}`)

  const { blocks } = schematicToBlocks(s)
  const volume = head.Width * head.Height * head.Length
  check('block count is under the volume and not empty',
    blocks.length > 0 && blocks.length < volume,
    `${blocks.length} of ${volume} cells`)

  // A varint stream read at the wrong stride decodes to palette indices that
  // are uniformly distributed over the palette - so the tell is not an error,
  // it is that the result has no dominant material. A real build always does.
  const tally = {}
  for (const b of blocks) {
    const base = b.name.split('[')[0]
    tally[base] = (tally[base] || 0) + 1
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1])
  const topShare = ranked[0][1] / blocks.length
  check('the decode has a dominant material, not noise',
    topShare > 0.05, `top block ${ranked[0][0]} is only ${(topShare * 100).toFixed(1)}%`)
  // Palette round-trip: read each palette entry back out of the decoded palette
  // and see whether it names the block the file said it was.
  //
  // This is NOT 100%, and the shortfall is not the shim's doing. Every Sponge
  // file is decoded through getStateId() against whatever registry version the
  // caller passed (26.1 here), while the file was written against its own
  // DataVersion. Where a block's property set moved between those versions the
  // computed state id overflows into the NEXT block in registry order - which
  // is why azalea_leaves comes back as flowering_azalea_leaves and pink_petals
  // as wildflowers. Measured across the collection: v2 files lose 0.7%-4.2% of
  // their palette exactly the same way. See docs/schematic-palette-drift.md.
  //
  // So the assertion that means something is: v3 decodes at least as faithfully
  // as v2 does. If the shim were wrong, this number would collapse, not shift.
  const Block = require('prismarine-block')('26.1')
  function fidelity (schematic, palette) {
    let ok = 0, total = 0
    for (const [str, id] of Object.entries(palette)) {
      const want = str.replace('minecraft:', '').split('[')[0]
      const sid = schematic.palette[id]
      total++
      if (sid !== undefined && Block.fromStateId(sid, 0).name === want) ok++
    }
    return { ok, total, share: ok / total }
  }
  const v3fid = fidelity(s, head.Blocks.Palette)
  const v2fid = fidelity(v2pre, v2nbt.Palette)
  check('v3 palette round-trips as faithfully as v2',
    v3fid.share >= 0.95 && v3fid.share >= v2fid.share - 0.05,
    `v3 ${(v3fid.share * 100).toFixed(1)}% (${v3fid.ok}/${v3fid.total}) vs v2 ${(v2fid.share * 100).toFixed(1)}%`)

  // Block states are the thing a base-name-only reader would lose silently.
  const stateful = blocks.filter(b => b.name.includes('['))
  check('block states survive the decode', stateful.length > 0, `${stateful.length} stateful cells`)
  const stairs = stateful.find(b => b.name.startsWith('smooth_quartz_stairs'))
  check('a stair carries a real facing',
    !!stairs && /facing=(north|south|east|west)/.test(stairs.name),
    stairs ? stairs.name : 'no smooth_quartz_stairs found')

  // v3 carries BlockEntities, which a v2 .schem structurally cannot. This is
  // the container inventory that setup.txt otherwise has to supply by hand.
  check('block entities are kept off the schematic',
    Array.isArray(s.blockEntities) && s.blockEntities.length > 0,
    s.blockEntities ? `${s.blockEntities.length}` : 'none kept')

  // --- the negative control --------------------------------------------------
  const v2blocks = schematicToBlocks(v2pre).blocks
  check('a v2 file still loads unchanged', v2blocks.length > 0, `${v2blocks.length} blocks`)

  console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
  process.exit(failures ? 1 : 0)
})().catch(err => {
  console.error('FAIL - threw:', err.stack)
  process.exit(1)
})
