'use strict'

const fs = require('fs')
const path = require('path')
const png = require('./png')
const { baseName } = require('../building/blockspec')

// ---------------------------------------------------------------------------
// Views of a build, from the cell map alone - no server round trip, so a plan
// can be looked at before a single block is placed.
//
// Two kinds. Text plans and elevations, which are cheap and diffable and go in
// the archive next to the plan that produced them. And an isometric PNG, which
// is what a critic can actually judge: "the towers are the same height" and
// "that wall is blank" are visual facts, and no amount of block counting
// surfaces them.
// ---------------------------------------------------------------------------

// Rough block colours. Anything unlisted falls back by keyword, then to grey -
// the render is for judging massing and silhouette, not for matching textures.
const COLOURS = {
  air: null,
  stone: [125, 125, 125],
  stone_bricks: [122, 122, 122],
  cracked_stone_bricks: [118, 116, 112],
  mossy_stone_bricks: [110, 121, 105],
  cobblestone: [127, 127, 127],
  mossy_cobblestone: [110, 124, 104],
  polished_andesite: [132, 134, 132],
  andesite: [136, 136, 136],
  deepslate_bricks: [72, 72, 76],
  cracked_deepslate_bricks: [68, 68, 71],
  deepslate_tiles: [54, 54, 57],
  cobbled_deepslate: [77, 77, 82],
  polished_deepslate: [72, 72, 75],
  bricks: [150, 97, 83],
  sandstone: [216, 203, 155],
  smooth_sandstone: [219, 207, 163],
  cut_sandstone: [217, 204, 157],
  chiseled_sandstone: [214, 201, 152],
  oak_planks: [162, 130, 78],
  spruce_planks: [114, 84, 48],
  dark_oak_planks: [66, 43, 20],
  oak_log: [109, 85, 50],
  stripped_oak_log: [177, 144, 86],
  stripped_spruce_log: [149, 118, 76],
  stripped_dark_oak_log: [96, 74, 44],
  white_terracotta: [209, 178, 161],
  white_concrete: [207, 213, 214],
  calcite: [223, 224, 220],
  glass: [175, 213, 219],
  glass_pane: [175, 213, 219],
  iron_bars: [130, 132, 135],
  water: [63, 118, 228],
  lava: [207, 92, 20],
  magma_block: [142, 63, 31],
  prismarine_bricks: [99, 171, 158],
  dark_prismarine: [51, 91, 75],
  sea_lantern: [172, 199, 190],
  glowstone: [171, 131, 84],
  lantern: [222, 165, 82],
  torch: [225, 190, 96],
  wall_torch: [225, 190, 96],
  vine: [79, 110, 43],
  oak_leaves: [72, 116, 41],
  dirt: [134, 96, 67],
  grass_block: [106, 138, 62],
  bedrock: [85, 85, 85],
  gravel: [131, 127, 126],
  blue_terracotta: [74, 59, 91],
  gold_block: [246, 208, 61],
  polished_blackstone: [53, 48, 56],
  red_wall_banner: [176, 46, 38],
  light_blue_wall_banner: [58, 175, 217]
}

const KEYWORDS = [
  [/deepslate/, [70, 70, 74]],
  [/sandstone/, [216, 203, 155]],
  [/prismarine/, [86, 154, 143]],
  [/dark_oak/, [66, 43, 20]],
  [/spruce/, [114, 84, 48]],
  [/oak/, [162, 130, 78]],
  [/brick/, [150, 97, 83]],
  [/stone|andesite|diorite|granite/, [125, 125, 125]],
  [/glass|pane/, [175, 213, 219]],
  [/wool|terracotta|concrete/, [190, 180, 175]],
  [/leaves|vine|moss/, [79, 110, 43]],
  [/lantern|torch|glow|light/, [222, 165, 82]]
]

