'use strict'

const { MAX_SIZE, MIN_SIZE, MAX_BLOCKS, MAX_ACTIONS } = require('../config')
const style = require('./style')
const { baseName, isValidSpec, familyVariant, hasState: hasStateFor } = require('../building/blockspec')
const render = require('../building/render')
const macros = require('../building/macros')
const paletteLib = require('../building/palette')

// ---------------------------------------------------------------------------
// Natural language -> structured building actions, via the Claude API.
//
// The model never gets to touch the world. It returns a plan - a list of
// actions naming the primitives in src/building/primitives.js - and that plan
// goes through validatePlan() before a single block is placed. Anything the
// validator doesn't recognise is rejected outright rather than best-guessed,
// because "I misread the request and built a 30k-block tower" is expensive to
// undo and cheap to prevent.
//
// The plan is also exactly what dry-run mode prints, so the natural-language
// path gets reviewed the same way a hand-typed !build does.
// ---------------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5'

const SYSTEM_PROMPT = `You turn a plain-English Minecraft building request into a structured plan. You choose the style, the massing and the parameters; the code works out every block position, every block state and all the ornament.

COORDINATES. x is east, z is south, y is up. y=0 is ground level. Every action has an offset and an anchor: anchor "center" - the default for round shapes - puts the offset at the shape's centre column, "corner" at its lowest, smallest corner. Round shapes take diameter as well as radius. Negative offsets are fine.

THE PLAN HAS THREE PHASES, rendered shell, then carves, then details, whatever order you write them in:
- shell: solid masses. Plinths, walls, floors, towers, roofs.
- carves: openings, material 'air'. Interiors, doorways, windows.
- details: everything applied on top. Trim, furniture, staircases.
A cell opened in carves is protected: a later bulk shape that tries to fill it is dropped. You cannot seal your own doorway. Do not re-emit a shape you have already placed - that is refused - and keep a carve strictly smaller than the shell it hollows.

MACROS. Prefer these. One action becomes a finished building - floors, a stair that lands on each of them, windows per storey, a door, a roof - with the arithmetic done for you:
- tower: diameter, height, storeys, top (cone | battlements | belfry), windows_per_storey, trim_every, spiral, door_face
- hall: width, depth, storeys, roof, bays, corner_posts, door {face, along}
- curtain_wall: from {x,z}, to {x,z}, height, thickness, slit_every
- gatehouse: passage_width, tower_diameter, height, portcullis

SHAPES, for what the macros do not cover:
- floor, wall, box, sphere, cylinder, pyramid: solid masses. hollow defaults true
- roof: kind (gable | hip | cone | mansard | pagoda | onion), width, depth, overhang. Always prefer this to a flat slab
- eaves, trim_band, battlements, plinth, column, pilaster, buttress: dressing around a footprint
- window: face, along, width, height, style (plain | arched | mullion). Carves, glazes and frames itself
- door: face, along, width, height, arched. Carves and hangs real doors
- arch: the opening under an arch, extruded through a wall
- blocks: an explicit list of cells, for detail no shape expresses

STAIRS. Use the stairs op for every flight except inside a round tower, where spiral belongs. A straight flight is width wide, climbs rise blocks along axis in the ascent direction, and gets a solid mass underneath, stepped stringers in a contrasting block, and posts with lights at each end. Set offset.y to the floor you leave and rise to the exact difference to the floor you arrive at, so the top tread is flush with it. Break anything over 8 steps with landing_every, and use turn for an L-shaped stair. Pair a wooden tread with a stone stringer or the reverse; never the same block for both. A spiral's top tread is at offset.y + height - 1: set height to land that on the floor it serves. Both carve their own headroom and punch through the floors they pass.

PALETTE. Name one - medieval_stone, nordic, gothic, desert, japanese, dwarven, fantasy_glow, brick_townhouse - and then write slot names instead of block ids anywhere a material is asked for: wall, trim, roof, accent, floor, glass, base_rough, upper. Override a slot inline if you need to. Real block ids still work everywhere. Materials are snake_case with no minecraft: prefix, and must exist - never invent one. A material may carry a state in square brackets, oak_log[axis=x], but you rarely need to: every op computes its own.

DECOR. Pick a style in decor - medieval_stone, timber_castle, fantasy_spire, or plain - and the decorator adds corbels, string courses, quoins, window frames, arrow slits, lights, weathering, crowns, vines and banners by itself, finding its own surfaces. Do not hand-place ornament a habit already covers. decor.intensity scales it; decor.skip turns individual habits off.

WHERE TO SPEND YOUR ACTIONS. Massing, and the things no habit can know about. Two or three volumes of different heights, one dominant; a keep taller than its towers; a wing that steps back. Then the bespoke: a well in the courtyard, a portcullis, a market stall.

Think in this order before you write the plan: the style; the massing; the bay grid the openings will sit on; the openings; the bespoke details.

WORKED EXAMPLE - a cottage:
{"summary":"A spruce and stone cottage with a gabled roof","palette":{"name":"nordic"},"decor":{"style":"timber_castle"},"shell":[{"op":"hall","offset":{"x":0,"y":0,"z":0},"anchor":"corner","width":9,"depth":13,"storeys":1,"roof":"gable","door":{"face":"south","along":4}}],"details":[{"op":"blocks","material":"accent","offset":{"x":10,"y":1,"z":6},"cells":[{"x":0,"y":0,"z":0},{"x":1,"y":0,"z":0}]}]}

WORKED EXAMPLE - a keep:
{"summary":"A curtain-walled keep with a gatehouse and a great hall","palette":{"name":"medieval_stone"},"decor":{"style":"medieval_stone","intensity":0.7},"shell":[{"op":"curtain_wall","offset":{"x":0,"y":0,"z":0},"from":{"x":0,"z":0},"to":{"x":44,"z":0},"height":9},{"op":"curtain_wall","offset":{"x":0,"y":0,"z":0},"from":{"x":0,"z":40},"to":{"x":44,"z":40},"height":9},{"op":"tower","offset":{"x":0,"y":0,"z":0},"diameter":9,"height":24,"storeys":4,"top":"battlements"},{"op":"tower","offset":{"x":44,"y":0,"z":0},"diameter":9,"height":18,"storeys":3,"top":"cone"},{"op":"gatehouse","offset":{"x":18,"y":0,"z":38},"passage_width":3,"height":13},{"op":"hall","offset":{"x":8,"y":0,"z":12},"anchor":"corner","width":15,"depth":21,"storeys":2,"roof":"gable"}]}

Prefer a build someone standing next to it would call deliberate.`

