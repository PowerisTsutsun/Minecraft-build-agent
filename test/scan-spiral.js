'use strict'

// Dumps the inside of the wizard tower level by level so the staircase can be
// looked at as data rather than squinted at in game. Prints the block letter
// plus, for anything with block states (stairs, slabs, logs), the state that
// actually landed - which is the thing /fill decides and nobody checks.

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const ORIGIN = new Vec3(
  parseInt(process.env.SCAN_X || '1164', 10),
  parseInt(process.env.SCAN_Y || '-60', 10),
  parseInt(process.env.SCAN_Z || '1196', 10))
const LEVELS = parseInt(process.env.SCAN_LEVELS || '10', 10)

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'Scanner',
  version: process.env.MC_VERSION || '26.1'
})

bot.once('spawn', async () => {
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  bot.chat(`/tp Scanner ${ORIGIN.x + 5} ${ORIGIN.y + 30} ${ORIGIN.z + 5}`)
  await bot.waitForTicks(40)
  await bot.waitForChunksToLoad().catch(() => {})
  await bot.waitForTicks(40)

  const letter = name => {
    if (name === 'air') return '.'
    if (name.includes('stairs')) return 'S'
    if (name.includes('slab')) return 's'
    if (name.includes('wall')) return 'W'
    if (name.includes('glass')) return 'g'
    return '#'
  }

  const states = new Map()

  for (let level = 2; level < 2 + LEVELS; level++) {
    const y = ORIGIN.y + level
    const rows = []
    for (let dz = 0; dz <= 10; dz++) {
      let row = ''
      for (let dx = 0; dx <= 10; dx++) {
        const b = bot.blockAt(new Vec3(ORIGIN.x + dx, y, ORIGIN.z + dz))
        if (!b) { row += '?'; continue }
        row += letter(b.name)
        if (b.name.includes('stairs')) {
          let props = {}
          try { props = b.getProperties() } catch (err) { props = { unavailable: err.message } }
          const sig = `${b.name} ${JSON.stringify(props)}`
          states.set(sig, (states.get(sig) || 0) + 1)
        }
      }
      rows.push(row)
    }
    console.log(`--- level ${level} (y=${y}) ---`)
    console.log(rows.join('\n'))
  }

  console.log('\n--- stair block states actually in the world ---')
  for (const [sig, n] of [...states.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n} x ${sig}`)
  }
  bot.quit()
})
