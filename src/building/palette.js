'use strict'

const { baseName, hasState, withState } = require('./blockspec')

// ---------------------------------------------------------------------------
// Palettes.
//
// A plan names slots - "wall", "trim", "roof" - and the palette decides what
// block each one is. That does two things: the model stops picking twenty
// individual block ids and getting a couple of them wrong, and a whole build
// can be restyled by swapping one word.
//
// Weathering is the other half. A wall of one block id reads as a test fixture,
// so a fraction of wall cells are swapped for a rougher variant, weighted
// toward the bottom of the wall where damp and damage actually accumulate.
//
// THE SWAP MUST BE DETERMINISTIC. Command mode skips cells that are already
// correct, which is what makes re-running a plan cheap - but only if the second
// render produces the same blocks as the first. A Math.random() swap would make
// every re-run rewrite most of the build, and would make a plan's output
// impossible to reason about. So the seed is a hash of the plan itself: same
// plan, same weathering, every time.
// ---------------------------------------------------------------------------

const NAMED = {
  medieval_stone: {
    wall: { base: 'stone_bricks', variants: ['cracked_stone_bricks', 'mossy_stone_bricks', 'cobblestone'], weathering: 0.12 },
    trim: 'polished_andesite',
    roof: 'deepslate_tiles',
    accent: 'cobblestone_wall',
    floor: 'polished_andesite',
    glass: 'glass_pane',
    base_rough: 'cobblestone',
    upper: 'stone_bricks'
  },
  nordic: {
    wall: { base: 'spruce_planks', variants: ['stripped_spruce_log', 'spruce_log'], weathering: 0.15 },
    trim: 'stripped_spruce_log',
    roof: 'dark_oak_stairs',
    accent: 'spruce_fence',
    floor: 'spruce_planks',
    glass: 'glass_pane',
    base_rough: 'cobblestone',
    upper: 'spruce_planks'
  },
  gothic: {
    wall: { base: 'deepslate_bricks', variants: ['cracked_deepslate_bricks', 'cobbled_deepslate', 'polished_deepslate'], weathering: 0.14 },
    trim: 'polished_deepslate',
    roof: 'deepslate_tiles',
    accent: 'deepslate_brick_wall',
    floor: 'polished_deepslate',
    glass: 'gray_stained_glass_pane',
    base_rough: 'cobbled_deepslate',
    upper: 'deepslate_bricks'
  },
  desert: {
    wall: { base: 'smooth_sandstone', variants: ['sandstone', 'cut_sandstone', 'chiseled_sandstone'], weathering: 0.16 },
    trim: 'cut_sandstone',
    roof: 'smooth_sandstone',
    accent: 'sandstone_wall',
    floor: 'cut_sandstone',
    glass: 'glass_pane',
    base_rough: 'sandstone',
    upper: 'smooth_sandstone'
  },
  japanese: {
    wall: { base: 'white_terracotta', variants: ['white_concrete', 'bone_block'], weathering: 0.06 },
    trim: 'dark_oak_planks',
    roof: 'dark_prismarine',
    accent: 'dark_oak_fence',
    floor: 'stripped_oak_log',
    glass: 'white_stained_glass_pane',
    base_rough: 'cobblestone',
    upper: 'white_terracotta'
  },
  dwarven: {
    wall: { base: 'polished_deepslate', variants: ['deepslate_tiles', 'deepslate_bricks', 'cobbled_deepslate'], weathering: 0.1 },
    trim: 'gold_block',
    roof: 'deepslate_tiles',
    accent: 'polished_deepslate_wall',
    floor: 'polished_blackstone',
    glass: 'glass_pane',
    base_rough: 'cobbled_deepslate',
    upper: 'polished_deepslate'
  },
  fantasy_glow: {
    wall: { base: 'prismarine_bricks', variants: ['prismarine', 'dark_prismarine'], weathering: 0.1 },
    trim: 'dark_prismarine',
    roof: 'prismarine_bricks',
    accent: 'sea_lantern',
    floor: 'dark_prismarine',
    glass: 'light_blue_stained_glass_pane',
    base_rough: 'prismarine',
    upper: 'prismarine_bricks'
  },
  brick_townhouse: {
    wall: { base: 'bricks', variants: ['mud_bricks', 'granite', 'polished_granite'], weathering: 0.1 },
    trim: 'polished_diorite',
    roof: 'dark_oak_stairs',
    accent: 'brick_wall',
    floor: 'oak_planks',
    glass: 'glass_pane',
    base_rough: 'cobblestone',
    upper: 'bricks'
  }
}

