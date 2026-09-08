'use strict'
// One-off driver: join as a player, ask BuilderBot to place the iron_farm
// template, echo its chat, leave.
const mineflayer = require('mineflayer')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'TestPlayer', version: '26.1' })
bot.on('chat', (u, m) => console.log(`<${u}> ${m}`))
bot.on('error', e => console.error('error', e.message))
bot.once('spawn', () => {
  console.log('spawned', bot.entity.position)
  setTimeout(() => { console.log('at', bot.entity.position); bot.chat('!schem 30808') }, 12000)
})
setTimeout(() => { bot.quit(); process.exit(0) }, 1500000)
