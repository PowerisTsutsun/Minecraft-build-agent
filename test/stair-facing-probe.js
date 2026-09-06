'use strict'

// Which way does a stair's `facing` property point - toward the tall side or
// the low side? Getting this backwards builds a helix you cannot climb, and it
// is not worth guessing. Reads the collision shape minecraft-data gives for
// each facing and reports which half of the block is raised.

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const AT = new Vec3(
  parseInt(process.env.PROBE_X || '1180', 10),
  parseInt(process.env.PROBE_Y || '-59', 10),
  parseInt(process.env.PROBE_Z || '1180', 10))

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'Scanner',
  version: process.env.MC_VERSION || '26.1'
})

bot.once('spawn', async () => {
  await bot.waitForTicks(60)
  await bot.waitForChunksToLoad().catch(() => {})
  await bot.waitForTicks(60)

  for (let i = 0; i < 4; i++) {
    const pos = AT.offset(i * 2, 0, 0)
    const b = bot.blockAt(pos)
    if (!b) { console.log(`  (${pos.x},${pos.y},${pos.z}) no world data`); continue }
    let props = {}
    try { props = b.getProperties() } catch (err) {}
    const shapes = b.shapes || []
    // The raised half is the shape box whose top reaches 1.0 - report which
    // side of the block it occupies.
    const upper = shapes.filter(s => s[4] > 0.51)
    const where = upper.map(s => {
      const sides = []
      if (s[0] >= 0.49) sides.push('+x/east')
      if (s[3] <= 0.51) sides.push('-x/west')
      if (s[2] >= 0.49) sides.push('+z/south')
      if (s[5] <= 0.51) sides.push('-z/north')
      return sides.join('&') || 'full'
    })
    console.log(`  ${b.name} facing=${props.facing} -> raised half on ${where.join(', ') || '(none)'}`)
  }
  bot.quit()
})
