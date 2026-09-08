'use strict'

// Give every usable schematic a friendly !build name.
//
// Rules, in order of authority:
//   - An existing alias is never touched, renumbered or reordered. Someone
//     chose it while looking at the build; a heuristic does not get to argue.
//   - `terrain` and `unreadable` entries get no name. A landscape capture is
//     not something you build, and three of them are over MC_MAX_BLOCKS
//     anyway - a name that can only ever refuse is worse than no name.
//   - Everything else gets <kind><n>, continuing the highest number already in
//     use for that kind, so existing names keep their meaning. Files are taken
//     smallest-first so the low numbers are the quick ones to try.
//
// --write to apply, otherwise it just prints what it would do.

const fs = require('fs')
const path = require('path')
const { SCHEMATIC_DIR } = require('../src/building/schematic')

const write = process.argv.includes('--write')
const catalog = JSON.parse(fs.readFileSync(path.join(SCHEMATIC_DIR, 'catalog.json'), 'utf8'))
const aliasFile = path.join(SCHEMATIC_DIR, 'aliases.json')
const aliases = JSON.parse(fs.readFileSync(aliasFile, 'utf8'))

const SKIP_KINDS = new Set(['terrain', 'unreadable'])
const SKIP_FILES = new Set(['test-cube.schem'])   // a 3x3 stone cube, not a build

// A raw .litematic that a template was captured FROM must never get its own
// name. The template carries setup.txt - the villagers, the zombie in its boat,
// the pre-loaded filter hoppers. The bare file carries none of that, and an
// empty filter passes everything, so /farm1 would build a machine that looks
// right and can never produce. Anyone reaching for it wants the template.
const templateSources = new Map()
try {
  const tdir = path.join(__dirname, '..', 'templates')
  for (const name of fs.readdirSync(tdir)) {
    const dir = path.join(tdir, name)
    if (!fs.statSync(dir).isDirectory()) continue
    let text = ''
    for (const f of ['readme.md', 'setup.txt', 'meta.json']) {
      try { text += fs.readFileSync(path.join(dir, f), 'utf8') } catch (e) {}
    }
    for (const m of text.matchAll(/([0-9]{3,6}\.(?:litematic|schem|schematic))/g)) {
      templateSources.set(m[1], name)
    }
  }
} catch (e) {}

const named = new Set(Object.values(aliases).filter(v => typeof v === 'string'))
const highest = {}
for (const name of Object.keys(aliases)) {
  const m = /^([a-z]+?)(\d+)$/.exec(name)
  if (m) highest[m[1]] = Math.max(highest[m[1]] || 0, Number(m[2]))
}

const added = []
const skipped = []
for (const e of catalog.slice().sort((a, b) => (a.blocks || 0) - (b.blocks || 0))) {
  if (named.has(e.file) || SKIP_FILES.has(e.file)) continue
  if (SKIP_KINDS.has(e.kind)) { skipped.push(e); continue }
  if (templateSources.has(e.file)) {
    skipped.push({ ...e, why: `source of template:${templateSources.get(e.file)} - build that instead, it carries setup.txt` })
    continue
  }
  const kind = e.kind || 'build'
  const n = (highest[kind] || 0) + 1
  highest[kind] = n
  const name = `${kind}${n}`
  aliases[name] = e.file
  added.push({ name, e })
}

// docs/dev-notes-2026-09-06.md, open issue #2: /shop1 is an enchanting room.
if (aliases.shop1 && !aliases.enchantroom) {
  aliases.enchantroom = aliases.shop1
  delete aliases.shop1
  console.log('renamed /shop1 -> /enchantroom  (dev-notes open issue #2)\n')
}

for (const { name, e } of added) {
  console.log(`  /${name.padEnd(12)} ${e.file.padEnd(17)} ${(e.size || '').padEnd(14)} ${String(e.blocks).padStart(8)} blocks`)
}
console.log(`\n${added.length} named, ${skipped.length} left unnamed:`)
for (const e of skipped) {
  console.log(`  ${e.file.padEnd(17)} ${e.kind.padEnd(10)} ${e.why || (e.overCap ? 'OVER-CAP - ' + e.overCap : (e.error || ''))}`)
}

if (write) {
  const ordered = { _comment: aliases._comment }
  for (const k of Object.keys(aliases).filter(k => k !== '_comment').sort()) ordered[k] = aliases[k]
  fs.writeFileSync(aliasFile, JSON.stringify(ordered, null, 2) + '\n')
  console.log(`\nwrote ${aliasFile}`)
} else {
  console.log('\n(dry run - pass --write to apply)')
}
