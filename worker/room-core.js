// room-core.js — one room's logic, with no Cloudflare API in it, so it can be tested
// in plain Node. The Durable Object in index.js only adapts WebSockets and storage.
//
// Cost model (the optimization rule: put a number on it):
//   per move:   1 message in (~60 B), 1 message out to each seat (~80 B), one state
//               hash (~2 KB of string building), one storage write of the room (~6 KB).
//   idle room:  nothing runs. No timers, no alarms. Gravity is paid lazily from
//               timestamps when the next message arrives (VersusMatch.catchUp).
//   per match:  one report sent to the Reports object at the end, plus one replay write per round
//               (the round's messages, ~25 B a move). The saved room also carries the current round's
//               replay so far, so a sleeping room loses nothing: ~6 KB plus ~25 B a move.
import { VersusMatch } from '../engine/versus-match.js';
import { decodeAction, encodeAction, stateHash, testerCode, RESULT_MS, COUNTDOWN_MS } from '../shared/protocol.js';
import { rulesFor, sanitize } from '../shared/settings.js';

const STALE_MS = 20000; // no ping or message this long = really gone (a phone that lost signal may never close its socket).
// Shorter hiccups never freeze anyone: the client keeps playing and its queued moves arrive when the line comes back.
const REMAKE_AFTER_MS = 10000; // a seat gone this long in one round may call a remake vote
const VOTE_MS = 20000;
const NAME_MAX = 16;
// Gravity and lag (2026-11-05). A move carries the time it was made (the client's estimate of
// server time). The server honours it if it's no older than LAG_MS, and pays the OTHER seat's
// gravity LAG_MS late, so a move made just before a tick, still on its way, resets that tick
// instead of losing to it. The sender's own gravity is paid up to its message: one seat's
// messages arrive in order. Cost: about 15 bytes more per message; nothing runs while idle.
const LAG_MS = 250;
// Between rounds: RESULT_MS of result, then a COUNTDOWN_MS 3-2-1 (both in shared/protocol.js).
// No "next round" button: the server schedules the next round's start time the moment one ends.
// Nothing runs meanwhile; moves before the start time are refused.

/** A replay's id: 16 random characters, so a replay link can't be guessed. */
function randomId() {
	const a = 'abcdefghijkmnpqrstuvwxyz23456789';
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => a[b % a.length]).join('');
}

const cleanName = (s) =>
	String(s || '')
		.replace(/[^\p{L}\p{N} _.-]/gu, '')
		.trim()
		.slice(0, NAME_MAX) || 'Player';

export class RoomCore {
	/**
	 * io: { send(conn, obj), conns() → [{ conn, id }], save(obj), report(obj), lastPing?(id) → ms }
	 * adminKey: the secret from the environment; a hello whose k matches it is admin.
	 */
	constructor(code, io, adminKey, saved = null) {
		this.code = code;
		this.io = io;
		this.adminKey = adminKey || null;
		Object.assign(this, {
			phase: 'lobby',
			seats: [], // { id, name, ready, connected, admin, dev, tele, reconnects, gone, goneRound, timing }
			o: {},
			n: 0,
			next: [false, false],
			vote: null, // { yes: [bool|null, bool|null], until }
			report: null,
			matchState: null,
			_roundLogged: false,
			rlog: null // this round's replay so far: what the server applied, in order (see _record)
		});
		if (saved) Object.assign(this, saved);
		this.match = this.matchState ? VersusMatch.fromState(this.matchState, rulesFor(this.o).rules) : null;
	}

	// —— persistence ——
	_save() {
		this.matchState = this.match ? this.match.toState() : null;
		const { code, phase, seats, o, n, next, vote, report, matchState, _roundLogged, rlog } = this;
		this.io.save({ code, phase, seats, o, n, next, vote, report, matchState, _roundLogged, rlog });
	}

