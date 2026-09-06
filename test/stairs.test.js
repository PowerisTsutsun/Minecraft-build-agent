'use strict'

// The straight-flight stair op. Written as the recipe's own checklist, because
// the build it replaces failed every line of it at once: a helix of full blocks
// hanging in the air, no mass underneath, no stringer, no posts, no lights.

const primitives = require('../src/building/primitives')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}

const solidsOf = f => f.filter(b => b.name !== 'air')
const key = b => `${b.pos.x},${b.pos.y},${b.pos.z}`
const mapOf = f => new Map(solidsOf(f).map(b => [key(b), b.name]))

const basic = primitives.stairs({
  axis: 'x', ascent: '+', width: 3, rise: 8,
  tread: 'stone_brick_stairs', fill: 'stone_bricks', stringer: 'cobblestone',
  postHeight: 3, lights: 'torch', lightEvery: 4
})
const cells = mapOf(basic)
const treads = solidsOf(basic).filter(b => /stairs/.test(b.name))

// 1. treads face the direction of ascent
check('treads face the ascent direction',
  treads.length > 0 && treads.every(b => /facing=east/.test(b.name)),
  [...new Set(treads.map(b => /facing=(\w+)/.exec(b.name)[1]))].join(','))

// 2. nothing floats
const floating = treads.filter(t => {
  for (let y = t.pos.y - 1; y >= 0; y--) {
    if (!cells.has(`${t.pos.x},${y},${t.pos.z}`)) return true
  }
  return false
})
check('every tread is solid all the way down to the floor', floating.length === 0, `${floating.length} floating`)

// 3. the stringer runs one block above the tread beside it
const rows = new Map()
for (const t of treads) rows.set(t.pos.x, t.pos.y)
let railOk = true
for (const [x, y] of rows) {
  const left = cells.get(`${x},${y + 1},${-1}`)
  const right = cells.get(`${x},${y + 1},${3}`)
  if (!left || !right) railOk = false
}
check('a stringer runs up each open side, one block proud of its tread', railOk)

// 4. posts at both ends, taller than the stringer, carrying the lights
const topOfRail = x => {
  let top = -1
  for (let y = 0; y < 40; y++) if (cells.has(`${x},${y},-1`)) top = y
  return top
}
// Compare each post to ITS OWN tread, not to absolute height - a stringer
// halfway up a flight is naturally as high as the post at the bottom.
const proud = x => topOfRail(x) - rows.get(x)
const ends = [0, 7]
const middles = [3, 5] // steps 3 and 5 carry no light; step 4 does (light_every 4)
check('posts stand proud of their own tread at both ends, plain stringer between',
  ends.every(e => proud(e) === 4) && middles.every(m => proud(m) === 1),
  `ends ${ends.map(proud)} vs middle ${middles.map(proud)}`)
check('light_every puts a light on the stringer mid-flight', proud(4) === 2, `step 4 proud ${proud(4)}`)
const torches = solidsOf(basic).filter(b => b.name === 'torch')
check('lights sit on the posts', torches.length >= 4, `${torches.length} torches`)

// 5. headroom is carved above every tread
const air = new Set(basic.filter(b => b.name === 'air').map(key))
check('three blocks of headroom over every tread',
  treads.every(t => [1, 2, 3].every(h => air.has(`${t.pos.x},${t.pos.y + h},${t.pos.z}`))))

// 6. THE RISE INVARIANT: a flight gains exactly `rise`, landings included.
for (const [rise, landing, turn] of [[8, 0, 'none'], [12, 6, 'none'], [12, 6, 'right'], [15, 5, 'left']]) {
  const f = primitives.stairs({
    axis: 'x', ascent: '+', width: 3, rise, tread: 'stone_brick_stairs', fill: 'stone_bricks',
    stringer: 'cobblestone', landingEvery: landing, turn
  })
  const t = solidsOf(f).filter(b => /stairs/.test(b.name))
  const top = Math.max(...t.map(b => b.pos.y))
  check(`rise ${rise} (landing ${landing}, turn ${turn}): top tread is exactly rise-1 above the floor`,
    top === rise - 1, `top tread at y=${top}`)
}

