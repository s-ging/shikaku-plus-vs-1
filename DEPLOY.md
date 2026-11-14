# Deploying the VS playtest

Written for Krischan, on Windows. About 15 minutes the first time, one command after that.

What you get: `https://shikaku-plus-vs-1.<your-name>.workers.dev`. Anyone with the link can create or join a room. Nothing touches `shikaku.plus`, the app or the landing page.

## Once

**1. Install Node.js.** Get the LTS installer from [nodejs.org](https://nodejs.org) and click through it. Then open a new terminal (Windows Terminal or PowerShell) and check that it worked:

```
node -v
```

**2. Get the code.**

```
git clone https://github.com/s-ging/shikaku-plus-vs-1.git
cd shikaku-plus-vs-1
```

**3. Optional, but do it: make it run on old phones.** This installs esbuild, which converts the code to an older JavaScript version that iOS 12 and old Android Chrome understand, and minifies it:

```
npm install --save-dev esbuild
```

**4. Log in to Cloudflare.** This opens your browser. Make a free Cloudflare account if you don't have one, then allow access.

```
npx wrangler login
```

The first time, npx asks to install wrangler. Say yes.

**5. Deploy.**

```
npm run deploy
```

At the end it prints your URL. The first time, Cloudflare may ask you to choose a `workers.dev` subdomain; pick anything.

**6. Set the admin secret.** Choose a word only you know, then run:

```
npx wrangler secret put ADMIN_KEY
```

Paste the word when it asks. It's stored in Cloudflare, never in the code or the repo. Your admin link for room QWER is then `https://…workers.dev/QWER+yourword`.

## Every update after that

```
git pull
npm run deploy
```

## Useful

- **Watch the server live** while friends play: `npx wrangler tail`. It shows errors as they happen.
- **Play it on your own machine first**, with no Cloudflare: `node build.mjs` then `node dev-server.mjs`, and open http://localhost:8787. The local admin word is `dev`, so `/QWER+dev`. To try it on your phone, use your PC's local IP (e.g. `http://192.168.1.20:8787`) on the same Wi-Fi.
- **Run the tests:** `npm test`.

## What it costs

Nothing, on the Workers Free plan. Durable Objects are included on Free with SQLite storage. The limits are per day, and the real costs are:

| | Free plan per day | One match (about 300 moves each) |
| --- | --- | --- |
| Requests | 100,000 | about 30 (incoming messages count 20 to 1) |
| Storage rows written | 100,000 | about 600 (one per move) |
| Duration | 13,000 GB-s | almost none: rooms sleep between messages |
| Heartbeat pings | free | free (answered by Cloudflare without waking the room) |

That's over 150 matches a day before anything stops. Planned use is 20 to 50 matches over two weeks. If a limit is ever hit, new requests fail for the rest of that day (UTC); nothing is charged.

Source: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Deploying from the Cloudflare dashboard instead (Git integration)

If you connected this repo in the dashboard (Workers & Pages → Create → Import a repository):

- The Worker's name must be `shikaku-plus-vs-1`, the same as `name` in `wrangler.jsonc`.
- **Build command:** leave empty. **Deploy command:** `npx wrangler deploy`. Wrangler runs `node build.mjs` by itself first.
- Root directory: `/`.
- Still set the secret: Worker → Settings → Variables and Secrets → add `ADMIN_KEY` as a **Secret**.

## If something goes wrong

- **"wrangler: command not found"**: use `npx wrangler …`, not `wrangler …`.
- **The deploy complains about `run_worker_first`**: your wrangler is old. Run `npx wrangler@latest deploy`.
- **A page loads but rooms never connect**: open the browser console (F12). If you see a WebSocket error, run `npx wrangler tail` and try again; send me what it prints.

## Matchmaking (Casual queues, 2026-11-14)

The queues run in their own Worker, `shikaku-plus-mm` (folder `matchmaker/`), so changing them never restarts the rooms or drops a live match. It has no public address: players reach it through this Worker at `/ws/queue/standard` and `/ws/queue/knockout`, after the same Origin check as rooms.

**Right now (2026-11-14) it's off:** the `services` line in `wrangler.jsonc` is commented out and the Casual panel is `hidden` in `client/index.html`, because Cloudflare refuses a deploy that binds a Worker that doesn't exist yet. To switch it on: deploy the matchmaker (step 2 below), then undo those two lines and push to `main`.

**The first time, in this order:**

1. Deploy the rooms first, so `Room` can take reservations. Workers Builds does this when the branch is merged; by hand it's `npm run deploy`. Until step 2 is done, `/ws/queue/*` answers 503 "matchmaking is off" and nothing else changes.

   If Cloudflare refuses the deploy because `shikaku-plus-mm` doesn't exist yet, do step 2 first, then this one.
2. Deploy the matchmaker:

```
npm run deploy:mm
```

**After that:** a queue change is `npm run deploy:mm` only. It never touches a room. A room change is the normal deploy, as before.

**Locally:** `node dev-server.mjs` runs the queues too (same Queue code, in memory). Open two browsers, press Find a match in both.
