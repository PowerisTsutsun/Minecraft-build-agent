# Schematic palette drift (open)

Found 2026-09-07 while adding Sponge v3 support. **Pre-existing; affects every
Sponge schematic we load, v2 and v3 alike.** Not caused by the v3 shim.

## Symptom

A small percentage of each file's palette decodes to the *wrong block*. Not an
error, not a warning - a plausible, wrong block, placed silently.

Measured with `Block.fromStateId(schematic.palette[id]).name` against the name
the file's own palette string declares:

| file | version | DataVersion | palette | misresolved |
|---|---|---|---|---|
| `31502.schem` | v2 | 3105 | 71  | 3 (4.2%) |
| `22575.schem` | v3 | 3953 | 213 | 5 (2.3%) |
| `30808.schem` | v2 | 4790 | 551 | 10 (1.8%) |
| `house7.schem` | v2 | 4786 | 141 | 1 (0.7%) |

Concrete examples from `22575.schem`:

```
file="minecraft:azalea_leaves[distance=7,persistent=true,waterlogged=false]"
  -> decoded="flowering_azalea_leaves"
file="minecraft:cherry_leaves[...]"            -> decoded="dark_oak_leaves"
file="minecraft:pink_petals[facing=east,flower_amount=4]" -> decoded="wildflowers"
file="minecraft:flowering_azalea_leaves[...]"  -> decoded="wet_sponge"
file="minecraft:chain[axis=y,waterlogged=false]" -> decoded="air"   (with a warning)
```

## Root cause

`prismarine-schematic`'s `parsePalette` resolves each palette string through
`getStateId(mcData, name, properties)` against **whichever registry version the
caller passed** - we always pass `cfg.readVersion`, i.e. `'26.1'`. The file was
written against its own `DataVersion`. Where a block's property set or the
registry's block ordering moved between those two versions, the computed state
id overflows into the **next block in registry order**. Hence the tell: every
wrong answer is a registry neighbour of the right one.

`chain` is a different failure in the same family - genuinely absent from the
26.1 registry, so it degrades to air, but at least it says so.

## Why it matters

Every downloaded build placed so far has some fraction of wrong blocks in it,
and nothing reports them. `catalog.js`'s `unknown` field only catches names the
registry does not have at all (`chain`), not names it resolves to the wrong
thing. It is invisible to `verifySample` too, which compares against the same
mis-decoded list it built the world from.

## The fix, when we get to it

Stop round-tripping through state ids. The palette strings in the file are
already exactly the form the RCON path sends to the server (`name[a=b,c=d]`),
and the server does its own validation - so decode palette index -> file's own
palette string directly and skip `getStateId` entirely. That makes the loader
version-independent, which is the whole point of the RCON path.

Two things to check first: `.litematic` goes through `src/building/litematic.js`
and may or may not share the flaw, and `blockspec.specOf` currently sorts
property keys, so the direct path needs the same normalisation to keep
`verifySample` comparisons stable.
