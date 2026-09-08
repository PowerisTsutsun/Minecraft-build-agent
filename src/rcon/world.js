'use strict'

const { Vec3 } = require('vec3')

// ---------------------------------------------------------------------------
// Reading the world through RCON.
//
// There is no bulk read here - every question is one command - but a round
// trip on a local socket is well under a millisecond, so a raycast or a ground
// probe costs nothing worth counting.
// ---------------------------------------------------------------------------

const NUMS = /-?\d+\.?\d*/g

async function entityData (rcon, name, path) {
  const out = await rcon.send(`data get entity ${name} ${path}`)
  if (/No entity was found|Found no elements/i.test(out)) return null
  const nums = out.match(NUMS)
  return nums ? nums.map(Number) : null
}

async function playerPos (rcon, name) {
  // "X has the following entity data: [1.0d, 2.0d, 3.0d]" - the leading name
  // can contain digits, so read only the bracketed list.
  const out = await rcon.send(`data get entity ${name} Pos`)
  const list = out.slice(out.indexOf('['))
  const nums = list.match(NUMS)
  if (!nums || nums.length < 3) return null
  return new Vec3(Number(nums[0]), Number(nums[1]), Number(nums[2]))
}

async function playerRotation (rcon, name) {
  const out = await rcon.send(`data get entity ${name} Rotation`)
  const list = out.slice(out.indexOf('['))
  const nums = list.match(NUMS)
  if (!nums || nums.length < 2) return null
  return { yaw: Number(nums[0]), pitch: Number(nums[1]) }
}

async function isAir (rcon, x, y, z) {
  const out = await rcon.send(`execute if block ${x} ${y} ${z} minecraft:air`)
  return /passed/i.test(out)
}

// Vanilla NBT Rotation is DEGREES, and its pitch is positive DOWNWARD - the
// opposite sign to mineflayer's radians. Getting that backwards sends the ray
// into the sky, which is exactly the bug the mineflayer crosshair had.
function viewVector (yawDeg, pitchDeg) {
  const yaw = yawDeg * Math.PI / 180
  const pitch = pitchDeg * Math.PI / 180
  const cp = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp)
}

// The block a player is looking at, returned as the cell ON TOP of it - the
// natural corner to stand a build on. Null if they are looking at open sky.
async function crosshairTarget (rcon, name, maxDist = 96) {
  const pos = await playerPos(rcon, name)
  const rot = await playerRotation(rcon, name)
  if (!pos || !rot) return null
  const eye = pos.offset(0, 1.62, 0)
  const dir = viewVector(rot.yaw, rot.pitch)

  let last = null
  for (let d = 0.3; d <= maxDist; d += 0.3) {
    const p = eye.plus(dir.scaled(d))
    const cell = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    if (last && cell.equals(last)) continue
    last = cell
    if (cell.y < -64 || cell.y > 319) continue
    if (!(await isAir(rcon, cell.x, cell.y, cell.z))) {
      return new Vec3(cell.x, cell.y + 1, cell.z)
    }
  }
  return null
}

async function findGroundY (rcon, x, z, startY, maxDrop = 200) {
  let y = Math.floor(startY)
  for (let i = 0; i < maxDrop; i++) {
    if (!(await isAir(rcon, x, y - 1, z))) return y
    y--
  }
  return Math.floor(startY)
}

module.exports = { playerPos, playerRotation, crosshairTarget, isAir, findGroundY, viewVector, entityData }
