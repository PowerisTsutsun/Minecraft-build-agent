'use strict'

// One-off: schematics/ + templates/  ->  blueprints/<group>/<name>.<ext>
//
// The old layout had every file named after a download id (13305.schematic) and
// a separate aliases.json mapping those to human names. The new layout makes
// the filename the name and the folder the group, so the alias someone chose
// becomes the filename and the name layer disappears.
//
// Prints a plan and changes nothing. Pass --write to move the files.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OLD = path.join(ROOT, 'schematics')
const TEMPLATES = path.join(ROOT, 'templates')
const NEW = path.join(ROOT, 'blueprints')
const write = process.argv.includes('--write')

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const aliases = read(path.join(OLD, 'aliases.json'))
const catalog = read(path.join(OLD, 'catalog.json'))
const byFile = {}
for (const e of catalog) byFile[e.file] = e

// "build" says nothing to someone reading a list: the eleven files in it are
// castles, a colosseum, a taj mahal, gardens. The rest of the kinds already
// read as groups.
const GROUP = { build: 'landmark' }
const groupFor = kind => GROUP[kind] || kind || 'other'

// Files that should not survive the move, with the reason shown in the plan.
const DROP = new Map()
for (const e of catalog) {
  if (e.overCap) DROP.set(e.file, `over the block cap (${e.blocks.toLocaleString()} blocks) - can only ever be refused`)
  else if (e.kind === 'terrain') DROP.set(e.file, 'a landscape capture, not a build')
  else if (e.kind === 'unreadable') DROP.set(e.file, 'cannot be parsed')
}
DROP.set('test-cube.schem', 'a 3x3 stone cube used to probe the fill path, not a blueprint')

// The raw captures the farm templates were made FROM. The template carries the
// setup.txt - the villagers, the zombie in its boat, the loaded filter hoppers.
// These carry none of it, so building one gets a machine that looks right and
// can never produce. That is exactly the trap the old namer refused to create.
for (const t of ['27169.litematic', '28758.litematic']) {
  if (byFile[t]) DROP.set(t, 'the raw capture behind a farm template - carries no setup.txt, would build a dead machine')
}

const plan = { moves: [], drops: [], templates: [] }

// 1. Named files: the alias becomes the filename.
const namedFiles = new Set()
for (const [name, target] of Object.entries(aliases)) {
  if (name.startsWith('_') || typeof target !== 'string') continue
  if (target.startsWith('template:')) continue
  if (DROP.has(target)) continue
  const e = byFile[target] || {}
  const ext = path.extname(target)
  plan.moves.push({
    from: path.join('schematics', target),
    to: path.join('blueprints', groupFor(e.kind), name + ext),
    why: `/${name}`
  })
  namedFiles.add(target)
}

// 2. Templates: one directory each becomes three files beside each other.
const templateAlias = {}
for (const [name, target] of Object.entries(aliases)) {
  if (typeof target === 'string' && target.startsWith('template:')) templateAlias[target.slice(9)] = name
}
if (fs.existsSync(TEMPLATES)) {
  for (const dir of fs.readdirSync(TEMPLATES).sort()) {
    const full = path.join(TEMPLATES, dir)
    if (!fs.statSync(full).isDirectory()) continue
    const name = templateAlias[dir] || dir
    for (const f of fs.readdirSync(full).sort()) {
      if (/\.bak$|\.\d{4}-\d{2}-\d{2}/.test(f)) { plan.drops.push({ file: path.join('templates', dir, f), why: 'a dated backup' }); continue }
      let to = null
      if (f === `${dir}.schem`) to = `${name}.schem`
      else if (f === 'setup.txt') to = `${name}.setup.txt`
      else if (f === 'meta.json') to = `${name}.meta.json`
      else if (f === 'readme.md') to = `${name}.readme.md`
      if (!to) { plan.drops.push({ file: path.join('templates', dir, f), why: 'not part of a blueprint' }); continue }
      plan.templates.push({ from: path.join('templates', dir, f), to: path.join('blueprints', 'farm', to), why: `/${name}` })
    }
  }
}

// 3. Everything left in schematics/ that nothing pointed at.
for (const f of fs.readdirSync(OLD).sort()) {
  if (!/\.(schem|schematic|litematic)$/i.test(f)) continue
  if (namedFiles.has(f)) continue
  if (DROP.has(f)) { plan.drops.push({ file: path.join('schematics', f), why: DROP.get(f) }); continue }
  const e = byFile[f] || {}
  plan.moves.push({
    from: path.join('schematics', f),
    to: path.join('blueprints', groupFor(e.kind), f),
    why: 'no name was ever chosen - rename the file to name the build'
  })
}

// --- report -----------------------------------------------------------------
const byGroup = {}
for (const m of plan.moves.concat(plan.templates)) {
  const g = m.to.split('/')[1]
  ;(byGroup[g] = byGroup[g] || []).push(m)
}
console.log(`\n=== blueprints/ (${plan.moves.length + plan.templates.length} files) ===`)
for (const g of Object.keys(byGroup).sort()) {
  console.log(`\n  ${g}/  (${byGroup[g].length})`)
  for (const m of byGroup[g].sort((a, b) => a.to.localeCompare(b.to))) {
    console.log(`    ${path.basename(m.to).padEnd(26)} <- ${m.from}`)
  }
}
console.log(`\n=== dropped (${plan.drops.length}) ===`)
for (const d of plan.drops.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`  ${d.file.padEnd(42)} ${d.why}`)
}

if (!write) {
  console.log('\n(dry run - nothing moved. Pass --write to apply.)')
  process.exit(0)
}

// --- apply ------------------------------------------------------------------
// Plain filesystem moves, no git: there is no git inside the bot container and
// no node on the host, so a script needing both could run nowhere. The content
// is byte-identical either way, and `git add -A` detects the renames itself.
const move = (from, to) => {
  fs.mkdirSync(path.join(ROOT, path.dirname(to)), { recursive: true })
  fs.renameSync(path.join(ROOT, from), path.join(ROOT, to))
}
const remove = f => fs.unlinkSync(path.join(ROOT, f))

for (const m of plan.moves.concat(plan.templates)) move(m.from, m.to)
for (const d of plan.drops) remove(d.file)

console.log(`\nmoved ${plan.moves.length + plan.templates.length}, dropped ${plan.drops.length}`)
