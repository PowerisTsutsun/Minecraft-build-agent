'use strict'

const { Vec3 } = require('vec3')
const { baseName, hasState, withState } = require('./blockspec')

// Circles are rasterised against (r + HALF)^2, not r^2.
//
// A bare r^2 test keeps only cells whose CENTRE is inside the circle, which
// pinches the cardinal extremes to a single block: diameter 5 comes out
// 1,3,5,3,1 - visibly pointy, and not what any Minecraft circle chart shows.
// Testing against (r + 0.5)^2 asks whether the cell's near edge is inside, and
// reproduces the conventional widths exactly: 3,5,5,5,3 at d5, 3,5,7,7,7,5,3
// at d7, 5,7,9,9,9,9,9,7,5 at d9. The bounding box is unchanged - only the
// corners of the silhouette fill out.
const HALF = 0.5
const circleLimit = r => (r + HALF) * (r + HALF)

// The direction a stair ascends, from a vector pointing up-slope.
//
// facing is the side the RAISED half sits on (measured - see
// test/stair-facing-probe.js), so for a roof the raised half must point toward
// the ridge: that is what makes each stair's top edge meet the underside of the
// next one up and reads as a continuous 45-degree surface. Pointing them the
// other way leaves a sawtooth.
function ascentFacing (dx, dz) {
  return Math.abs(dx) >= Math.abs(dz)
    ? (dx > 0 ? 'east' : 'west')
    : (dz > 0 ? 'south' : 'north')
}

// Orient a stairs material, leaving any other block - and any material whose
// state the caller chose explicitly - completely alone.
function orientStairs (material, dx, dz, half = 'bottom') {
  if (!/_stairs$/.test(baseName(material)) || hasState(material)) return material
  return withState(material, `facing=${ascentFacing(dx, dz)},half=${half}`)
}

// ---------------------------------------------------------------------------
// Primitive shape generators.
//
// Every generator returns a flat array of { pos: Vec3, name: string } in
// RELATIVE coordinates (origin-anchored, y=0 is the structure's floor). None
// of them touch the bot or the world - they are pure functions, which is what
// makes dry-run mode and unit-testing them possible.
//
// Ordering matters more than it looks: the placer walks this array in order,
// and mineflayer can only place a block against an already-solid neighbor. So
// every generator emits bottom-up, and anything that could strand the bot over
// a hole (roofs, ceilings) is ordered outermost-ring-first so there is always
// an adjacent placed block to stand next to.
// ---------------------------------------------------------------------------

// Sorts a horizontal slab from its perimeter inward, so the bot builds a ring
// and then fills toward the middle rather than walling itself off from the
// blocks it still has to reach.
function outsideIn (blocks, width, depth) {
  const cx = (width - 1) / 2
  const cz = (depth - 1) / 2
  return blocks.slice().sort((a, b) => {
    const da = Math.max(Math.abs(a.pos.x - cx), Math.abs(a.pos.z - cz))
    const db = Math.max(Math.abs(b.pos.x - cx), Math.abs(b.pos.z - cz))
    return db - da
  })
}

// A solid horizontal slab, width (x) by depth (z), at height y.
function floor ({ width, depth, material, y = 0 }) {
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      blocks.push({ pos: new Vec3(x, y, z), name: material })
    }
  }
  return outsideIn(blocks, width, depth)
}

// A flat vertical wall `length` long and `height` tall, running along either
// the x or the z axis.
function wall ({ length, height, material, axis = 'x', y = 0 }) {
  const blocks = []
  for (let h = 0; h < height; h++) {
    for (let i = 0; i < length; i++) {
      const pos = axis === 'z' ? new Vec3(0, y + h, i) : new Vec3(i, y + h, 0)
      blocks.push({ pos, name: material })
    }
  }
  return blocks
}

// A box. `hollow` (the default) gives you four walls plus floor and ceiling -
// a room. `hollow: false` gives a solid cuboid.
function box ({ width, depth, height, material, hollow = true, y = 0 }) {
  const blocks = []

  for (let h = 0; h < height; h++) {
    const layer = []
    const isCap = h === 0 || h === height - 1
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        const isPerimeter = x === 0 || x === width - 1 || z === 0 || z === depth - 1
        if (hollow && !isCap && !isPerimeter) continue
        layer.push({ pos: new Vec3(x, y + h, z), name: material })
      }
    }
    // Only the flat caps need the outside-in treatment; a perimeter ring is
    // already self-supporting in any order.
    blocks.push(...(isCap ? outsideIn(layer, width, depth) : layer))
  }

  return blocks
}

// A sphere of the given radius, centred horizontally on the origin and sitting
// with its lowest point at y. `hollow` keeps only the shell.
//
// Shell test: a voxel is on the shell if it is inside the radius but at least
// one of its 6 neighbours is outside. Comparing against (r - 1) instead would
// leave diagonal gaps you can see daylight through.
function sphere ({ radius, material, hollow = true, y = 0 }) {
  const blocks = []
  const r = Math.max(1, Math.floor(radius))
  const limit = circleLimit(r)
  const inside = (x, yy, z) => (x * x + yy * yy + z * z) <= limit

  for (let dy = -r; dy <= r; dy++) {
    const layer = []
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (!inside(dx, dy, dz)) continue
        if (hollow) {
          const solidShell =
            inside(dx + 1, dy, dz) && inside(dx - 1, dy, dz) &&
            inside(dx, dy + 1, dz) && inside(dx, dy - 1, dz) &&
            inside(dx, dy, dz + 1) && inside(dx, dy, dz - 1)
          if (solidShell) continue
        }
        // Shift so the sphere's bottom rests at y and its centre sits at
        // (r, r) in x/z - keeps every coordinate non-negative, matching the
        // other primitives' "origin is the near-bottom-left corner" contract.
        layer.push({ pos: new Vec3(dx + r, y + dy + r, dz + r), name: material })
      }
    }
    blocks.push(...outsideIn(layer, r * 2 + 1, r * 2 + 1))
  }

  return blocks
}

