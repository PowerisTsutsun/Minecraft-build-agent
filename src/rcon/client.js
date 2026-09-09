'use strict'

const net = require('net')

// ---------------------------------------------------------------------------
// Minimal RCON client.
//
// Why this exists at all: mineflayer cannot speak to the 26.2 main server -
// minecraft-data ships no 26.2 protocol, so there is no bot to log in. But
// every single thing that actually built anything today was a slash command,
// and RCON runs those at console level with no protocol version involved. So
// the whole builder can drive a 26.2 server through this socket instead, with
// no player entity in the world at all.
//
// Protocol: little-endian [int32 length][int32 id][int32 type][body NUL][NUL].
// type 3 = auth, 2 = command, 0 = response. An auth failure comes back with
// id -1. Responses over 4096 bytes arrive split across packets; commands here
// are small, but the reader below reassembles by id anyway rather than
// assuming one packet per reply.
// ---------------------------------------------------------------------------

const TYPE_AUTH = 3
const FRAGMENT = 4096   // vanilla's per-packet response payload cap
const MAX_PACKET = 4 * 1024 * 1024   // sanity bound on a length read off the wire
const TYPE_COMMAND = 2

class Rcon {
  constructor ({ host = '127.0.0.1', port = 25575, password, timeout = 15000 }) {
    this.host = host
    this.port = port
    // rcon-servers.json may say "${RCON_PASSWORD}" so the secret stays in .env.
    const env = /^\$\{(\w+)\}$/.exec(password || '')
    if (env && !process.env[env[1]]) {
      throw new Error(`rcon-servers.json wants ${password} but ${env[1]} is not set in the environment`)
    }
    this.password = env ? process.env[env[1]] : password
    this.timeout = timeout
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
  }

  connect () {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, this.host)
      this.socket.setNoDelay(true)
      this.socket.once('error', reject)
      this.socket.on('data', chunk => this._onData(chunk))
      this.socket.on('close', () => {
        // clearTimeout too, or up to `timeout` ms of dangling timers keep the
        // event loop alive after the socket is gone.
        for (const { reject: rj, timer } of this.pending.values()) {
          clearTimeout(timer)
          rj(new Error('rcon connection closed'))
        }
        this.pending.clear()
      })
      this.socket.once('connect', async () => {
        this.socket.removeListener('error', reject)
        this.socket.on('error', err => console.error('[rcon]', err.message))
        try {
          await this._send(TYPE_AUTH, this.password)
          resolve(this)
        } catch (err) {
          reject(err)
        }
      })
    })
  }

  _onData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0)
      // len is a SIGNED int32 straight off the wire. At len <= -4 the `break`
      // below is false and subarray(len + 4) consumes nothing, so the loop
      // spins on the same bytes at 100% CPU and the process never recovers.
      // Anything outside the protocol's own bounds means the stream is not
      // RCON any more - drop the socket rather than try to resynchronise.
      if (len < 10 || len > MAX_PACKET) {
        this.socket.destroy(new Error(`rcon: bogus packet length ${len}`))
        return
      }
      if (this.buffer.length < len + 4) break
      const id = this.buffer.readInt32LE(4)
      // Keep the raw bytes: decoding per-fragment mangles any multi-byte
      // sequence that straddles a packet boundary into U+FFFD.
      const payload = this.buffer.subarray(12, len + 2)
      this.buffer = this.buffer.subarray(len + 4)

      // Auth failure is reported as id -1 against the request we just made.
      if (id === -1) {
        // Settle EVERY waiter, not just the first - clearing the map while
        // rejecting one left the rest pending until their timers fired.
        const err = new Error('rcon auth failed - wrong password')
        for (const { reject: rj, timer } of this.pending.values()) { clearTimeout(timer); rj(err) }
        this.pending.clear()
        this.socket.destroy()
        return
      }
      const entry = this.pending.get(id)
      if (!entry) continue
      // Vanilla splits any reply longer than 4096 BYTES into several packets
      // that all carry the SAME request id. Resolving on the first one hands
      // back a truncated string with no error - a 1206-chest `data get`, a
      // villager's Brain, `help` - so a full-size fragment is held and the
      // pieces joined until a short (final) one arrives.
      //
      // The comparison must be on bytes, not on decoded length: a full 4096-byte
      // fragment holding any multi-byte UTF-8 decodes to FEWER than 4096 chars,
      // which read as "final" and silently truncated the reply this code exists
      // to reassemble.
      entry.parts = entry.parts || []
      entry.parts.push(payload)
      if (payload.length >= FRAGMENT) continue
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve(Buffer.concat(entry.parts).toString('utf8'))
    }
  }

  _send (type, body) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const payload = Buffer.from(body, 'utf8')
      const packet = Buffer.alloc(payload.length + 14)
      packet.writeInt32LE(payload.length + 10, 0)
      packet.writeInt32LE(id, 4)
      packet.writeInt32LE(type, 8)
      payload.copy(packet, 12)
      packet.writeInt16LE(0, payload.length + 12)

      // The AUTH packet's body IS the password. Echoing it into a timeout
      // message put it in console.error -> docker logs -> the json-file log on
      // disk, where anyone reading logs finds a console-level credential.
      const shown = type === TYPE_AUTH ? '<auth>' : body.slice(0, 60)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rcon timeout after ${this.timeout}ms: ${shown}`))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(packet)
    })
  }

  // One command, one reply. Leading slash is optional and stripped - the
  // console does not want it.
  async send (command) {
    return this._send(TYPE_COMMAND, command.startsWith('/') ? command.slice(1) : command)
  }

  close () {
    if (this.socket) this.socket.end()
  }
}

async function connect (opts) {
  return new Rcon(opts).connect()
}

module.exports = { Rcon, connect }