	// —— helpers ——
	_seatOf(id) {
		return this.seats.findIndex((s) => s.id === id);
	}
	_to(id, obj) {
		for (const c of this.io.conns()) if (c.id === id) this.io.send(c.conn, obj);
	}
	_all(obj, except) {
		for (const c of this.io.conns()) if (c.id && c.id !== except) this.io.send(c.conn, obj);
	}
	_roomMsg(id) {
		const i = this._seatOf(id);
		return {
			t: 'room',
			code: this.code,
			you: i,
			host: i === 0,
			admin: !!this.seats[i]?.admin,
			phase: this.phase,
			seats: this.seats.map((s) => ({ name: s.name, ready: s.ready, connected: s.connected })),
			replay: this.report && this.match && this.match.over ? this.report.replayId : null,
			o: this.o,
			vote: this.vote ? { open: true, yes: this.vote.yes } : null
		};
	}
	_roomAll() {
		for (const s of this.seats) this._to(s.id, this._roomMsg(s.id));
	}
	_full(id) {
		const { rules } = rulesFor(this.o);
		const seat = this.seats[this._seatOf(id)];
		this._to(id, { t: 'full', n: this.n, st: this.match.toState(), rules, phase: this.phase, ls: seat ? seat.lastS || 0 : 0 });
	}
	_seq(obj) {
		this.n++;
		const h = stateHash(this.match);
		this._record(obj, h);
		return { ...obj, n: this.n, h };
	}

	// —— replays (2026-11-05) ——
	// A replay is the match header plus, per round, every sequenced message the server applied:
	//   ['m', seat, action, at, g]   a move        ['t', seat, at, g]   a gravity catch-up
	//   ['f', seat, at]              a freeze      ['h', seat, at, g]   a thaw
	// The engine is deterministic, so replaying these from the round's seed rebuilds the round
	// exactly; the last state hash is kept to prove it. About 25 bytes per move.
	_record(obj, h) {
		const r = this.rlog;
		if (!r) return;
		if (obj.t === 'mv') r.msgs.push(['m', obj.i, obj.a, obj.at, obj.g]);
		else if (obj.t === 'tk') r.msgs.push(['t', obj.i ?? null, obj.at, obj.g ?? null]);
		else if (obj.t === 'fz') r.msgs.push(['f', obj.i, obj.at]);
		else if (obj.t === 'th') r.msgs.push(['h', obj.i, obj.at, obj.g ?? null]);
		else return;
		r.hash = h;
	}
	_openRound(now) {
		const m = this.match;
		this.rlog = { round: m.round, t0: now, startAt: m.roundStartAt, score: [...m.score], frozen: m.sides.map((s, i) => (s.frozenAt != null ? i : -1)).filter((i) => i >= 0), msgs: [], hash: stateHash(m) };
	}
	_flushRound(partial = false) {
		if (!this.rlog || !this.report || !this.report.replayId) return;
		this.io.replay?.(this.report.replayId, this.rlog.round, partial ? { ...this.rlog, partial: true } : this.rlog);
	}

	// —— connection events ——
	/** A socket said hello. Returns false if the room is full. */
	hello(id, msg, now) {
		let i = this._seatOf(id);
		if (i < 0) {
			if (this.seats.length >= 2) {
				this._to(id, { t: 'err', why: 'full' });
				return false;
			}
			this.seats.push({ id, name: cleanName(msg.name), ready: false, connected: true, admin: false, dev: null, tele: [], reconnects: 0, gone: 0, goneRound: 0, timing: null });
			i = this.seats.length - 1;
		} else {
			const s = this.seats[i];
			if (!s.connected) s.reconnects++;
			s.connected = true;
			if (msg.name) s.name = cleanName(msg.name);
		}
		const seat = this.seats[i];
		if (this.adminKey && msg.k && msg.k === this.adminKey) seat.admin = true;
		if (msg.dev && typeof msg.dev === 'object') seat.dev = JSON.parse(JSON.stringify(msg.dev).slice(0, 600) || 'null');
		seat.lastSeen = now;
		this._resume(i, now);
		this._reap(now);
		this._roomAll();
		if (this.match) this._full(id);
		this._save();
		return true;
	}

