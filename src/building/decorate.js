'use strict'

const { Vec3 } = require('vec3')
const { baseName, familyVariant } = require('./blockspec')
const surfaces = require('./surfaces')

// ---------------------------------------------------------------------------
// The decorator: builder habits applied to a finished shell.
//
// Runs after shell and carves and before the model's own details, reads the
// cell map, and puts in the things a human builder does without thinking -
// a cornice under every wall top, a course of contrasting stone at each floor
// line, a frame and a sill around every window.
//
// The model does not ask for any of it. It picks a style; the habits find their
// own surfaces. That is the point: hand-placed ornament is where the model
// spends most of its actions and makes most of its mistakes, and none of these
// three habits can be got wrong by a plan that got its massing right.
//
// Habits never fill a carved opening: the decorator writes through the same
// protection the renderer applies to everything else, so a frame that tried to
// close its own window would be dropped and reported rather than shipped.
// ---------------------------------------------------------------------------

// Each style is a trim block plus the habits that belong to it. The universal
// habits run for every style; these are what make one look different from
// another rather than just differently coloured.
const STYLES = {
  medieval_stone: {
    trim: 'polished_andesite',
    habits: ['crown', 'wall_walk', 'vines', 'banners'],
    vine: 'vine',
    banner: 'red_wall_banner'
  },
  timber_castle: {
    trim: 'dark_oak_planks',
    habits: ['crown', 'wall_walk', 'timber_upper', 'flower_boxes', 'chimney', 'vines'],
    post: 'stripped_dark_oak_log',
    infill: 'white_terracotta',
    vine: 'vine'
  },
  fantasy_spire: {
    trim: 'prismarine_bricks',
    habits: ['crown', 'glow', 'banners'],
    glowBlock: 'sea_lantern',
    banner: 'light_blue_wall_banner'
  },
  plain: null
}

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' }

function paletteFor (decor, isKnownBlock) {
  const style = STYLES[decor.style] || STYLES.medieval_stone
  if (!style) return null
  const trim = decor.trim || style.trim
  if (!isKnownBlock(trim)) return null
  return {
    trim,
    stairs: familyVariant(trim, 'stairs', isKnownBlock),
    slab: familyVariant(trim, 'slab', isKnownBlock),
    // Filled in from the plan's palette when there is one, so the gradient
    // habit uses the same blocks the build is already made of.
    wallBase: decor.wallBase || null,
    baseRough: decor.baseRough || null,
    upper: decor.upper || null
  }
}

function decorate (cells, carved, decor, isKnownBlock) {
  if (!decor || decor.style === 'plain') return { blocks: [], applied: {} }

  const palette = paletteFor(decor, isKnownBlock)
  if (!palette) return { blocks: [], applied: {}, note: 'no usable trim material for that style' }

  const view = surfaces.analyse(cells, carved)
  const skip = new Set(decor.skip || [])
  const out = []
  const applied = {}

  // Blocks that fall off if nothing holds them. The renderer's protection stops
  // a habit filling a carved opening; this stops one placing a torch in mid-air,
  // which the server deletes the instant it lands - leaving a build that is
  // subtly less lit than the log claims.
  const NEEDS_SUPPORT = /torch$|^lantern|_lantern$|^vine$|_banner$|_pane$|^iron_bars$|_wall$|_trapdoor$|^chain$/

  let unsupported = 0
  const emit = (pos, name) => {
    if (NEEDS_SUPPORT.test(baseName(name))) {
      const base = baseName(name)
      const anchored = base === 'vine' || /_banner$/.test(base) || /torch$/.test(base)
        // Side-attached: needs a solid beside it.
        ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => view.isSolid(pos.offset(dx, dy, dz)))
        // Everything else needs something above or below.
        : view.isSolid(pos.offset(0, 1, 0)) || view.isSolid(pos.offset(0, -1, 0))
      if (!anchored) { unsupported++; return }
    }
    out.push({ pos, name })
  }
  const occupied = p => cells.has(`${p.x},${p.y},${p.z}`)

  if (!skip.has('corbel_edges') && palette.stairs) {
    applied.corbel_edges = corbelEdges(view, palette, emit, occupied)
  }
  if (!skip.has('string_courses')) {
    applied.string_courses = stringCourses(view, palette, emit)
  }
  if (!skip.has('window_frames')) {
    applied.window_frames = windowFrames(view, palette, emit, occupied)
  }
  if (!skip.has('quoins')) {
    applied.quoins = quoins(view, palette, emit, occupied)
  }
  if (!skip.has('arrow_slits')) {
    applied.arrow_slits = arrowSlits(view, palette, emit, occupied, decor)
  }
  if (!skip.has('lights')) {
    applied.lights = lightsUnderOverhangs(view, palette, emit, occupied, decor)
  }
  if (!skip.has('material_gradient') && decor.gradient !== false) {
    applied.material_gradient = materialGradient(view, palette, emit, occupied, decor)
  }

  // Style habits, on top of the universal ones.
  const style = STYLES[decor.style] || STYLES.medieval_stone
  for (const habit of style.habits || []) {
    if (skip.has(habit)) continue
    const fn = STYLE_HABITS[habit]
    if (!fn) continue
    const n = fn(view, palette, emit, occupied, decor, style)
    if (n) applied[habit] = n
  }

  if (unsupported) applied.__unsupported_skipped = unsupported

  return { blocks: out, applied, surfaces: view }
}

