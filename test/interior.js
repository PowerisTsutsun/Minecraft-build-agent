const m=require('mineflayer'),{Vec3}=require('vec3')
const OX=parseInt(process.env.IX,10), OZ=parseInt(process.env.IZ,10)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  await b.waitForTicks(100); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(80)
  // Find the interior: cells with air at head height enclosed by solid.
  const solid=p=>{const q=b.blockAt(p);return q&&q.boundingBox==='block'}
  let inside=0, lit=0, furnished=0, bareWall=0
  const floors={}, wallKinds={}, furniture={}
  for(let x=-4;x<=60;x++)for(let z=-4;z<=60;z++)for(let y=-59;y<=-35;y++){
    const p=new Vec3(OX+x,y,OZ+z)
    const q=b.blockAt(p); if(!q) continue
    if(q.name!=='air') continue
    // enclosed? solid above within 6 and solid on 3+ sides within 8
    let roof=false
    for(let d=1;d<=6;d++) if(solid(p.offset(0,d,0))){roof=true;break}
    if(!roof) continue
    let walls=0
    for(const d of [[1,0],[-1,0],[0,1],[0,-1]]){
      for(let r=1;r<=8;r++){ if(solid(p.offset(d[0]*r,0,d[1]*r))){walls++;break} }
    }
    if(walls<4) continue
    inside++
    const below=b.blockAt(p.offset(0,-1,0))
    if(below&&below.boundingBox==='block') floors[below.name]=(floors[below.name]||0)+1
    const here=b.blockAt(p)
    // light source nearby?
    for(let dx=-4;dx<=4;dx++)for(let dy=-2;dy<=3;dy++)for(let dz=-4;dz<=4;dz++){
      const l=b.blockAt(p.offset(dx,dy,dz))
      if(l&&/torch|lantern|glowstone|sea_lantern|campfire|candle|shroomlight|froglight/.test(l.name)){lit++;dx=dz=99;dy=99;break}
    }
  }
  console.log('interior air cells found:', inside)
  console.log('of those within 4 blocks of a light:', lit, '('+Math.round(100*lit/Math.max(1,inside))+'%)')
  console.log('floor materials under them:', JSON.stringify(floors))
  b.quit()
})
