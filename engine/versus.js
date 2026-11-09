// versus.js — Shikaku+ VS: the rules and one player's economy (first built 2026-10-29).
//
//   Mines (active):  sent by clears, land when YOU move, fuse down on your moves,
//                    cover with a finished rect to defuse, explode = −1 heart.
//   Ice (passive):   sent by perfect clears and by ice your opponent thaws;
//                    refuses rects, so it stalls your board until it thaws.
//   KO:              hearts run out, or freezeOverAt ice on the board at once.
//
// Only dependency: the board solver from economy.js (for the force break).
// Every mutation returns events { kind, ...data }. Cells are i = y * N + x.
import { BoardCompletionSolver, EconRng } from './economy.js';

export const VERSUS_RULES = {
	hearts: 3,
	freezeOverAt: 4,
	// What reaching freezeOverAt ice does (2026-11-04, Krischan): 'loseBoard' = the board is lost
	// (no clear, no attack), live mines go back to your red batch, a short pause, then the next
	// board. Hearts are the only way to lose. 'ko' = the old instant KO.
	freezeOver: 'loseBoard',
	frozenPauseMs: 800, // clients lock input this long after a lost board

	// Attack
	clearSend: 4,
	perfectSendsIce: 0, // was 1; frost (below) is now the only ice your opponent sends
	overflow: 'netCancel',
	// Net cancel (Krischan, 2026-11-08: "Why would I return it when it's supposed to be cancelled"):
	// your attack is spent cancelling Mines coming at you first, red batch first, up to counterCap;
	// only the rest is sent. Send 14 against 12 incoming: cancel 12, send 2.
	// true = the old counter-spike: a clear cancels up to counterCap for free and still sends everything.
	counterSpike: 'net',
	counterCap: 12,
	counterRate: 0, // share of cancelled mines added back to your attack: 0 = cancel only (2026-11-04), 0.5 = half, 1 = all
	cancelOrder: 'redFirst', // clears and clutches cancel the red batch first, then orange (2026-11-04); 'orangeFirst' = old // 'netCancel': your attack cancels your in-flight mines first | 'passthrough'

	// Mines
	incomingEta: 3, // your moves before a sent packet arrives
	batchSize: 6, // most that land in one move (was 4)
	mineCap: 6, // live mines on board; the rest wait in the pool
	mineFuse: 3,
	maxHeartsPerMove: 1, // mines going off on the same move cost at most this many hearts (anti-burst)
	spreadLanding: false, // land one per unsolved region (experiment)
	blastRadius: 1, // 3×3

	// Ice
	iceEta: 3, // 3 again (Krischan, 2026-11-09: "I'd much rather have the ice come in 3 ticks instead so it's defensible"); was 2 for a while, "more threatening"
	maxIceIncoming: 0, // 0 = no cap: ice stacks if the opponent is cracked
	telegraphIce: false, // false: no target cell shown; the board just catches a chill until it lands
	thawPoints: 4,
	passiveThawEvery: 2, // −1 every 2 moves (0.5 per move)
	activeThaw: 2, // a placed rect sharing an edge
	perPlacementThawCap: 2,
	thawSendsIce: false, // was true; finishing ice off by building now charges frost instead
	forceBreakSendsIce: false,
	// Rule C (Krischan's original): mines left sitting in your orange bank start to freeze
	// your board. Every bankFreezeEvery moves with at least bankFreezeMin mines banked,
	// one ice is queued. Holding your last box to counter-spike has a price.
	// Mines land clustered in the biggest unsolved box (weighted by open area squared),
	// spilling to the nearest cells, so one big box can defuse a clump. Reads the
	// solution on purpose: Krischan, 2026-10-30, a hint that rewards intuition is fine.
	mineCluster: true,
	// Grace (Krischan, 2026-10-30): nothing lands on the clearing move or on your first
	// move on the fresh board, so you can read it and plan a route before the batch drops.
	clearGrace: 1,
	// Frost: the one ice source from your opponent, and you can watch it fill.
	// Points per ice; early defuse (fuse not on its last tick) +1; finishing ice off
	// by building next to it +2. Fires the moment it's full, except on your last
	// frostHoldAtBoxesLeft boxes, where it holds and fires with your clear.
	frostMeter: 4, // 0 = off
	frostEarlyDefuse: 1,
	// A perfect Board (no Do-Overs) gives Frost too (Krischan, 2026-11-09): clean play feeds attack
	// and defence alike, while Mines stay the main fuel.
	perfectFrost: 1,
	// Frost shield (a room toggle, off by default; Krischan, 2026-11-09: "not 100% sold"): when a
	// Frozen Cell would land, this many Frost points are spent instead and it doesn't. 0 = off.
	frostShield: 0,
	frostActiveThaw: 2,
	frostHoldAtBoxesLeft: 4,
	frostMaxHeld: 12, // 3 ice: one clear alone can never freeze someone over
	// Clutch: a mine covered on its very last tick cancels this many of your own incoming.
	clutchCancels: 1,
	// Combo (Krischan, 2026-11-05): clears in a row. Only damage breaks it (a mine going off on
	// you, or freezing over); do-overs don't, because Shikaku needs them. The payout is added to
	// each clear's attack and is capped (a Jstris-style slow ramp): index = combo count.
	comboTable: [0, 0, 1, 1, 2, 2, 3, 3, 4], // combo 1: +0, 2–3: +1, 4–5: +2, 6–7: +3, 8+: +4
	// A full frost ice mid-board is armed for one move (outlined), then fires: every send gets a
	// visible armed moment. Held ice on the last boxes fires with the clear as before.
	frostArmMoves: 1,
	// Deflect (Krischan, 2026-11-05): when your frost fires, it first cancels ice coming at you,
	// soonest first, one for one; only the rest goes out. Clean play is your defence against ice,
	// the way your clears cancel mines.
	frostDeflects: true,
	// Defuse-clear: each mine defused by the box that finishes the board adds this many
	// mines to the clear's attack. Flat, never a multiplier (counter-spikes are big already).
	defuseClearBonus: 1,
	bankFreezeEvery: 6, // 0 = off
	// Anti-stall: a board with no move for this long ticks anyway. Off: Krischan didn't
	// like it in play (2026-10-30). Kept as a lab slider.
	idleTickSecs: 0,
	bankFreezeMin: 4,
	icebreakAtBoxesLeft: 2, // the icebreaker only helps on your last N boxes
	icebreakPerMove: 1, // and breaks at most this many cells per move
	icebreakSpills: false, // was true; Krischan 2026-10-30: ice you broke stays broken
	icebreakReward: 2, // frost for an icebreak on your last boxes (you routed the whole board around it); the rescue break gives nothing
	defuseTiers: true, // fresh (covered the move it landed) +1 frost; middle nothing; clutch (last tick) cancels 1

	// Rush: once the round runs long, every mine attack is multiplied
	rushAfter: 100, // match moves (average of both players); 0 = off
	rushAfterSecs: 180, // when the match clock is known (online), rush starts on time instead of moves; 0 = use moves
	// Always-on gravity (2026-11-04): every gravitySecs of real time your board ticks once, moves or not.
	// Lazy: nothing runs; whoever handles the next message catches up on owed ticks from timestamps.
	gravitySecs: 3, // 0 = off
	rushMultiplier: 5,
	// The Rush ramp (Krischan, 2026-11-08): a first step before the full Rush, so the squeeze builds
	// instead of flipping on. ×3 from 2:00, then ×rushMultiplier from rushAfterSecs (3:00). 0 = no first step.
	rushEarlySecs: 120,
	rushEarlyMultiplier: 3,

	// Heal: +1 heart after healPerfectBoards perfect clears in a row (0 = off).
	// A non-perfect clear resets the run; explosions don't count against perfect.
	healPerfectBoards: 4, // was 3
	healCheckpoint: 2, // a non-perfect clear drops the run back to this, not to 0, once reached (0 = off)
	maxHealsPerRound: 1, // 0 = unlimited; stops a low-heart player from chaining heals
	// Older idea, off: +1 heart every N placements in a row without a do-over.
	healEvery: 0,

	// On your board clear: mines that already arrived (the pool) die with the board.
	// Mines still in flight keep coming unless clearWipesIncoming is on.
	clearWipesPool: false, // the red batch is committed: it lands on your next board
	clearWipesIncoming: false,

	solverBudget: 20000
};

