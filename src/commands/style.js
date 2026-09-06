'use strict'

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// House style: the part of the planner's instructions you can edit without
// touching code.
//
// Two things live here and both are read fresh on every build, so editing a
// file changes the next build with no restart:
//
//   style/guide.md        free text appended to the system prompt
//   style/examples/*.json plans that were built and approved, shown as worked
//                         examples
//
// The examples matter more than the guide. Telling a model "use ornament" is
// weak; showing it a plan that was accepted, with its offsets and its material
// choices intact, is strong. !remember saves the last build as one, so the way
// to teach this bot is to build something, look at it, and keep it.
//
// Everything here is size-capped. A system prompt that grows without bound
// quietly costs more on every single request and eventually crowds out the
// instructions that matter.
// ---------------------------------------------------------------------------

const STYLE_DIR = path.join(__dirname, '..', '..', 'style')
const GUIDE_FILE = path.join(STYLE_DIR, 'guide.md')
const EXAMPLE_DIR = path.join(STYLE_DIR, 'examples')

const MAX_GUIDE_CHARS = 8000
const MAX_EXAMPLES = 3
const MAX_EXAMPLE_CHARS = 4000
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

function readGuide () {
  try {
    const text = fs.readFileSync(GUIDE_FILE, 'utf8').trim()
    if (!text) return null
    if (text.length > MAX_GUIDE_CHARS) {
      console.error(`[style] guide.md is ${text.length} chars - using the first ${MAX_GUIDE_CHARS}`)
      return text.slice(0, MAX_GUIDE_CHARS)
    }
    return text
  } catch (err) {
    return null // no guide is the normal case, not an error
  }
}

// Newest first: the most recently approved build is the most relevant example
// of what this player currently wants things to look like.
function listExamples () {
  let files
  try {
    files = fs.readdirSync(EXAMPLE_DIR).filter(f => f.endsWith('.json'))
  } catch (err) {
    return []
  }

  const found = []
  for (const file of files) {
    const full = path.join(EXAMPLE_DIR, file)
    try {
      const stat = fs.statSync(full)
      const data = JSON.parse(fs.readFileSync(full, 'utf8'))
      if (!data || !Array.isArray(data.actions) || !data.actions.length) continue
      found.push({ name: path.basename(file, '.json'), at: stat.mtimeMs, ...data })
    } catch (err) {
      console.error(`[style] skipping ${file}: ${err.message}`)
    }
  }
  return found.sort((a, b) => b.at - a.at)
}

function saveExample (name, request, plan) {
  if (!NAME.test(name)) throw new Error('name must be lowercase letters, digits, - or _')
  fs.mkdirSync(EXAMPLE_DIR, { recursive: true })
  const body = JSON.stringify({
    request,
    summary: plan.summary,
    actions: plan.actions
  }, null, 2)
  const file = path.join(EXAMPLE_DIR, `${name}.json`)
  fs.writeFileSync(file, body)
  return { file, bytes: body.length, actions: plan.actions.length }
}

function forgetExample (name) {
  if (!NAME.test(name)) throw new Error('name must be lowercase letters, digits, - or _')
  fs.unlinkSync(path.join(EXAMPLE_DIR, `${name}.json`))
}

// The text appended to the system prompt. Returns '' when nothing is
// configured, so an untaught bot behaves exactly as it did before.
function promptSuffix () {
  const parts = []

  const guide = readGuide()
  if (guide) {
    parts.push(`HOUSE STYLE. These are the player's own standing instructions and they override the general guidance above where they disagree.\n\n${guide}`)
  }

  const examples = listExamples().slice(0, MAX_EXAMPLES)
  if (examples.length) {
    const shown = []
    for (const ex of examples) {
      const json = JSON.stringify(ex.actions)
      if (json.length > MAX_EXAMPLE_CHARS) {
        console.error(`[style] example "${ex.name}" is ${json.length} chars - too big to show, skipping`)
        continue
      }
      shown.push(`Request: ${JSON.stringify(ex.request || ex.name)}\nPlan: ${json}`)
    }
    if (shown.length) {
      parts.push(
        'WORKED EXAMPLES. These plans were built and kept by this player. Match their level of detail, their use of ornament and their material choices. Do not copy one literally unless the request genuinely matches it.\n\n' +
        shown.join('\n\n'))
    }
  }

  return parts.length ? '\n\n' + parts.join('\n\n') : ''
}

function describe () {
  const guide = readGuide()
  const examples = listExamples()
  return {
    guide: guide ? guide.length : 0,
    examples: examples.map(e => e.name),
    used: examples.slice(0, MAX_EXAMPLES).map(e => e.name)
  }
}

module.exports = { promptSuffix, describe, saveExample, forgetExample, listExamples, readGuide, STYLE_DIR, GUIDE_FILE, EXAMPLE_DIR, MAX_EXAMPLES }
