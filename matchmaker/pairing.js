// pairing.js — who plays whom in a Quickplay queue, and when a bot is offered. Pure, so
// test/matchmaker.test.js runs it in Node.
//
// Step 1 (2026-11-14): first come, first served.
// Step 2 (2026-11-16, decision 0025): by skill, from the quiet Glicko-2 rating (worker/ratings.js).
//   The longest-waiting player meets the closest rating the wait allows. The allowed gap starts at
//   BASE_GAP and widens by GAP_PER_S every second the longer waiter has waited; after ANYONE_AFTER_MS
//   anyone will do, so nobody waits longer than first come, first served would make them.
//   A new player (no rating yet) counts as 1500, a new player's rating.
// The bot (decision 0025): by BOT_AFTER_MS with no match, the queue offers a labeled bot. The player
//   keeps their place while they play it (state 'bot', out of pairing), and comes back to the front
//   of the line when it ends. A human found meanwhile waits for them; nothing is interrupted.

/** The two Quickplay queues (wiki decision 0025): one per division, both first to 3, never rated. */
export const QUEUE_DIVISIONS = ['standard', 'knockout'];

/** What a player says they play with. Recorded now so pairing by input can be switched on later
 * on the server, with no app release. */
export const INPUTS = new Set(['touch', 'mouse', 'keyboard']);

/** How long a matched pair has to reach their room. After that the room refuses them. */
export const RESERVE_MS = 30000;

/** The pairing knobs (first guesses, 2026-11-16). Glicko scale: 1500 new, ±200 is about a 76/24 favourite. */
export const BASE_GAP = 100;
export const GAP_PER_S = 8; // 100 at once, 340 after 30 s, 580 after 60 s
export const ANYONE_AFTER_MS = 60000;
/** The bot is offered this long into a search with no match (decision 0025: "by about 2 minutes"). */
export const BOT_AFTER_MS = 120000;

const NEW_RATING = 1500;
const ratingOf = (e) => (e && e.rating && Number.isFinite(e.rating.r) ? e.rating.r : NEW_RATING);
const gap = (a, b) => Math.abs(ratingOf(a) - ratingOf(b));

/** The rating gap a wait of waitMs allows. */
export const allowedGap = (waitMs) => (waitMs >= ANYONE_AFTER_MS ? Infinity : BASE_GAP + (GAP_PER_S * Math.max(0, waitMs)) / 1000);

/** When a and b may meet: as soon as the longer waiter's allowance covers their gap. */
export function pairableAt(a, b) {
	const g = gap(a, b);
	const since = Math.min(a.at, b.at);
	if (g <= BASE_GAP) return since;
	return since + Math.min(ANYONE_AFTER_MS, ((g - BASE_GAP) / GAP_PER_S) * 1000);
}

/** The pair to match now, or null. waiting: [{ id, at, rating?: { r, rd } }], any order. */
export function pickPair(waiting, now = Date.now()) {
	const w = [...waiting].sort((a, b) => a.at - b.at);
	for (const a of w) {
		let best = null;
		for (const b of w) {
			if (b === a || b.id === a.id || pairableAt(a, b) > now) continue;
			if (!best || gap(a, b) < gap(a, best)) best = b; // ties: the one waiting longer (w is sorted)
		}
		if (best) return a.at <= best.at ? [a, best] : [best, a];
	}
	return null;
}

/** When something next changes for these players (a pair becomes possible, a bot is due), or null. */
export function nextWake(waiting, now = Date.now(), botAfterMs = BOT_AFTER_MS) {
	let t = Infinity;
	for (const a of waiting) {
		if (!a.offered) t = Math.min(t, a.at + botAfterMs);
		for (const b of waiting) if (b !== a && b.id !== a.id) t = Math.min(t, pairableAt(a, b));
	}
	return t === Infinity ? null : Math.max(t, now);
}

/** The bot offered to this player: a level near their rating, and its honest label. */
const BOT_LEVELS = [
	[1350, 'easy', 'Easy'],
	[1600, 'normal', 'Normal'],
	[1800, 'hard', 'Hard'],
	[Infinity, 'expert', 'Expert']
];
export function botFor(entry) {
	const r = ratingOf(entry);
	const [, level, name] = BOT_LEVELS.find(([below]) => r < below);
	return { level, label: `Bot · ${name}` };
}

const TICKET_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A seat's one-time ticket: 20 random characters. rand returns 0 ≤ x < 1. */
export function newTicket(rand = Math.random) {
	let t = '';
	for (let i = 0; i < 20; i++) t += TICKET_ALPHABET[Math.floor(rand() * TICKET_ALPHABET.length)];
	return t;
}

/** A random number from crypto, for codes and tickets on the server. */
export const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
