'use strict'

const { Vec3 } = require('vec3')
const { baseName, hasState, withState } = require('./blockspec')
const { MAX_BLOCKS } = require('../config')
const { decorate } = require('./decorate')
const paletteLib = require('./palette')

// ---------------------------------------------------------------------------
// Plan -> cells.
//
// This is where a plan stops being a list of shapes and becomes the exact set
// of blocks that will be filled. Three jobs, in order:
//
//   1. RENDER. Expand each action through primitives.js, apply its offset and
//      anchor, and resolve overlaps - later writes win, as they always did.
//   2. PROTECT AND LINT. Remember which action wrote each cell. A cell carved
//      to air is protected: a later BULK shape may not fill it back in. This is
//      the failure that produced a castle with no entrance and a tower whose
//      stairs had holes in them, and it is invisible at build time because
//      every block still reports placed successfully.
//   3. ORIENT. Any directional block left at its default state gets one
//      computed from its neighbours - panes and bars connect, wall torches face
//      away from what they hang on, lanterns hang when there is a ceiling.
//
// Precise ops (`blocks`, `spiral`) are exempt from protection. They place
// individual, deliberate cells - furniture in a carved room, a staircase up a
// carved shaft - and blocking those would break the thing protection exists to
// enable. Only bulk shapes get stopped.
// ---------------------------------------------------------------------------

// A stair and a spiral are deliberate structures, not bulk shapes: they belong
// inside carved space, so protection must not stop them.
const PRECISE_OPS = new Set(['blocks', 'spiral', 'stairs'])

// Blocks that cannot seal anything, and so are never what protection is for.
//
// Protection exists to stop a WALL closing a doorway. It was written as "any
// solid write into a carved cell", which is wrong for two things people
// legitimately put inside an opening: fluids and things you can see or walk
// through. An iron farm asked for five water channels, carved them, flooded
// them from `details` - and every drop was dropped as if it were masonry. The
// farm came out with a killing floor, hoppers, chests, beds, and no water at
// all, while reporting 1944 placed and 0 failed.
const NON_SEALING = new Set([
  'water', 'lava',
  'glass_pane', 'iron_bars', 'chain', 'ladder', 'vine', 'scaffolding',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch',
  'lantern', 'soul_lantern', 'rail', 'powered_rail', 'detector_rail',
  'redstone_wire', 'tripwire', 'string', 'snow', 'light'
])

const sealsOpening = name => {
  const b = baseName(name)
  return !NON_SEALING.has(b) && !/_pane$/.test(b) && !/_rail$/.test(b) &&
    !/_torch$/.test(b) && !/_button$/.test(b) && !/_pressure_plate$/.test(b)
}

// Blocks that do not fill their cell, for the purpose of "is my neighbour
// something I can attach to".
const NON_SOLID = new Set([
  'air', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch',
  'lantern', 'soul_lantern', 'chain', 'ladder', 'vine', 'water', 'lava',
  'glass_pane', 'iron_bars', 'white_stained_glass_pane', 'gray_stained_glass_pane'
])

const SIDES = [
  { key: 'north', d: new Vec3(0, 0, -1) },
  { key: 'south', d: new Vec3(0, 0, 1) },
  { key: 'east', d: new Vec3(1, 0, 0) },
  { key: 'west', d: new Vec3(-1, 0, 0) }
]

const key = (x, y, z) => `${x},${y},${z}`

// Ops whose offset names a centre rather than a corner when anchor is 'center'.
// Round shapes span (2r+1); rectangular ones span their width and depth.
function anchorShift (action) {
  if (action.anchor !== 'center') return { x: 0, z: 0 }
  if (action.radius !== undefined) return { x: -action.radius, z: -action.radius }
  const w = action.width || action.length || 1
  const d = action.depth || action.length || 1
  return { x: -Math.floor((w - 1) / 2), z: -Math.floor((d - 1) / 2) }
}

