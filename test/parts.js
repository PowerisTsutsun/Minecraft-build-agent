const m=require('mineflayer'),{Vec3}=require('vec3')
const UX=+process.env.UX, UY=+process.env.UY, UZ=+process.env.UZ
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(100); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(80)
  const KEY=/bed|fletching_table|hopper|chest|water|lava|trapdoor|lantern|glass_pane|slab/
  const hits=[]
  for(let x=UX-30;x<=UX+30;x++)for(let y=UY-25;y<=UY+25;y++)for(let z=UZ-30;z<=UZ+30;z++){
    const q=b.blockAt(new Vec3(x,y,z)); if(!q||!KEY.test(q.name))continue
    hits.push({x,y,z,n:q.name})
  }
  // cluster around the hopper - that is the collection point of the farm
  const hop=hits.filter(h=>h.n==='hopper')[0]
  console.log('hopper at', hop? hop.x+','+hop.y+','+hop.z : 'none')
  const near=hits.filter(h=>hop && Math.abs(h.x-hop.x)<=20 && Math.abs(h.z-hop.z)<=20 && Math.abs(h.y-hop.y)<=20)
  const lo={x:1e9,y:1e9,z:1e9},hi={x:-1e9,y:-1e9,z:-1e9}
  for(const h of near){lo.x=Math.min(lo.x,h.x);hi.x=Math.max(hi.x,h.x);lo.y=Math.min(lo.y,h.y);hi.y=Math.max(hi.y,h.y);lo.z=Math.min(lo.z,h.z);hi.z=Math.max(hi.z,h.z)}
  console.log('farm parts span: x '+lo.x+'..'+hi.x+' y '+lo.y+'..'+hi.y+' z '+lo.z+'..'+hi.z)
  console.log('key parts:')
  for(const k of ['white_bed','fletching_table','hopper','chest','lava','water','lantern']){
    const v=near.filter(h=>h.n===k)
    if(v.length) console.log('  '+k+' x'+v.length+':  '+v.slice(0,4).map(h=>h.x+','+h.y+','+h.z).join('  '))
  }
  console.log('FARM '+lo.x+' '+lo.y+' '+lo.z+' '+hi.x+' '+hi.y+' '+hi.z)
  b.quit()
})
