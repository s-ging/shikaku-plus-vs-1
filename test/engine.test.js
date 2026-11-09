// engine.test.js — Shikaku+ VS rules. Run: node --test test/*.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSUS_RULES, MINES_RULES, VersusPlayer } from '../engine/versus.js';
import { VersusMatch, TiltBot } from '../engine/versus-match.js';

const p = (patch = {}) => new VersusPlayer({ ...VERSUS_RULES, ...patch }, 5);
const FREE = [...Array(36).keys()];
const kinds = (ev) => ev.map((e) => e.kind);

test('mines arrive after incomingEta of YOUR moves, then land in batches of 4 (old batch size)', () => {
	const e = p({ batchSize: 4 });
	e.receiveMines(8);
	e.tick(FREE);
	e.tick(FREE);
	assert.equal(e.mines.length, 0);
	e.tick(FREE);
	assert.equal(e.mines.length, 4, 'first batch of 4');
	assert.equal(e.pool, 4);
	e.tick(FREE);
	assert.equal(e.mines.length, 6, 'cap 6 on board');
	assert.equal(e.pool, 2);
});

test('fuse: explodes on the 3rd move after landing, costs a heart', () => {
	const e = p();
	e.mines = [{ cell: 0, fuse: 3 }];
	e.tick(FREE);
	e.tick(FREE);
	const ev = e.tick(FREE);
	assert.ok(kinds(ev).includes('mineExplode'));
	assert.equal(e.hearts, 2);
});

test('defuse: covering with a placed rect, no reward', () => {
	const e = p();
	e.mines = [{ cell: 0, fuse: 2 }];
	const ev = e.onPlacement([0, 1], []);
	assert.deepEqual(kinds(ev), ['defuse']);
	assert.equal(e.outMines + e.outIce, 0);
});

test('queue: red is the next batch (committed), orange is the rest; cancel only takes orange', () => {
	const e = p();
	e.incoming = [
		{ count: 4, eta: 1 },
		{ count: 8, eta: 3 }
	];
	e.pool = 3;
	assert.equal(e.nextBatch, 6, 'pool 3 + arriving 4, capped at a batch of 6');
	assert.equal(e.bank, 9);
	assert.equal(e.cancelIncoming(100), 9, 'never more than the orange bank');
	assert.equal(e.nextBatch, 6);
	assert.equal(e.bank, 0);
});

test('ice: telegraphed target (toggle on), lands after iceEta moves, never on clue cells', () => {
	const e = p({ telegraphIce: true, iceEta: 3 });
	const free = [7, 8, 9]; // caller passes non-clue, uncovered cells only
	e.receiveIce(1, free);
	const target = e.iceIncoming[0].target;
	assert.ok(free.includes(target));
	e.tick(free);
	e.tick(free);
	assert.ok(kinds(e.tick(free)).includes('frozen'));
	assert.equal(e.ice[0].cell, target);
});

test('thaw (old rules, thawSendsIce): adjacent placement −2, thaw-out sends 1 ice back; passive −1 per 2 moves sends nothing', () => {
	const e = p({ thawSendsIce: true, frostMeter: 0 });
	e.ice = [{ cell: 6, thaw: 2, seq: 0, landedTick: -1 }];
	const ev = e.onPlacement([0], [6, 1]);
	assert.ok(kinds(ev).includes('thaw'));
	assert.equal(e.outIce, 1);
	e.outIce = 0;
	e.ice = [{ cell: 6, thaw: 1, seq: 0, landedTick: -1 }];
	e.tick([]);
	assert.equal(e.ice.length, 1, 'first move: no passive thaw yet');
	e.tick([]);
	assert.equal(e.ice.length, 0);
	assert.equal(e.outIce, 0);
});

test('perfect clear (old rules, perfectSendsIce 1) sends 4 mines + 1 ice; a do-over makes it 4 mines only', () => {
	const e = p({ perfectSendsIce: 1, comboTable: [] });
	e.onBoardCleared();
	assert.deepEqual(e.drainOut(), { mines: 4, ice: 1 });
	e.onErase();
	e.onBoardCleared();
	assert.deepEqual(e.drainOut(), { mines: 4, ice: 0 });
});

test('KO (old freezeOver ko): hearts at 0, or 4 ice at once', () => {
	const a = p();
	a.hearts = 0;
	assert.ok(a.isKO);
	const b = p({ freezeOver: 'ko' });
	b.ice = [0, 1, 2, 3].map((cell, seq) => ({ cell, thaw: 4, seq, landedTick: -1 }));
	assert.ok(b.isKO);
});