// The original procedural house, preserved from the pre-refactor bot: floor,
// four walls with a doorway, and a flat roof one course above the walls.
function house ({ width, depth, height, wallBlock, floorBlock, roofBlock, doorGap = 2 }) {
  const blocks = floor({ width, depth, material: floorBlock, y: 0 })

  const doorX = Math.floor(width / 2)
  for (let y = 1; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        const isPerimeter = x === 0 || x === width - 1 || z === 0 || z === depth - 1
        if (!isPerimeter) continue
        if (x === doorX && z === 0 && y <= doorGap) continue // doorway
        blocks.push({ pos: new Vec3(x, y, z), name: wallBlock })
      }
    }
  }

  return blocks.concat(floor({ width, depth, material: roofBlock, y: height + 1 }))
}


// A vertical cylinder (or a horizontal one - `axis` is the direction it runs).
// Round towers, pillars, wells, tunnels. `hollow` keeps only the wall, which is
// what makes it a tower rather than a very expensive pillar.
//
// The shell test is the same one the sphere uses and for the same reason:
// "inside the radius but with a neighbour outside it" keeps the wall connected
// where "inside r but outside r-1" leaves diagonal gaps you can see through.
function cylinder ({ radius, height, material, hollow = true, axis = 'y', y = 0 }) {
  const r = Math.max(1, Math.floor(radius))
  const len = Math.max(1, Math.floor(height))
  const limit = circleLimit(r)
  const inside = (a, b) => (a * a + b * b) <= limit
  const blocks = []

  for (let i = 0; i < len; i++) {
    const layer = []
    for (let da = -r; da <= r; da++) {
      for (let db = -r; db <= r; db++) {
        if (!inside(da, db)) continue
        if (hollow && inside(da + 1, db) && inside(da - 1, db) && inside(da, db + 1) && inside(da, db - 1)) continue
        // Shift so nothing is negative: the shape's own corner is the origin,
        // matching every other primitive's contract.
        const pos = axis === 'x' ? new Vec3(i, y + da + r, db + r)
          : axis === 'z' ? new Vec3(da + r, y + db + r, i)
            : new Vec3(da + r, y + i, db + r)
        layer.push({ pos, name: material })
      }
    }
    blocks.push(...(axis === 'y' ? outsideIn(layer, r * 2 + 1, r * 2 + 1) : layer))
  }

  return blocks
}

// A cone: a disc of `radius` at the bottom tapering to a point at `height`.
// This is the witch-hat / turret roof, and it is the single shape that stops a
// round tower reading as a pipe.
//
// Hollow keeps the sloping surface only: a cell is on it when it is inside this
// level's disc but NOT inside the level above's, i.e. it is the top of its own
// column. Adding the rim band keeps steep cones watertight.
function cone ({ radius, height, material, hollow = true, y = 0 }) {
  const r = Math.max(1, Math.floor(radius))
  const h = Math.max(1, Math.floor(height))
  const blocks = []

  const radiusAt = level => r * (1 - level / h)

  for (let level = 0; level < h; level++) {
    const rNow = radiusAt(level)
    const rNext = radiusAt(level + 1)
    const layer = []
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d > rNow + HALF) continue
        if (hollow && d <= rNext + HALF && d <= rNow - 1 + HALF) continue
        // A conical roof climbs toward its own axis.
        layer.push({ pos: new Vec3(dx + r, y + level, dz + r), name: orientStairs(material, -dx, -dz) })
      }
    }
    blocks.push(...outsideIn(layer, r * 2 + 1, r * 2 + 1))
  }

  return blocks
}

// A rectangular pyramid, insetting proportionally so any height works - a tall
// thin spire and a squat ziggurat come out of the same generator. Hollow keeps
// each level's perimeter, which is what you want for a stepped temple.
function pyramid ({ width, depth, height, material, hollow = false, y = 0 }) {
  const w = Math.max(1, Math.floor(width))
  const d = Math.max(1, Math.floor(depth))
  const h = Math.max(1, Math.floor(height))
  const blocks = []

  for (let level = 0; level < h; level++) {
    const t = level / h
    const insetX = Math.floor(t * (w - 1) / 2)
    const insetZ = Math.floor(t * (d - 1) / 2)
    const x0 = insetX
    const x1 = w - 1 - insetX
    const z0 = insetZ
    const z1 = d - 1 - insetZ
    if (x0 > x1 || z0 > z1) break

    const layer = []
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const isPerimeter = x === x0 || x === x1 || z === z0 || z === z1
        if (hollow && !isPerimeter && level < h - 1) continue
        // A pyramid used as a hip roof: all four faces climb inward.
        const name = orientStairs(material, (w - 1) / 2 - x, (d - 1) / 2 - z)
        layer.push({ pos: new Vec3(x, y + level, z), name })
      }
    }
    blocks.push(...outsideIn(layer, w, d))
  }

  return blocks
}

