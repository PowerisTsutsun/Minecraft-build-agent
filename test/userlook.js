const m=require('mineflayer'),{Vec3}=require('vec3')
const UX=parseInt(process.env.UX,10),UY=parseInt(process.env.UY,10),UZ=parseInt(process.env.UZ,10)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(60)
  const t={}
  for(let x=-14;x<=14;x++)for(let y=-8;y<=10;y++)for(let z=-14;z<=14;z++){
    const q=b.blockAt(new Vec3(UX+x,UY+y,UZ+z)); if(!q||q.name==='air'||q.name==='grass_block'||q.name==='dirt'||q.name==='bedrock')continue
    t[q.name]=(t[q.name]||0)+1
  }
  console.log('blocks within 14 of you:')
  for(const [k,v] of Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,16)) console.log('  '+String(v).padStart(5)+'  '+k)
  console.log()
  for(let y=UY+3;y>=UY-4;y--){
    let row=''
    for(let x=UX-7;x<=UX+7;x++){
      const q=b.blockAt(new Vec3(x,y,UZ))
      const n=q?q.name:'?'
      row += n==='air'?'.':(n.includes('trapdoor')?'T':(n.includes('bed')?'B':(n.includes('water')?'~':(n.includes('composter')?'C':(n.includes('glass')?'G':(n.includes('hopper')?'H':(n.includes('chest')?'E':(n.includes('magma')?'M':'#'))))))))
    }
    console.log('  y='+String(y).padStart(3)+' '+row)
  }
  b.quit()
})
