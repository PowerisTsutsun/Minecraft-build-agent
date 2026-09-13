'use strict'

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// The blueprint folder.
//
//   blueprints/
//     house/japanesehouse.schematic     ->  !build /japanesehouse   (group: house)
//     house/japanesehouse.setup.txt     ->  optional, run after placing
//     house/japanesehouse.meta.json     ->  optional, ground offset etc.
//     tower/wizard.litematic            ->  !build /wizard          (group: tower)
//
// Two rules, and they are the whole system:
//
//   THE FILENAME IS THE NAME. Call the file japanesehouse.schematic and it is
//   /japanesehouse. Nothing to register, no names file to edit, no restart.
//   This replaces aliases.json, which existed only because every file was
//   named after a download id (13305.schematic) and therefore needed a human
//   name bolted on from the side.
//
//   THE FOLDER IS THE GROUP. `!build list` groups by folder, so a folder a user
//   invents - blueprints/ships/ - becomes a section of the list the moment a
//   file lands in it. The groups are not a fixed vocabulary in the code.
//
// A file sitting loose in blueprints/ still works; its group is "other".
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..')
const BLUEPRINT_DIR = process.env.MC_BLUEPRINT_DIR ||
  process.env.MC_SCHEMATIC_DIR || path.join(ROOT, 'blueprints')

const BLUEPRINT_FILE = /\.(schem|schematic|litematic)$/i
const UNGROUPED = 'other'

// A name typed in chat. Deliberately strict: it is used as a KEY in the map
// built below, never joined onto a path, and this keeps it that way even if a
// future caller forgets. No slashes, so no traversal; no dots, so no "..".
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

const nameOf = file => file.replace(BLUEPRINT_FILE, '').toLowerCase()

// Everything in the folder, keyed by name. Read per command rather than cached,
// so a file copied in mid-session needs no restart.
//
// Scans one level of subdirectory. Deeper nesting is ignored rather than
// flattened: blueprints/house/old/thing.schem almost certainly means "parked",
// and silently offering it would be a surprise.
function scan () {
  const found = new Map()   // name -> the entry a bare name resolves to
  const all = []            // every blueprint, including shadowed ones
  const clashes = []

  const addFile = (group, dir, file) => {
    if (!BLUEPRINT_FILE.test(file)) return
    const name = nameOf(file)
    if (!NAME.test(name)) return
    const entry = {
      name,
      group,
      file,
      path: path.join(dir, file),
      // A machine that needs its entities and container contents to work keeps
      // them beside it. Without this an iron farm arrives as a dead shell.
      setup: sidecar(dir, file, '.setup.txt'),
      meta: sidecar(dir, file, '.meta.json')
    }
    all.push(entry)
    const had = found.get(name)
    // A shadowed entry stays in `all`: it is still listed, still buildable, and
    // still reachable as group/name. Dropping it here made the disambiguating
    // form useless for the one case it exists for.
    if (had) { clashes.push({ name, kept: had.path, ignored: entry.path }); return }
    found.set(name, entry)
  }

  let top = []
  try { top = fs.readdirSync(BLUEPRINT_DIR, { withFileTypes: true }) } catch (err) { return { found, all, clashes } }

  // Sorted so a clash resolves the same way on every machine, rather than by
  // whatever order the filesystem happens to return.
  for (const e of top.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue
      const dir = path.join(BLUEPRINT_DIR, e.name)
      let inner = []
      try { inner = fs.readdirSync(dir).sort() } catch (err) { continue }
      for (const f of inner) addFile(e.name.toLowerCase(), dir, f)
    } else {
      addFile(UNGROUPED, BLUEPRINT_DIR, e.name)
    }
  }
  return { found, all, clashes }
}

// <name>.schem -> <name>.setup.txt, when it exists.
function sidecar (dir, file, suffix) {
  const p = path.join(dir, file.replace(BLUEPRINT_FILE, '') + suffix)
  return fs.existsSync(p) ? p : null
}

// Resolve a name typed in chat. The leading slash is optional, and a
// "group/name" form disambiguates when two folders hold the same name.
function resolve (typed) {
  const raw = String(typed || '').replace(/^\//, '').toLowerCase().trim()
  if (!raw) return null

  const { found, all } = scan()

  if (raw.includes('/')) {
    const [group, name] = raw.split('/', 2)
    if (!NAME.test(name || '')) return null
    return all.find(e => e.group === group && e.name === name) || null
  }
  if (!NAME.test(raw)) return null
  return found.get(raw) || null
}

// Everything buildable, grouped by folder, for !build list.
function groups () {
  const { all, clashes } = scan()
  const out = {}
  for (const e of all) (out[e.group] = out[e.group] || []).push(e)
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
  return { groups: out, clashes, total: all.length }
}

const names = () => [...scan().found.keys()].sort()

module.exports = {
  resolve, groups, names, scan,
  BLUEPRINT_DIR, BLUEPRINT_FILE, UNGROUPED, NAME
}
