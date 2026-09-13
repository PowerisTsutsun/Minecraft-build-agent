'use strict'

const fs = require('fs')
const path = require('path')
const { SCHEMATIC_DIR } = require('./schematic')

// ---------------------------------------------------------------------------
// Turning a name someone typed into something loadable.
//
// Two sources, in order:
//
//   1. aliases.json - hand-written, the nice names. A value is either a
//      filename or "template:<name>", and a template is the only way to get a
//      build that arrives with its entities and container contents.
//   2. Whatever is sitting in schematics/. A file dropped in is buildable by
//      its own filename with nothing else to edit: copy house9.schem in and
//      "!build house9" works. This is the whole point of the bot - a blueprint
//      folder, not a registry someone has to maintain.
//
// aliases.json wins a clash, so renaming a file cannot silently change what an
// existing name builds.
//
// SECURITY: the name off chat is only ever looked up as a KEY in these maps. It
// is never joined onto a path, so "../../etc/passwd" resolves to null rather
// than reaching outside schematics/. (schematic.js validates again on load; two
// checks, because this one is the only one that sees the raw chat string.)
// ---------------------------------------------------------------------------

const BLUEPRINT_FILE = /\.(schem|schematic|litematic)$/i

// Both readers run per command, not once at startup, so a file copied in or an
// alias edited mid-session takes effect without a restart.
function aliases () {
  try {
    return JSON.parse(fs.readFileSync(path.join(SCHEMATIC_DIR, 'aliases.json'), 'utf8'))
  } catch (err) {
    // No aliases.json at all is a legitimate setup: a fresh checkout where
    // someone has only dropped files in. Missing means empty, not broken.
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

// Keys starting with _ are notes to whoever edits the file, not blueprints.
function aliasNames () {
  return Object.keys(aliases()).filter(k => !k.startsWith('_'))
}

// Every blueprint file in schematics/, keyed by its lowercased basename.
function dropped () {
  const found = {}
  let files = []
  try { files = fs.readdirSync(SCHEMATIC_DIR) } catch (err) { return found }
  for (const file of files.sort()) {
    if (!BLUEPRINT_FILE.test(file)) continue
    const key = file.replace(BLUEPRINT_FILE, '').toLowerCase()
    // house9.schem and house9.litematic both want "house9". Sorted above, so
    // which one wins is stable rather than filesystem order.
    if (!Object.prototype.hasOwnProperty.call(found, key)) found[key] = file
  }
  return found
}

// A leading slash is optional: /house1 is how the list prints them, house1 is
// what someone types after dropping house1.schem in.
//
// hasOwnProperty throughout, or "/constructor" returns an inherited member,
// passes the caller's guard, and dies later with "target.startsWith is not a
// function".
function resolve (name) {
  const key = String(name || '').replace(/^\//, '').toLowerCase()
  if (!key) return null

  const table = aliases()
  if (Object.prototype.hasOwnProperty.call(table, key) && typeof table[key] === 'string') {
    return table[key]
  }
  const files = dropped()
  return Object.prototype.hasOwnProperty.call(files, key) ? files[key] : null
}

// Everything buildable, for the list and for error messages: alias names, plus
// dropped files that no alias already covers.
//
// "Covers" has to mean the FILE, not the name. /house1 points at
// 31497.litematic, so listing 31497 as well offers the same build twice under a
// name nobody chose - and inflated the count of un-named files from 10 to 45.
function names () {
  const table = aliases()
  const named = aliasNames()
  const coveredNames = new Set(named.map(n => n.toLowerCase()))
  const coveredFiles = new Set(
    named.map(n => table[n]).filter(v => typeof v === 'string' && !v.startsWith('template:'))
  )
  const files = dropped()
  const extra = Object.keys(files)
    .filter(k => !coveredNames.has(k) && !coveredFiles.has(files[k]))
  return { named, extra }
}

module.exports = { aliases, aliasNames, dropped, resolve, names, BLUEPRINT_FILE }