// One action schema object, referenced three times. Written as a shared JS
// value rather than a JSON Schema $ref, because $ref resolution is not
// something to assume of a tool-schema validator - inlining it is unambiguous.
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: ['floor', 'wall', 'box', 'sphere', 'house', 'cylinder', 'cone', 'pyramid', 'gable', 'arch', 'stairs', 'window', 'door', 'eaves', 'trim_band', 'battlements', 'pilaster', 'buttress', 'plinth', 'column', 'roof', 'tower', 'hall', 'curtain_wall', 'gatehouse', 'spiral', 'blocks']
    },
    material: {
      type: 'string',
      description: 'Block id, snake_case, no minecraft: prefix. May carry a block state: stone_brick_stairs[facing=east,half=bottom].'
    },
    offset: {
      type: 'object',
      description: 'Position of this shape relative to the build origin.',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } },
      required: ['x', 'y', 'z']
    },
    anchor: {
      type: 'string',
      enum: ['corner', 'center'],
      description: "Where the offset sits. 'center' - the default for round shapes - means the offset is the shape's centre column; 'corner' means its lowest, smallest corner."
    },
    width: { type: 'integer', description: 'x extent. floor, box, house, pyramid, gable.' },
    depth: { type: 'integer', description: 'z extent. floor, box, house, pyramid, gable. Also arch: how far it is extruded.' },
    height: { type: 'integer', description: 'y extent. wall, box, house, cylinder, cone, pyramid, arch, spiral.' },
    length: { type: 'integer', description: 'wall only: how long the wall runs.' },
    radius: { type: 'integer', description: 'sphere, cylinder, cone, spiral.' },
    diameter: { type: 'integer', description: 'Alternative to radius for round shapes, if that is how you are thinking about it.' },
    axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'wall, gable, arch: x or z. cylinder: x, y or z (y is upright).' },
    cells: {
      type: 'array',
      description: 'blocks op only: individual blocks, positioned relative to this action offset. Give the action one material and list bare coordinates here, unless the cells genuinely differ.',
      items: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          z: { type: 'integer' },
          material: { type: 'string', description: "Optional - defaults to this action's own material." }
        },
        required: ['x', 'y', 'z']
      }
    },
    hollow: { type: 'boolean', description: 'box, sphere, cylinder, cone, pyramid. Defaults true.' },
    ascent: { type: 'string', enum: ['+', '-'], description: 'stairs: which way along the axis the flight climbs.' },
    rise: { type: 'integer', description: 'stairs: how many blocks the flight climbs. Exactly the floor-to-floor difference.' },
    tread: { type: 'string', description: 'stairs: the step block, a *_stairs id. A plain material is looked up.' },
    fill: { type: 'string', description: 'stairs: the solid mass under the treads. Defaults to the block the tread is made of.' },
    stringer: { type: 'string', description: 'stairs: the stepped side wall, in a contrasting block. null for none.' },
    sides: { type: 'string', enum: ['both', 'left', 'right', 'none'], description: 'stairs: which sides carry a stringer. Default both.' },
    post_height: { type: 'integer', description: 'stairs: how far the end posts stand above their tread. Default 3, 0 for none.' },
    lights: { type: 'string', enum: ['torch', 'lantern', 'none'], description: 'stairs: what sits on the posts. Default torch.' },
    light_every: { type: 'integer', description: 'stairs: also light the stringer every N steps. Default 4.' },
    landing_every: { type: 'integer', description: 'stairs: flat landing after every N steps. Use on anything over 8.' },
    turn: { type: 'string', enum: ['none', 'left', 'right'], description: 'stairs: turn 90 degrees at each landing.' },
    flare: { type: 'integer', description: 'stairs: widen the bottom N steps by one each side. 0-2.' },
    storeys: { type: 'integer', description: 'tower, hall: how many floors. Each is 5 blocks.' },
    spiral: { type: 'boolean', description: 'tower: put a staircase inside. Default true.' },
    top: { type: 'string', enum: ['cone', 'battlements', 'belfry'], description: 'tower: how it finishes.' },
    windows_per_storey: { type: 'integer', description: 'tower: windows around each storey.' },
    trim_every: { type: 'integer', description: 'tower: a banding course every N levels.' },
    bays: { type: 'integer', description: 'hall: how many structural bays along its length.' },
    corner_posts: { type: 'boolean', description: 'hall: logs at the corners. Default true.' },
    door: {
      type: 'object',
      description: 'hall: where the entrance goes.',
      properties: { face: { type: 'string', enum: ['north', 'south', 'east', 'west'] }, along: { type: 'integer' } }
    },
    from: { type: 'object', description: 'curtain_wall: start point, relative to offset.', properties: { x: { type: 'integer' }, z: { type: 'integer' } } },
    to: { type: 'object', description: 'curtain_wall: end point, relative to offset.', properties: { x: { type: 'integer' }, z: { type: 'integer' } } },
    thickness: { type: 'integer', description: 'curtain_wall: how thick. Minimum 2 so it carries a walkway.' },
    slit_every: { type: 'integer', description: 'curtain_wall: an arrow slit every N blocks.' },
    passage_width: { type: 'integer', description: 'gatehouse: how wide the gateway is.' },
    tower_diameter: { type: 'integer', description: 'gatehouse: the flanking towers.' },
    portcullis: { type: 'boolean', description: 'gatehouse: iron bars across the passage. Default true.' },
    kind: { type: 'string', enum: ['gable', 'hip', 'cone', 'mansard', 'pagoda', 'onion'], description: 'roof only: which roof form.' },
    overhang: { type: 'integer', description: 'roof: how far past the wall it projects. Default 1 - a flush roof looks generated.' },
    gable_fill: { type: 'string', description: 'roof gable: the block that fills the triangular ends.' },
    ridge: { type: 'string', description: 'roof gable: a capping course along the ridge line.' },
    proud: { type: 'integer', description: 'eaves, trim_band, battlements: how far outside the footprint they sit.' },
    grow: { type: 'integer', description: 'plinth: how much wider than the building, each side. Default 1.' },
    cap: { type: 'string', description: 'battlements: a slab on top of each merlon.' },
    face: { type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'window, door: which wall of the footprint it sits in.' },
    along: { type: 'integer', description: 'window, door: how far along that wall, from its lowest corner.' },
    footprint: {
      type: 'object',
      description: 'window, door: the building footprint the opening belongs to, so the wall can be found for you.',
      properties: { width: { type: 'integer' }, depth: { type: 'integer' } }
    },
    style: { type: 'string', enum: ['plain', 'arched', 'mullion'], description: 'window only.' },
    arched: { type: 'boolean', description: 'door only.' },
    frame: { type: 'string', description: 'window, door: trim around the opening.' },
    glass: { type: 'string', description: 'window: what to glaze with. Defaults to glass_pane.' },
    door_block: { type: 'string', description: 'door: a real door, e.g. oak_door. Facing, half and hinge are computed.' },
    railing: { type: 'string', description: 'spiral: a wall or fence block for the open side. Omitted means no railing.' },
    column: { type: 'string', description: 'spiral: the central column block. Defaults to the solid the tread is made of.' },
    rise_per_tread: { type: 'number', enum: [0.5, 1], description: 'spiral: 0.5 gives a gentler stair of alternating slabs.' },
    stringer_pattern: {
      type: 'array',
      items: { type: 'string' },
      description: 'stairs: alternate the stringer block per step, e.g. ["oak_log[axis=y]", "oak_leaves"].'
    }
  },
  required: ['op', 'offset']
}