const SLOTS = ['wall', 'trim', 'roof', 'accent', 'floor', 'glass', 'base_rough', 'upper']

// FNV-1a over the plan's own text. Small, dependency-free, and stable across
// runs and machines - which is the whole requirement.
function hash (text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// A cheap positional PRNG: same coordinates and seed give the same value, with
// no state to thread through the renderer.
function noise (seed, x, y, z) {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d)
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0
  h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function resolveSlot (palette, name) {
  const entry = palette[name]
  if (!entry) return null
  return typeof entry === 'string' ? entry : entry.base
}

// Build a resolver from whatever the plan gave: a named palette, an inline one,
// or both (inline overrides the named base).
function build (spec, isKnownBlock) {
  const warnings = []
  let table = {}

  // hasOwnProperty, not truthiness: NAMED['constructor'] resolves through the
  // prototype chain, so a plan naming that palette got Object's constructor
  // spread into the table instead of the "unknown palette" warning.
  const namedPalette = n => (typeof n === 'string' && Object.prototype.hasOwnProperty.call(NAMED, n) ? NAMED[n] : null)

  if (typeof spec === 'string') {
    const base = namedPalette(spec)
    if (!base) warnings.push(`unknown palette "${spec}" - falling back to medieval_stone`)
    table = { ...(base || NAMED.medieval_stone) }
  } else if (spec && typeof spec === 'object') {
    const named = namedPalette(spec.name)
    table = { ...(named || NAMED.medieval_stone) }
    for (const slot of SLOTS) {
      if (spec[slot] !== undefined) table[slot] = spec[slot]
    }
  } else {
    return null
  }

  // Anything the server does not know falls back rather than failing a build.
  for (const slot of SLOTS) {
    const entry = table[slot]
    if (typeof entry === 'string') {
      if (!isKnownBlock(entry)) {
        warnings.push(`palette slot "${slot}" names "${entry}", which this server does not know - using ${NAMED.medieval_stone[slot]}`)
        table[slot] = typeof NAMED.medieval_stone[slot] === 'string' ? NAMED.medieval_stone[slot] : NAMED.medieval_stone[slot].base
      }
    } else if (entry && typeof entry === 'object') {
      const kept = (entry.variants || []).filter(v => isKnownBlock(v))
      if (!isKnownBlock(entry.base)) {
        warnings.push(`palette slot "${slot}" base "${entry.base}" is unknown - using stone_bricks`)
        entry.base = 'stone_bricks'
      }
      entry.variants = kept
    }
  }

  return { table, warnings }
}

// Is this material a slot name rather than a block id?
function isSlot (name) {
  return SLOTS.includes(name)
}

function resolve (palette, material) {
  if (!palette || typeof material !== 'string') return material
  if (!isSlot(material)) return material
  return resolveSlot(palette.table, material) || material
}

// The weathering pass: swap a fraction of wall cells for a rougher variant,
// weighted toward the bottom third of the build.
function weather (cells, palette, seed) {
  if (!palette) return 0
  const wall = palette.table.wall
  if (!wall || typeof wall === 'string' || !wall.variants || !wall.variants.length) return 0

  const rate = Number.isFinite(wall.weathering) ? Math.max(0, Math.min(0.5, wall.weathering)) : 0.12
  if (rate === 0) return 0

  let minY = Infinity
  let maxY = -Infinity
  for (const cell of cells.values()) {
    if (baseName(cell.name) !== wall.base) continue
    if (cell.pos.y < minY) minY = cell.pos.y
    if (cell.pos.y > maxY) maxY = cell.pos.y
  }
  if (!Number.isFinite(minY)) return 0
  const span = Math.max(1, maxY - minY)

  let swapped = 0
  for (const cell of cells.values()) {
    if (baseName(cell.name) !== wall.base || hasState(cell.name)) continue
    // Three times the rate at the very bottom, tapering to the plain rate up top.
    const fromBottom = 1 - (cell.pos.y - minY) / span
    const chance = rate * (1 + 2 * fromBottom * fromBottom)
    const roll = noise(seed, cell.pos.x, cell.pos.y, cell.pos.z)
    if (roll >= chance) continue
    const pick = wall.variants[Math.floor(noise(seed ^ 0x5bf03635, cell.pos.x, cell.pos.y, cell.pos.z) * wall.variants.length) % wall.variants.length]
    cell.name = pick
    swapped++
  }
  return swapped
}

module.exports = { build, resolve, weather, isSlot, hash, noise, NAMED, SLOTS }
