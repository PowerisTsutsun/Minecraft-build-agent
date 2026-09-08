'use strict'

// Spot a machine that has been placed dead.
//
// A .schem stores blocks; container inventories live in block-entity data that
// prismarine-schematic discards. For a house that costs nothing. For a sorter
// it is the difference between working and not: a filter hopper holds 41 of its
// target plus junk so the comparator beside it reads 2, and empty it reads 0 -
// the divert never fires, and worse, an empty hopper filters nothing, so it
// swallows whatever passes into the first slot it meets.
//
// That failure is silent. The build looks perfect and does nothing, which is
// how "the sorting didn't work" and the gold farm posting its gold into lava
// both started. So say it at build time rather than leaving it to be found.

const { baseName } = require('./blockspec')

const NEAR = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

// -> { filters, hoppers, comparators } counted over a placed block list.
function machineParts (blocks) {
  const cmp = new Set()
  let hoppers = 0
  for (const b of blocks) {
    const n = baseName(b.name)
    if (n === 'comparator') cmp.add(`${b.pos.x},${b.pos.y},${b.pos.z}`)
    else if (n === 'hopper') hoppers++
  }
  let filters = 0
  for (const b of blocks) {
    if (baseName(b.name) !== 'hopper') continue
    if (NEAR.some(([dx, dy, dz]) => cmp.has(`${b.pos.x + dx},${b.pos.y + dy},${b.pos.z + dz}`))) filters++
  }
  return { filters, hoppers, comparators: cmp.size }
}

// The chat warning, or null when there is nothing to say. `loaded` is how many
// containers the caller is about to fill from a setup.txt.
function unloadedWarning (blocks, loaded = 0) {
  const { filters, hoppers } = machineParts(blocks)
  if (filters < 4 || loaded >= filters) return null
  return [
    `This has ${filters} filter hoppers and ${loaded ? `only ${loaded} of them get loaded` : 'none of them are loaded'}.`,
    'A .schem cannot carry container contents, and an empty filter passes everything - it will not sort until they are filled.',
    `Fix: node tools/load-sorter.js --what <file> --at <x> <y> <z> --apply`
  ]
}

module.exports = { machineParts, unloadedWarning }
