# House style
Edit this file to change how the bot builds. It is read fresh on every `!make`,
so save the file and the next build obeys it - no restart, no code. Everything
below is sent to the planner as standing instructions that override its general
guidance. Delete anything you disagree with. 8000 character cap.

## Plan before placing
- Name ONE style for the whole build (Nordic longhouse, gothic keep, Japanese
  pagoda, desert riad, steampunk workshop...) and make every material and shape
  choice fit it. Mixed styles read as mistakes.
- Use odd footprints (7, 9, 11, 13, 15) so doors, windows, ridges and towers
  sit on a true centre block. Even sizes only for paired features.
- Massing first: compose 2 to 4 simple volumes (boxes, cylinders, wings) of
  different heights. One dominant mass; the others no taller than 2/3 of it.
  A single box is never the answer, even for a cottage - add a porch, chimney
  or wing.
- Lay a bay grid from the origin: a pillar/pilaster every 3 or 4 blocks along
  every wall. Windows, buttresses, roof dormers and doors snap to bays.
- Whatever is at +n from a wall's centre axis is mirrored at -n unless the
  plan deliberately breaks symmetry for one asymmetric feature (a tower, a
  side wing) - never for scattered details.

## Accuracy rules (do not skip)
- Build order: plinth -> floor slab -> corner pillars -> wall infill -> upper
  floor plates -> roof -> trim/eaves -> windows/doors -> interior -> landscaping.
  Details never go on before the shell is closed.
- Pitched roof: step in exactly 1 block per level (45 degrees) using stairs,
  gable ends filled solid up to the ridge in a contrasting block. Ridge runs
  along the long axis, centred on the odd width. Roof overhangs every wall by
  1 block. Roof height is at least half the wall height.
- Stairs: on roof slopes face down-slope; eaves are upside-down stairs facing
  outward; outside corners use two stairs meeting at the corner, never a gap.
- Storey height 4 (3 clear + 1 floor). Grand halls 6 or more.
- Nothing floats: every block touches the structure. No holes in walls except
  intended openings. Walls are 1 thick; load-bearing pillars may be 2x2.
- Windows never touch a corner or the roof line - leave at least 1 block of
  wall around them. Doors sit on a bay centre, 2 wide 3 tall, with a lintel.
- Before finalising, check: all walls close, roof covers the whole footprint,
  door is reachable from ground level, floors are continuous, no stairs face
  the wrong way.

## Materials and texture
- Every surface gets a palette of 3 to 5 blocks: base ~60%, secondary ~30%,
  accent ~10%. Vary the base by randomly swapping 10-15% of blocks for a
  weathered variant (cracked/mossy/cobbled). Random scatter, never a pattern.
- Stone: deepslate_bricks, stone_bricks, polished_andesite, polished_deepslate
  for trim; cobblestone and cobbled_deepslate only for plinths, rubble and
  weathering. Sandstone/terracotta families for warm-climate styles.
- Wood: spruce_planks, dark_oak_planks, stripped logs as pillars at every bay.
  oak_planks only as small accents. Timber framing = log pillars with plank
  or white/light terracotta infill.
- Roofs: deepslate_tiles, dark_oak stairs, blue_terracotta, dark_prismarine,
  copper (oxidised mix) or nether bricks - never the wall block.
- Windows: glass_pane in a 1-block frame of trim material, a sill of slabs or
  stairs below. Windows taller than 2 get a mullion (fence or log). Arched
  windows for gothic/church: 1 wide, 3-5 tall, stairs at the top.
- Lighting: lanterns on fences or chains, glowstone/sea_lantern hidden behind
  stairs or under carpet, campfires in chimneys. Torches only in rustic styles.
  Something glows from every facade at night.

## Depth and detail passes
- Any wall 6 or longer: pilasters or buttresses proud by 1 at each bay,
  stepping back with stairs near the top.
- Corners: quoins (alternating trim block) or a full corner pillar.
- Trim band (slabs or stairs) at every floor line and under every roof.
- Plinth 1 wider than the building, 1-2 tall, in the darkest block.
- Ground: a path to the door, 2-4 accents (lanterns, leaves, barrels, flower
  boxes on windowsills).
- Chimney on any residential build, 2 taller than the ridge, campfire inside.
- Interior: patterned floor, at least one furnished room, a real staircase to
  each upper floor, lighting that does not show from outside as torches.

## Scaling up (crazy builds)
- Match ambition to the request. "Castle" means curtain wall, gatehouse with
  a portcullis (fences), at least two towers of different heights and a keep.
  "Cathedral" means nave, transept, buttresses, rose window, spire. Never
  shrink a big word into one tower.
- Circles for towers and domes, filled row widths per diameter:
  d5 = 3,5,5,5,3   d7 = 3,5,7,7,7,5,3   d9 = 5,7,9,9,9,9,9,7,5
  d11 = 5,7,9,11,11,11,11,11,9,7,5. Hollow = keep only the outer ring.
- Dome: stack rings, dropping one diameter size every 1-2 levels, capped with
  a single block or spike. Onion dome: rings grow one size, then shrink fast.
- Roof forms: gable, hip (all four sides step in), cross-gable for wings,
  mansard (steep then shallow), pagoda (each tier 2 narrower, eaves flare out
  with upside-down stairs), conical for round towers (ring shrinks each level).
- Towers are 4-6 times their width in height, with a crenellated top (1-block
  merlons on alternating blocks) or a conical roof, and a trim band every
  5-6 levels.
- Bridges, arches and colonnades: arch spans are odd, built from stairs with a
  keystone block at the top.
- Fantasy only if anchored: floating pieces need visible chains, roots or
  crystals; glowing accents (froglight, shroomlight, amethyst) as the accent
  slot of the palette.
- If the plan has a block budget, spend it in this order: silhouette, then
  facade texture, then interior. A great outline with a plain interior beats
  the reverse.

## Never
- A flat slab roof, or a roof shorter than half the wall height.
- A wall with a single material and no banding, pilaster or texture.
- Checkerboard or striped block patterns.
- Glass as a wall material; unframed windows; windows touching a corner.
- A door that is not on a bay centre, or that opens onto nothing.
- A perfectly square single box, however small.
- Stairs or slabs that leave a visible gap at an outside corner.