// A cornice: upside-down stairs one block proud of every wall top, facing out.
// The single biggest visual return of any habit here - it is the difference
// between a wall that stops and a building that is finished at the top.
function corbelEdges (view, palette, emit, occupied) {
  let n = 0
  for (const edge of view.topEdges) {
    // ...and it has to be the LOWEST course of whatever it belongs to. A slope
    // steps down by exactly one into the next column, so a cell with a
    // neighbouring column topping out one block below is mid-roof, not an eave.
    //
    // "Sits on something solid" was the first attempt at this and was wrong in
    // the case the habit exists for: an overhanging eaves course has open air
    // underneath by definition, so that test deleted every cornice worth having
    // and kept the cone rings anyway. A drop of one is a slope; a drop of five
    // is a lower wing, and a tower beside a low hall still wants its cornice.
    const stepsDown = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
      const top = view.columnTop.get(`${edge.pos.x + dx},${edge.pos.z + dz}`)
      return top !== undefined && top === edge.pos.y - 1
    })
    if (stepsDown) continue

    // And do not dress a cell that is itself unsupported: a cornice hung off a
    // floating roof cell turns one stray block into three.
    const anchored = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      .some(([dx, dy, dz]) => view.isSolid(edge.pos.offset(dx, dy, dz)))
    if (!anchored) continue

    for (const normal of edge.normals) {
      const at = edge.pos.plus(normal.v)
      if (occupied(at)) continue

      // A cornice only means anything where it projects over open air. Every
      // course of a sloped roof is a column top, so without this test a gable
      // gets a cornice on all eight of its steps and a cone gets one per ring -
      // measured at 524 corbels on a two-building plan, a fifth of the whole
      // structure. Requiring the cell below the corbel to be open leaves
      // exactly the wall tops and the lowest course of each slope, which is the
      // eaves line and the only place the habit was ever meant to run.
      if (view.isSolid(at.offset(0, -1, 0))) continue

      emit(at, `${palette.stairs}[half=top,facing=${normal.key}]`)
      n++
    }
    // Mitre: a corner leaves a diagonal gap between its two corbels.
    if (edge.normals.length >= 2) {
      const [a, b] = edge.normals
      const diag = edge.pos.plus(a.v).plus(b.v)
      if (!occupied(diag) && !view.isSolid(diag.offset(0, -1, 0))) {
        emit(diag, `${palette.stairs}[half=top,facing=${a.key}]`)
        n++
      }
    }
  }
  return n
}

