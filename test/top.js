const mineflayer=require('mineflayer'); const {Vec3}=require('vec3')
const O=new Vec3(1155,-60,1170)
const bot=mineflayer.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
bot.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await bot.waitForTicks(80); await bot.waitForChunksToLoad().catch(()=>{}); await bot.waitForTicks(60)
  for (const dy of [33,34,35]) {
    console.log(`--- y+${dy} ---  (S=stairs  #=solid  .=air/passable)`)
    for (let dz=0; dz<=12; dz++) {
      let row=''
      for (let dx=0; dx<=12; dx++) {
        const b=bot.blockAt(O.offset(dx,dy,dz))
        row += !b ? '?' : b.name.includes('stairs') ? 'S' : b.boundingBox==='block' ? '#' : '.'
      }
      console.log('  '+row)
    }
  }
  // Standing room: where on the balcony can a player actually stand?
  let stand=0
  for (let dx=0;dx<=12;dx++) for (let dz=0;dz<=12;dz++){
    const floor=bot.blockAt(O.offset(dx,33,dz)), f=bot.blockAt(O.offset(dx,34,dz)), h=bot.blockAt(O.offset(dx,35,dz))
    if (floor && floor.boundingBox==='block' && f && f.boundingBox!=='block' && h && h.boundingBox!=='block') stand++
  }
  console.log(`\nplayer-standable cells on the gallery floor (y+33): ${stand}`)
  bot.quit()
})
