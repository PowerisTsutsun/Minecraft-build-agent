# iron_farm

**No `.schem` yet — this template is a scaffold, not a working farm.**

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
