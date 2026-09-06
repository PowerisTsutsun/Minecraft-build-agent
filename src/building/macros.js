'use strict'

const { Vec3 } = require('vec3')
const primitives = require('./primitives')
const { baseName } = require('./blockspec')

// ---------------------------------------------------------------------------
// Compound macros.
//
// One action becomes a whole building: floors, a stair that reaches them,
// windows on every storey, trim, a roof with eaves, a door at the ground. All
// the arithmetic - where each floor sits, how tall to make the stair so its top
// tread lands flush, which cells of the wall to open - happens here, in code.
//
// This is the difference between a plan that describes a building and a plan
// that describes a shell. Left to place these itself the model spends thirty
// actions on one tower and still gets the stair height wrong.
//
// A macro returns { shell, carves, details } of ordinary op actions, which the
// renderer then treats exactly like anything else - so protection, the lint and
// the decorator all apply to macro output without knowing macros exist.
// ---------------------------------------------------------------------------

const STOREY = 5 // floor to floor: 4 clear plus the floor itself

function odd (n) {
  const v = Math.max(1, Math.floor(n))
  return v % 2 === 0 ? v + 1 : v
}

function pick (palette, slot, fallback) {
  const v = palette && palette[slot]
  return typeof v === 'string' ? v : fallback
}

// --- tower -----------------------------------------------------------------
// A round tower: plinth, shaft, floors, a spiral that lands on each of them,
// windows per storey, trim bands, and a top that is a cone, battlements or an
// open belfry.
function tower (a, palette) {
  const diameter = odd(a.diameter || (a.radius ? a.radius * 2 + 1 : 9))
  const r = Math.floor(diameter / 2)
  const height = Math.max(6, Math.floor(a.height || 20))
  const storeys = Math.max(1, Math.floor(a.storeys || Math.max(1, Math.floor((height - 2) / STOREY))))
  const wall = pick(palette, 'wall', a.material || 'stone_bricks')
  const trim = pick(palette, 'trim', 'polished_andesite')
  const roofMat = pick(palette, 'roof', 'deepslate_tiles')
  const glass = pick(palette, 'glass', 'glass_pane')
  const o = a.offset

  const shell = []
  const carves = []
  const details = []
  const at = (dx, dy, dz) => ({ x: o.x + dx, y: o.y + dy, z: o.z + dz })

  shell.push({ op: 'plinth', material: pick(palette, 'base_rough', 'cobblestone'), offset: at(0, 0, 0), anchor: 'center', width: diameter, depth: diameter, height: 1, grow: 1 })
  shell.push({ op: 'cylinder', material: wall, offset: at(0, 1, 0), anchor: 'center', radius: r, height, hollow: true })
  carves.push({ op: 'cylinder', material: 'air', offset: at(0, 2, 0), anchor: 'center', radius: r - 1, height: height - 1, hollow: false })

  // Floors, and the stair that reaches each one.
  const floorYs = []
  for (let s = 1; s <= storeys; s++) {
    const fy = 1 + s * STOREY
    if (fy >= height) break
    floorYs.push(fy)
    shell.push({ op: 'cylinder', material: pick(palette, 'floor', trim), offset: at(0, fy, 0), anchor: 'center', radius: r - 1, height: 1, hollow: false })
  }

  if (a.spiral !== false && r >= 3) {
    const top = floorYs.length ? floorYs[floorYs.length - 1] : height - 2
    // Top tread must land ON the floor it serves: y + rise - 1 === top.
    details.push({
      op: 'spiral',
      material: pick(palette, 'floor', wall),
      offset: at(0, 2, 0),
      anchor: 'center',
      radius: Math.min(r - 1, 3),
      height: Math.max(2, top - 1),
      railing: a.railing || 'cobblestone_wall'
    })
  }

  // Windows: one per face per storey, and a door at the bottom.
  const perStorey = Math.max(0, Math.floor(a.windows_per_storey !== undefined ? a.windows_per_storey : 2))
  const faces = ['north', 'east', 'south', 'west']
  for (let s = 0; s < floorYs.length + 1; s++) {
    const sy = 2 + s * STOREY + 1
    if (sy + 3 >= height) break
    for (let i = 0; i < perStorey; i++) {
      const face = faces[(i + s) % 4]
      carves.push({
        op: 'window', offset: at(0, sy, 0), anchor: 'center', face, along: 0,
        width: 1, height: 2, style: 'arched', frame: trim, glass,
        footprint: { width: diameter, depth: diameter }
      })
    }
  }
  carves.push({
    op: 'door', offset: at(0, 2, 0), anchor: 'center', face: a.door_face || 'south', along: 0,
    width: 1, height: 3, arched: true, frame: trim,
    footprint: { width: diameter, depth: diameter }
  })

  const every = Math.max(0, Math.floor(a.trim_every !== undefined ? a.trim_every : 5))
  if (every) {
    for (let ty = 1 + every; ty < height; ty += every) {
      details.push({ op: 'trim_band', material: trim, offset: at(0, ty, 0), anchor: 'center', width: diameter, depth: diameter })
    }
  }

  // The top.
  const top = a.top || 'cone'
  const capY = 1 + height
  if (top === 'battlements') {
    details.push({ op: 'eaves', material: wall, offset: at(0, capY - 1, 0), anchor: 'center', width: diameter, depth: diameter })
    details.push({ op: 'battlements', material: pick(palette, 'accent', 'cobblestone_wall'), offset: at(0, capY, 0), anchor: 'center', width: diameter + 2, depth: diameter + 2, height: 2 })
  } else if (top === 'belfry') {
    shell.push({ op: 'cylinder', material: wall, offset: at(0, capY, 0), anchor: 'center', radius: r, height: 4, hollow: true })
    carves.push({ op: 'cylinder', material: 'air', offset: at(0, capY, 0), anchor: 'center', radius: r - 1, height: 4, hollow: false })
    details.push({ op: 'roof', material: roofMat, offset: at(0, capY + 4, 0), anchor: 'center', kind: 'cone', radius: r + 1, height: r * 2 })
  } else {
    details.push({ op: 'eaves', material: wall, offset: at(0, capY - 1, 0), anchor: 'center', width: diameter, depth: diameter })
    details.push({ op: 'roof', material: roofMat, offset: at(0, capY, 0), anchor: 'center', kind: 'cone', radius: r + 1, height: Math.max(4, r * 2) })
  }

  return { shell, carves, details }
}

