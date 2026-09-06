'use strict'

const { Vec3 } = require('vec3')
const { baseName } = require('./blockspec')

// ---------------------------------------------------------------------------
// Surface detection over a finished cell map.
//
// Every decorator habit needs the same handful of questions answered - which
// faces are outside, where the wall tops are, where the openings are - and all
// of them are pure geometry. Computing them once here keeps the habits short
// and keeps them agreeing with each other about what "outside" means.
//
// The load-bearing definition is EXTERIOR. A face is outside if the cell beside
// it is open AND nothing in the build stands above that cell: a courtyard wall
// is outside, a room wall under a roof is not. That is decided against a
// per-column high-water mark rather than by scanning upward for every face,
// which turns the test into a map lookup.
// ---------------------------------------------------------------------------

const NON_SOLID = new Set([
  'air', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch',
  'lantern', 'soul_lantern', 'chain', 'ladder', 'vine', 'water', 'lava',
  'glass_pane', 'iron_bars', 'flower_pot', 'rail'
])

const DIRS = [
  { key: 'north', v: new Vec3(0, 0, -1) },
  { key: 'south', v: new Vec3(0, 0, 1) },
  { key: 'east', v: new Vec3(1, 0, 0) },
  { key: 'west', v: new Vec3(-1, 0, 0) }
]

const key = (x, y, z) => `${x},${y},${z}`
const col = (x, z) => `${x},${z}`