// Shikaku+ Mines (Krischan, 2026-11-05): mines only, no ice at all, unrated. Every ice source is off.
export const MINES_RULES = {
	...VERSUS_RULES,
	mode: 'mines',
	frostMeter: 0,
	perfectSendsIce: 0,
	thawSendsIce: false,
	forceBreakSendsIce: false,
	icebreakSpills: false,
	bankFreezeEvery: 0
};

export class VersusPlayer {
	constructor(rules = VERSUS_RULES, seed = 1) {
		this.rules = rules;
		this.seed = seed;
		this.reset();
	}

	reset() {
		this.rng = new EconRng(this.seed);
		this.hearts = this.rules.hearts;
		this.ticks = 0;
		this.mines = []; // { cell, fuse }
		this.incoming = []; // packets in flight: { count, eta }
		this.pool = 0; // arrived, waiting for room
		this.ice = []; // { cell, thaw, seq, landedTick }
		this.iceIncoming = []; // { eta, target }
		this._seq = 0;
		this._thawAcc = 0;
		this.doOversThisBoard = 0;
		this.streak = 0;
		this.perfectRun = 0;
		this.heals = 0;
		this._bankCold = 0;
		this._defusedThisMove = 0;
		this.frost = 0;
		this.armed = 0;
		this.combo = 0;
		this._clutch = []; // clutches waiting on this move's tick: they only count if nothing goes off
		this.graceLeft = 0;
		this.outMines = 0;
		this.outIce = 0;
		this.spill = 0; // icebroken cells waiting for your next board
		this.stats = { defused: 0, exploded: 0, thawed: 0, sentIce: 0, forceBreaks: 0, clears: 0, perfects: 0 };
	}