// A pitched (gable) roof: two sloping planes meeting at a ridge. `axis` is the
// direction the ridge runs. This is the difference between a house and a box
// with a lid, and it costs one primitive.
function gable ({ width, depth, material, axis = 'x', y = 0 }) {
  const w = Math.max(1, Math.floor(width))
  const d = Math.max(1, Math.floor(depth))
  const run = axis === 'z' ? d : w // along the ridge
  const span = axis === 'z' ? w : d // across the slope
  const blocks = []

  for (let level = 0; level * 2 < span; level++) {
    const near = level
    const far = span - 1 - level
    for (const across of far === near ? [near] : [near, far]) {
      // Each slope climbs toward the ridge, so the two sides face opposite ways.
      const toward = across === near ? 1 : -1
      const name = axis === 'z'
        ? orientStairs(material, toward, 0)
        : orientStairs(material, 0, toward)
      for (let along = 0; along < run; along++) {
        const pos = axis === 'z'
          ? new Vec3(across, y + level, along)
          : new Vec3(along, y + level, across)
        blocks.push({ pos, name })
      }
    }
  }

  return blocks
}

// The OPENING under an arch - a rectangle topped by a semicircle, extruded
// `depth` blocks along `axis`.
//
// Its best use is carving: pass material 'air' and it cuts an arched doorway,
// window or tunnel straight through a wall you already built. Passing a solid
// block instead casts the same volume in stone, which is occasionally what you
// want for a freestanding arch.
function arch ({ width, height, depth = 1, material, axis = 'x', y = 0 }) {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const thickness = Math.max(1, Math.floor(depth))
  const r = Math.floor((w - 1) / 2)
  const centre = r
  const straight = Math.max(0, h - r - 1)
  const blocks = []

  for (let level = 0; level < h; level++) {
    let half
    if (level < straight) {
      half = r
    } else {
      const dy = level - straight
      const inner = r * r - dy * dy
      if (inner < 0) continue
      half = Math.floor(Math.sqrt(inner))
    }
    for (let across = centre - half; across <= centre + half; across++) {
      for (let along = 0; along < thickness; along++) {
        const pos = axis === 'z'
          ? new Vec3(across, y + level, along)
          : new Vec3(along, y + level, across)
        blocks.push({ pos, name: material })
      }
    }
  }

  return blocks
}

// The ordered ring of cells at radius r, going anticlockwise. Consecutive
// entries are neighbours (orthogonally or diagonally), which is what makes it
// usable as a path rather than just a set.
function ringCells (r) {
  const limit = circleLimit(r)
  const inside = (a, b) => (a * a + b * b) <= limit
  const cells = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (!inside(dx, dz)) continue
      if (inside(dx + 1, dz) && inside(dx - 1, dz) && inside(dx, dz + 1) && inside(dx, dz - 1)) continue
      cells.push({ dx, dz, angle: Math.atan2(dz, dx) })
    }
  }
  return cells.sort((a, b) => a.angle - b.angle)
}

// The ring walked as a PATH: a closed loop of single cells where every step
// changes exactly one coordinate by one.
//
// A rasterised circle's perimeter contains diagonal steps, and a diagonal step
// up cannot be walked in Minecraft without jumping, so each diagonal is split
// by a bridging cell. There are always two candidates and they always differ,
// which is what makes the repair below possible.
//
// THE LOOP IS CYCLIC, SO THE REPAIR HAS TO BE. Choosing each bridge greedily
// against the cells already placed leaves exactly one bad seam per loop - the
// wrap-around, where the first bridge is chosen before there is any preceding
// context to compare against. At a cardinal extreme of the circle the diagonal
// entering and the diagonal leaving both want the same inner bridge, walking
// A -> B -> A: two levels later the staircase is directly above itself and a
// climber hits their head. So bridges are placed by preference first, then
// repaired against the closed loop, where index -2 and +2 both exist.
function ringPath (r) {
  const ring = ringCells(r)
  const n = ring.length
  const path = []

  for (let i = 0; i < n; i++) {
    const cur = ring[i]
    const prev = ring[(i - 1 + n) % n]
    const dx = cur.dx - prev.dx
    const dz = cur.dz - prev.dz

    if (dx !== 0 && dz !== 0) {
      const rad = c => c.dx * c.dx + c.dz * c.dz
      // Prefer the inner candidate so a tread never pushes into the tower wall;
      // keep the outer one as the escape route for the repair pass.
      const [near, far] = [{ dx: cur.dx, dz: prev.dz }, { dx: prev.dx, dz: cur.dz }]
        .sort((a, b) => rad(a) - rad(b))
      path.push({ ...near, alt: far })
    }
    path.push({ dx: cur.dx, dz: cur.dz })
  }

  const len = path.length
  const same = (a, b) => Boolean(a) && Boolean(b) && a.dx === b.dx && a.dz === b.dz
  const at = i => path[(i % len + len) % len]

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < len; i++) {
      const node = path[i]
      if (!node.alt) continue // a ring cell is fixed; only bridges can move
      if (!same(node, at(i - 2)) && !same(node, at(i + 2))) continue

      // Both candidates are orthogonally adjacent to both neighbours, so
      // swapping never breaks the walk - it only has to not create a new clash.
      const swapped = { dx: node.alt.dx, dz: node.alt.dz, alt: { dx: node.dx, dz: node.dz } }
      const clashes = [at(i - 2), at(i - 1), at(i + 1), at(i + 2)].some(c => same(swapped, c))
      if (!clashes) path[i] = swapped
    }
  }

  return path.map(({ dx, dz }) => ({ dx, dz }))
}

