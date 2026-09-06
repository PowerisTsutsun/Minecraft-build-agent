'use strict'

const views = require('./views')

// ---------------------------------------------------------------------------
// The critic.
//
// One vision call on the isometric render, before a single block is placed.
// Everything else in this codebase checks facts a program can compute - is it
// climbable, does anything float, is that a real block id. What no lint catches
// is "both towers are the same height" or "that whole wall is blank", which are
// the things that actually make a build look generated. Those are visual, so
// the check has to be visual.
//
// It returns a list of problems, not a plan. The architect gets one revision on
// that list, which keeps the loop bounded and keeps authorship in one place.
// ---------------------------------------------------------------------------

const CRITIC_PROMPT = `You are looking at an isometric render of a Minecraft build that has been planned but not yet placed. North is up-left, east is up-right.

List what is visibly wrong with it, as a builder would see it standing outside. Look for:
- masses that are all the same height, or a silhouette with no variation
- large blank wall surfaces with no windows, trim, buttresses or texture
- roofs that are too shallow, flat, or the same material as the walls
- a missing or unreachable front door
- ornament that is obviously misplaced or floating
- anything that reads as generated rather than built

Be specific and brief: at most six problems, each one line, each naming what and where. If the build already looks good, say so and list nothing. Do not suggest a plan, do not describe what is right, and do not repeat the request back.`

async function critique (client, model, blocks, request) {
  const iso = views.isometric(blocks, { tile: 6 })
  if (!iso || !iso.buffer) return { problems: [], skipped: 'nothing to render' }
  if (iso.tooBig) return { problems: [], skipped: 'render too large' }

  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: CRITIC_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: iso.buffer.toString('base64') }
        },
        { type: 'text', text: `The request was: ${request}` }
      ]
    }]
  })

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()

  // One problem per line; drop anything that is clearly not a complaint.
  const problems = text.split('\n')
    .map(l => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(l => l.length > 8 && !/^(the build|this build|looks good|no problems|nothing)/i.test(l))
    .slice(0, 6)

  return { problems, raw: text, png: iso.buffer }
}

module.exports = { critique, CRITIC_PROMPT }
