const m=require('mineflayer'),{Vec3}=require('vec3')
const FX=parseInt(process.env.FX,10), FZ=parseInt(process.env.FZ,10)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(60)
  console.log('pod at y=-46:')
  for(let z=FZ-2;z<=FZ+4;z++){
    let row=''
    for(let x=FX-4;x<=FX+4;x++){
      const q=b.blockAt(new Vec3(x,-46,z))
      const n=q?q.name:'?'
      row += n==='air'?' . ':(n.includes('trapdoor')?' T ':(n.includes('bed')?' B ':(n.includes('composter')?' C ':(n==='stone_bricks'?' # ':' '+n[0]+' '))))
    }
    console.log('  z='+z+row)
  }
  console.log()
  console.log('exact blocks at the cells beside the zombie:')
  for(const [x,z] of [[FX-1,FZ+1],[FX+1,FZ+1],[FX,FZ+1],[FX,FZ+2],[FX,FZ]]) {
    const q=b.blockAt(new Vec3(x,-46,z)); let p={}; try{p=q.getProperties()}catch(e){}
    console.log('  ('+x+',-46,'+z+') = '+(q?q.name:'?')+' '+JSON.stringify(p))
  }
  b.quit()
})