test('match: hazards never land on clue cells or solved rects', () => {
	const m = new VersusMatch({ seed: 3 });
	const s = m.sides[0];
	m.sides[1].econ.outMines = 0;
	s.econ.receiveMines(6);
	s.econ.receiveIce(2, s.landable());
	const first = s.puzzle.layout[0];
	m.act(0, { type: 'place', ax: first.x1, ay: first.y1, bx: first.x2, by: first.y2 });
	for (let k = 0; k < 4; k++) m.act(0, { type: 'erase', x: first.x1, y: first.y1 }) || 0;
	const clue = (c) => s.puzzle.nums[Math.floor(c / s.N)][c % s.N] !== 0;
	for (const mine of s.econ.mines) assert.ok(!clue(mine.cell));
	for (const f of s.econ.ice) assert.ok(!clue(f.cell));
});

test('match: a round KO fully resets both players', () => {
	const m = new VersusMatch({ seed: 4 });
	m.sides[1].econ.hearts = 1;
	m.sides[1].econ.mines = [{ cell: m.sides[1].landable()[0], fuse: 1 }];
	const r = m.sides[1].puzzle.layout.find((x) => !x.has(m.sides[1].econ.mines[0].cell % 6, Math.floor(m.sides[1].econ.mines[0].cell / 6)));
	m.act(1, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 });
	assert.equal(m.roundOver.winner, 0);
	m.newRound();
	assert.deepEqual(m.sides.map((s) => s.econ.hearts), [3, 3]);
	assert.equal(m.score[0], 1);
});

test('streak heal (off by default): +1 heart every 25 placements in a row, capped at max', () => {
	const e = p({ healEvery: 25 });
	e.hearts = 2;
	let healEv = [];
	for (let i = 0; i < 25; i++) healEv = e.onPlacement([i % 36], []);
	assert.ok(kinds(healEv).includes('heal'));
	assert.equal(e.hearts, 3);
	for (let i = 0; i < 25; i++) e.onPlacement([i % 36], []);
	assert.equal(e.hearts, 3, 'never above max');
});

test('heal: a do-over or erase resets the streak; an explosion does not', () => {
	const e = p();
	for (let i = 0; i < 10; i++) e.onPlacement([0], []);
	e.mines = [{ cell: 5, fuse: 1 }];
	e.tick(FREE);
	assert.equal(e.streak, 10, 'explosion keeps the streak');
	e.onPlacement([0], [], { doOver: true });
	assert.equal(e.streak, 0);
	e.onPlacement([0], []);
	e.onErase();
	assert.equal(e.streak, 0);
});

test('clear: with clearWipesPool on, pooled mines die with the board; in-flight keep coming', () => {
	const e = p({ clearWipesPool: true });
	e.pool = 3;
	e.incoming = [{ count: 4, eta: 2 }];
	const ev = e.onBoardCleared();
	assert.equal(e.pool, 0);
	assert.equal(e.incomingTotal, 4);
	assert.equal(ev[0].wiped, 3);
	const w = p({ clearWipesPool: true, clearWipesIncoming: true });
	w.pool = 1;
	w.incoming = [{ count: 4, eta: 2 }];
	w.onBoardCleared();
	assert.equal(w.incomingTotal, 0);
});

test('heal: 3 perfect boards in a row heals 1 heart; a sloppy clear resets the run (no checkpoint)', () => {
	const e = p({ healPerfectBoards: 3, healCheckpoint: 0 });
	e.hearts = 1;
	e.onBoardCleared();
	e.onBoardCleared();
	e.onErase();
	e.onBoardCleared(); // not perfect: run resets
	assert.equal(e.hearts, 1);
	assert.equal(e.perfectRun, 0);
	e.onBoardCleared();
	e.onBoardCleared();
	const ev = e.onBoardCleared();
	assert.ok(kinds(ev).includes('heal'));
	assert.equal(e.hearts, 2);
	assert.equal(e.perfectRun, 0, 'run starts over after a heal');
});

test('heal: explosions do not spoil a perfect board', () => {
	const e = p({ healPerfectBoards: 3 });
	e.mines = [{ cell: 0, fuse: 1 }];
	e.tick(FREE); // explosion on board 1: 3 → 2 hearts
	assert.equal(e.hearts, 2);
	e.onBoardCleared();
	e.onBoardCleared();
	e.onBoardCleared();
	assert.equal(e.hearts, 3, 'the exploded board still counted as perfect');
});

