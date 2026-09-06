const m=require('mineflayer'),{Vec3}=require('vec3')
const templates=require('/app/src/building/templates')
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Exporter',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(110); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(90)
  const lo=new Vec3(1804,-62,993), hi=new Vec3(1817,-52,1003)
  const probe=b.blockAt(new Vec3(1811,-60,997))
  console.log('probe bed cell:', probe?probe.name:'NO DATA')
  if(!probe||probe.name==='air'){ console.log('chunks not loaded - aborting'); return b.quit() }
  try{
    const meta=await templates.exportRegion(b,'iron_farm',lo,hi,{
      needs:['3 villagers','1 zombie','3 beds','3 workstations'],
      produces:'iron ingots at the double chest'
    })
    console.log('exported', meta.size.x+'x'+meta.size.y+'x'+meta.size.z, meta.blocks+'blocks')
    console.log('mechanism parts captured:', JSON.stringify(meta.notable))
  }catch(e){ console.log('ERROR:',e.message) }
  b.quit()
})