	get incomingTotal() {
		return this.incoming.reduce((a, p) => a + p.count, 0);
	}
	/** Red: the batch that lands on your next move. Committed; can't be cancelled. */
	get nextBatch() {
		const arriving = this.pool + this.incoming.filter((p) => p.eta <= 1).reduce((a, p) => a + p.count, 0);
		const room = Math.max(0, this.rules.mineCap - this.mines.length);
		return Math.min(arriving, room, this.rules.batchSize);
	}
	/** Orange: everything else on its way or parked. A clear's counter-spike cancels from here. */
	get bank() {
		return this.pool + this.incomingTotal - this.nextBatch;
	}
	/** Moves until the next mine packet lands, or null. */
	get nextMinesIn() {
		if (this.pool > 0) return 1;
		return this.incoming.length ? Math.min(...this.incoming.map((p) => p.eta)) : null;
	}
	get isKO() {
		return this.hearts <= 0 || (this.rules.freezeOver === 'ko' && this.ice.length >= this.rules.freezeOverAt);
	}
	iceSet() {
		return new Set(this.ice.map((f) => f.cell));
	}

	_occupied() {
		const s = new Set();
		for (const m of this.mines) s.add(m.cell);
		for (const f of this.ice) s.add(f.cell);
		for (const w of this.iceIncoming) if (w.target >= 0) s.add(w.target);
		return s;
	}
	_pick(free, extraBlocked = new Set()) {
		const occ = this._occupied();
		const pool = free.filter((c) => !occ.has(c) && !extraBlocked.has(c));
		return pool.length ? pool[this.rng.nextInt(pool.length)] : -1;
	}

