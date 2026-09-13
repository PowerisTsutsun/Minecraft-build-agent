'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Put an item frame on each sorting slot showing what it stores.
//
// A 300-slot storage hall is unusable without labels - the chests are identical
// and the filter that decides what goes where is buried inside a hopper. The
// convention is a frame on the chest face holding one of the item, so the aisle
// reads at a glance.
//
// Frames are entities, so a .schem cannot carry them (/sorter1 stores zero
// Entities) - they have to be summoned. Item and slot come from the same
// flow-order walk load-sorter.js uses, so frame and filter always agree.
//
//   node tools/label-sorter.js --at 610 59 12 --what /sorter1 --limit 6 --apply
//   node tools/label-sorter.js --at 610 59 12 --what /sorter1 --apply
//   node tools/label-sorter.js ... --clear      # remove frames in the region
//
// --limit places only the first N, for checking the facing before committing.

const fs = require('fs')
const path = require('path')
const schemMod = require('../src/building/schematic')
const blueprints = require('../src/building/blueprints')
const { baseName } = require('../src/building/blockspec')

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const has = n => process.argv.includes(`--${n}`)

// Facing values as the entity stores them.
const FACE = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 }
const DIR = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }

;(async () => {
  const what = arg('what', '/sorter1')
  const at = process.argv.indexOf('--at')
  if (at === -1) { console.error('--at <x> <y> <z> is required'); process.exit(1) }
  const O = { x: +process.argv[at + 1], y: +process.argv[at + 2], z: +process.argv[at + 3] }

  // --what takes a blueprint name (/sorter1) or a path to a file. Resolving
  // through blueprints.js is what keeps these tools and the chat bot naming
  // the same thing.
  const entry = blueprints.resolve(what)
  const s = await schemMod.loadSchematic(entry ? entry.path : what, DATA_VERSION)
  const { blocks } = schemMod.schematicToBlocks(s)
  const at3 = new Map()
  for (const b of blocks) at3.set(`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name)
  const base = (x, y, z) => { const n = at3.get(`${x},${y},${z}`); return n ? baseName(n) : 'air' }

  // Same ordering as the loader, so slot N here is slot N there.
  const { findFilters } = require('./lib-sorter')
  const filters = findFilters(blocks)
  const items = require('./lib-sorter').itemsFor(filters.length, arg('items'))

  // For each filter, find its chests and an air cell next to one that a frame
  // can hang in. Prefer the cell the walkway is on, so it faces the aisle.
  const placements = []
  const proposals = []
  let unrouted = 0
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    // Where a label goes, taken from frames placed by hand in-world rather
    // than guessed: the slot's chests stack two high, and the label hangs on
    // the WOOD ROW under the pair, facing the aisle. Not beside the chest -
    // under it, on the plank block that is deliberately left blank for it.
    //
    //   y69  chest          upper pair
    //   y68  chest
    //   y67  planks  <- label for the upper pair hangs on this, in the air west
    //   y66  chest          lower pair
    //   y65  chest
    //   y64  planks  <- label for the lower pair
    //
    // The plank row steps one block across between the two banks, so "the block
    // directly below the bottom chest" is wrong for one of them. Search the
    // small neighbourhood under the pair for the plank that has an open face.
    // Collect EVERY plank face this slot could reasonably label, ranked, then
    // let the assignment below claim them one at a time. A single "best" cell
    // is not enough: on the distribution line the two banks at one x,z resolve
    // to the same plank, and whichever is processed second silently overwrites
    // the first - 300 slots collapsing to 191 labels.
    const candidates = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -6; dy <= -1; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          if (base(f.x + dx, f.y + dy, f.z + dz) !== 'chest') continue
          const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz }
          let bottom = c
          while (base(bottom.x, bottom.y - 1, bottom.z) === 'chest') bottom = { ...bottom, y: bottom.y - 1 }
          const rowY = bottom.y - 1
          for (let ex = -2; ex <= 2; ex++) {
            for (let ez = -1; ez <= 1; ez++) {
              const bx = bottom.x + ex, bz = bottom.z + ez
              if (!/planks|slab/.test(base(bx, rowY, bz))) continue
              for (const dir of ['west', 'east', 'north', 'south']) {
                const [ax, , az] = DIR[dir]
                if (base(bx + ax, rowY, bz + az) !== 'air') continue
                candidates.push({
                  cell: { x: bx + ax, y: rowY, z: bz + az },
                  facing: dir,
                  // Weighted to reproduce the placement done by hand in-world:
                  // the chest pair nearest BELOW this filter, the plank right
                  // under that pair, hung on the aisle face. Distance to the
                  // chest dominates so a slot cannot borrow the other bank's
                  // pair; facing is next so labels always read from the walkway.
                  cost: Math.abs(dy) * 100 + (dir === 'west' ? 0 : 40) +
                        Math.abs(dx) * 6 + Math.abs(dz) * 6 +
                        Math.abs(ex) * 3 + Math.abs(ez) * 3
                })
              }
            }
          }
        }
      }
    }
    if (!candidates.length) { unrouted++; continue }
    candidates.sort((a, b) => a.cost - b.cost)
    proposals.push({ slot: i, item: items[i], filter: { ...f }, candidates })
  }

  // Greedy claim in flow order: each slot takes its cheapest cell that is still
  // free, so no two labels can ever land on the same plank.
  const taken = new Set()
  let contested = 0
  for (const p of proposals) {
    const pick = p.candidates.find(c => !taken.has(`${c.cell.x},${c.cell.y},${c.cell.z}`))
    if (!pick) { unrouted++; continue }
    if (pick !== p.candidates[0]) contested++
    taken.add(`${pick.cell.x},${pick.cell.y},${pick.cell.z}`)
    placements.push({
      pos: { x: O.x + pick.cell.x, y: O.y + pick.cell.y, z: O.z + pick.cell.z },
      facing: FACE[pick.facing],
      item: p.item,
      slot: p.slot,
      filter: { x: O.x + p.filter.x, y: O.y + p.filter.y, z: O.z + p.filter.z }
    })
  }

  const limit = arg('limit') ? Number(arg('limit')) : placements.length
  const use = placements.slice(0, limit)
  if (contested) console.error(`${contested} slot(s) took their second-choice plank because their first was already claimed`)
  console.error(`${filters.length} filters: ${placements.length} routed to a chest with an open face, ${unrouted} whose output chain never reached a chest; placing ${use.length}`)

  const { assertItemId } = require('./lib-sorter')
  const cmds = use.map(p =>
    // The id goes inside double quotes with nothing escaping them; assert the
    // vanilla id shape here so this does not rely on where p.item came from.
    `summon minecraft:glow_item_frame ${p.pos.x} ${p.pos.y} ${p.pos.z} {Facing:${Number(p.facing)}b,Fixed:1b,Invulnerable:1b,Item:{id:"${assertItemId(p.item)}",count:1}}`)

  if (!has('apply') && !has('clear')) {
    // A label cell must belong to exactly one slot. Two filters resolving to
    // the same plank means one of them is unlabelled and the other is lying.
    const cells = new Map()
    for (const p of use) {
      const k = `${p.pos.x},${p.pos.y},${p.pos.z}`
      ;(cells.get(k) || cells.set(k, []).get(k)).push(p)
    }
    const clashes = [...cells.entries()].filter(([, v]) => v.length > 1)
    if (clashes.length) {
      console.error(`COLLISION: ${clashes.length} label cells claimed by more than one slot (${use.length} slots -> ${cells.size} cells)`)
      for (const [k, v] of clashes.slice(0, 5)) console.error(`   ${k} <- ` + v.map(p => `${p.item.replace('minecraft:', '')} (filter ${p.filter.x},${p.filter.y},${p.filter.z})`).join('  |  '))
    } else {
      console.error(`${cells.size} label cells, one per slot - no collisions`)
    }
    if (has('list')) for (const c of cmds) console.log('/' + c)
    else { for (const c of cmds.slice(0, 6)) console.log('/' + c); console.log(`... ${cmds.length} total (--list for all, --apply to place)`) }
    return
  }

  const { connect } = require('../src/rcon/client')
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rcon-servers.json'), 'utf8'))[arg('server', SERVER)]
  const rcon = await connect({ host: cfg.host, port: cfg.port, password: cfg.password, timeout: 60000 })
  const xs = use.map(p => p.pos.x), zs = use.map(p => p.pos.z)
  const lo = { x: Math.min(...xs), z: Math.min(...zs) }, hi = { x: Math.max(...xs), z: Math.max(...zs) }
  await rcon.send(`forceload add ${lo.x} ${lo.z} ${hi.x} ${hi.z}`)
  await new Promise(r => setTimeout(r, 1500))

  if (has('clear')) {
    const out = await rcon.send(`kill @e[type=minecraft:glow_item_frame,x=${lo.x},y=${O.y},z=${lo.z},dx=${hi.x - lo.x},dy=80,dz=${hi.z - lo.z}]`)
    console.error('cleared:', out.trim())
  } else {
    // Clear whatever is already in the target cell first, so re-running swaps
    // labels rather than stacking a second frame behind the first.
    let ok = 0, failed = 0, replaced = 0
    const errs = []
    for (let i = 0; i < cmds.length; i++) {
      const p = use[i].pos
      const gone = await rcon.send(`kill @e[type=minecraft:glow_item_frame,x=${p.x},y=${p.y},z=${p.z},dx=0,dy=0,dz=0]`)
      if (/Killed/i.test(gone)) replaced++
      const reply = (await rcon.send(cmds[i])).trim()
      if (/Summoned/i.test(reply)) ok++
      else { failed++; if (errs.length < 3) errs.push(`${cmds[i].slice(0, 80)} -> ${reply.slice(0, 80)}`) }
    }
    if (replaced) console.error(`replaced ${replaced} frame(s) that were already in place`)
    console.error(`placed ${ok} frames, ${failed} failed`)
    for (const e of errs) console.error('  ' + e)
    if (use.length) console.error(`\nfirst frame is at ${use[0].pos.x} ${use[0].pos.y} ${use[0].pos.z} showing ${use[0].item}`)
  }
  await rcon.send(`forceload remove ${lo.x} ${lo.z} ${hi.x} ${hi.z}`)
  rcon.close()
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1) })
