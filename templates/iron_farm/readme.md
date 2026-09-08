# iron_farm

Captured 2026-09-06 from the farm at 1804 -62 993 on the sandbox (23 ingots in its chest).

An iron farm is three villagers, a zombie they can see but not reach, three beds
and three workstations, arranged so golems spawn on a platform and are swept into
a killing chamber. Every part of that is position-sensitive and version-sensitive,
and none of it is something a language model should be inventing: it will produce
something farm-shaped that makes no iron and report success.

So this template is filled in from a design that demonstrably works, not written
from description.

## How to fill it in

1. Build a proven 26.1 iron farm by hand on the sandbox (port 25566), or paste
   one in from a schematic you trust.
2. Run it. Confirm iron actually reaches the chest — that is the only test that
   counts.
3. Stand at one bottom corner of the whole thing and type `!export iron_farm`.
4. Walk to the opposite top corner and type `!export iron_farm` again.

That captures the blocks. It does **not** capture the villagers or the zombie —
entities are not blocks and are not in a `.schem`.

5. Add the `/summon` lines to `setup.txt`, using `~x ~y ~z` offsets from the
   template's origin corner. The examples in that file are the right shape.

After that, `!make an iron farm` places the blocks, runs the setup, and wraps the
whole thing in a decorated shell with the protected region left untouched.

## Why the protect region matters

`meta.json` carries a `protect` box that the decorator and the planner may not
write into. Without it a cornice goes through a hopper line and the farm quietly
stops working — which looks exactly like a farm that was never built right.

- source:
- tested on:
- notes:

## Why the ground gets shovelled

Golems spawn anywhere within 8 blocks of the village centre, on any full block
with air above it, so plain grass beside the walls grows golems outside the
chamber. The by-hand fix is right-clicking the grass with a shovel: dirt path is
a fifteen-sixteenths block and nothing spawns on it. The `surface` box in
`meta.json` (`margin` 8, `block` dirt_path) does that to every column within 8
blocks of the footprint after placement. The `.schem` cannot carry this - the
original was captured with plain grass outside it.

## Why `ground` is 1

The template was re-captured on 2026-09-06 from the floor layer up, so layer 0
is the dirt-path floor with the grass around it - the layer that stands in for
the natural grass. `ground: 1` sinks the template one block at placement so that
layer replaces the grass and the farm comes out flush with the terrain. The
first capture (kept as `iron_farm.schem.2026-09-06-ground2.bak`) also had a full
layer of dirt underneath and needed `ground: 2`.