// A helical staircase winding up the inside of a tower.
//
// Built around three things a bare helix does not have: a central column to
// wind about, treads wide enough to be a stair rather than a tightrope, and a
// railing on the open side.
//
// THE OUTER CELL STILL WALKS A RING, ONE PER LEVEL. That is not decoration of
// the algorithm, it is what makes the stair climbable, and it survived two
// rewrites to get here. Sampling an angle per level and emitting a radial run
// puts consecutive treads on the SAME cells at radius 3 - stairs stacked on
// each other, no headroom, unclimbable. So the outer cell comes from the ring
// path (distinct by construction, orthogonal steps, one arrival direction to
// face) and the wedge is filled inward from it.
//
// Inner wedge cells are dropped where they would land on the two levels below,
// because that is exactly the stacking the ring path exists to prevent - a
// wide tread is worth having, but not at the cost of headroom.
//
// `isFree` lets the renderer answer "is there a wall here already", which the
// railing needs and a pure function cannot know. Without it the railing is
// placed into the tower wall it is supposed to stand clear of.
function spiral ({
  radius, height, material, clearance = true, y = 0,
  railing = null, risePerTread = 1, isFree = null,
  column = null, slab = null
}) {
  const r = Math.max(1, Math.floor(radius))
  const rise = Math.max(1, Math.floor(height))
  const half = risePerTread === 0.5
  const steps = half ? rise * 2 : rise
  const path = ringPath(r)
  const n = path.length
  const orientable = /_stairs$/.test(baseName(material)) && !hasState(material)
  // Family members are resolved against the server registry in validatePlan,
  // because deriving them by string surgery here produced "stone_brick" - not a
  // block - for the column of a stone_brick_stairs spiral.
  // validatePlan resolves these against the server registry and always passes
  // them; the fallbacks only apply to direct calls, and a stairs id used as a
  // column is a visible sign that a caller skipped that resolution.
  const stepSlab = slab || material
  const post = column || material

  // Only decorate an actual, unstated slab id with [type=...]. Appending it to
  // whatever was passed produced oak_stairs[facing=west][type=top] and
  // stone[type=top] - strings that are not blocks. Without a usable slab the
  // wedge is simply solid, which is what an inner tread is anyway.
  const usableSlab = /_slab$/.test(baseName(stepSlab)) && !hasState(stepSlab)
  const innerName = usableSlab ? `${stepSlab}[type=top]` : post

  // A column you can wind around: one cell in a narrow shaft, 2x2 once there
  // is room for it.
  const columnCells = r <= 3 ? [{ dx: 0, dz: 0 }] : [{ dx: 0, dz: 0 }, { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 1, dz: 1 }]
  const inColumn = (dx, dz) => columnCells.some(c => c.dx === dx && c.dz === dz)

  const treads = []
  const clear = []
  const rails = []
  const usedAt = new Map() // "dx,dz" -> [levels it is already a tread on]

  const columnTop = half ? Math.ceil(steps / 2) : steps
  for (let level = 0; level < columnTop; level++) {
    for (const c of columnCells) {
      treads.push({ pos: new Vec3(c.dx + r, y + level, c.dz + r), name: post })
    }
  }

  for (let step = 0; step < steps; step++) {
    const level = half ? Math.floor(step / 2) : step
    const cell = path[step % n]
    const prev = path[(step % n - 1 + n) % n]
    const dx = cell.dx - prev.dx
    const dz = cell.dz - prev.dz
    const facing = dx !== 0 ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')

    // The outer cell is the step you actually climb.
    const outerName = half && usableSlab
      ? `${stepSlab}[type=${step % 2 === 0 ? 'bottom' : 'top'}]`
      : (orientable ? withState(material, `facing=${facing},half=bottom`) : material)
    const wedge = [{ dx: cell.dx, dz: cell.dz, name: outerName }]

    // Fill inward toward the column, skipping anything that would stack.
    const stepsIn = Math.max(Math.abs(cell.dx), Math.abs(cell.dz))
    for (let t = 1; t < stepsIn; t++) {
      const f = t / stepsIn
      const ix = Math.round(cell.dx * (1 - f))
      const iz = Math.round(cell.dz * (1 - f))
      if (inColumn(ix, iz)) continue
      if (wedge.some(w => w.dx === ix && w.dz === iz)) continue
      const seen = usedAt.get(`${ix},${iz}`) || []
      if (seen.some(l => l >= level - 2 && l < level)) continue
      wedge.push({ dx: ix, dz: iz, name: innerName })
    }

    for (const w of wedge) {
      treads.push({ pos: new Vec3(w.dx + r, y + level, w.dz + r), name: w.name })
      const seen = usedAt.get(`${w.dx},${w.dz}`) || []
      seen.push(level)
      usedAt.set(`${w.dx},${w.dz}`, seen)
      if (clearance) {
        for (let h = 1; h <= 3; h++) {
          clear.push({ pos: new Vec3(w.dx + r, y + level + h, w.dz + r), name: 'air' })
        }
      }
    }

    // A railing on the open side, where there is not already a wall there.
    if (railing) {
      const outward = { dx: Math.sign(cell.dx), dz: Math.sign(cell.dz) }
      const rx = cell.dx + outward.dx
      const rz = cell.dz + outward.dz
      const pos = new Vec3(rx + r, y + level + 1, rz + r)
      if (!isFree || isFree(pos)) rails.push({ pos, name: railing })
    }
  }

  return clear.concat(treads, rails)
}

