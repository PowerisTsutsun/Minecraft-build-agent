'use strict'

// Offline check on the greedy cuboid merge that turns a block list into /fill
// commands. Two properties matter and neither is obvious by inspection:
//   - EXACT COVER: every planned cell is filled exactly once, with the right
//     material. A cell covered twice means two fills fight over it; a cell
//     missed means a hole in the build that nothing reports.
//   - It has to actually save commands, or the whole exercise is pointless.

const { Vec3 } = require('vec3')
const { toBoxes, fillCommand } = require('../src/building/commander')

// ---------------------------------------------------------------------------
// Fixtures. These used to come from the plan primitives, which went with the
// natural-language planner - but the merger under test never cared where a
// block list came from, only what shape it is. Kept here verbatim because the
// shapes are the point: a flat slab, a hollow shell, a ragged curve and a
// mixed-material overlay each break a different merge assumption.
// ---------------------------------------------------------------------------

const HALF = 0.5
const circleLimit = r => (r + HALF) * (r + HALF)

function floor ({ width, depth, material, y = 0 }) {
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) blocks.push({ pos: new Vec3(x, y, z), name: material })
  }
  return blocks
}

function box ({ width, depth, height, material, hollow = true, y = 0 }) {
  const blocks = []
  for (let h = 0; h < height; h++) {
    const isCap = h === 0 || h === height - 1
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        const isPerimeter = x === 0 || x === width - 1 || z === 0 || z === depth - 1
        if (hollow && !isCap && !isPerimeter) continue
        blocks.push({ pos: new Vec3(x, y + h, z), name: material })
      }
    }
  }
  return blocks
}

function sphere ({ radius, material, hollow = true, y = 0 }) {
  const blocks = []
  const r = Math.max(1, Math.floor(radius))
  const limit = circleLimit(r)
  const inside = (x, yy, z) => (x * x + yy * yy + z * z) <= limit

  for (let dy = -r; dy <= r; dy++) {
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
        blocks.push({ pos: new Vec3(dx + r, y + dy + r, dz + r), name: material })
      }
    }
  }
  return blocks
}

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

function cellsFrom (blocks, origin = new Vec3(100, -60, 100)) {
  const cells = new Map()
  for (const { pos, name } of blocks) {
    const t = origin.plus(pos)
    cells.set(`${t.x},${t.y},${t.z}`, name)
  }
  return cells
}

function verify (label, blocks) {
  const cells = cellsFrom(blocks)
  const boxes = toBoxes(cells)

  const covered = new Map()
  let overlaps = 0
  for (const box of boxes) {
    for (let x = box.min.x; x <= box.max.x; x++) {
      for (let y = box.min.y; y <= box.max.y; y++) {
        for (let z = box.min.z; z <= box.max.z; z++) {
          const k = `${x},${y},${z}`
          if (covered.has(k)) overlaps++
          covered.set(k, box.name)
        }
      }
    }
  }

  const missing = [...cells.keys()].filter(k => !covered.has(k))
  const extra = [...covered.keys()].filter(k => !cells.has(k))
  const wrong = [...cells.entries()].filter(([k, n]) => covered.get(k) !== n)

  check(`${label}: no overlapping fills`, overlaps === 0, `${overlaps} cells covered twice`)
  check(`${label}: nothing missed`, missing.length === 0, `${missing.length} cells uncovered`)
  check(`${label}: nothing extra`, extra.length === 0, `${extra.length} cells outside the plan`)
  check(`${label}: right material everywhere`, wrong.length === 0, `${wrong.length} cells wrong`)
  console.log(`     ${cells.size} blocks -> ${boxes.length} fill commands (${(cells.size / boxes.length).toFixed(1)} blocks each)`)
  return boxes
}

verify('floor 9x9', floor({ width: 9, depth: 9, material: 'stone' }))
verify('hollow box 7x7x5', box({ width: 7, depth: 7, height: 5, material: 'stone_bricks', hollow: true }))
verify('solid box 5x5x5', box({ width: 5, depth: 5, height: 5, material: 'stone', hollow: false }))
// Three materials in one plan, the shape a small house makes: stone walls on a
// plank floor under a cobble lid. Each material merges separately, so the
// merger has to keep three cuboid sets from stepping on each other.
verify('walls, floor and roof 7x6x4', [
  ...box({ width: 7, depth: 6, height: 4, material: 'stone_bricks', hollow: true }),
  ...floor({ width: 7, depth: 6, material: 'oak_planks' }),
  ...floor({ width: 7, depth: 6, material: 'cobblestone', y: 3 })
])
const sphereBoxes = verify('hollow sphere r6', sphere({ radius: 6, material: 'glass', hollow: true }))

// Mixed-material plan where a later shape overwrites an earlier one - the case
// that produced the "supersede" logic in the undo log.
const mixed = [
  ...box({ width: 6, depth: 6, height: 4, material: 'stone_bricks', hollow: true }),
  ...floor({ width: 6, depth: 6, material: 'glass' }).map(b => ({ pos: b.pos.offset(0, 3, 0), name: b.name }))
]
verify('box with a glass ceiling laid over it', mixed)

// Command strings have to fit in a chat line.
const longest = Math.max(...sphereBoxes.map(b => fillCommand(b).length))
check('fill commands fit in a chat message', longest < 250, `longest is ${longest} chars`)

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