// 7. a turn actually changes direction
const turned = primitives.stairs({
  axis: 'x', ascent: '+', width: 3, rise: 12, tread: 'stone_brick_stairs',
  fill: 'stone_bricks', stringer: 'cobblestone', landingEvery: 6, turn: 'right'
})
const tt = solidsOf(turned).filter(b => /stairs/.test(b.name))
const lowHalf = tt.filter(b => b.pos.y < 6)
const highHalf = tt.filter(b => b.pos.y >= 6)
const spread = list => ({
  x: Math.max(...list.map(b => b.pos.x)) - Math.min(...list.map(b => b.pos.x)),
  z: Math.max(...list.map(b => b.pos.z)) - Math.min(...list.map(b => b.pos.z))
})
check('turn right: the flight runs along x, then along z',
  spread(lowHalf).x > spread(lowHalf).z && spread(highHalf).z > spread(highHalf).x,
  `low ${JSON.stringify(spread(lowHalf))} high ${JSON.stringify(spread(highHalf))}`)
check('turn right: the upper flight faces a new direction',
  new Set(tt.map(b => /facing=(\w+)/.exec(b.name)[1])).size === 2,
  [...new Set(tt.map(b => /facing=(\w+)/.exec(b.name)[1]))].join(','))

// 8. flare widens the bottom steps
const flared = primitives.stairs({
  axis: 'x', ascent: '+', width: 3, rise: 6, tread: 'stone_brick_stairs',
  fill: 'stone_bricks', stringer: 'cobblestone', flare: 2
})
const widthAt = (list, x) => new Set(list.filter(b => b.pos.x === x).map(b => b.pos.z)).size
const ft = solidsOf(flared).filter(b => /stairs/.test(b.name))
check('flare widens the bottom steps only',
  widthAt(ft, 0) === 5 && widthAt(ft, 1) === 5 && widthAt(ft, 2) === 3,
  `${widthAt(ft, 0)}, ${widthAt(ft, 1)}, ${widthAt(ft, 2)}`)

// 9. options
const oneSided = primitives.stairs({ axis: 'x', ascent: '+', width: 3, rise: 5, tread: 'oak_stairs', fill: 'oak_planks', stringer: 'stone_bricks', sides: 'left' })
check('sides: left puts a stringer on one side only',
  mapOf(oneSided).has('0,0,-1') && !mapOf(oneSided).has('0,0,3'))
const bare = primitives.stairs({ axis: 'x', ascent: '+', width: 3, rise: 5, tread: 'oak_stairs', fill: 'oak_planks', stringer: null })
check('stringer null: no side walls at all',
  solidsOf(bare).every(b => b.pos.z >= 0 && b.pos.z <= 2))

const garden = primitives.stairs({
  axis: 'z', ascent: '+', width: 4, rise: 6, tread: 'dark_oak_stairs', fill: 'dark_oak_planks',
  stringerPattern: ['oak_log[axis=y]', 'oak_leaves'], lights: 'lantern'
})
const rails = solidsOf(garden).filter(b => /log|leaves/.test(b.name))
check('stringer_pattern alternates per step',
  rails.some(b => /oak_log/.test(b.name)) && rails.some(b => /oak_leaves/.test(b.name)))
check('leaves are made persistent automatically',
  rails.filter(b => /leaves/.test(b.name)).every(b => /persistent=true/.test(b.name)),
  rails.filter(b => /leaves/.test(b.name))[0] && rails.filter(b => /leaves/.test(b.name))[0].name)
check('lantern lights are placed standing, not hanging',
  solidsOf(garden).some(b => b.name === 'lantern[hanging=false]'))

const railed = primitives.stairs({ axis: 'x', ascent: '+', width: 3, rise: 5, tread: 'stone_brick_stairs', fill: 'stone_bricks', stringer: 'oak_stairs' })
check('a stairs stringer is oriented like a sloped handrail',
  solidsOf(railed).some(b => /^oak_stairs\[facing=east/.test(b.name)))

const northward = primitives.stairs({ axis: 'z', ascent: '-', width: 2, rise: 4, tread: 'stone_brick_stairs', fill: 'stone_bricks', stringer: null })
check('ascent "-" climbs the other way',
  solidsOf(northward).filter(b => /stairs/.test(b.name)).every(b => /facing=north/.test(b.name)))

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