	_resume(i, now) {
		const seat = this.seats[i];
		if (!this.match || this.phase !== 'match' || seat.left == null) return;
		const g = this._pay(now, i, now);
		const gap = now - (seat.goneFrom ?? seat.left); // counted from when we last heard from them
		seat.gone += gap;
		seat.goneRound += gap;
		seat.left = null;
		seat.goneFrom = null;
		seat.connected = true;
		this.match.thawSide(i, now);
		this._all(this._seq({ t: 'th', i, at: now, g }), seat.id);
		if (seat.goneRound >= REMAKE_AFTER_MS && !this.match.roundOver && !this.vote) this.vote = { yes: [null, null], until: now + VOTE_MS };
	}

	/** Lazy dead-connection check, run whenever anything arrives. No timers. */
	_reap(now) {
		if (!this.match || this.phase !== 'match') return;
		this.seats.forEach((s, i) => {
			if (s.left != null || !s.connected) return;
			const seen = Math.max(s.lastSeen || 0, (this.io.lastPing && this.io.lastPing(s.id)) || 0);
			if (seen && now - seen > STALE_MS) this._drop(i, now, seen);
		});
	}

	closed(id, now) {
		const i = this._seatOf(id);
		if (i < 0) return;
		if (this.io.conns().some((c) => c.id === id)) return; // another tab of the same browser is still on
		this._drop(i, now);
		this._save();
	}

	_drop(i, now, since = now) {
		const seat = this.seats[i];
		if (seat.left != null) {
			seat.connected = false; // already frozen (it went silent first); keep when it really left
			return;
		}
		seat.goneFrom = since;
		const id = seat.id;
		seat.connected = false;
		if (this.phase === 'lobby') {
			this.seats.splice(i, 1);
		} else if (this.match && this.phase === 'match') {
			seat.left = now;
			const g = this._pay(now);
			this.match.freezeSide(i, g);
			// Sent to the frozen seat too: if its socket was only quiet, it hears this and answers.
			this._all(this._seq({ t: 'fz', i, at: g }));
			// Everyone gone mid-match: record it as abandoned now. If they come back and finish,
			// the finished report replaces this one (same key).
			if (!this.match.over && this.seats.every((s) => !s.connected)) this._sendReport(now);
		}
		this._roomAll();
	}

	message(id, msg, now) {
		const i = this._seatOf(id);
		if (i < 0 || !msg || typeof msg.t !== 'string') return;
		const seat = this.seats[i];
		seat.lastSeen = now;
		if (seat.left != null) {
			this._resume(i, now); // it was only quiet, not gone
			this._roomAll();
			if (this.match) this._full(id);
		}
		this._reap(now);
		this._expireVote(now);
		switch (msg.t) {
			case 'set':
				if (i !== 0 || this.phase !== 'lobby') return;
				this.o = sanitize(msg.o);
				for (const s of this.seats) s.ready = false;
				this._roomAll();
				break;
			case 'ready':
				if (this.phase !== 'lobby') return;
				seat.ready = !!msg.v;
				this._roomAll();
				break;
			case 'start':
				if (i !== 0 || this.phase !== 'lobby' || this.seats.length < 2 || !this.seats.every((s) => s.ready)) return;
				this._startMatch(now);
				break;
			case 'mv':
				this._move(i, msg, now);
				break;
			case 'sync':
				if (!this.match || this.phase !== 'match') return;
				this._all(this._seq({ t: 'tk', i, at: now, g: this._pay(now, i, now) }));
				this._afterChange(now);
				break;
			case 'next':
				this._next(i, now);
				break;
			case 'vote':
				this._vote(i, !!msg.v, now);
				break;
			case 'resync':
				if (this.match) this._full(id);
				break;
			case 'tele':
				if (seat.tele.length < 20 && msg.d && typeof msg.d === 'object') seat.tele.push(JSON.parse(JSON.stringify(msg.d).slice(0, 1500) || 'null'));
				break;
			case 'report':
				if (seat.admin) this._to(id, { t: 'report', r: this._report(now) });
				return;
			default:
				return;
		}
		this._save();
	}

