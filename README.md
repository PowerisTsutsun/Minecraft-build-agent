# minecraft-build-agent-26.2

A blueprint bot for a vanilla Minecraft **26.2** server. Drop a `.schem`, `.schematic` or `.litematic` file into `schematics/`, type `!build <name>` in chat, and it appears where you are looking — no client mod, no server mod, no plugin.

Thirty-nine named blueprints ship with it: sixteen houses, three towers, a colosseum, a taj mahal, statues, iron and gold farms, and a 1,700-hopper item sorter that arrives with its filters loaded.

It works over RCON, which means it needs no protocol support for the server's version at all: everything the bot does is a slash command, and chat comes back by tailing the server log.

## What you need

- Docker (the included `compose.yml` runs both the server and the bot)
- or an existing 26.2 server with `enable-rcon=true`, whose `logs/` and `world/` directories the bot can read

No API key, no account, no network access beyond the server itself.

## Quick start

```sh
git clone https://github.com/PowerisTsutsun/minecraft-build-agent-26.2
cd minecraft-build-agent-26.2
./setup.sh YourMinecraftName
```

That is the whole install. It writes `.env` with a generated RCON password, starts the server and the bot, and waits until the bot reports `rcon connected` (first run generates a world, which takes a few minutes on a Pi). Run it without an argument and it asks for the name.

Your Minecraft name is the only thing it needs, and it is not cosmetic: RCON is console-level, so the bot only answers names on its allow list. Nobody else can build, and with no name set it refuses everyone rather than handing the console to anyone who can type in chat.

Then join `localhost:25565`, look at the ground, and type:

```
!build list
!build house1
```

Re-running `setup.sh` is safe — it only fills in what is missing and never rewrites a password you already have.

**Already have a server?** Delete the `mc` service from `compose.yml`, point the bot's two read-only mounts at your server's `logs/` and `world/`, and set `MC_SERVER` to a matching entry. The server needs `enable-rcon=true`. For more than one server, or for paths that differ from the compose layout, copy `rcon-servers.example.json` to `rcon-servers.json` and edit it — the bot reads that in preference to the example.

## Commands

| in chat | does |
|---|---|
| `!build list` | every named blueprint, grouped, hover for size, click to fill in |
| `!build list houses` | one group |
| `!build house1` | place it where you are looking (the aimed block becomes the min corner) |
| `!build myhouse` | anything you dropped into `schematics/`, by its filename |
| `!build house1 at 100 70 -50` | place at exact coordinates |
| `!build house1 dry` | report what would happen, place nothing |
| `!build house1 noclear` | skip emptying the volume first (see below) |
| `!remove` | remove the build you are standing in |
| `!undo` | remove the last build |
| **L key** | the whole catalogue as an advancement tree, with icons — see *Datapack* |

Before placing, the bot **clears the volume** the build will occupy. Blueprints carry no air, so without this a house placed against a hill keeps the hill inside it, and a house placed in water arrives full of water. The clear is bounded to the build's own footprint and base. If the site is underwater it will warn you: the water flows back through any door or window, and that is Minecraft, not the bot.

## Your own blueprints

Copy `.schem` (Sponge v2 **or v3**), `.schematic` (MCEdit) or `.litematic` files into `schematics/`. That is the whole install step — `mybarn.schem` is buildable as `!build mybarn` immediately, with no restart and nothing to edit. Names are case-insensitive and the leading `/` is optional.

**Naming happens by itself.** When the bot starts and finds `schematics/` newer than the catalogue, it rebuilds in the background and announces the new names in chat — `2 new blueprints named: /house18 /tower4`. Nothing to run, and the bot stays usable while it works, because the files already build by filename. Set `MC_NO_AUTOCATALOG=1` to turn that off, or do it yourself at any time:

```sh
docker compose exec bot npm run catalog
```

`catalog.json` records dimensions, block count, dominant materials and a `kind` (house, tower, statue, farm, sorter, redstone, terrain). `aliases.json` maps friendly names to files — edit it freely, it is re-read on every command, and a name in it always wins over a filename, so renaming a file cannot silently change what an existing name builds. An alias you chose is never renamed or renumbered by the automatic pass. Terrain captures, unreadable files, and anything over `MC_MAX_BLOCKS` get no name, and neither do the raw captures behind templates — those carry no `setup.txt`, so building one gets you a machine that looks right and can never produce.

### Datapack