// A band of contrasting stone where each floor meets the outside wall.
function stringCourses (view, palette, emit) {
  const lines = new Set(view.floorLines)
  if (!lines.size) return 0
  let n = 0
  const done = new Set()
  for (const face of view.exteriorFaces) {
    if (!lines.has(face.pos.y)) continue
    const k = `${face.pos.x},${face.pos.y},${face.pos.z}`
    if (done.has(k)) continue
    done.add(k)
    emit(face.pos, palette.trim)
    n++
  }
  return n
}

// A frame, a sill and a lintel around every opening in an outside wall. A slit
// one block wide gets the sill and lintel only - a frame around a slit reads as
// a mistake, not a window.
function windowFrames (view, palette, emit, occupied) {
  let n = 0
  for (const hole of view.openings) {
    if (hole.height < 2) continue

    const thin = hole.axis // the wall's normal axis
    const lo = thin === 'x' ? hole.min.x : hole.min.z
    const hi = thin === 'x' ? hole.max.x : hole.max.z

    // Which side of this wall is outdoors?
    const probe = v => new Vec3(
      thin === 'x' ? v : hole.min.x,
      hole.min.y,
      thin === 'x' ? hole.min.z : v)
    let outward = null
    if (view.isOutside(probe(hi + 1))) outward = { step: 1, at: hi }
    else if (view.isOutside(probe(lo - 1))) outward = { step: -1, at: lo }
    if (!outward) continue

    const face = outward.at + outward.step
    const across = thin === 'x' ? ['z', hole.min.z, hole.max.z] : ['x', hole.min.x, hole.max.x]
    const dirKey = thin === 'x' ? (outward.step > 0 ? 'east' : 'west') : (outward.step > 0 ? 'south' : 'north')

    const put = (a, y, plane, name) => {
      const pos = thin === 'x'
        ? new Vec3(plane, y, a)
        : new Vec3(a, y, plane)
      if (occupied(pos) && name !== palette.trim) return
      emit(pos, name)
      n++
    }

    // Frame: the ring of wall around the opening, in the wall's own plane.
    if (hole.width > 1) {
      for (let a = across[1] - 1; a <= across[2] + 1; a++) {
        for (let y = hole.min.y - 1; y <= hole.max.y + 1; y++) {
          const inside = a >= across[1] && a <= across[2] && y >= hole.min.y && y <= hole.max.y
          if (inside) continue
          for (let plane = lo; plane <= hi; plane++) {
            const pos = thin === 'x' ? new Vec3(plane, y, a) : new Vec3(a, y, plane)
            if (!view.isSolid(pos)) continue
            emit(pos, palette.trim)
            n++
          }
        }
      }
    }

    // Sill below, lintel above, both standing one block proud of the wall.
    for (let a = across[1]; a <= across[2]; a++) {
      put(a, hole.min.y - 1, face, `${palette.stairs}[half=bottom,facing=${OPPOSITE[dirKey]}]`)
      if (palette.slab) put(a, hole.max.y + 1, face, `${palette.slab}[type=bottom]`)
    }
  }
  return n
}


// Corner stones: alternating courses of trim picking out every corner. On a
// round tower there are no corners, so the same instinct becomes ribs - a
// vertical line of trim at the four cardinal points, which is what stops a
// cylinder reading as a pipe.
function quoins (view, palette, emit, occupied) {
  let n = 0
  const byColumn = new Map()
  for (const corner of view.corners) {
    const k = `${corner.pos.x},${corner.pos.z}`
    if (!byColumn.has(k)) byColumn.set(k, [])
    byColumn.get(k).push(corner)
  }

  for (const [, cells] of byColumn) {
    const ys = cells.map(c => c.pos.y).sort((a, b) => a - b)
    if (ys.length < 3) continue // not a corner of anything, just a stray cell
    for (const cell of cells) {
      // Alternate pairs of courses so the quoin reads as stonework, not stripes.
      if (Math.floor((cell.pos.y - ys[0]) / 2) % 2 !== 0) continue
      emit(cell.pos, palette.trim)
      n++
    }
  }
  return n
}

