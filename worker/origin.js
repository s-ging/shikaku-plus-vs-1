// origin.js — which web pages may open a room's WebSocket (2026-11-11, decision 0017).
//
// A browser always says which page a WebSocket comes from (the Origin header); a page on
// some other site can't fake it. The app on Android, iOS and desktop sends none, so a
// missing Origin is allowed: that's not a browser page, and blocking it would block the app.
// Everything else must be one of ours:
//   shikaku.plus, www.shikaku.plus   the game's web version (its VS screen plays online)
//   vs.shikaku.plus                  this playtest
//   *.shikaku-plus.pages.dev         the web version's preview and staging builds (and the old origin)
//   localhost, 127.0.0.1             local development (any port)
// Not *.workers.dev: a Worker's name there is only unique within one Cloudflare account, so
// anyone could deploy their own "shikaku-plus-vs-1" and pass. (*.pages.dev is safe: a Pages
// project name is unique across Cloudflare.) Pure, so test/origin.test.js runs it in Node.
const OURS = /^https:\/\/((www\.|vs\.)?shikaku\.plus|([a-z0-9-]+\.)*shikaku-plus\.pages\.dev)$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function originAllowed(origin) {
	if (origin == null || origin === '') return true; // the app, not a browser page
	return OURS.test(origin) || LOCAL.test(origin);
}