test('heal: at most one heal per round by default', () => {
	const e = p({ healPerfectBoards: 3 });
	e.hearts = 1;
	for (let b = 0; b < 6; b++) e.onBoardCleared();
	assert.equal(e.hearts, 2, 'six perfect boards still heal only once');
	const u = p({ healPerfectBoards: 3, maxHealsPerRound: 0 });
	u.hearts = 1;
	for (let b = 0; b < 6; b++) u.onBoardCleared();
	assert.equal(u.hearts, 3);
});

test('anti-burst: two mines going off on the same move cost one heart', () => {
	const e = p();
	e.mines = [{ cell: 0, fuse: 1 }, { cell: 10, fuse: 1 }];
	const ev = e.tick(FREE);
	assert.equal(kinds(ev).filter((k) => k === 'mineExplode').length, 2, 'both still blast');
	assert.equal(e.hearts, 2);
});

test('ice: with maxIceIncoming 2, extra is dropped; no target cell is shown by default', () => {
	const e = p({ maxIceIncoming: 2 });
	const ev = e.receiveIce(3, FREE);
	assert.equal(e.iceIncoming.length, 2);
	assert.ok(kinds(ev).includes('iceBlocked'));
	assert.ok(e.iceIncoming.every((w) => w.target === -1));
	e.tick(FREE);
	e.tick(FREE);
	e.tick(FREE);
	assert.equal(e.ice.length, 2, 'lands on random free cells');
});

test('defaults: ice lands after 3 moves and stacks without a cap; heal needs 4 perfect boards', () => {
	const e = p();
	e.receiveIce(5, FREE);
	assert.equal(e.iceIncoming.length, 5);
	e.tick(FREE);
	e.tick(FREE);
	assert.equal(e.ice.length, 0);
	e.tick(FREE);
	assert.equal(e.ice.length, 5);
	const h = p();
	h.hearts = 2;
	for (let b = 0; b < 3; b++) h.onBoardCleared();
	assert.equal(h.hearts, 2);
	h.onBoardCleared();
	assert.equal(h.hearts, 3);
});

test('counter-spike (full send-back): a clear cancels the orange bank and sends it back on top', () => {
	const m = new VersusMatch({ seed: 9, rules: { ...VERSUS_RULES, counterSpike: true, counterRate: 1 } });
	const you = m.sides[0];
	const them = m.sides[1];
	you.econ.incoming = [{ count: 10, eta: 50 }]; // far away: stays orange the whole board
	for (const r of you.puzzle.layout) m.act(0, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 });
	assert.equal(you.econ.incomingTotal + you.econ.pool, 0, 'bank wiped');
	assert.equal(them.econ.incomingTotal, 14, '4 for the clear + 10 countered');
});

test('icebreaker: waits for the last 2 boxes, then breaks one cell per move', () => {
	// Six rows, each a 6 at x=0; ice sits in rows 4 and 5.
	const nums = Array.from({ length: 6 }, () => [6, 0, 0, 0, 0, 0]);
	const row = (y) => ({ x1: 0, y1: y, x2: 5, y2: y });
	const board = { N: 6, nums, rects: [0, 1].map(row) };
	const e = p();
	e.ice = [29, 35].map((cell, seq) => ({ cell, thaw: 4 - seq, seq, landedTick: -1 }));
	assert.equal(e.checkStuckAndForceBreak(board, 4).length, 0, '4 boxes left, rows 2–3 still free: too early');
	board.rects = [0, 1, 2, 3].map(row);
	const first = e.checkStuckAndForceBreak(board, 2);
	assert.equal(first.length, 1, 'one cell per move');
	assert.equal(first[0].cell, 35, 'nearest to thaw first');
	assert.equal(e.checkStuckAndForceBreak(board, 2).length, 0, 'row 5 is free now: place it first');
	board.rects.push(row(5));
	assert.equal(e.checkStuckAndForceBreak(board, 1).length, 1, 'then the last ice breaks');
	assert.equal(e.ice.length, 0);
});

