'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Shared between load-sorter.js and label-sorter.js so a slot's filter item and
// its label can never disagree: both walk the hopper chain in the same order
// and index the same item list.

const fs = require('fs')
const { baseName } = require('../src/building/blockspec')

const CATEGORIES = [
  /_ingot$|^(coal|diamond|emerald|quartz|nether_star|raw_iron|raw_gold|raw_copper|copper_ingot|netherite_scrap)$/,
  /_ore$|^(ancient_debris|raw_iron_block|raw_gold_block|raw_copper_block)$/,
  /_block$/,
  /^(cobblestone|stone|granite|diorite|andesite|deepslate|cobbled_deepslate|tuff|calcite|basalt|blackstone|netherrack|end_stone|obsidian|smooth_stone|sandstone|red_sandstone)$/,
  /_planks$/, /_log$|_wood$|^stripped_/, /_leaves$/, /_sapling$/,
  /^(dirt|coarse_dirt|podzol|mud|clay|gravel|sand|red_sand|soul_sand|soul_soil|grass_block|moss_block|mycelium)$/,
  /_wool$/, /_terracotta$/, /_concrete$/, /_concrete_powder$/, /_glass$/,
  /_stairs$/, /_slab$/, /_fence$/, /_wall$/, /_door$/, /_trapdoor$/,
  /^(redstone|repeater|comparator|piston|sticky_piston|observer|hopper|dropper|dispenser|lever|tripwire_hook|target|daylight_detector|note_block|rail|powered_rail|detector_rail|activator_rail)$/,
  /^(wheat|carrot|potato|beetroot|bread|apple|melon_slice|sugar_cane|sugar|bamboo|kelp|cocoa_beans|nether_wart|bone_meal|bone|feather|leather|string|flint|gunpowder|blaze_rod|ender_pearl|slime_ball|honeycomb)$/,
  /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_/
]

function defaultItems (registry, need) {
  const all = Object.values(registry.itemsByName)
    .filter(i => (i.stackSize || 64) === 64)
    .map(i => i.name)
  const out = []
  const seen = new Set()
  for (const re of CATEGORIES) {
    for (const name of all.sort()) {
      if (seen.has(name) || !re.test(name)) continue
      seen.add(name); out.push(name)
      if (out.length >= need) return out
    }
  }
  // Top up with whatever is left rather than leaving slots unfilled - an
  // unfilled slot is not neutral, it swallows things.
  for (const name of all.sort()) {
    if (seen.has(name)) continue
    seen.add(name); out.push(name)
    if (out.length >= need) break
  }
  return out
}

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
  let items = listFile
    ? fs.readFileSync(listFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : defaultItems(registry, need)
  return items.map(n => (n.startsWith('minecraft:') ? n : 'minecraft:' + n))
    .filter(n => registry.itemsByName[n.replace('minecraft:', '')])
}

module.exports = { findFilters, itemsFor, defaultItems }
