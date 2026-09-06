const m=require('mineflayer'); const {Vec3}=require('vec3')
const O=new Vec3(1122,-60,1220)
const b=m.createBot({host:'127.0.0.1',port:25566,username:'Scanner',version:'26.1'})
b.once('spawn',async()=>{
  await b.waitForTicks(90); await b.waitForChunksToLoad().catch(()=>{}); await b.waitForTicks(70)
  const tally={}, add=(k)=>tally[k]=(tally[k]||0)+1
  let panes=0, panesConnected=0, torches=0, torchDefault=0, lanterns=0, lanternHang=0
  for(let x=-4;x<=34;x++)for(let y=0;y<=34;y++)for(let z=-4;z<=34;z++){
    const q=b.blockAt(O.offset(x,y,z)); if(!q||q.name==='air') continue
    let p={}; try{p=q.getProperties()}catch(e){}
    if(/stairs$/.test(q.name)) add('stairs facing='+p.facing+' half='+p.half)
    if(/_pane$|iron_bars/.test(q.name)){ panes++; if(p.north===true||p.south===true||p.east===true||p.west===true) panesConnected++ }
    if(/wall_torch/.test(q.name)){ torches++; if(p.facing==='north') torchDefault++ }
    if(/lantern/.test(q.name)){ lanterns++; if(p.hanging===true) lanternHang++ }
  }
  console.log('stairs by state:'); for(const k of Object.keys(tally).sort()) console.log('  '+tally[k]+' x '+k)
  console.log(`panes/bars: ${panes}, of which connected: ${panesConnected}`)
  console.log(`wall torches: ${torches}, still default north: ${torchDefault}`)
  console.log(`lanterns: ${lanterns}, hanging: ${lanternHang}`)
  b.quit()
})
