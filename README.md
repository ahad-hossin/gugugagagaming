# gugugagagaming

A little arcade of browser games under one domain — **https://gugugagagaming.vercel.app**

The homepage (`/`) is a dashboard. Each game lives at its own subpath (`/slug`) and
is fully self-contained. No engines, no build step, no installs — vanilla
HTML/CSS/JS, deployed as static files on Vercel with a couple of tiny serverless
functions for online multiplayer.

## Games

| Game | Path | Notes |
|------|------|-------|
| **SONAR** (Battleship) | [`/battleship`](https://gugugagagaming.vercel.app/battleship) | Audio-first Battleship: 4 themes, shaped fleets, ability mode (sonar/barrage/torpedo), and online multiplayer. |
| **TYCOON** (Monopoly) | [`/monopoly`](https://gugugagagaming.vercel.app/monopoly) | Online property-trading game for **2–16 players**. Full ruleset (rent, houses/hotels, mortgages, Chance/Chest, jail, taxes), live **trading** + **auctions**, server-persisted rooms with drop/rejoin, spectators, host- & vote-kick, synth sound, deep QoL. |
| _Coming soon_ | `/<slug>` | Drop a folder + a registry entry. |

## Project layout

```
index.html            the dashboard (game registry is inline — edit GAMES[])
battleship/           one game = one folder
  index.html          (has <base href="/battleship/"> so it works at /battleship)
  css/  js/
battleship/           one game = one folder
monopoly/             TYCOON (online Monopoly)
  index.html          (<base href="/monopoly/">) — lobby + game + spectator shell
  css/  js/           board/render/lobby/trade/auction/audio/main
  js/boarddata.js     static board + card decks (dual-exported: browser + Node)
  dev-server.js       LOCAL-ONLY in-memory server (play without Upstash/Ably)
api/                  shared serverless functions (root, absolute /api/* paths)
  config.js           reports whether realtime multiplayer is enabled
  token.js            issues short-lived Ably tokens
  monopoly/           TYCOON game API
    _engine.js        pure authoritative rules engine
    _redis.js _ably.js _apply.js   Upstash CAS store · Ably broadcast · shared mutate
    create.js join.js state.js action.js   the room/intent endpoints
package.json          deps for the serverless functions (ably, @upstash/redis)
vercel.json           cleanUrls + cache headers
```

### TYCOON architecture

Clients are thin renderers. To act, a client POSTs an *intent* to
`/api/monopoly/action`; the function loads the room's `GameState` from Upstash
Redis, validates + applies it through the pure rules engine (compare-and-set on
a `version` so 16 players can't clobber each other), saves, and broadcasts the
full snapshot over Ably (`monopoly:<CODE>`). Clients render whatever snapshot
arrives, so the game survives refreshes, drops, and the host leaving.

## Add a new game

1. Create a folder `mygame/` with its own `index.html` (+ assets).
2. Add `<base href="/mygame/">` in that `index.html` so relative asset paths
   resolve at `/mygame` (no trailing slash).
3. Add an entry to the `GAMES` array in the root `index.html`.

That's it — Vercel serves `/mygame` from `mygame/index.html` automatically.

## Local dev

Serve from the repo root (don't open via `file://` — the games use absolute
asset paths):

```bash
python3 -m http.server 8123      # http://localhost:8123  (hub)
                                 # http://localhost:8123/battleship/
```

TYCOON needs server state, so use its in-memory dev server (no cloud accounts):

```bash
node monopoly/dev-server.js      # http://localhost:8124/monopoly/
```

Open two browser tabs to play with yourself. Realtime is off in dev, so the
client polls `/state`; this server is a dev aid only — production uses the
serverless functions.

## Environment variables (Vercel)

| Var | Used by | Without it |
|-----|---------|-----------|
| `ABLY_API_KEY` | Battleship + TYCOON realtime | Battleship falls back to two-tab; TYCOON falls back to `/state` polling. |
| `UPSTASH_REDIS_REST_URL` | TYCOON state store | TYCOON shows "online play not configured". |
| `UPSTASH_REDIS_REST_TOKEN` | TYCOON state store | (same) |

Create a free Upstash Redis database, copy its REST URL + token into the Vercel
project env, and TYCOON is live.
