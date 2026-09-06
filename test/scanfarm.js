const m=require('mineflayer'),{Vec3}=require('vec3')
const UX=+process.env.UX, UY=+process.env.UY, UZ=+process.env.UZ
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(100); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(80)
  // Find the extent of anything built (non-natural) near the player.
  const NATURAL=/^(air|grass_block|dirt|bedrock|stone|gravel|sand|short_grass|tall_grass|fern|.*_flower|dandelion|poppy)$/
  let lo={x:1e9,y:1e9,z:1e9},hi={x:-1e9,y:-1e9,z:-1e9},n=0
  const tally={}
  for(let x=UX-30;x<=UX+30;x++)for(let y=UY-25;y<=UY+25;y++)for(let z=UZ-30;z<=UZ+30;z++){
    const q=b.blockAt(new Vec3(x,y,z)); if(!q||NATURAL.test(q.name))continue
    tally[q.name]=(tally[q.name]||0)+1; n++
    lo.x=Math.min(lo.x,x);hi.x=Math.max(hi.x,x)
    lo.y=Math.min(lo.y,y);hi.y=Math.max(hi.y,y)
    lo.z=Math.min(lo.z,z);hi.z=Math.max(hi.z,z)
  }
  console.log('built blocks:',n)
  console.log('extent: x '+lo.x+'..'+hi.x+'  y '+lo.y+'..'+hi.y+'  z '+lo.z+'..'+hi.z)
  console.log('size:', (hi.x-lo.x+1)+'x'+(hi.y-lo.y+1)+'x'+(hi.z-lo.z+1))
  console.log('blocks used:')
  for(const [k,v] of Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log('  '+String(v).padStart(5)+'  '+k)
  console.log('EXTENT '+lo.x+' '+lo.y+' '+lo.z+' '+hi.x+' '+hi.y+' '+hi.z)
  b.quit()
})
