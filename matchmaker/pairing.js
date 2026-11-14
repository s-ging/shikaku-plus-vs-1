// pairing.js — who plays whom in a Casual queue. Pure, so test/matchmaker.test.js runs it in Node.
//
// Step 1 (2026-11-14): first come, first served. The two players waiting longest are paired,
// never the same browser twice. Later steps change only this file and the Queue object's
// knobs: the quiet Glicko rating, preferring the same input, the labeled bot after ~2 minutes.

/** The two Casual queues (wiki decision 0025): one per division, both first to 3, never rated. */
export const QUEUE_DIVISIONS = ['standard', 'knockout'];

/** What a player says they play with. Recorded now so pairing by input can be switched on later
 * on the server, with no app release. */
export const INPUTS = new Set(['touch', 'mouse', 'keyboard']);

/** How long a matched pair has to reach their room. After that the room refuses them. */
export const RESERVE_MS = 30000;

/** The pair to match now, or null. waiting: [{ id, at, ... }], any order. */
export function pickPair(waiting) {
	const w = [...waiting].sort((a, b) => a.at - b.at);
	const first = w[0];
	if (!first) return null;
	const second = w.find((x) => x.id !== first.id);
	return second ? [first, second] : null;
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