// ---------------------------------------------------------------------------
// A straight flight of stairs that looks built.
//
// The recipe, from three reference builds: treads facing the direction of
// ascent; a solid mass under every tread so nothing floats; a stringer up each
// open side, one block PROUD of the tread beside it; taller posts at both ends
// carrying the lights; landings every few steps on a long flight.
//
// The failure this replaces was a bare helix of full blocks hanging in the air
// with no mass under it, no stringer and no lights - every line of the recipe
// missed at once, because the model was placing individual cells by hand.
//
// LANDINGS SIT FLUSH WITH THE TREAD THEY FOLLOW, not one above it. A tread is a
// stair block whose walkable top is one above its own level, so a landing at
// the same level meets it exactly; putting the landing a level higher would add
// a block of climb per landing, and then `rise` would no longer be the height
// the flight gains. The prompt promises `rise` is exactly the floor-to-floor
// difference, so the geometry has to keep that true.
// ---------------------------------------------------------------------------
const STAIR_HEADROOM = 3

function persistentLeaves (name) {
  return /_leaves$/.test(baseName(name)) && !hasState(name)
    ? withState(name, 'persistent=true')
    : name
}

function stairs ({
  axis = 'x', ascent = '+', width = 3, rise = 9,
  tread, fill, stringer = null, sides = 'both',
  postHeight = 3, lights = 'torch', lightEvery = 4,
  landingEvery = 0, turn = 'none', flare = 0,
  stringerPattern = null, y = 0
}) {
  const w = Math.max(1, Math.floor(width))
  const steps = Math.max(2, Math.floor(rise))
  const flareBy = Math.max(0, Math.min(2, Math.floor(flare)))
  const fillName = fill || tread
  const clear = []
  const solid = []

  // Work in a local frame so a turn is a change of basis rather than four
  // copies of the same loop.
  let run = axis === 'z' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0)
  if (ascent === '-') run = run.scaled(-1)
  let across = axis === 'z' ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1)
  let base = new Vec3(0, 0, 0)

  const put = (cell, level, name) => solid.push({ pos: new Vec3(cell.x, y + level, cell.z), name })
  const open = (cell, level) => {
    for (let h = 1; h <= STAIR_HEADROOM; h++) {
      clear.push({ pos: new Vec3(cell.x, y + level + h, cell.z), name: 'air' })
    }
  }
  const column = (cell, level, name) => {
    for (let below = 0; below < level; below++) put(cell, below, name)
  }
  const lightName = lights === 'lantern' ? 'lantern[hanging=false]' : (lights === 'none' ? null : 'torch')

  let step = 0
  let inFlight = 0

  while (step < steps) {
    const level = step
    const treadName = withState(tread, `facing=${ascentFacing(run.x, run.z)},half=bottom`)
    const spread = step < flareBy ? 1 : 0
    const lo = -spread
    const hi = w - 1 + spread
    const rail = stringerPattern && stringerPattern.length
      ? stringerPattern[step % stringerPattern.length]
      : stringer

    for (let a = lo; a <= hi; a++) {
      const cell = base.plus(run.scaled(inFlight)).plus(across.scaled(a))
      open(cell, level)
      put(cell, level, treadName)
      column(cell, level, fillName)
    }

    if (rail) {
      const railName = /_stairs$/.test(baseName(rail)) && !hasState(rail)
        ? withState(rail, `facing=${ascentFacing(run.x, run.z)},half=bottom`)
        : persistentLeaves(rail)
      const wanted = sides === 'none' ? [] : sides === 'left' ? [lo - 1] : sides === 'right' ? [hi + 1] : [lo - 1, hi + 1]

      for (const a of wanted) {
        const cell = base.plus(run.scaled(inFlight)).plus(across.scaled(a))
        put(cell, level, railName)
        put(cell, level + 1, railName) // always one above the tread beside it
        column(cell, level, railName)

        const isEnd = step === 0 || step === steps - 1
        if (isEnd && postHeight > 1) {
          for (let h = 2; h <= postHeight; h++) put(cell, level + h, railName)
          if (lightName) put(cell, level + postHeight + 1, lightName)
        } else if (lightName && lightEvery > 0 && step > 0 && step % lightEvery === 0) {
          put(cell, level + 2, lightName)
        }
      }
    }

    step++
    inFlight++

    if (landingEvery > 0 && step % landingEvery === 0 && step < steps) {
      const landingLevel = step - 1 // flush with the tread just climbed
      for (let r = 0; r < w; r++) {
        for (let a = 0; a < w; a++) {
          const cell = base.plus(run.scaled(inFlight + r)).plus(across.scaled(a))
          open(cell, landingLevel)
          put(cell, landingLevel, fillName)
          column(cell, landingLevel, fillName)
        }
      }

      // Re-base the frame past the landing; a turn swaps the axes.
      if (turn === 'right') {
        const nextBase = base.plus(run.scaled(inFlight + w - 1)).plus(across.scaled(w))
        const nextRun = across
        across = run.scaled(-1)
        run = nextRun
        base = nextBase
      } else if (turn === 'left') {
        const nextBase = base.plus(run.scaled(inFlight)).plus(across.scaled(-1))
        const nextRun = across.scaled(-1)
        across = run
        run = nextRun
        base = nextBase
      } else {
        base = base.plus(run.scaled(inFlight + w))
      }
      inFlight = 0
    }
  }

  // Clearance first so the treads and rails win wherever they meet it.
  return clear.concat(solid)
}


