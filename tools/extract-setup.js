'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Pull the container contents out of a schematic and write them as setup.txt.
//
// A downloaded machine is two things: blocks, and what is inside the blocks.
// prismarine-schematic reads the first and discards the second, so a sorter
// builds with 1718 empty hoppers - and an empty filter hopper passes
// everything, which is why "the sorting didn't work" and why the gold farm
// posted its gold into the lava. The fix has been to hand-transcribe the
// contents into setup.txt. They are already in the file; this reads them out.
//
//   node tools/extract-setup.js --what 17071.schem [--out setup.txt] [--all]
//
// By default only containers holding something are emitted. --all adds signs,
// spawners and every other block entity that carries data.

const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { snbt, compoundWithout } = require('../src/building/snbt')
const schemMod = require('../src/building/schematic')
const { baseName } = require('../src/building/blockspec')

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const has = n => process.argv.includes(`--${n}`)

const what = arg('what')
if (!what) { console.error('usage: extract-setup.js --what <schematic> [--out <file>] [--all]'); process.exit(1) }

// Pre-1.13 items are {id, Count:Nb, Damage:Ns, tag:{...}}; 26.2 wants
// {id, count:N, components:{...}}. Count and Slot map straight across, and
// Damage:0 on a non-damageable item carried no meaning. A `tag` is a different
// matter - written books, enchantments, potion types all lived in there and
// each needs its own modern component - so anything carrying one is left for a
// human rather than guessed at.
function modernizeItems (itemsNode) {
  if (!itemsNode || itemsNode.type !== 'list') return { node: null, why: 'not a list' }
  const items = (itemsNode.value && itemsNode.value.value) || []
  const out = []
  for (const it of items) {
    if (it.tag) return { node: null, why: 'carries pre-1.13 `tag` data (book, potion or enchantment)' }
    if (it.Damage && it.Damage.value !== 0) return { node: null, why: `Damage:${it.Damage.value} encoded a variant that is now a separate item id` }
    const id = it.id && it.id.value
    if (typeof id !== 'string' || /^\d+$/.test(id)) return { node: null, why: 'numeric item id, pre-1.8' }
    const count = it.count ? it.count.value : (it.Count ? it.Count.value : 1)
    const v = { id: { type: 'string', value: id.startsWith('minecraft:') ? id : 'minecraft:' + id },
                count: { type: 'int', value: count } }
    if (it.Slot) v.Slot = { type: 'byte', value: it.Slot.value }
    out.push(v)
  }
  return { node: { type: 'list', value: { type: 'compound', value: out } }, why: null }
}

// Data worth carrying. Everything else on a block entity is either derivable
// or noise (a chest's id and position are already implied by where we put it).
const SKIP_KEYS = ['id', 'Id', 'x', 'y', 'z', 'Pos', 'keepPacked', 'components']
const INTERESTING = /Items|Item|front_text|back_text|SpawnData|SpawnPotentials|patterns|Book|Base|note|Levels|primary_effect|secondary_effect|RecipesUsed|Lock|CustomName|is_waxed/

