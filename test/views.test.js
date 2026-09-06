'use strict'

// The PNG writer and the views built on it. `canvas` does not build on this Pi -
// it is a native module and the image has no cairo headers - so the encoder is
// written here on Node's zlib, and it needs its own tests because a malformed
// PNG fails silently as an unreadable attachment rather than an exception.

const zlib = require('zlib')
const png = require('../src/pipeline/png')
const views = require('../src/pipeline/views')
const primitives = require('../src/building/primitives')
const { validatePlan, renderPlan } = require('../src/commands/llm')
const mcData = require('minecraft-data')('26.1')

let failures = 0
function check (name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failures++
}
const real = n => Boolean(mcData.blocksByName[n.split('[')[0]])

// --- the encoder -----------------------------------------------------------
const w = 5
const h = 3
const px = Buffer.alloc(w * h * 3)
for (let i = 0; i < w * h; i++) { px[i * 3] = i * 10; px[i * 3 + 1] = 100; px[i * 3 + 2] = 200 }
const file = png.encode(w, h, px)

check('png: starts with the PNG signature',
  file.slice(0, 8).toString('hex') === '89504e470d0a1a0a')
check('png: declares the right dimensions',
  file.readUInt32BE(16) === w && file.readUInt32BE(20) === h,
  `${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`)
check('png: ends with IEND', file.slice(-8, -4).toString('ascii') === 'IEND')

const idatAt = file.indexOf(Buffer.from('IDAT')) + 4
const idatLen = file.readUInt32BE(idatAt - 8)
const raw = zlib.inflateSync(file.slice(idatAt, idatAt + idatLen))
check('png: the image data inflates to filter byte plus scanline, per row',
  raw.length === (w * 3 + 1) * h, `${raw.length} vs ${(w * 3 + 1) * h}`)
check('png: pixels survive the round trip',
  raw[1] === 0 && raw[2] === 100 && raw[3] === 200, [...raw.slice(1, 4)].join(','))
check('png: every chunk CRC is right', (() => {
  // Walk the chunks and re-check each CRC the way a decoder would.
  let at = 8
  while (at < file.length) {
    const len = file.readUInt32BE(at)
    const body = file.slice(at + 4, at + 8 + len)
    const stored = file.readUInt32BE(at + 8 + len)
    if (png.crc32(body) !== stored) return false
    at += 12 + len
  }
  return true
})())

// --- views over a real build -----------------------------------------------
const built = (() => {
  const v = validatePlan({
    summary: 'x',
    palette: { name: 'medieval_stone' },
    decor: { style: 'medieval_stone' },
    shell: [
      { op: 'tower', offset: { x: 0, y: 0, z: 0 }, diameter: 11, height: 22, storeys: 3, top: 'cone' },
      { op: 'hall', offset: { x: 14, y: 0, z: 0 }, width: 13, depth: 17, storeys: 2 }
    ]
  }, real)
  return renderPlan(v, primitives, { isKnownBlock: real })
})()

const text = views.textViews(built.blocks)
check('views: text names the build size and origin', /build is \d+ x \d+/.test(text))
check('views: has a plan and four elevations',
  ['PLAN', 'NORTH', 'SOUTH', 'WEST', 'EAST'].every(k => text.includes(k)))
check('views: distinguishes glazing and stairs from plain wall',
  text.includes('o') && text.includes('/') && text.includes('#'))

const iso = views.isometric(built.blocks, { tile: 6 })
check('views: renders an isometric image', Boolean(iso && iso.buffer))
check('views: the image is a valid PNG',
  iso.buffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a')

// The bug that cropped a tower's roof off the top of the canvas: a tall block
// projects UPWARD, so the vertical offset has to clear the whole build.
const tall = (() => {
  const v = validatePlan({
    summary: 'tall',
    shell: [{ op: 'cylinder', material: 'stone_bricks', offset: { x: 0, y: 0, z: 0 }, anchor: 'corner', radius: 3, height: 40, hollow: false }]
  }, real)
  return renderPlan(v, primitives, { isKnownBlock: real })
})()
const tallIso = views.isometric(tall.blocks, { tile: 4 })
const inflatedTall = (() => {
  const at = tallIso.buffer.indexOf(Buffer.from('IDAT')) + 4
  const len = tallIso.buffer.readUInt32BE(at - 8)
  return zlib.inflateSync(tallIso.buffer.slice(at, at + len))
})()
const stride = tallIso.width * 3 + 1
// The topmost rows must contain something other than the background.
const topRowsPainted = (() => {
  for (let y = 1; y < Math.min(20, tallIso.height); y++) {
    for (let x = 1; x < stride; x++) {
      const v = inflatedTall[y * stride + x]
      if (v !== 24 && v !== 26 && v !== 32) return true
    }
  }
  return false
})()
check('views: a tall build is not cropped off the top of the canvas', topRowsPainted)

check('views: a gigantic build is skipped rather than allocated',
  (() => {
    const huge = { blocks: [] }
    for (let i = 0; i < 4; i++) {
      huge.blocks.push({ pos: { x: i * 900, y: 0, z: i * 900 }, name: 'stone' })
    }
    const r = views.isometric(huge.blocks, { tile: 12 })
    return r && r.tooBig
  })())

console.log(failures ? `\n${failures} FAILURES` : '\nall passed')
process.exit(failures ? 1 : 0)