// --- hall ------------------------------------------------------------------
// A rectangular building: plinth, walls on a bay grid, floors, a stair between
// them, windows per bay, a door, trim at each floor line, and a pitched roof.
function hall (a, palette) {
  const width = odd(a.width || 11)
  const depth = odd(a.depth || 17)
  const storeys = Math.max(1, Math.floor(a.storeys || 1))
  const wallH = storeys * STOREY
  const wall = pick(palette, 'wall', a.material || 'stone_bricks')
  const trim = pick(palette, 'trim', 'polished_andesite')
  const roofMat = pick(palette, 'roof', 'dark_oak_planks')
  const glass = pick(palette, 'glass', 'glass_pane')
  const post = pick(palette, 'accent', 'stripped_oak_log')
  const o = a.offset
  const at = (dx, dy, dz) => ({ x: o.x + dx, y: o.y + dy, z: o.z + dz })

  const shell = []
  const carves = []
  const details = []

  shell.push({ op: 'plinth', material: pick(palette, 'base_rough', 'cobblestone'), offset: at(0, 0, 0), anchor: 'corner', width, depth, height: 1, grow: 1 })
  shell.push({ op: 'box', material: wall, offset: at(0, 1, 0), anchor: 'corner', width, depth, height: wallH, hollow: true })
  carves.push({ op: 'box', material: 'air', offset: at(1, 2, 1), anchor: 'corner', width: width - 2, depth: depth - 2, height: wallH - 2, hollow: false })

  const floorYs = []
  for (let s = 1; s < storeys; s++) {
    const fy = 1 + s * STOREY
    floorYs.push(fy)
    shell.push({ op: 'floor', material: pick(palette, 'floor', trim), offset: at(1, fy, 1), anchor: 'corner', width: width - 2, depth: depth - 2 })
  }

  // One straight flight per storey, along the inside of the west wall.
  for (let s = 0; s < floorYs.length; s++) {
    const from = s === 0 ? 2 : floorYs[s - 1]
    const to = floorYs[s]
    details.push({
      op: 'stairs', offset: at(2, from, 2), anchor: 'corner', axis: 'z', ascent: '+',
      width: 2, rise: to - from + 1,
      tread: pick(palette, 'floor', 'oak_planks'), stringer: trim,
      lights: 'lantern', landing_every: 0
    })
  }

  // Bays: a post at every third cell along the long walls, a window between.
  const bays = Math.max(2, Math.floor(a.bays || Math.floor(depth / 4)))
  const spacing = Math.max(2, Math.floor((depth - 1) / bays))
  if (a.corner_posts !== false) {
    for (const [dx, dz] of [[0, 0], [width - 1, 0], [0, depth - 1], [width - 1, depth - 1]]) {
      details.push({ op: 'column', material: post, offset: at(dx, 1, dz), anchor: 'corner', height: wallH, axis: 'y' })
    }
  }

  for (let s = 0; s < storeys; s++) {
    const sy = 2 + s * STOREY + 1
    for (let b = 1; b < bays; b++) {
      const along = b * spacing
      if (along <= 1 || along >= depth - 2) continue
      for (const face of ['east', 'west']) {
        carves.push({
          op: 'window', offset: at(0, sy, 0), anchor: 'corner', face, along,
          width: 1, height: 2, style: 'arched', frame: trim, glass,
          footprint: { width, depth }
        })
      }
    }
  }

  const doorFace = a.door && a.door.face ? a.door.face : 'north'
  const doorAlong = a.door && Number.isFinite(a.door.along) ? a.door.along : Math.floor(width / 2)
  carves.push({
    op: 'door', offset: at(0, 2, 0), anchor: 'corner', face: doorFace, along: doorAlong,
    width: 2, height: 3, arched: true, frame: trim, door_block: a.door_block || null,
    footprint: { width, depth }
  })

  for (const fy of floorYs) {
    details.push({ op: 'trim_band', material: trim, offset: at(0, fy, 0), anchor: 'corner', width, depth })
  }
  details.push({ op: 'eaves', material: wall, offset: at(0, 1 + wallH - 1, 0), anchor: 'corner', width, depth })
  details.push({
    op: 'roof', material: roofMat, offset: at(0, 1 + wallH, 0), anchor: 'corner',
    kind: a.roof || 'gable', width, depth, axis: depth >= width ? 'z' : 'x'
  })

  return { shell, carves, details }
}

