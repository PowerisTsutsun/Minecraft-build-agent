'use strict'

// Offline check on the greedy cuboid merge that turns a block list into /fill
// commands. Two properties matter and neither is obvious by inspection:
//   - EXACT COVER: every planned cell is filled exactly once, with the right
//     material. A cell covered twice means two fills fight over it; a cell
//     missed means a hole in the build that nothing reports.
//   - It has to actually save commands, or the whole exercise is pointless.

const { Vec3 } = require('vec3')
const primitives = require('../src/building/primitives')
const { toBoxes, fillCommand } = require('../src/building/commander')

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

verify('floor 9x9', primitives.floor({ width: 9, depth: 9, material: 'stone' }))
verify('hollow box 7x7x5', primitives.box({ width: 7, depth: 7, height: 5, material: 'stone_bricks', hollow: true }))
verify('solid box 5x5x5', primitives.box({ width: 5, depth: 5, height: 5, material: 'stone', hollow: false }))
verify('house 7x6x4', primitives.house({ width: 7, depth: 6, height: 4, wallBlock: 'stone_bricks', floorBlock: 'oak_planks', roofBlock: 'cobblestone' }))
const sphereBoxes = verify('hollow sphere r6', primitives.sphere({ radius: 6, material: 'glass', hollow: true }))

// Mixed-material plan where a later shape overwrites an earlier one - the case
// that produced the "supersede" logic in the undo log.
const mixed = [
  ...primitives.box({ width: 6, depth: 6, height: 4, material: 'stone_bricks', hollow: true }),
  ...primitives.floor({ width: 6, depth: 6, material: 'glass' }).map(b => ({ pos: b.pos.offset(0, 3, 0), name: b.name }))
]
verify('box with a glass ceiling laid over it', mixed)

// Command strings have to fit in a chat line.
const longest = Math.max(...sphereBoxes.map(b => fillCommand(b).length))
check('fill commands fit in a chat message', longest < 250, `longest is ${longest} chars`)

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
