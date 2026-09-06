const m=require('mineflayer'); const {Vec3}=require('vec3')
const O=new Vec3(1200,-60,1085)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(70)
  // Ground-level plan of the whole castle: where can a player actually walk?
  for (const dy of [1,2]) {
    console.log(`--- y+${dy}  (#=solid  .=walkable) ---`)
    for (let dz=0; dz<=40; dz++){
      let row=''
      for (let dx=0; dx<=40; dx++){
        const q=b.blockAt(O.offset(dx,dy,dz))
        row += !q ? '?' : q.boundingBox==='block' ? '#' : '.'
      }
      console.log('  '+row)
    }
  }
  bot_done()
  function bot_done(){ b.quit() }
})
