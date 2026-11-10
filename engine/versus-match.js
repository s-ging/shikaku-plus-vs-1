// versus-match.js — the Shikaku+ VS match. Each board ticks on its OWN player's moves,
// so incoming mines land when you move (Tetris garbage) and you can always stop
// and plan. Faster players simply attack more often.
import { Rect } from './puzzle.js';
import { commit, isSolved } from './game.js';
import { rectCellsOf, edgeCellsOf, coveredSet, unplacedGivens } from './economy.js';
import { vsBoard, ReplayBot } from './match.js';
import { VERSUS_RULES, VersusPlayer } from './versus.js';

export class VersusSide {
	constructor(name, rules, seed) {
		this.name = name;
		this.econ = new VersusPlayer(rules, seed);
		this.boardIndex = 0;
		this.cleared = 0;
		this.puzzle = null;
		this.rects = [];
		this.regionOf = null;
	}
	get N() {
		return this.puzzle.nums.length;
	}
	board() {
		return { N: this.N, nums: this.puzzle.nums, rects: this.rects };
	}
	iceCells() {
		return this.econ.iceSet();
	}
	/** Engine seam: refuse rects over ice. */
	isRectBlocked(rc) {
		const ice = this.iceCells();
		return rectCellsOf(rc, this.N).some((c) => ice.has(c));
	}
	/** Cells hazards may use: uncovered and never a clue. */
	landable() {
		const cov = coveredSet(this.board());
		const out = [];
		for (let y = 0; y < this.N; y++)
			for (let x = 0; x < this.N; x++) {
				const i = y * this.N + x;
				if (!cov.has(i) && !this.puzzle.nums[y][x]) out.push(i);
			}
		return out;
	}
	deal(puzzle) {
		this.puzzle = puzzle;
		this.rects = [];
		this.regionOf = new Array(puzzle.nums.length ** 2);
		puzzle.layout.forEach((r, idx) => {
			for (const c of rectCellsOf(r, this.N)) this.regionOf[c] = idx;
		});
	}
}

// Boards are regenerated from (roundSeed, index); cache them so restoring a snapshot is cheap.
const BOARD_CACHE = new Map();
function cachedBoard(roundSeed, index, cap = 0) {
	const k = roundSeed + ':' + index + (cap ? ':' + cap : '');
	let b = BOARD_CACHE.get(k);
	if (!b) {
		b = cap ? vsBoard(roundSeed, index, cap) : vsBoard(roundSeed, index);
		BOARD_CACHE.set(k, b);
		if (BOARD_CACHE.size > 64) BOARD_CACHE.delete(BOARD_CACHE.keys().next().value);
	}
	return b;
}
const ECON_SKIP = new Set(['rules', 'rng', 'seed']);

export class VersusMatch {
	/**
	 * Compact, JSON-safe snapshot of the whole match: what the server sends so clients
	 * can snap to the truth. Boards aren't sent; they're regenerated from their seed.
	 */
	toState() {
		return {
			v: 1,
			seed: this.seed,
			target: this.target,
			score: [...this.score],
			round: this.round,
			roundSeed: this.roundSeed,
			over: this.over,
			roundOver: this.roundOver,
			leadChanges: this.leadChanges,
			lead: this._lead,
			clock: this.clock ?? null,
			roundStartAt: this.roundStartAt ?? null,
			sides: this.sides.map((s) => {
				const econ = {};
				for (const [k, v] of Object.entries(s.econ)) if (!ECON_SKIP.has(k)) econ[k] = v;
				return {
					name: s.name,
					boardIndex: s.boardIndex,
					cleared: s.cleared,
					rects: s.rects.map((r) => [r.x1, r.y1, r.x2, r.y2]),
					gAt: s.gAt ?? null,
					frozenAt: s.frozenAt ?? null,
					pausedUntil: s.pausedUntil ?? 0,
					...(s.rushCap ? { rc: s.rushCap } : {}),
					rng: s.econ.rng.s,
					econ: JSON.parse(JSON.stringify(econ))
				};
			})
		};
	}
	static fromState(st, rules = VERSUS_RULES) {
		const m = Object.create(VersusMatch.prototype);
		m.rules = rules;
		m.seed = st.seed;
		m.target = st.target;
		m.score = [...st.score];
		m.round = st.round;
		m.roundSeed = st.roundSeed;
		m.over = st.over;
		m.roundOver = st.roundOver;
		m.leadChanges = st.leadChanges;
		m._lead = st.lead;
		m.clock = st.clock ?? undefined;
		m.roundStartAt = st.roundStartAt ?? undefined;
		m.sides = st.sides.map((ss, i) => {
			const s = new VersusSide(ss.name, rules, 1);
			Object.assign(s.econ, JSON.parse(JSON.stringify(ss.econ)));
			s.econ.rng.s = ss.rng;
			// Rooms saved by an older engine lack newer fields: default them so they keep playing.
			if (!Array.isArray(s.econ._clutch)) s.econ._clutch = [];
			if (typeof s.econ.combo !== 'number') s.econ.combo = 0;
			if (typeof s.econ.armed !== 'number') s.econ.armed = 0;
			s.boardIndex = ss.boardIndex;
			s.cleared = ss.cleared;
			s.rushCap = ss.rc || 0;
			s.deal(cachedBoard(st.roundSeed, ss.boardIndex, s.rushCap));
			s.rects = ss.rects.map(([a, b, c, d]) => Object.assign(new Rect(a, b, c, d), { valid: true }));
			s.gAt = ss.gAt ?? undefined;
			s.frozenAt = ss.frozenAt;
			s.pausedUntil = ss.pausedUntil;
			return s;
		});
		return m;
	}