test('icebreaker: steps in early when ice leaves no legal move at all', () => {
	// 2×2 board, clues at (0,0)=2 and (1,1)=2; ice on (1,0) and (0,1) blocks every box.
	const board = { N: 2, nums: [[2, 0], [0, 2]], rects: [] };
	const e = p({ icebreakAtBoxesLeft: 1 });
	e.ice = [{ cell: 1, thaw: 2, seq: 0, landedTick: -1 }, { cell: 2, thaw: 4, seq: 1, landedTick: -1 }];
	assert.equal(e.hasIceFreeMove(board), false);
	const ev = e.checkStuckAndForceBreak(board, 2);
	assert.deepEqual(kinds(ev), ['forceBreak'], 'one cell, even though 2 boxes > the last-1 rule');
	assert.equal(ev[0].cell, 1, 'nearest to thaw');
	assert.equal(e.hasIceFreeMove(board), true);
});

test('rule C: a bank of 4+ left sitting for 6 moves queues an ice', () => {
	const e = p();
	e.incoming = [{ count: 8, eta: 50 }];
	for (let i = 0; i < 5; i++) e.tick(FREE);
	assert.equal(e.iceIncoming.length, 0);
	const ev = e.tick(FREE);
	assert.ok(kinds(ev).includes('bankFreeze'));
	assert.equal(e.iceIncoming.length, 1);
	const off = p({ bankFreezeEvery: 0 });
	off.incoming = [{ count: 8, eta: 50 }];
	for (let i = 0; i < 12; i++) off.tick(FREE);
	assert.equal(off.iceIncoming.length, 0);
});

test('idle tick: the clock moves without a move, so stalling stops working', () => {
	const m = new VersusMatch({ seed: 12 });
	const e = m.sides[0].econ;
	e.mines = [{ cell: m.sides[0].landable()[0], fuse: 1 }];
	const r = m.idleTick(0);
	assert.ok(r.events.some((x) => x.kind === 'mineExplode'));
	assert.equal(e.hearts, 2);
});

test('icebreaker never leaves you with no legal box (three ice on the last two boxes)', async () => {
	const { vsBoard } = await import('../engine/match.js');
	const m = new VersusMatch({ seed: 416076 });
	m.newRound();
	const s = m.sides[0];
	s.boardIndex = 4;
	s.deal(vsBoard(m.roundSeed, 4));
	for (const r of s.puzzle.layout) if (!(r.x1 === 1 && r.y1 === 4) && !(r.x1 === 4 && r.y1 === 0)) m.act(0, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 });
	const e = s.econ;
	e.mines = [];
	e.iceIncoming = [];
	e.ice = [17, 28, 33].map((cell, i) => ({ cell, thaw: 3, seq: i, landedTick: 0 }));
	e.checkStuckAndForceBreak(s.board(), 2);
	assert.ok(e.hasIceFreeMove(s.board()), 'a legal box must remain');
});

test('clustered landing: a batch lands inside one box first, then the nearest cells', () => {
	const e = p({ mineCluster: true, batchSize: 6, mineCap: 6 });
	// 6x6: region 0 = left 3x6 (18 cells), region 1 = right 3x6.
	const regionOf = Array.from({ length: 36 }, (_, c) => (c % 6 < 3 ? 0 : 1));
	e.pool = 4;
	e.tick(FREE, regionOf);
	const regs = new Set(e.mines.map((m) => regionOf[m.cell]));
	assert.equal(e.mines.length, 4);
	assert.equal(regs.size, 1);
});

test('defuse-clear: mines defused by the clearing box add to the attack; clutch is flagged', () => {
	const e = p({ defuseClearBonus: 1 });
	e.mines = [{ cell: 0, fuse: 1 }, { cell: 1, fuse: 3 }];
	const ev = e.onPlacement([0, 1], []);
	assert.deepEqual(ev.filter((x) => x.kind === 'defuse').map((x) => x.clutch).sort(), [false, true]);
	const clear = e.onBoardCleared()[0];
	assert.equal(clear.defuseBonus, 2);
	assert.equal(clear.sendMines, e.rules.clearSend + 2);
});

test('frost (no arming delay): early defuses charge it, it fires when full, holds on the last 4 boxes and fires with the clear', () => {
	const e = p({ frostArmMoves: 0 });
	e.mines = [0, 1, 2, 3].map((cell) => ({ cell, fuse: 3 }));
	e.onPlacement([0, 1, 2, 3], []);
	assert.equal(e.frost, 4);
	assert.deepEqual(e.settleFrost(5, false), [{ kind: 'frostFire', count: 1, deflected: 0, withClear: false }]);
	assert.equal(e.frost, 0);
	e.frost = 7;
	assert.deepEqual(e.settleFrost(3, false), []); // held
	assert.equal(e.frost, 7);
	assert.deepEqual(e.settleFrost(0, true), [{ kind: 'frostFire', count: 1, deflected: 0, withClear: true }]);
	assert.equal(e.frost, 3);
	e.frost = 30;
	e.settleFrost(2, false);
	assert.equal(e.frost, 12); // capped while held: 3 ice at most
});

