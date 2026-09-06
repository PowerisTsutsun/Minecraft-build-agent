'use strict'

const llm = require('../commands/llm')
const views = require('./views')
const critic = require('./critic')
const detailer = require('./detailer')

// ---------------------------------------------------------------------------
// The !make pipeline, as an explicit sequence of roles.
//
//   architect -> render -> critic -> architect (one revision) -> build
//
// Each role is a function over shared state rather than a class or a queue: the
// whole thing is one process and one conversation, and a state machine that
// fits on a screen is easier to reason about than an orchestrator.
//
// The critic is the only step that costs an extra model call, and --fast skips
// it. Everything before it is local: validation, the render, and the lints.
// ---------------------------------------------------------------------------

async function runMake (opts) {
  const { request, check, archive, fast, client, model, say } = opts
  const state = { request, attempts: 0, revised: false, problems: [] }

  // --- architect ----------------------------------------------------------
  const first = await llm.requestPlan(request, check)
  state.attempts = first.attempts
  if (first.errors.length || !opts.rendered()) {
    state.failed = first.errors
    state.plan = first.plan
    return state
  }

  let { plan, out } = opts.rendered()

  // --- render -------------------------------------------------------------
  if (archive) {
    const written = views.writeViews(archive.dir, out.blocks)
    if (written.length) archive.note('views.md', `views written: ${written.join(', ')}\n`)
  }

  // --- critic -------------------------------------------------------------
  if (!fast && client) {
    try {
      const verdict = await critic.critique(client, model, out.blocks, request)
      state.problems = verdict.problems
      if (archive && verdict.raw) archive.note('critique.txt', verdict.raw + '\n')

      if (verdict.problems.length) {
        if (say) say(`Looking at it: ${verdict.problems[0]}`)
        // --- architect, one revision ---------------------------------------
        const revision = await llm.requestPlan(
          `${request}\n\nA look at the rendered build turned up these problems. Fix them and submit a corrected plan; keep everything that is not named here:\n- ${verdict.problems.join('\n- ')}`,
          check)
        state.attempts += revision.attempts
        if (!revision.errors.length && opts.rendered()) {
          const revised = opts.rendered()
          plan = revised.plan
          out = revised.out
          state.revised = true
          if (archive) views.writeViews(archive.dir + '/revised', out.blocks)
        }
      }
    } catch (err) {
      console.error('[critic] skipped:', err.message)
      state.criticError = err.message
    }
  }

  // --- detailer -----------------------------------------------------------
  // Last, and only ever additive: by this point the massing has been through
  // the critic and a revision, so a pass that could move walls would put the
  // build back before both.
  if (!fast && client && opts.reRender) {
    try {
      const extra = await detailer.detail(client, model, out.blocks, request, plan.summary)
      if (extra.details.length) {
        const merged = opts.reRender(extra.details)
        if (merged) {
          out = merged.out
          plan = merged.plan
          state.detailed = extra.details.length
          state.detailNote = extra.note
          if (archive) {
            archive.note('details.json', JSON.stringify(extra, null, 2) + '\n')
            views.writeViews(archive.dir + '/detailed', out.blocks)
          }
        } else {
          state.detailRejected = true
        }
      }
    } catch (err) {
      console.error('[detailer] skipped:', err.message)
    }
  }

  state.plan = plan
  state.out = out
  return state
}

module.exports = { runMake }