function colourOf (name) {
  const b = baseName(name)
  if (b === 'air') return null
  if (COLOURS[b] !== undefined) return COLOURS[b]
  for (const [re, c] of KEYWORDS) if (re.test(b)) return c
  return [140, 140, 140]
}

function bounds (blocks) {
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const b of blocks) {
    if (baseName(b.name) === 'air') continue
    lo.x = Math.min(lo.x, b.pos.x); hi.x = Math.max(hi.x, b.pos.x)
    lo.y = Math.min(lo.y, b.pos.y); hi.y = Math.max(hi.y, b.pos.y)
    lo.z = Math.min(lo.z, b.pos.z); hi.z = Math.max(hi.z, b.pos.z)
  }
  return { lo, hi }
}

// --- text views ------------------------------------------------------------
// One character per column, so a plan reads as a floor plan and an elevation
// reads as a silhouette. Solid, glass, opening and stair are distinguished
// because those are the things worth spotting: a blank wall, a missing door.
function glyph (name) {
  const b = baseName(name)
  if (b === 'air') return '.'
  if (/_pane$|^glass|iron_bars/.test(b)) return 'o'
  if (/_stairs$/.test(b)) return '/'
  if (/_slab$/.test(b)) return '-'
  if (/_wall$|fence/.test(b)) return 'i'
  if (/torch|lantern|glow|sea_lantern/.test(b)) return '*'
  if (/vine|leaves/.test(b)) return ','
  if (/door/.test(b)) return 'D'
  return '#'
}

function textViews (blocks, opts = {}) {
  const { lo, hi } = bounds(blocks)
  if (!Number.isFinite(lo.x)) return 'empty build\n'

  const solid = new Map()
  for (const b of blocks) {
    if (baseName(b.name) === 'air') continue
    solid.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name)
  }
  const at = (x, y, z) => solid.get(`${x},${y},${z}`)

  const out = []
  const w = hi.x - lo.x + 1
  const d = hi.z - lo.z + 1
  const h = hi.y - lo.y + 1
  out.push(`build is ${w} x ${d} on the ground and ${h} tall, origin (${lo.x}, ${lo.y}, ${lo.z})`)

  // Plan at the height a person walks through, so doorways show.
  const planY = lo.y + (opts.planHeight !== undefined ? opts.planHeight : 2)
  out.push('', `PLAN at y=${planY} (# solid, . open, o glazed, D door)`)
  for (let z = lo.z; z <= hi.z; z++) {
    let row = ''
    for (let x = lo.x; x <= hi.x; x++) {
      const n = at(x, planY, z)
      row += n ? glyph(n) : '.'
    }
    out.push('  ' + row)
  }

  // Four elevations: the nearest solid seen from each side.
  for (const [label, iterate] of [
    ['NORTH (looking south)', (x, y) => { for (let z = lo.z; z <= hi.z; z++) { const n = at(x, y, z); if (n) return n } return null }],
    ['SOUTH (looking north)', (x, y) => { for (let z = hi.z; z >= lo.z; z--) { const n = at(x, y, z); if (n) return n } return null }],
    ['WEST (looking east)', (z, y) => { for (let x = lo.x; x <= hi.x; x++) { const n = at(x, y, z); if (n) return n } return null }],
    ['EAST (looking west)', (z, y) => { for (let x = hi.x; x >= lo.x; x--) { const n = at(x, y, z); if (n) return n } return null }]
  ]) {
    const across = label.startsWith('NORTH') || label.startsWith('SOUTH')
      ? { from: lo.x, to: hi.x }
      : { from: lo.z, to: hi.z }
    out.push('', `${label} elevation`)
    for (let y = hi.y; y >= lo.y; y--) {
      let row = ''
      for (let a = across.from; a <= across.to; a++) {
        const n = iterate(a, y)
        row += n ? glyph(n) : '.'
      }
      out.push('  ' + row)
    }
  }

  return out.join('\n') + '\n'
}