function shapeFor (action, primitives, ctx) {
  switch (action.op) {
    case 'floor': return primitives.floor({ width: action.width, depth: action.depth, material: action.material })
    case 'wall': return primitives.wall({ length: action.length, height: action.height, material: action.material, axis: action.axis })
    case 'box': return primitives.box({ width: action.width, depth: action.depth, height: action.height, material: action.material, hollow: action.hollow })
    case 'sphere': return primitives.sphere({ radius: action.radius, material: action.material, hollow: action.hollow })
    case 'house': return primitives.house({
      width: action.width,
      depth: action.depth,
      height: action.height,
      wallBlock: action.material,
      floorBlock: action.material,
      roofBlock: action.material
    })
    case 'cylinder': return primitives.cylinder({ radius: action.radius, height: action.height, material: action.material, hollow: action.hollow, axis: action.axis })
    case 'cone': return primitives.cone({ radius: action.radius, height: action.height, material: action.material, hollow: action.hollow })
    case 'pyramid': return primitives.pyramid({ width: action.width, depth: action.depth, height: action.height, material: action.material, hollow: action.hollow })
    case 'gable': return primitives.gable({ width: action.width, depth: action.depth, material: action.material, axis: action.axis })
    case 'arch': return primitives.arch({ width: action.width, height: action.height, depth: action.depth, material: action.material, axis: action.axis })
    case 'spiral': return primitives.spiral({
      radius: action.radius,
      height: action.height,
      material: action.material,
      column: action.column,
      slab: action.slab,
      railing: action.railing,
      risePerTread: action.risePerTread,
      isFree: ctx && ctx.isFree
    })
    case 'stairs': return primitives.stairs({
      axis: action.axis,
      ascent: action.ascent,
      width: action.width,
      rise: action.rise,
      tread: action.tread,
      fill: action.fill,
      stringer: action.stringer,
      sides: action.sides,
      postHeight: action.postHeight,
      lights: action.lights,
      lightEvery: action.lightEvery,
      landingEvery: action.landingEvery,
      turn: action.turn,
      flare: action.flare,
      stringerPattern: action.stringerPattern
    })
    case 'eaves': return primitives.eaves({ width: action.width, depth: action.depth, material: action.material, proud: action.proud })
    case 'trim_band': return primitives.trimBand({ width: action.width, depth: action.depth, material: action.material, proud: action.proud })
    case 'battlements': return primitives.battlements({ width: action.width, depth: action.depth, material: action.material, height: action.height, cap: action.cap, proud: action.proud })
    case 'pilaster':
    case 'buttress': return primitives.pilaster({
      face: action.face, along: action.along, width: action.width, height: action.height,
      material: action.material, footprint: action.footprint,
      buttress: action.op === 'buttress', stairs: action.stairs
    })
    case 'plinth': return primitives.plinth({ width: action.width, depth: action.depth, material: action.material, height: action.height, grow: action.grow })
    case 'column': return primitives.column({ height: action.height, material: action.material, axis: action.axis })
    case 'roof': return primitives.roof({
      kind: action.kind, width: action.width, depth: action.depth, height: action.height,
      material: action.material, overhang: action.overhang, gableFill: action.gableFill,
      ridge: action.ridge, radius: action.radius, axis: action.axis
    })
    case 'window': return primitives.window({
      face: action.face, along: action.along, width: action.width, height: action.height,
      style: action.style, frame: action.frame, glass: action.glass, sill: action.sill,
      lintel: action.lintel, footprint: action.footprint, isSolid: ctx && ctx.isSolid
    })
    case 'door': return primitives.door({
      face: action.face, along: action.along, width: action.width, height: action.height,
      arched: action.arched, doorBlock: action.doorBlock, frame: action.frame,
      lintel: action.lintel, footprint: action.footprint, isSolid: ctx && ctx.isSolid
    })
    case 'blocks': return action.cells.map(c => ({ pos: new Vec3(c.x, c.y, c.z), name: c.material }))
    default: return []
  }
}

// How much of an earlier action one later action may bury before it looks like
// a mistake rather than a detail. A trim band replacing a course of wall is a
// few percent; a wall re-emitted over its own doorway is most of it.
const CLOBBER_RATIO = 0.3
const CLOBBER_MIN_CELLS = 8

