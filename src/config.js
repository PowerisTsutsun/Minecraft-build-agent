'use strict'

// ---------------------------------------------------------------------------
// Central config. Env vars win, so compose.yml stays the source of truth and
// this file just supplies sane fallbacks.
//
// This was much larger when a bot logged in and walked to every block: a host,
// port, username and protocol version to connect with, a scaffold block to
// pillar up on, an action timeout for calls that hung, size and action caps on
// a generated plan, a settle delay and a resume radius for a bot that could
// wander off. None of it survived the move to RCON, where there is no player
// entity, no inventory and no plan - only a file and a corner to put it at.
// What is left is the one number every path reads.
// ---------------------------------------------------------------------------

// This cap was sized for a bot that walked to every block, where 4000 blocks
// was roughly twelve hours of placing. Filling does 292 blocks in 0.6s, so the
// limit that matters now is how much of someone's world a single typo should be
// able to redecorate. compose.yml raises it to 500000; downloaded builds run to
// about 370k.
const MAX_BLOCKS = parseInt(process.env.MC_MAX_BLOCKS || '150000', 10)

module.exports = { MAX_BLOCKS }