// A tall blank wall gets slits at a third and two thirds of its height. This is
// the habit that fixes the "undifferentiated masonry" look on curtain walls and
// tower shafts, where there is nothing else to break the surface up.
function arrowSlits (view, palette, emit, occupied, decor) {
  const intensity = Number.isFinite(decor.intensity) ? decor.intensity : 0.7
  let n = 0
  const done = new Set()

  // Spacing along the run, not one per column. Closer together as intensity
  // rises, but never so close that the wall becomes a colonnade.
  const spacing = Math.max(5, Math.round(11 - 5 * intensity))

  for (const run of view.verticalRuns) {
    if (run.height < 8 || run.length < 3) continue
    const fractions = run.height >= 14 ? [1 / 3, 2 / 3] : [0.5]

    for (let i = Math.floor(spacing / 2); i < run.length; i += spacing) {
      const col = run.columns[i]
      if (!col) continue
      for (const f of fractions) {
        const y = run.bottom + Math.floor(run.height * f)
        const id = `${run.normal.key}|${run.plane}|${col.across}|${y}`
        if (done.has(id)) continue
        done.add(id)

        for (let h = 0; h < 2; h++) {
          const face = col.faces.find(c => c.pos.y === y + h)
          if (!face) continue
          emit(face.pos, 'air')
          n++
        }
        const below = col.faces.find(c => c.pos.y === y - 1)
        const above = col.faces.find(c => c.pos.y === y + 2)
        if (below) { emit(below.pos, palette.trim); n++ }
        if (above) { emit(above.pos, palette.trim); n++ }
      }
    }
  }
  return n
}

// Lanterns on chains under anything that overhangs, and beside every doorway.
// Something has to glow from each face or the build disappears at night.
function lightsUnderOverhangs (view, palette, emit, occupied, decor) {
  const intensity = Number.isFinite(decor.intensity) ? decor.intensity : 0.7
  const spacing = Math.max(4, Math.round(7 - 3 * intensity))
  let n = 0

  for (const over of view.overhangs) {
    // Space them out along the run, and only where there is air to hang into.
    if ((over.pos.x + over.pos.z) % spacing !== 0) continue
    const under = over.pos.offset(0, -1, 0)
    if (occupied(under)) continue
    if (!view.isOutside(under)) continue
    emit(under, 'lantern[hanging=true]')
    n++
  }

  // A pair beside each doorway - the one light every building needs.
  for (const hole of view.openings) {
    if (hole.min.y > view.minY + 2) continue // doorways only, not windows
    const thin = hole.axis
    for (const side of [-1, 1]) {
      const pos = new Vec3(
        thin === 'x' ? hole.min.x : hole.min.x + (side < 0 ? -1 : hole.max.x - hole.min.x + 1),
        hole.min.y + 1,
        thin === 'x' ? hole.min.z + (side < 0 ? -1 : hole.max.z - hole.min.z + 1) : hole.min.z)
      if (occupied(pos)) continue
      if (!view.isOutside(pos)) continue
      // A torch needs a solid beside it; the orientation pass works out which.
      const supported = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dz]) => view.isSolid(pos.offset(dx, 0, dz)))
      if (!supported) continue
      emit(pos, 'wall_torch')
      n++
    }
  }
  return n
}

// Wall material changes with height: rough at the bottom where it meets the
// ground, the main block through the body, something lighter at the top.
function materialGradient (view, palette, emit, occupied, decor) {
  const rough = palette.baseRough
  const upper = palette.upper
  if (!rough && !upper) return 0

  const span = Math.max(1, view.maxY - view.minY)
  if (span < 8) return 0 // too short for a gradient to read as anything
  let n = 0

  for (const face of view.exteriorFaces) {
    const f = (face.pos.y - view.minY) / span
    const want = f < 0.2 ? rough : (f > 0.75 ? upper : null)
    if (!want) continue
    const cell = view.cells.get(`${face.pos.x},${face.pos.y},${face.pos.z}`)
    if (!cell || cell.name !== palette.wallBase) continue
    emit(face.pos, want)
    n++
  }
  return n
}



// ---------------------------------------------------------------------------
// Style habits. Each is (surfaces, palette, emit, occupied, decor, style) -> count.
// ---------------------------------------------------------------------------

