// match.js — local VS match: turn loop, mine routing, explosions, clears, FT7.
// Wraps two PlayerEconomy instances around two real Shikaku boards.
import { generatePuzzle, Rect, Rng } from './puzzle.js';
import { commit, verifyRect, isSolved } from './game.js';
import {
	DEFAULT_RULES,
	PlayerEconomy,
	rectCellsOf,
	edgeCellsOf,
	freeCellsOf
} from './economy.js';

export const VS_GEN = { size: 6, maxAreaFrac: 0.32, maxGivens: 10 };

/**
 * Board `index` of a match's shared sequence. Classic generator untouched; VS
 * caps givens by retry (oddChance/oddDimLean: original algorithm lost — not yet reimplemented).
 */
export function vsBoard(seed, index) {
	for (let k = 0; ; k++) {
		const s = (seed * 7919 + index * 104729 + k * 15485863) % 2147483646;
		const p = generatePuzzle(VS_GEN.size, VS_GEN.maxAreaFrac, s);
		if (p.layout.length <= VS_GEN.maxGivens || k > 50) return { ...p, seed: s };
	}
}

const key = (r) => `${r.x1},${r.y1},${r.x2},${r.y2}`;

export class Side {
	constructor(name, rules, seed) {
		this.name = name;
		this.econ = new PlayerEconomy(rules, seed);
		this.boardIndex = 0;
		this.cleared = 0;
		this.puzzle = null;
		this.rects = [];
	}
	get N() {
		return this.puzzle.nums.length;
	}
	board() {
		return { N: this.N, nums: this.puzzle.nums, rects: this.rects };
	}
	iceCells() {
		return new Set(this.econ.frozen.map((f) => f.cell));
	}
	/** Engine seam: refuse rects over frozen cells. */
	isRectBlocked(rc) {
		const ice = this.iceCells();
		return rectCellsOf(rc, this.N).some((c) => ice.has(c));
	}
}

