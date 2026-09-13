#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# One command from a fresh clone to a bot waiting for !build.
#
# Everything here used to be a manual step: copy two files, invent an RCON
# password, find the allow list inside a JSON file and put your own name in it,
# then work out why the bot was ignoring you when you hadn't. Only the first
# question actually needs a human - the rest is generated or already correct.
#
# POSIX sh, no node needed: the README promises Docker is the only requirement,
# and the host this was written on has no node installed at all.
# ---------------------------------------------------------------------------
set -eu

cd "$(dirname "$0")"

say () { printf '%s\n' "$*"; }
die () { printf 'setup: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed - see https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "this docker has no 'compose' subcommand (needs Compose v2)"

# --- the one thing that cannot be guessed ----------------------------------
# RCON is console level, so the bot only listens to names on the allow list.
# Taken as an argument for unattended installs, asked for otherwise.
BUILDER_NAME="${1:-${BUILDER:-}}"
if [ -z "$BUILDER_NAME" ]; then
  if [ -t 0 ]; then
    printf 'Your Minecraft name (only this name may build): '
    read -r BUILDER_NAME
  else
    die "no Minecraft name given. Run: ./setup.sh YourName"
  fi
fi
case "$BUILDER_NAME" in
  ''|*[!A-Za-z0-9_]*) die "\"$BUILDER_NAME\" is not a Minecraft name (letters, digits and _ only)" ;;
esac

# --- a password nobody has to invent ---------------------------------------
# Tried in order; the last is always present because this script needs docker
# anyway, which means we can borrow randomness from a container if the host has
# neither openssl nor /dev/urandom exposed the way we expect.
random_secret () {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  elif [ -r /dev/urandom ]; then
    od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
  else
    docker run --rm alpine sh -c 'od -An -tx1 -N24 /dev/urandom | tr -d " \n"'
  fi
}

if [ -f .env ]; then
  say "keeping the .env you already have"
  # Add only what is missing, so re-running setup never rewrites a password.
  grep -q '^BUILDER=' .env || printf 'BUILDER=%s\n' "$BUILDER_NAME" >> .env
  grep -q '^RCON_PASSWORD=' .env || printf 'RCON_PASSWORD=%s\n' "$(random_secret)" >> .env
  grep -q '^ONLINE_MODE=' .env || printf 'ONLINE_MODE=true\n' >> .env
else
  umask 077
  cat > .env <<EOF
# Written by setup.sh. Never commit this file.
BUILDER=$BUILDER_NAME
RCON_PASSWORD=$(random_secret)
ONLINE_MODE=true
EOF
  say "wrote .env with a generated RCON password"
fi

# rcon-servers.json is NOT created: the committed example already works, and
# reads BUILDER and RCON_PASSWORD from the environment. Copy it yourself only
# when you want a second server or hand-edited paths.

say "starting the server and the bot..."
docker compose up -d

# --- wait for something meaningful, not a fixed sleep ----------------------
# The server generates a world on first run, which can take minutes on a Pi.
say "waiting for the bot to reach the server (first run generates a world, this can take a while)..."
i=0
while [ "$i" -lt 300 ]; do
  if docker compose logs bot 2>/dev/null | grep -q 'rcon connected'; then
    say ""
    say "Ready. Join the server, look at the ground and type:"
    say "    !build list"
    say "    !build house1"
    say ""
    say "Drop .schem / .schematic / .litematic files into schematics/ and they are"
    say "buildable by filename straight away - no restart, nothing to edit."
    exit 0
  fi
  # Surface the common first-run failure rather than timing out silently.
  if docker compose logs bot 2>/dev/null | grep -q 'rcon auth failed'; then
    die "the bot could not authenticate. If you changed RCON_PASSWORD, recreate
     the containers so they re-read it:  docker compose up -d --force-recreate"
  fi
  i=$((i + 5))
  sleep 5
done

die "the bot has not connected after 5 minutes. Look at:  docker compose logs bot"