	constructor({ rules = VERSUS_RULES, seed = 1, target = 7 } = {}) {
		this.rules = rules;
		this.seed = seed;
		this.target = target;
		this.score = [0, 0];
		this.round = 0;
		this.over = false;
		this.newRound();
	}

	newRound() {
		this.round++;
		this.roundSeed = this.seed * 1000 + this.round;
		this.sides = [
			new VersusSide('you', this.rules, this.roundSeed * 3 + 1),
			new VersusSide('them', this.rules, this.roundSeed * 3 + 2)
		];
		for (const s of this.sides) {
			s.rushCap = 0;
			s.deal(cachedBoard(this.roundSeed, 0));
		}
		this.roundOver = null;
		this.leadChanges = 0;
		this._lead = 0;
	}

	/** Average moves made by both players this round. */
	get moves() {
		return (this.sides[0].econ.ticks + this.sides[1].econ.ticks) / 2;
	}
	get rush() {
		return this.rushFactor > 1;
	}
	/** What every Mine attack is multiplied by right now: 1, the ramp's first step, or the full Rush. */
	get rushFactor() {
		const r = this.rules;
		if (r.rushAfterSecs && this.clock != null && this.roundStartAt != null) {
			const ms = this.clock - this.roundStartAt;
			if (ms >= r.rushAfterSecs * 1000) return r.rushMultiplier;
			if (r.rushEarlySecs && r.rushEarlyMultiplier > 1 && ms >= r.rushEarlySecs * 1000) return r.rushEarlyMultiplier;
			return 1;
		}
		return r.rushAfter && this.moves >= r.rushAfter ? r.rushMultiplier : 1;
	}

	/**
	 * Real-time clock (online play). Sets the match clock and pays each side the gravity
	 * ticks it owes since its anchor. Lazy: call it whenever anything happens; nothing runs
	 * in between. A frozen side (disconnected) owes nothing while frozen.
	 */
	/**
	 * delayMs: the round starts that much later (the 3-2-1 countdown, 2026-11-05). Until then
	 * both boards refuse moves (pausedUntil) and gravity owes nothing, so both players start even.
	 */
	startClock(now, delayMs = 0) {
		const at = now + delayMs;
		this.clock = now;
		this.roundStartAt = at;
		for (const s of this.sides) {
			s.gAt = at;
			s.frozenAt = null;
			if (delayMs) s.pausedUntil = at;
		}
	}
	/**
	 * only (optional): pay just that side. The server pays the OTHER seat's gravity a little
	 * late (so a move made just before a tick, still on its way, can reset it) and the sender's
	 * up to its own message: a seat's own messages arrive in order. Ticks are owed up to `now`,
	 * never past it, so two horizons can coexist; both sides of the wire replay the same calls.
	 */
	catchUp(now, only = null) {
		const out = [];
		if (now == null) return out;
		this.clock = Math.max(this.clock ?? now, now);
		const step = (this.rules.gravitySecs || 0) * 1000;
		if (!step || this.over || this.roundOver) return out;
		this.sides.forEach((s, i) => {
			if (only != null && i !== only) return;
			if (s.frozenAt != null || s.gAt == null) return;
			let owed = Math.floor((now - s.gAt) / step);
			while (owed-- > 0 && !this.roundOver) {
				s.gAt += step;
				const tag = (side, evs) => evs.forEach((e) => out.push({ side: side.name, ...e }));
				out.push({ side: s.name, kind: 'gravity' });
				this._tickSide(s, this.sides[1 - i], tag, out);
			}
		});
		return out;
	}
	freezeSide(i, now) {
		const s = this.sides[i];
		if (s.frozenAt == null) s.frozenAt = now;
	}
	thawSide(i, now) {
		const s = this.sides[i];
		if (s.frozenAt == null) return;
		if (s.gAt != null) s.gAt += now - s.frozenAt; // the gap never counts as gravity
		s.frozenAt = null;
	}

