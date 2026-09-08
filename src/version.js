'use strict'

// The two knobs that were scattered as literals through every tool.
//
// DATA_VERSION is the minecraft-data registry used to READ schematics and name
// blocks. It is deliberately not the server version: minecraft-data ships no
// 26.2 package, and the RCON path never speaks the protocol - it sends block
// names as text and the server validates them - so the newest registry that
// exists (26.1) reads 26.2 worlds fine. Change it when a newer one ships.
//
// SERVER is the default entry in rcon-servers.json when no --server is given.
const DATA_VERSION = process.env.MC_DATA_VERSION || '26.1'
const SERVER = process.env.MC_SERVER || 'mc-test'

module.exports = { DATA_VERSION, SERVER }