;(async () => {
  const file = path.join(schemMod.SCHEMATIC_DIR, path.basename(what))
  const { parsed } = await nbt.parse(fs.readFileSync(file))
  const root = parsed.value

  // Three formats put block entities in three places, with two position shapes.
  let list = null; let format = null
  if (root.Schematic && root.Schematic.value.Blocks) {
    list = root.Schematic.value.Blocks.value.BlockEntities; format = 'sponge v3'
  } else if (root.BlockEntities) { list = root.BlockEntities; format = 'sponge v2' }
  else if (root.TileEntities) { list = root.TileEntities; format = 'mcedit' }

  const entries = (list && list.value && list.value.value) || []
  console.log(`# ${path.basename(file)} - ${format || 'no block entities'}, ${entries.length} block entities`)
  if (!entries.length) { console.log('# nothing to extract'); return }

  // Cross-check every position against the decoded blocks. A block entity that
  // does not land on its own block means the coordinate frame is off, and a
  // setup.txt built on that would /data merge into the wrong cells - the same
  // off-by-one that popped the sorter's comparators once already.
  const schematic = await schemMod.loadSchematic(path.basename(file), DATA_VERSION)
  const start = schematic.start()
  const blockAt = (x, y, z) => {
    try { return baseName(require('../src/building/blockspec').specOf(schematic.getBlock(start.offset(x, y, z)))) }
    catch (e) { return null }
  }

  const lines = []
  let emitted = 0, matched = 0, mismatched = 0, empty = 0, legacy = 0, converted = 0
  const kinds = {}

  for (const e of entries) {
    const v = e.value || e
    const idNode = v.id || v.Id
    const id = idNode ? String(idNode.value).replace('minecraft:', '') : '?'
    // Pos is an intArray in sponge v3, a list in some v2 writers, and three
    // separate int tags in mcedit. Unwrap whichever this is.
    let x, y, z
    if (v.Pos) {
      const p = v.Pos.value
      const arr = Array.isArray(p) ? p : (p && Array.isArray(p.value) ? p.value : null)
      if (!arr || arr.length < 3) { empty++; continue }
      ;[x, y, z] = arr.map(n => (typeof n === 'object' && n !== null ? n.value : n))
    } else if (v.x && v.y && v.z) { x = v.x.value; y = v.y.value; z = v.z.value }
    else { empty++; continue }

    const payload = compoundWithout({ type: 'compound', value: v }, SKIP_KEYS)
    const keys = Object.keys(payload.value)
    const useful = keys.filter(k => INTERESTING.test(k))
    const itemsNode = payload.value.Items
    const itemCount = itemsNode && itemsNode.value && itemsNode.value.value ? itemsNode.value.value.length : 0

    if (!useful.length || (!has('all') && itemCount === 0)) { empty++; continue }

    const here = blockAt(x, y, z)
    if (here && here.toLowerCase() === id.toLowerCase()) matched++
    else { mismatched++; lines.push(`# WARNING ${id} at ${x},${y},${z} but the schematic has ${here || 'nothing'} there`) }

    const keep = { type: 'compound', value: {} }
    for (const k of useful) keep.value[k] = payload.value[k]
    // Upgrade legacy item lists where the upgrade is unambiguous.
    if (keep.value.Items && /\bCount:|\bDamage:|\btag:\{/.test(snbt(keep.value.Items))) {
      const { node, why } = modernizeItems(keep.value.Items)
      if (!node) { legacy++; lines.push(`# SKIPPED ${id} at ${x},${y},${z} - ${why}`); continue }
      keep.value.Items = node
      converted++
    }
    const text = snbt(keep)
    if (/\bCount:|\bDamage:|\btag:\{/.test(text)) { legacy++; lines.push(`# SKIPPED ${id} at ${x},${y},${z} - pre-1.13 NBT outside Items`); continue }
    lines.push(`/data merge block ~${x} ~${y} ~${z} ${text}`)
    kinds[id] = (kinds[id] || 0) + 1
    emitted++
  }

  const header = [
    `# Container contents for ${path.basename(file)}, extracted from the file's own`,
    '# block entities. A .schem stores these but prismarine-schematic drops them,',
    '# so without this every hopper and chest is placed empty - and an empty',
    '# filter hopper passes everything through instead of sorting it.',
    '#',
    `# ${emitted} of ${entries.length} block entities carry data worth restoring:`,
    `#   ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    '#',
    '# ~x ~y ~z are offsets from the template origin, resolved at placement by',
    '# templates.setupCommands(). Positions were checked against the decoded',
    `# blocks: ${matched} landed on their own block, ${mismatched} did not.`,
    ...(converted ? [`#`, `# ${converted} container(s) were upgraded from pre-1.13 item NBT.`] : []),
    ...(legacy ? [`#`, `# ${legacy} container(s) could not be upgraded automatically and are`,
                  `# listed as comments - each says why. Fill those in by hand if they matter.`] : []),
    ''
  ]
  const out = header.concat(lines).join('\n') + '\n'

  const dest = arg('out')
  if (dest) { fs.writeFileSync(dest, out); console.log(`wrote ${dest}`) } else { console.log(out) }
  console.error(`# ${emitted} emitted (${converted} upgraded), ${empty} skipped as empty, ${legacy} left as comments, ${matched} position-checked OK, ${mismatched} MISMATCHED`)
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1) })
