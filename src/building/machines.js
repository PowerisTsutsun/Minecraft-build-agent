'use strict'

const path = require('path')

// ---------------------------------------------------------------------------
// Machines: blueprints that are dead without their contents.
//
// A farm, a mob grinder, a sorter. Blocks alone make no iron: the machine is
// three villagers who can see a zombie they cannot reach, a filter hopper
// holding 41 of one item, a zombie in a boat. None of that is block data, so no
// .schem carries it - placed raw, every machine arrives looking right and
// producing nothing, silently.
//
// So a machine keeps its contents beside it, as sidecar files the loader picks
// up automatically:
//
//   blueprints/farm/ironfarm1.schem          the blocks
//   blueprints/farm/ironfarm1.setup.txt      /summon and /data merge, run after placing
//   blueprints/farm/ironfarm1.meta.json      how far it sits into the ground, what to protect
//
// This file is what turns those two sidecars into commands against a real
// origin. It used to also own a templates/ directory with its own name rules
// and loader; that directory is gone - a machine is just a blueprint now.
// ---------------------------------------------------------------------------

function setupCommands (info, origin) {
  const num = '(-?\\d+(?:\\.\\d+)?)'
  const re = new RegExp(`~${num}\\s+~${num}\\s+~${num}`, 'g')
  const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return info.setup.map(line =>
    line.replace(re, (m, x, y, z) =>
      `${fmt(origin.x + Number(x))} ${fmt(origin.y + Number(y))} ${fmt(origin.z + Number(z))}`))
}

// Cells a decorator or a later build must not touch.
function protectedCells (info, origin) {
  const p = info.meta.protect
  if (!p) return null
  const cells = new Set()
  for (let x = p.from.x; x <= p.to.x; x++) {
    for (let y = p.from.y; y <= p.to.y; y++) {
      for (let z = p.from.z; z <= p.to.z; z++) {
        cells.add(`${origin.x + x},${origin.y + y},${origin.z + z}`)
      }
    }
  }
  return cells
}

module.exports = { setupCommands, protectedCells }
