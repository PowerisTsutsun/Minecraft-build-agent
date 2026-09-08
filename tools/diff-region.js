'use strict'
// Compare the world against a template/schematic after placement.
// usage: node tools/diff-region.js <file> <originX> <originY> <originZ> [x0 x1 y0 y1 z0 z1]
const mineflayer = require('mineflayer'); const { Vec3 } = require('vec3')
const { loadSchematic } = require('../src/building/schematic')
const [file, ox, oy, oz, ...box] = process.argv.slice(2)
const O = new Vec3(+ox, +oy, +oz)
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'Surveyor', version: '26.1' })
bot.once('spawn', async () => {
  const s = await loadSchematic(file, '26.1'); const st = s.start()
  const [x0, x1, y0, y1, z0, z1] = box.length ? box.map(Number) : [0, s.size.x - 1, 0, s.size.y - 1, 0, s.size.z - 1]
  // Wait until the region really is loaded, sampled across the whole box - not
  // just two corners. On a 76x118x80 region the corners can arrive while the
  // middle is still empty, and every unloaded cell reads as a false difference.
  const probes = []
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) for (let k = 0; k <= 4; k++) {
    probes.push(O.offset(x0 + Math.round((x1 - x0) * i / 4), y0 + Math.round((y1 - y0) * j / 4), z0 + Math.round((z1 - z0) * k / 4)))
  }
  for (let i = 0; i < 120; i++) {
    const missing = probes.filter(p => !bot.blockAt(p)).length
    if (!missing) break
    if (i % 20 === 19) console.log(`waiting for world: ${missing}/${probes.length} sample cells still empty`)
    await bot.waitForTicks(10)
  }
  let same = 0; let unloaded = 0; const diffs = []
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const want = s.getBlock(new Vec3(st.x + x, st.y + y, st.z + z)).name
    const have = bot.blockAt(O.offset(x, y, z)); const hn = have ? have.name : 'UNLOADED'
    if (hn === 'UNLOADED') { unloaded++; continue }
    if (want === hn) same++; else diffs.push(`${x},${y},${z} want ${want} have ${hn}`)
  }
  console.log(`same ${same}, different ${diffs.length}, unloaded ${unloaded}`)
  const byKind = {}
  for (const d of diffs) { const m = d.match(/want (\S+) have (\S+)/); if (m) { const k = `${m[1]} -> ${m[2]}`; byKind[k] = (byKind[k] || 0) + 1 } }
  console.log('mismatch kinds:', Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} x${v}`).join(' | ')); console.log(diffs.slice(0, 80).join('\n'))
  bot.quit(); process.exit(0)
})
bot.on('error', e => { console.error(e.message); process.exit(1) })
