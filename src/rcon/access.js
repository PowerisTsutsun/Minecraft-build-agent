'use strict'

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Who may drive the bot.
//
// This matters more than it looks. RCON is CONSOLE level: whoever gets a
// `!build` line into the server log is issuing /fill and /setblock as the
// server itself. There is no permission ceiling below that, so "who may type
// at the bot" is the entire security boundary.
//
// Three modes, set per server in rcon-servers.json as `access`:
//
//   "ops"       (default) anyone the server has opped. Add the bot to a server
//               and every OP can use it, which is what a server owner expects.
//   "everyone"  any player in chat. For a private world or a friends' server
//               where everyone is trusted anyway. Opt-in, never the default.
//   "allow"     only the names in the allow list. The tightest setting.
//
// The `allow` list is additive in every mode: a name on it may always build,
// op or not. That is how a non-OP gets access on a server whose owner does not
// want to op them.
//
// HOW OP STATUS IS KNOWN. Vanilla has no command that reports whether a player
// is an operator - not /data get, not a selector, nothing. The server's
// ops.json is the only source of truth, so the bot reads it. That file is
// outside the world directory, so it needs its own read-only mount; without
// one this falls back to the allow list and says so, loudly, rather than
// quietly letting everyone in or quietly letting nobody in.
// ---------------------------------------------------------------------------

const MODES = new Set(['ops', 'everyone', 'allow'])

// Cheap enough to stat on every command, so an /op takes effect immediately
// rather than at the next restart. Only re-parsed when the file changes.
const cache = new Map()

function readOps (file) {
  if (!file) return { ops: null, why: 'no ops file configured' }
  let stat
  try { stat = fs.statSync(file) } catch (err) {
    return { ops: null, why: `cannot read ${file} (${err.code}) - is it mounted into the container?` }
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value

  let value
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(raw)) throw new Error('not a JSON array')
    // Vanilla writes [{uuid, name, level, bypassesPlayerLimit}]. Level 1 is
    // enough to be an operator; the bot does not need to care beyond that.
    value = { ops: raw.filter(o => o && typeof o.name === 'string').map(o => o.name.toLowerCase()), why: null }
  } catch (err) {
    value = { ops: null, why: `${file} is not readable as ops.json (${err.message})` }
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, value })
  return value
}

// Where ops.json lives, if the entry does not say. The log path is already
// "<server dir>/logs/latest.log" inside the container, and ops.json sits beside
// the logs directory, so it can be derived rather than configured twice.
function opsFileFor (cfg) {
  if (cfg.ops === false) return null
  if (typeof cfg.ops === 'string') return cfg.ops
  if (typeof cfg.log === 'string') return path.join(path.dirname(path.dirname(cfg.log)), 'ops.json')
  return null
}

// Build the access decision for one server entry. Returns helpers plus the
// lines the bot should print at startup, so the operator can see what the
// policy actually resolved to instead of guessing.
function policy (cfg, serverName) {
  const wanted = typeof cfg.access === 'string' ? cfg.access.toLowerCase() : 'ops'
  const allow = (Array.isArray(cfg.allow) ? cfg.allow : []).map(n => String(n).toLowerCase())
  const explicitOperators = Array.isArray(cfg.operators) ? cfg.operators.map(n => String(n).toLowerCase()) : null
  const opsFile = opsFileFor(cfg)
  const notes = []

  let mode = wanted
  if (!MODES.has(mode)) {
    notes.push(`[bot] unknown access mode "${cfg.access}" for "${serverName}" - falling back to "allow". Use ops, everyone or allow.`)
    mode = 'allow'
  }

  // Read once here for the startup diagnosis below, and again on every check
  // (readOps caches on mtime, so it is a stat) - otherwise /op and /deop would
  // not take effect until the bot restarted.
  const { ops, why } = readOps(opsFile)
  const opsNow = () => readOps(opsFile).ops

  // A configured "ops" policy that cannot read ops.json must not silently
  // become "nobody" OR "everybody". It degrades to the allow list and says why.
  if (mode === 'ops' && ops === null) {
    notes.push(`[bot] access "ops" wants the server's ops.json: ${why}`)
    notes.push(`[bot] falling back to the allow list${allow.length ? ` (${allow.join(', ')})` : ' - which is EMPTY, so nobody can build'}.`)
    notes.push('[bot] mount it read-only, e.g.  ./server/data:/servers/mc:ro  in compose.yml')
    mode = 'allow'
  }

  if (mode === 'everyone') {
    notes.push(`[bot] access "everyone" on "${serverName}": ANY player in chat can build, clear and remove.`)
    notes.push('[bot] RCON is console level - only do this where you trust everyone who can join.')
  }
  if (mode === 'allow' && allow.length === 0) {
    notes.push(`[bot] no "allow" list for "${serverName}" and no ops to fall back on - refusing every builder.`)
    notes.push('[bot] set BUILDER in .env, or add "allow": ["YourName"] to that entry.')
  }

  const isOp = player => {
    const list = opsNow()
    return Array.isArray(list) && list.includes(String(player).toLowerCase())
  }

  // May this player build at all?
  const isAllowed = player => {
    const p = String(player).toLowerCase()
    if (allow.includes(p)) return true          // additive in every mode
    if (mode === 'everyone') return true
    if (mode === 'ops') return isOp(p)
    return false
  }

  // May this player remove or undo someone else's build? Explicit `operators`
  // wins; otherwise the server's own ops, and failing that the first allow
  // entry, so a single-player setup needs no extra config.
  const isOperator = player => {
    const p = String(player).toLowerCase()
    if (explicitOperators) return explicitOperators.includes(p)
    if (isOp(p)) return true
    // The first allow entry stands in for an operator ONLY when the server's
    // ops are unknown - that is the single-player case, where there is no
    // ops.json to consult and one name in .env is the whole configuration.
    // With a readable ops.json, being merely allowed to build must not also
    // grant the right to delete other people's builds.
    if (Array.isArray(opsNow())) return false
    return allow.length > 0 && allow[0] === p
  }

  return { mode, isAllowed, isOperator, isOp, notes, opsFile, opsKnown: Array.isArray(ops) }
}

module.exports = { policy, readOps, opsFileFor, MODES }
