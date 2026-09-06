'use strict'

const views = require('./views')

// ---------------------------------------------------------------------------
// The detailer.
//
// Habits cover what every build of a style needs - a cornice, a string course,
// a frame round each window. What they cannot know is that THIS build wants a
// well in its courtyard, a portcullis in its gate, a market stall against the
// south wall. Those are one-off, they depend on what the build is for, and they
// are exactly what makes a place look inhabited rather than issued.
//
// It gets the render and a short vocabulary, and returns a handful of actions
// in the details phase. It may not touch the shell: the massing has already
// been criticised and revised by this point, and letting a last pass move walls
// would put the build back before both.
// ---------------------------------------------------------------------------

const MAX_TOUCHES = 15

const DETAILER_PROMPT = `You are adding the last touches to a Minecraft build that is already planned, decorated and about to be placed. You are looking at an isometric render of it. North is up-left, east is up-right.

Add up to 15 bespoke features the build should have and does not: a well or trough in a courtyard, a portcullis in a gateway, an oriel or balcony on a good facade, a statue or monument, a market stall, benches, a garden bed, crates and barrels by a door, a fire pit, a signpost, furniture in a room.

Rules:
- Use only these ops: blocks, window, door, stairs, column.
- Everything goes in the details phase. Do not add shell or carves.
- Do not add ornament that is already there - no cornices, string courses, window frames, trim bands, battlements, lights on walls, vines or banners. Those are handled.
- Coordinates are absolute, in the same frame as the plan you are given.
- Prefer a few well-placed things over many scattered ones. If the build needs nothing, submit an empty list.`

const TOUCH_TOOL = {
  name: 'submit_details',
  description: 'Submit the bespoke finishing touches for this build.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'One short sentence on what you added.' },
      details: {
        type: 'array',
        description: 'Actions in the details phase. At most 15.',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['blocks', 'window', 'door', 'stairs', 'column'] },
            material: { type: 'string' },
            offset: {
              type: 'object',
              properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } },
              required: ['x', 'y', 'z']
            },
            cells: {
              type: 'array',
              items: {
                type: 'object',
                properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, material: { type: 'string' } },
                required: ['x', 'y', 'z']
              }
            },
            width: { type: 'integer' },
            height: { type: 'integer' },
            depth: { type: 'integer' },
            rise: { type: 'integer' },
            axis: { type: 'string', enum: ['x', 'y', 'z'] },
            ascent: { type: 'string', enum: ['+', '-'] },
            tread: { type: 'string' },
            face: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
            along: { type: 'integer' },
            anchor: { type: 'string', enum: ['corner', 'center'] }
          },
          required: ['op', 'offset']
        }
      }
    },
    required: ['details']
  }
}

const ALLOWED = new Set(['blocks', 'window', 'door', 'stairs', 'column'])

async function detail (client, model, blocks, request, summary) {
  const iso = views.isometric(blocks, { tile: 6 })
  if (!iso || !iso.buffer) return { details: [], skipped: 'nothing to render' }

  const { lo, hi } = views.bounds(blocks)
  const frame = `The build occupies x ${lo.x} to ${hi.x}, y ${lo.y} to ${hi.y}, z ${lo.z} to ${hi.z}. Ground level is y=${lo.y}.`

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: DETAILER_PROMPT,
    tools: [TOUCH_TOOL],
    tool_choice: { type: 'tool', name: 'submit_details' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: iso.buffer.toString('base64') } },
        { type: 'text', text: `The request was: ${request}\nThe plan summary is: ${summary}\n${frame}` }
      ]
    }]
  })

  const call = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_details')
  if (!call || !Array.isArray(call.input.details)) return { details: [], skipped: 'no details returned' }

  // Trust nothing: cap the count and drop anything outside the vocabulary.
  const details = call.input.details
    .filter(a => a && ALLOWED.has(a.op))
    .slice(0, MAX_TOUCHES)

  return { details, note: call.input.note || null, dropped: call.input.details.length - details.length }
}

module.exports = { detail, DETAILER_PROMPT, MAX_TOUCHES }
