'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Load an item sorter's filter hoppers.
//
// A filter hopper holds 41 of its target item plus one junk item in each of the
// other four slots. That exact loading is the whole mechanism: 45 items across
// 5 slots makes the comparator beside it read 2, and the 46th item ticks it to
// 3. That edge is what diverts the item into the slot's chests.
//
// Empty, the comparator reads 0 and nothing ever diverts - and worse, an empty
// hopper filters nothing, so it grabs whatever passes and swallows it into the
// first slot. A sorter placed from a .schem is always in that state, because
// container inventories live in block-entity data that prismarine-schematic
// discards. /sorter1 arrives with 300 empty filters.
//
//   node tools/load-sorter.js --at 610 59 12 --what /sorter1            # preview
//   node tools/load-sorter.js --at 610 59 12 --what /sorter1 --map      # slot map
//   node tools/load-sorter.js --at 610 59 12 --what /sorter1 --apply --server mc-test
//   node tools/load-sorter.js ... --out templates/sorter1/setup.txt
//
// --items <file> takes one item id per line to override the built-in list.

const fs = require('fs')
const path = require('path')
const schemMod = require('../src/building/schematic')
const blueprints = require('../src/building/blueprints')
const { baseName } = require('../src/building/blockspec')

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const has = n => process.argv.includes(`--${n}`)

const FILTER_COUNT = 41      // target item; 41 + 4 junk = comparator reads 2
const JUNK = 'minecraft:stick'
const JUNK_ALT = 'minecraft:bone'   // for the slot whose target IS a stick

// Slot order and item list come from lib-sorter.js, shared with label-sorter.js,
// so a filter's charge and the frame under its chests can never disagree.
const { findFilters, itemsFor, assertItemId } = require('./lib-sorter')

function mergeCommand (pos, item, absolute) {
  assertItemId(item)
  const junk = item === JUNK ? JUNK_ALT : JUNK
  const slots = [`{Slot:0b,id:"${item}",count:${FILTER_COUNT}}`]
  for (let s = 1; s <= 4; s++) slots.push(`{Slot:${s}b,id:"${junk}",count:1}`)
  const at = absolute ? `${pos.x} ${pos.y} ${pos.z}` : `~${pos.x} ~${pos.y} ~${pos.z}`
  return `/data merge block ${at} {Items:[${slots.join(',')}]}`
}

;(async () => {
  const what = arg('what', '/sorter1')
  const registry = require('minecraft-data')(DATA_VERSION)
  // --what takes a blueprint name (/sorter1) or a path to a file. Resolving
  // through blueprints.js is what keeps these tools and the chat bot naming
  // the same thing.
  const entry = blueprints.resolve(what)
  const s = await schemMod.loadSchematic(entry ? entry.path : what, DATA_VERSION)
  const { blocks } = schemMod.schematicToBlocks(s)
  const filters = findFilters(blocks)
  if (!filters.length) { console.error(`no filter hoppers in ${what}`); process.exit(1) }

  const items = itemsFor(filters.length, arg('items'))

  const at = process.argv.indexOf('--at')
  const origin = at === -1 ? null : { x: +process.argv[at + 1], y: +process.argv[at + 2], z: +process.argv[at + 3] }
  const abs = !!origin
  const place = p => (origin ? { x: origin.x + p.x, y: origin.y + p.y, z: origin.z + p.z } : p)

  const reachable = filters.reachable === undefined ? filters.length : filters.reachable
  console.error(`${filters.length} filter hoppers in ${what}; ${items.length} items available`)
  console.error(`${reachable} are reachable by walking the hopper chain from its input; ${filters.length - reachable} are not on the traced path`)
  if (items.length < filters.length) console.error(`WARNING: ${filters.length - items.length} slots will be left empty - an empty filter swallows whatever passes it`)

  if (has('map')) {
    const banks = {}
    for (let i = 0; i < filters.length; i++) {
      const p = place(filters[i])
      ;(banks[p.y] = banks[p.y] || []).push(`${String(p.x).padStart(5)} ${String(p.z).padStart(5)}  ${(items[i] || '(EMPTY)').replace('minecraft:', '')}`)
    }
    for (const y of Object.keys(banks).sort((a, b) => b - a)) {
      console.log(`\n=== bank at y${y} - ${banks[y].length} slots ===`)
      console.log('    x     z  item')
      for (const l of banks[y]) console.log(l)
    }
    return
  }

  const lines = filters.map((f, i) => items[i] ? mergeCommand(place(f), items[i], abs) : null).filter(Boolean)

  const out = arg('out')
  if (out) {
    const header = [
      `# Filter hopper loading for ${what}.`,
      '#',
      '# 41 of the target item plus one junk item in each of the other four slots,',
      "# so the comparator beside each hopper reads 2 and ticks to 3 on the next",
      '# matching item. That edge is what diverts it into the slot chests.',
      '#',
      `# ${lines.length} slots. Container inventories are not stored in a .schem, so`,
      '# without this the sorter builds with every filter empty - and an empty',
      '# filter passes everything, which looks exactly like a sorter that does',
      '# nothing.',
      ''
    ]
    fs.writeFileSync(out, header.concat(lines).join('\n') + '\n')
    console.error(`wrote ${out} (${lines.length} commands)`)
    return
  }

  if (has('apply')) {
    if (!origin) { console.error('--apply needs --at <x> <y> <z>'); process.exit(1) }
    const { connect } = require('../src/rcon/client')
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rcon-servers.json'), 'utf8'))[arg('server', SERVER)]
    const rcon = await connect({ host: cfg.host, port: cfg.port, password: cfg.password, timeout: 60000 })
    const xs = filters.map(f => place(f).x), zs = filters.map(f => place(f).z)
    const lo = { x: Math.min(...xs), z: Math.min(...zs) }, hi = { x: Math.max(...xs), z: Math.max(...zs) }
    await rcon.send(`forceload add ${lo.x} ${lo.z} ${hi.x} ${hi.z}`)
    await new Promise(r => setTimeout(r, 1500))
    let ok = 0, failed = 0
    const firstErrors = []
    for (const cmd of lines) {
      const reply = (await rcon.send(cmd.slice(1))).trim()
      // "Nothing changed" means the slot already holds exactly this - which is
      // success, not failure, and matters when re-running the loader.
      if (/Modified block data/i.test(reply) || /Nothing changed/i.test(reply)) ok++
      else { failed++; if (firstErrors.length < 3) firstErrors.push(`${cmd.slice(0, 70)} -> ${reply.slice(0, 90)}`) }
    }
    await rcon.send(`forceload remove ${lo.x} ${lo.z} ${hi.x} ${hi.z}`)
    await rcon.send('save-all flush')
    rcon.close()
    console.error(`loaded ${ok} filters, ${failed} failed`)
    for (const e of firstErrors) console.error('  ' + e)
    return
  }

  for (const l of lines.slice(0, 5)) console.log(l)
  console.log(`... ${lines.length} commands total (--map to see the layout, --apply to run them)`)
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1) })
