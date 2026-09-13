'use strict'

const fs = require('fs')
const path = require('path')
const blueprints = require('./blueprints')
const journal = require('../rcon/journal')

// ---------------------------------------------------------------------------
// Protected volumes.
//
// Some blueprints are machines, and the part that makes them work does not look
// like it. A sorting bank is hoppers and dust buried under a grassy ridge; a
// farm is villagers, a zombie in a boat and three locked hoppers. Fill through
// any of it and you get a machine that still LOOKS right and silently
// misroutes - which is worse than one that is obviously broken.
//
// So a blueprint may declare the volume that must not be built into:
//
//   blueprints/sorter/sorter1.schem          the blocks
//   blueprints/sorter/sorter1.protect.json   the part that must survive
//
//   { "protect": [ { "from": {"x":28,"y":3,"z":27}, "to": {"x":83,"y":13,"z":111} } ],
//     "why": "the sorting banks" }
//
// Coordinates are relative to the blueprint's own corner, so the volume travels
// with the file: place it anywhere and the protection moves with it.
//
// The bot checks a new build against every volume already standing, and refuses
// rather than overwriting. This exists because a terrace was once cut through
// live sorting banks by a check that only looked at the surface block - the
// machinery was buried, the grass above it said "clean ground", and 16 hoppers,
// 4 comparators and 2 repeaters went with it.
// ---------------------------------------------------------------------------

// The declared boxes for one blueprint, in blueprint-relative coordinates.
function boxesFor (entry) {
  if (!entry) return []
  const file = entry.path.replace(blueprints.BLUEPRINT_FILE, '.protect.json')
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return []
    // A malformed protect file must not silently mean "nothing is protected".
    throw new Error(`${path.basename(file)} is not readable: ${err.message}`)
  }
  const list = Array.isArray(raw) ? raw : (raw.protect || [])
  return list
    .filter(b => b && b.from && b.to)
    .map(b => ({
      from: { x: Math.min(b.from.x, b.to.x), y: Math.min(b.from.y, b.to.y), z: Math.min(b.from.z, b.to.z) },
      to: { x: Math.max(b.from.x, b.to.x), y: Math.max(b.from.y, b.to.y), z: Math.max(b.from.z, b.to.z) },
      why: b.why || raw.why || 'declared protected'
    }))
}

// Every protected volume standing in the world, in world coordinates.
//
// A journal entry records where a build landed. `origin` is written by newer
// entries; older ones fall back to the low corner of their bounds, which is the
// same thing for any blueprint rebased to its own minimum corner (schematic.js
// does that on load, so it holds for every file the bot places).
function placed (server) {
  const out = []
  for (const build of journal.list(server)) {
    if (!build || !build.bounds) continue
    const entry = blueprints.resolve(build.label)
    if (!entry) continue
    let boxes
    try { boxes = boxesFor(entry) } catch (err) { out.push({ label: build.label, error: err.message }); continue }
    if (!boxes.length) continue
    const o = build.origin
      ? { x: build.origin[0], y: build.origin[1], z: build.origin[2] }
      : { x: build.bounds.lo.x, y: build.bounds.lo.y, z: build.bounds.lo.z }
    for (const b of boxes) {
      out.push({
        label: build.label,
        id: build.id,
        why: b.why,
        lo: { x: o.x + b.from.x, y: o.y + b.from.y, z: o.z + b.from.z },
        hi: { x: o.x + b.to.x, y: o.y + b.to.y, z: o.z + b.to.z }
      })
    }
  }
  return out
}

const overlaps = (a, b) =>
  a.lo.x <= b.hi.x && a.hi.x >= b.lo.x &&
  a.lo.y <= b.hi.y && a.hi.y >= b.lo.y &&
  a.lo.z <= b.hi.z && a.hi.z >= b.lo.z

// Which protected volumes would this build cut into? `bounds` is {lo,hi} in
// world coordinates - exactly what fillBlocks reports from a dry run.
function conflicts (server, bounds, opts = {}) {
  if (!bounds || !bounds.lo || !bounds.hi) return []
  const ignoreId = opts.ignoreId || null
  return placed(server)
    .filter(p => p.error || (p.id !== ignoreId && overlaps(bounds, p)))
}

module.exports = { boxesFor, placed, conflicts, overlaps }
