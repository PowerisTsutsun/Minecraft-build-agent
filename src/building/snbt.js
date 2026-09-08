'use strict'

// prismarine-nbt tree -> SNBT, the text form slash commands take.
//
// nbt.simplify() is no use here: it throws the types away, and SNBT needs them.
// `{count:1}` and `{count:1b}` are different values to the server, and a byte
// written as a plain int is silently the wrong tag - the command succeeds and
// the container comes out empty. So this walks the typed tree instead.
//
// Longs are the trap: prismarine-nbt hands them over as a [high, low] pair of
// signed 32-bit ints, which has to be reassembled rather than concatenated.

function longToString (v) {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v) && v.length === 2) {
    const [hi, lo] = v
    return ((BigInt(hi | 0) << 32n) | (BigInt(lo >>> 0) & 0xffffffffn)).toString()
  }
  return String(v)
}

// Unquoted keys are legal only for [A-Za-z0-9_.+-]; anything else needs quotes.
const BARE_KEY = /^[A-Za-z0-9_.+-]+$/
const key = k => (BARE_KEY.test(k) ? k : JSON.stringify(k))

function snbt (node) {
  if (node === null || node === undefined) return ''
  const { type, value } = node
  switch (type) {
    case 'byte': return `${value}b`
    case 'short': return `${value}s`
    case 'int': return `${value}`
    case 'long': return `${longToString(value)}L`
    case 'float': return `${value}f`
    case 'double': return `${value}d`
    case 'string': return JSON.stringify(value)
    case 'byteArray': return `[B;${Array.from(value).map(v => `${v}b`).join(',')}]`
    case 'intArray': return `[I;${Array.from(value).join(',')}]`
    case 'longArray': return `[L;${Array.from(value).map(v => `${longToString(v)}L`).join(',')}]`
    case 'list': {
      const inner = value && value.value ? value.value : []
      const t = value && value.type
      return `[${inner.map(v => snbt({ type: t, value: v })).join(',')}]`
    }
    case 'compound': {
      const entries = Object.entries(value || {})
        .map(([k, v]) => `${key(k)}:${snbt(v)}`)
        .filter(s => !s.endsWith(':'))
      return `{${entries.join(',')}}`
    }
    default: return ''
  }
}

// A compound minus some keys - block entities carry their own id and position,
// which must not go inside the data payload.
function compoundWithout (node, drop = []) {
  if (!node || node.type !== 'compound') return null
  const value = {}
  for (const [k, v] of Object.entries(node.value || {})) {
    if (!drop.includes(k)) value[k] = v
  }
  return { type: 'compound', value }
}

module.exports = { snbt, compoundWithout, longToString }
