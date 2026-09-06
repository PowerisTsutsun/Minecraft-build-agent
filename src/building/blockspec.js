'use strict'

// ---------------------------------------------------------------------------
// Block specs: a block id, optionally carrying a block state.
//
//   stone_bricks
//   stone_brick_stairs[facing=east,half=bottom]
//   oak_log[axis=x]
//
// This exists because /fill takes a state and bot.placeBlock does not. The
// wizard tower came out with all 23 of its staircase blocks facing north -
// every one of them - because `/fill minecraft:stone_brick_stairs` with no
// state gets the DEFAULT state, and for stairs that is facing=north. A helix of
// north-facing stairs is wrong on three quarters of every turn.
//
// THE GRAMMAR IS DELIBERATELY STRICT. A material string written by the model
// ends up inside a slash command the bot sends to the server, so it is
// untrusted input on a command line. Before states existed, isKnownBlock()
// happened to be the guard - only exact block ids got through. Allowing a
// bracketed suffix reopens that, so the suffix is matched against a whitelist
// grammar of [a-z0-9_]+=[a-z0-9_]+ pairs and anything else is rejected
// outright rather than sanitised.
//
// Only the fill path can honour a state. The survival placer places whatever
// block the item makes and the server decides its orientation, so it strips the
// state - documented rather than pretended away.
// ---------------------------------------------------------------------------

const SPEC = /^([a-z0-9_]+)(\[[a-z0-9_]+=[a-z0-9_]+(?:,[a-z0-9_]+=[a-z0-9_]+)*\])?$/

function parse (spec) {
  const text = String(spec == null ? '' : spec)
  const m = SPEC.exec(text)
  if (!m) return { base: text, state: '', valid: false }
  return { base: m[1], state: m[2] || '', valid: true }
}

// The block id without its state - what bot.blockAt() reports, what the
// inventory is searched by, and what every comparison in the codebase means
// when it says "is this block the one we asked for".
function baseName (spec) {
  return parse(spec).base
}

function hasState (spec) {
  return Boolean(parse(spec).state)
}

function isValidSpec (spec) {
  return parse(spec).valid
}

// Attach a state, unless the caller already chose one explicitly.
function withState (spec, state) {
  return hasState(spec) ? spec : `${baseName(spec)}[${state}]`
}

// The stairs/slab/wall sibling of a material, if the server has one.
// stone_bricks -> stone_brick_stairs, dark_oak_planks -> dark_oak_stairs,
// deepslate_tiles -> deepslate_tile_stairs, cobblestone -> cobblestone_stairs.
function familyVariant (material, suffix, isKnownBlock) {
  const b = baseName(material)
  const guesses = [
    b.replace(/_planks$/, '') + '_' + suffix,
    b.replace(/_bricks$/, '_brick') + '_' + suffix,
    b.replace(/_tiles$/, '_tile') + '_' + suffix,
    b + '_' + suffix
  ]
  return guesses.find(g => isKnownBlock(g)) || null
}

// A prismarine-block as a spec string, STATE INCLUDED.
//
// block.name is just the id. A schematic placed from names alone lands every
// bed as a default unpaired foot and every trapdoor flat on the floor - a
// verbatim copy of a working iron farm, placed that way, had villagers with no
// home, a zombie walking free, and made no iron. The state is right there in
// getProperties(); it just has to be carried.
function specOf (block) {
  if (!block) return null
  let props = {}
  try { props = block.getProperties() || {} } catch (err) { props = {} }
  const keys = Object.keys(props).sort()
  if (!keys.length) return block.name
  return `${block.name}[${keys.map(k => `${k}=${String(props[k])}`).join(',')}]`
}

module.exports = { parse, baseName, hasState, isValidSpec, withState, familyVariant, specOf }
