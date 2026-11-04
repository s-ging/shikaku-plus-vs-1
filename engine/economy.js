// economy.js — Shikaku+ VS economy. The "brain".
//
// Import-free on purpose: this same file is meant to run in the prototype, in a
// Cloudflare Durable Object (authoritative server), and be translated
// line-for-line into vs_economy.dart for the Flutter client.
//
// Every mutation returns a list of events: { kind, ...data }. The UI and the
// network layer react to events; nothing here touches rendering or the board.
//
// Cells are integer indices: i = y * N + x.
// Spec: vs_handoff.md (Project doc). Section refs below point there.

export const DEFAULT_RULES = {
	boardN: 6,

	// §4 Temperature
	tempMin: -100,
	tempMax: 100,
	tempStart: 0,
	freezeThreshold: -25,
	deepColdThreshold: -50,
	mineLandTemp: -7.5,
	mineDefuseTemp: 5,
	mineExplodeTemp: -10,
	passiveThawReward: 15,
	activeThawReward: 25,
	forceBreakReward: 30,
	clearReward: 15,
	decayAmount: 1,
	decayEvery: 2,

	// §5 Mines
	mineFuse: 3,
	activeMineCap: 4,
	mineStagger: 2,
	mineEta: 3,
	mineBatch: 4,
	blastRadius: 1, // 3×3

	// §5.1 Surge (two open questions are toggles)
	surgeAbsorptionCap: 3,
	surgeUsesStagger: false, // false: surge discharge ignores the 2/turn stagger
	zeroBankOnClear: true, // true: surge bank is wiped when you clear a board

	// §6 Frozen cells
	warnSteps: 3,
	freezeStagger: 2,
	thawPoints: 4,
	passiveThawAmount: 1,
	passiveThawEvery: 2,
	activeThaw: 2,
	comboThaw: 2,
	perPlacementThawCap: 2,
	maxWarnings: 1,
	maxWarningsDeep: 2,

	// §8 Attack
	clearSendBase: 4,
	perfectBonusCap: 4, // 4 + 4 = 8 max per clear
	defusesPerSend: 2,
	forceBreakSend: 2,
	comboMilestone: 6,
	comboSend: 1,
	comboDecayPause: 2,
	overflow: 'netCancel', // 'netCancel' | 'passthrough'
	// Margin time (not in spec; anti-stalemate experiment, off by default).
	// After marginStart ticks, sends are multiplied by 1 + marginStep per marginEvery ticks.
	marginStart: 0,
	marginEvery: 10,
	marginStep: 0.25,

	// §7 Solver
	solverBudget: 20000
};

