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

const STYLES = {
  medieval_stone: { trim: 'polished_andesite' },
  timber_castle: { trim: 'dark_oak_planks' },
  fantasy_spire: { trim: 'prismarine_bricks' },
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
    slab: familyVariant(trim, 'slab', isKnownBlock)
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

  const emit = (pos, name) => out.push({ pos, name })
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

module.exports = { decorate, paletteFor, STYLES }
