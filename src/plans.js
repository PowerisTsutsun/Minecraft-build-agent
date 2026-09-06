'use strict'

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Plan archive.
//
// Every !make writes its whole round trip to plans/<timestamp>/: the request,
// each attempt the model returned, the errors it was sent back, the validated
// plan, and what the renderer made of it. Rejected finals are also copied to
// plans/rejected/ as regression fixtures.
//
// This exists because the interesting failures are invisible at build time -
// a plan that seals its own doorway, or floods a channel that protection then
// drains, still reports every block placed. Being able to diff stage by stage
// after the fact is the difference between "the castle looked wrong" and
// "action 17 was dropped by the carve protection".
//
// Logging must never break a build: every write is best-effort.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', 'plans')
const REJECTED = path.join(ROOT, 'rejected')

// Keep the newest N runs. An archive that grows without bound on a Pi's SD
// card is a slow-motion disk-full bug, and these are debugging aids, not
// records worth keeping forever.
const KEEP_RUNS = parseInt(process.env.MC_KEEP_PLANS || '50', 10)

function stamp () {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

function write (file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  } catch (err) {
    console.error(`[plans] could not write ${path.basename(file)}: ${err.message}`)
  }
}

function prune () {
  try {
    const runs = fs.readdirSync(ROOT)
      .filter(name => name !== 'rejected')
      .map(name => ({ name, at: fs.statSync(path.join(ROOT, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of runs.slice(KEEP_RUNS)) {
      fs.rmSync(path.join(ROOT, old.name), { recursive: true, force: true })
    }
  } catch (err) { /* nothing to prune, or no archive yet */ }
}

function startRun (request, kind = 'make') {
  const id = stamp()
  const dir = path.join(ROOT, id)
  write(path.join(dir, 'request.txt'), `${kind}\n${request}\n`)

  return {
    id,
    dir,

    // One model round trip: what came back, and what we told it was wrong.
    attempt (n, raw, errors) {
      write(path.join(dir, `attempt-${n}.json`), JSON.stringify(raw, null, 2))
      if (errors && errors.length) {
        write(path.join(dir, `attempt-${n}-errors.txt`), errors.join('\n') + '\n')
      }
    },

    accepted (plan, out) {
      write(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2))
      const lines = [
        `blocks: ${out.blocks.length}`,
        `dropped by protection: ${out.drops}`,
        `decorator: ${JSON.stringify(out.decor || {})}`,
        '',
        'warnings:',
        ...(out.warnings.length ? out.warnings.map(w => '  ' + w) : ['  (none)'])
      ]
      write(path.join(dir, 'render.txt'), lines.join('\n') + '\n')
      prune()
    },

    rejected (raw, errors) {
      write(path.join(dir, 'rejected.json'), JSON.stringify(raw, null, 2))
      write(path.join(dir, 'rejected-errors.txt'), (errors || []).join('\n') + '\n')
      write(path.join(REJECTED, `${id}.json`), JSON.stringify({ request, errors, plan: raw }, null, 2))
      prune()
    },

    note (name, text) {
      write(path.join(dir, name), text)
    }
  }
}

module.exports = { startRun, ROOT, REJECTED }
