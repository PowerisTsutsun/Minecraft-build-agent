I want to build my own custom Minecraft building agent using Mineflayer, similar to Mindcraft but built from scratch, for my self-hosted server.

Context:
- I run my own Minecraft Java server in Docker on my homelab (currently on version 26.2)
- I have OP/admin access on the server
- The official Mineflayer library doesn't support 26.2 yet (open upstream issue), but does support 26.1.x
- I want the agent to receive natural language building instructions and place blocks/structures accordingly

Please do the following, checking in with me before major decisions:

1. VERSION STRATEGY
   - Check my actual running server version first (inspect my docker-compose/server config)
   - Confirm whether official Mineflayer/minecraft-data currently support that version
   - If not supported, help me decide between: (a) running the bot against a 26.1 instance instead, or (b) attempting to patch minecraft-data myself for 26.2 support
   - If I choose to patch for 26.2: extract the packet registration order from the server jar (net.minecraft.network.protocol.game.GameProtocols), diff it against the closest existing minecraft-data version entry, and build out a new data/pc/26.2/ folder (protocol.json, version.json, etc.)
   - Test the patched connection with a minimal bot before building anything on top of it

2. PROJECT SCAFFOLDING
   - Set up a Node.js project with mineflayer, mineflayer-pathfinder, and mineflayer-collectblock as a base
   - Structure it cleanly: /src/bot.js (connection/lifecycle), /src/building/ (placement logic), /src/commands/ (natural language parsing), /schematics/ (stored builds)

3. CORE BUILDING CAPABILITIES
   - Basic primitive building functions: place a wall, floor, box, sphere given coordinates and a block type
   - Schematic loading: parse a .schem/.schematic file (use the prismarine-schematic or similar library) and have the bot place it block-by-block from its current position
   - Pathfinding integration so the bot navigates to reach blocks it can't place from its current spot

4. LLM INTEGRATION FOR NATURAL LANGUAGE BUILDING
   - Wire up a Claude API call using model "claude-opus-5" that takes a plain-English building request and translates it into a sequence of structured building actions (calls to the primitives from step 3)

5. SAFETY
   - Add a dry-run mode that prints planned block placements without executing them, so I can review large builds before committing
   - Add a simple undo: track placed blocks per session so I can roll back a build if it goes wrong

Ask me for any credentials, server IPs, or file paths you need instead of guessing them. Don't install any third-party Mineflayer forks from outside the npm registry or the official PrismarineJS org without checking with me first.