// --- isometric render ------------------------------------------------------
// Painter's algorithm over a standard 2:1 isometric projection. Each block is a
// cube drawn as three faces at different brightness, which is what gives the
// image any read of depth at all.
function isometric (blocks, opts = {}) {
  const tile = Math.max(2, Math.min(12, opts.tile || 6))
  const { lo, hi } = bounds(blocks)
  if (!Number.isFinite(lo.x)) return null

  const solid = blocks.filter(b => baseName(b.name) !== 'air')
  const spanX = hi.x - lo.x + 1
  const spanY = hi.y - lo.y + 1
  const spanZ = hi.z - lo.z + 1

  const halfW = tile
  const quarterH = Math.max(1, Math.round(tile / 2))
  const width = (spanX + spanZ) * halfW + tile * 2
  const height = (spanX + spanZ) * quarterH + spanY * tile + tile * 4

  const CAP = 4_000_000
  if (width * height > CAP) return { tooBig: true, width, height }

  const px = Buffer.alloc(width * height * 3)
  const sky = [24, 26, 32]
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = sky[0]; px[i * 3 + 1] = sky[1]; px[i * 3 + 2] = sky[2]
  }

  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 3
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]
  }
  const shade = (c, f) => [
    Math.max(0, Math.min(255, Math.round(c[0] * f))),
    Math.max(0, Math.min(255, Math.round(c[1] * f))),
    Math.max(0, Math.min(255, Math.round(c[2] * f)))
  ]

  // Far blocks first, so near ones paint over them.
  const ordered = solid.slice().sort((a, b) =>
    (a.pos.x + a.pos.z + a.pos.y) - (b.pos.x + b.pos.z + b.pos.y))

  for (const block of ordered) {
    const colour = colourOf(block.name)
    if (!colour) continue
    const bx = block.pos.x - lo.x
    const by = block.pos.y - lo.y
    const bz = block.pos.z - lo.z

    // The vertical offset has to clear the whole build, not a fixed margin: a
    // tall block projects UPWARD by by*tile, so anchoring at a constant put the
    // top of a 22-block tower above the canvas and cropped its roof off.
    const sx = Math.round((bx - bz) * halfW + (spanZ * halfW) + tile)
    const sy = Math.round((bx + bz) * quarterH - by * tile + spanY * tile + tile)

    // Top face: a 2:1 diamond.
    const top = shade(colour, 1.15)
    for (let dy = 0; dy < quarterH * 2; dy++) {
      const spread = dy < quarterH ? dy : (quarterH * 2 - 1 - dy)
      const run = Math.max(1, Math.round((spread + 1) * (halfW / quarterH)))
      for (let dx = -run; dx < run; dx++) put(sx + dx, sy + dy - quarterH, top)
    }
    // Left and right faces.
    const left = shade(colour, 0.78)
    const right = shade(colour, 0.55)
    for (let dy = 0; dy < tile; dy++) {
      for (let dx = 0; dx < halfW; dx++) {
        put(sx - halfW + dx, sy + quarterH + dy - Math.round(dx / 2), left)
        put(sx + dx, sy + quarterH + dy - Math.round((halfW - dx) / 2), right)
      }
    }
  }

  return { buffer: png.encode(width, height, px), width, height }
}

function writeViews (dir, blocks, opts = {}) {
  const written = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    const text = textViews(blocks, opts)
    fs.writeFileSync(path.join(dir, 'views.txt'), text)
    written.push('views.txt')

    const iso = isometric(blocks, opts)
    if (iso && iso.buffer) {
      fs.writeFileSync(path.join(dir, 'isometric.png'), iso.buffer)
      written.push(`isometric.png (${iso.width}x${iso.height})`)
    } else if (iso && iso.tooBig) {
      written.push(`isometric skipped - ${iso.width}x${iso.height} is too large to render`)
    }
  } catch (err) {
    console.error('[views] could not write:', err.message)
  }
  return written
}

module.exports = { textViews, isometric, writeViews, colourOf, glyph, bounds }