	/** Up to n landing cells: a clump in one big unsolved box, then the nearest cells around it. */
	_clusterCells(free, regionOf, n) {
		const occ = new Set([...this.mines.map((m) => m.cell), ...this.ice.map((f) => f.cell)]);
		const open = free.filter((c) => !occ.has(c));
		if (!open.length || n <= 0) return [];
		const byRegion = new Map();
		for (const c of open) {
			const k = regionOf[c];
			if (!byRegion.has(k)) byRegion.set(k, []);
			byRegion.get(k).push(c);
		}
		// Anchor box: weighted by open cells squared, so big boxes draw the clump.
		const regions = [...byRegion.entries()];
		let roll = this.rng.nextInt(regions.reduce((s, [, cs]) => s + cs.length * cs.length, 0));
		let anchor = regions[0];
		for (const rg of regions) {
			roll -= rg[1].length * rg[1].length;
			if (roll < 0) {
				anchor = rg;
				break;
			}
		}
		const N = Math.round(Math.sqrt(regionOf.length));
		const ax = anchor[1].reduce((s, c) => s + (c % N), 0) / anchor[1].length;
		const ay = anchor[1].reduce((s, c) => s + Math.floor(c / N), 0) / anchor[1].length;
		const dist = (c) => Math.abs((c % N) - ax) + Math.abs(Math.floor(c / N) - ay);
		const inside = this._shuffle([...anchor[1]]);
		const rest = open.filter((c) => regionOf[c] !== anchor[0]).map((c, i) => [c, i]).sort((a, b) => dist(a[0]) - dist(b[0]) || a[1] - b[1]).map(([c]) => c); // explicit tiebreak: same order in every language
		return [...inside, ...rest].slice(0, n);
	}
	_shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = this.rng.nextInt(i + 1);
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	// —— Receiving ——
	receiveMines(count) {
		if (count > 0) this.incoming.push({ count, eta: this.rules.incomingEta });
		return count > 0 ? [{ kind: 'minesIncoming', count, eta: this.rules.incomingEta }] : [];
	}
	/** Ice is telegraphed on a visible target cell. free = landable cells now. */
	receiveIce(count, free) {
		const r = this.rules;
		const ev = [];
		for (let i = 0; i < count; i++) {
			if (r.maxIceIncoming && this.iceIncoming.length >= r.maxIceIncoming) {
				ev.push({ kind: 'iceBlocked' });
				continue;
			}
			const target = r.telegraphIce ? this._pick(free) : -1;
			this.iceIncoming.push({ eta: r.iceEta, target });
			ev.push({ kind: 'iceIncoming', target, eta: r.iceEta });
		}
		return ev;
	}

	/** Net-cancel: only packets still in flight, oldest first. Never the pool or the board. */
	cancelIncoming(count) {
		// Only the orange bank: far packets first (oldest first), then whatever is
		// arriving next move beyond the red batch.
		let left = Math.min(count, this.bank);
		const start = left;
		for (const p of this.incoming) {
			if (left <= 0) break;
			if (p.eta <= 1) continue;
			const take = Math.min(left, p.count);
			p.count -= take;
			left -= take;
		}
		for (const p of this.incoming) {
			if (left <= 0) break;
			if (p.eta > 1) continue;
			const take = Math.min(left, p.count);
			p.count -= take;
			left -= take;
		}
		if (left > 0) {
			const take = Math.min(left, this.pool);
			this.pool -= take;
			left -= take;
		}
		this.incoming = this.incoming.filter((p) => p.count > 0);
		return start - left;
	}

	/** Cancel from anywhere in your queue: orange bank first, then the red batch. */
	cancelAny(count) {
		if (this.rules.cancelOrder === 'redFirst') return this.cancelNearest(count);
		let done = this.cancelIncoming(count);
		let left = count - done;
		const take = Math.min(left, this.pool);
		this.pool -= take;
		left -= take;
		for (const p of this.incoming) {
			if (left <= 0) break;
			const t = Math.min(left, p.count);
			p.count -= t;
			left -= t;
		}
		this.incoming = this.incoming.filter((p) => p.count > 0);
		return count - left;
	}

