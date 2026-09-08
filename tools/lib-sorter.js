'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Shared between load-sorter.js and label-sorter.js so a slot's filter item and
// its label can never disagree: both walk the hopper chain in the same order
// and index the same item list.

const fs = require('fs')
const path = require('path')
const { baseName } = require('../src/building/blockspec')

// Never sorted, whatever the registry says: command-only or not obtainable in
// survival. A slot charged with one of these is a slot wasted, and a label
// showing a command block is embarrassing.
const UNOBTAINABLE = /^(.*command_block|structure_block|structure_void|jigsaw|barrier|light|debug_stick|knowledge_book|spawner|trial_spawner|vault|reinforced_deepslate|bedrock|end_portal_frame|chorus_plant|farmland|dirt_path|budding_amethyst|frogspawn|suspicious_sand|suspicious_gravel|petrified_oak_slab|player_head|.*_spawn_egg|infested_.*|filled_map|.*_smithing_template|.*_banner_pattern|.*_pottery_sherd|bundle|.*_bundle|enchanted_book|written_book|writable_book|ominous_bottle|tipped_arrow|spectral_arrow|firework_star|firework_rocket|heavy_core|trial_key|ominous_trial_key|air|.*_candle_cake|test_block|test_instance_block)$/

// Obtainable, but an intermediate nobody keeps: the six-sided wood variants
// and concrete powder. Dropped so the stairs and glass fit in 280 slots.
const NOT_WORTH_A_SLOT = /(^|_)wood$|^stripped_.*_(wood|hyphae)$|_concrete_powder$/

const CATEGORIES = [
  /_ingot$|^(coal|charcoal|diamond|emerald|quartz|amethyst_shard|lapis_lazuli|redstone|nether_star|raw_iron|raw_gold|raw_copper|netherite_scrap|echo_shard|prismarine_shard|prismarine_crystals)$/,
  /_ore$|^(ancient_debris|raw_iron_block|raw_gold_block|raw_copper_block)$/,
  /^(iron_block|gold_block|diamond_block|emerald_block|netherite_block|copper_block|lapis_block|redstone_block|coal_block|quartz_block|amethyst_block)$/,
  /^(cobblestone|stone|granite|diorite|andesite|deepslate|cobbled_deepslate|tuff|calcite|basalt|blackstone|netherrack|end_stone|obsidian|crying_obsidian|smooth_stone|sandstone|red_sandstone|mossy_cobblestone|stone_bricks|mossy_stone_bricks|deepslate_bricks|deepslate_tiles|polished_.*|.*_bricks|bricks|packed_mud|mud_bricks|glowstone|sea_lantern|shroomlight|prismarine|dark_prismarine)$/,
  /_planks$/, /_log$|_stem$/, /_leaves$/, /_sapling$|_propagule$/,
  /^(dirt|coarse_dirt|rooted_dirt|podzol|mud|clay|gravel|sand|red_sand|soul_sand|soul_soil|grass_block|moss_block|mycelium|snow_block|ice|packed_ice|blue_ice|magma_block|sponge|wet_sponge|hay_block|bone_block|dried_kelp_block|honey_block|slime_block)$/,
  /_glass$|_glass_pane$/, /_wool$/, /_terracotta$|^terracotta$/, /_concrete$/, /_dye$/, /_carpet$/,
  /_stairs$/, /_slab$/, /_wall$/, /_fence$|_fence_gate$/, /_door$/, /_trapdoor$/,
  /^(redstone_torch|torch|soul_torch|lantern|soul_lantern|repeater|comparator|piston|sticky_piston|observer|hopper|dropper|dispenser|lever|tripwire_hook|target|daylight_detector|note_block|rail|powered_rail|detector_rail|activator_rail|chest|barrel|crafting_table|furnace|blast_furnace|smoker|composter|ladder|scaffolding|tnt|item_frame|glow_item_frame|flower_pot)$/,
  /^(wheat|wheat_seeds|carrot|potato|baked_potato|beetroot|beetroot_seeds|bread|apple|golden_apple|melon_slice|melon|pumpkin|carved_pumpkin|sugar_cane|sugar|bamboo|kelp|dried_kelp|cocoa_beans|nether_wart|sweet_berries|glow_berries|cactus|egg|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_cod|cooked_salmon|beef|porkchop|chicken|mutton|cod|salmon|rotten_flesh|spider_eye|glow_ink_sac|ink_sac)$/,
  /^(bone|bone_meal|feather|leather|string|flint|gunpowder|blaze_rod|blaze_powder|ender_pearl|slime_ball|honeycomb|arrow|stick|paper|book|glass_bottle|clay_ball|brick|nether_brick|phantom_membrane|magma_cream|ghast_tear|rabbit_hide|rabbit_foot|turtle_scute|armadillo_scute|nautilus_shell|heart_of_the_sea)$/,
  /^(poppy|dandelion|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|pink_petals|wildflowers|lily_pad|vine|glow_lichen|moss_carpet|azalea|flowering_azalea|fern|large_fern|short_grass|tall_grass|dead_bush|sea_pickle|seagrass|.*_coral|.*_coral_block|.*_coral_fan)$/,
  /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_/
]

function defaultItems (registry, need) {
  const all = Object.values(registry.itemsByName)
    .filter(i => (i.stackSize || 64) === 64)
    .map(i => i.name)
    .filter(n => !UNOBTAINABLE.test(n) && !NOT_WORTH_A_SLOT.test(n))
    .sort()
  const out = []
  const seen = new Set()
  for (const re of CATEGORIES) {
    for (const name of all) {
      if (seen.has(name) || !re.test(name)) continue
      seen.add(name); out.push(name)
      if (out.length >= need) return out
    }
  }
  // Top up with whatever is left rather than leaving slots unfilled - an
  // unfilled slot is not neutral, it swallows things.
  for (const name of all) {
    if (seen.has(name)) continue
    seen.add(name); out.push(name)
    if (out.length >= need) break
  }
  return out
}