export class VsMatch {
	constructor({ rules = DEFAULT_RULES, seed = 1, target = 7 } = {}) {
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
			new Side('you', this.rules, this.roundSeed * 3 + 1),
			new Side('them', this.rules, this.roundSeed * 3 + 2)
		];
		for (const s of this.sides) this._deal(s);
		this.turn = 0;
		this.roundOver = null;
	}

	_deal(side) {
		side.puzzle = vsBoard(this.roundSeed, side.boardIndex);
		side.rects = [];
	}

	/**
	 * Apply one action for a side. Returns { ticks: boolean, events }.
	 * action: { type: 'place', ax, ay, bx, by } | { type: 'erase', x, y } | null
	 */
	_apply(side, action) {
		if (!action) return { ticks: false, events: [] };
		const N = side.N;
		const state = { nums: side.puzzle.nums, rects: side.rects, N };
		if (action.type === 'erase') {
			const res = commit(action.x, action.y, action.x, action.y, state);
			if (!res.changed) return { ticks: false, events: [] };
			return { ticks: true, events: side.econ.onErase() };
		}
		const probe = new Rect(action.ax, action.ay, action.bx, action.by);
		if (side.isRectBlocked(probe)) return { ticks: false, events: [], denied: 'ice' };
		const before = side.rects.length;
		const res = commit(action.ax, action.ay, action.bx, action.by, state);
		if (!res.placed) return { ticks: false, events: [], denied: 'invalid' };
		const removed = before - (side.rects.length - 1);
		const rc = res.placed;
		const events = side.econ.onPlacement(rectCellsOf(rc, N), edgeCellsOf(rc, N), {
			doOver: removed > 0
		});
		return { ticks: true, events, placed: rc };
	}

	/**
	 * Apply an action for side i right away (client-instant). Placement-side
	 * effects (defuse, active thaw, combo, clear, sends) resolve immediately.
	 * Returns { ticks, events, denied }.
	 */
	act(i, action) {
		if (this.over || this.roundOver) return { ticks: false, events: [] };
		const s = this.sides[i];
		const out = [];
		const tag = (evs) => evs.forEach((e) => out.push({ side: s.name, ...e }));
		const a = this._apply(s, action);
		if (!a.ticks) return { ticks: false, events: [], denied: a.denied };
		tag(a.events);
		tag(s.econ.checkStuckAndForceBreak(s.board()));
		this._resolveClear(s, out);
		this._route(out);
		this._checkRound(out);
		return { ticks: true, events: out, placed: a.placed };
	}

	/** Advance both economies one clock step. */
	tick() {
		if (this.over || this.roundOver) return { events: [] };
		const out = [];
		this.turn++;
		for (const s of this.sides) {
			const tag = (evs) => evs.forEach((e) => out.push({ side: s.name, ...e }));
			const evs = s.econ.tick(freeCellsOf(s.board()));
			tag(evs);
			for (const e of evs) if (e.kind === 'mineExplode') tag(this._explode(s, e.cell));
			tag(s.econ.checkStuckAndForceBreak(s.board()));
			this._resolveClear(s, out);
		}
		this._route(out);
		this._checkRound(out);
		return { events: out };
	}

	/**
	 * Per-placement clock (decision 4): your action, the opponent's action, then
	 * one tick. Only ticks if your action changed the board.
	 */
	step(youAction, themAction) {
		const a = this.act(0, youAction);
		if (!a.ticks) return { events: [], ticked: false, denied: a.denied };
		const themAct = typeof themAction === 'function' ? themAction(this) : themAction;
		const b = this.act(1, themAct);
		const t = this.tick();
		return { events: [...a.events, ...b.events, ...t.events], ticked: true, placed: a.placed };
	}

	/** Margin time: attack multiplier that grows once a round runs long. */
	get marginMultiplier() {
		const r = this.rules;
		if (!r.marginStart || this.turn < r.marginStart) return 1;
		return 1 + Math.floor((this.turn - r.marginStart) / r.marginEvery + 1) * r.marginStep;
	}

	_resolveClear(s, out) {
		if (!isSolved(s.rects, s.N)) return;
		s.econ.onBoardCleared().forEach((e) => out.push({ side: s.name, ...e }));
		s.cleared++;
		s.boardIndex++;
		this._deal(s);
		out.push({ side: s.name, kind: 'newBoard', index: s.boardIndex });
	}

	/** Route outgoing mines. Net-cancel: your sends cancel your own incoming first. */
	_route(out) {
		const mult = this.marginMultiplier;
		const sends = this.sides.map((s) => {
			const raw = s.econ.drainOutgoing();
			return raw ? Math.round(raw * mult) : 0;
		});
		this.sides.forEach((s, i) => {
			const n = sends[i];
			if (!n) return;
			const opp = this.sides[1 - i];
			const cancelled = this.rules.overflow === 'netCancel' ? s.econ.cancelIncoming(n) : 0;
			const pass = n - cancelled;
			if (pass) opp.econ.receiveMines(pass);
			out.push({ side: s.name, kind: 'send', count: n, cancelled, pass });
		});
	}

	/** §5: every rect touching the 3×3 blast is removed whole. Not a do-over. */
	_explode(side, cell) {
		const N = side.N;
		const cx = cell % N;
		const cy = Math.floor(cell / N);
		const r = this.rules.blastRadius;
		const blast = { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r };
		const hit = side.rects.filter(
			(rc) => rc.x1 <= blast.x2 && rc.x2 >= blast.x1 && rc.y1 <= blast.y2 && rc.y2 >= blast.y1
		);
		side.rects = side.rects.filter((rc) => !hit.includes(rc));
		return hit.length ? [{ kind: 'rectsBlown', cell, count: hit.length }] : [];
	}

	_checkRound(out) {
		const [you, them] = this.sides;
		const yl = you.econ.isDefeated;
		const tl = them.econ.isDefeated;
		if (!yl && !tl) return;
		let winner = null;
		if (yl && tl) {
			const d = you.econ.effectiveTemp - them.econ.effectiveTemp;
			winner = d > 0 ? 0 : d < 0 ? 1 : null;
		} else winner = yl ? 1 : 0;
		if (this.roundOver) return;
		if (winner !== null) this.score[winner]++;
		this.roundOver = { winner };
		if (this.score.some((s) => s >= this.target)) this.over = true;
		out.push({ side: 'match', kind: 'roundOver', winner, score: [...this.score] });
	}
}