`docker compose exec bot node tools/make-advancements.js` renders the catalogue as an advancement tree; copy `.datapack/blueprints` into your world's `datapacks/` and `/reload`. Every blueprint appears on the **L** screen under its group with its dominant block as the icon.

## Machines: farms and sorters

A downloaded machine is blocks only. Schematics do not carry what is *inside* the blocks — villagers, the zombie in its boat, the 41 items that make a filter hopper a filter — and prismarine-schematic drops even the block-entity data that some files do have. Placed raw, every machine arrives dead, silently.

**Farms** live in `templates/<name>/` as a `.schem` plus a `setup.txt` of `/summon` and `/data merge block` commands that the bot runs after placing. Three ship: `ironfarm1`, `ironfarm2` (with auto-crafter), `goldfarm`. `docker compose exec bot node tools/extract-setup.js --what <file>` writes a `setup.txt` from a schematic's own block entities where it has them.

**Sorters** are handled by two tools that share one walk of the hopper network, so a filter's charge and the frame under its chests can never disagree:

```sh
docker compose exec bot node tools/load-sorter.js  --what 17071.schem --at 610 59 12 --apply   # 41 target + 4 sticks in every real filter, in flow order
docker compose exec bot node tools/label-sorter.js --what 17071.schem --at 610 59 12 --apply   # a glow item frame under each chest pair
docker compose exec bot node tools/load-sorter.js  ... --map                                   # print slot -> item
docker compose exec bot node tools/load-sorter.js  ... --items my-list.txt                     # your own ordering, one id per line
```

(Drop the `docker compose exec bot` prefix if you have node on the host and are running the bot outside Docker.)

Items land in the **bottom** chest of each pair. The bot warns at build time when it places a machine with unloaded filters.

## Configuration

Everything lives in `.env`, which `setup.sh` writes:

| env | | |
|---|---|---|
| `BUILDER` | — | **who may build.** RCON is console-level, so only these names are obeyed. Unset means the bot refuses everyone |
| `RCON_PASSWORD` | — | shared by the server and the bot; `setup.sh` generates one |
| `ONLINE_MODE` | `true` | `false` lets offline/cracked clients join |
| `MC_SERVER` | `mc` under compose, else `mc-test` | which server entry to drive |
| `MC_MAX_BLOCKS` | `150000` | refuse larger builds (`compose.yml` sets 500000) |
| `MC_NO_AUTOCATALOG` | unset | `1` stops the bot rebuilding the catalogue by itself |
| `MC_DATA_VERSION` | `26.1` | minecraft-data registry used to read files — see `src/version.js` for why this is not the server version |
| `MC_SCHEMATIC_DIR` | `./schematics` | |

**`rcon-servers.json` is optional.** The committed `rcon-servers.example.json` is a working config, not a template to fill in: `${RCON_PASSWORD}` and `${BUILDER}` in it are resolved from the environment, so a fresh clone runs with nothing copied and nothing hand-edited. Copy it to `rcon-servers.json` only when you want a second server or different paths — the bot prefers that file when it exists. `log` and the world directory are paths *inside the bot container*; see `compose.yml`.

An unresolved `${BUILDER}` is dropped from the allow list rather than taken as a literal name, so a missing setting can only ever lock you out — never let someone in.

## Tests

```sh
docker compose exec bot npm test     # 6 files, 117 checks, no server needed
```

## Layout

```
setup.sh                 one command from a fresh clone to a bot waiting for !build
tools/rcon-bot.js        the bot: tails the log, answers in chat, places builds
src/rcon/                rcon client, server config, fill batching, clear pass, region reader, journal
src/building/            schematic loading (v2/v3/litematic), name resolution, catalogue upkeep,
                         block specs, fill phases, templates
tools/                   catalog, naming, advancements, extract-setup, load/label-sorter, rcon-export
schematics/              blueprints + catalog.json + aliases.json
templates/               farms with their setup.txt
docs/                    dev notes and findings
```

## Known limitations

- **Placement is not yet collision-aware.** Two builds aimed at the same spot will interpenetrate. Ground is taken from the single block you aim at, so a big build on a slope is half buried. Both are the next piece of work.
- **Schematics from older game versions decode ~1–4% of their palette to a neighbouring block** (e.g. `cherry_leaves` → `dark_oak_leaves`). Cause and fix are in `docs/schematic-palette-drift.md`.
- **A blueprint is placed exactly as it was captured.** If a machine was copied mid-cycle its moving parts settle into their rest state once the world ticks again, and those cells will not match the file. Verification counts them separately rather than calling them failures.
