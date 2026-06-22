# TYCOON — online multiplayer Monopoly-style game (design)

**Date:** 2026-06-22
**Slug:** `/monopoly` · **Brand title:** TYCOON (sibling to SONAR)
**Status:** approved design, pre-implementation

A new game for the **gugugagagaming** hub: a faithful, original-IP recreation of
Monopoly in the style of [richup.io](https://richup.io), supporting **2–16
players** in **online multiplayer** rooms. Same domain, new `/monopoly` subpath,
same vanilla-HTML/CSS/JS-on-Vercel philosophy as the rest of the arcade — but
with a small server-authoritative game layer because state must survive players
dropping and rejoining.

---

## 1. Goals & non-goals

**Goals**
- Online multiplayer, 2–16 players per room, private rooms (code + shareable link).
- Server-persisted game state: any original player can drop and rejoin their seat
  mid-game; the game survives the host leaving.
- Full Monopoly ruleset: dice/movement, property purchase, rent, houses/hotels,
  mortgages, Chance/Community-Chest decks, jail, taxes, bankruptcy.
- **Trading** (multi-item, accept/reject/counter) and **Auctions** (live bidding).
- Professional, cohesive neon-glass visuals matching the hub; satisfying
  animations; fully synthesized "heavenly" Web-Audio sound effects (no asset files).
- Deep quality-of-life: reconnect, turn timer w/ auto-actions, live rankings,
  property tooltips, confirm dialogs, copy-link/QR, host pause, host-kick +
  vote-kick, spectator mode, light chat/reactions.

**Non-goals (v1)**
- AI / bot players (explicitly deferred — humans fill seats).
- Public room browser / matchmaking (rooms are code/link only).
- Accounts / persistent profiles (anonymous name + color per session).
- A build step or framework (stays vanilla, no bundler).

---

## 2. Architecture

### 2.1 Authority model — thin clients, authoritative serverless
- **Single source of truth:** one `GameState` JSON document in **Upstash Redis**,
  keyed by room code (`mono:room:<CODE>`).
- **Clients are renderers.** To act, a client POSTs an *intent* to
  `/api/monopoly/action`. It never computes authoritative results.
- **The API** loads state → validates (whose turn, legal action, correct phase)
  → applies the change via a **pure rules engine** → saves to Redis → broadcasts.
- **Broadcast = full snapshot** over Ably channel `monopoly:<CODE>` on every
  change. Dynamic state is only a few KB even at 16 players, so there is no
  event-replay to get wrong — clients simply render the latest snapshot. On
  join/reconnect a client GETs the snapshot once, then lives off the broadcasts.

### 2.2 Concurrency — compare-and-set
- State carries a monotonically increasing `version` integer.
- Every mutation is an **atomic compare-and-set** via an Upstash Lua `EVAL`:
  read current `version`; if it equals the expected version, write the new state
  (with `version+1`) and return OK; else return conflict.
- Conflict → API returns `409`; client refetches the snapshot and retries the
  intent if still valid. Most actions are turn-gated (single actor) so contention
  is rare; auctions/trades/votes (multi-actor) rely on this CAS for correctness.

### 2.3 Turn timer without cron
- State stores `turn.deadline` (epoch ms). Vercel has no long-running process,
  so timing is enforced cooperatively:
  - The **active** client schedules its own auto-action at the deadline.
  - As a guard against a disconnected active player, **any** client may POST a
    `claimTimeout` intent after the deadline; the server validates
    `now > turn.deadline` before auto-resolving (auto-roll → no purchase → end
    turn). This needs no background worker.

### 2.4 Stack / infra
- Static files + tiny serverless functions on Vercel (same as today). No build.
- **Env vars** (user-provisioned, like the existing `ABLY_API_KEY`):
  - `ABLY_API_KEY` — realtime push (reuses existing `/api/token.js`).
  - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis (free tier).
- **Deps added to `package.json`:** `@upstash/redis` (REST client) and `ably`
  (already present; used server-side in `_ably.js` to publish snapshots).
- Without the Redis env vars, `/monopoly` shows a friendly "online play not
  configured" notice (mirrors how battleship degrades without `ABLY_API_KEY`).

### 2.5 Folder layout
```
monopoly/
  index.html            <base href="/monopoly/"> — lobby + game + spectator shell
  css/
    board.css           board grid, tiles, tokens, buildings
    ui.css              panels, modals, dock, toasts, log
    themes.css          neon-glass palette (shared look w/ hub)
  js/
    boarddata.js        static board (40 tiles) + Chance/Chest decks (DUAL-EXPORT)
    main.js             bootstrap; route lobby ↔ game ↔ spectator; prefs
    net.js              API calls + Ably subscribe + reconnect/resume
    state.js            holds last snapshot; diffs old→new to drive animations
    render.js           snapshot → DOM (board, dock, panels, log)
    board.js            board geometry, token movement tweens, building pips
    lobby.js            create/join + settings UI
    trade.js            trade builder + incoming-offer UI
    auction.js          auction bidding UI
    ui.js               modals, toasts, dice animation, confirm dialogs, chat
    audio.js            procedural Web-Audio SFX engine ("heavenly" palette)
api/
  monopoly/
    create.js           create room → {code, playerId, snapshot}
    join.js             join lobby → {playerId, snapshot}
    state.js            GET current snapshot (reconnect)
    action.js           single intent dispatcher → _engine
    _engine.js          pure rules engine (requires boarddata) — server authority
    _redis.js           Upstash client + CAS helper (Lua EVAL)
    _ably.js            publish-snapshot helper (Ably REST)
  token.js  config.js   existing, reused
```
> `boarddata.js` is the single source of board truth, written with the dual
> export idiom used elsewhere in the repo
> (`(typeof module !== 'undefined' ? module.exports : window.MONO = ...)`), so
> both the browser and the Node serverless engine consume the same definitions.

### 2.6 Module conventions (match existing repo idioms)
- Browser JS: IIFE attaching to a `window.MONO` namespace (mirrors `window.BS`),
  with `(typeof window !== 'undefined' ? window : this)` tail.
- Audio engine mirrors `battleship/js/audio.js`: `tone()`, `noise()`, `echoSend()`
  primitives + an `EVENTS` map + master/sfx/music buses; a soft-bell, major-scale
  "heavenly" palette with light reverb/delay.
- Ably loaded lazily from CDN with token auth via `/api/token` (as in
  `battleship/js/net.js`), but used here only to receive snapshot pushes.

---

## 3. Data model (GameState snapshot)

Conceptual shape (not final field-for-field; the plan refines it):
```
{
  code, version, phase,            // phase: 'lobby'|'playing'|'ended'
  settings: {                      // chosen in lobby, immutable after start
    maxPlayers (2..16), startingCash (def 1500),
    auctions (bool), freeParkingPot (bool), evenBuild (bool),
    fullSetDoubleRent (bool), turnSeconds (0=off|N),
    randomizeOrder (bool), roundCap (0=off|N)   // → richest net worth wins
  },
  hostId,
  players: [{
    id, name, color, emoji,
    cash, position, inJail, jailTurns, getOutCards,
    bankrupt (→ spectator), connected (bool), order
  }],
  properties: {                    // keyed by tile index
    <tile>: { ownerId|null, houses (0..5; 5=hotel), mortgaged }
  },
  bank: { houses (32), hotels (12), pot (free-parking) },
  turn: { activeId, phase, dice:[d,d], doublesCount, deadline },
  pending: null | { kind:'auction'|'trade'|'vote', ... },
  log: [ ...recent entries ],      // tail only; capped
  reactions: [ ... ],              // ephemeral emoji
  winnerId, endReason
}
```
- Static, never-stored data lives in `boarddata.js`: tile definitions (name,
  group, price, rent table, house cost, mortgage value), and the two card decks.
- Redis key `mono:room:<CODE>` holds the JSON with a TTL (~24h) refreshed on
  each action so abandoned rooms expire.

---

## 4. Board & rules

### 4.1 Board (classic-equivalent, original names)
40 tiles: GO, **22 streets** in **8 color groups** (sizes 2-2-3-3-3-3-3-3),
**4 railroads**, **2 utilities**, **3 Chance** + **3 Community-Chest**, **Income
Tax** + **Luxury Tax**, **Jail/Just-Visiting**, **Free Parking**, **Go-to-Jail**.
Prices and rent tables use the original Monopoly numbers (public-domain mechanics)
with **original street names and recolored groups** to avoid Hasbro IP.
Building supply: **32 houses / 12 hotels**.

### 4.2 Rules engine (server-authoritative, pure functions)
- **Move:** roll 2d6; doubles → roll again; 3rd consecutive double → jail.
  Passing/landing on GO → +200.
- **Land on tile:**
  - Unowned property → buy at list price, or decline → **auction** (if enabled;
    if disabled, stays unowned).
  - Owned (unmortgaged) → pay rent to owner. Rent: streets by houses
    (base→1–4→hotel; bare full-set doubles base if `fullSetDoubleRent`); railroads
    scale by count owned (25/50/100/200); utilities ×4 (one) / ×10 (both) × dice.
  - Tax tiles → pay bank (or pot if `freeParkingPot`).
  - Chance / Chest → draw top card, apply, recycle to bottom.
  - Go-to-Jail → jail.
- **Jail:** options — pay 50 / use get-out card / roll for doubles (3 attempts,
  then must pay). Optional rent-while-jailed (standard: still collect rent).
- **Build:** buy houses/hotels (even-build toggle; supply-limited; sell back at
  half). Can't build on a mortgaged group.
- **Mortgage/unmortgage:** mortgage for half value; unmortgage = mortgage + 10%
  interest. No rent while mortgaged.
- **Bankruptcy:** when a debt can't be paid even after liquidation →
  - to a player creditor: transfer all assets (mortgaged props + 10% to creditor);
  - to the bank: properties go to **auction**, buildings sold to bank.
  - Bankrupt player → **spectator**.
- **Cards:** ~16 Chance + ~16 Community-Chest (move-to, nearest-RR/utility,
  collect/pay, get-out-of-jail-free, street-repairs per house/hotel, etc.).

### 4.3 End conditions
- Default: **last player standing wins** (all others bankrupt → spectators).
- Optional `roundCap`: when the round/time cap is reached, **highest net worth
  wins** (net worth = cash + property value + buildings − mortgages). Keeps
  16-player games bounded.

---

## 5. Lobby & session flow

- **Identity:** no accounts. Player picks a display name + token color + emoji;
  these + sound prefs persist in `localStorage`. A `playerId` is also stored for
  seat reconnect.
- **Host** creates a room → 4-char code (unambiguous charset, as in battleship's
  `makeCode`) + shareable link + QR. Configures settings (§3), watches players
  join live, hits **Start**.
- **Join:** open link or enter code → lobby → ready up.
- **Roster lock on Start:** only players present at Start are in the game. They
  may drop and **rejoin their seat anytime** (server-persisted). **No brand-new
  players after Start.**
- **Reconnect/resume:** on load, if a stored `playerId` matches a seat in the
  room snapshot, rejoin that seat; otherwise (game already started, unknown id) →
  spectator or "room locked" notice.
- **Spectators:** bankrupt/eliminated players become spectators — see public
  board state live, can leave anytime.

---

## 6. UI / visual design

Cohesive with the hub's neon-glass arcade theme (Orbitron/Space Mono/Inter,
dark radial bg, glassmorphism, glow accents).
- **Board:** centered rounded square, 11×11 CSS grid. Glassmorphic tiles with
  group color bars; owned tiles glow in the owner's color; house/hotel pips.
  Center holds the TYCOON logo, dice, current-action panel, game log, and pot.
