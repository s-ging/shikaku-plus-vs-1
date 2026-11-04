// room-core.js — one room's logic, with no Cloudflare API in it, so it can be tested
// in plain Node. The Durable Object in index.js only adapts WebSockets and storage.
//
// Cost model (the optimization rule: put a number on it):
//   per move:   1 message in (~60 B), 1 message out to each seat (~80 B), one state
//               hash (~2 KB of string building), one storage write of the room (~6 KB).
//   idle room:  nothing runs. No timers, no alarms. Gravity is paid lazily from
//               timestamps when the next message arrives (VersusMatch.catchUp).
//   per match:  one report sent to the Reports object at the end.
import { VersusMatch } from '../engine/versus-match.js';
import { decodeAction, encodeAction, stateHash } from '../shared/protocol.js';
import { rulesFor, sanitize } from '../shared/settings.js';

const STALE_MS = 20000; // no ping or message this long = really gone (a phone that lost signal may never close its socket).
// Shorter hiccups never freeze anyone: the client keeps playing and its queued moves arrive when the line comes back.
const REMAKE_AFTER_MS = 10000; // a seat gone this long in one round may call a remake vote
const VOTE_MS = 20000;
const NAME_MAX = 16;

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
			_roundLogged: false
		});
		if (saved) Object.assign(this, saved);
		this.match = this.matchState ? VersusMatch.fromState(this.matchState, rulesFor(this.o).rules) : null;
	}

	// —— persistence ——
	_save() {
		this.matchState = this.match ? this.match.toState() : null;
		const { code, phase, seats, o, n, next, vote, report, matchState, _roundLogged } = this;
		this.io.save({ code, phase, seats, o, n, next, vote, report, matchState, _roundLogged });
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
		return { ...obj, n: this.n, h: stateHash(this.match) };
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
		this.match.catchUp(now);
		const gap = now - (seat.goneFrom ?? seat.left); // counted from when we last heard from them
		seat.gone += gap;
		seat.goneRound += gap;
		seat.left = null;
		seat.goneFrom = null;
		seat.connected = true;
		this.match.thawSide(i, now);
		this._all(this._seq({ t: 'th', i, at: now }), seat.id);
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
			this.match.catchUp(now);
			this.match.freezeSide(i, now);
			// Sent to the frozen seat too: if its socket was only quiet, it hears this and answers.
			this._all(this._seq({ t: 'fz', i, at: now }));
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
				this.match.catchUp(now);
				this._all(this._seq({ t: 'tk', at: now }));
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
		this.match.startClock(now);
		this.phase = 'match';
		this.next = [false, false];
		for (const s of this.seats) {
			s.goneRound = 0;
			s.timing = { n: 0, sum: 0, sumSq: 0, min: null, last: now, boardFirst: { n: 0, sum: 0 }, boardAt: now, board: 0 };
		}
		this.report = { code: this.code, startedAt: now, o: this.o, rounds: [], votes: [] };
		this.n++;
		for (const s of this.seats) this._to(s.id, { t: 'round', n: this.n, st: this.match.toState(), rules, ls: s.lastS || 0 });
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
		m.catchUp(now);
		const r = action && !m.roundOver ? m.act(i, action, now) : { moved: false, denied: 'bad' };
		if (!r.moved) {
			this._to(seat.id, { t: 'no', s: msg.s, why: r.denied || 'invalid' });
			// If the catch-up paid gravity ticks, keep everyone in step; otherwise send nothing more.
			if (m.sides.map((s) => s.econ.ticks).join() !== ticksBefore) this._all(this._seq({ t: 'tk', at: now }));
			this._afterChange(now);
			return;
		}
		this._time(i, now);
		const echo = this._seq({ t: 'mv', i, a: encodeAction(action), at: now });
		this._to(seat.id, { ...echo, s: msg.s });
		this._all(echo, seat.id);
		this._afterChange(now);
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
			this._roomAll();
		}
	}

	_next(i, now) {
		const m = this.match;
		if (!m || !m.roundOver) return;
		this.next[i] = true;
		if (!this.next.every(Boolean)) return;
		if (m.over) {
			this.phase = 'lobby';
			this.report.endedAt = now;
			this.report.score = [...m.score];
			this.io.report(this._report(now));
			this.match = null;
			for (const s of this.seats) s.ready = false;
			this._roomAll();
			return;
		}
		this._newRound(now, false);
	}

	_newRound(now, remake) {
		const m = this.match;
		m.newRound();
		m.startClock(now);
		this._roundLogged = false;
		this.next = [false, false];
		this.vote = null;
		for (const s of this.seats) {
			s.goneRound = 0;
			if (s.left != null) m.freezeSide(this._seatOf(s.id), now);
		}
		this.n++;
		const rules = rulesFor(this.o).rules;
		for (const s of this.seats) this._to(s.id, { t: 'round', n: this.n, st: m.toState(), rules, remake, ls: s.lastS || 0 });
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
			at: now,
			score: this.match ? [...this.match.score] : this.report?.score,
			seats: this.seats.map((s) => {
				const t = s.timing;
				const mean = t && t.n ? t.sum / t.n : null;
				return {
					name: s.name,
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