	/** Cancel the nearest first: what's already arrived (red), then packets by arrival. */
	cancelNearest(count) {
		let left = count;
		const t = Math.min(left, this.pool);
		this.pool -= t;
		left -= t;
		for (const p of this.incoming.map((q, i) => [q, i]).sort((a, b) => a[0].eta - b[0].eta || a[1] - b[1]).map(([q]) => q)) {
			if (left <= 0) break;
			const k = Math.min(left, p.count);
			p.count -= k;
			left -= k;
		}
		this.incoming = this.incoming.filter((p) => p.count > 0);
		return count - left;
	}
	/** The 'loseBoard' freeze-over: no clear, live mines go back to your red batch, run drops to checkpoint. */
	loseBoard() {
		const r = this.rules;
		this.pool += this.mines.length;
		this.mines = [];
		this.ice = [];
		const cp = r.healCheckpoint || 0;
		this.perfectRun = cp && this.perfectRun >= cp ? cp : 0;
		this.doOversThisBoard = 0;
		this._defusedThisMove = 0;
		this.graceLeft = r.clearGrace ? r.clearGrace : 0; // first move on the new board is safe
		this.stats.frozenOut = (this.stats.frozenOut || 0) + 1;
		const ev = [{ kind: 'frozenOut', pauseMs: r.frozenPauseMs }];
		if (this.combo) ev.push({ kind: 'comboBreak', combo: this.combo });
		this.combo = 0;
		this.armed = 0;
		return ev;
	}

	/** Frost settles after each move: fires when full, or holds near the end of a board. */
	frostHeld(boxesLeft) {
		return !!this.rules.frostHoldAtBoxesLeft && boxesLeft <= this.rules.frostHoldAtBoxesLeft;
	}
	settleFrost(boxesLeft, cleared) {
		const r = this.rules;
		if (!r.frostMeter) return [];
		let count = 0;
		const full = () => Math.floor(this.frost / r.frostMeter);
		if (cleared) {
			count = full(); // the cannon: everything charged goes out with the clear
			this.armed = 0;
		} else if (this.frostHeld(boxesLeft)) {
			this.frost = Math.min(this.frost, r.frostMaxHeld);
			this.armed = full(); // held, shown armed, fires with the clear
		} else if (r.frostArmMoves) {
			count = this.armed; // armed last move: fire now
			this.armed = full() - count; // newly completed: armed, fires next move
		} else count = full();
		if (count) this.frost -= count * r.frostMeter;
		if (!count) return [];
		let deflected = 0;
		if (r.frostDeflects && this.iceIncoming.length) {
			deflected = Math.min(count, this.iceIncoming.length);
			const soonest = this.iceIncoming.map((w, i) => [w, i]).sort((a, b) => a[0].eta - b[0].eta || a[1] - b[1]).slice(0, deflected).map(([w]) => w);
			this.iceIncoming = this.iceIncoming.filter((w) => !soonest.includes(w));
			count -= deflected;
			this.stats.deflected = (this.stats.deflected || 0) + deflected;
		}
		this.outIce += count;
		this.stats.sentIce += count;
		return [{ kind: 'frostFire', count, deflected, withClear: !!cleared }];
	}

	/** New board: re-aim telegraphed ice at cells that exist on it. */
	retargetIce(free) {
		for (const w of this.iceIncoming) w.target = -1;
		if (this.rules.telegraphIce) for (const w of this.iceIncoming) w.target = this._pick(free);
	}

	// —— Your moves ——
	onPlacement(rectCells, edgeCells, { doOver = false } = {}) {
		const r = this.rules;
		const ev = [];
		if (doOver) {
			this.doOversThisBoard++;
			this.streak = 0;
		} else {
			this.streak++;
			if (r.healEvery && this.streak % r.healEvery === 0) {
				const healed = this.hearts < r.hearts;
				if (healed) this.hearts++;
				ev.push({ kind: 'heal', streak: this.streak, healed, hearts: this.hearts });
			}
		}
		const covered = new Set(rectCells);
		this._defusedThisMove = 0;
		for (let i = this.mines.length - 1; i >= 0; i--) {
			if (!covered.has(this.mines[i].cell)) continue;
			// Clutch: covered on its very last fuse tick (it would have gone off this move).
			const clutch = this.mines[i].fuse === 1;
			const fresh = this.mines[i].fuse >= r.mineFuse;
			ev.push({ kind: 'defuse', cell: this.mines[i].cell, clutch, fresh });
			// The clutch is only a clutch if nothing goes off this move (Krischan, 2026-11-05: calling
			// it a clutch while you lose a heart is lying). It waits for this move's tick.
			if (clutch && r.clutchCancels) this._clutch.push(this.mines[i].cell);
			else if (r.frostMeter && (r.defuseTiers ? fresh : !clutch)) this.frost += r.frostEarlyDefuse;
			this._defusedThisMove++;
			this.mines.splice(i, 1);
			this.stats.defused++;
		}
		const edge = new Set(edgeCells);
		for (const f of [...this.ice]) {
			if (!edge.has(f.cell)) continue;
			const amt = Math.min(r.activeThaw, r.perPlacementThawCap);
			f.thaw -= amt;
			if (f.thaw <= 0) {
				this.ice.splice(this.ice.indexOf(f), 1);
				this.stats.thawed++;
				const sends = r.thawSendsIce;
				if (sends) {
					this.outIce++;
					this.stats.sentIce++;
				}
				if (r.frostMeter) this.frost += r.frostActiveThaw;
				ev.push({ kind: 'thaw', cell: f.cell, source: 'active', sends });
			} else ev.push({ kind: 'thawPulse', cell: f.cell, thaw: f.thaw });
		}
		return ev;
	}