test('frost: finishing ice off by building charges +2 and sends nothing directly', () => {
	const e = p();
	e.ice = [{ cell: 6, thaw: 2, seq: 0, landedTick: -1 }];
	e.onPlacement([0], [6]);
	assert.equal(e.frost, 2);
	assert.equal(e.drainOut().ice, 0);
});

test('clutch: a mine covered on its last tick cancels one incoming, from the red batch if the bank is empty', () => {
	const e = p();
	e.incoming = [{ count: 3, eta: 1 }];
	e.mines = [{ cell: 0, fuse: 1 }];
	const ev = [...e.onPlacement([0], []), ...e.tick(FREE)]; // a clutch resolves on this move's tick
	assert.deepEqual(ev.find((x) => x.kind === 'clutch'), { kind: 'clutch', cell: 0, cancelled: 1 });
	assert.equal(e.incomingTotal + e.pool + e.mines.length, 2);
	assert.equal(e.frost, 0); // clutch is defense, not frost
});

test('grace: nothing lands on the clearing move or the first move of the new board', () => {
	const e = p();
	e.pool = 6;
	e.iceIncoming = [{ eta: 1, target: -1 }];
	e.onBoardCleared();
	e.pool = 6; // the red batch survives the clear
	e.iceIncoming = [{ eta: 1, target: -1 }];
	e.tick(FREE); // the clearing move's tick
	e.tick(FREE); // first move on the new board
	assert.equal(e.mines.length, 0);
	assert.equal(e.ice.length, 0);
	e.tick(FREE); // second move: it all drops
	assert.equal(e.mines.length, 6);
	assert.equal(e.ice.length, 1);
});

test('heal checkpoint: after 2 perfect boards a sloppy clear drops the run to 2, not 0', () => {
	const e = p();
	e.onBoardCleared();
	e.onBoardCleared();
	e.onBoardCleared();
	assert.equal(e.perfectRun, 3);
	e.onErase();
	e.onBoardCleared();
	assert.equal(e.perfectRun, 2);
	const f = p();
	f.onBoardCleared();
	f.onErase();
	f.onBoardCleared();
	assert.equal(f.perfectRun, 0);
});

test('freeze-over loses the board: no KO, mines return to red, next board, pause', () => {
	const m = new VersusMatch({ seed: 21 });
	m.startClock(1000);
	const s = m.sides[0];
	const e = s.econ;
	const before = s.boardIndex;
	e.mines = [{ cell: s.landable()[0], fuse: 3 }];
	e.ice = [0, 1, 2].map((k, seq) => ({ cell: s.landable()[k + 1], thaw: 4, seq, landedTick: -1 }));
	e.iceIncoming = [{ eta: 1, target: -1 }];
	const ev = m.idleTick(0).events;
	assert.ok(ev.some((x) => x.kind === 'frozenOut'));
	assert.equal(s.boardIndex, before + 1);
	assert.equal(e.ice.length, 0);
	assert.equal(e.mines.length, 0);
	assert.equal(e.pool, 1);
	assert.ok(!m.roundOver);
	assert.equal(m.act(0, { type: 'erase', x: 0, y: 0 }, 1200).denied, 'paused');
});

test('no spill: icebroken ice is gone for good', () => {
	const e = p();
	e.ice = [{ cell: 5, thaw: 4, seq: 0, landedTick: -1 }];
	e.forceBreakAt(5);
	assert.equal(e.spill, 0);
});

test('old counter-spike, red first: a clear cancels the red batch before the orange bank, and sends nothing back', () => {
	const m = new VersusMatch({ seed: 9, rules: { ...VERSUS_RULES, counterSpike: true } });
	const you = m.sides[0];
	for (const r of you.puzzle.layout.slice(0, -1)) m.act(0, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 });
	you.econ.pool = 3;
	you.econ.incoming = [{ count: 20, eta: 50 }];
	const last = you.puzzle.layout[you.puzzle.layout.length - 1];
	const ev = m.act(0, { type: 'place', ax: last.x1, ay: last.y1, bx: last.x2, by: last.y2 }).events;
	const send = ev.find((x) => x.kind === 'send');
	assert.equal(send.cancelled, 12);
	assert.equal(send.pass, 4);
	assert.equal(you.econ.pool, 0, 'red cancelled first');
});

