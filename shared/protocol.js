// protocol.js — what goes over the wire. Kept tiny on purpose: a move is about
// 60 bytes, the server's echo about 80. Full match state is only sent on join,
// on reconnect, on a new round, and when a client reports that it drifted.
//
// Client → server
//   hello  { t, id, name, k?, dev, pv?, tok? }  join or rejoin (id is a random per-browser id; pv = PROTOCOL_VERSION;
//                                        tok = the player's Shikaku+ account token: the server checks it and shows the
//                                        account's name and badge instead of the typed name: worker/identity.js)
//   set    { t, o }                      host only, in the lobby: setting overrides
//   ready  { t, v }                      lobby ready toggle
//   start  { t }                         host only, both ready
//   mv     { t, s, a }                   a move; s = the client's own sequence number
//   sync   { t }                         "my prediction says something happened": server catches up
//   next   { t }                         ready for the next round
//   vote   { t, v }                      remake-round vote
//   resync { t }                         ask for a full state
//   tele   { t, d }                      telemetry summary (at round end)
//   time   { t, c }                      clock check: c = the client's clock when sent
//   hv     { t, r? }                     my drag as [x1, y1, x2, y2], or none (not sequenced)
//   report { t }                         admin only: the match report so far
//   claim  { t }                         the hold's wait is over: the missing player forfeits (v2)
//   here   { t }                         mid-match, after 3s without sending anything: still here (wakes the room so
//                                        it notices a dropout even when the other player is idle; changes nothing)
//
// Server → client (sequenced ones carry n, the server's message number, and t, server time)
//   room   { t, code, you, host, admin, phase, seats, o }       lobby / room state; a seat is { name, ready, connected,
//                                                                badge?, v? } (v: the name is the account's, checked)
//   full   { t, n, st, o, phase }                               whole match state
//   mv     { t, n, i, a, at, h, s? }                            an accepted move (s echoed to its sender)
//   no     { t, s, why }                                        a refused move (only to its sender)
//   tk     { t, n, at, h }                                      catch up to time `at` (gravity) — after a sync
//   fz/th  { t, n, i, at, h }                                   a seat froze (disconnected) / thawed
//   round  { t, n, st, remake? }                                a new round started
//   vote   { t, open, yes? }                                    remake vote opened / result
//   report { t, r }                                             admin: the report
//   hold   { t, n, i, at, until }                              v2: seat i is silent; the battle is on hold from `at`
//   go     { t, n, at }                                        v2: play resumes at `at` (a 3-2-1); v3: once both have decided
//   ff     { t, n, i, at, by? }                                v2: seat i forfeits: didn't come back in time, or (by
//                                                                'drops') dropped more than twice this match
//   (mv with at and g null, v2: a move made offline before the hold, applied outside time)
//   time   { t, c, s }                                         clock check answer: s = server time
//   hv     { t, i, r }                                         the other seat's drag (r null = none)
//   err    { t, why, min? }                                    why 'full', or 'update' (pv below min)

/**
 * The wire protocol's version, sent in hello as pv (2026-11-11). The server refuses a hello
 * below MIN_PROTOCOL_VERSION with err 'update' and closes with reason 'update', so an
 * installed app that is too old says "Update Shikaku+ to play online" instead of breaking.
 * A hello with no pv (a web client from before this) counts as version 1.
 * Raise PROTOCOL_VERSION on any change an older client can't follow; raise the minimum
 * only when the server stops supporting the old behaviour.
 */
// 2 (2026-11-11): dropouts hold the battle (hold / go / ff, offline moves applied outside time). A version-1
// client would mis-apply those, so it's told to update.
// 3 (2026-11-11): back from a hold, the battle stays on hold while both decide whether to replay the round;
// the room's vote carries its deadline, and a client that hasn't answered by then says no.
// 4 (2026-11-14, decision 0026): the server deals the boards. round and full carry st.deck, the round's
// Boards as text, and a client deals from it; a version-3 app would generate different boards and desync.
export const PROTOCOL_VERSION = 4;
export const MIN_PROTOCOL_VERSION = 4;
/** The version a hello claims: its pv, or 1 when it has none (or a nonsense one). */
export const helloVersion = (msg) => (Number.isInteger(msg?.pv) && msg.pv > 0 ? msg.pv : 1);

/** Moves as tiny arrays: place ['p', ax, ay, bx, by], erase ['e', x, y]. */
export function encodeAction(a) {
	if (!a) return null;
	return a.type === 'erase' ? ['e', a.x, a.y] : ['p', a.ax, a.ay, a.bx, a.by];
}
export function decodeAction(a) {
	if (!Array.isArray(a)) return null;
	const ok = (v) => Number.isInteger(v) && v >= 0 && v < 32;
	if (a[0] === 'e' && a.length === 3 && ok(a[1]) && ok(a[2])) return { type: 'erase', x: a[1], y: a[2] };
	if (a[0] === 'p' && a.length === 5 && a.slice(1).every(ok)) return { type: 'place', ax: a[1], ay: a[2], bx: a[3], by: a[4] };
	return null;
}

/**
 * An 8-hex fingerprint of what matters in a match. Built from a fixed field order so
 * two machines that agree on the game always agree on the hash. FNV-1a, 32-bit.
 */
export function stateHash(m) {
	const parts = [m.round, m.score[0], m.score[1], m.roundOver ? 1 : 0];
	for (const s of m.sides) {
		const e = s.econ;
		parts.push(
			s.boardIndex,
			s.cleared,
			e.hearts,
			e.ticks,
			e.pool,
			e.frost,
			e.rng.s,
			s.rects.map((r) => `${r.x1}${r.y1}${r.x2}${r.y2}`).join('.'),
			e.mines.map((x) => `${x.cell}:${x.fuse}`).join('.'),
			e.ice.map((x) => `${x.cell}:${x.thaw}`).join('.'),
			e.incoming.map((x) => `${x.count}:${x.eta}`).join('.')
		);
	}
	const str = parts.join('|');
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** Room codes: 4 letters, no look-alikes (no I, L, O). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const isRoomCode = (c) => typeof c === 'string' && /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(c);
export function newRoomCode(rand = Math.random) {
	let c = '';
	for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
	return c;
}
/** "/QWER" or "/QWER+secret" → { code, key } (key is only a hint; the server decides). */
export function parseRoomPath(pathname) {
	const raw = decodeURIComponent((pathname || '').replace(/^\/+/, '').split('/')[0] || '');
	const [code, ...rest] = raw.split('+');
	const up = (code || '').toUpperCase();
	return isRoomCode(up) ? { code: up, key: rest.join('+') || null } : null;
}

/** A short public code for a browser's private id: FNV-1a, 8 hex. Shown to the player, kept in reports. */
export function testerCode(id) {
	let h = 0x811c9dc5;
	for (const ch of String(id || '')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
	const x = h.toString(16).padStart(8, '0').toUpperCase();
	return x.slice(0, 4) + '-' + x.slice(4);
}

// Between rounds (2026-11-05): the result shows for RESULT_MS, then a 3-2-1 countdown of COUNTDOWN_MS.
export const RESULT_MS = 2000;
export const COUNTDOWN_MS = 3000;
