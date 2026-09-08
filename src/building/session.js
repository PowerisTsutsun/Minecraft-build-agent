'use strict'

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

// ---------------------------------------------------------------------------
// Session state that has to survive a container restart.
//
// Two separate things live here:
//
// 1. The build origin. Deriving origin from the bot's current position breaks
//    the moment the bot restarts standing on top of its OWN half-built walls:
//    that surface is genuinely solid ground, just not the original floor, so
//    "ground level" and "this build's floor" silently diverge and the whole
//    structure gets replanned floating at the wrong height (0 placed,
//    everything "unreachable", since nothing is adjacent to anything). The fix
//    is to stop re-deriving origin from position once a build has started:
//    compute it fresh only the first time, then persist and reuse it.
//
// 2. The undo log. Every successfully placed block is recorded with what was
//    there before it, so a build can be rolled back in reverse order.
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(__dirname, '..', '..')
const ORIGIN_FILE = path.join(STATE_DIR, '.build-origin.json')
const UNDO_FILE = path.join(STATE_DIR, '.build-undo.json')

// Rolling back more than this many blocks in one go is slower than the build
// was; past it the bot reports the count and asks for a repeat !undo.
const UNDO_BATCH = parseInt(process.env.MC_UNDO_BATCH || '2000', 10)

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return fallback // missing or corrupt - start clean
  }
}

function writeJson (file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value))
    return true
  } catch (err) {
    console.error(`[warn] could not persist ${path.basename(file)}:`, err.message)
    return false
  }
}

// --- origin ---------------------------------------------------------------

function loadOrigin () {
  const raw = readJson(ORIGIN_FILE, null)
  if (raw && typeof raw.x === 'number' && typeof raw.y === 'number' && typeof raw.z === 'number') {
    return new Vec3(raw.x, raw.y, raw.z)
  }
  return null
}

function saveOrigin (origin) {
  return writeJson(ORIGIN_FILE, { x: origin.x, y: origin.y, z: origin.z })
}

function clearOrigin () {
  try { fs.unlinkSync(ORIGIN_FILE) } catch (err) { /* nothing saved - fine */ }
}

// --- undo log -------------------------------------------------------------
//
// Shape: { builds: [ { id, label, startedAt, blocks: [ {x,y,z,placed,previous} ] } ] }
// Newest build last, so undo pops from the end.

function loadLog () {
  const log = readJson(UNDO_FILE, null)
  return (log && Array.isArray(log.builds)) ? log : { builds: [] }
}

function startBuild (label) {
  const log = loadLog()
  log.builds.push({
    id: Date.now().toString(36),
    label,
    startedAt: new Date().toISOString(),
    blocks: []
  })
  writeJson(UNDO_FILE, log)
  return log.builds[log.builds.length - 1].id
}

// Flushing to disk after every single block would mean thousands of
// synchronous writes per build, so placements are buffered and flushed
// periodically (and always at the end of a build). A hard crash can therefore
// lose the last few entries of the undo log - those blocks stay in the world
// and have to be cleared by hand. That is the deliberate trade: a slow build
// loop is a worse failure than a slightly short undo log.
const FLUSH_EVERY = 25
let pending = []

// Periodic flushing is crash-insurance for the WALKING placer, where a build
// runs for hours at about a block every eleven seconds and losing the tail of
// the log matters. It is actively harmful for a command build: flush() re-reads
// and rewrites the whole log file, so 27,000 blocks at one flush per 25 is
// ~1080 rewrites of a file growing past 1.5MB - well over a gigabyte of I/O for
// a single castle, onto an SD card, to insure against a crash in a build that
// finishes in five seconds. Command mode buffers instead and writes once, from
// the same finally block that already guaranteed the final flush.
let buffering = false

function setBuffering (on) {
  buffering = Boolean(on)
}

function recordPlacement (buildId, pos, placedName, previousName) {
  pending.push({
    buildId,
    entry: { x: pos.x, y: pos.y, z: pos.z, placed: placedName, previous: previousName }
  })
  if (!buffering && pending.length >= FLUSH_EVERY) flush()
}

