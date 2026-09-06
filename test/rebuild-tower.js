'use strict'

// Rolls back the standing build and asks for it again, so the fix can be judged
// in the same spot rather than next to its own predecessor.

const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'TestPlayer',
  version: process.env.MC_VERSION || '26.1'
})

const heard = []
bot.on('chat', (username, message) => {
  if (username !== 'BuilderBot') return
  heard.push(message)
  console.log(`[bot] ${message}`)
})

function waitFor (pattern, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const t = setInterval(() => {
      if (heard.some(m => pattern.test(m))) { clearInterval(t); resolve(Date.now() - started) }
      else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout waiting for ${pattern}`)) }
    }, 100)
  })
}

bot.once('spawn', async () => {
  console.log('[test] spawned - teleport TestPlayer to the site now')
  await bot.waitForTicks(200)
  await bot.waitForChunksToLoad().catch(() => {})
  console.log(`[test] at ${bot.entity.position}`)

  bot.chat('!undo')
  await waitFor(/Undo done|Nothing to undo/)
  await bot.waitForTicks(40)

  heard.length = 0
  bot.chat(process.env.TEST_CMD)
  const ms = await waitFor(/Done in|Stopped|Error/)
  console.log(`[test] rebuild finished in ${(ms / 1000).toFixed(1)}s`)
  await bot.waitForTicks(40)
  bot.quit()
})