// —— Tiny deterministic RNG (Park–Miller, same constants as puzzle.js). ——
// Redeclared here so this module stays import-free.
export class EconRng {
	constructor(seed) {
		const m = 2147483647;
		const s = ((seed % m) + m) % m;
		this.s = s <= 0 ? 1 : s;
	}
	nextInt(bound) {
		if (bound <= 1) return 0;
		const hi = Math.floor(this.s / 44488);
		const lo = this.s % 44488;
		this.s = 48271 * lo - 3399 * hi;
		if (this.s < 0) this.s += 2147483647;
		return this.s % bound;
	}
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class PlayerEconomy {
	constructor(rules = DEFAULT_RULES, seed = 1) {
		this.rules = rules;
		this.seed = seed;
		this.reset();
	}

	reset() {
		const r = this.rules;
		this.rng = new EconRng(this.seed);
		this.temp = r.tempStart;
		this.turn = 0;

		// Frozen cells: { cell, thaw, seq, landedTurn }
		this.frozen = [];
		this.freezeQueue = []; // warning countdowns, e.g. [3, 1]
		this.turnsSinceFreezeSpawn = r.freezeStagger; // first warning can queue at once
		this._frozenSeq = 0;

		// Mines: pending (unbatched) → queue (batches w/ eta) → board → explode/defuse
		this.pendingMines = 0;
		this.mineQueue = []; // [{ count, eta }]
		this.mines = []; // [{ cell, fuse }]
		this.bank = 0; // surge overflow
		this._staggerLeft = r.mineStagger;

		this.defuses = 0;
		this.combo = 0;
		this.perfectStreak = 0;
		this.doOversThisBoard = 0;
		this.pendingMinesToSend = 0;
		this.pendingBonusMines = 0;

		this._decayAcc = 0;
		this.decayPause = 0;
		this._thawAcc = 0;
	}

	// —— Getters (§4) ——
	get floor() {
		return this.frozen.length ? this.rules.freezeThreshold * this.frozen.length : null;
	}
	get effectiveTemp() {
		return this.frozen.length ? Math.min(this.temp, this.floor) : this.temp;
	}
	/** Freeze spawning reads RAW temp (prevents the spiral). */
	get isFreezing() {
		return this.temp <= this.rules.freezeThreshold;
	}
	get isDefeated() {
		return this.effectiveTemp <= this.rules.tempMin;
	}
	/** Promise bar: only when raw sits above the floor. */
	get showPromise() {
		return this.frozen.length > 0 && this.temp > this.floor;
	}
	/** Everything still coming at you (for the queue UI and net-cancel). */
	get incomingTotal() {
		return this.pendingMines + this.mineQueue.reduce((a, b) => a + b.count, 0);
	}

	_occupied() {
		const s = new Set();
		for (const m of this.mines) s.add(m.cell);
		for (const f of this.frozen) s.add(f.cell);
		return s;
	}
	_addTemp(d) {
		this.temp = clamp(this.temp + d, this.rules.tempMin, this.rules.tempMax);
	}
	_pickFree(freeCells) {
		const occ = this._occupied();
		const pool = freeCells.filter((c) => !occ.has(c));
		if (!pool.length) return -1;
		return pool[this.rng.nextInt(pool.length)];
	}

	// —— Incoming / outgoing (§8) ——
	receiveMines(count) {
		if (count > 0) this.pendingMines += count;
		return [];
	}

	/** Net-cancel: remove from pending first, then batches from the back. Never landed mines. */
	cancelIncoming(count) {
		let left = count;
		const fromPending = Math.min(left, this.pendingMines);
		this.pendingMines -= fromPending;
		left -= fromPending;
		for (let i = this.mineQueue.length - 1; i >= 0 && left > 0; i--) {
			const take = Math.min(left, this.mineQueue[i].count);
			this.mineQueue[i].count -= take;
			left -= take;
			if (this.mineQueue[i].count === 0) this.mineQueue.splice(i, 1);
		}
		return count - left;
	}

	drainOutgoing() {
		const n = this.pendingMinesToSend + this.pendingBonusMines;
		this.pendingMinesToSend = 0;
		this.pendingBonusMines = 0;
		return n;
	}

	// —— Player actions ——

	/**
	 * A rect was committed.
	 * @param {number[]} rectCells cells covered by the new rect
	 * @param {number[]} edgeCells cells sharing an edge with the rect (outside it)
	 * @param {{ doOver?: boolean }} opts doOver = the placement overwrote other rects
	 */
	onPlacement(rectCells, edgeCells, { doOver = false } = {}) {
		const r = this.rules;
		const ev = [];
		const spent = new Map(); // per-cell thaw spent this placement (cap §6)

		// Combo / do-over (§8)
		if (doOver) {
			this.doOversThisBoard++;
			if (this.combo) ev.push({ kind: 'comboReset', combo: this.combo });
			this.combo = 0;
		} else {
			this.combo++;
			ev.push({ kind: 'combo', combo: this.combo });
		}

		// Defuse (§5): a committed rect covers the mine
		const covered = new Set(rectCells);
		for (let i = this.mines.length - 1; i >= 0; i--) {
			const m = this.mines[i];
			if (!covered.has(m.cell)) continue;
			this.mines.splice(i, 1);
			this._addTemp(r.mineDefuseTemp);
			this.defuses++;
			const sends = this.defuses % r.defusesPerSend === 0;
			if (sends) this.pendingBonusMines += 1;
			ev.push({ kind: 'defuse', cell: m.cell, sends });
		}

		// Active thaw (§6): frozen cells sharing an edge with the rect
		const edge = new Set(edgeCells);
		for (const f of [...this.frozen]) {
			if (edge.has(f.cell)) this._thaw(f, r.activeThaw, 'active', spent, ev);
		}

		// Combo milestone (§8)
		if (!doOver && this.combo > 0 && this.combo % r.comboMilestone === 0) {
			this.pendingBonusMines += r.comboSend;
			this.decayPause = r.comboDecayPause;
			ev.push({ kind: 'comboAttack', combo: this.combo });
			const target = this._nearestToThaw(this.frozen);
			if (target) this._thaw(target, r.comboThaw, 'combo', spent, ev);
		}
		return ev;
	}

	/** A rect was erased by the player (tap). Erases tick; combo resets. */
	onErase() {
		const ev = [];
		this.doOversThisBoard++;
		if (this.combo) ev.push({ kind: 'comboReset', combo: this.combo });
		this.combo = 0;
		return ev;
	}

	_thaw(f, amount, source, spent, ev) {
		const r = this.rules;
		const used = spent.get(f.cell) ?? 0;
		const amt = Math.min(amount, r.perPlacementThawCap - used);
		if (amt <= 0) return;
		spent.set(f.cell, used + amt);
		f.thaw -= amt;
		if (f.thaw <= 0) {
			this.frozen.splice(this.frozen.indexOf(f), 1);
			this._addTemp(r.activeThawReward);
			ev.push({ kind: 'thaw', cell: f.cell, source });
		} else {
			ev.push({ kind: source === 'combo' ? 'comboThaw' : 'thawPulse', cell: f.cell, thaw: f.thaw });
		}
	}

	_nearestToThaw(cells) {
		if (!cells.length) return null;
		const min = Math.min(...cells.map((f) => f.thaw));
		const atMin = cells.filter((f) => f.thaw === min);
		const oldest = Math.min(...atMin.map((f) => f.seq));
		const ties = atMin.filter((f) => f.seq === oldest);
		return ties[this.rng.nextInt(ties.length)];
	}

	// —— The clock (§3: one tick per turn) ——

	/** @param {number[]} freeCells uncovered cells on this player's board */
	tick(freeCells) {
		const r = this.rules;
		const ev = [];
		this.turn++;
		this._staggerLeft = r.mineStagger;
		const bankBefore = this.bank; // surge only discharges what was banked before this tick

		// 1) Passive decay (paused after a combo milestone)
		if (this.decayPause > 0) this.decayPause--;
		else if (++this._decayAcc >= r.decayEvery) {
			this._decayAcc = 0;
			this._addTemp(-r.decayAmount);
		}

		// 2) Fuses. Mines landing later this tick are untouched.
		for (const m of [...this.mines]) {
			m.fuse--;
			if (m.fuse === 1) ev.push({ kind: 'mineFuseFinal', cell: m.cell });
			if (m.fuse <= 0) {
				this.mines.splice(this.mines.indexOf(m), 1);
				this._addTemp(r.mineExplodeTemp);
				ev.push({ kind: 'mineExplode', cell: m.cell });
			}
		}

		// 3) Incoming batches
		if (this.mineQueue.length) {
			const front = this.mineQueue[0];
			front.eta--;
			if (front.eta <= 0) {
				this.mineQueue.shift();
				this.bank += this._landMines(front.count, freeCells, true, ev);
			}
		}
		if (!this.mineQueue.length && this.pendingMines > 0) {
			const c = Math.min(r.mineBatch, this.pendingMines);
			this.pendingMines -= c;
			this.mineQueue.push({ count: c, eta: r.mineEta });
			ev.push({ kind: 'mineEnqueued', count: c, eta: r.mineEta });
		}

		// 4) Surge discharge (§5.1). Only what was banked before this tick.
		if (bankBefore > 0) {
			const release = Math.min(bankBefore, r.surgeAbsorptionCap);
			this.bank -= release;
			const surgeEv = [];
			const left = this._landMines(release, freeCells, r.surgeUsesStagger, surgeEv);
			this.bank += left;
			if (release - left > 0) ev.push({ kind: 'surge', count: release - left }, ...surgeEv);
		}

		// 5) Freeze (reads RAW temp)
		if (!this.isFreezing) {
			if (this.freezeQueue.length) ev.push({ kind: 'freezeAbandon', count: this.freezeQueue.length });
			this.freezeQueue = [];
			this.turnsSinceFreezeSpawn++;
		} else {
			let landed = false;
			this.freezeQueue = this.freezeQueue.map((w) => w - 1);
			for (let i = 0; i < this.freezeQueue.length; i++) {
				if (this.freezeQueue[i] > 0) continue;
				const cell = this._pickFree(freeCells);
				if (cell < 0) {
					this.freezeQueue[i] = 0; // no room: retry next tick
					continue;
				}
				this.frozen.push({ cell, thaw: r.thawPoints, seq: this._frozenSeq++, landedTurn: this.turn });
				this.freezeQueue.splice(i--, 1);
				this.turnsSinceFreezeSpawn = 0; // stagger resets ONLY on landing
				landed = true;
				ev.push({ kind: 'frozen', cell });
			}
			if (!landed) this.turnsSinceFreezeSpawn++;
			const maxW = this.temp <= r.deepColdThreshold ? r.maxWarningsDeep : r.maxWarnings;
			if (this.turnsSinceFreezeSpawn >= r.freezeStagger && this.freezeQueue.length < maxW) {
				this.freezeQueue.push(r.warnSteps);
				ev.push({ kind: 'freezeWarn', steps: r.warnSteps });
			}
		}

		// 6) Passive thaw (skips cells that landed this tick)
		if (++this._thawAcc >= r.passiveThawEvery) {
			this._thawAcc = 0;
			for (const f of [...this.frozen]) {
				if (f.landedTurn === this.turn) continue;
				f.thaw -= r.passiveThawAmount;
				if (f.thaw <= 0) {
					this.frozen.splice(this.frozen.indexOf(f), 1);
					this._addTemp(r.passiveThawReward);
					ev.push({ kind: 'thaw', cell: f.cell, source: 'passive' });
				} else ev.push({ kind: 'thawPulse', cell: f.cell, thaw: f.thaw });
			}
		}

		if (this.isDefeated) ev.push({ kind: 'loss' });
		return ev;
	}

	/** Land up to n mines; returns how many couldn't land (→ bank). */
	_landMines(n, freeCells, useStagger, ev) {
		const r = this.rules;
		let landed = 0;
		while (landed < n) {
			if (this.mines.length >= r.activeMineCap) break;
			if (useStagger && this._staggerLeft <= 0) break;
			const cell = this._pickFree(freeCells);
			if (cell < 0) break;
			this.mines.push({ cell, fuse: r.mineFuse });
			if (useStagger) this._staggerLeft--;
			this._addTemp(r.mineLandTemp);
			ev.push({ kind: 'mineLand', cell });
			landed++;
		}
		return n - landed;
	}

	// —— Board clear (§8) ——
	onBoardCleared() {
		const r = this.rules;
		const ev = [];
		// Defensive no-op: a cleared board can't hold ice (clue areas sum to N²).
		for (const f of [...this.frozen]) ev.push(...this.forceBreakAt(f.cell));
		this._addTemp(r.clearReward);
		const perfect = this.doOversThisBoard === 0;
		this.perfectStreak = perfect ? this.perfectStreak + 1 : 0;
		const send = r.clearSendBase + Math.min(this.perfectStreak, r.perfectBonusCap);
		this.pendingMinesToSend += send;
		this.mines = []; // mines vanish with the board
		if (r.zeroBankOnClear) this.bank = 0;
		this.doOversThisBoard = 0;
		ev.push({ kind: 'clear', perfect, perfectStreak: this.perfectStreak, send });
		return ev;
	}

	// —— Force break (§7) ——
	forceBreakAt(cell) {
		const f = this.frozen.find((x) => x.cell === cell);
		if (!f) return [];
		this.frozen.splice(this.frozen.indexOf(f), 1);
		this._addTemp(this.rules.forceBreakReward);
		this.pendingBonusMines += this.rules.forceBreakSend;
		return [{ kind: 'forceBreak', cell }];
	}

	/**
	 * Anti-softlock. Run after every turn.
	 * board: { N, nums: number[][], rects: {x1,y1,x2,y2}[] }
	 * Breaks ice one cell at a time (nearest-to-thaw) only while some remaining
	 * clue has no ice-free way to finish, and only if the player's routing is sound.
	 */
	checkStuckAndForceBreak(board) {
		const ev = [];
		if (!this.frozen.length) return ev;
		const unplaced = unplacedGivens(board);
		if (unplaced.length > this.frozen.length) return ev; // the gate (§7)

		let guard = this.frozen.length + 1;
		let passB = null; // computed once: does any completion exist, ignoring ice?
		while (this.frozen.length && guard-- > 0) {
			const ice = new Set(this.frozen.map((f) => f.cell));
			const a = BoardCompletionSolver.analyze(board, ice, this.rules.solverBudget);
			if (passB === null) passB = a.solvable;
			if (!passB) break; // bad routing: the player's fault, no rescue
			if (!a.blocked.length) break; // Pass A: every clue still has an ice-free finish
			const candidates = this.frozen.filter((f) => a.blockingIce.has(f.cell));
			const target = this._nearestToThaw(candidates);
			if (!target) break;
			ev.push(...this.forceBreakAt(target.cell));
		}
		return ev;
	}
}

// —— Board helpers (pure) ——

export function rectCellsOf(rc, N) {
	const out = [];
	for (let y = rc.y1; y <= rc.y2; y++) for (let x = rc.x1; x <= rc.x2; x++) out.push(y * N + x);
	return out;
}

export function edgeCellsOf(rc, N) {
	const out = [];
	for (let x = rc.x1; x <= rc.x2; x++) {
		if (rc.y1 > 0) out.push((rc.y1 - 1) * N + x);
		if (rc.y2 < N - 1) out.push((rc.y2 + 1) * N + x);
	}
	for (let y = rc.y1; y <= rc.y2; y++) {
		if (rc.x1 > 0) out.push(y * N + rc.x1 - 1);
		if (rc.x2 < N - 1) out.push(y * N + rc.x2 + 1);
	}
	return out;
}

export function coveredSet(board) {
	const s = new Set();
	for (const rc of board.rects) for (const c of rectCellsOf(rc, board.N)) s.add(c);
	return s;
}

export function freeCellsOf(board) {
	const cov = coveredSet(board);
	const out = [];
	for (let i = 0; i < board.N * board.N; i++) if (!cov.has(i)) out.push(i);
	return out;
}

export function unplacedGivens(board) {
	const cov = coveredSet(board);
	const out = [];
	for (let y = 0; y < board.N; y++)
		for (let x = 0; x < board.N; x++) {
			const v = board.nums[y][x];
			if (v && !cov.has(y * board.N + x)) out.push({ x, y, v, cell: y * board.N + x });
		}
	return out;
}

// —— BoardCompletionSolver (§7): partial-state DFS + MRV, node budget ——
export const BoardCompletionSolver = {
	/** Candidate rects for one clue: right area, contains only that clue, on uncovered cells. */
	candidates(board, g, covered) {
		const { N, nums } = board;
		const out = [];
		for (let w = 1; w <= g.v; w++) {
			if (g.v % w) continue;
			const h = g.v / w;
			if (w > N || h > N) continue;
			for (let x1 = Math.max(0, g.x - w + 1); x1 <= Math.min(g.x, N - w); x1++)
				for (let y1 = Math.max(0, g.y - h + 1); y1 <= Math.min(g.y, N - h); y1++) {
					const rc = { x1, y1, x2: x1 + w - 1, y2: y1 + h - 1 };
					let ok = true;
					for (let y = rc.y1; y <= rc.y2 && ok; y++)
						for (let x = rc.x1; x <= rc.x2 && ok; x++) {
							if (covered.has(y * N + x)) ok = false;
							else if (nums[y][x] && !(x === g.x && y === g.y)) ok = false;
						}
					if (ok) out.push({ rc, cells: rectCellsOf(rc, N) });
				}
		}
		return out;
	},

	/** Pass B: is there any completion with ice treated as normal cells? */
	solve(board, budget = 20000) {
		return this.analyze(board, new Set(), budget);
	},

	/**
	 * Enumerates completions (ignoring ice = Pass B) and reports which clues are
	 * blocked: every completion-consistent rect for them contains ice.
	 */
	analyze(board, ice, budget = 20000) {
		const covered = coveredSet(board);
		const givens = unplacedGivens(board);
		const cands = givens.map((g) => this.candidates(board, g, covered));
		const used = new Uint8Array(board.N * board.N);
		const seen = givens.map(() => new Set()); // candidate indices appearing in completions
		const chosen = new Array(givens.length).fill(-1);
		let nodes = 0;
		let completions = 0;
		let exhausted = false;

		const dfs = (placedCount) => {
			if (nodes++ > budget) {
				exhausted = true;
				return;
			}
			if (placedCount === givens.length) {
				completions++;
				chosen.forEach((ci, gi) => seen[gi].add(ci));
				return;
			}
			// MRV: the unplaced clue with the fewest fitting candidates
			let best = -1;
			let bestFits = null;
			for (let gi = 0; gi < givens.length; gi++) {
				if (chosen[gi] >= 0) continue;
				const fits = [];
				cands[gi].forEach((c, ci) => {
					if (c.cells.every((cell) => !used[cell])) fits.push(ci);
				});
				if (!fits.length) return; // dead end
				if (!bestFits || fits.length < bestFits.length) {
					best = gi;
					bestFits = fits;
				}
			}
			for (const ci of bestFits) {
				for (const cell of cands[best][ci].cells) used[cell] = 1;
				chosen[best] = ci;
				dfs(placedCount + 1);
				chosen[best] = -1;
				for (const cell of cands[best][ci].cells) used[cell] = 0;
				if (exhausted) return;
			}
		};
		dfs(0);

		const blocked = [];
		const blockingIce = new Set();
		givens.forEach((g, gi) => {
			const rects = [...seen[gi]].map((ci) => cands[gi][ci]);
			if (!rects.length) return;
			const hasClean = rects.some((c) => c.cells.every((cell) => !ice.has(cell)));
			if (hasClean) return;
			blocked.push(g);
			for (const c of rects) for (const cell of c.cells) if (ice.has(cell)) blockingIce.add(cell);
		});
		return { solvable: completions > 0, completions, nodes, exhausted, blocked, blockingIce };
	}
};
