// replay.js — rebuilds a recorded round, exactly, from its seed and the server's messages.
// Pure and UI-free: the viewer (client/ui.js) and the tests use the same code.
//
// A replay is { header, rounds }:
//   header  { v, id, code, startedAt, seed, target, rules, names }
//   round   { round, t0, startAt, score, frozen, msgs, hash, end?, partial? }
//   msgs    ['m', seat, move, at, g] · ['t', seat, at, g] · ['f', seat, at] · ['h', seat, at, g] · ['v', seat, at, tile|null] (a hover)
// The messages are applied the same way a client applies them live (shared/client-core.js),
// so the state after the last one hashes to `hash`: that's the proof the replay is faithful.
import { VersusMatch } from '../engine/versus-match.js';
import { decodeAction, stateHash } from './protocol.js';

/** A match at the start of round `rd`, before any message. */
export function roundStart(header, rd) {
	const m = new VersusMatch({ rules: { ...header.rules }, seed: header.seed, target: header.target });
	while (m.round < rd.round) m.newRound();
	m.score = [...rd.score];
	m.startClock(rd.t0, rd.startAt - rd.t0);
	for (const i of rd.frozen || []) m.freezeSide(i, rd.t0);
	return m;
}

/** The time a message happened at. */
export const msgAt = (x) => (x[0] === 'm' ? x[3] : x[2]);

/** Apply one recorded message. Returns the engine events, for animation. */
export function applyMsg(m, x) {
	const [t, i] = x;
	if (t === 'v') return []; // a hover: shown by the viewer, changes nothing
	const at = msgAt(x);
	const g = t === 'm' ? x[4] : t === 't' || t === 'h' ? x[3] : null;
	const events = m.catchUp(g ?? at);
	if (i != null && g != null) events.push(...m.catchUp(at, i));
	if (t === 'm') events.push(...m.act(i, decodeAction(x[2]), at).events);
	else if (t === 'f') m.freezeSide(i, at);
	else if (t === 'h') m.thawSide(i, at);
	return events;
}

/** Rebuild a round up to (and including) message index `upTo`; -1 = the start. */
export function roundAt(header, rd, upTo) {
	const m = roundStart(header, rd);
	for (let k = 0; k <= upTo && k < rd.msgs.length; k++) applyMsg(m, rd.msgs[k]);
	return m;
}

/** Where each seat's hover is after message `upTo`: the last hover, cleared by that seat's next move. */
export function hoversAt(rd, upTo) {
	const out = [null, null];
	for (let k = 0; k <= upTo && k < rd.msgs.length; k++) {
		const x = rd.msgs[k];
		if (x[0] === 'v') out[x[1]] = x[3];
		else if (x[0] === 'm') out[x[1]] = null;
	}
	return out;
}

/** True if replaying every message lands on the hash the server recorded. */
export function verifyRound(header, rd) {
	return stateHash(roundAt(header, rd, rd.msgs.length - 1)) === rd.hash;
}

/** When the round's playback ends: its result, else its last message. */
export function roundEnd(rd) {
	return rd.end ? rd.end.at : rd.msgs.length ? msgAt(rd.msgs[rd.msgs.length - 1]) : rd.startAt;
}
