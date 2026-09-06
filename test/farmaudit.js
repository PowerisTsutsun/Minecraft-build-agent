const m=require('mineflayer'); const {Vec3}=require('vec3')
const O=new Vec3(1244,-64,1124)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  // Normal difficulty means mobs fight back; a scanner that dies mid-read
  // returns half a world. Spectator is immune and still reads blocks.
  b.chat('/gamemode spectator')
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(70)
  const tally={}
  for(let x=-6;x<=32;x++)for(let y=0;y<=34;y++)for(let z=-6;z<=32;z++){
    const q=b.blockAt(O.offset(x,y,z)); if(!q||q.name==='air') continue
    tally[q.name]=(tally[q.name]||0)+1
  }
  const want=['water','lava','magma_block','hopper','chest','red_bed','white_bed','composter','smoker','fletching_table','cartography_table','glass','iron_bars','oak_trapdoor','rail','redstone_wire','slab','stairs','polished_andesite']
  console.log('--- functional parts present ---')
  for(const w of want){
    const n=Object.entries(tally).filter(([k])=>k.includes(w)).reduce((a,[,v])=>a+v,0)
    console.log('  '+w.padEnd(20), n||'-')
  }
  console.log('--- 12 most common blocks ---')
  for(const [k,v] of Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log('  '+String(v).padStart(5), k)
  console.log('--- entities in the area ---')
  const near=Object.values(b.entities).filter(e=>e.position && e.position.distanceTo(O.offset(13,8,13))<40)
  const kinds={}; for(const e of near) kinds[e.name||e.type]=(kinds[e.name||e.type]||0)+1
  console.log('  ', JSON.stringify(kinds))
  b.quit()
})