const PLAN_TOOL = {
  name: 'submit_build_plan',
  description: 'Submit the build, in three phases. They are rendered shell, then carves, then details, whatever order you write them in.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One short sentence describing what will be built, for the player to read in chat.'
      },
      palette: {
        type: 'object',
        description: 'The blocks this build is made of. Name one of the shipped palettes and any material in the plan may then be a slot name - "wall", "trim", "roof", "accent", "floor", "glass", "base_rough", "upper" - instead of a block id. Override individual slots inline.',
        properties: {
          name: { type: 'string', enum: ['medieval_stone', 'nordic', 'gothic', 'desert', 'japanese', 'dwarven', 'fantasy_glow', 'brick_townhouse'] },
          wall: { type: 'object', properties: { base: { type: 'string' }, variants: { type: 'array', items: { type: 'string' } }, weathering: { type: 'number' } } },
          trim: { type: 'string' },
          roof: { type: 'string' },
          accent: { type: 'string' },
          floor: { type: 'string' },
          glass: { type: 'string' },
          base_rough: { type: 'string' },
          upper: { type: 'string' }
        }
      },
      decor: {
        type: 'object',
        description: 'Which set of builder habits to apply after the shell is carved. The decorator finds its own surfaces - you do not place any of it yourself.',
        properties: {
          style: { type: 'string', enum: ['medieval_stone', 'timber_castle', 'fantasy_spire', 'plain'] },
          intensity: { type: 'number', description: '0 to 1, scales how much of the optional dressing goes on. Default 0.7.' },
          gradient: { type: 'boolean', description: 'Let the wall material change with height.' },
          greenery: { type: 'boolean' },
          banners: { type: 'string', description: 'Banner colour, e.g. "red".' },
          trim: { type: 'string', description: 'Override the contrasting block the habits use. Defaults per style.' },
          skip: { type: 'array', items: { type: 'string' }, description: 'Names of habits to leave off.' }
        },
        required: ['style']
      },
      shell: {
        type: 'array',
        description: 'Solid masses: plinth, walls, floors, towers, roofs. Rendered first.',
        items: ACTION_SCHEMA
      },
      carves: {
        type: 'array',
        description: "Openings, material 'air': room interiors, doorways, windows, arches. Rendered second, and what they open stays open.",
        items: ACTION_SCHEMA
      },
      details: {
        type: 'array',
        description: 'Applied on top: trim, eaves, battlements, glazing, lights, furniture, staircases. Rendered last.',
        items: ACTION_SCHEMA
      }
    },
    required: ['summary', 'shell']
  }
}

// Op tables, shared by the validator and by planToBlocks so the two can never
// drift into disagreeing about what an op needs.
const OPS = ['floor', 'wall', 'box', 'sphere', 'house', 'cylinder', 'cone', 'pyramid', 'gable', 'arch', 'stairs', 'window', 'door', 'eaves', 'trim_band', 'battlements', 'pilaster', 'buttress', 'plinth', 'column', 'roof', 'tower', 'hall', 'curtain_wall', 'gatehouse', 'spiral', 'blocks']