test('icebreak on the last boxes earns frost; defuse tiers: only a fresh defuse charges frost', () => {
	const e = p();
	e.mines = [{ cell: 0, fuse: 3 }, { cell: 1, fuse: 2 }];
	e.onPlacement([0, 1], []);
	assert.equal(e.frost, 1);
});

test('gravity is lazy: owed ticks are paid from timestamps, and a frozen side owes nothing', () => {
	const m = new VersusMatch({ seed: 4 });
	m.startClock(0);
	const t0 = m.sides[0].econ.ticks;
	m.catchUp(9500); // 3 ticks at 3s
	assert.equal(m.sides[0].econ.ticks - t0, 3);
	m.freezeSide(1, 9500);
	const t1 = m.sides[1].econ.ticks;
	m.catchUp(30000);
	assert.equal(m.sides[1].econ.ticks, t1, 'frozen while disconnected');
	m.thawSide(1, 30000);
	m.catchUp(33100);
	assert.equal(m.sides[1].econ.ticks, t1 + 1);
});

test('snapshot round-trip: a restored match plays on identically', () => {
	const a = new VersusMatch({ seed: 77 });
	a.startClock(0);
	const bots = [new TiltBot({ seed: 1 }), new TiltBot({ seed: 2 })];
	let t = 0;
	for (let k = 0; k < 60 && !a.roundOver; k++) {
		t += 900;
		a.catchUp(t);
		a.act(k % 2, bots[k % 2].decide(a.sides[k % 2]), t);
	}
	const st = JSON.parse(JSON.stringify(a.toState()));
	const b = VersusMatch.fromState(st, a.rules);
	assert.deepEqual(b.toState(), a.toState());
	const moves = [];
	const bots2 = [new TiltBot({ seed: 5 }), new TiltBot({ seed: 6 })];
	for (let k = 0; k < 40 && !a.roundOver; k++) {
		t += 700;
		const i = k % 2;
		const mv = bots2[i].decide(a.sides[i]);
		moves.push([i, mv, t]);
		a.catchUp(t);
		a.act(i, mv, t);
	}
	for (const [i, mv, tt] of moves) {
		b.catchUp(tt);
		b.act(i, mv, tt);
	}
	assert.deepEqual(b.toState(), a.toState());
	assert.ok(JSON.stringify(st).length < 6000, 'snapshot stays small: ' + JSON.stringify(st).length);
});

test('frost arms for one move mid-board, then fires; held ice shows armed and fires with the clear', () => {
	const e = p();
	e.frost = 4;
	assert.deepEqual(e.settleFrost(6, false), []);
	assert.equal(e.armed, 1, 'armed, not fired');
	assert.deepEqual(e.settleFrost(6, false), [{ kind: 'frostFire', count: 1, deflected: 0, withClear: false }]);
	assert.equal(e.armed, 0);
	e.frost = 9;
	e.settleFrost(3, false);
	assert.equal(e.armed, 2, 'held on the last boxes shows armed');
	assert.deepEqual(e.settleFrost(0, true), [{ kind: 'frostFire', count: 2, deflected: 0, withClear: true }]);
	assert.equal(e.frost, 1);
});

test('combo: clears in a row add to the attack on a capped ramp; damage breaks it, do-overs do not', () => {
	const e = p({ healPerfectBoards: 0 });
	const sends = [];
	for (let i = 0; i < 10; i++) {
		if (i === 3) e.onErase(); // a do-over keeps the combo
		sends.push(e.onBoardCleared()[0].sendMines);
	}
	assert.deepEqual(sends, [4, 5, 5, 6, 6, 7, 7, 8, 8, 8]);
	e.mines = [{ cell: 0, fuse: 1 }];
	const ev = e.tick(FREE);
	assert.ok(ev.some((x) => x.kind === 'comboBreak' && x.combo === 10));
	assert.equal(e.combo, 0);
	assert.equal(e.onBoardCleared()[0].sendMines, 4);
});

