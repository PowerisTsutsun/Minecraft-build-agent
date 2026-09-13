'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')
// Inventory every schematic in schematics/: dims, block count, palette, unknowns.
const fs = require('fs'); const path = require('path'); const { Vec3 } = require('vec3')
const { loadSchematic, SCHEMATIC_DIR } = require('../src/building/schematic')
const registry = require('minecraft-data')(DATA_VERSION)

// ---------------------------------------------------------------------------
// What KIND of thing is this file? Downloaded collections mix buildings with
// terrain grabs and redstone machines, and they want handling differently: a
// 2.5M-block landscape capture is not something you ever "build", and a farm
// wants its setup.txt before it does anything. The signal is already in the
// stats we just computed - dimensions, palette size and the top materials.
// ---------------------------------------------------------------------------

const MAX_BLOCKS = parseInt(process.env.MC_MAX_BLOCKS || '500000', 10)

// Blocks that mean "this is landscape someone selected", not "this is a build".
const NATURAL = /^(stone|dirt|grass_block|gravel|sand|sandstone|andesite|diorite|granite|deepslate|tuff|water|lava|coarse_dirt|podzol|clay|bedrock|netherrack|snow|snow_block|ice|packed_ice|blue_ice|moss_block|mud|calcite|magma_block|obsidian|.*_ore|.*_leaves|.*_log|.*_wood)$/

// Machinery, counted over the WHOLE build. The top-6 material list is no use
// here: a 369k-block sorting hall is 72% stone, so by dominant material it
// reads as a hillside - while carrying 1718 hoppers and 301 comparators.
const PARTS = /^(hopper|crafter|dropper|dispenser|piston|sticky_piston|observer|comparator|repeater|redstone_wire|redstone_torch|redstone_wall_torch|redstone_block|lever|rail|powered_rail|detector_rail|activator_rail|chest|trapped_chest|barrel|furnace|blast_furnace|smoker|composter|nether_portal|spawner|trial_spawner|note_block|target|daylight_detector|tripwire_hook|slime_block|honey_block|water|lava|magma_block|bubble_column|soul_sand|brewing_stand|cauldron)$/

function share (top, test) {
  let pct = 0
  for (const line of top || []) {
    const m = /^(\S+) (\d+)%$/.exec(line)
    if (m && test(m[1])) pct += Number(m[2])
  }
  return pct
}
function has (top, test) { return (top || []).some(l => test(l.split(' ')[0])) }

// Names already in aliases.json were chosen by someone who looked at the build.
// That beats any heuristic, so an existing alias fixes the kind.
const ALIASES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(SCHEMATIC_DIR, 'aliases.json'), 'utf8')) } catch (e) { return {} }
})()
const NAMED = new Map()
for (const [name, file] of Object.entries(ALIASES)) {
  if (name.startsWith('_') || typeof file !== 'string' || file.startsWith('template:')) continue
  const kind = /^([a-z]+?)\d*$/.exec(name)
  if (kind) NAMED.set(file, kind[1])
}
const ALIAS_KIND = { colosseum: 'build', town: 'build', garden: 'build', enchantroom: 'redstone', ironfarm: 'farm', goldfarm: 'farm' }

function classify (e) {
  if (e.error) return 'unreadable'
  const named = NAMED.get(e.file)
  if (named) return ALIAS_KIND[named] || named
  const [w, h, d] = (e.size || '0x0x0').split('x').map(Number)
  const naturalShare = share(e.top, n => NATURAL.test(n))
  const footprint = Math.max(w, d)
  const p = e.parts || {}
  const n = k => p[k] || 0

  // MACHINERY FIRST. Whatever a build is made of, if it is full of working
  // parts then that is what it is for, and burying it under 'terrain' because
  // its walls are stone is how a 1718-hopper sorter ends up with no name.
  if (n('nether_portal') >= 100) return 'farm'
  if (n('spawner') + n('trial_spawner') >= 1) return 'farm'
  // Standing water at scale plus a collection system: a mob or iron farm.
  if (n('water') >= 500 && n('hopper') >= 12) return 'farm'
  // Item sorting is filter hoppers read by comparators - but that pair also
  // shows up in any machine that routes items, and an automatic potion brewer
  // has 25 hoppers and 18 comparators while being nothing to do with sorting.
  // What separates a sorter is what it sorts INTO: a wall of chests.
  if (n('hopper') >= 8 && n('comparator') >= 4 && n('chest') + n('barrel') + n('trapped_chest') >= 20) return 'sorter'
  // Dust at scale means wiring, not decoration. Kept high enough that a build
  // with a few piston doors stays a build.
  if (n('redstone_wire') >= 50) return 'redstone'

  // Terrain: the category that must never be mistaken for a build - but only
  // once we know there is no machine inside it.
  if (naturalShare > 60 && e.blocks > 50000) return 'terrain'
  if (has(e.top, x => x === 'bedrock')) return 'terrain'

  // Statues are the giveaway case: enormous, very tall, and almost no palette,
  // because they are one material carved into a shape.
  if (e.palette <= 20 && h > footprint) return 'statue'
  if (h > 2 * footprint) return 'tower'
  if (e.blocks < 10000) return 'house'
  return 'build'
}

;(async () => {
  const files = fs.readdirSync(SCHEMATIC_DIR).filter(f => /\.(schem|schematic|litematic)$/i.test(f)).sort()
  const out = []
  for (const f of files) {
    const t0 = Date.now()
    try {
      const s = await loadSchematic(f, DATA_VERSION)
      const st = s.start(), en = s.end(); const size = s.size
      const tally = {}; let n = 0; const unknown = new Set(); const parts = {}
      for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
        let b; try { b = s.getBlock(new Vec3(x, y, z)) } catch (e) { continue }
        if (!b || b.name === 'air') continue
        n++; tally[b.name] = (tally[b.name] || 0) + 1
        if (PARTS.test(b.name)) parts[b.name] = (parts[b.name] || 0) + 1
        if (!registry.blocksByName[b.name]) unknown.add(b.name)
      }
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${Math.round(100 * v / n)}%`)
      const meta = s.litematic ? `"${s.litematic.name}" by ${s.litematic.author}` : ''
      // Only the parts worth keeping, biggest first - the tail is all ones.
      const partList = Object.entries(parts).sort((a, b) => b[1] - a[1]).slice(0, 12)
      const entry = { parts: Object.fromEntries(partList), file: f, meta, size: `${size.x}x${size.y}x${size.z}`, blocks: n, palette: Object.keys(tally).length, top, unknown: [...unknown, ...Object.keys((s.litematic && s.litematic.unknown) || {})], ms: Date.now() - t0 }
      entry.kind = classify(entry)
      if (entry.blocks > MAX_BLOCKS) entry.overCap = `${entry.blocks} blocks exceeds MC_MAX_BLOCKS ${MAX_BLOCKS}`
      out.push(entry)
    } catch (err) { out.push({ file: f, kind: 'unreadable', error: err.message.slice(0, 120) }) }
  }
  for (const o of out) console.log(JSON.stringify(o))
  fs.writeFileSync(path.join(SCHEMATIC_DIR, 'catalog.json'), JSON.stringify(out, null, 2) + '\n')
})()
