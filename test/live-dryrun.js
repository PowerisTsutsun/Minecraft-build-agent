'use strict'

// Live smoke test against the sandbox server. Joins as a second player, turns
// on dry-run, and issues each build command in turn - so it exercises the real
// chat -> parse -> generate -> plan path without placing a single block or
// needing anything in the bot's inventory.
//
//   docker exec mc-builder-bot node test/live-dryrun.js

const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'TestPlayer',
  version: process.env.MC_VERSION || '26.1'
})

const SCRIPT = [
  '!help',
  '!dry on',
  '!build floor 5 5 stone',
  '!build wall 6 3 stone z',
  '!build box 5 5 4 stone',
  '!build sphere 4 glass',
  '!build house 7 6 4 oak_planks',
  '!schem list',
  '!schem test-cube',
  '!build box 999 999 999 stone', // clamped, not obeyed
  '!build box 5 5 4 unobtainium', // rejected
  '!dry off'
]

bot.once('spawn', () => {
  console.log('[test] spawned - waiting for world data before issuing commands')
  // Sending commands immediately after spawn races BuilderBot's own chunk load:
  // bot.blockAt() returns nothing yet and every neighbour check fails. A real
  // player takes far longer than a second to type, so give it a real margin.
  let delay = 8000
  for (const line of SCRIPT) {
    setTimeout(() => {
      console.log(`[send] ${line}`)
      bot.chat(line)
    }, delay)
    delay += 4000
  }
  setTimeout(() => {
    console.log('[test] done')
    bot.quit()
    process.exit(0)
  }, delay + 6000)
})

bot.on('chat', (username, message) => {
  if (username !== bot.username) console.log(`[chat] <${username}> ${message}`)
})

bot.on('error', err => console.error('[test] error:', err.message))
bot.on('end', reason => console.log('[test] disconnected:', reason))