const REQUIRED_DIMS = {
  floor: ['width', 'depth'],
  wall: ['length', 'height'],
  box: ['width', 'depth', 'height'],
  sphere: ['radius'],
  house: ['width', 'depth', 'height'],
  cylinder: ['radius', 'height'],
  cone: ['radius', 'height'],
  pyramid: ['width', 'depth', 'height'],
  gable: ['width', 'depth'],
  arch: ['width', 'height'],
  stairs: ['width', 'rise'],
  window: ['width', 'height'],
  door: ['width', 'height'],
  eaves: ['width', 'depth'],
  trim_band: ['width', 'depth'],
  battlements: ['width', 'depth'],
  pilaster: ['height'],
  buttress: ['height'],
  plinth: ['width', 'depth'],
  column: ['height'],
  roof: [],
  spiral: ['radius', 'height'],
  blocks: []
}

// Dimensions an op accepts but can do without.
const OPTIONAL_DIMS = { arch: ['depth'], battlements: ['height'], plinth: ['height'], pilaster: ['width'], buttress: ['width'], roof: ['width', 'depth', 'height', 'radius'] }

// Which axes each op understands. A cylinder is the only one that can stand up.
const ALLOWED_AXES = { cylinder: ['x', 'y', 'z'], column: ['x', 'y', 'z'], wall: ['x', 'z'], gable: ['x', 'z'], arch: ['x', 'z'], stairs: ['x', 'z'], roof: ['x', 'z'] }

// The `blocks` escape hatch is per-block detail, not a way to smuggle a whole
// build past the shape validator - hence a hard cap on both count and reach.
const MAX_CELLS = 512
const CELL_REACH = 96


// A tread must be a stairs block and the mass under it must not be. Both are
// derivable from one material, so the model only has to name what the stair is
// made of - and if it names the stair block itself, the fill is derived back.
const WOODS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)$/

// Vanilla is inconsistent about which stone variants get a stairs block:
// sandstone and smooth_sandstone have one, cut_sandstone does not; deepslate
// tiles and bricks do, plain deepslate does not. So the search widens from the
// exact family outward, stripping the qualifier last - cut_sandstone finds
// sandstone_stairs, which is the right-looking answer rather than a failure.
const QUALIFIERS = /^(cut|smooth|polished|chiseled|cracked|mossy)_/

function stairsFor (material, isKnownBlock) {
  if (/_stairs$/.test(baseName(material))) return material
  const b = baseName(material)
  const guesses = [
    b.replace(/_planks$/, '') + '_stairs',
    b.replace(/_bricks$/, '_brick') + '_stairs',
    b.replace(/_tiles$/, '_tile') + '_stairs',
    b.replace(/s$/, '') + '_stairs', // bricks -> brick_stairs
    b.replace(/_log$|_stem$/, '') + '_stairs', // stripped_oak_log -> oak_stairs
    b.replace(/^stripped_/, '').replace(/_log$|_stem$/, '') + '_stairs',
    b + '_stairs'
  ]
  if (QUALIFIERS.test(b)) {
    const plain = b.replace(QUALIFIERS, '')
    guesses.push(plain + '_stairs', plain.replace(/_bricks$/, '_brick') + '_stairs')
  }
  const found = guesses.find(g => isKnownBlock(g))
  if (found) return found
  // Nothing in the family has stairs (plain deepslate, most terracotta). A
  // near-miss in the right colour beats refusing to build - the caller only
  // ever wants "something stair-shaped that suits this material".
  return isKnownBlock('stone_brick_stairs') ? 'stone_brick_stairs' : null
}

function fillFor (tread, isKnownBlock) {
  const b = baseName(tread).replace(/_stairs$/, '')
  const guesses = [
    /_brick$/.test(b) ? b + 's' : null,
    /_tile$/.test(b) ? b + 's' : null,
    WOODS.test(b) ? b + '_planks' : null,
    b === 'quartz' || b === 'purpur' ? b + '_block' : null,
    b
  ].filter(Boolean)
  return guesses.find(g => isKnownBlock(g)) || tread
}

let cachedClient = null

function getClient () {
  if (cachedClient) return cachedClient
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set - add it to docker/.env and restart the container')
  }
  const Anthropic = require('@anthropic-ai/sdk')
  cachedClient = new Anthropic() // reads ANTHROPIC_API_KEY from the environment
  return cachedClient
}

// Asks Claude for a plan. Returns { summary, actions } - unvalidated.
async function callModel (messages) {
  const client = getClient()

  // Read the house style fresh every time, so editing style/guide.md or saving
  // a new example changes the very next build with no restart.
  const system = SYSTEM_PROMPT + style.promptSuffix()

  // Streamed, because a detailed plan is a lot of output. A castle is a
  // hundred-odd actions of JSON, and a non-streaming request with a max_tokens
  // that large risks the SDK's HTTP timeout. Streaming lifts that constraint;
  // .finalMessage() still hands back the whole response.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system,
    tools: [PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'submit_build_plan' },
    messages
  })
  const response = await stream.finalMessage()

  if (response.stop_reason === 'refusal') {
    const why = response.stop_details ? response.stop_details.explanation : 'no explanation given'
    throw new Error(`the model declined that request (${why})`)
  }

  const call = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_build_plan')
  if (!call) throw new Error('the model did not return a build plan')

  return { response, call }
}

// Ask for a plan, and hand any problems straight back to the model.
//
// `check` returns { errors } for a candidate plan - validation plus the
// overwrite lint. Rather than failing a build over a fixable mistake (an
// invented block id, a carve as wide as its own wall, a shape burying another),
// the errors go back as the tool_result for the call that produced them and the
// model gets to correct itself. Two retries, then it fails to chat as before.
//
// The assistant turn is echoed back as `response.content` unchanged, thinking
// blocks included - the API requires that when continuing a thinking model.
const MAX_RETRIES = 2