// ---------------------------------------------------------------------------
// Wall-relative openings.
//
// A window is named by the face it sits in and how far along that face it is,
// not by a coordinate the model had to work out. Give it the building's
// footprint and it finds the wall itself; give it neither and the offset is
// taken as the opening's own lower corner.
//
// It carves only as deep as the wall actually is - walked outward from the
// wall plane while `isSolid` says there is still wall - so a window in a
// one-thick wall does not bore a tunnel into the room behind it. That was the
// failure mode when openings were plain `air` boxes: a three-deep window carve
// reached past the wall and ate four treads off the staircase inside.
// ---------------------------------------------------------------------------

const FACES = {
  north: { normal: new Vec3(0, 0, -1), along: 'x' },
  south: { normal: new Vec3(0, 0, 1), along: 'x' },
  east: { normal: new Vec3(1, 0, 0), along: 'z' },
  west: { normal: new Vec3(-1, 0, 0), along: 'z' }
}

// Where the opening's lower corner sits, in the shape's own coordinates.
function openingCorner ({ face, along = 0, y = 0, footprint }) {
  const f = FACES[face] || FACES.north
  if (!footprint) return { start: new Vec3(0, y, 0), f }
  const w = Math.max(1, Math.floor(footprint.width || 1))
  const d = Math.max(1, Math.floor(footprint.depth || 1))
  const a = Math.floor(along)
  const start = face === 'north' ? new Vec3(a, y, 0)
    : face === 'south' ? new Vec3(a, y, d - 1)
      : face === 'east' ? new Vec3(w - 1, y, a)
        : new Vec3(0, y, a)
  return { start, f }
}

// How thick is the wall here? Walk inward from the outer plane while solid,
// capped so a window never becomes a tunnel through a solid mass.
const MAX_WALL_THICKNESS = 4

function wallThickness (start, normal, isSolid) {
  if (!isSolid) return 1
  let n = 0
  for (let t = 0; t < MAX_WALL_THICKNESS; t++) {
    const probe = start.plus(normal.scaled(-t))
    if (!isSolid(probe)) break
    n++
  }
  return Math.max(1, n)
}

// The cells of an opening's face, honouring its style.
function openingShape (width, height, style) {
  const cells = []
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const r = Math.floor((w - 1) / 2)
  const straight = style === 'arched' ? Math.max(1, h - r) : h

  for (let level = 0; level < h; level++) {
    let lo = 0
    let hi = w - 1
    if (style === 'arched' && level >= straight) {
      const dy = level - straight + 1
      const inner = r * r - dy * dy
      if (inner < 0) continue
      const half = Math.floor(Math.sqrt(inner))
      lo = r - half
      hi = r + half
    }
    for (let a = lo; a <= hi; a++) {
      // A mullion is a single column of wall left standing down the middle.
      if (style === 'mullion' && w >= 3 && a === r && level < h - 1) continue
      cells.push({ a, level })
    }
  }
  return cells
}

function placeOnFace (start, f, a, level, depth) {
  const out = []
  for (let t = 0; t < depth; t++) {
    const base = start.plus(f.normal.scaled(-t)).offset(0, level, 0)
    out.push(f.along === 'x' ? base.offset(a, 0, 0) : base.offset(0, 0, a))
  }
  return out
}

// window: carve the opening, glaze it, frame it, sill below, lintel above.
function window ({
  face = 'north', along = 0, width = 2, height = 3, style = 'plain',
  frame = null, glass = 'glass_pane', mullion = null,
  footprint = null, sill = null, lintel = null, isSolid = null, y = 0
}) {
  const { start, f } = openingCorner({ face, along, y, footprint })
  const depth = wallThickness(start, f.normal, isSolid)
  const shape = openingShape(width, height, style)
  const carved = []
  const solid = []

  for (const { a, level } of shape) {
    for (const pos of placeOnFace(start, f, a, level, depth)) carved.push({ pos, name: 'air' })
  }
  // Glazing goes in the outer plane only; the rest of the reveal stays open.
  for (const { a, level } of shape) {
    if (glass) solid.push({ pos: placeOnFace(start, f, a, level, 1)[0], name: glass })
  }

  if (frame) {
    const inShape = (a, level) => shape.some(c => c.a === a && c.level === level)
    for (let a = -1; a <= width; a++) {
      for (let level = -1; level <= height; level++) {
        if (inShape(a, level)) continue
        if (a < -1 || a > width) continue
        const ring = a === -1 || a === width || level === -1 || level === height ||
          !inShape(a, level)
        if (!ring) continue
        for (const pos of placeOnFace(start, f, a, level, depth)) solid.push({ pos, name: frame })
      }
    }
  }

  const outward = f.normal
  if (sill) {
    for (let a = 0; a < width; a++) {
      const base = placeOnFace(start, f, a, -1, 1)[0].plus(outward)
      solid.push({ pos: base, name: sill })
    }
  }
  if (lintel) {
    for (let a = 0; a < width; a++) {
      const base = placeOnFace(start, f, a, height, 1)[0].plus(outward)
      solid.push({ pos: base, name: lintel })
    }
  }

  return carved.concat(solid)
}

