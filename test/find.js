const m=require('mineflayer'),{Vec3}=require('vec3')
const FX=parseInt(process.env.FX,10), FZ=parseInt(process.env.FZ,10)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(60)
  const found={}
  for(let x=FX-20;x<=FX+20;x++)for(let y=-52;y<=-36;y++)for(let z=FZ-20;z<=FZ+20;z++){
    const q=b.blockAt(new Vec3(x,y,z)); if(!q) continue
    if(/trapdoor|bed|composter|planks|torch/.test(q.name)){
      if(!found[q.name]) found[q.name]=[]
      found[q.name].push([x,y,z])
    }
  }
  for(const [k,v] of Object.entries(found)){
    const ys=[...new Set(v.map(c=>c[1]))].sort((a,b)=>a-b)
    console.log(k+': '+v.length+' at y '+ys.join(','))
    if(k.includes('trapdoor')) for(const c of v.slice(0,6)) console.log('    '+c.join(','))
  }
  b.quit()
})
