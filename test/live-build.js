'use strict'

// Live build + undo test. Needs materials in BuilderBot's inventory first:
//   docker exec mc-sandbox rcon-cli "give BuilderBot stone 512"
//   docker exec mc-sandbox rcon-cli "give BuilderBot dirt 64"
//   docker exec mc-sandbox rcon-cli "give BuilderBot diamond_pickaxe 1"
// Then:
//   docker exec mc-builder-bot node test/live-build.js
//
// Event-driven, not timer-driven: it waits for BuilderBot to actually report
// "Done!" before issuing !undo. A fixed timer just races the build - how long
// 16 blocks take depends on how far the bot has to walk.

const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'TestPlayer',
  version: process.env.MC_VERSION || '26.1'
})

let stage = 'waiting'
let undoRounds = 0

bot.once('spawn', () => {
  console.log('[test] spawned - waiting for world data')
  setTimeout(() => {
    send('!dry off')
    setTimeout(() => { stage = 'building'; send('!build floor 4 4 stone') }, 2000)
  }, 8000)
})

function send (line) {
  console.log(`[send] ${line}`)
  bot.chat(line)
}

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  console.log(`[chat] <${username}> ${message}`)

  if (stage === 'building' && /^Done!|^Stopped\./.test(message)) {
    stage = 'undoing'
    setTimeout(() => send('!undo'), 3000)
    return
  }

  // A batched undo can legitimately need a second pass, but a harness that
  // repeats on every "left" message will happily loop forever against a stuck
  // undo - which is exactly what happened the first time this ran. Cap it.
  if (stage === 'undoing' && /left - run !undo again/.test(message) && undoRounds < 3) {
    undoRounds++
    setTimeout(() => send('!undo'), 3000)
    return
  }

  if (stage === 'undoing' && /^Undo done:/.test(message)) {
    stage = 'finished'
    setTimeout(finish, 6000)
  }
})

function finish () {
  console.log(`[test] finished at stage: ${stage}`)
  bot.quit()
  process.exit(0)
}

// Hard ceiling so a wedged run can't hang forever.
setTimeout(() => {
  console.log(`[test] TIMED OUT at stage: ${stage}`)
  bot.quit()
  process.exit(1)
}, 600000)

bot.on('error', err => console.error('[test] error:', err.message))
bot.on('end', reason => console.log('[test] disconnected:', reason))