	_apply(side, action) {
		if (!action) return { moved: false, events: [] };
		const N = side.N;
		const state = { nums: side.puzzle.nums, rects: side.rects, N };
		if (action.type === 'erase') {
			const res = commit(action.x, action.y, action.x, action.y, state);
			return res.changed ? { moved: true, events: side.econ.onErase() } : { moved: false, events: [] };
		}
		if (side.isRectBlocked(new Rect(action.ax, action.ay, action.bx, action.by)))
			return { moved: false, events: [], denied: 'ice' };
		const before = side.rects.length;
		const res = commit(action.ax, action.ay, action.bx, action.by, state);
		if (!res.placed) return { moved: false, events: [], denied: 'invalid' };
		const rc = res.placed;
		const doOver = before - (side.rects.length - 1) > 0;
		return { moved: true, placed: rc, events: side.econ.onPlacement(rectCellsOf(rc, N), edgeCellsOf(rc, N), { doOver }) };
	}

	/** One move for side i: resolve it, then that side's clock ticks. */
	act(i, action, now) {
		if (this.over || this.roundOver) return { moved: false, events: [] };
		const s = this.sides[i];
		if (now != null && s.pausedUntil && now < s.pausedUntil) return { moved: false, events: [], denied: 'paused' };
		const opp = this.sides[1 - i];
		const out = [];
		const tag = (side, evs) => evs.forEach((e) => out.push({ side: side.name, ...e }));

		if (!action) return { moved: false, events: [] };
		const a = this._apply(s, action);
		if (!a.moved) return { moved: false, events: [], denied: a.denied };
		tag(s, a.events);
		// A move resets your gravity timer (Krischan, 2026-11-05, like Tetris lock delay): gravity
		// only ticks after gravitySecs with no move, never a hair after one. Owed ticks were paid
		// by catchUp(now) before this move, so the replay order stays exact.
		if (now != null && s.gAt != null && s.frozenAt == null) s.gAt = now;

		// Clear resolves before the tick, so its attack cancels incoming first.
		const cleared = isSolved(s.rects, s.N);
		if (cleared) {
			tag(s, s.econ.onBoardCleared());
			s.cleared++;
			s.boardIndex++;
			this._dealNext(s);
			s.econ.retargetIce(s.landable());
			if (s.econ.spill) {
				tag(s, s.econ.receiveIce(s.econ.spill, s.landable()));
				s.econ.spill = 0;
			}
			out.push({ side: s.name, kind: 'newBoard', index: s.boardIndex });
		}
		tag(s, s.econ.settleFrost(unplacedGivens(s.board()).length, cleared));
		this._route(s, opp, out);
		this._tickSide(s, opp, tag, out);
		return { moved: true, events: out, placed: a.placed };
	}

	/**
	 * Deal side s its next Board. From the first Rush step on, a Board has at most rushMaxGivens Givens
	 * (Krischan, 2026-11-09): fewer regions leave fewer Mine landings that no sequence of moves can answer.
	 * The Board is still a pure function of (roundSeed, index, cap); the cap is kept on the side so a snapshot
	 * rebuilds the same Board. Off (0/absent) for rules recorded before this existed, so old replays hold.
	 */
	_dealNext(s) {
		s.rushCap = this.rules.rushMaxGivens && this.rushFactor > 1 ? this.rules.rushMaxGivens : 0;
		s.deal(cachedBoard(this.roundSeed, s.boardIndex, s.rushCap));
	}

	/** What side i's clear would send right now (base, counter-spike, rush). */
	attackPreview(i) {
		const s = this.sides[i];
		const r = this.rules;
		const base = r.clearSend * this.rushFactor;
		const cancel = r.counterSpike === true && (r.counterRate ?? 1) > 0 ? Math.min(s.econ.bank, r.counterCap) : 0;
		return { send: base + Math.floor(cancel * (r.counterRate ?? 1)), counter: cancel };
	}