	// —— match ——
	_startMatch(now) {
		const { rules, firstTo } = rulesFor(this.o);
		const seed = (Math.floor(now / 1000) % 1000000) + 1;
		this.match = new VersusMatch({ rules, seed, target: firstTo });
		this.match.startClock(now, COUNTDOWN_MS);
		this.phase = 'match';
		this.next = [false, false];
		for (const s of this.seats) {
			s.goneRound = 0;
			s.timing = { n: 0, sum: 0, sumSq: 0, min: null, last: now, boardFirst: { n: 0, sum: 0 }, boardAt: now, board: 0 };
		}
		const replayId = randomId();
		this.report = { code: this.code, startedAt: now, o: this.o, mode: rules.mode === 'mines' ? 'mines' : 'vs', firstTo, rounds: [], votes: [], replayId };
		this.io.replay?.(replayId, 0, { v: 1, id: replayId, code: this.code, startedAt: now, seed, target: firstTo, rules, names: this.seats.map((s) => s.name) });
		this._openRound(now);
		this.n++;
		for (const s of this.seats) this._to(s.id, { t: 'round', n: this.n, st: this.match.toState(), rules, ls: s.lastS || 0, startAt: this.match.roundStartAt });
		this._roomAll();
	}

	_move(i, msg, now) {
		const m = this.match;
		if (!m || this.phase !== 'match') return;
		const seat = this.seats[i];
		// Moves can arrive twice after a reconnect (resent from the queue). Apply each once.
		if (!Number.isInteger(msg.s) || msg.s <= (seat.lastS || 0)) return;
		seat.lastS = msg.s;
		const action = decodeAction(msg.a);
		const ticksBefore = m.sides.map((s) => s.econ.ticks).join();
		// The move's own time, if it's believable: no older than LAG_MS, never before this seat's
		// last message, never in the future.
		const claimed = Number.isFinite(msg.at) ? Math.round(msg.at) : now;
		const at = Math.min(now, Math.max(claimed, now - LAG_MS, seat.lastAt || 0));
		const g = this._pay(now, i, at);
		const r = action && !m.roundOver ? m.act(i, action, at) : { moved: false, denied: 'bad' };
		if (!r.moved) {
			this._to(seat.id, { t: 'no', s: msg.s, why: r.denied || 'invalid' });
			// If the catch-up paid gravity ticks, keep everyone in step; otherwise send nothing more.
			if (m.sides.map((s) => s.econ.ticks).join() !== ticksBefore) this._all(this._seq({ t: 'tk', i, at, g }));
			this._afterChange(now);
			return;
		}
		this._time(i, now);
		const echo = this._seq({ t: 'mv', i, a: encodeAction(action), at, g });
		this._to(seat.id, { ...echo, s: msg.s });
		this._all(echo, seat.id);
		this._afterChange(now);
	}

	/**
	 * Pay gravity: everyone up to now − LAG_MS, then seat i up to its own time `at`.
	 * Returns the horizon, which goes in the message so clients make the same two calls.
	 */
	_pay(now, i = null, at = now) {
		const g = now - LAG_MS;
		this.match.catchUp(g);
		if (i != null) {
			this.match.catchUp(at, i);
			this.seats[i].lastAt = Math.max(this.seats[i].lastAt || 0, at);
		}
		return g;
	}

	/** Move-timing summary per seat: the raw material for spotting solver-like play. No arrays kept. */
	_time(i, now) {
		const t = this.seats[i].timing;
		if (!t) return;
		const gap = now - t.last;
		t.last = now;
		t.n++;
		t.sum += gap;
		t.sumSq += gap * gap;
		t.min = t.min == null ? gap : Math.min(t.min, gap);
		const s = this.match.sides[i];
		if (s.boardIndex !== t.board) {
			t.board = s.boardIndex;
			t.boardAt = now;
		} else if (t.boardAt != null) {
			t.boardFirst.n++;
			t.boardFirst.sum += now - t.boardAt;
			t.boardAt = null;
		}
	}