function flush () {
  if (!pending.length) return
  const log = loadLog()
  for (const { buildId, entry } of pending) {
    const build = log.builds.find(b => b.id === buildId)
    if (!build) continue

    // A later action in the same build can overwrite an earlier one at the same
    // coordinate - an LLM plan that puts a glass roof over a box's own stone
    // ceiling does exactly that, and the placer digs the old block out to place
    // the new one. Keeping both entries leaves the log claiming a block that is
    // no longer there. Supersede instead: keep the ORIGINAL `previous` (what
    // was there before this build touched the spot at all, which is what undo
    // reports as destroyed terrain) but take the new `placed`, and move it to
    // the end so reverse-order rollback removes it at the right time.
    const at = build.blocks.findIndex(b => b.x === entry.x && b.y === entry.y && b.z === entry.z)
    if (at !== -1) {
      const original = build.blocks[at].previous
      build.blocks.splice(at, 1)
      build.blocks.push({ ...entry, previous: original })
    } else {
      build.blocks.push(entry)
    }
  }
  writeJson(UNDO_FILE, log)
  pending = []
}

function lastBuild () {
  flush()
  const log = loadLog()
  return log.builds.length ? log.builds[log.builds.length - 1] : null
}

// Replaces the newest build's block list with whatever is left un-undone, or
// drops the build entirely once it is empty.
function updateLastBuild (remainingBlocks) {
  flush()
  const log = loadLog()
  if (!log.builds.length) return
  if (remainingBlocks.length) {
    log.builds[log.builds.length - 1].blocks = remainingBlocks
  } else {
    log.builds.pop()
  }
  writeJson(UNDO_FILE, log)
}

function summary () {
  flush()
  const log = loadLog()
  return log.builds.map(b => ({ id: b.id, label: b.label, count: b.blocks.length }))
}

// Bounds of a build's placed blocks, or null if it recorded none.
function buildBounds (build) {
  if (!build || !build.blocks.length) return null
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const b of build.blocks) {
    lo.x = Math.min(lo.x, b.x); hi.x = Math.max(hi.x, b.x)
    lo.y = Math.min(lo.y, b.y); hi.y = Math.max(hi.y, b.y)
    lo.z = Math.min(lo.z, b.z); hi.z = Math.max(hi.z, b.z)
  }
  return { lo, hi }
}

// Every build still in the log, newest last, with bounds - for listing and for
// finding the one a player is standing in.
function builds () {
  flush()
  return loadLog().builds.map(b => ({ id: b.id, label: b.label, count: b.blocks.length, bounds: buildBounds(b) }))
}

function getBuildById (id) {
  flush()
  return loadLog().builds.find(b => b.id === id) || null
}

// Newest build whose horizontal footprint contains (x, z). Y is ignored so it
// works whether the player stands inside, on top of, or at the foot of it.
function buildAt (x, z) {
  const all = builds().filter(b => b.bounds)
  for (let i = all.length - 1; i >= 0; i--) {
    const { lo, hi } = all[i].bounds
    if (x >= lo.x && x <= hi.x && z >= lo.z && z <= hi.z) return all[i]
  }
  return null
}

function dropBuildById (id) {
  flush()
  const log = loadLog()
  const before = log.builds.length
  log.builds = log.builds.filter(b => b.id !== id)
  if (log.builds.length !== before) writeJson(UNDO_FILE, log)
}

// Replace a specific build's blocks with what is left after a partial removal,
// or drop it once empty.
function updateBuildById (id, remainingBlocks) {
  flush()
  const log = loadLog()
  const build = log.builds.find(b => b.id === id)
  if (!build) return
  if (remainingBlocks.length) build.blocks = remainingBlocks
  else log.builds = log.builds.filter(b => b.id !== id)
  writeJson(UNDO_FILE, log)
}

function clearLog () {
  pending = []
  try { fs.unlinkSync(UNDO_FILE) } catch (err) { /* nothing saved - fine */ }
}

module.exports = {
  buildBounds,
  builds,
  getBuildById,
  buildAt,
  dropBuildById,
  updateBuildById,
  UNDO_BATCH,
  loadOrigin,
  saveOrigin,
  clearOrigin,
  startBuild,
  recordPlacement,
  setBuffering,
  flush,
  lastBuild,
  updateLastBuild,
  summary,
  clearLog
}
