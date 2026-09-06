'use strict'

// ---------------------------------------------------------------------------
// Central config. Env vars win, so compose.yml stays the source of truth for
// host/port/version and this file just supplies sane fallbacks.
// ---------------------------------------------------------------------------

// The main server on 25565 runs 26.2 (protocol 776), which mineflayer does not
// support - 26.1 / protocol 775 is its newest, and minecraft-data ships no
// data/pc/26.2 as of 3.116.0. So the bot targets the 26.1 sandbox on 25566
// instead (see compose.yml's mc-sandbox service). Once `npm update
// minecraft-data mineflayer` adds 26.2, switch both this and the port back.
const CONNECTION = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25566', 10),
  username: process.env.MC_USERNAME || 'BuilderBot',
  version: process.env.MC_VERSION || '26.1' // must match the server exactly
  // auth: 'microsoft'  // uncomment only if the server has online-mode=true
}

// Cheap, distinct block the bot pillars up with to reach the roof. Kept
// different from the build materials so pathfinder is allowed to mine its own
// scaffolding back down without ever touching the structure.
const SCAFFOLD_BLOCK = process.env.MC_SCAFFOLD || 'dirt'

// mineflayer's network-facing calls have been observed to hang forever on
// server versions newer than the library was tested against - see placer.js.
const ACTION_TIMEOUT_MS = parseInt(process.env.MC_ACTION_TIMEOUT || '15000', 10)

// Guard against `!build box 999 999 999`.
const MAX_SIZE = parseInt(process.env.MC_MAX_SIZE || '96', 10)
const MIN_SIZE = 1

// This cap was sized for a bot that walked to every block, where 4000 blocks
// was roughly twelve hours of placing. Command mode does 292 blocks in 0.6s,
// so the limit that matters now is the undo log (one JSON entry per block) and
// how much of someone's world a single typo should be able to redecorate.
const MAX_BLOCKS = parseInt(process.env.MC_MAX_BLOCKS || '150000', 10)

const DEFAULTS = { width: 7, depth: 6, height: 4, material: 'oak_planks' }

// Most actions one plan may contain. 40 was fine for a cottage and far too few
// for a castle: four corner towers with roofs and battlements, curtain walls, a
// gatehouse and a keep is past 40 before any carving or ornament. The real
// ceiling on a build is MAX_BLOCKS, not the number of shapes used to describe
// it - a plan with more, smaller actions is usually the better-detailed one.
const MAX_ACTIONS = parseInt(process.env.MC_MAX_ACTIONS || '250', 10)

// How the bot places blocks:
//   'auto'     - use /fill if the bot is op, walk and place if it isn't
//   'command'  - /fill only; report failure rather than falling back
//   'survival' - always walk and place, op or not
// 'auto' is the useful default: the fallback costs one wasted fill command to
// discover, and the walking placer stays exercised on a bot with no op.
const BUILD_MODE = process.env.MC_BUILD_MODE || 'auto'

// Ticks to wait after a slash command before reading the world back. Commands
// are applied server-side and the resulting block updates take a moment to
// reach us; reading too early reports a fill as failed when it landed fine.
const CMD_SETTLE_TICKS = parseInt(process.env.MC_CMD_SETTLE_TICKS || '6', 10)

// A saved origin further than this from the player who asked is treated as
// stale rather than resumed - see commander.nearEnough().
const RESUME_RADIUS = parseInt(process.env.MC_RESUME_RADIUS || '64', 10)

module.exports = {
  CONNECTION,
  SCAFFOLD_BLOCK,
  ACTION_TIMEOUT_MS,
  MAX_SIZE,
  MIN_SIZE,
  MAX_BLOCKS,
  MAX_ACTIONS,
  DEFAULTS,
  BUILD_MODE,
  CMD_SETTLE_TICKS,
  RESUME_RADIUS
}