// --- curtain_wall ----------------------------------------------------------
// A defensive wall between two points: two courses thick, a walkway on top,
// crenellations outside, arrow slits every few blocks, and a stair up.
function curtainWall (a, palette) {
  const from = a.from || { x: 0, z: 0 }
  const to = a.to || { x: 16, z: 0 }
  const height = Math.max(4, Math.floor(a.height || 8))
  const thickness = Math.max(2, Math.floor(a.thickness || 2))
  const wall = pick(palette, 'wall', a.material || 'stone_bricks')
  const trim = pick(palette, 'trim', 'polished_andesite')
  const o = a.offset

  const alongX = Math.abs(to.x - from.x) >= Math.abs(to.z - from.z)
  const length = Math.max(2, Math.abs(alongX ? to.x - from.x : to.z - from.z) + 1)
  const base = {
    x: o.x + Math.min(from.x, to.x),
    y: o.y,
    z: o.z + Math.min(from.z, to.z)
  }

  const width = alongX ? length : thickness
  const depth = alongX ? thickness : length

  const shell = [
    { op: 'box', material: wall, offset: { ...base, y: base.y }, anchor: 'corner', width, depth, height, hollow: false }
  ]
  const carves = []
  const details = [
    { op: 'trim_band', material: trim, offset: { ...base, y: base.y + height - 1 }, anchor: 'corner', width, depth },
    { op: 'battlements', material: pick(palette, 'accent', 'cobblestone_wall'), offset: { ...base, y: base.y + height }, anchor: 'corner', width, depth, height: 2 }
  ]

  // Arrow slits: a one-wide, two-tall opening every few blocks along the face.
  const every = Math.max(0, Math.floor(a.slit_every !== undefined ? a.slit_every : 4))
  if (every) {
    for (let i = every; i < length - 1; i += every) {
      carves.push({
        op: 'window', offset: { ...base, y: base.y + height - 4 }, anchor: 'corner',
        face: alongX ? 'north' : 'west', along: i, width: 1, height: 2, style: 'plain',
        frame: null, glass: null, footprint: { width, depth }
      })
    }
  }

  return { shell, carves, details }
}

