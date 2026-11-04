// client-core.js — the client side of the netcode, with no UI and no transport.
//
// Two copies of the match:
//   confirmed  exactly what the server has said, in server order. Never guessed.
//   predicted  confirmed + my moves the server hasn't echoed yet + gravity up to "now".
// Your own board draws from `predicted`, so a move shows the instant you make it.
// The other board draws from `confirmed`. When the server echoes or refuses a move,
// predicted is rebuilt from confirmed. That is cheap: a snapshot is about 5 KB of
// plain data, and pending moves are usually 0 to 2.
//
// Drift check: every sequenced server message carries an 8-hex state hash. If ours
// differs, we count a mismatch and ask for a full state.
import { FFMatch } from '../engine/ffmatch.js';
import { decodeAction, encodeAction, stateHash } from './protocol.js';

export class ClientCore {
	constructor({ send, now = () => Date.now() }) {
		this.send = send;
		this.now = now;
		this.me = 0;
		this.rules = null;
		this.confirmed = null;
		this.predicted = null;
		this.n = 0;
		this.seq = 0;
		this.pending = []; // { s, a, at, sentAt }
		this.offset = 0; // server time ≈ local time + offset
		this.bestRtt = Infinity;
		this.rtts = [];
		this.mismatches = 0;
		this.resyncs = 0;
		this.syncSentFor = -1;
		this.waitingFull = false;
	}

	serverNow() {
		return this.now() + this.offset;
	}

	/** Feed one server message. Returns events from the other side's confirmed moves, for animation. */
	handle(msg) {
		if (msg.t === 'full' || msg.t === 'round') {
			this.rules = msg.rules || this.rules;
			this.confirmed = FFMatch.fromState(msg.st, this.rules);
			this.n = msg.n;
			// Keep the moves the server hasn't seen yet (made during a dropout) and send them again.
			// A new round drops them: they belonged to the board that just ended.
			this.pending = msg.t === 'full' ? this.pending.filter((p) => p.s > (msg.ls || 0)) : [];
			this.seq = Math.max(this.seq, msg.ls || 0); // after a reload our counter restarts; the server's wins
			for (const p of this.pending) this.send({ t: 'mv', s: p.s, a: encodeAction(p.a) });
			this.waitingFull = false;
			this._repredict();
			return [];
		}
		if (!this.confirmed || this.waitingFull) return [];
		if (msg.t === 'no') {
			this.pending = this.pending.filter((p) => p.s !== msg.s);
			this._repredict();
			return [];
		}
		if (!('n' in msg)) return [];
		if (msg.n !== this.n + 1) return this._askFull('gap');
		this.n = msg.n;
		const c = this.confirmed;
		const events = c.catchUp(msg.at);
		if (msg.t === 'mv') {
			const r = c.act(msg.i, decodeAction(msg.a), msg.at);
			events.push(...r.events);
			if (msg.i === this.me && msg.s != null) {
				const p = this.pending.find((q) => q.s === msg.s);
				if (p) this._rtt(p.sentAt, msg.at);
				this.pending = this.pending.filter((q) => q.s !== msg.s);
			}
		} else if (msg.t === 'fz') c.freezeSide(msg.i, msg.at);
		else if (msg.t === 'th') c.thawSide(msg.i, msg.at);
		if (msg.h && stateHash(c) !== msg.h) {
			this.mismatches++;
			return this._askFull('hash');
		}
		this._repredict();
		return events;
	}

	/** Make a move locally (instantly) and send it. Returns the local result for animation. */
	move(action) {
		const p = this.predicted;
		if (!p || p.roundOver || p.over) return { moved: false, events: [] };
		const at = this.serverNow();
		const events = p.catchUp(at);
		const r = p.act(this.me, action, at);
		r.events = [...events, ...r.events];
		if (!r.moved) return r;
		const s = ++this.seq;
		this.pending.push({ s, a: action, at, sentAt: this.now() });
		this.send({ t: 'mv', s, a: encodeAction(action) });
		return r;
	}

	/** Gravity: bring the prediction up to now. Asks the server to confirm a predicted round end. */
	tick() {
		const p = this.predicted;
		if (!p) return [];
		const events = p.catchUp(this.serverNow());
		if (p.roundOver && !this.confirmed.roundOver && this.syncSentFor !== this.n) {
			this.syncSentFor = this.n;
			this.send({ t: 'sync' });
		}
		return events;
	}

	/** Milliseconds until the next gravity tick on my board, or null. */
	msToGravity() {
		const p = this.predicted;
		const step = (this.rules?.gravitySecs || 0) * 1000;
		if (!p || !step || p.roundOver) return null;
		const s = p.sides[this.me];
		if (s.gAt == null || s.frozenAt != null) return null;
		return Math.max(0, s.gAt + step - p.clock) + 5;
	}

	telemetry() {
		const r = [...this.rtts].sort((a, b) => a - b);
		const q = (f) => (r.length ? r[Math.min(r.length - 1, Math.floor(f * r.length))] : null);
		return { rttMs: { n: r.length, p50: q(0.5), p95: q(0.95), max: r.length ? r[r.length - 1] : null }, mismatches: this.mismatches, resyncs: this.resyncs };
	}

	_rtt(sentAt, serverAt) {
		const t = this.now();
		const rtt = t - sentAt;
		if (this.rtts.length < 500) this.rtts.push(rtt);
		// The lowest-RTT sample gives the best clock estimate.
		if (rtt <= this.bestRtt) {
			this.bestRtt = rtt;
			this.offset = serverAt + rtt / 2 - t;
		}
	}
	_askFull(why) {
		this.waitingFull = true;
		this.resyncs++;
		this.send({ t: 'resync', why });
		return [];
	}
	_repredict() {
		const p = FFMatch.fromState(this.confirmed.toState(), this.rules);
		for (const q of this.pending) {
			p.catchUp(q.at);
			p.act(this.me, q.a, q.at);
		}
		p.catchUp(this.serverNow());
		this.predicted = p;
	}
}

export { stateHash };