- **Player dock (up to 16):** avatar/emoji, cash, color swatch, property count;
  the active player glows with a **circular turn-timer ring**. Scrolls/wraps for
  large counts.
- **Animations (GPU transforms, target 60fps):** token hop per tile traversed,
  dice roll, money fly in/out, card flip, house "pop", confetti on win.
- **Property card:** hover/tap shows full rent table, build cost, mortgage value.
- **Responsive:** desktop board-centric; mobile stacks board + bottom-sheet
  controls. Honors `prefers-reduced-motion` and a "hide animations" toggle.

---

## 7. Sound design ("heavenly", fully synthesized)

Procedural Web-Audio engine (no asset files), mirroring battleship's `audio.js`
architecture (buses, `tone`/`noise`/`echoSend`, `EVENTS`, master/sfx/music gain).
Palette: soft sine/triangle bells on major scales with light reverb/delay for an
airy, satisfying feel. Events:
dice shake/roll · token step blips (ascending) · land · cash-in arpeggio /
cash-out · buy chime · house knock / hotel chord · mortgage · card whoosh + sting
· pass-GO fanfare · rent paid · trade-accepted warm chord · auction tick ·
bankruptcy descend · turn chime · victory fanfare · UI clicks.
Controls: master + per-category volume, mute, persisted in `localStorage`.

