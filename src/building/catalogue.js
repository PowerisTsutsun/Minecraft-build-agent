'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { SCHEMATIC_DIR } = require('./schematic')
const { BLUEPRINT_FILE } = require('./blueprints')

const ROOT = path.join(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Keeping schematics/catalog.json and aliases.json current without anyone
// asking.
//
// A dropped-in file is buildable by its own filename the moment it lands, but
// until the catalogue is rebuilt it has no friendly name, no size in the
// hover text and no line in !build list. Rebuilding was `npm run catalog` -
// which needs a node on the HOST, and the whole promise of this repo is that
// Docker is the only requirement. So the bot does it itself.
//
// Both steps are existing command-line tools rather than functions, so they are
// spawned rather than required: requiring them would run them at import time
// and there is nothing to import back. They are also deliberately re-run as
// whole passes rather than incrementally - catalog.js reads every file to get
// dimensions and a palette, and a wrong incremental result would be worse than
// a slow correct one.
//
// Safe to run unattended: name-schematics.js never touches an alias that
// already exists, and skips terrain, unreadable files, and the raw captures
// behind templates (whose setup.txt is the whole point of them).
// ---------------------------------------------------------------------------

const CATALOG = path.join(SCHEMATIC_DIR, 'catalog.json')

// Newest mtime among the blueprint files, or 0 if there are none.
function newestBlueprint () {
  let newest = 0
  let files = []
  try { files = fs.readdirSync(SCHEMATIC_DIR) } catch (err) { return 0 }
  for (const f of files) {
    if (!BLUEPRINT_FILE.test(f)) continue
    try {
      const t = fs.statSync(path.join(SCHEMATIC_DIR, f)).mtimeMs
      if (t > newest) newest = t
    } catch (err) { /* vanished mid-scan; not our problem */ }
  }
  return newest
}

// Is the catalogue behind the files? Missing counts as stale; an empty folder
// does not, or a fresh clone with no blueprints would rebuild on every boot.
function isStale () {
  const newest = newestBlueprint()
  if (!newest) return false
  let built = 0
  try { built = fs.statSync(CATALOG).mtimeMs } catch (err) { return true }
  return newest > built
}

function run (script, args, onDone) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', script), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('error', err => onDone(err, out))
  child.on('close', code => onDone(code === 0 ? null : new Error(`${script} exited ${code}`), out))
}

// Names name-schematics.js reports adding, for the chat line. Its output rows
// look like:  /house18     31441.schem      25x19x23     1,952 blocks
const ADDED = /^\s+\/(\S+)\s+\S+\.(?:schem|schematic|litematic)\b/gm

let running = false

// Rebuild, then name anything new. `report(err, addedNames)` is called once.
// Never throws: a catalogue that failed to rebuild must not stop the bot, since
// every blueprint is still buildable by filename without it.
function refresh (report) {
  if (running) return report(null, [])
  running = true
  const done = (err, names) => { running = false; report(err, names || []) }

  run('catalog.js', [], (err, out) => {
    if (err) return done(new Error(`catalog: ${err.message}\n${out.trim().split('\n').slice(-3).join('\n')}`))
    run('name-schematics.js', ['--write'], (err2, out2) => {
      if (err2) return done(new Error(`naming: ${err2.message}`))
      const names = []
      let m
      while ((m = ADDED.exec(out2)) !== null) names.push(m[1])
      done(null, names)
    })
  })
}

module.exports = { isStale, refresh, newestBlueprint, CATALOG }
