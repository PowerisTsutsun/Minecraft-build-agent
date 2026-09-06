'use strict'

// Throwaway probe answering two questions before command-mode building is built:
//   1. Do slash commands from an OP'd bot actually place blocks?
//   2. How fast can they be fired before vanilla's chat-spam throttle kicks?
//
// It teleports itself far from the play area first - /setblock silently refuses
// with "That position is not loaded" outside anyone's view distance, which is
// also why the builder will have to tp to its build site before filling.
//
//   docker exec mc-builder-bot node test/cmd-rate-probe.js
//   (op the RateProbe account from the host during the 10s grace window)

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const COUNT = parseInt(process.env.PROBE_COUNT || '300', 10)
const DELAY_TICKS = parseInt(process.env.PROBE_DELAY_TICKS || '0', 10)
const HOME = { x: 10000, y: -59, z: 0 }

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'RateProbe',
  version: process.env.MC_VERSION || '26.1'
})

let kicked = null
bot.on('kicked', reason => { kicked = JSON.stringify(reason) })
bot.on('end', reason => console.log(`[probe] disconnected: ${reason}${kicked ? ' KICKED: ' + kicked : ''}`))

bot.once('spawn', async () => {
  console.log('[probe] spawned - op RateProbe now, starting in 10s')
  await bot.waitForTicks(200)

  bot.chat(`/tp RateProbe ${HOME.x} ${HOME.y} ${HOME.z}`)
  await bot.waitForTicks(40)
  console.log(`[probe] position after tp: ${bot.entity.position}`)

  // setblock needs loaded chunks; give them a moment to stream in.
  try { await bot.waitForChunksToLoad() } catch (err) { console.log('[probe] chunk wait:', err.message) }
  await bot.waitForTicks(20)

  console.log(`[probe] firing ${COUNT} setblock with ${DELAY_TICKS} ticks between`)
  const t0 = Date.now()
  for (let i = 0; i < COUNT; i++) {
    bot.chat(`/setblock ${HOME.x} -60 ${i} minecraft:stone_bricks replace`)
    if (DELAY_TICKS > 0) await bot.waitForTicks(DELAY_TICKS)
  }
  const sendMs = Date.now() - t0

  // Wait for the server to work through the queue, then count what really landed.
  await bot.waitForTicks(100)
  let landed = 0
  for (let i = 0; i < COUNT; i++) {
    const b = bot.blockAt(new Vec3(HOME.x, -60, i))
    if (b && b.name === 'stone_bricks') landed++
  }

  console.log(`[probe] sent ${COUNT} in ${sendMs}ms | landed ${landed}/${COUNT} | connected ${Boolean(bot.player)} | kicked ${kicked ? 'YES' : 'no'}`)

  // One /fill to clear - also proves fill works and how much one command covers.
  const t1 = Date.now()
  bot.chat(`/fill ${HOME.x} -60 0 ${HOME.x} -60 ${COUNT - 1} minecraft:air replace`)
  await bot.waitForTicks(40)
  let left = 0
  for (let i = 0; i < COUNT; i++) {
    const b = bot.blockAt(new Vec3(HOME.x, -60, i))
    if (b && b.name === 'stone_bricks') left++
  }
  console.log(`[probe] one /fill of ${COUNT} blocks: ${COUNT - left} cleared in ${Date.now() - t1}ms`)
  bot.quit()
})
