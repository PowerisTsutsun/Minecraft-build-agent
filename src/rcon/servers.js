'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Where the bot gets a server to drive.
//
// One loader, because there were three: the bot fell back to the committed
// example when rcon-servers.json was absent, while rcon-build and rcon-export
// exited with "no rcon-servers.json". Same file, three answers.
//
// The committed example is a working config, not a template to fill in. A fresh
// clone should run with nothing copied and nothing edited - the only thing that
// cannot be guessed is WHO is allowed to build, and that comes from the
// environment (see expand below), so it lives in .env with the password rather
// than in a JSON file the user has to find and hand-edit.
// ---------------------------------------------------------------------------

const CANDIDATES = ['rcon-servers.json', 'rcon-servers.example.json']

function sourceFile () {
  const found = CANDIDATES.map(f => path.join(ROOT, f)).find(f => fs.existsSync(f))
  if (!found) {
    throw new Error(`no rcon-servers.json and no rcon-servers.example.json in ${ROOT}`)
  }
  return found
}

// "${BUILDER}" -> the value of $BUILDER.
//
// An unset variable is left ALONE rather than blanked, so each caller can give
// its own error: client.js explains a missing password by name, and the allow
// list below drops the entry so the bot fails closed rather than authorising a
// player literally called "${BUILDER}".
const VAR = /^\$\{(\w+)\}$/

function expand (value) {
  const m = VAR.exec(value || '')
  if (!m) return value
  const got = process.env[m[1]]
  return got === undefined || got === '' ? value : got
}

const unresolved = value => VAR.test(value || '')

// A name list (allow / operators) with unresolved variables and blanks removed.
// Order is kept: operators defaults to the first allow entry elsewhere.
function nameList (list) {
  if (!Array.isArray(list)) return list
  return list.map(expand).filter(n => typeof n === 'string' && n.trim() && !unresolved(n))
}

// The whole table, variables resolved.
function all () {
  const raw = JSON.parse(fs.readFileSync(sourceFile(), 'utf8'))
  const out = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith('_') || !entry || typeof entry !== 'object') continue
    out[name] = Object.assign({}, entry, {
      password: expand(entry.password),
      log: expand(entry.log),
      allow: nameList(entry.allow),
      operators: nameList(entry.operators)
    })
  }
  return out
}

// One entry by name. Throws with the names that DO exist, which is the whole
// question someone has when they get this wrong.
function load (name) {
  const table = all()
  const cfg = table[name]
  if (!cfg) {
    const have = Object.keys(table)
    throw new Error(
      `unknown server "${name}" - ${sourceFile().replace(ROOT + '/', '')} defines: ${have.join(', ') || '(nothing)'}`
    )
  }
  return cfg
}

module.exports = { load, all, sourceFile, expand, nameList, ROOT }