	onErase() {
		this.doOversThisBoard++;
		this.streak = 0;
		return [];
	}

	onBoardCleared() {
		const r = this.rules;
		const perfect = this.doOversThisBoard === 0;
		const defuseBonus = (r.defuseClearBonus || 0) * this._defusedThisMove;
		this._defusedThisMove = 0;
		this.combo++;
		const t = r.comboTable || [];
		const comboBonus = t.length ? t[Math.min(this.combo, t.length - 1)] : 0;
		this.outMines += r.clearSend + defuseBonus + comboBonus;
		if (perfect) {
			this.outIce += r.perfectSendsIce;
			if (r.frostMeter && r.perfectFrost) this.frost += r.perfectFrost;
			this.stats.perfects++;
			this.stats.sentIce += r.perfectSendsIce;
		}
		this.stats.clears++;
		const ev = [];
		const cp = r.healCheckpoint || 0;
		this.perfectRun = perfect ? this.perfectRun + 1 : cp && this.perfectRun >= cp ? cp : 0;
		this.graceLeft = r.clearGrace ? r.clearGrace + 1 : 0; // the clearing move's tick + your first move
		const healsLeft = !r.maxHealsPerRound || this.heals < r.maxHealsPerRound;
		if (r.healPerfectBoards && healsLeft && this.perfectRun >= r.healPerfectBoards) {
			this.perfectRun = 0;
			const healed = this.hearts < r.hearts;
			if (healed) {
				this.hearts++;
				this.heals++;
			}
			ev.push({ kind: 'heal', boards: r.healPerfectBoards, healed, hearts: this.hearts });
		}
		this.mines = []; // mines on the board die with it
		this.ice = []; // defensive: a cleared board can't hold ice
		this.doOversThisBoard = 0;
		const wiped = (r.clearWipesPool ? this.pool : 0) + (r.clearWipesIncoming ? this.incomingTotal : 0);
		if (r.clearWipesPool) this.pool = 0;
		if (r.clearWipesIncoming) this.incoming = [];
		return [{ kind: 'clear', wiped, perfect, perfectRun: this.perfectRun, sendMines: r.clearSend + defuseBonus + comboBonus, defuseBonus, combo: this.combo, comboBonus, sendIce: perfect ? r.perfectSendsIce : 0 }, ...ev];
	}

	drainOut() {
		const out = { mines: this.outMines, ice: this.outIce };
		this.outMines = 0;
		this.outIce = 0;
		return out;
	}