// —— Replay bot (§: bot parked; this is the stand-in) ——
// Plays the generator's own solution, one move per turn, with tunable mistakes.
export class ReplayBot {
	constructor({ misplay = 0.15, idle = 0.25, defuseFirst = 0.7, seed = 99 } = {}) {
		this.misplay = misplay;
		this.idle = idle;
		this.defuseFirst = defuseFirst;
		this.rng = new Rng(seed);
	}
	_roll(p) {
		return this.rng.nextDouble() < p;
	}

	/** Decide an action for `side`. */
	decide(side) {
		if (this._roll(this.idle)) return null;
		const N = side.N;
		const nums = side.puzzle.nums;
		const sol = side.puzzle.layout;
		const solKeys = new Set(sol.map(key));
		const toAction = (rc) => ({ type: 'place', ax: rc.x1, ay: rc.y1, bx: rc.x2, by: rc.y2 });

		// Fix a known-wrong rect first (an overwrite = do-over).
		const wrong = side.rects.find((rc) => !solKeys.has(key(rc)));
		if (wrong) {
			const fix = sol.find((s) => s.overlaps(wrong) && !side.isRectBlocked(s));
			if (fix) return toAction(fix);
			return { type: 'erase', x: wrong.x1, y: wrong.y1 }; // fix blocked by ice: clear the way
		}

		const placed = new Set(side.rects.map(key));
		let todo = sol.filter((s) => !placed.has(key(s)) && !side.isRectBlocked(s));
		todo = todo.filter((s) => !side.rects.some((p) => p.overlaps(s)));
		if (!todo.length) {
			// Waiting on ice. A person would build next to it to thaw it: re-commit a
			// placed box beside the ice (a do-over, but it ticks and thaws).
			const ice = side.iceCells ? side.iceCells() : new Set();
			if (!side.rects.length) return null;
			const near = side.rects.find((rc) => {
				for (const c of ice) {
					const x = c % N;
					const y = Math.floor(c / N);
					if (x >= rc.x1 - 1 && x <= rc.x2 + 1 && y >= rc.y1 - 1 && y <= rc.y2 + 1 &&
						!(x < rc.x1 || x > rc.x2) !== !(y < rc.y1 || y > rc.y2)) return true;
				}
				return false;
			});
			return toAction(near ?? side.rects[this.rng.nextInt(side.rects.length)]);
		}

		// Prefer defusing the most urgent mine.
		let pick = null;
		if (side.econ.mines.length && this._roll(this.defuseFirst)) {
			const mines = [...side.econ.mines].sort((a, b) => a.fuse - b.fuse);
			for (const m of mines) {
				pick = todo.find((s) => s.has(m.cell % N, Math.floor(m.cell / N)));
				if (pick) break;
			}
		}
		pick ??= todo[this.rng.nextInt(todo.length)];

		// Misplay: a valid-but-wrong rect for the same clue, on empty cells.
		if (this._roll(this.misplay)) {
			const alt = this._alternative(pick, side, nums);
			if (alt) return toAction(alt);
		}
		return toAction(pick);
	}

	_alternative(target, side, nums) {
		const N = side.N;
		const area = target.area;
		let cx = -1,
			cy = -1;
		for (let y = target.y1; y <= target.y2; y++)
			for (let x = target.x1; x <= target.x2; x++) if (nums[y][x]) [cx, cy] = [x, y];
		const opts = [];
		for (let w = 1; w <= area; w++) {
			if (area % w) continue;
			const h = area / w;
			for (let x1 = cx - w + 1; x1 <= cx; x1++)
				for (let y1 = cy - h + 1; y1 <= cy; y1++) {
					if (x1 < 0 || y1 < 0 || x1 + w > N || y1 + h > N) continue;
					const r = new Rect(x1, y1, x1 + w - 1, y1 + h - 1);
					if (key(r) === key(target) || !verifyRect(r, nums)) continue;
					if (side.isRectBlocked(r) || side.rects.some((p) => p.overlaps(r))) continue;
					opts.push(r);
				}
		}
		return opts.length ? opts[this.rng.nextInt(opts.length)] : null;
	}
}