// The crown of a wall: machicolations - a course of stairs hanging outward just
// under the parapet - then the merlons themselves. This is the detail that
// makes a castle top read as defensive rather than simply flat.
function crown (view, palette, emit, occupied, decor, style) {
  let n = 0
  const rings = new Map()
  for (const edge of view.topEdges) {
    if (edge.normals.length === 0) continue
    if (!rings.has(edge.pos.y)) rings.set(edge.pos.y, [])
    rings.get(edge.pos.y).push(edge)
  }

  // Only the highest few courses are a crown; everything lower is a wall top
  // the eaves habit has already dressed.
  const levels = [...rings.keys()].sort((a, b) => b - a).slice(0, 3)
  for (const y of levels) {
    const ring = rings.get(y)
    if (ring.length < 8) continue // too small to be a parapet
    for (const edge of ring) {
      // Merlon on alternating cells, so the gaps are crenels.
      if ((edge.pos.x + edge.pos.z) % 2 !== 0) continue
      const up = edge.pos.offset(0, 1, 0)
      if (occupied(up)) continue
      emit(up, palette.trim)
      n++
    }
  }
  return n
}

// A walkway behind the parapet, so a wall top is something you could stand on.
function wallWalk (view, palette, emit, occupied) {
  if (!palette.slab) return 0
  let n = 0
  for (const edge of view.topEdges) {
    // The cell one step INWARD from the parapet, at the same height.
    for (const normal of edge.normals) {
      const inward = edge.pos.plus(normal.v.scaled(-1))
      if (occupied(inward)) continue
      if (view.isSolid(inward.offset(0, -1, 0))) {
        emit(inward, `${palette.slab}[type=bottom]`)
        n++
      }
      break
    }
  }
  return n
}

// Vines down the shaded faces, weighted to the bottom. Age, cheaply.
function vines (view, palette, emit, occupied, decor, style) {
  if (decor.greenery === false) return 0
  const intensity = Number.isFinite(decor.intensity) ? decor.intensity : 0.7
  const seed = 0x7f4a7c15
  let n = 0

  for (const face of view.exteriorFaces) {
    // North faces are the shaded ones, and the bottom half is where damp sits.
    const shaded = face.normal.key === 'north' ? 2 : 1
    const low = face.height < (view.maxY - view.minY) / 2 ? 2 : 1
    const chance = 0.02 * intensity * shaded * low
    const at = face.pos.plus(face.normal.v)
    if (occupied(at)) continue
    if (!view.isOutside(at)) continue
    const roll = hashNoise(seed, at.x, at.y, at.z)
    if (roll >= chance) continue

    // A patch, not a single leaf.
    const drop = 2 + Math.floor(hashNoise(seed ^ 0x1234, at.x, at.y, at.z) * 4)
    for (let d = 0; d < drop; d++) {
      const pos = at.offset(0, -d, 0)
      if (occupied(pos) || !view.isOutside(pos)) break
      if (!view.isSolid(pos.plus(face.normal.v.scaled(-1)))) break
      emit(pos, `${style.vine || 'vine'}[${OPPOSITE_FACE[face.normal.key]}=true]`)
      n++
    }
  }
  return n
}

// Banners high on the principal faces.
function banners (view, palette, emit, occupied, decor, style) {
  const colour = typeof decor.banners === 'string' ? `${decor.banners}_wall_banner` : (style.banner || 'red_wall_banner')
  let n = 0
  const perFace = new Map()

  for (const face of view.exteriorFaces) {
    // High up, but below the parapet.
    const fromTop = view.maxY - face.pos.y
    if (fromTop < 3 || fromTop > 6) continue
    const k = `${face.normal.key}|${Math.floor(face.pos.x / 12)}|${Math.floor(face.pos.z / 12)}`
    if (perFace.has(k)) continue
    const at = face.pos.plus(face.normal.v)
    if (occupied(at) || !view.isOutside(at)) continue
    perFace.set(k, true)
    emit(at, `${colour}[facing=${face.normal.key}]`)
    n++
  }
  return n
}