	/** One clock step for side i without a move: the idle tick that stops stalling. */
	idleTick(i) {
		if (this.over || this.roundOver) return { events: [] };
		const s = this.sides[i];
		const out = [{ side: s.name, kind: 'idleTick' }];
		const tag = (side, evs) => evs.forEach((e) => out.push({ side: side.name, ...e }));
		this._tickSide(s, this.sides[1 - i], tag, out);
		return { events: out };
	}

	_tickSide(s, opp, tag, out) {
		const evs = s.econ.tick(s.landable(), this.rules.spreadLanding || this.rules.mineCluster ? s.regionOf : null);
		tag(s, evs);
		for (const e of evs) if (e.kind === 'mineExplode') tag(s, this._explode(s, e.cell));
		if (this.rules.freezeOver === 'loseBoard' && s.econ.ice.length >= this.rules.freezeOverAt && !s.econ.isKO) {
			tag(s, s.econ.loseBoard());
			s.boardIndex++;
			this._dealNext(s);
			s.econ.retargetIce(s.landable());
			s.pausedUntil = (this.clock ?? 0) + this.rules.frozenPauseMs;
			out.push({ side: s.name, kind: 'newBoard', index: s.boardIndex, frozen: true });
		}
		this._icebreak(s, tag);
		this._route(s, opp, out);
		this._trackLead();
		this._checkKO(out);
	}

	_icebreak(s, tag) {
		tag(s, s.econ.checkStuckAndForceBreak(s.board(), unplacedGivens(s.board()).length));
	}

	_route(s, opp, out) {
		const { mines, ice } = s.econ.drainOut();
		if (mines) {
			const x = this.rushFactor;
			const n = mines * x;
			let cancelled = 0;
			let pass;
			if (this.rules.counterSpike === 'net') {
				// Net cancel: the attack is spent on Mines coming at you first (red batch first when
				// cancelOrder says so), up to counterCap; only the rest goes out.
				cancelled = s.econ.cancelAny(Math.min(n, this.rules.counterCap));
				pass = n - cancelled;
			} else if (this.rules.counterSpike === 'refund') {
				// Net-cancel, plus a refund: your attack cancels first, the rest goes out,
				// and a share of what you cancelled is added back on top.
				cancelled = s.econ.cancelIncoming(Math.min(n, this.rules.counterCap));
				pass = n - cancelled + Math.floor(cancelled * (this.rules.counterRate ?? 1));
			} else if (this.rules.counterSpike) {
				// Counter-spike: cancel from your orange bank, then send it all back on top.
				cancelled = this.rules.cancelOrder === 'redFirst' ? s.econ.cancelNearest(this.rules.counterCap) : s.econ.cancelIncoming(this.rules.counterCap);
				pass = n + Math.floor(cancelled * (this.rules.counterRate ?? 1));
			} else {
				cancelled = this.rules.overflow === 'netCancel' ? s.econ.cancelIncoming(n) : 0;
				pass = n - cancelled;
			}
			if (pass) opp.econ.receiveMines(pass).forEach((e) => out.push({ side: opp.name, ...e }));
			out.push({ side: s.name, kind: 'send', count: n, cancelled, pass, counter: !!this.rules.counterSpike && this.rules.counterSpike !== 'net' && cancelled > 0 && (this.rules.counterRate ?? 1) > 0, rush: x > 1, rushX: x });
		}
		if (ice) {
			opp.econ.receiveIce(ice, opp.landable()).forEach((e) => out.push({ side: opp.name, ...e }));
			out.push({ side: s.name, kind: 'sendIce', count: ice });
		}
	}

	_explode(side, cell) {
		const N = side.N;
		const cx = cell % N;
		const cy = Math.floor(cell / N);
		const r = this.rules.blastRadius;
		const hit = side.rects.filter((rc) => rc.x1 <= cx + r && rc.x2 >= cx - r && rc.y1 <= cy + r && rc.y2 >= cy - r);
		side.rects = side.rects.filter((rc) => !hit.includes(rc));
		return hit.length ? [{ kind: 'rectsBlown', cell, count: hit.length }] : [];
	}

