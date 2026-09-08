const fs=require('fs'), nbt=require('prismarine-nbt'), zlib=require('zlib')
// 3x3x3 cube of nether_portal, no frame - the exact thing /fill cannot keep.
const size=3, blocks=[]
for(let y=0;y<size;y++)for(let z=0;z<size;z++)for(let x=0;x<size;x++)blocks.push({pos:{type:'list',value:{type:'int',value:[x,y,z]}},state:{type:'int',value:0}})
const root={type:'compound',name:'',value:{
  DataVersion:{type:'int',value:4325},
  size:{type:'list',value:{type:'int',value:[size,size,size]}},
  palette:{type:'list',value:{type:'compound',value:[{Name:{type:'string',value:'minecraft:nether_portal'},Properties:{type:'compound',value:{axis:{type:'string',value:'x'}}}}]}},
  blocks:{type:'list',value:{type:'compound',value:blocks}},
  entities:{type:'list',value:{type:'end',value:[]}}
}}
fs.writeFileSync('/tmp/portaltest.nbt', zlib.gzipSync(nbt.writeUncompressed(root)))
console.log('written', fs.statSync('/tmp/portaltest.nbt').size,'bytes')
