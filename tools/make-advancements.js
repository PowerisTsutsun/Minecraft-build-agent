'use strict'

const { DATA_VERSION, SERVER } = require('../src/version')

// Render the blueprint catalogue as a datapack of advancements, so /build list
// can be browsed on the L screen instead of scrolling past in chat: a tab per
// collection, a node per blueprint, each with an icon and a tooltip.
//
// The icon for a build is its own dominant material, straight out of
// catalog.json - a sandstone colosseum gets sandstone, a nether portal farm
// gets obsidian. Some dominant blocks have no item form (water, redstone_wire,
// nether_portal), so those fall back per kind.
//
// The mc-test world is mounted read-only in this container, so this writes to
// --out (default /app/.datapack) and the host copies it into
// <server>/world/datapacks/. Then: /reload
//
//   docker exec -w /app mc-builder-bot node tools/make-advancements.js
//   cp -r ./.datapack/blueprints <server>/world/datapacks/

const fs = require('fs')
const path = require('path')
const schemMod = require('../src/building/schematic')

const NS = 'blueprints'
const PACK_FORMAT = 107          // 26.2 version.json -> pack_version.data_major
const outRoot = (() => {
  const i = process.argv.indexOf('--out')
  return i === -1 ? path.join(__dirname, '..', '.datapack') : process.argv[i + 1]
})()

const aliases = JSON.parse(fs.readFileSync(path.join(schemMod.SCHEMATIC_DIR, 'aliases.json'), 'utf8'))
const catalog = (() => {
  const by = {}
  for (const e of JSON.parse(fs.readFileSync(path.join(schemMod.SCHEMATIC_DIR, 'catalog.json'), 'utf8'))) by[e.file] = e
  return by
})()
const registry = require('minecraft-data')(DATA_VERSION)

const KIND_LABEL = {
  template: 'Machines', farm: 'Farms', sorter: 'Sorters', redstone: 'Redstone',
  house: 'Houses', tower: 'Towers', statue: 'Statues', build: 'Big builds', other: 'Other'
}
const KIND_ICON = {
  template: 'minecraft:crafter', farm: 'minecraft:iron_block', sorter: 'minecraft:hopper',
  redstone: 'minecraft:redstone',
  house: 'minecraft:oak_planks', tower: 'minecraft:stone_bricks', statue: 'minecraft:polished_blackstone',
  build: 'minecraft:bricks', other: 'minecraft:chest'
}
const KIND_ORDER = ['template', 'farm', 'sorter', 'redstone', 'house', 'tower', 'statue', 'build', 'other']

// A block that cannot be held cannot be an icon. And the most common block in a
// downloaded build is very often the slab of ground it was captured standing on,
// which makes for sixteen identical grass_block icons - so terrain is passed
// over unless the build really is nothing but terrain.
const TERRAIN_ICON = /^(grass_block|dirt|coarse_dirt|podzol|stone|gravel|sand|water|lava|andesite|diorite|granite|deepslate|clay|snow|snow_block|mud|netherrack|.*_leaves|.*_log|tall_grass|fern|short_grass)$/

function iconFor (entry, kind) {
  // A machine is best identified by its machinery, not its shell.
  if (kind === 'sorter') return 'minecraft:hopper'
  if (kind === 'redstone') return 'minecraft:redstone'
  const names = ((entry && entry.top) || [])
    .map(line => line.split(' ')[0])
    .filter(n => registry.itemsByName[n])
  return 'minecraft:' + (
    names.find(n => !TERRAIN_ICON.test(n)) ||   // what it is built OF
    names[0] ||                                  // else whatever it is made of
    (KIND_ICON[kind] || 'minecraft:chest').replace('minecraft:', '')
  )
}

function describe (target, entry) {
  if (target.startsWith('template:')) {
    return 'Machine - carries setup.txt: entities, container contents.\nBuild this, not the raw schematic.'
  }
  const bits = []
  if (entry) {
    if (entry.size) bits.push(entry.size)
    if (entry.blocks) bits.push(entry.blocks.toLocaleString() + ' blocks')
    if (entry.palette) bits.push(entry.palette + ' materials')
  }
  let text = bits.join('  ·  ')
  if (entry && entry.meta) text += '\n' + entry.meta
  if (entry && entry.overCap) text += '\n§cToo big to build: ' + entry.overCap
  return text || target
}

// --- group -----------------------------------------------------------------
const groups = {}
for (const name of Object.keys(aliases)) {
  if (name.startsWith('_')) continue
  const target = aliases[name]
  const entry = catalog[target]
  const kind = target.startsWith('template:') ? 'template' : ((entry && entry.kind) || 'other')
  ;(groups[kind] = groups[kind] || []).push({ name, target, entry, kind })
}
const kinds = KIND_ORDER.filter(k => groups[k]).concat(Object.keys(groups).filter(k => !KIND_ORDER.includes(k)))

// --- write ------------------------------------------------------------------
const packDir = path.join(outRoot, NS)
const advDir = path.join(packDir, 'data', NS, 'advancement')
fs.rmSync(packDir, { recursive: true, force: true })
fs.mkdirSync(advDir, { recursive: true })

fs.writeFileSync(path.join(packDir, 'pack.mcmeta'), JSON.stringify({
  pack: { pack_format: PACK_FORMAT, description: 'BuilderBot blueprint catalogue' }
}, null, 2) + '\n')

const write = (file, obj) => fs.writeFileSync(path.join(advDir, file + '.json'), JSON.stringify(obj, null, 2) + '\n')
// Granted on the next tick, so the whole tree is visible rather than locked.
const shown = { criteria: { shown: { trigger: 'minecraft:tick' } } }

const total = Object.values(groups).reduce((n, g) => n + g.length, 0)
write('root', {
  display: {
    icon: { id: 'minecraft:filled_map' },
    title: 'Blueprints',
    description: `${total} builds BuilderBot can place. Type !build /<name>`,
    background: 'minecraft:textures/block/stone_bricks.png',
    frame: 'task', show_toast: false, announce_to_chat: false
  },
  ...shown
})

let n = 0
for (const kind of kinds) {
  const id = 'kind_' + kind
  write(id, {
    parent: `${NS}:root`,
    display: {
      icon: { id: KIND_ICON[kind] || 'minecraft:chest' },
      title: KIND_LABEL[kind] || kind,
      description: `${groups[kind].length} ${(KIND_LABEL[kind] || kind).toLowerCase()}`,
      frame: 'task', show_toast: false, announce_to_chat: false
    },
    ...shown
  })
  const sorted = groups[kind].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const b of sorted) {
    write('bp_' + b.name, {
      parent: `${NS}:${id}`,
      display: {
        icon: { id: iconFor(b.entry, kind) },
        title: '/' + b.name,
        description: describe(b.target, b.entry),
        frame: kind === 'template' ? 'goal' : 'task',
        show_toast: false, announce_to_chat: false
      },
      ...shown
    })
    n++
  }
}

console.log(`wrote ${packDir}`)
console.log(`  ${kinds.length} groups, ${n} blueprints, pack_format ${PACK_FORMAT}`)
for (const kind of kinds) {
  console.log(`  ${(KIND_LABEL[kind] || kind).padEnd(12)} ${String(groups[kind].length).padStart(2)}  icons: ` +
    groups[kind].slice(0, 4).map(b => iconFor(b.entry, kind).replace('minecraft:', '')).join(', '))
}