// The list a sorter is actually charged with. Precedence: --items <file>, then
// the committed schematics/sorter-items.txt (edit that to change what goes
// where - the order is the order the item stream meets the filters), then the
// generated default. Unobtainable items are dropped from every source.
const DEFAULT_LIST = path.join(__dirname, '..', 'schematics', 'sorter-items.txt')

// A filter hopper is a hopper with a comparator reading it.
function isFilterAt (cmp, x, y, z) {
  return [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    .some(([dx, dy, dz]) => cmp.has(`${x + dx},${y + dy},${z + dz}`))
}

const STEP = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], down: [0, -1, 0] }
const CONTAINER = /^(chest|trapped_chest|barrel|hopper|dropper|dispenser|furnace|blast_furnace|smoker|crafter)$/
const facing = n => (/facing=([a-z]+)/.exec(n || '') || [])[1]

// Filter hoppers IN THE ORDER THE ITEM STREAM MEETS THEM.
//
// Sorting them by coordinate looks tidy and is wrong. In this design the item
// line is a chain of hoppers and each sorting cell hangs *below* one of them,
// pulling from it - so a filter's position in the stream is its position along
// the chain, which has nothing to do with its x/z. Order them by coordinate and
// an item's filter can sit on a branch the stream reaches late or never, which
// is exactly what made oak logs vanish into overflow on the first attempt.
//
// So: find the one hopper nothing feeds, walk the chain from it, and record
// each filter as the line passes over it.
function findFilters (blocks) {
  const at = new Map()
  for (const b of blocks) at.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name)
  const base = (x, y, z) => { const n = at.get(`${x},${y},${z}`); return n ? baseName(n) : 'air' }
  const cmp = new Set()
  for (const b of blocks) if (baseName(b.name) === 'comparator') cmp.add(`${b.pos.x},${b.pos.y},${b.pos.z}`)

  const hoppers = blocks.filter(b => baseName(b.name) === 'hopper')
  const key = p => `${p.x},${p.y},${p.z}`

  // "Hopper with a comparator beside it" is not enough. The overflow chain at
  // the end of the y67 bank runs past comparators too, and loading those 20
  // with 41 stained glass each just posted 820 blocks of glass into overflow.
  // What makes a sorter cell is the LOCK: a hopper directly under the filter
  // that the blueprint holds shut (enabled=false), so the charge cannot fall
  // through until the comparator releases it. Require that.
  const isRealFilter = (x, y, z) => {
    if (!isFilterAt(cmp, x, y, z)) return false
    const under = at.get(`${x},${y - 1},${z}`) || ''
    return /^hopper\[/.test(under) && /enabled=false/.test(under)
  }

  // A hopper is fed if something pushes into it, or a container sits on it.
  const fed = new Set()
  for (const b of hoppers) {
    const d = STEP[facing(b.name)]
    if (d) fed.add(key({ x: b.pos.x + d[0], y: b.pos.y + d[1], z: b.pos.z + d[2] }))
  }
  for (const b of hoppers) {
    if (CONTAINER.test(base(b.pos.x, b.pos.y + 1, b.pos.z))) fed.add(key(b.pos))
  }
  const heads = hoppers.filter(b => !fed.has(key(b.pos)))

  const order = []
  const seenFilter = new Set()
  const visited = new Set()
  for (const head of heads) {
    let p = { x: head.pos.x, y: head.pos.y, z: head.pos.z }
    for (let i = 0; i < 20000; i++) {
      const k = key(p)
      if (visited.has(k)) break
      visited.add(k)
      const name = at.get(k)
      if (!name || baseName(name) !== 'hopper') break
      // A filter hanging under this link of the chain.
      const below = { x: p.x, y: p.y - 1, z: p.z }
      if (base(below.x, below.y, below.z) === 'hopper' &&
          isRealFilter(below.x, below.y, below.z) && !seenFilter.has(key(below))) {
        seenFilter.add(key(below)); order.push(below)
      }
      if (isRealFilter(p.x, p.y, p.z) && !seenFilter.has(k)) { seenFilter.add(k); order.push({ ...p }) }
      const d = STEP[facing(name)]
      if (!d) break
      p = { x: p.x + d[0], y: p.y + d[1], z: p.z + d[2] }
    }
  }

  // Anything the walk never reached still needs loading - an unloaded filter is
  // not inert, it swallows whatever passes it - so append the stragglers.
  const missed = hoppers
    .filter(b => isRealFilter(b.pos.x, b.pos.y, b.pos.z) && !seenFilter.has(key(b.pos)))
    .map(b => ({ x: b.pos.x, y: b.pos.y, z: b.pos.z }))
    .sort((a, b) => (b.y - a.y) || (a.z - b.z) || (a.x - b.x))

  order.reachable = order.length
  order.push(...missed)
  return order
}


function itemsFor (need, listFile) {
  const registry = require('minecraft-data')(DATA_VERSION)
  const file = listFile || (fs.existsSync(DEFAULT_LIST) ? DEFAULT_LIST : null)
  const items = file
    ? fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : defaultItems(registry, need)
  return items.map(n => (n.startsWith('minecraft:') ? n : 'minecraft:' + n))
    .filter(n => registry.itemsByName[n.replace('minecraft:', '')])
    .filter(n => !UNOBTAINABLE.test(n.replace('minecraft:', '')))
    .slice(0, need)
}

module.exports = { findFilters, itemsFor, defaultItems, UNOBTAINABLE, NOT_WORTH_A_SLOT }