---

## 8. Trading & auctions

- **Trading:** propose to any active player; multi-item on both sides (properties
  + cash + get-out-of-jail cards); **live balance preview**; recipient can
  accept / reject / counter. Blocked if either traded color group still has
  buildings (must sell first). Validated server-side on accept.
- **Auctions:** triggered by a declined purchase (if enabled) or bank bankruptcy.
  Live bidding for all solvent players; quick-bid (+10/+50/+100), shows current
  high bid + bidder + countdown; highest bid at timeout wins and pays.

---

## 9. Quality-of-life features

Persist name/color/sound prefs · reconnect to seat · visible turn timer + audio
warning + tab-title flash on your turn · one-click Roll/Buy/End-Turn +
keyboard shortcuts · live net-worth rankings · filterable game log + dice
history · mortgaged props greyed + build-availability indicators · confirm
dialogs with "don't ask again" · color-blind-safe group patterns · copy room
link + QR · **host pause** · **host-kick + vote-kick (majority)** · spectator
view after elimination with leave · light emoji reactions + quick chat over
Ably · reduce-motion / hide-animations option.

---

## 10. Hub integration

- New entry in the `GAMES[]` registry inside the root `index.html`:
  `{ slug:'monopoly', title:'TYCOON', art:'🎩', live:true, desc:'... up to 16 players, online.' }`.