async function requestPlan (request, check) {
  const messages = [{ role: 'user', content: request }]
  let last = null

  for (let attempt = 0; ; attempt++) {
    const { response, call } = await callModel(messages)
    last = call.input

    if (typeof check !== 'function') return { plan: last, attempts: attempt + 1, errors: [] }

    const result = check(call.input)
    if (!result.errors.length) return { plan: last, checked: result, attempts: attempt + 1, errors: [] }
    if (attempt >= MAX_RETRIES) return { plan: last, checked: result, attempts: attempt + 1, errors: result.errors }

    console.error(`[!make] attempt ${attempt + 1} rejected:\n  - ${result.errors.join('\n  - ')}`)
    messages.push({ role: 'assistant', content: response.content })
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: call.id,
        is_error: true,
        content: `That plan was rejected:\n- ${result.errors.join('\n- ')}\n\nFix these and submit a corrected plan. Change only what is wrong; keep the rest of the design.`
      }]
    })
  }
}

// ---------------------------------------------------------------------------
// Validation.
//
// Everything the model sends is treated as untrusted input: block names are
// checked against the server's own registry, every dimension is clamped, and
// the total block count is capped. A plan that fails validation is reported
// back with the reason rather than partially executed.
// ---------------------------------------------------------------------------

// Round shapes anchor on their centre by default, rectangular ones on their
// corner. Centring a dome on a tower used to be arithmetic the model had to do
// in its head, and getting it wrong hung the dome off the side of the tower.
const CENTRED_BY_DEFAULT = new Set(['sphere', 'cylinder', 'cone', 'spiral'])

// Flatten { shell, carves, details } into one ordered list, tagging each action
// with the phase it came from. The phase order IS the render order, which is
// what makes it impossible for a plan to seal its own doorway.
function phasedActions (plan, macroPalette) {
  const raw = []
  if (Array.isArray(plan.actions)) {
    // Legacy single-list plans - saved examples, and the older tests.
    for (const action of plan.actions) raw.push({ action, phase: 'shell' })
  } else {
    for (const phase of ['shell', 'carves', 'details']) {
      const list = plan[phase]
      if (!Array.isArray(list)) continue
      for (const action of list) raw.push({ action, phase })
    }
  }

  // A macro expands into ordinary actions, each landing in its own phase - a
  // tower's shaft in shell, its windows in carves, its roof in details -
  // whichever phase the macro itself was written in. Expanding here means
  // protection, the overwrite lint, the decorator and the archive all treat
  // macro output exactly like anything else, and none of them has to know that
  // macros exist.
  const out = []
  let macroSeq = 0
  for (const { action, phase } of raw) {
    if (!action || !macros.isMacro(action.op)) {
      out.push({ action, phase })
      continue
    }
    const instance = `${action.op}#${macroSeq++}`
    let parts
    try {
      parts = macros.expand(action, macroPalette)
    } catch (err) {
      out.push({ action: { ...action, __macroError: err.message }, phase })
      continue
    }
    // Tag the provenance so the lint can tell the model's own actions from
    // ones it has no way to change.
    for (const sub of parts.shell) out.push({ action: { ...sub, __macro: action.op, __instance: instance }, phase: 'shell' })
    for (const sub of parts.carves) out.push({ action: { ...sub, __macro: action.op, __instance: instance }, phase: 'carves' })
    for (const sub of parts.details) out.push({ action: { ...sub, __macro: action.op, __instance: instance }, phase: 'details' })
  }
  return out
}

