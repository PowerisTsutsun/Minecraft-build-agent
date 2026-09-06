'use strict'

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')

// ---------------------------------------------------------------------------
// Templates: builds that must be exactly right.
//
// A farm, a mob grinder, a sorter - these have designs that are known, proven
// and version-sensitive, and every one of those properties is something a
// language model is bad at. It will produce a farm-shaped building that makes
// no iron, and report success, because nothing downstream can tell the
// difference between a hopper in the right place and a hopper one block over.
//
// So functional builds are not planned. They are placed from a .schem someone
// tested, with their entities summoned by a setup script, and then wrapped in
// architecture the planner IS good at.
//
// A template directory holds:
//   <name>.schem   the blocks, as exported from a working build
//   meta.json      size, the region to protect, what it needs, what it makes
//   setup.txt      slash commands run after placement - /summon, chest fills
//   readme.md      where the design came from
// ---------------------------------------------------------------------------

const DIR = path.join(__dirname, '..', '..', 'templates')
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

function templateDir (name) {
  if (!NAME.test(name)) throw new Error('a template name is lowercase letters, digits, - or _')
  return path.join(DIR, name)
}

function list () {
  try {
    return fs.readdirSync(DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => fs.existsSync(path.join(DIR, n, `${n}.schem`)))
      .sort()
  } catch (err) {
    return []
  }
}

function describe (name) {
  const dir = templateDir(name)
  const metaPath = path.join(dir, 'meta.json')
  const meta = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    : {}
  const setupPath = path.join(dir, 'setup.txt')
  const setup = fs.existsSync(setupPath)
    ? fs.readFileSync(setupPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : []
  return { name, dir, meta, setup, schem: path.join(dir, `${name}.schem`) }
}

async function load (name, version) {
  const info = describe(name)
  if (!fs.existsSync(info.schem)) throw new Error(`no .schem for template "${name}"`)
  const schematic = await Schematic.read(await fs.promises.readFile(info.schem), version)
  return { ...info, schematic }
}

// --- export ----------------------------------------------------------------
// Read a region out of the world and write it as a template. This is how a
// proven design gets in: someone builds it by hand, or verifies a generated
// one, and then it is captured exactly rather than described approximately.
async function exportRegion (bot, name, start, end, opts = {}) {
  const dir = templateDir(name)
  fs.mkdirSync(dir, { recursive: true })

  const lo = new Vec3(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.min(start.z, end.z))
  const hi = new Vec3(Math.max(start.x, end.x), Math.max(start.y, end.y), Math.max(start.z, end.z))
  const size = hi.minus(lo).offset(1, 1, 1)

  const CAP = 200000
  if (size.x * size.y * size.z > CAP) {
    throw new Error(`that region is ${size.x}x${size.y}x${size.z}, over the ${CAP}-block export cap`)
  }

  const schematic = await Schematic.copy(bot.world, lo, hi, new Vec3(0, 0, 0), bot.version)
  await fs.promises.writeFile(path.join(dir, `${name}.schem`), await schematic.write())

  // Count what is actually in there, so meta.json says something useful about
  // a design nobody will remember the details of in a month.
  const tally = {}
  for (let x = lo.x; x <= hi.x; x++) {
    for (let y = lo.y; y <= hi.y; y++) {
      for (let z = lo.z; z <= hi.z; z++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b || b.name === 'air') continue
        tally[b.name] = (tally[b.name] || 0) + 1
      }
    }
  }
  const notable = Object.entries(tally)
    .filter(([n]) => /hopper|chest|water|lava|magma|bed|composter|rail|piston|observer|repeater|comparator|dispenser|dropper|sign|bars/.test(n))
    .sort((a, b) => b[1] - a[1])

  const meta = {
    name,
    size: { x: size.x, y: size.y, z: size.z },
    version: bot.version,
    exported: new Date().toISOString(),
    blocks: Object.values(tally).reduce((a, b) => a + b, 0),
    // The whole footprint is protected unless someone narrows it by hand: a
    // decorator that puts a cornice through a hopper line has broken the farm.
    protect: opts.protect || { from: { x: 0, y: 0, z: 0 }, to: { x: size.x - 1, y: size.y - 1, z: size.z - 1 } },
    notable: Object.fromEntries(notable),
    needs: opts.needs || [],
    produces: opts.produces || null
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

  const readmePath = path.join(dir, 'readme.md')
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, [
      `# ${name}`,
      '',
      `Exported from the world on ${meta.exported} at Minecraft ${meta.version}.`,
      `${meta.size.x} x ${meta.size.y} x ${meta.size.z}, ${meta.blocks} blocks.`,
      '',
      'Record where this design came from and what it needs to run:',
      '',
      '- source:',
      '- tested on:',
      '- notes:',
      ''
    ].join('\n'))
  }

  const setupPath = path.join(dir, 'setup.txt')
  if (!fs.existsSync(setupPath)) {
    fs.writeFileSync(setupPath, [
      '# Slash commands run after this template is placed, one per line.',
      '# ~x ~y ~z are relative to the template origin.',
      '# Blocks alone do not make a farm work - the entities have to be here too.',
      '#',
      '# example:',
      '# /summon minecraft:villager ~4 ~2 ~4 {VillagerData:{profession:"minecraft:farmer",level:2}}',
      '# /summon minecraft:zombie ~4 ~5 ~4 {NoAI:1b,IsBaby:0b,Silent:1b}',
      ''
    ].join('\n'))
  }

  return meta
}

// --- placement --------------------------------------------------------------
// Templates go down as /fill commands like everything else, so they share the
// forceload, the verification and the undo log.
function schematicToBlocks (schematic) {
  const blocks = []
  let skipped = 0
  const start = schematic.start()
  const end = schematic.end()
  for (let y = start.y; y <= end.y; y++) {
    for (let z = start.z; z <= end.z; z++) {
      for (let x = start.x; x <= end.x; x++) {
        let block
        try {
          block = schematic.getBlock(new Vec3(x, y, z))
        } catch (err) {
          skipped++
          continue
        }
        if (!block || block.name === 'air') continue
        blocks.push({
          pos: new Vec3(x - start.x, y - start.y, z - start.z),
          name: block.name
        })
      }
    }
  }
  return { blocks, skipped }
}

// The setup script, with ~x ~y ~z resolved against where the template landed.
function setupCommands (info, origin) {
  return info.setup.map(line =>
    line.replace(/~(-?\d+)\s+~(-?\d+)\s+~(-?\d+)/g, (m, x, y, z) =>
      `${origin.x + Number(x)} ${origin.y + Number(y)} ${origin.z + Number(z)}`))
}

// Cells the decorator and the planner must not touch.
function protectedCells (info, origin) {
  const p = info.meta.protect
  if (!p) return null
  const cells = new Set()
  for (let x = p.from.x; x <= p.to.x; x++) {
    for (let y = p.from.y; y <= p.to.y; y++) {
      for (let z = p.from.z; z <= p.to.z; z++) {
        cells.add(`${origin.x + x},${origin.y + y},${origin.z + z}`)
      }
    }
  }
  return cells
}

module.exports = { list, describe, load, exportRegion, schematicToBlocks, setupCommands, protectedCells, DIR, NAME }