function analyse (cells, carved) {
  const solid = new Map() // key -> cell, solid only
  const columnTop = new Map()
  let minY = Infinity
  let maxY = -Infinity

  for (const cell of cells.values()) {
    const name = baseName(cell.name)
    if (name === 'air' || NON_SOLID.has(name)) continue
    solid.set(key(cell.pos.x, cell.pos.y, cell.pos.z), cell)
    const c = col(cell.pos.x, cell.pos.z)
    if (!columnTop.has(c) || columnTop.get(c) < cell.pos.y) columnTop.set(c, cell.pos.y)
    if (cell.pos.y < minY) minY = cell.pos.y
    if (cell.pos.y > maxY) maxY = cell.pos.y
  }

  const isSolid = p => solid.has(key(p.x, p.y, p.z))

  // OUTSIDE IS A CONNECTED REGION, NOT A SIGHTLINE TO THE SKY.
  //
  // The first version asked "is anything of ours above this cell" - cheap, and
  // wrong the moment a roof overhangs its wall by a block, which is a thing the
  // decorator itself asks for. The overhang put roof above every column just
  // outside the facade, so the entire outside of the building read as interior:
  // no windows were found and the wall faces went undressed.
  //
  // Flooding in from beyond the bounding box answers the question actually being
  // asked - can you get here from outdoors - and gets overhangs, porches,
  // arcades and open courtyards right for the same reason.
  const outside = new Set()
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const cell of solid.values()) {
    lo.x = Math.min(lo.x, cell.pos.x); hi.x = Math.max(hi.x, cell.pos.x)
    lo.y = Math.min(lo.y, cell.pos.y); hi.y = Math.max(hi.y, cell.pos.y)
    lo.z = Math.min(lo.z, cell.pos.z); hi.z = Math.max(hi.z, cell.pos.z)
  }

  const inBox = p => p.x >= lo.x - 1 && p.x <= hi.x + 1 &&
    p.y >= lo.y - 1 && p.y <= hi.y + 1 &&
    p.z >= lo.z - 1 && p.z <= hi.z + 1

  const volume = solid.size
    ? (hi.x - lo.x + 3) * (hi.y - lo.y + 3) * (hi.z - lo.z + 3)
    : 0
  const FLOOD_LIMIT = 4000000

  if (solid.size && volume <= FLOOD_LIMIT) {
    const queue = []
    for (let x = lo.x - 1; x <= hi.x + 1; x++) {
      for (let z = lo.z - 1; z <= hi.z + 1; z++) {
        for (const y of [lo.y - 1, hi.y + 1]) queue.push(new Vec3(x, y, z))
      }
    }
    for (let y = lo.y - 1; y <= hi.y + 1; y++) {
      for (let x = lo.x - 1; x <= hi.x + 1; x++) {
        queue.push(new Vec3(x, y, lo.z - 1)); queue.push(new Vec3(x, y, hi.z + 1))
      }
      for (let z = lo.z - 1; z <= hi.z + 1; z++) {
        queue.push(new Vec3(lo.x - 1, y, z)); queue.push(new Vec3(hi.x + 1, y, z))
      }
    }
    const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    while (queue.length) {
      const p = queue.pop()
      const k = key(p.x, p.y, p.z)
      if (outside.has(k) || !inBox(p) || isSolid(p)) continue
      outside.add(k)
      for (const [dx, dy, dz] of steps) queue.push(new Vec3(p.x + dx, p.y + dy, p.z + dz))
    }
  }

  const isOutside = p => {
    if (isSolid(p)) return false
    if (!inBox(p)) return true
    if (volume > FLOOD_LIMIT) {
      const top = columnTop.get(col(p.x, p.z))
      return top === undefined || p.y >= top
    }
    return outside.has(key(p.x, p.y, p.z))
  }

  const exteriorFaces = []
  const faceIndex = new Map() // key -> [normals]
  const topEdges = []
  const overhangs = []

  for (const [k, cell] of solid) {
    const p = cell.pos
    const normals = []
    for (const d of DIRS) {
      if (isOutside(p.plus(d.v))) normals.push(d)
    }
    if (normals.length) {
      faceIndex.set(k, normals)
      for (const n of normals) {
        exteriorFaces.push({ pos: p, normal: n, height: p.y - minY, cell })
      }
      if (columnTop.get(col(p.x, p.z)) === p.y) topEdges.push({ pos: p, normals, cell })
      if (!isSolid(p.offset(0, -1, 0))) overhangs.push({ pos: p, normals, cell })
    }
  }

  const corners = [...faceIndex.entries()]
    .filter(([, normals]) => normals.length >= 2 &&
      normals.some(n => n.v.x !== 0) && normals.some(n => n.v.z !== 0))
    .map(([k, normals]) => ({ pos: solid.get(k).pos, normals }))

  // A blank wall: a run of exterior faces on one plane, tall and unbroken by any
  // opening. This is what arrow slits and pilasters are looking for - a stretch
  // of undifferentiated masonry is the single most generated-looking thing a
  // build can have.
  const openingCells = new Set()
  for (const k of carved.keys()) openingCells.add(k)

  const columns = new Map() // "normal|plane|across" -> [heights]
  for (const face of exteriorFaces) {
    const n = face.normal
    const plane = n.v.x !== 0 ? face.pos.x : face.pos.z
    const across = n.v.x !== 0 ? face.pos.z : face.pos.x
    const id = `${n.key}|${plane}|${across}`
    if (!columns.has(id)) columns.set(id, [])
    columns.get(id).push(face)
  }

  // A RUN IS A STRETCH OF WALL, NOT A SINGLE COLUMN.
  //
  // Grouping per column looked right and produced 1296 arrow slits on one
  // castle - every column of a 40-block curtain wall counted as its own blank
  // wall and got its own pair. What the habit actually wants is the contiguous
  // horizontal stretch, so a slit can be spaced along it.
  const MIN_BLANK = 8
  const blankColumns = []
  for (const [id, faces] of columns) {
    const [normalKey, plane, across] = id.split('|')
    const ys = faces.map(f => f.pos.y).sort((a, b) => a - b)
    const dir = DIRS.find(d => d.key === normalKey)
    const hasOpening = faces.some(f => {
      const out = f.pos.plus(dir.v)
      return openingCells.has(key(out.x, out.y, out.z))
    })
    if (hasOpening) continue
    if (ys.length < MIN_BLANK) continue
    if (ys[ys.length - 1] - ys[0] + 1 !== ys.length) continue // contiguous
    blankColumns.push({ dir, plane: Number(plane), across: Number(across), bottom: ys[0], top: ys[ys.length - 1], height: ys.length, faces })
  }

  blankColumns.sort((a, b) =>
    a.dir.key.localeCompare(b.dir.key) || a.plane - b.plane || a.across - b.across)

  const verticalRuns = []
  let current = null
  for (const col of blankColumns) {
    const continues = current &&
      current.normal.key === col.dir.key &&
      current.plane === col.plane &&
      col.across === current.lastAcross + 1 &&
      col.bottom === current.bottom &&
      col.top === current.top
    if (continues) {
      current.columns.push(col)
      current.lastAcross = col.across
      current.length++
    } else {
      if (current) verticalRuns.push(current)
      current = {
        normal: col.dir,
        plane: col.plane,
        firstAcross: col.across,
        lastAcross: col.across,
        bottom: col.bottom,
        top: col.top,
        height: col.height,
        length: 1,
        columns: [col]
      }
    }
  }
  if (current) verticalRuns.push(current)

  return {
    solid,
    columnTop,
    cells,
    carved,
    minY,
    maxY,
    isSolid,
    isOutside,
    exteriorFaces,
    faceIndex,
    corners,
    topEdges,
    overhangs,
    verticalRuns,
    openings: findOpenings(cells, carved, isSolid, isOutside),
    floorLines: findFloorLines(solid, minY, maxY),
    rooms: findRooms(cells, isSolid, isOutside, minY, maxY)
  }
}

