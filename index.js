'use strict'

// Entry point. Everything of substance lives in src/ - see src/bot.js for the
// connection, src/building/ for placement, src/commands/ for chat handling.
// The pre-refactor single-file version is kept as index.js.pre-refactor.bak.

const { createBuilderBot, configureMovements } = require('./src/bot')
const commands = require('./src/commands')
const { CONNECTION } = require('./src/config')

const bot = createBuilderBot()
commands.register(bot)

bot.once('spawn', () => {
  configureMovements(bot, [])
  // Harmless no-op without op. With op it stops the bot taking suffocation or
  // fall damage while it stands next to (or briefly inside) what it is filling,
  // and means the walking fallback never runs its inventory dry.
  bot.chat('/gamemode creative')
  // Sweep any forceload orphaned by a crash between add and remove; left alone
  // they pin chunks loaded for the life of the server.
  bot.chat('/forceload remove all')
  bot.chat('BuilderBot online. !help for commands, !make <description> for plain English.')
  console.log(`Connected to ${CONNECTION.host}:${CONNECTION.port} as ${bot.username} (${CONNECTION.version})`)
  console.log(`LLM builds ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'DISABLED - no ANTHROPIC_API_KEY set'}`)
})