	/**
	 * One move's clock step. Runs AFTER your move resolved (so a clear's attack has
	 * already cancelled incoming). free = uncovered, non-clue cells.
	 * regionOf (optional): cell → solution-rect index, for spread landing.
	 */
	tick(free, regionOf = null) {
		const r = this.rules;
		const ev = [];
		this.ticks++;

		// 1) Fuses
		// Several mines going off on one move cost at most maxHeartsPerMove (anti-burst);
		// every one still blasts the board.
		const blown = [];
		for (const m of [...this.mines]) {
			m.fuse--;
			if (m.fuse <= 0) {
				this.mines.splice(this.mines.indexOf(m), 1);
				this.stats.exploded++;
				blown.push(m);
			}
		}
		if (blown.length) {
			const cap = r.maxHeartsPerMove || blown.length;
			this.hearts -= Math.min(blown.length, cap);
			for (const m of blown) ev.push({ kind: 'mineExplode', cell: m.cell, hearts: this.hearts, together: blown.length });
			if (this.combo) ev.push({ kind: 'comboBreak', combo: this.combo });
			this.combo = 0;
		}
		// Clutches from this move stand only if nothing went off.
		if (this._clutch && this._clutch.length) {
			if (!blown.length) for (const cell of this._clutch) ev.push({ kind: 'clutch', cell, cancelled: this.cancelAny(r.clutchCancels) });
			this._clutch = [];
		}

		// 2) Passive thaw (sends nothing)
		if (++this._thawAcc >= r.passiveThawEvery) {
			this._thawAcc = 0;
			for (const f of [...this.ice]) {
				if (f.landedTick === this.ticks) continue;
				f.thaw--;
				if (f.thaw <= 0) {
					this.ice.splice(this.ice.indexOf(f), 1);
					this.stats.thawed++;
					ev.push({ kind: 'thaw', cell: f.cell, source: 'passive', sends: false });
				} else ev.push({ kind: 'thawPulse', cell: f.cell, thaw: f.thaw });
			}
		}

		// 3) Mines in flight → pool → board (Tetris: lands when you move)
		const grace = this.graceLeft > 0;
		if (grace) this.graceLeft--;
		for (const p of this.incoming) p.eta--;
		for (const p of this.incoming.filter((q) => q.eta <= 0)) this.pool += p.count;
		this.incoming = this.incoming.filter((q) => q.eta > 0);
		if (this.pool > 0 && !grace) {
			const room = Math.max(0, r.mineCap - this.mines.length);
			let n = Math.min(this.pool, room, r.batchSize);
			const usedRegions = new Set(this.mines.map((m) => regionOf?.[m.cell]));
			let landed = 0;
			if (r.mineCluster && regionOf && !r.spreadLanding) {
				for (const cell of this._clusterCells(free, regionOf, n)) {
					this.mines.push({ cell, fuse: r.mineFuse });
					ev.push({ kind: 'mineLand', cell });
					landed++;
				}
				n = 0;
			}
			while (landed < n) {
				let block = new Set();
				if (r.spreadLanding && regionOf) {
					block = new Set(free.filter((c) => usedRegions.has(regionOf[c])));
					if (free.every((c) => block.has(c))) block = new Set();
				}
				const cell = this._pick(free, block);
				if (cell < 0) break;
				this.mines.push({ cell, fuse: r.mineFuse });
				if (regionOf) usedRegions.add(regionOf[cell]);
				ev.push({ kind: 'mineLand', cell });
				landed++;
			}
			this.pool -= landed;
		}

		// 3b) Rule C: a bank left sitting too long freezes over
		if (r.bankFreezeEvery && this.bank >= r.bankFreezeMin) {
			if (++this._bankCold >= r.bankFreezeEvery) {
				this._bankCold = 0;
				ev.push({ kind: 'bankFreeze', bank: this.bank }, ...this.receiveIce(1, free));
			}
		} else this._bankCold = 0;

		// 4) Ice in flight
		for (const w of this.iceIncoming) w.eta--;
		for (const w of [...this.iceIncoming]) {
			if (w.eta > 0) continue;
			if (grace) {
				w.eta = 0;
				continue;
			}
			if (r.frostShield && r.frostMeter && this.frost >= r.frostShield) {
				// The shield: spend Frost, and this Frozen Cell never lands.
				this.frost -= r.frostShield;
				this.armed = Math.min(this.armed, Math.floor(this.frost / r.frostMeter));
				this.iceIncoming.splice(this.iceIncoming.indexOf(w), 1);
				this.stats.shielded = (this.stats.shielded || 0) + 1;
				ev.push({ kind: 'shield', spent: r.frostShield });
				continue;
			}
			const occ = new Set([...this.mines.map((m) => m.cell), ...this.ice.map((f) => f.cell)]);
			let cell = w.target;
			if (cell < 0 || !free.includes(cell) || occ.has(cell)) {
				w.target = -1;
				cell = this._pick(free);
			}
			if (cell < 0) {
				w.eta = 0; // no room: retry next move
				continue;
			}
			this.iceIncoming.splice(this.iceIncoming.indexOf(w), 1);
			this.ice.push({ cell, thaw: r.thawPoints, seq: this._seq++, landedTick: this.ticks });
			ev.push({ kind: 'frozen', cell });
		}

		if (this.hearts <= 0) ev.push({ kind: 'ko', by: 'mines' });
		else if (r.freezeOver === 'ko' && this.ice.length >= r.freezeOverAt) ev.push({ kind: 'ko', by: 'ice' });
		return ev;
	}