// --- gatehouse -------------------------------------------------------------
// Two flanking towers with an arched passage between them, a portcullis, and
// murder holes over the passage.
function gatehouse (a, palette) {
  const passage = odd(a.passage_width || 3)
  const height = Math.max(8, Math.floor(a.height || 12))
  const towerD = odd(a.tower_diameter || 7)
  const wall = pick(palette, 'wall', a.material || 'stone_bricks')
  const trim = pick(palette, 'trim', 'polished_andesite')
  const o = a.offset
  const depth = Math.max(5, Math.floor(a.depth || towerD))

  const shell = []
  const carves = []
  const details = []

  const span = passage + towerD * 2
  const left = { x: o.x, y: o.y, z: o.z }
  const right = { x: o.x + passage + towerD, y: o.y, z: o.z }

  for (const t of [left, right]) {
    const built = tower({
      offset: { x: t.x + Math.floor(towerD / 2), y: t.y, z: t.z + Math.floor(depth / 2) },
      diameter: towerD, height, storeys: 2, top: 'battlements',
      windows_per_storey: 1, material: wall, spiral: false
    }, palette)
    shell.push(...built.shell)
    carves.push(...built.carves)
    details.push(...built.details)
  }

  // The block between the towers, then the passage cut through it.
  shell.push({ op: 'box', material: wall, offset: { x: o.x + towerD, y: o.y, z: o.z }, anchor: 'corner', width: passage, depth, height, hollow: false })
  carves.push({ op: 'arch', material: 'air', offset: { x: o.x + towerD, y: o.y + 1, z: o.z }, anchor: 'corner', width: passage, height: Math.min(5, height - 2), depth, axis: 'z' })

  // Portcullis at the outer end, and murder holes above the passage.
  if (a.portcullis !== false) {
    details.push({
      op: 'wall', material: 'iron_bars', offset: { x: o.x + towerD, y: o.y + 1, z: o.z }, anchor: 'corner',
      length: passage, height: Math.min(4, height - 3), axis: 'x'
    })
  }
  const holeY = o.y + Math.min(5, height - 2)
  const holes = []
  for (let i = 1; i < passage; i += 2) {
    for (let d = 1; d < depth; d += 2) holes.push({ x: towerD + i, y: 0, z: d })
  }
  if (holes.length) {
    carves.push({ op: 'blocks', material: 'air', offset: { x: o.x, y: holeY, z: o.z }, anchor: 'corner', cells: holes })
  }

  details.push({ op: 'battlements', material: pick(palette, 'accent', 'cobblestone_wall'), offset: { x: o.x + towerD, y: o.y + height, z: o.z }, anchor: 'corner', width: passage, depth, height: 2 })

  return { shell, carves, details, span }
}

const MACROS = { tower, hall, curtain_wall: curtainWall, gatehouse }

function isMacro (op) {
  return Object.prototype.hasOwnProperty.call(MACROS, op)
}

function expand (action, palette) {
  return MACROS[action.op](action, palette || {})
}

module.exports = { isMacro, expand, MACROS, STOREY }
