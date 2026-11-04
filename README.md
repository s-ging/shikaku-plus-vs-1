# Shikaku+ VS playtest

A standalone browser build of Shikaku+ VS for playing friends online, across any mix of devices, to find network and device problems before the Flutter port. Built 2026-11-04. Deploy: [DEPLOY.md](DEPLOY.md).

This repo is separate from the app (`s-ging/shikaku-plus`), the landing page and the wiki (`s-ging/shikaku-plus-info`). The game rules are in [engine/](engine/), and this repo is their home: the server, the client and the lab all run this one copy. `engine/puzzle.js` and `engine/game.js` are unchanged copies of the landing page's generator and rules; don't edit them here.

Two modes run on the same engine: **Shikaku+ VS**, the complete experience (`VERSUS_RULES`), and **Shikaku+ Mines**, mines only with no ice, unrated (`MINES_RULES`). A room host picks the mode in the lobby (Mines preset); practice has a mode menu.

The **lab** in [lab/](lab/) is where rules and HUD get tried first: one self-contained page with bots, sliders and a match log. Build it with `node lab/build.mjs`; it is published as Krischan's lab artifact. 
## How it works

- **One Cloudflare Worker.** It serves two static files (`public/index.html` and `public/app.js`). Only `/ws/*` and `/api/*` run Worker code.
- **One Durable Object per room** (`/ws/QWER` → the object named QWER), using the WebSocket Hibernation API: a quiet room sleeps and costs nothing.
- **The server is the referee; the client runs your own board.** This is the TETR.IO model.
  - Your move shows the instant you make it (`predicted`), then goes to the server as a tiny array (`['p', ax, ay, bx, by]`, about 60 bytes).
  - The server applies it with the same engine, in one order for both players, and echoes it with an 8-hex state hash (about 80 bytes).
  - Each client replays the echoes on its `confirmed` copy. A hash that doesn't match means drift: the client asks for a full state and counts a mismatch in telemetry.
  - Full state (about 5 KB) only goes out on join, reconnect, a new round, or drift.
- **Gravity, lazily.** After `gravitySecs` with no move, your board ticks once; every move resets that timer (like Tetris lock delay), so a tick never lands a hair after a move.
- **Moves carry their own time.** The client stamps each move with its estimate of server time. The server honours it if it's no older than 250ms (`LAG_MS` in `worker/room-core.js`), and pays the other seat's gravity 250ms late, so a move made just before a tick, still on its way, resets the tick instead of losing to it. A seat's own gravity is paid up to its own message (its messages arrive in order). Every message says which times were used (`at`, `g`), so clients replay exactly what the server did. Nothing runs a clock: whoever handles the next message pays the ticks owed since the last one, from timestamps (`VersusMatch.catchUp`). Clients predict the same ticks locally.
- **Bad connections keep playing.** Your board keeps working through lag or a dropout. Moves made while offline queue up and are resent on reconnect, and the server applies each move once (`lastS`).
- **Dropping out.** Only after 20s of silence is a player treated as gone: their board and gravity freeze, while the other player keeps attacking into their bank.
- **Remake vote.** Gone 10s or more in one round: on return, both players are offered a replay of the round with no score change. Votes are logged.
- **Heartbeat.** Clients send `ping` every 4s, and Cloudflare answers `pong` itself without waking the room (`setWebSocketAutoResponse`). No pong for 10s, and the client reconnects. The server reads ping times lazily to spot dead sockets.
- **Practice against a bot** runs entirely in the browser. No server.
- **Admin rooms.** `/QWER+secret`, where the secret is the `ADMIN_KEY` Worker secret, gets a match-report button and the recent-matches list.

## Files

| File | What it is |
| --- | --- |
| `worker/room-core.js` | One room's logic, with no Cloudflare API in it: seats, lobby, settings, moves, gravity, freeze and thaw, remake vote, reports, move-timing stats |
| `worker/index.js` | The Worker and the two Durable Objects (`Room`, `Reports`); adapts sockets and storage to room-core |
| `shared/protocol.js` | Every message, the move encoding, the state hash, room codes |
| `shared/settings.js` | The room settings a host can change, presets, and the sanitizer the server uses |
| `shared/client-core.js` | Client netcode: confirmed and predicted copies, reconciliation, clock offset, RTT, mismatch counting |
| `client/hud.js` | The game screen, shared with the lab: boards, callout lane, combo, ice and mine poles, hearts, play and spectator views. Draws on change only; transform and opacity only |
| `client/ui.js`, `client/index.html` | Home, lobby, match, practice; feeds the screen my predicted board and their confirmed one. Plain JS, no framework |
| `build.mjs` | Stitches everything into `public/app.js` (one script, two requests per page). Uses esbuild if installed |
| `dev-server.mjs` | Run it all locally with no Cloudflare and no dependencies |
| `engine/` | The rules: `versus.js` (economy), `versus-match.js` (match, bots, snapshots, gravity) and the generator they use |
| `lab/` | The lab page: `page.html`, `app.js`, `build.mjs` (bundles the engine into one file) |
| `test/engine.test.js` | The rules' tests |
| `test/room.test.js` | Two real clients play through the real room with lag: full match, dropout, silent socket, remake vote, queued moves |

## Telemetry (what a report holds)

Per match:
- the settings used
- each round: winner, how it ended, length, boards reached, frozen-over count
- remake votes

Per player:
- device: user agent, screen, pixel ratio, memory, cores, network type, touch
- client telemetry each round: RTT p50/p95/max, mismatches, resyncs, reconnects
- reconnects and total time disconnected
- move timing: count, mean, standard deviation, fastest gap, average time to the first move on a new board

The move timing is the raw material for spotting solver-like play later; nobody acts on it automatically. No IPs are stored, and names are whatever players type.

## Known limits

- **Old browsers:** without esbuild installed, `app.js` uses modern syntax (`??`, `?.`), so iOS 12 and old Android browsers need the esbuild step in [DEPLOY.md](DEPLOY.md).
- **No spectators:** two seats per room; a third visitor is turned away.
- **Equal players can stalemate:** with the default cancel-only counter-spike, two clean players cancel each other's mines until rush. That's the counter-spike tuning Krischan is doing.
- **No SvelteKit yet:** Krischan OK'd plain JS for the playtest (2026-11-04). The game and network logic are UI-free modules, so a Svelte shell can wrap them later.