test('gravity: a move resets the timer, so a tick never lands right after a move', () => {
	const m = new VersusMatch({ seed: 7 });
	m.startClock(0);
	const s = m.sides[0];
	const placed = () => new Set(s.rects.map((r) => [r.x1, r.y1, r.x2, r.y2].join()));
	const nextBox = () => s.puzzle.layout.find((l) => !placed().has([l.x1, l.y1, l.x2, l.y2].join()) && !s.isRectBlocked(l));
	const move = (at) => {
		m.catchUp(at);
		const r = nextBox();
		return m.act(0, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 }, at);
	};
	assert.ok(move(2900).moved);
	const ticks = s.econ.ticks;
	assert.equal(m.catchUp(3100).filter((e) => e.side === 'you' && e.kind === 'gravity').length, 0, 'no tick 200ms after a move');
	assert.equal(m.catchUp(5899).filter((e) => e.side === 'you' && e.kind === 'gravity').length, 0);
	assert.equal(m.catchUp(5900).filter((e) => e.side === 'you' && e.kind === 'gravity').length, 1, 'ticks 3s after the last move');
	assert.equal(s.econ.ticks, ticks + 1);
});

test('clutch only counts on a move where nothing goes off', () => {
	const e = p();
	e.incoming = [{ count: 5, eta: 3 }];
	e.mines = [{ cell: 0, fuse: 1 }, { cell: 9, fuse: 1 }];
	const ev = [...e.onPlacement([0], []), ...e.tick(FREE)];
	assert.ok(ev.some((x) => x.kind === 'mineExplode'));
	assert.ok(!ev.some((x) => x.kind === 'clutch'), 'no clutch when a mine blew on the same move');
	assert.equal(e.incomingTotal, 5, 'and nothing was cancelled');
	const f = p();
	f.incoming = [{ count: 5, eta: 3 }];
	f.mines = [{ cell: 0, fuse: 1 }];
	const ev2 = [...f.onPlacement([0], []), ...f.tick(FREE)];
	assert.deepEqual(ev2.filter((x) => x.kind === 'clutch').map((x) => x.cancelled), [1]);
	assert.equal(f.incomingTotal, 4);
});

test('frost deflects incoming ice first, soonest first; only the rest goes out', () => {
	const e = p({ frostArmMoves: 0 });
	e.iceIncoming = [{ eta: 2, target: -1 }, { eta: 1, target: -1 }];
	e.frost = 12;
	assert.deepEqual(e.settleFrost(10, false), [{ kind: 'frostFire', count: 1, deflected: 2, withClear: false }]);
	assert.equal(e.iceIncoming.length, 0);
	assert.equal(e.outIce, 1);
	const f = p({ frostArmMoves: 0 });
	f.iceIncoming = [{ eta: 2, target: -1 }, { eta: 1, target: -1 }];
	f.frost = 4;
	f.settleFrost(10, false);
	assert.deepEqual(f.iceIncoming.map((w) => w.eta), [2], 'the soonest one is deflected');
});

test('Mines mode has no ice source at all', () => {
	const m = new VersusMatch({ rules: MINES_RULES, seed: 3 });
	const bots = [new TiltBot({ seed: 1, misplay: 0.2 }), new TiltBot({ seed: 2, misplay: 0.2 })];
	let ice = 0;
	for (let g = 0; g < 4000 && !m.roundOver; g++) for (const e of m.act(g % 2, bots[g % 2].decide(m.sides[g % 2])).events) if (e.kind === 'iceIncoming' || e.kind === 'frozen') ice++;
	assert.ok(m.roundOver, 'the round ends');
	assert.equal(ice, 0);
});