- README updated: add TYCOON to the games table; document the `monopoly/` layout
  and the new `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` env vars
  alongside `ABLY_API_KEY`.
- Base branch: built on `battleship-game-remake` (which carries the hub +
  battleship); `main` is currently empty.

---

## 11. Build order (phases for the implementation plan)

1. **Scaffold & lobby plumbing** — `monopoly/` shell, `boarddata.js`, Redis
   (`_redis.js` CAS) + Ably publish (`_ably.js`), `create`/`join`/`state`/
   `action` endpoints, lobby create/join/settings UI, reconnect/resume.
2. **Core turn engine** — board render + static data; roll/move/buy/rent/tax/
   cards/jail; money; turn rotation; snapshot broadcast + client render/animate.
3. **Property economy** — houses/hotels (even-build, supply), mortgage/unmortgage,
   bankruptcy (to creditor / to bank), end conditions, spectators.
4. **Auctions** — declined-buy + bank-bankruptcy auctions, bidding UI.
5. **Trading** — multi-item proposals, counter, server validation.
6. **Session robustness** — turn timer + `claimTimeout`, disconnect/rejoin,
   host pause, host-kick, vote-kick, roster lock.
7. **Polish** — audio engine, animations, full QoL set, chat/reactions,
   responsive/mobile, reduced-motion.
8. **Integration & docs** — hub registry entry, README + env docs, deploy notes.

---

## 12. Risks & mitigations

- **Rules-engine complexity / correctness** → pure functions, unit-testable in
  isolation; build incrementally per phase; the engine is the only authority.
- **Concurrency at 16 players** → version + Lua CAS; clients retry on `409`.
- **No background worker for timers** → cooperative deadline + `claimTimeout`
  guard validated server-side.
- **Host abandonment** → state is server-persisted; any original player can
  continue; host-only powers (pause/kick) can transfer if host is gone (host
  migration to lowest-order connected player).
- **IP** → original name, street names, recolored groups; only public-domain
  mechanics/numbers reused.
- **Redis/Ably not provisioned** → graceful "online not configured" notice.
