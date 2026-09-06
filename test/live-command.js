'use strict'

// End-to-end check of command-mode building, run somewhere nobody is standing.
// A joining TestPlayer issues a real chat command, and this measures the thing
// that actually matters to whoever asked: wall-clock seconds from "!build" to
// "Done", and whether the blocks are genuinely in the world afterwards.
//
//   docker exec mc-builder-bot node test/live-command.js
//   (host teleports TestPlayer to the test site during the grace window)

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'TestPlayer',
  version: process.env.MC_VERSION || '26.1'
})

const heard = []
let buildStart = 0
let undoStart = 0

bot.on('chat', (username, message) => {
  if (username !== 'BuilderBot') return
  heard.push(message)
  console.log(`[bot] ${message}`)
})

function waitFor (pattern, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const hit = heard.find(m => pattern.test(m))
      if (hit) { clearInterval(timer); resolve({ line: hit, ms: Date.now() - started }) }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timed out waiting for ${pattern}`)) }
    }, 100)
  })
}

function countStone (origin, w, d, h) {
  let found = 0
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      for (let z = 0; z < d; z++) {
        const b = bot.blockAt(origin.offset(x, y, z))
        if (b && b.name !== 'air') found++
      }
    }
  }
  return found
}

bot.once('spawn', async () => {
  console.log('[test] spawned - teleport TestPlayer to the site now')
  await bot.waitForTicks(200)
  console.log(`[test] standing at ${bot.entity.position}`)
  await bot.waitForChunksToLoad().catch(() => {})

  const origin = bot.entity.position.floored().offset(2, 0, 0)

  console.log('[test] --- build ---')
  buildStart = Date.now()
  bot.chat(process.env.TEST_CMD || '!build house 7 6 4 stone_bricks')
  const done = await waitFor(/Done in|Stopped|Error/)
  const buildMs = Date.now() - buildStart
  await bot.waitForTicks(20)

  const standing = countStone(origin, 7, 6, 5)
  console.log(`[test] BUILD took ${(buildMs / 1000).toFixed(1)}s wall clock; ${standing} non-air blocks at the site`)

  if (process.env.TEST_UNDO === '0') {
    console.log(`\n[test] RESULT build=${(buildMs / 1000).toFixed(1)}s placed=${standing} (left standing on purpose)`)
    return bot.quit()
  }

  console.log('[test] --- undo ---')
  undoStart = Date.now()
  bot.chat('!undo')
  await waitFor(/Undo done/)
  const undoMs = Date.now() - undoStart
  await bot.waitForTicks(20)
  const left = countStone(origin, 7, 6, 5)
  console.log(`[test] UNDO took ${(undoMs / 1000).toFixed(1)}s; ${left} non-air blocks left at the site`)

  console.log(`\n[test] RESULT build=${(buildMs / 1000).toFixed(1)}s undo=${(undoMs / 1000).toFixed(1)}s placed=${standing} leftAfterUndo=${left}`)
  bot.quit()
})
