'use strict'

const templates = require('../building/templates')

// ---------------------------------------------------------------------------
// Architectural or functional?
//
// The two need opposite things. A keep should be invented, criticised and
// dressed. A farm should be placed exactly as someone proved it works, with its
// entities summoned, and then left alone - decorating a redstone machine breaks
// it, and inventing one produces a farm-shaped building that makes nothing.
//
// Keywords first because they are free and almost always right; the model is
// only asked when the words genuinely do not settle it.
// ---------------------------------------------------------------------------

const FUNCTIONAL = /\b(farm|grinder|xp|experience|sorter|sorting|redstone|automatic|auto[- ]?\w+|smelter|furnace array|storage system|item elevator|flying machine|piston|clock|portal hub|duper|breeder|spawner|trading hall|villager hall|mob switch|witch hut|guardian|slime|iron golem|creeper|enderman)\b/i

// Words that look mechanical but describe a building people live in.
const ARCHITECTURAL_OVERRIDE = /\b(farmhouse|farmstead|barn|windmill|watermill|granary|stable|farm house)\b/i

function byKeyword (request) {
  if (ARCHITECTURAL_OVERRIDE.test(request)) return { kind: 'architectural', why: 'names a farm building, not a farm' }
  if (FUNCTIONAL.test(request)) return { kind: 'functional', why: 'names a mechanism' }
  return null
}

// Does the request name a template we actually have?
function matchTemplate (request) {
  const words = request.toLowerCase()
  for (const name of templates.list()) {
    const spaced = name.replace(/[_-]/g, ' ')
    if (words.includes(spaced) || words.includes(name)) return name
  }
  return null
}

const CLASSIFY_PROMPT = `Decide whether a Minecraft build request is ARCHITECTURAL or FUNCTIONAL.

FUNCTIONAL means the thing has to work mechanically: farms, grinders, sorters, redstone contraptions, anything whose value is what it produces. Getting a block one square wrong breaks it.

ARCHITECTURAL means the thing has to look right: houses, castles, towers, bridges, walls, decorative builds. A barn or a farmhouse is architectural - it is a building, not a mechanism.

Answer with one word: ARCHITECTURAL or FUNCTIONAL.`

async function classify (request, client, model) {
  const template = matchTemplate(request)
  if (template) return { kind: 'functional', template, why: `matches the ${template} template` }

  const quick = byKeyword(request)
  if (quick) return quick
  if (!client) return { kind: 'architectural', why: 'no keyword matched' }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 16,
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: request }]
    })
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').toUpperCase()
    if (text.includes('FUNCTIONAL')) return { kind: 'functional', why: 'the model called it a mechanism' }
    return { kind: 'architectural', why: 'the model called it a building' }
  } catch (err) {
    return { kind: 'architectural', why: `classifier unavailable (${err.message})` }
  }
}

module.exports = { classify, byKeyword, matchTemplate, FUNCTIONAL, ARCHITECTURAL_OVERRIDE }
