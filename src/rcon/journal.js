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

const FILE = name => path.join(__dirname, '..', '..', `.rcon-undo-${name}.json`)

function load (server) {
  try { return JSON.parse(fs.readFileSync(FILE(server), 'utf8')) } catch (err) { return { builds: [] } }
}
function save (server, log) {
  fs.writeFileSync(FILE(server), JSON.stringify(log))
}
function record (server, entry) {
  const log = load(server)
  log.builds.push({ id: Date.now().toString(36), at: new Date().toISOString(), ...entry })
  if (log.builds.length > 200) log.builds = log.builds.slice(-200)
  save(server, log)
  return log.builds[log.builds.length - 1]
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

module.exports = { record, list, last, drop, findAt, load }
