'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { BLUEPRINT_FILE, BLUEPRINT_DIR } = require('./blueprints')

const ROOT = path.join(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Keeping blueprints/catalog.json current without anyone asking.
//
// A dropped-in file is buildable and listed the moment it lands - the folder
// is the source of truth. What it does NOT have until the catalogue is rebuilt
// is its size and block count in the hover text. Rebuilding was
// `npm run catalog`, which needs a node on the HOST, and the whole promise of
// this repo is that Docker is the only requirement. So the bot does it itself.
//
// catalog.js is a command-line tool rather than a function, so it is spawned
// rather than required: requiring it would run it at import time and there is
// nothing to import back. It is deliberately a whole pass rather than an
// incremental one - it reads every file to get dimensions and a palette, and a
// wrong incremental result would be worse than a slow correct one.
// ---------------------------------------------------------------------------

const CATALOG = path.join(BLUEPRINT_DIR, 'catalog.json')

// Newest mtime among the blueprint files, or 0 if there are none.
//
// Walks the group folders, not just the root. Blueprints live in
// blueprints/<group>/, so a flat scan here would see nothing and the catalogue
// would never be rebuilt for the one case this exists for: a file dropped in.
function newestBlueprint () {
  let newest = 0
  const look = dir => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const e of entries) {
      if (e.isDirectory()) { if (!e.name.startsWith('.') && dir === BLUEPRINT_DIR) look(path.join(dir, e.name)); continue }
      if (!BLUEPRINT_FILE.test(e.name)) continue
      try {
        const t = fs.statSync(path.join(dir, e.name)).mtimeMs
        if (t > newest) newest = t
      } catch (err) { /* vanished mid-scan; not our problem */ }
    }
  }
  look(BLUEPRINT_DIR)
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

let running = false

// Rebuild the catalogue. `report(err)` is called once. Never throws: a stale
// catalogue costs hover text, nothing more - every blueprint still builds.
function refresh (report) {
  if (running) return report(null)
  running = true
  run('catalog.js', [], (err, out) => {
    running = false
    if (err) return report(new Error(`catalog: ${err.message}\n${out.trim().split('\n').slice(-3).join('\n')}`))
    report(null)
  })
}

module.exports = { isStale, refresh, newestBlueprint, CATALOG }