	/** Danger 0..1: the larger of hearts lost and ice toward freeze-over. */
	danger(i) {
		const e = this.sides[i].econ;
		const r = this.rules;
		return Math.max((r.hearts - e.hearts) / r.hearts, e.ice.length / r.freezeOverAt);
	}

	/** Lead = who is in less danger; counts every time it flips. */
	_trackLead() {
		const d = this.danger(1) - this.danger(0);
		const lead = Math.abs(d) < 0.2 ? 0 : Math.sign(d);
		if (lead !== 0 && this._lead !== 0 && lead !== this._lead) this.leadChanges++;
		if (lead !== 0) this._lead = lead;
	}

	_checkKO(out) {
		if (this.roundOver) return;
		const ko = this.sides.map((s) => s.econ.isKO);
		if (!ko[0] && !ko[1]) return;
		const winner = ko[0] && ko[1] ? null : ko[0] ? 1 : 0;
		const loser = this.sides[winner === 0 ? 1 : 0].econ;
		if (winner !== null) this.score[winner]++;
		this.roundOver = { winner, by: loser.hearts <= 0 ? 'mines' : 'ice' };
		if (this.score.some((x) => x >= this.target)) this.over = true;
		out.push({ side: 'match', kind: 'roundOver', winner, by: this.roundOver.by, score: [...this.score] });
	}
}

/** Replay bot that tilts: mistakes climb with live mines and lost hearts. */
export class TiltBot extends ReplayBot {
	constructor(opts = {}) {
		super({ idle: 0, ...opts });
		this.baseMisplay = opts.misplay ?? 0.12;
		this.tiltPerMine = opts.tiltPerMine ?? 0.04;
		this.tiltPerHeart = opts.tiltPerHeart ?? 0.06;
		this.counterHold = opts.counterHold ?? 0; // waits this many turns on its last box to grow a counter-spike
		this._holdBoard = -1;
		this._holdLeft = 0;
	}
	decide(side) {
		const e = side.econ;
		// Counter timing: on the last box, with mines banked and nothing about to land,
		// wait a little so the bank grows, then clear into a bigger counter-spike.
		if (this.counterHold) {
			if (this._holdBoard !== side.boardIndex) {
				this._holdBoard = side.boardIndex;
				this._holdLeft = this.counterHold;
			}
			const placed = new Set(side.rects.map((r) => `${r.x1},${r.y1},${r.x2},${r.y2}`));
			const left = side.puzzle.layout.filter((r) => !placed.has(`${r.x1},${r.y1},${r.x2},${r.y2}`)).length;
			if (left === 1 && e.bank >= 4 && e.nextBatch === 0 && e.mines.length === 0 && this._holdLeft > 0) {
				this._holdLeft--;
				return null;
			}
		}
		this.misplay = Math.min(0.9, this.baseMisplay + this.tiltPerMine * e.mines.length + this.tiltPerHeart * (e.rules.hearts - e.hearts));
		return super.decide(side);
	}
}

/**
 * Bot presets. secs = average seconds per move (±40% jitter); read = extra
 * seconds before its first move on a fresh board (humans read the board first).
 * Every preset keeps a margin of error, Impossible included.
 */
export const BOT_PRESETS = {
	easy: { label: 'Easy', secs: 3.2, read: 4, misplay: 0.24, tiltPerMine: 0.06, tiltPerHeart: 0.08, defuseFirst: 0.35 },
	normal: { label: 'Normal', secs: 2.4, read: 3, misplay: 0.15, tiltPerMine: 0.05, tiltPerHeart: 0.07, defuseFirst: 0.55 },
	hard: { label: 'Hard', secs: 1.9, read: 2.2, misplay: 0.1, tiltPerMine: 0.04, tiltPerHeart: 0.05, defuseFirst: 0.7 },
	expert: { label: 'Expert', secs: 1.4, read: 1.5, misplay: 0.06, tiltPerMine: 0.03, tiltPerHeart: 0.04, defuseFirst: 0.85, counterHold: 1 },
	impossible: { label: 'Impossible', secs: 1.0, read: 0.9, misplay: 0.03, tiltPerMine: 0.015, tiltPerHeart: 0.02, defuseFirst: 0.97, counterHold: 2 },
	// Mirror: moves in lockstep with you (one move per your move, ~0.3s after), Expert-plus decisions.
	mirror: { label: 'Mirror', secs: 2.0, read: 1.2, misplay: 0.05, tiltPerMine: 0.03, tiltPerHeart: 0.03, defuseFirst: 0.9, counterHold: 1, mirror: true }
};
