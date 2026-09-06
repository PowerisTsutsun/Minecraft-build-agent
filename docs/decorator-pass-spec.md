# Decorator pass: builder habits as code

Runs after shell and carves, before the model's own `details`. Reads the cell
map, finds surfaces, applies a style's habits everywhere they fit. The model
chooses `decor.style` and `decor.intensity`; the code does the rest.

## Plan fields

```json
"decor": { "style": "medieval_stone", "intensity": 0.7, "gradient": true,
           "greenery": true, "banners": "red", "skip": ["vines"] }
```

## Step 1: surface detection (pure geometry over the cell map)

exteriorFaces (with normals), corners, topEdges (rings and runs), roofSlopes
and eaves lines, openings (air regions bounded by solid), floorLines,
overhangs, verticalRuns (blank wall >= 8 tall).

## Step 2: habits

Universal: corbel_edges, string_courses, quoins/ribs, window_frames,
arrow_slits, lights_under_overhangs, material_gradient, weathering.

medieval_stone: crown (machicolations), wall_walk, cone_roofs with log eaves
ring, gable_dormers, vines, banners.

timber_castle: timber_upper, jetties, flower_boxes, balconies, belfry_tops,
chimney.

fantasy_spire: spire_tiers, glow, wall_gradient.

## Implementation notes (as built, step 1 only)

- OUTSIDE IS A CONNECTED REGION, not a sightline to the sky. A one-block roof
  overhang breaks the sightline test completely: every facade reads as interior
  and no window is ever found. Outside is a flood fill from beyond the bounding
  box, with a column-top fallback above 4M cells.
- corbel_edges fires only on the LOWEST course of a slope. A sloped roof is a
  column top at every course; without this a gable gets a cornice on all eight
  of its steps (measured: 524 corbels on a two-building plan, a fifth of the
  structure). Skip if a neighbouring column tops out exactly one block lower -
  a drop of one is a slope, a drop of five is a lower wing.
- Openings are size-bounded (<= 8 span, <= 3 thick, <= 48 cells) or a room
  interior comes back as one very tall "window".
- Habits write through the same protection as everything else, so a frame that
  tried to close its own window is dropped and reported.

## Order of implementation

1. Surface detection + corbel_edges + string_courses + window_frames.  [DONE]
2. crown, wall_walk, material_gradient, weathering, lights.
3. timber_upper, flower_boxes, vines, banners, chimney.
4. spire_tiers, glow, belfries, balconies.
5. The render + bespoke details call.