function validatePlan (plan, isKnownBlock) {
  const errors = []
  const paletteWarnings = []

  if (!plan || typeof plan !== 'object') return { errors: ['plan was not an object'] }

  // Macros read the palette directly so their component actions carry real
  // block ids; slot resolution below then leaves them alone.
  const macroPre = plan.palette !== undefined ? paletteLib.build(plan.palette, isKnownBlock) : null
  const incoming = phasedActions(plan, macroPre ? macroPre.table : null)
  if (!incoming.length) return { errors: ['plan contained no actions'] }
  if (incoming.length > MAX_ACTIONS) {
    return { errors: [`plan had ${incoming.length} actions, which is more than the ${MAX_ACTIONS} this bot will run at once`] }
  }

  // The palette resolves slot names, so it has to exist before any material is
  // checked against the registry - otherwise "wall" is rejected as an unknown
  // block rather than resolved to one.
  let palette = null
  if (plan.palette !== undefined) {
    const built = paletteLib.build(plan.palette, isKnownBlock)
    if (built) {
      palette = built
      for (const w of built.warnings) paletteWarnings.push(w)
    }
  }
  const slot = m => paletteLib.resolve(palette, m)

  const clean = []

  incoming.forEach(({ action, phase }, i) => {
    const where = `${phase} action ${i + 1}`

    if (!action || typeof action !== 'object') {
      errors.push(`${where}: not an object`)
      return
    }
    if (action.__macroError) {
      errors.push(`${where}: ${action.op} could not be expanded - ${action.__macroError}`)
      return
    }
    if (!OPS.includes(action.op)) {
      errors.push(`${where}: unknown op "${action.op}"`)
      return
    }

    // `blocks` may name one material for the whole action, one per cell, or
    // both - a cell's own material wins. Requiring it per cell was a design
    // mistake: an action that scatters twenty lanterns is one material and
    // twenty coordinates, and the model quite reasonably wrote it that way and
    // had the whole castle rejected for it.
    const sharedMaterial = typeof action.material === 'string' ? slot(action.material) : null
    if (sharedMaterial !== null && !isKnownBlock(sharedMaterial)) {
      errors.push(`${where}: "${action.material}" is not a block this server knows`)
      return
    }
    if (action.op === 'stairs' && sharedMaterial === null && typeof action.tread !== 'string') {
      errors.push(`${where}: stairs need a tread material`)
      return
    }
    if (!['blocks', 'stairs', 'window', 'door'].includes(action.op) && sharedMaterial === null) {
      errors.push(`${where}: needs a material`)
      return
    }

    const offset = action.offset || {}
    const dims = {}

    // diameter is the other way people describe a round thing. Convert once,
    // here, so nothing downstream has to know both spellings exist.
    if (action.radius === undefined && Number.isFinite(action.diameter)) {
      action = { ...action, radius: Math.max(1, Math.floor((action.diameter - 1) / 2)) }
    }

    let bad = false
    for (const key of REQUIRED_DIMS[action.op]) {
      const raw = action[key]
      if (!Number.isFinite(raw) || raw < MIN_SIZE) {
        errors.push(`${where}: ${key} must be a number >= ${MIN_SIZE} (got ${raw})`)
        bad = true
        continue
      }
      if (raw > MAX_SIZE) {
        errors.push(`${where}: ${key} of ${raw} exceeds the ${MAX_SIZE} limit`)
        bad = true
        continue
      }
      dims[key] = Math.floor(raw)
    }
    for (const key of OPTIONAL_DIMS[action.op] || []) {
      const raw = action[key]
      if (raw === undefined || raw === null) continue
      if (!Number.isFinite(raw) || raw < MIN_SIZE || raw > MAX_SIZE) {
        errors.push(`${where}: ${key} must be between ${MIN_SIZE} and ${MAX_SIZE} (got ${raw})`)
        bad = true
        continue
      }
      dims[key] = Math.floor(raw)
    }
    if (bad) return

    let cells
    if (action.op === 'blocks') {
      if (!Array.isArray(action.cells) || !action.cells.length) {
        errors.push(`${where}: blocks needs a non-empty cells list`)
        return
      }
      if (action.cells.length > MAX_CELLS) {
        errors.push(`${where}: ${action.cells.length} cells is over the ${MAX_CELLS} limit for one blocks action`)
        return
      }
      cells = []
      for (let c = 0; c < action.cells.length; c++) {
        const cell = action.cells[c]
        if (!cell || typeof cell !== 'object') {
          errors.push(`${where}: cell ${c + 1} is not an object`)
          return
        }
        const cellMaterial = typeof cell.material === 'string' ? slot(cell.material) : sharedMaterial
        if (cellMaterial === null) {
          errors.push(`${where}: cell ${c + 1} has no material, and the action names none either`)
          return
        }
        if (!isKnownBlock(cellMaterial)) {
          errors.push(`${where}: cell ${c + 1} names "${cellMaterial}", which is not a block this server knows`)
          return
        }
        const cx = intOr(cell.x, NaN)
        const cy = intOr(cell.y, NaN)
        const cz = intOr(cell.z, NaN)
        if (![cx, cy, cz].every(Number.isFinite)) {
          errors.push(`${where}: cell ${c + 1} has a non-numeric coordinate`)
          return
        }
        if ([cx, cy, cz].some(v => Math.abs(v) > CELL_REACH)) {
          errors.push(`${where}: cell ${c + 1} is more than ${CELL_REACH} blocks from its offset`)
          return
        }
        cells.push({ x: cx, y: cy, z: cz, material: cellMaterial })
      }
    }

    // The footprint-relative ornament ops. They take a face or a footprint and
    // work out their own geometry and block states, so the only thing to
    // validate here is that the materials exist and that anything derived from
    // them (a stairs sibling for eaves, a slab cap) resolves.
    let dressing
    if (['eaves', 'trim_band', 'battlements', 'pilaster', 'buttress', 'plinth', 'column', 'roof'].includes(action.op)) {
      dressing = {}
      if (action.op === 'eaves') {
        const st = stairsFor(sharedMaterial, isKnownBlock)
        if (!st) {
          errors.push(`${where}: eaves need a stairs block; "${sharedMaterial}" has none`)
          return
        }
        dressing.material = st
      }
      if (action.op === 'roof') {
        dressing.kind = ['gable', 'hip', 'cone', 'mansard', 'pagoda', 'onion'].includes(action.kind) ? action.kind : 'gable'
        dressing.overhang = Number.isFinite(action.overhang) ? Math.max(0, Math.min(4, Math.floor(action.overhang))) : 1
        dressing.gableFill = typeof action.gable_fill === 'string' ? slot(action.gable_fill) : null
        dressing.ridge = typeof action.ridge === 'string' ? slot(action.ridge) : null
        // A sloped roof wants stairs; a cone is made of full blocks.
        if (dressing.kind !== 'cone') {
          const st = stairsFor(sharedMaterial, isKnownBlock)
          if (st) dressing.material = st
        }
        if (!dressing.gableFill && dressing.kind === 'gable') {
          dressing.gableFill = fillFor(dressing.material || sharedMaterial, isKnownBlock)
        }
      }
      if (action.op === 'battlements') {
        dressing.cap = typeof action.cap === 'string' ? slot(action.cap)
          : familyVariant(sharedMaterial, 'slab', isKnownBlock)
      }
      if (action.op === 'buttress') {
        dressing.buttress = true
        dressing.stairs = stairsFor(sharedMaterial, isKnownBlock)
      }
      if (action.op === 'pilaster' || action.op === 'buttress') {
        dressing.face = ['north', 'south', 'east', 'west'].includes(action.face) ? action.face : 'north'
        dressing.along = intOr(action.along, 0)
        if (action.footprint && Number.isFinite(action.footprint.width) && Number.isFinite(action.footprint.depth)) {
          dressing.footprint = {
            width: Math.max(1, Math.floor(action.footprint.width)),
            depth: Math.max(1, Math.floor(action.footprint.depth))
          }
        }
      }
      dressing.proud = Number.isFinite(action.proud) ? Math.max(0, Math.min(4, Math.floor(action.proud))) : undefined
      dressing.grow = Number.isFinite(action.grow) ? Math.max(0, Math.min(4, Math.floor(action.grow))) : undefined

      const extras = [dressing.material, dressing.gableFill, dressing.ridge, dressing.cap, dressing.stairs].filter(Boolean)
      const unknown = extras.find(m => !isKnownBlock(m))
      if (unknown) {
        errors.push(`${where}: "${unknown}" is not a block this server knows`)
        return
      }
      for (const k of Object.keys(dressing)) if (dressing[k] === undefined) delete dressing[k]
    }

    let opening
    if (action.op === 'window' || action.op === 'door') {
      opening = {}
      opening.face = ['north', 'south', 'east', 'west'].includes(action.face) ? action.face : 'north'
      opening.along = intOr(action.along, 0)
      if (action.footprint && Number.isFinite(action.footprint.width) && Number.isFinite(action.footprint.depth)) {
        opening.footprint = {
          width: Math.max(1, Math.floor(action.footprint.width)),
          depth: Math.max(1, Math.floor(action.footprint.depth))
        }
      }
      opening.frame = typeof action.frame === 'string' ? slot(action.frame) : null
      opening.lintel = typeof action.lintel === 'string' ? slot(action.lintel) : null

      if (action.op === 'window') {
        opening.style = ['plain', 'arched', 'mullion'].includes(action.style) ? action.style : 'plain'
        opening.glass = typeof action.glass === 'string' ? slot(action.glass)
          : (typeof action.material === 'string' ? action.material : 'glass_pane')
        if (opening.frame && !opening.lintel) {
          opening.lintel = familyVariant(opening.frame, 'slab', isKnownBlock)
        }
        opening.sill = typeof action.sill === 'string' ? slot(action.sill)
          : (opening.frame ? familyVariant(opening.frame, 'stairs', isKnownBlock) : null)
        if (opening.sill && !hasStateFor(opening.sill)) {
          opening.sill = `${opening.sill}[half=bottom,facing=${opening.face}]`
        }
      } else {
        opening.arched = action.arched === true
        opening.doorBlock = typeof action.door_block === 'string' ? slot(action.door_block) : null
        if (opening.frame && !opening.lintel) {
          opening.lintel = familyVariant(opening.frame, 'slab', isKnownBlock)
        }
      }

      const extras = [opening.frame, opening.glass, opening.lintel, opening.doorBlock]
        .filter(Boolean)
        .concat(opening.sill ? [baseName(opening.sill)] : [])
      const unknown = extras.find(m => !isKnownBlock(m))
      if (unknown) {
        errors.push(`${where}: "${unknown}" is not a block this server knows`)
        return
      }
    }

    let helix
    if (action.op === 'spiral') {
      helix = {}
      const tread = stairsFor(sharedMaterial, isKnownBlock)
      if (!tread) {
        errors.push(`${where}: "${action.material}" is not a stairs block and I could not find one for it`)
        return
      }
      helix.material = tread
      helix.column = (typeof action.column === 'string' ? slot(action.column) : null) || fillFor(tread, isKnownBlock)
      helix.slab = (typeof action.slab === 'string' ? slot(action.slab) : null) || familyVariant(helix.column, 'slab', isKnownBlock) || helix.column
      helix.railing = typeof action.railing === 'string' ? slot(action.railing) : null
      helix.risePerTread = action.rise_per_tread === 0.5 ? 0.5 : 1
      const extras = [helix.column, helix.slab, helix.railing].filter(Boolean)
      const unknown = extras.find(m => !isKnownBlock(m))
      if (unknown) {
        errors.push(`${where}: "${unknown}" is not a block this server knows`)
        return
      }
    }

    let stair
    if (action.op === 'stairs') {
      stair = {}
      const tread = stairsFor(slot(action.tread || action.material), isKnownBlock)
      if (!tread) {
        errors.push(`${where}: "${slot(action.tread || action.material)}" is not a stairs block and I could not find one for it`)
        return
      }
      stair.tread = tread
      stair.fill = (typeof action.fill === 'string' ? slot(action.fill) : null) || fillFor(tread, isKnownBlock)
      stair.ascent = action.ascent === '-' ? '-' : '+'
      stair.sides = ['both', 'left', 'right', 'none'].includes(action.sides) ? action.sides : 'both'
      stair.lights = ['torch', 'lantern', 'none'].includes(action.lights) ? action.lights : 'torch'
      stair.postHeight = Number.isFinite(action.post_height) ? Math.max(0, Math.min(8, Math.floor(action.post_height))) : 3
      stair.lightEvery = Number.isFinite(action.light_every) ? Math.max(0, Math.floor(action.light_every)) : 4
      stair.landingEvery = Number.isFinite(action.landing_every) ? Math.max(0, Math.floor(action.landing_every)) : 0
      stair.turn = ['none', 'left', 'right'].includes(action.turn) ? action.turn : 'none'
      stair.stringer = typeof action.stringer === 'string' ? slot(action.stringer) : null

      if (action.rise < 2) {
        errors.push(`${where}: a flight needs a rise of at least 2 (got ${action.rise})`)
        return
      }
      if (Number.isFinite(action.flare) && (action.flare < 0 || action.flare > 2)) {
        errors.push(`${where}: flare must be 0, 1 or 2 (got ${action.flare})`)
        return
      }
      stair.flare = Number.isFinite(action.flare) ? Math.floor(action.flare) : 0
      if (stair.turn !== 'none' && !stair.landingEvery) {
        errors.push(`${where}: turn "${stair.turn}" needs landing_every - a flight turns at a landing`)
        return
      }

      const extras = [stair.fill, stair.stringer].filter(Boolean)
      if (Array.isArray(action.stringer_pattern) && action.stringer_pattern.length) {
        stair.stringerPattern = action.stringer_pattern.map(slot)
        extras.push(...action.stringer_pattern)
      }
      const unknown = extras.find(m => !isKnownBlock(m))
      if (unknown) {
        errors.push(`${where}: "${unknown}" is not a block this server knows`)
        return
      }
    }

    const axes = ALLOWED_AXES[action.op] || ['x', 'z']
    const defaultAxis = action.op === 'cylinder' ? 'y' : 'x'

    clean.push({
      op: action.op,
      // sharedMaterial, not action.material: the raw value may be a palette
      // slot name, and storing that ships the literal string "wall" as a block.
      material: sharedMaterial,
      offset: {
        x: intOr(offset.x, 0),
        y: intOr(offset.y, 0),
        z: intOr(offset.z, 0)
      },
      axis: axes.includes(action.axis) ? action.axis : defaultAxis,
      ...(action.__macro ? { __macro: action.__macro } : {}),
      ...(action.__instance ? { __instance: action.__instance } : {}),
      anchor: action.anchor === 'corner' || action.anchor === 'center'
        ? action.anchor
        : (CENTRED_BY_DEFAULT.has(action.op) ? 'center' : 'corner'),
      phase,
      hollow: action.hollow !== false,
      ...(cells ? { cells } : {}),
      ...(stair || {}),
      ...(helix || {}),
      ...(opening || {}),
      ...(dressing || {}),
      ...dims
    })
  })

  // The decorator's own settings.
  let decor = null
  if (plan.decor && typeof plan.decor === 'object') {
    const style = ['medieval_stone', 'timber_castle', 'fantasy_spire', 'plain'].includes(plan.decor.style)
      ? plan.decor.style
      : 'medieval_stone'
    if (plan.decor.trim !== undefined && !isKnownBlock(plan.decor.trim)) {
      errors.push(`decor: "${plan.decor.trim}" is not a block this server knows`)
    }
    decor = {
      style,
      intensity: Number.isFinite(plan.decor.intensity) ? Math.max(0, Math.min(1, plan.decor.intensity)) : 0.7,
      gradient: plan.decor.gradient !== false,
      greenery: plan.decor.greenery !== false,
      banners: typeof plan.decor.banners === 'string' ? plan.decor.banners : null,
      trim: typeof plan.decor.trim === 'string' ? plan.decor.trim : null,
      skip: Array.isArray(plan.decor.skip) ? plan.decor.skip.filter(x => typeof x === 'string') : []
    }
  }

  if (errors.length) return { errors }

  // Drop actions byte-identical to an earlier one, keeping the FIRST.
  //
  // A repeated shape is at best wasted work and at worst destructive: a wizard
  // tower came out with no way in because the plan built the wall, carved a
  // doorway through it, and then re-emitted the same four wall cylinders -
  // sealing the door it had just cut. Keeping the first occurrence is right
  // either way, since a shape placed twice with nothing between the two is a
  // no-op the second time.
  const seen = new Set()
  const deduped = []
  for (const action of clean) {
    const signature = JSON.stringify(action)
    if (seen.has(signature)) continue
    seen.add(signature)
    deduped.push(action)
  }

  // Staircases go last, always.
  //
  // A spiral is the one shape whose whole purpose is that a player can use it,
  // and it is uniquely fragile: anything solid placed over it seals the climb,
  // and any air carved through it deletes treads outright. Both have now
  // happened in real plans - a floor disc laid across the shaft stopped the
  // ascent at every storey, and window arches carved three blocks deep through
  // the wall erased four treads, leaving a staircase with holes in it.
  //
  // Ordering guidance in the prompt did not hold across three attempts, and the
  // failure is invisible: the build reports every block placed successfully.
  // Since a staircase destroyed by a later action is never what anyone meant,
  // the order is enforced here instead of asked for. The spiral carves its own
  // headroom, so running it last is also what makes it punch through the floors
  // it should pass and arrive at the one it serves.
  // Phases now order shell before carves before details, so the only ordering
  // left to enforce is within details: a spiral must be the last thing to touch
  // its own cells, because bulk detail work laid over it seals the climb.
  const stairs = deduped.filter(a => a.op === 'spiral')
  const rest = deduped.filter(a => a.op !== 'spiral')
  const reordered = stairs.length && deduped[deduped.length - 1].op !== 'spiral'

  return {
    summary: typeof plan.summary === 'string' ? plan.summary : 'a build',
    palette,
    paletteWarnings,
    decor,
    actions: rest.concat(stairs),
    dropped: clean.length - deduped.length,
    reordered: Boolean(reordered),
    errors: []
  }
}

function intOr (value, fallback) {
  return Number.isFinite(value) ? Math.floor(value) : fallback
}

// Turns a validated plan into one flat { pos, name } list by calling the
// primitives and shifting each shape by its offset. Ordering is preserved:
// action order is build order, which is how the model expresses "walls before
// roof".
// Expand a validated plan into the exact cells that will be filled. The work
// lives in src/building/render.js - phase order, carve protection, the
// overwrite lint and the orientation pass all happen there, because they all
// need the same cell map and computing it twice would let the two copies drift.
function renderPlan (plan, primitives, opts) {
  return render.renderPlan(plan, primitives, opts)
}

// Compatibility shape: just the blocks, throwing on the cap as before.
function planToBlocks (plan, primitives, opts) {
  return render.renderPlan(plan, primitives, opts).blocks
}

module.exports = { requestPlan, validatePlan, planToBlocks, renderPlan, getClient, MODEL, SYSTEM_PROMPT }
