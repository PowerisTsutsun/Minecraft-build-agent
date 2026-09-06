'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const { CONNECTION, SCAFFOLD_BLOCK } = require('./config')
const { baseName, isValidSpec } = require('./building/blockspec')

// ---------------------------------------------------------------------------
// Connection and lifecycle.
// ---------------------------------------------------------------------------

function createBuilderBot () {
  const bot = mineflayer.createBot(CONNECTION)
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)

  bot.on('kicked', reason => console.log('Kicked:', reason))
  bot.on('error', console.error)
  bot.on('end', reason => console.log('Disconnected:', reason))

  return bot
}

function registry (bot) {
  return bot.registry || require('minecraft-data')(bot.version)
}

// ---------------------------------------------------------------------------
// Movement setup.
//
// allow1by1towers lets pathfinder pillar straight up, which is the only way the
// bot can physically reach the roof layer - a player standing on the floor
// cannot reach a block 5 up and 3 across. It needs scaffolding blocks in its
// inventory for that, and permission to mine them back out again. Everything
// the structure is made of goes in blocksCantBreak so the pathfinder never
// demolishes what it just built to make itself a shortcut.
// ---------------------------------------------------------------------------
// `canDig` is an option because it must be turned OFF while the bot is doing
// its own digging (undo). mineflayer-pathfinder's resetPath() calls
// bot.stopDigging() whenever its internal `digging` flag is set, and it resets
// its path whenever the world changes - which our own digging does. The result
// is the pathfinder cancelling our dig with "Digging aborted" on every block
// after the first. A pathfinder that never digs never sets that flag.
function configureMovements (bot, materials = [], { canDig = true } = {}) {
  const mcData = registry(bot)
  const movements = new Movements(bot, mcData)

  movements.allow1by1towers = true
  movements.canDig = canDig
  movements.allowParkour = false
  movements.maxDropDown = 4

  const scaffoldItem = mcData.itemsByName[SCAFFOLD_BLOCK]
  movements.scafoldingBlocks = scaffoldItem ? [scaffoldItem.id] : [] // sic: library spells it this way

  movements.blocksCantBreak = new Set(movements.blocksCantBreak)
  for (const name of new Set(materials)) {
    const block = mcData.blocksByName[name]
    if (block) movements.blocksCantBreak.add(block.id)
  }

  bot.pathfinder.setMovements(movements)
  return movements
}

// Accepts a block spec, with or without a state suffix: the state is the
// server's business, the id is what the registry knows about. An unparseable
// spec is not a known block - that check is also what keeps a hand-written
// material string from reaching a slash command intact.
function isKnownBlock (bot, spec) {
  if (!isValidSpec(spec)) return false
  return Boolean(registry(bot).blocksByName[baseName(spec)])
}

module.exports = { createBuilderBot, configureMovements, registry, isKnownBlock }