// Openings are the cells a carve took out of a wall - not the room interiors it
// also took out. The difference is that a window has the outside on one side of
// it and solid on the other, so it is a hole THROUGH something.
function findOpenings (cells, carved, isSolid, isOutside) {
  const candidates = new Set()
  for (const k of carved.keys()) {
    const [x, y, z] = k.split(',').map(Number)
    const p = new Vec3(x, y, z)
    let touchesSolid = false
    let touchesOutside = false
    for (const d of DIRS) {
      if (isSolid(p.plus(d.v))) touchesSolid = true
      if (isOutside(p.plus(d.v))) touchesOutside = true
    }
    if (touchesSolid && touchesOutside) candidates.add(k)
  }

  // Group into connected components; each is one window or doorway.
  const seen = new Set()
  const groups = []
  for (const start of candidates) {
    if (seen.has(start)) continue
    const queue = [start]
    const group = []
    seen.add(start)
    while (queue.length) {
      const k = queue.pop()
      group.push(k)
      const [x, y, z] = k.split(',').map(Number)
      for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nk = key(x + n[0], y + n[1], z + n[2])
        if (candidates.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk) }
      }
    }
    groups.push(group)
  }

  // A window is a hole through a wall. A room interior also touches solid and
  // also reaches outdoors - through its own doorway, or through an open tower
  // top - so without a size bound the whole inside of a building comes back as
  // one very tall "opening" and gets framed like a window.
  const MAX_OPENING = { span: 8, cells: 48, thickness: 3 }

  return groups.map(group => {
    const pts = group.map(k => k.split(',').map(Number))
    const min = { x: Math.min(...pts.map(p => p[0])), y: Math.min(...pts.map(p => p[1])), z: Math.min(...pts.map(p => p[2])) }
    const max = { x: Math.max(...pts.map(p => p[0])), y: Math.max(...pts.map(p => p[1])), z: Math.max(...pts.map(p => p[2])) }
    // The wall's normal is the thin axis - a window is wide and tall, not deep.
    const spanX = max.x - min.x
    const spanZ = max.z - min.z
    const axis = spanX <= spanZ ? 'x' : 'z'
    return {
      cells: group,
      min,
      max,
      axis,
      width: axis === 'x' ? spanZ + 1 : spanX + 1,
      height: max.y - min.y + 1,
      thickness: (axis === 'x' ? spanX : spanZ) + 1
    }
  }).filter(o =>
    o.width <= MAX_OPENING.span &&
    o.height <= MAX_OPENING.span &&
    o.thickness <= MAX_OPENING.thickness &&
    o.cells.length <= MAX_OPENING.cells)
}