// The upper storey becomes timber framing: posts, beams and pale infill.
function timberUpper (view, palette, emit, occupied, decor, style) {
  const span = view.maxY - view.minY
  if (span < 10) return 0
  const cut = view.minY + Math.floor(span * 0.65)
  let n = 0

  for (const face of view.exteriorFaces) {
    if (face.pos.y < cut) continue
    const cell = view.cells.get(`${face.pos.x},${face.pos.y},${face.pos.z}`)
    if (!cell) continue
    // Posts every third cell and at the top and bottom of the storey; infill
    // between them.
    const isPost = (face.pos.x + face.pos.z) % 3 === 0
    const isBeam = face.pos.y === cut || face.pos.y === view.maxY
    cell.name = isPost || isBeam ? (style.post || 'stripped_dark_oak_log') : (style.infill || 'white_terracotta')
    n++
  }
  return n
}

// A trapdoor box of leaves under a window: the cheapest thing that makes a
// facade look lived in.
function flowerBoxes (view, palette, emit, occupied, decor) {
  if (decor.greenery === false) return 0
  let n = 0
  for (const hole of view.openings) {
    if (hole.height < 2) continue
    const thin = hole.axis
    const below = { x: hole.min.x, y: hole.min.y - 1, z: hole.min.z }
    const outward = thin === 'x'
      ? (view.isOutside(new Vec3(hole.max.x + 1, hole.min.y, hole.min.z)) ? 1 : -1)
      : (view.isOutside(new Vec3(hole.min.x, hole.min.y, hole.max.z + 1)) ? 1 : -1)

    for (let a = 0; a <= (thin === 'x' ? hole.max.z - hole.min.z : hole.max.x - hole.min.x); a++) {
      const pos = thin === 'x'
        ? new Vec3(hole.min.x + (outward > 0 ? 1 : -1), below.y, hole.min.z + a)
        : new Vec3(hole.min.x + a, below.y, hole.min.z + (outward > 0 ? 1 : -1))
      if (occupied(pos) || !view.isOutside(pos)) continue
      if (!view.isSolid(pos.offset(0, 1, 0)) && !view.isSolid(pos.offset(0, -1, 0))) continue
      emit(pos, 'oak_leaves[persistent=true]')
      n++
    }
  }
  return n
}

// One chimney per building, rising past the ridge, with a fire in it.
function chimney (view, palette, emit, occupied) {
  // The tallest solid column that is not already a tower top.
  let best = null
  for (const edge of view.topEdges) {
    if (!best || edge.pos.y > best.pos.y) best = edge
  }
  if (!best) return 0
  const base = best.pos.offset(2, 0, 2)
  let n = 0
  for (let h = 1; h <= 3; h++) {
    const pos = base.offset(0, h, 0)
    if (occupied(pos)) return n
    emit(pos, 'bricks')
    n++
  }
  return n
}

// Recessed light in the upper storey, so the build glows at night.
function glow (view, palette, emit, occupied, decor, style) {
  const block = style.glowBlock || 'sea_lantern'
  const span = view.maxY - view.minY
  if (span < 6) return 0
  let n = 0
  const done = new Set()

  for (const face of view.exteriorFaces) {
    if (view.maxY - face.pos.y > 4) continue
    const k = `${Math.floor(face.pos.x / 5)}|${Math.floor(face.pos.z / 5)}|${face.pos.y}`
    if (done.has(k)) continue
    const cell = view.cells.get(`${face.pos.x},${face.pos.y},${face.pos.z}`)
    if (!cell) continue
    done.add(k)
    cell.name = block
    n++
  }
  return n
}

const OPPOSITE_FACE = { north: 'south', south: 'north', east: 'west', west: 'east' }

// Small deterministic noise, same shape as the palette's.
function hashNoise (seed, x, y, z) {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d)
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0
  h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const STYLE_HABITS = {
  crown,
  wall_walk: wallWalk,
  vines,
  banners,
  timber_upper: timberUpper,
  flower_boxes: flowerBoxes,
  chimney,
  glow
}


module.exports = { decorate, paletteFor, STYLES, STYLE_HABITS }
