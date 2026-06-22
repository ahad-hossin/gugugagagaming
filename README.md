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
| _Coming soon_ | `/<slug>` | Drop a folder + a registry entry. |

## Project layout

```
index.html            the dashboard (game registry is inline — edit GAMES[])
battleship/           one game = one folder
  index.html          (has <base href="/battleship/"> so it works at /battleship)
  css/  js/
api/                  shared serverless functions (root, absolute /api/* paths)
  config.js           reports whether realtime multiplayer is enabled
  token.js            issues short-lived Ably tokens
package.json          deps for the serverless functions (ably)
vercel.json           cleanUrls + cache headers
```

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

Online multiplayer needs `ABLY_API_KEY` set as a Vercel env var; without it the
lobby falls back to same-device (two-tab) play.
