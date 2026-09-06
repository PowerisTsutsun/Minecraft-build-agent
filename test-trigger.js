'use strict'
// Throwaway "test player" bot: joins, sends a build command, watches
// BuilderBot's chat responses for a while, then disconnects.
const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: 'TestPlayer',
  version: process.env.MC_VERSION || '26.1'
})

bot.once('spawn', () => {
  console.log('[test] TestPlayer spawned, waiting for world data before sending build command')
  // Sending !build immediately after spawn races BuilderBot's own chunk/world
  // load - bot.blockAt() returns nothing yet, every neighbor check fails, and
  // the whole 170-block build fails instantly ("0 placed, 170 unreachable")
  // within the same tick. A real player takes much longer than 1s to type a
  // chat command after joining, so this was a test-harness bug, not a
  // BuilderBot bug. Give it a real margin instead.
  setTimeout(() => bot.chat('!build house 7 6 4 oak_planks'), 8000)
})

bot.on('chat', (username, message) => {
  console.log(`[chat] <${username}> ${message}`)
})

bot.on('error', err => console.error('[test] error:', err))
bot.on('end', reason => console.log('[test] disconnected:', reason))

// Stay connected long enough to watch the whole build, then leave.
setTimeout(() => {
  console.log('[test] test window over, quitting')
  bot.quit()
  process.exit(0)
}, 900000)
