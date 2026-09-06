'use strict'

// Isolates digging from the rest of the bot. Connects, has blocks placed
// around it by the caller, and digs them one at a time with full instrumentation
// on who aborts what. Used to find why undo stalls with "Digging aborted".
//
//   docker exec mc-builder-bot node test/dig-probe.js

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25566,
  username: 'DigProbe',
  version: '26.1'
})
bot.loadPlugin(pathfinder)

bot.on('diggingAborted', block => {
  console.log(`[event] diggingAborted @ ${block.position}`)
  console.log(new Error('who called stopDigging').stack.split('\n').slice(1, 6).join('\n'))
})
bot.on('diggingCompleted', block => console.log(`[event] diggingCompleted @ ${block.position}`))

bot.once('spawn', async () => {
  await bot.waitForTicks(40)
  const p = bot.entity.position.floored()
  console.log(`[probe] standing at ${p}, gamemode ${bot.game.gameMode}`)
  console.log(`[probe] READY - place blocks at ${p.x + 2}..${p.x + 5}, y=${p.y}, z=${p.z}`)

  // Wait for the caller to place the targets and hand over a pickaxe, rather
  // than racing them.
  for (let i = 0; i < 60; i++) {
    const first = bot.blockAt(new Vec3(p.x + 2, p.y, p.z))
    if (first && first.name !== 'air') break
    await bot.waitForTicks(10)
  }
  console.log(`[probe] inventory: ${bot.inventory.items().map(it => it.name).join(', ') || '(empty)'}`)

  const mcData = require('minecraft-data')(bot.version)
  const movements = new Movements(bot, mcData)
  movements.canDig = true
  bot.pathfinder.setMovements(movements)

  // Dig targets: a horizontal line of blocks the caller placed at foot level.
  for (let i = 0; i < 4; i++) {
    const target = new Vec3(p.x + 2 + i, p.y, p.z)
    const block = bot.blockAt(target)
    console.log(`\n[probe] --- target ${target}: ${block && block.name} ---`)
    if (!block || block.name === 'air') { console.log('[probe] nothing there, skipping'); continue }

    const dist = bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5))
    console.log(`[probe] distance ${dist.toFixed(2)}, targetDigBlock=${bot.targetDigBlock}, canDigBlock=${bot.canDigBlock(block)}`)

    const started = Date.now()
    try {
      await bot.dig(block)
      console.log(`[probe] OK dug in ${Date.now() - started}ms`)
    } catch (err) {
      console.log(`[probe] FAILED after ${Date.now() - started}ms: ${err.message}`)
    }
    console.log(`[probe] block is now: ${bot.blockAt(target) && bot.blockAt(target).name}`)
    await bot.waitForTicks(10)
  }

  console.log('\n[probe] done')
  bot.quit()
  process.exit(0)
})

bot.on('error', err => console.error('[probe] error:', err.message))
setTimeout(() => { console.log('[probe] timeout'); process.exit(1) }, 180000)