// Net cancel (Krischan, 2026-11-08): the attack is spent cancelling first; only the rest is sent.
const clearAll = (m, i) => {
	const s = m.sides[i];
	let ev = [];
	for (const r of s.puzzle.layout) ev = ev.concat(m.act(i, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 }).events);
	return ev;
};
test('net cancel (default): a 4-Mine clear against 3 red + 20 orange cancels 4, red first, and sends nothing', () => {
	const m = new VersusMatch({ seed: 9 });
	const you = m.sides[0];
	for (const r of you.puzzle.layout.slice(0, -1)) m.act(0, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 });
	you.econ.pool = 3;
	you.econ.incoming = [{ count: 20, eta: 50 }];
	const last = you.puzzle.layout[you.puzzle.layout.length - 1];
	const send = m.act(0, { type: 'place', ax: last.x1, ay: last.y1, bx: last.x2, by: last.y2 }).events.find((x) => x.kind === 'send');
	assert.equal(send.count, 4);
	assert.equal(send.cancelled, 4);
	assert.equal(send.pass, 0);
	assert.equal(send.counter, false);
	assert.equal(you.econ.pool, 0, 'red cancelled first');
	assert.equal(you.econ.incomingTotal, 19);
	assert.equal(m.sides[1].econ.incomingTotal, 0);
});
test('net cancel: send 14 against 12 incoming, cancel 12 and send 2', () => {
	const m = new VersusMatch({ seed: 9, rules: { ...VERSUS_RULES, clearSend: 14 } });
	const you = m.sides[0];
	you.econ.incoming = [{ count: 12, eta: 50 }];
	const send = clearAll(m, 0).find((x) => x.kind === 'send');
	assert.deepEqual([send.count, send.cancelled, send.pass], [14, 12, 2]);
	assert.equal(m.sides[1].econ.incomingTotal, 2);
});
test('Rush ramp: ×1 before 2:00, ×3 from 2:00, ×5 from 3:00', () => {
	const m = new VersusMatch({ seed: 9 });
	m.startClock(0, 0);
	const at = (s) => {
		m.clock = m.roundStartAt + s * 1000;
		return m.rushFactor;
	};
	assert.deepEqual([at(0), at(119), at(120), at(179), at(180), at(400)], [1, 1, 3, 3, 5, 5]);
	assert.equal(new VersusMatch({ seed: 9, rules: { ...VERSUS_RULES, rushEarlySecs: 0 } }).rushFactor, 1);
});

test('Rush boards: from the first Rush step a new Board has at most 7 Givens, a snapshot rebuilds it, old rules are untouched', () => {
	const solve = (m, i) => {
		for (const r of m.sides[i].puzzle.layout) m.act(i, { type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 }, m.clock);
	};
	const run = (rules, secs) => {
		const m = new VersusMatch({ seed: 5, rules });
		m.startClock(0, 0);
		m.clock = m.roundStartAt + secs * 1000;
		solve(m, 0);
		return m;
	};
	// Before the first Rush step: the usual cap of 10.
	assert.equal(run(VERSUS_RULES, 119).sides[0].rushCap || 0, 0);
	// After it: every Board dealt has at most 7 Givens, and a snapshot gives the same Board back.
	let seen = 0;
	for (let seed = 1; seed <= 30; seed++) {
		const m = new VersusMatch({ seed, rules: VERSUS_RULES });
		m.startClock(0, 0);
		m.clock = m.roundStartAt + 130 * 1000;
		for (let k = 0; k < 3; k++) {
			solve(m, 0);
			assert.ok(m.sides[0].puzzle.layout.length <= 7, 'at most 7 Givens in Rush');
			seen++;
		}
		const back = VersusMatch.fromState(JSON.parse(JSON.stringify(m.toState())), VERSUS_RULES);
		assert.deepEqual(back.sides[0].puzzle.layout, m.sides[0].puzzle.layout);
	}
	assert.equal(seen, 90);
	// Rules recorded before the cap existed (no rushMaxGivens) deal exactly as before.
	const { rushMaxGivens, ...old } = VERSUS_RULES;
	const o = run(old, 130);
	assert.equal(o.sides[0].rushCap || 0, 0);
	assert.ok(!('rc' in o.toState().sides[0]));
});

test('a perfect Board gives 1 Frost; a Board with a Do-Over gives none', () => {
	const e = p();
	e.onBoardCleared();
	assert.equal(e.frost, 1);
	const d = p();
	d.onErase();
	d.onBoardCleared();
	assert.equal(d.frost, 0);
});
test('Frost shield (off by default): with 2 Frost, a Frozen Cell is blocked and 2 Frost spent', () => {
	const off = p();
	off.frost = 3;
	off.receiveIce(1, FREE);
	for (let k = 0; k < 3; k++) off.tick(FREE);
	assert.equal(off.ice.length, 1, 'off: it lands');
	const e = p({ frostShield: 2 });
	e.frost = 3;
	e.receiveIce(2, FREE);
	let ev = [];
	for (let k = 0; k < 3; k++) ev = ev.concat(e.tick(FREE));
	assert.equal(ev.filter((x) => x.kind === 'shield').length, 1);
	assert.equal(e.frost, 1);
	assert.equal(e.ice.length, 1, 'the second one lands: not enough Frost left');
});
