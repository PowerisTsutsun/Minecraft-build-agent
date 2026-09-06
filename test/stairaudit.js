const m=require('mineflayer'); const {Vec3}=require('vec3')
const O=new Vec3(1082,-60,1120)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
bot_main()
function bot_main(){
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(70)
  const solid=p=>{const q=b.blockAt(p); return q && q.boundingBox==='block'}
  for (const [label, ox,oy,oz, axis, width, rise] of [
      ['interior grand stair', 6,1,8, 'z', 5, 7],
      ['garden stair',6,-2,28,'z',5,4]]) {
    const treads=[]
    for(let x=-3;x<=width+3;x++)for(let y=-3;y<=rise+4;y++)for(let z=-3;z<=rise+6;z++){
      const p=O.offset(ox+x,oy+y,oz+z); const q=b.blockAt(p)
      if(q && /_stairs$/.test(q.name)){let pr={};try{pr=q.getProperties()}catch(e){}; if(pr.facing==='south'&&pr.half==='bottom') treads.push({p,q})}
    }
    let floating=0, unsupported=[]
    for(const t of treads){
      for(let y=t.p.y-1;y>=O.y+oy;y--){ if(!solid(new Vec3(t.p.x,y,t.p.z))){ floating++; unsupported.push(`${t.p.x},${y},${t.p.z}`); break } }
    }
    const facings=new Set(treads.map(t=>{let p={};try{p=t.q.getProperties()}catch(e){};return p.facing}))
    console.log(`${label}: ${treads.length} stair blocks, facings {${[...facings].join(',')}}, floating: ${floating}${floating?' at '+unsupported.slice(0,3).join(' '):''}`)
  }
  b.quit()
})}
