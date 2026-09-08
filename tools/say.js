'use strict'
// Join as TestPlayer, say one chat line (argv), echo replies for a while, quit.
const mineflayer = require('mineflayer')
const line = process.argv.slice(2).join(' ')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'TestPlayer', version: '26.1' })
bot.on('chat', (u, m) => console.log(`<${u}> ${m}`))
bot.once('spawn', () => setTimeout(() => bot.chat(line), 8000))
setTimeout(() => { bot.quit(); process.exit(0) }, parseInt(process.env.SAY_WAIT || '20000', 10))