// Ops small and deliberate enough that an overlap is untidy rather than wrong.
const SOFT_CLOBBER_OPS = new Set(['window', 'door', 'blocks', 'stairs', 'spiral', 'column', 'pilaster', 'buttress'])

function renderPlan (plan, primitives, opts = {}) {
  const isKnownBlock = opts.isKnownBlock || (() => true)
  const cells = new Map() // key -> { name, pos, action, order }
  const carvedBy = new Map() // key -> index of the action that carved it to air
  const footprint = []
  const clobbered = []
  const drops = []
  const errors = []
  const warnings = []
  let order = 0

  // Writing one action into the shared state. Pulled out of the loop because
  // the decorator runs in the middle of the sequence and has to go through
  // exactly the same protection and bookkeeping as everything else - a habit
  // that quietly refilled a doorway would be the original bug wearing a hat.
  const writeAction = (action, i, blocks) => {
    footprint[i] = new Set()
    clobbered[i] = new Map()

    for (const b of blocks) {
      const pos = b.pos
      const k = key(pos.x, pos.y, pos.z)
      const isAir = baseName(b.name) === 'air'

      const carver = carvedBy.get(k)
      if (!isAir && sealsOpening(b.name) && carver !== undefined && carver !== i && !PRECISE_OPS.has(action.op)) {
        drops.push({ pos, filler: i, carver, name: b.name })
        continue
      }

      const prev = cells.get(k)
      if (prev && prev.action !== i) {
        footprint[prev.action].delete(k)
        if (!isAir) {
          const tally = clobbered[prev.action]
          tally.set(i, (tally.get(i) || 0) + 1)
        }
      }

      cells.set(k, { name: b.name, pos, action: i, order: order++ })
      footprint[i].add(k)
      if (isAir) carvedBy.set(k, i)
      else carvedBy.delete(k)
    }
  }

  const placed = (action, i) => {
    const shift = anchorShift(action)
    const off = new Vec3(action.offset.x + shift.x, action.offset.y, action.offset.z + shift.z)
    // A railing must not be built into the wall it stands against, and only
    // the renderer knows what is already there.
    const ctx = {
      isFree: local => {
        const world = local.plus(off)
        const c = cells.get(key(world.x, world.y, world.z))
        return !c || baseName(c.name) === 'air'
      },
      // An opening carves only as deep as there is wall, which means asking
      // the cell map how thick the wall it is cutting through actually is.
      isSolid: local => {
        const world = local.plus(off)
        const c = cells.get(key(world.x, world.y, world.z))
        return Boolean(c) && baseName(c.name) !== 'air'
      }
    }
    return shapeFor(action, primitives, ctx).map(b => ({ pos: b.pos.plus(off), name: b.name }))
  }

  // shell and carves, then the decorator, then the model's own details.
  const before = plan.actions.filter(a => a.phase !== 'details')
  const after = plan.actions.filter(a => a.phase === 'details')
  const sequence = []

  for (const action of before) sequence.push(action)
  const decorIndex = sequence.length
  sequence.push(null) // placeholder for the decorator
  for (const action of after) sequence.push(action)

  before.forEach((action, i) => writeAction(action, i, placed(action, i)))

  let decorated = { blocks: [], applied: {} }
  if (plan.decor && plan.decor.style !== 'plain') {
    // Hand the decorator the palette the build is actually made of, so the
    // gradient habit swaps between blocks already in use rather than
    // introducing a fourth stone from nowhere.
    const table = plan.palette ? plan.palette.table : null
    const wall = table && table.wall
    const decorWithPalette = {
      ...plan.decor,
      wallBase: wall ? (typeof wall === 'string' ? wall : wall.base) : null,
      baseRough: table && typeof table.base_rough === 'string' ? table.base_rough : null,
      upper: table && typeof table.upper === 'string' ? table.upper : null,
      trim: plan.decor.trim || (table && typeof table.trim === 'string' ? table.trim : null)
    }
    decorated = decorate(cells, carvedBy, decorWithPalette, isKnownBlock)
    if (decorated.note) warnings.push(`decorator: ${decorated.note}`)
  }
  const decorAction = { op: '__decor', phase: 'decor', material: plan.decor ? plan.decor.style : 'none' }
  sequence[decorIndex] = decorAction
  writeAction(decorAction, decorIndex, decorated.blocks)

  after.forEach((action, n) => {
    const i = decorIndex + 1 + n
    writeAction(action, i, placed(action, i))
  })

  const actions = sequence

  // Report a later action that buried most of an earlier one, within a phase.
  //
  // Only BULK shapes are worth failing a build over. The lint exists to catch a
  // wall re-emitted across its own doorway; two windows sharing a frame block,
  // or a door cut where a window was, still leaves a working opening - so those
  // are reported and built rather than refused.
  //
  // The other half of this matters more: an action may have come from a macro,
  // and the model cannot fix what it did not write. A keep was refused three
  // times running with byte-identical errors naming macro-generated windows,
  // because every retry asked the model to correct code. Macro actions are
  // never fatal; they surface as warnings aimed at whoever maintains the macro.
  actions.forEach((action, i) => {
    const own = footprint[i].size
    const total = own + [...clobbered[i].values()].reduce((a, b) => a + b, 0)
    if (total < CLOBBER_MIN_CELLS) return
    for (const [j, count] of clobbered[i]) {
      if (actions[j].phase !== action.phase) continue
      if (count < total * CLOBBER_RATIO) continue

      const message =
        `action ${j + 1} (${actions[j].op} ${actions[j].material || ''}) overwrites ${Math.round(100 * count / total)}% of action ${i + 1} ` +
        `(${action.op} ${action.material || ''}) - ${count} of its ${total} blocks.`

      const fromMacro = actions[j].__macro || action.__macro
      const smallOps = SOFT_CLOBBER_OPS.has(action.op) || SOFT_CLOBBER_OPS.has(actions[j].op)

      if (fromMacro) warnings.push(`${message} Both came from the ${actions[j].__macro || action.__macro} macro - not something the plan can fix.`)
      else if (smallOps) warnings.push(`${message} Overlapping openings, which still leaves a working opening.`)
      else errors.push(`${message} Do not re-emit or bury a shape you have already placed.`)
    }
  })

  for (const action of plan.actions) {
    if (action.op === 'stairs' && action.rise > 8 && !action.landingEvery) {
      warnings.push(`a ${action.rise}-step flight with no landing - anything over 8 wants landing_every`)
    }
  }

  if (drops.length) {
    const byPair = new Map()
    for (const d of drops) {
      const k = `${d.filler}:${d.carver}`
      byPair.set(k, (byPair.get(k) || 0) + 1)
    }
    for (const [pair, count] of byPair) {
      const [filler, carver] = pair.split(':').map(Number)
      warnings.push(`action ${filler + 1} (${actions[filler].op}) tried to fill ${count} block${count === 1 ? '' : 's'} that action ${carver + 1} had opened up - those blocks were dropped, the opening stands`)
    }
  }

  // Weathering last, so decorator output weathers with everything else. The
  // seed is a hash of the plan: the same plan always produces the same wall,
  // which is what keeps command mode's "already correct" skip meaningful.
  if (plan.palette) {
    const seed = paletteLib.hash(JSON.stringify(plan.actions))
    const swapped = paletteLib.weather(cells, plan.palette, seed)
    if (swapped) console.log(`[render] weathered ${swapped} wall cells`)
  }
  for (const w of plan.paletteWarnings || []) warnings.push(w)

  orientCells(cells, warnings)

  if (cells.size > MAX_BLOCKS) {
    throw new Error(`that plan comes to ${cells.size} blocks, over the ${MAX_BLOCKS} cap`)
  }

  const blocks = [...cells.values()].sort((a, b) => a.order - b.order)
    .map(c => ({ pos: c.pos, name: c.name }))

  return { blocks, errors, warnings, drops: drops.length, decor: decorated.applied }
}

