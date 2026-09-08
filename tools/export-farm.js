'use strict'
// One-off: join as a second bot, stand at the original farm, and export the
// region from its floor layer up (no buried dirt) as the iron_farm template.
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const templates = require('../src/building/templates')
const { execSync } = require('child_process')

const LO = new Vec3(1963, -61, 1105)
const HI = new Vec3(1976, -52, 1115)
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'Exporter', version: '26.1' })
bot.on('error', e => { console.error('error', e.message); process.exit(1) })
bot.once('spawn', async () => {
  console.log('spawned at', bot.entity.position)
  // rcon tp: the bot itself is not op.
  execSync(`echo "tp Exporter 1810 -50 998" > /tmp/tp.txt`) // placeholder, real tp done by host
  let tries = 0
  while (tries++ < 60) {
    await bot.waitForTicks(10)
    const b = bot.blockAt(LO)
    const c = bot.blockAt(HI)
    if (b && c && bot.entity.position.distanceTo(new Vec3(1970, -50, 1110)) < 20) break
  }
  const b = bot.blockAt(LO); const c = bot.blockAt(HI)
  console.log('corner blocks', b && b.name, c && c.name, 'at', bot.entity.position)
  if (!b || !c) { console.error('chunks not loaded'); process.exit(2) }
  const meta = await templates.exportRegion(bot, 'iron_farm', LO, HI, {
    needs: ['3 villagers', '1 zombie in a boat', '3 beds', '3 workstations'],
    produces: 'iron ingots at the double chest'
  })
  console.log(JSON.stringify(meta))
  bot.quit(); process.exit(0)
})
