const mineflayer = require('mineflayer'); const { Vec3 } = require('vec3')
const O = new Vec3(1155, -60, 1170)
const bot = mineflayer.createBot({ host:'127.0.0.1', port:25566, username:'Scanner', version:'26.1' })
bot.once('spawn', async () => {
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await bot.waitForTicks(80); await bot.waitForChunksToLoad().catch(()=>{}); await bot.waitForTicks(60)
  for (let dy=0; dy<=46; dy++) {
    const s=[]; let solid=0
    for (let dx=0; dx<=12; dx++) for (let dz=0; dz<=12; dz++) {
      const b=bot.blockAt(O.offset(dx,dy,dz)); if(!b) continue
      if (b.name.includes('stairs')) s.push(`${dx},${dz}`)
      if (b.boundingBox==='block') solid++
    }
    console.log(`y+${String(dy).padStart(2)}  stairs:${String(s.length).padStart(2)} ${s.slice(0,4).join(' ')}   solidBlocks:${solid}`)
  }
  bot.quit()
})
