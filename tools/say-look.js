'use strict'
// Join as TestPlayer, look at a point (so the bot has a real crosshair), send
// a chat line, echo replies. usage: node tools/say-look.js <lx> <ly> <lz> <msg...>
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const [lx, ly, lz, ...rest] = process.argv.slice(2)
const line = rest.join(' ')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'TestPlayer', version: '26.1' })
bot.on('chat', (u, m) => console.log(`<${u}> ${m}`))
bot.on('error', e => console.error('error', e.message))
bot.once('spawn', () => {
  setTimeout(async () => {
    await bot.lookAt(new Vec3(+lx + 0.5, +ly + 0.5, +lz + 0.5), true)
    console.log('looking at', lx, ly, lz, 'from', bot.entity.position, 'yaw', bot.entity.yaw.toFixed(2), 'pitch', bot.entity.pitch.toFixed(2))
    bot.chat(line)
  }, 9000)
})
setTimeout(() => { bot.quit(); process.exit(0) }, parseInt(process.env.SAY_WAIT || '90000', 10))