// door: the same carve, reaching the ground, with real door blocks and a lintel.
function door ({
  face = 'north', along = 0, width = 1, height = 3, arched = false,
  doorBlock = null, frame = null, lintel = null,
  footprint = null, isSolid = null, y = 0
}) {
  const { start, f } = openingCorner({ face, along, y, footprint })
  const depth = wallThickness(start, f.normal, isSolid)
  const w = Math.max(1, Math.min(2, Math.floor(width)))
  const h = Math.max(2, Math.floor(height))
  const shape = openingShape(w, h, arched ? 'arched' : 'plain')
  const carved = []
  const solid = []

  for (const { a, level } of shape) {
    for (const pos of placeOnFace(start, f, a, level, depth)) carved.push({ pos, name: 'air' })
  }

  if (frame) {
    for (let a = -1; a <= w; a++) {
      for (let level = -1; level <= h; level++) {
        const inShape = shape.some(c => c.a === a && c.level === level)
        if (inShape) continue
        if (level < -1) continue
        for (const pos of placeOnFace(start, f, a, level, depth)) solid.push({ pos, name: frame })
      }
    }
  }

  // Real doors: two halves, hinged outward from the middle of a double door.
  if (doorBlock) {
    const facing = face
    for (let a = 0; a < w; a++) {
      const hinge = w === 2 ? (a === 0 ? 'left' : 'right') : 'left'
      const column = placeOnFace(start, f, a, 0, 1)[0]
      solid.push({ pos: column, name: `${doorBlock}[facing=${facing},half=lower,hinge=${hinge}]` })
      solid.push({ pos: column.offset(0, 1, 0), name: `${doorBlock}[facing=${facing},half=upper,hinge=${hinge}]` })
    }
  }

  if (lintel) {
    for (let a = -1; a <= w; a++) {
      for (const pos of placeOnFace(start, f, a, h, depth)) solid.push({ pos, name: lintel })
    }
  }

  return carved.concat(solid)
}



// ---------------------------------------------------------------------------
// Architectural primitives.
//
// Everything here works from a FOOTPRINT - a width by depth rectangle, or a
// radius for the round forms - and computes its own block states. The model
// says "eaves around this building at this height"; it never writes a facing.
//
// These exist because the model spent most of its actions, and made most of its
// mistakes, hand-placing exactly these things out of `blocks` cells.
// ---------------------------------------------------------------------------

// The perimeter cells of a footprint, each with the direction that faces out.
function perimeter (width, depth, { grow = 0 } = {}) {
  const w = Math.max(1, Math.floor(width))
  const d = Math.max(1, Math.floor(depth))
  const lo = -grow
  const hiX = w - 1 + grow
  const hiZ = d - 1 + grow
  const out = []
  for (let x = lo; x <= hiX; x++) {
    for (let z = lo; z <= hiZ; z++) {
      const edgeX = x === lo || x === hiX
      const edgeZ = z === lo || z === hiZ
      if (!edgeX && !edgeZ) continue
      const normals = []
      if (x === lo) normals.push('west')
      if (x === hiX) normals.push('east')
      if (z === lo) normals.push('north')
      if (z === hiZ) normals.push('south')
      out.push({ x, z, normals, corner: edgeX && edgeZ })
    }
  }
  return out
}

const OUTWARD = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) }

// A cornice: upside-down stairs one block proud of the footprint, facing out.
// Corners get a stair on the diagonal too, or the ring has a notch in it.
function eaves ({ width, depth, material, y = 0, proud = 1 }) {
  const blocks = []
  for (const cell of perimeter(width, depth, { grow: proud })) {
    for (const dir of cell.normals) {
      const at = new Vec3(cell.x, y, cell.z)
      blocks.push({ pos: at, name: orientStairs(material, OUTWARD[dir].x, OUTWARD[dir].z, 'top') })
      break
    }
  }
  return blocks
}

// One course of contrasting stone around a footprint.
function trimBand ({ width, depth, material, y = 0, proud = 0 }) {
  return perimeter(width, depth, { grow: proud })
    .map(cell => ({ pos: new Vec3(cell.x, y, cell.z), name: material }))
}

// Merlons on alternating cells, with an optional walkway course below them.
function battlements ({ width, depth, material, y = 0, height = 2, cap = null, proud = 0 }) {
  const blocks = []
  const h = Math.max(1, Math.floor(height))
  for (const cell of perimeter(width, depth, { grow: proud })) {
    // Alternate around the ring; corners always get a merlon so the silhouette
    // reads as crenellated rather than accidentally gapped.
    const solid = cell.corner || ((cell.x + cell.z) % 2 === 0)
    if (!solid) continue
    for (let level = 0; level < h; level++) {
      blocks.push({ pos: new Vec3(cell.x, y + level, cell.z), name: material })
    }
    if (cap) blocks.push({ pos: new Vec3(cell.x, y + h, cell.z), name: cap })
  }
  return blocks
}

// A column standing proud of one face, stepping back with stairs near the top.
function pilaster ({ face = 'north', along = 0, width = 1, height = 6, material, footprint = null, y = 0, buttress = false, stairs = null }) {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const { start, f } = openingCorner({ face, along, y, footprint })
  const out = new Vec3(OUTWARD[face].x, 0, OUTWARD[face].z)
  const blocks = []

  // A buttress leans in as it rises; a pilaster is a straight strip.
  const stepAt = buttress ? Math.max(1, Math.floor(h * 0.6)) : h

  for (let level = 0; level < h; level++) {
    const depth = buttress && level >= stepAt ? 0 : 1
    for (let a = 0; a < w; a++) {
      const base = f.along === 'x' ? start.offset(a, level, 0) : start.offset(0, level, a)
      for (let t = 1; t <= Math.max(1, depth); t++) {
        blocks.push({ pos: base.plus(out.scaled(t)), name: material })
      }
    }
  }

  // The set-back is dressed with stairs so the step reads as deliberate.
  if (buttress && stairs) {
    for (let a = 0; a < w; a++) {
      const base = f.along === 'x' ? start.offset(a, stepAt, 0) : start.offset(0, stepAt, a)
      blocks.push({ pos: base.plus(out.scaled(2)), name: orientStairs(stairs, -out.x, -out.z, 'bottom') })
    }
  }
  return blocks
}