// ---------------------------------------------------------------------------
// Orientation pass.
//
// /fill places a block in its DEFAULT state, which for a glass pane is
// unconnected, for a wall torch is facing north whatever it is attached to, and
// for a lantern is standing rather than hanging. The model can write states
// itself and is told to, but it is one omission away from a wrong-looking block
// and nothing downstream notices. Anything directional that arrives here with
// no state gets one computed from its neighbours instead.
// ---------------------------------------------------------------------------
function orientCells (cells, warnings) {
  const solidAt = pos => {
    const c = cells.get(key(pos.x, pos.y, pos.z))
    if (!c) return false
    return !NON_SOLID.has(baseName(c.name))
  }
  const nameAt = pos => {
    const c = cells.get(key(pos.x, pos.y, pos.z))
    return c ? baseName(c.name) : null
  }

  let unstated = 0

  for (const cell of cells.values()) {
    if (hasState(cell.name)) continue
    const base = baseName(cell.name)

    if (/_pane$/.test(base) || base === 'iron_bars') {
      const on = SIDES.filter(s => {
        const n = nameAt(cell.pos.plus(s.d))
        return solidAt(cell.pos.plus(s.d)) || n === base
      })
      if (on.length) {
        cell.name = withState(cell.name, on.map(s => `${s.key}=true`).join(','))
      }
      continue
    }

    if (/wall_torch$/.test(base)) {
      // A wall torch hangs on the block behind it: facing points AWAY from its
      // support, so facing is the direction from the support toward the torch.
      const support = SIDES.find(s => solidAt(cell.pos.plus(s.d)))
      if (support) {
        const away = SIDES.find(s => s.d.x === -support.d.x && s.d.z === -support.d.z)
        cell.name = withState(cell.name, `facing=${away.key}`)
      } else {
        warnings.push(`a ${base} at (${cell.pos.x}, ${cell.pos.y}, ${cell.pos.z}) has nothing to hang on - the server will drop it`)
      }
      continue
    }

    if (/lantern$/.test(base)) {
      if (solidAt(cell.pos.offset(0, 1, 0))) cell.name = withState(cell.name, 'hanging=true')
      else if (!solidAt(cell.pos.offset(0, -1, 0))) {
        warnings.push(`a ${base} at (${cell.pos.x}, ${cell.pos.y}, ${cell.pos.z}) has nothing above or below it`)
      }
      continue
    }

    if (/_slab$/.test(base)) {
      // A slab under a solid is a soffit and belongs at the top of its cell; a
      // slab with open air above is a step or a cap and belongs at the bottom.
      cell.name = withState(cell.name, solidAt(cell.pos.offset(0, 1, 0)) && !solidAt(cell.pos.offset(0, -1, 0))
        ? 'type=top'
        : 'type=bottom')
      continue
    }

    if (/_trapdoor$/.test(base)) {
      // Hangs on whatever solid is beside it, opening away from that face.
      const support = SIDES.find(s => solidAt(cell.pos.plus(s.d)))
      if (support) {
        const away = SIDES.find(s => s.d.x === -support.d.x && s.d.z === -support.d.z)
        cell.name = withState(cell.name, `facing=${away.key},half=bottom,open=true`)
      } else {
        cell.name = withState(cell.name, 'half=bottom,open=false')
      }
      continue
    }

    if (/_wall$/.test(base)) {
      const on = SIDES.filter(s => solidAt(cell.pos.plus(s.d)))
      const parts = on.map(s => `${s.key}=low`)
      if (solidAt(cell.pos.offset(0, 1, 0))) parts.push('up=true')
      if (parts.length) cell.name = withState(cell.name, parts.join(','))
      continue
    }

    // Everything else that cares about orientation and did not get one.
    if (/_stairs$|_log$|_door$|^chain$/.test(base)) {
      unstated++
      if (unstated <= 3) warnings.push(`a ${base} at (${cell.pos.x}, ${cell.pos.y}, ${cell.pos.z}) is in its default orientation`)
    }
  }

  if (unstated) {
    warnings.push(`${unstated} directional block${unstated === 1 ? '' : 's'} (stairs, slabs, logs, doors) left in their default orientation`)
  }
}

module.exports = { renderPlan, orientCells, anchorShift, shapeFor, PRECISE_OPS, CLOBBER_RATIO }
