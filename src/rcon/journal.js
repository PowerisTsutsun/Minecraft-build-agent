'use strict'

const fs = require('fs')
const path = require('path')

// What the rcon builder placed, so it can be taken back out.
//
// The mineflayer path recorded the previous block per cell and could restore
// terrain. RCON cannot: there is no command that reports what block is at a
// position, so there is nothing to record. What is stored instead is the fill
// boxes, which is enough to clear a build back to air - the same deal the old
// digging undo gave: you get the hole back, not the hill.

// MC_JOURNAL_DIR lets a test point the journal at a temp directory instead of
// the repo root; unset, it is the repo root as before.
const DIR = process.env.MC_JOURNAL_DIR || path.join(__dirname, '..', '..')
const FILE = name => path.join(DIR, `.rcon-undo-${name}.json`)

function load (server) {
  const file = FILE(server)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { builds: [] }   // first run, nothing recorded yet
    throw err                                          // EACCES etc: do NOT silently start empty
  }
  let log
  try {
    log = JSON.parse(text)
  } catch (err) {
    // A parse error used to return {builds:[]}, and the next record() wrote it
    // back - permanently discarding up to 200 build records. Move the damaged
    // file aside instead, so the history is recoverable by hand.
    const aside = `${file}.corrupt-${Date.now()}`
    try { fs.renameSync(file, aside) } catch (e) {}
    console.error(`[journal] ${file} is not valid JSON; moved to ${aside} and starting fresh`)
    return { builds: [] }
  }
  // A truncated-but-valid file ({}), which used to throw on push.
  if (!log || typeof log !== 'object' || !Array.isArray(log.builds)) return { builds: [] }
  return log
}
function save (server, log) {
  // Write-then-rename: a crash partway through writeFileSync truncated the
  // journal into exactly the unparseable state load() has to recover from.
  const file = FILE(server)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2))
  fs.renameSync(tmp, file)
}
// -> the new entry's id.
function record (server, entry) {
  const log = load(server)
  // Date.now().toString(36) alone collided inside one millisecond, and drop()
  // filters by equality - so a collision deleted both records.
  const taken = new Set(log.builds.map(b => b.id))
  let id = Date.now().toString(36)
  while (taken.has(id)) id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  log.builds.push({ id, at: new Date().toISOString(), ...entry })
  if (log.builds.length > 200) log.builds = log.builds.slice(-200)
  save(server, log)
  return id
}

// Merge fields into an existing entry. Used to flip `partial` off once a build
// has actually finished filling.
function update (server, id, fields) {
  const log = load(server)
  const entry = log.builds.find(b => b.id === id)
  if (!entry) return false
  Object.assign(entry, fields)
  save(server, log)
  return true
}
function list (server) { return load(server).builds }
function last (server) { const b = load(server).builds; return b.length ? b[b.length - 1] : null }
function drop (server, id) {
  const log = load(server)
  log.builds = log.builds.filter(b => b.id !== id)
  save(server, log)
}
function findAt (server, x, z) {
  const builds = load(server).builds
  for (let i = builds.length - 1; i >= 0; i--) {
    const b = builds[i]
    if (!b.bounds) continue
    if (x >= b.bounds.lo.x && x <= b.bounds.hi.x && z >= b.bounds.lo.z && z <= b.bounds.hi.z) return b
  }
  return null
}

module.exports = { record, update, list, last, drop, findAt, load, save }