	// —— Icebreaker (anti-softlock), same proven logic as the original ——
	forceBreakAt(cell) {
		const f = this.ice.find((x) => x.cell === cell);
		if (!f) return [];
		this.ice.splice(this.ice.indexOf(f), 1);
		this.stats.forceBreaks++;
		if (this.rules.forceBreakSendsIce) this.outIce++;
		if (this.rules.icebreakSpills) this.spill++;
		return [{ kind: 'forceBreak', cell, spills: this.rules.icebreakSpills }];
	}
	_nearestToThaw(list) {
		if (!list.length) return null;
		const min = Math.min(...list.map((f) => f.thaw));
		const atMin = list.filter((f) => f.thaw === min);
		const oldest = Math.min(...atMin.map((f) => f.seq));
		const ties = atMin.filter((f) => f.seq === oldest);
		return ties[this.rng.nextInt(ties.length)];
	}
	/** True if some unplaced clue has at least one valid box that avoids ice. */
	hasIceFreeMove(board) {
		const cov = new Set();
		for (const rc of board.rects) for (let y = rc.y1; y <= rc.y2; y++) for (let x = rc.x1; x <= rc.x2; x++) cov.add(y * board.N + x);
		const ice = this.iceSet();
		for (let y = 0; y < board.N; y++)
			for (let x = 0; x < board.N; x++) {
				const v = board.nums[y][x];
				if (!v || cov.has(y * board.N + x)) continue;
				const cands = BoardCompletionSolver.candidates(board, { x, y, v }, cov);
				if (cands.some((c) => c.cells.every((cell) => !ice.has(cell)))) return true;
			}
		return false;
	}

	checkStuckAndForceBreak(board, unplacedCount) {
		const ev = [];
		const r = this.rules;
		if (!this.ice.length || unplacedCount > this.ice.length) return ev;
		// Normally the icebreaker only helps on your last N boxes. But if ice leaves you
		// with no legal placement at all, it steps in anyway: the board only ticks when
		// you move, so with nothing to place the ice would never melt (a true softlock).
		if (r.icebreakAtBoxesLeft && unplacedCount > r.icebreakAtBoxesLeft && this.hasIceFreeMove(board)) return ev;
		let budget = r.icebreakPerMove || Infinity;
		let guard = this.ice.length + 1;
		let passB = null;
		while (this.ice.length && guard-- > 0) {
			const softlock = !this.hasIceFreeMove(board);
			// One cell per move, unless you'd be left with no legal box at all: then keep
			// breaking, or the board can never tick again (the 2026-10-30 lockout: three ice
			// on the last two boxes, one broke, two stayed).
			if (budget-- <= 0 && !softlock) break;
			const a = BoardCompletionSolver.analyze(board, this.iceSet(), this.rules.solverBudget);
			if (passB === null) passB = a.solvable;
			if (!softlock && (!passB || !a.blocked.length)) break;
			let pool = this.ice.filter((f) => a.blockingIce.has(f.cell));
			if (!pool.length && softlock) pool = this.ice; // nothing provably blocking: free the nearest-to-thaw
			const target = this._nearestToThaw(pool);
			if (!target) break;
			const broke = this.forceBreakAt(target.cell);
			// Earned: you reached your last boxes with the ice still there, routing around it.
			const earned = !!r.icebreakAtBoxesLeft && unplacedCount <= r.icebreakAtBoxesLeft && !!r.icebreakReward;
			if (earned && broke.length) {
				this.frost += r.icebreakReward;
				broke[0].earned = true;
			}
			ev.push(...broke);
		}
		return ev;
	}
}
