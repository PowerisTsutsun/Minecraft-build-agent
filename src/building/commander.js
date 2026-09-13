'use strict'

const { Vec3 } = require('vec3')
const { baseName } = require('./blockspec')

// ---------------------------------------------------------------------------
// Turning a block list into /fill commands, and deciding what order they go in.
//
// Everything the builder does is a slash command, so the two questions here are
// how FEW commands a build can be expressed in, and which of them must land
// before which. Both answers are load-bearing:
//
//   1. FEWER, BIGGER COMMANDS. Merging runs into cuboids turns a 200-block
//      house into a dozen fills - fewer commands to verify, and a shorter
//      window in which a build can be interrupted half-applied.
//   2. OP IS NOT JUST A PERMISSION, IT IS THE SPAM EXEMPTION. Vanilla kicks on
//      `chatSpamTickCount > 200 && !isOp(player)` - the counter climbs 20 per
//      message and decays 1 per tick, so ~10 messages in quick succession ends
//      a non-op session with `disconnect.spam`. An op is never checked, which
//      is the only reason a 114-command burst is safe. (Over RCON this is moot
//      - there is no player to kick - but the rule is why the burst sizes below
//      were chosen, and it comes straight back if anything ever logs in again.)
//   3. CHUNKS MUST BE LOADED. /setblock and /fill fail with "That position is
//      not loaded", and a /fill whose box touches even one unloaded chunk does
//      nothing at all - a 300-block fill that cleared exactly zero. The RCON
//      path force-loads the footprint and waits before filling; see
//      src/rcon/build.js.
//
// The phase order (phaseOf) is a fact about Minecraft rather than about this
// bot: a piston head pops if its piston is not there yet, a torch drops if the
// wall it hangs on arrives after it, water flows into a room that has no walls,
// and a nether portal is deleted outright if its frame is unfinished.
// ---------------------------------------------------------------------------

const key = (x, y, z) => `${x},${y},${z}`
const parseKey = k => k.split(',').map(Number)

// Greedy 3D merge: grow along x, then extend that run across z, then lift the
// whole rectangle through y. Every cell is consumed exactly once, so the result
// is a disjoint cover of the plan - no cell filled twice, no fill fighting
// another fill over the same coordinate.
function toBoxes (cells) {
  const used = new Set()
  const boxes = []

  const keys = [...cells.keys()].sort((a, b) => {
    const [ax, ay, az] = parseKey(a)
    const [bx, by, bz] = parseKey(b)
    return ay - by || az - bz || ax - bx
  })

  for (const start of keys) {
    if (used.has(start)) continue
    const [x0, y0, z0] = parseKey(start)
    const name = cells.get(start)

    const free = (x, y, z) => {
      const k = key(x, y, z)
      return !used.has(k) && cells.get(k) === name
    }
    const rowFree = (y, z) => {
      for (let x = x0; x <= x1; x++) if (!free(x, y, z)) return false
      return true
    }
    const layerFree = y => {
      for (let z = z0; z <= z1; z++) if (!rowFree(y, z)) return false
      return true
    }

    let x1 = x0
    while (free(x1 + 1, y0, z0)) x1++

    let z1 = z0
    while (rowFree(y0, z1 + 1)) z1++

    let y1 = y0
    while (layerFree(y1 + 1)) y1++

    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) used.add(key(x, y, z))
      }
    }

    boxes.push({ min: new Vec3(x0, y0, z0), max: new Vec3(x1, y1, z1), name })
  }

  return boxes
}

const ATTACHABLE = /^(torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|redstone_wire|comparator|repeater|lever|.*_button|.*_pressure_plate|tripwire|tripwire_hook|rail|powered_rail|detector_rail|activator_rail|.*_sign|.*_banner|.*_carpet|moss_carpet|ladder|vine|.*_vines|bell|lantern|soul_lantern|.*_chain|iron_chain|.*_hanging_sign|item_frame|painting|snow|.*_candle|candle|flower_pot|potted_.*|.*_door|.*_trapdoor|.*_fence_gate|scaffolding|lily_pad|.*_coral_fan|.*_coral_wall_fan|sea_pickle|bamboo|sugar_cane|cactus|.*_sapling|short_grass|tall_grass|fern|large_fern|dead_bush|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|pink_petals|small_dripleaf|big_dripleaf|.*_mushroom|cave_vines.*|glow_lichen|sculk_vein|pointed_dripstone|amethyst_cluster|.*_amethyst_bud|redstone_lamp|lightning_rod|end_rod|.*_head|.*_skull|bubble_column|water|lava|kelp.*|seagrass|tall_seagrass)$/
const FILL_MAX = 32768
function splitBox (box) {
  const dx = box.max.x - box.min.x + 1
  const dy = box.max.y - box.min.y + 1
  const dz = box.max.z - box.min.z + 1
  if (dx * dy * dz <= FILL_MAX) return [box]
  // Cut along the longest axis and recurse.
  const axis = dx >= dy && dx >= dz ? 'x' : (dy >= dz ? 'y' : 'z')
  const mid = Math.floor((box.min[axis] + box.max[axis]) / 2)
  const a = { ...box, min: box.min.clone(), max: box.max.clone() }
  const b = { ...box, min: box.min.clone(), max: box.max.clone() }
  a.max[axis] = mid
  b.min[axis] = mid + 1
  return [...splitBox(a), ...splitBox(b)]
}

// Block until the client actually holds world data for a spread of the target
// cells (or we give up). Sampling beats checking all of them: a few dozen
// cells spread across the footprint prove the chunks arrived, and cost
// nothing next to reading 300k.
const MECHANISM = /^(piston|sticky_piston|moving_piston|observer|dispenser|dropper|crafter|hopper|note_block|tnt|redstone_lamp|target|jukebox|bell)$/
const POWER = /^(redstone_block|lever|.*_button|.*_pressure_plate|redstone_torch|redstone_wall_torch|daylight_detector|sculk_sensor|calibrated_sculk_sensor|lightning_rod|tripwire_hook)$/
const LIQUID = /^(water|lava|bubble_column)$/

function phaseOf (name) {
  const base = baseName(name)
  if (base === 'nether_portal') return 5
  if (LIQUID.test(base)) return 4
  if (POWER.test(base)) return 3
  if (ATTACHABLE.test(base)) return 2
  if (MECHANISM.test(base)) return 1
  return 0
}

function fillCommand (box) {
  const { min, max, name } = box
  return `/fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} minecraft:${name} replace`
}

// Only what something actually imports: the box merger, the /fill splitter and
// formatter, and the phase rule. The regex vocabularies above are internal to
// phaseOf - export them again if a caller ever needs to ask "is this a
// mechanism" for its own reasons.
module.exports = { toBoxes, splitBox, fillCommand, phaseOf }