// A base course wider than the building it carries.
function plinth ({ width, depth, material, height = 1, grow = 1, y = 0, depthBelow = 0 }) {
  const blocks = []
  const h = Math.max(1, Math.floor(height))
  const w = Math.max(1, Math.floor(width)) + grow * 2
  const d = Math.max(1, Math.floor(depth)) + grow * 2
  for (let level = -Math.max(0, Math.floor(depthBelow)); level < h; level++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        blocks.push({ pos: new Vec3(x - grow, y + level, z - grow), name: material })
      }
    }
  }
  return blocks
}

// A pillar. Logs get their axis set from the direction they run.
function column ({ height = 4, material, axis = 'y', y = 0 }) {
  const h = Math.max(1, Math.floor(height))
  const name = /_log$|_stem$|_wood$/.test(baseName(material)) && !hasState(material)
    ? withState(material, `axis=${axis}`)
    : material
  const blocks = []
  for (let i = 0; i < h; i++) {
    const pos = axis === 'x' ? new Vec3(i, y, 0) : axis === 'z' ? new Vec3(0, y, i) : new Vec3(0, y + i, 0)
    blocks.push({ pos, name })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// One roof op for every roof shape.
//
// gable and hip are the rectangular pair; cone is the round one; mansard,
// pagoda and onion are the stacked forms. All of them overhang by default,
// because a roof flush with its walls is the single clearest sign that
// something was generated rather than built.
// ---------------------------------------------------------------------------
function roof ({
  kind = 'gable', width = 9, depth = 9, height = null, material,
  overhang = 1, gableFill = null, ridge = null, radius = null, axis = 'x', y = 0
}) {
  const over = Math.max(0, Math.floor(overhang))
  const w = Math.max(1, Math.floor(width)) + over * 2
  const d = Math.max(1, Math.floor(depth)) + over * 2
  const shift = -over
  const blocks = []
  const at = (list) => list.map(b => ({ pos: b.pos.offset(shift, 0, shift), name: b.name }))

  if (kind === 'cone') {
    const r = radius !== null ? Math.floor(radius) + over : Math.floor(Math.max(w, d) / 2)
    const h = height !== null ? Math.floor(height) : r * 2
    return cone({ radius: r, height: h, material, hollow: true, y })
      .map(b => ({ pos: b.pos.offset(-over, 0, -over), name: b.name }))
  }

  if (kind === 'hip') {
    const h = height !== null ? Math.floor(height) : Math.ceil(Math.min(w, d) / 2)
    return at(pyramid({ width: w, depth: d, height: h, material, hollow: true, y }))
  }

  if (kind === 'mansard' || kind === 'pagoda' || kind === 'onion') {
    // Stacked tiers: each narrower than the last, with its own eaves flare.
    const tiers = kind === 'pagoda' ? 3 : 2
    const perTier = height !== null ? Math.max(1, Math.floor(height / tiers)) : 3
    let tw = w
    let td = d
    let level = y
    for (let t = 0; t < tiers; t++) {
      const steep = kind === 'mansard' ? t === 0 : true
      const tierHeight = steep ? perTier : Math.max(1, Math.ceil(perTier / 2))
      blocks.push(...at(pyramid({ width: tw, depth: td, height: tierHeight, material, hollow: true, y: level })))
      if (kind === 'pagoda' && t < tiers - 1) {
        // The flared eaves that make a pagoda a pagoda.
        blocks.push(...at(eaves({ width: tw, depth: td, material, y: level, proud: 1 })))
      }
      level += tierHeight
      tw = Math.max(1, tw - 2)
      td = Math.max(1, td - 2)
    }
    return blocks
  }

  // gable
  const h = height !== null ? Math.floor(height) : Math.ceil((axis === 'z' ? w : d) / 2)
  const slopes = at(gable({ width: w, depth: d, material, axis, y }))
  blocks.push(...slopes)

  // Fill the triangular ends, or the roof is two flying planes.
  if (gableFill) {
    const span = axis === 'z' ? w : d
    const run = axis === 'z' ? d : w
    for (let level = 0; level * 2 < span; level++) {
      const near = level
      const far = span - 1 - level
      for (const end of [0, run - 1]) {
        for (let across = near; across <= far; across++) {
          const pos = axis === 'z'
            ? new Vec3(across + shift, y + level, end + shift)
            : new Vec3(end + shift, y + level, across + shift)
          blocks.push({ pos, name: gableFill })
        }
      }
    }
  }

  if (ridge) {
    const top = Math.max(...slopes.map(b => b.pos.y))
    for (const b of slopes.filter(b => b.pos.y === top)) {
      blocks.push({ pos: b.pos.offset(0, 1, 0), name: ridge })
    }
  }

  return blocks
}


module.exports = { floor, wall, box, sphere, house, cylinder, cone, pyramid, gable, arch, spiral, stairs, window, door, eaves, trimBand, battlements, pilaster, plinth, column, roof, openingShape, perimeter, outsideIn, circleLimit, ascentFacing }