	_afterChange(now) {
		const m = this.match;
		if (m.roundOver && !this._roundLogged) {
			this._roundLogged = true;
			this.report.rounds.push({ round: m.round, winner: m.roundOver.winner, by: m.roundOver.by, ms: now - (m.roundStartAt ?? now), boards: m.sides.map((s) => s.boardIndex + 1), hearts: m.sides.map((s) => s.econ.hearts), frozenOut: m.sides.map((s) => s.econ.stats.frozenOut || 0) });
			this.next = [false, false];
			this.vote = null;
			if (this.rlog) this.rlog.end = { winner: m.roundOver.winner, by: m.roundOver.by, score: [...m.score], at: now };
			this._flushRound();
			if (m.over) {
				// The match is concluded: record it now, not when someone presses a button.
				this.report.endedAt = now;
				this.report.result = 'finished';
				this._sendReport(now);
				this._roomAll();
			} else {
				const prev = { winner: m.roundOver.winner, by: m.roundOver.by, score: [...m.score] };
				this._newRound(now, false, RESULT_MS + COUNTDOWN_MS, prev);
			}
		}
	}

	/** One report per match, keyed by its start: sending again (an abandoned match resumed and finished) replaces it. */
	_sendReport(now) {
		if (!this.report) return;
		if (this.rlog && !this.rlog.end) this._flushRound(true); // abandoned: keep the round so far
		this.io.report(this._report(now));
	}

	/** After a match: either player can take the room back to the lobby. Rounds advance by themselves. */
	_next(i, now) {
		const m = this.match;
		if (!m || !m.roundOver) return;
		this.next[i] = true;
		if (m.over) {
			this.phase = 'lobby';
			this.match = null;
			for (const s of this.seats) s.ready = false;
			this._roomAll();
			return;
		}
	}

	_newRound(now, remake, delayMs = COUNTDOWN_MS, prev = null) {
		const m = this.match;
		if (this.rlog && !this.rlog.end) this._flushRound(true); // a remake ends a round early
		m.newRound();
		m.startClock(now, delayMs);
		this._roundLogged = false;
		this.next = [false, false];
		this.vote = null;
		for (const s of this.seats) {
			s.goneRound = 0;
			if (s.left != null) m.freezeSide(this._seatOf(s.id), now);
		}
		this._openRound(now);
		this.n++;
		const rules = rulesFor(this.o).rules;
		for (const s of this.seats) this._to(s.id, { t: 'round', n: this.n, st: m.toState(), rules, remake, ls: s.lastS || 0, startAt: m.roundStartAt, prev });
		this._roomAll();
	}

	// —— remake vote ——
	_vote(i, yes, now) {
		if (!this.vote) return;
		this.vote.yes[i] = yes;
		this.report.votes.push({ at: now, seat: i, yes });
		if (this.vote.yes.some((v) => v === false)) this.vote = null;
		else if (this.vote.yes.every((v) => v === true)) return this._newRound(now, true);
		this._roomAll();
	}
	_expireVote(now) {
		if (this.vote && now > this.vote.until) {
			this.vote = null;
			this._roomAll();
		}
	}

	_report(now) {
		return {
			...this.report,
			key: `${this.report.startedAt}:${this.code}`,
			result: this.report.result || 'abandoned',
			at: now,
			score: this.match ? [...this.match.score] : this.report?.score,
			seats: this.seats.map((s) => {
				const t = s.timing;
				const mean = t && t.n ? t.sum / t.n : null;
				return {
					name: s.name,
					tester: testerCode(s.id), // the playtester code shown on the player's home screen
					dev: s.dev,
					tele: s.tele,
					reconnects: s.reconnects,
					disconnectedMs: s.gone,
					moves: t ? { n: t.n, meanMs: mean && Math.round(mean), sdMs: t && t.n > 1 ? Math.round(Math.sqrt(Math.max(0, t.sumSq / t.n - mean * mean))) : null, minMs: t?.min, firstMoveOnBoardMs: t && t.boardFirst.n ? Math.round(t.boardFirst.sum / t.boardFirst.n) : null } : null
				};
			})
		};
	}
}
