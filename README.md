# minecraft-build-agent-26.2

A building bot for a vanilla Minecraft **26.2** server. You type `!build /house1` in chat and it places the blueprint in front of you — houses, towers, a colosseum, iron and gold farms, a 1,700-hopper item sorter — over RCON, with no client or mod on the server side.

It exists because [mineflayer](https://github.com/PrismarineJS/mineflayer) cannot log in to 26.2 (there is no 26.2 protocol data), and every other approach needed a mod. RCON needs neither: everything the bot does is a slash command, and chat comes back through the server log.

## What you need

- Docker (the included `compose.yml` runs both the server and the bot)
- or an existing 26.2 server with `enable-rcon=true`, whose `logs/` and `world/` directories the bot can read

No API key is needed. `ANTHROPIC_API_KEY` is only read by the plain-English planner, which is not wired to the RCON path yet.

## Quick start

```sh
git clone https://github.com/PowerisTsutsun/minecraft-build-agent-26.2
cd minecraft-build-agent-26.2
cp .env.example .env                                 # set RCON_PASSWORD
cp rcon-servers.example.json rcon-servers.json
docker compose up -d
docker compose logs -f bot                           # wait for "rcon connected"
```

Join `localhost:25565`, look at the ground, and type:

```
!build list
!build /house1
```

**Already have a server?** Delete the `mc` service from `compose.yml`, point the bot's two read-only mounts at your server's `logs/` and `world/`, and make `rcon-servers.json` match. The server must have RCON enabled.

## Commands

| in chat | does |
|---|---|
| `!build list` | every blueprint, grouped, hover for size, click to fill in |
| `!build list houses` | one group |
| `!build /house1` | place it where you are looking (the aimed block becomes the min corner) |
| `!build /house1 at 100 70 -50` | place at exact coordinates |
| `!build /house1 dry` | report what would happen, place nothing |
| `!build /house1 noclear` | skip emptying the volume first (see below) |
| `!remove` | remove the build you are standing in |
| `!undo` | remove the last build |
| **L key** | the whole catalogue as an advancement tree, with icons — see *Datapack* |

Before placing, the bot **clears the volume** the build will occupy. Blueprints carry no air, so without this a house placed against a hill keeps the hill inside it, and a house placed in water arrives full of water. The clear is bounded to the build's own footprint and base. If the site is underwater it will warn you: the water flows back through any door or window, and that is Minecraft, not the bot.

## Blueprints

Drop `.schem` (Sponge v2 **or v3**), `.schematic` (MCEdit) or `.litematic` files into `schematics/`, then:

```sh
npm run catalog        # rebuilds schematics/catalog.json and names anything new in aliases.json
```

`catalog.json` records dimensions, block count, dominant materials and a `kind` (house, tower, statue, farm, sorter, redstone, terrain). `aliases.json` maps friendly names to files — edit it freely, it is re-read on every command. Terrain captures and anything over `MC_MAX_BLOCKS` get no name.

### Datapack

`node tools/make-advancements.js` renders the catalogue as an advancement tree; copy `.datapack/blueprints` into your world's `datapacks/` and `/reload`. Every blueprint appears on the **L** screen under its group with its dominant block as the icon.

## Machines: farms and sorters

A downloaded machine is blocks only. Schematics do not carry what is *inside* the blocks — villagers, the zombie in its boat, the 41 items that make a filter hopper a filter — and prismarine-schematic drops even the block-entity data that some files do have. Placed raw, every machine arrives dead, silently.

**Farms** live in `templates/<name>/` as a `.schem` plus a `setup.txt` of `/summon` and `/data merge block` commands that the bot runs after placing. Three ship: `ironfarm1`, `ironfarm2` (with auto-crafter), `goldfarm`. `tools/extract-setup.js --what <file>` writes a `setup.txt` from a schematic's own block entities where it has them.

**Sorters** are handled by two tools that share one walk of the hopper network, so a filter's charge and the frame under its chests can never disagree:

```sh
node tools/load-sorter.js  --what 17071.schem --at 610 59 12 --apply   # 41 target + 4 sticks in every real filter, in flow order
node tools/label-sorter.js --what 17071.schem --at 610 59 12 --apply   # a glow item frame under each chest pair
node tools/load-sorter.js  ... --map                                   # print slot -> item
node tools/load-sorter.js  ... --items my-list.txt                     # your own ordering, one id per line
```

Items land in the **bottom** chest of each pair. The bot warns at build time when it places a machine with unloaded filters.

## Configuration

`rcon-servers.json` — one entry per server; `password` may be `${RCON_PASSWORD}` so the secret stays in `.env`. The `log` path is the one *inside the bot container*.

| env | default | |
|---|---|---|
| `MC_SERVER` | `mc-test` | which `rcon-servers.json` entry `npm start` drives |
| `MC_MAX_BLOCKS` | `150000` | refuse larger builds (`compose.yml` sets 500000) |
| `MC_DATA_VERSION` | `26.1` | minecraft-data registry used to read files — see `src/version.js` for why this is not the server version |
| `MC_SCHEMATIC_DIR` | `./schematics` | |

## Tests

```sh
npm test      # 15 files, no server or API key needed
```

## Layout

```
tools/rcon-bot.js        the bot: tails the log, answers in chat, places builds
src/rcon/                rcon client, fill batching, clear pass, anvil region reader, journal
src/building/            schematic loading (v2/v3/litematic), block specs, fill phases, templates
tools/                   catalog, naming, advancements, extract-setup, load/label-sorter, rcon-export
schematics/              blueprints + catalog.json + aliases.json
templates/               farms with their setup.txt
docs/                    dev notes and findings
```

## Known limitations

- **Placement is not yet collision-aware.** Two builds aimed at the same spot will interpenetrate. Ground is taken from the single block you aim at, so a big build on a slope is half buried. Both are the next piece of work.
- **The plain-English planner (`!make`) is not reachable** from the RCON bot yet. It lives in `src/commands/` and `src/pipeline/`, wired to a mineflayer path that no longer has a server.
- **Schematics from older game versions decode ~1–4% of their palette to a neighbouring block** (e.g. `cherry_leaves` → `dark_oak_leaves`). Cause and fix are in `docs/schematic-palette-drift.md`.
- `index.js` and the mineflayer-based tools (`tools/diff-region.js`, `place-*.js`, `say*.js`, `export-farm.js`) target a 26.1 server and are kept for reference only.
