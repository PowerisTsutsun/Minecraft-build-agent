# `stairs` op: straight flights that look built

Derived from three reference builds: a wide garden stair with log-and-leaf
flanks, a stone-brick flight with stepped side walls, and a great-hall stair
running along a wall. All three follow the same recipe.

## The recipe

1. Treads are `*_stairs` facing the direction of ascent, `width` wide.
2. Everything under a tread is solid, down to the floor. Stairs never float.
3. A stringer runs up each open side: a 1-thick wall of a contrasting block
   that steps with the flight, always one block ABOVE the tread beside it.
4. Posts at the bottom and top of each stringer are 1-2 blocks taller than
   the stringer, and that is where the lights go.
5. Long flights break at landings every 6-8 steps, optionally turning 90 deg.
6. The bottom step may flare wider by 1 each side for a grand entrance.

## Schema

```json
{ "op": "stairs",
  "offset": {"x": 0, "y": 0, "z": 0},       // bottom tread, left-front corner
  "axis": "x", "ascent": "+",                // climbs toward +x
  "width": 3, "rise": 9,                     // 9 steps = 9 blocks up
  "tread": "dark_oak_stairs",                // any *_stairs; else <mat>_stairs looked up
  "fill": "dark_oak_planks",                 // solid mass under treads (default: tread's base)
  "stringer": "stone_bricks",                // null = no side walls
  "sides": "both",                           // both | left | right | none
  "post_height": 3,                          // 0 = none
  "lights": "torch",                         // torch | lantern | none
  "light_every": 4,
  "landing_every": 0,                        // N = flat landing after every N steps
  "turn": "none",                            // none | left | right, at each landing
  "flare": 0,                                // widen first N steps by 1 each side
  "stringer_pattern": null                   // e.g. ["oak_log[axis=y]","oak_leaves"]
}
```

Only `op`, `offset`, `axis`, `ascent`, `width`, `rise`, `tread` are required.

## Implementation notes (as built)

- Landings sit FLUSH with the tread they follow, not one above it. A tread is a
  stair whose walkable top is one above its own level, so a landing at the same
  level meets it exactly. Putting the landing one higher would add a block of
  climb per landing and break the promise that `rise` is exactly the
  floor-to-floor difference. Tested for turn none/left/right.
- `flare` is literal: the first N steps are one wider each side.
- Leaves in `stringer_pattern` get `[persistent=true]` automatically.
- A `*_stairs` stringer is oriented as a sloped handrail.
- The op is a PRECISE op: it may be placed into carved space.
- Validation rejects rise < 2, flare > 2, turn without landing_every, and
  unknown fill/stringer/pattern blocks. Warns on rise > 8 with no landing.
