'use strict'

// Exercises the natural-language path end to end: !make -> Claude API ->
// validated plan -> block list. Runs in dry-run by default so it costs one API
// call and places nothing.
//
//   docker exec mc-builder-bot node test/live-make.js
//   docker exec mc-builder-bot node test/live-make.js --wet   (actually builds)

const mineflayer = require('mineflayer')

const WET = process.argv.includes('--wet')
const REQUEST = process.argv.slice(2).filter(a => a !== '--wet').join(' ') ||
  'a small stone watchtower with a glass dome on top'

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'TestPlayer',
  version: process.env.MC_VERSION || '26.1'
})

bot.once('spawn', () => {
  console.log(`[test] spawned - mode: ${WET ? 'REAL BUILD' : 'dry run'}`)
  setTimeout(() => {
    send(WET ? '!dry off' : '!dry on')
    setTimeout(() => send(`!make ${REQUEST}`), 2500)
  }, 8000)
})

function send (line) {
  console.log(`[send] ${line}`)
  bot.chat(line)
}

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  console.log(`[chat] <${username}> ${message}`)
  if (/^Done!|^DRY RUN|Couldn't get a plan|didn't check out/.test(message)) {
    setTimeout(() => { console.log('[test] done'); bot.quit(); process.exit(0) }, 8000)
  }
})

bot.on('error', err => console.error('[test] error:', err.message))
setTimeout(() => { console.log('[test] TIMED OUT'); process.exit(1) }, 300000)