// Floor lines: the y levels a string course should follow. Explicit floor
// slabs are the honest answer; failing that, any level that is mostly solid
// across the footprint is a floor.
function findFloorLines (solid, minY, maxY) {
  const columns = new Set()
  const perLevel = new Map()
  for (const cell of solid.values()) {
    columns.add(col(cell.pos.x, cell.pos.z))
    perLevel.set(cell.pos.y, (perLevel.get(cell.pos.y) || 0) + 1)
  }
  const footprint = columns.size || 1
  const lines = []
  for (let y = minY + 1; y <= maxY; y++) {
    if ((perLevel.get(y) || 0) >= footprint * 0.5) lines.push(y)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Interiors.
//
// Everything else here answers questions about the outside, because that is
// what the decorator was built to dress. The result is a building that reads
// well from thirty blocks away and is a bare shell the moment you walk in:
// measured on a finished keep, 43% of the interior had no light within four
// blocks and the floor underfoot was nineteen different materials.
//
// A room is a connected pocket of air that is NOT outside, with a ceiling over
// it and a floor under it. Grouping them per pocket rather than per storey
// matters: a tower shaft and the hall beside it are different rooms with
// different needs, and lighting them as one volume puts lanterns in the wrong
// places.
// ---------------------------------------------------------------------------
const MIN_ROOM_CELLS = 12
const MAX_ROOM_CELLS = 20000

// INDOORS IS NOT "UNREACHABLE FROM OUTSIDE". The first cut used the exterior
// flood fill and found zero rooms in a keep, because the fill walks straight in
// through the front door - which is what a door is for. A room is a cell with a
// ceiling over it and walls around it, whether or not you can walk to it.
const CEILING_WITHIN = 7
const WALL_WITHIN = 10

function findRooms (cells, isSolid, isOutside, minY, maxY) {
  const hasCeiling = p => {
    for (let d = 1; d <= CEILING_WITHIN; d++) if (isSolid(p.offset(0, d, 0))) return true
    return false
  }
  const wallsAround = p => {
    let n = 0
    for (const d of DIRS) {
      for (let r = 1; r <= WALL_WITHIN; r++) {
        if (isSolid(p.plus(d.v.scaled(r)))) { n++; break }
      }
    }
    return n
  }

  const candidates = new Set()
  for (const cell of cells.values()) {
    if (baseName(cell.name) !== 'air') continue
    const p = cell.pos
    if (!hasCeiling(p)) continue
    if (wallsAround(p) < 4) continue
    candidates.add(key(p.x, p.y, p.z))
  }

  const seen = new Set()
  const rooms = []
  const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

  for (const start of candidates) {
    if (seen.has(start)) continue
    const queue = [start]
    const group = []
    seen.add(start)

    while (queue.length && group.length < MAX_ROOM_CELLS) {
      const k = queue.pop()
      group.push(k)
      const [x, y, z] = k.split(',').map(Number)
      for (const [dx, dy, dz] of steps) {
        const nk = key(x + dx, y + dy, z + dz)
        if (candidates.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk) }
      }
    }
    if (group.length < MIN_ROOM_CELLS) continue

    const pts = group.map(k => k.split(',').map(Number))
    const lo = { x: Math.min(...pts.map(p => p[0])), y: Math.min(...pts.map(p => p[1])), z: Math.min(...pts.map(p => p[2])) }
    const hi = { x: Math.max(...pts.map(p => p[0])), y: Math.max(...pts.map(p => p[1])), z: Math.max(...pts.map(p => p[2])) }

    // The floor of a room is the lowest course of air with something solid
    // under it - which is where a player actually stands.
    const floorCells = []
    const ceilingCells = []
    for (const [x, y, z] of pts) {
      const below = new Vec3(x, y - 1, z)
      const above = new Vec3(x, y + 1, z)
      if (isSolid(below)) floorCells.push({ x, y, z })
      if (isSolid(above)) ceilingCells.push({ x, y, z })
    }

    rooms.push({
      cells: group,
      lo,
      hi,
      size: group.length,
      width: hi.x - lo.x + 1,
      depth: hi.z - lo.z + 1,
      height: hi.y - lo.y + 1,
      floor: floorCells,
      ceiling: ceilingCells
    })
  }

  return rooms.sort((a, b) => b.size - a.size)
}

module.exports = { analyse, findRooms, NON_SOLID, DIRS }
