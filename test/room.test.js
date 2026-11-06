// End-to-end netcode test with no network: the real RoomCore, two real ClientCores,
// bots playing through them, simulated latency and a simulated clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore } from '../worker/room-core.js';
import { ClientCore, stateHash } from '../shared/client-core.js';
import { TiltBot } from '../engine/versus-match.js';

function world({ latency = [40, 140], o = { firstTo: 2 } } = {}) {
	let now = 1_000_000;
	const q = []; // { at, fn }
	const later = (ms, fn) => q.push({ at: now + ms, fn, k: q.length });
	const conns = new Map(); // id → { open }
	const saved = [];
	const reports = [];
	const clients = [];
	const io = {
		send: (conn, obj) => later(latency[conn.seat], () => conn.client.inbox(JSON.parse(JSON.stringify(obj)))),
		conns: () => [...conns.values()].filter((c) => c.open).map((c) => ({ conn: c, id: c.id })),
		save: (obj) => saved.push(JSON.stringify(obj).length),
		report: (r) => reports.push(r)
	};
	const room = new RoomCore('QWER', io, 'sekrit', null);
	function addClient(seat, id, k) {
		const conn = { id, seat, open: true };
		const c = {
			seat,
			id,
			conn,
			core: null,
			room: null,
			bot: new TiltBot({ seed: 100 + seat, misplay: 0.05, defuseFirst: 0.9 }),
			inbox(msg) {
				if (!c.conn.open) return;
				if (msg.t === 'room') {
					c.room = msg;
					c.core.me = msg.you;
				} else c.core.handle(msg);
			},
			sendUp(obj) {
				(c.sentTypes ||= []).push(obj.t);
				const cn = c.conn;
				if (!cn.open || c.mute) return;
				const data = JSON.parse(JSON.stringify(obj));
				later(latency[seat], () => cn.open && (data.t === 'hello' ? room.hello(id, data, now) : room.message(id, data, now)));
			}
		};
		c.core = new ClientCore({ send: (o2) => c.sendUp(o2), now: () => now });
		conn.client = c;
		conns.set(id, conn);
		clients[seat] = c;
		c.sendUp({ t: 'hello', id, name: 'P' + seat, k, dev: { ua: 'test' } });
		return c;
	}
	/** Same browser, same ClientCore, new socket: what a reconnect after a dropout looks like. */
	function reconnect(seat) {
		const c = clients[seat];
		const conn = { id: c.id, seat, open: true, client: c };
		c.conn = conn;
		conns.set(c.id + ':' + now, conn);
		c.sendUp({ t: 'hello', id: c.id, name: 'P' + seat });
	}
	function drop(seat) {
		const c = clients[seat];
		c.conn.open = false;
		room.closed(c.id, now);
	}
	function run(ms, onStep) {
		const end = now + ms;
		while (now < end) {
			q.sort((a, b) => a.at - b.at || a.k - b.k);
			const nextAt = q.length ? Math.min(q[0].at, now + 50) : now + 50;
			now = Math.min(Math.max(nextAt, now), end);
			while (q.length && q[0].at <= now) q.shift().fn();
			onStep?.(now);
		}
	}
	return { room, addClient, drop, reconnect, run, clients, reports, saved, o, get now() { return now; } };
}

function playLoop(w, pace = [900, 1300]) {
	const due = [0, 0];
	return (now) => {
		for (const c of w.clients) {
			if (!c || !c.conn.open || !c.core.predicted) continue;
			c.core.tick();
			const m = c.core.confirmed;
			if (m.roundOver) {
				if (!c.sentNext || c.sentNext !== m.round) {
					c.sentNext = m.round;
					c.sendUp({ t: 'next' });
				}
				continue;
			}
			if (now >= due[c.seat]) {
				due[c.seat] = now + pace[c.seat];
				const p = c.core.predicted;
				if (!p.roundOver) c.core.move(c.bot.decide(p.sides[c.core.me]) || { type: 'erase', x: 0, y: 0 });
			}
		}
	};
}

test('two clients play a whole match through the room with no drift', () => {
	const w = world();
	const a = w.addClient(0, 'aaaaaaaa1', null);
	const b = w.addClient(1, 'bbbbbbbb2', null);
	w.run(500);
	assert.equal(w.room.seats.length, 2);
	a.sendUp({ t: 'set', o: { firstTo: 1, gravitySecs: 3, bogus: 9, hearts: 99 } });
	w.run(500);
	assert.deepEqual(w.room.o, { firstTo: 1, gravitySecs: 3, hearts: 5 }, 'host settings are sanitized');
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(500);
	a.sendUp({ t: 'start' });
	w.run(1000);
	assert.equal(w.room.phase, 'match');
	w.run(30 * 60 * 1000, playLoop(w));
	assert.equal(w.reports.length, 1, 'match finished and was reported');
	const r = w.reports[0];
	assert.ok(Math.max(...r.score) === 1);
	assert.equal(r.result, 'finished');
	assert.match(r.seats[0].tester, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
	for (const c of w.clients) assert.equal(c.core.mismatches, 0, `seat ${c.seat} drifted`);
	assert.ok(r.seats[0].moves.n > 20);
	// The saved room carries this round's replay so far (2026-11-05). Writes are billed per row, not by size, and a value can hold 2MB.
	assert.ok(Math.max(...w.saved) < 48000, 'room fits comfortably in one storage value: ' + Math.max(...w.saved));
});

test('a dropped player freezes; reconnecting offers a remake vote; both yes replays the round', () => {
	const w = world({ o: { firstTo: 3 } });
	const a = w.addClient(0, 'aaaaaaaa1', 'sekrit');
	const b = w.addClient(1, 'bbbbbbbb2', null);
	w.run(300);
	a.sendUp({ t: 'set', o: { firstTo: 3 } });
	w.run(300);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(300);
	a.sendUp({ t: 'start' });
	w.run(500);
	assert.ok(w.room.seats[0].admin && !w.room.seats[1].admin, 'only the secret makes an admin');
	w.run(8000, playLoop(w));
	const round = w.room.match.round;
	const ticksBefore = w.room.match.sides[1].econ.ticks;
	w.drop(1);
	w.run(15000, playLoop(w));
	assert.ok(w.room.match.sides[1].econ.ticks <= ticksBefore + 1, 'no gravity while disconnected');
	const b2 = w.addClient(1, 'bbbbbbbb2', null);
	w.run(600);
	assert.ok(w.room.vote, 'remake vote opened');
	assert.ok(b2.core.confirmed, 'reconnected client got the full state');
	const score = [...w.room.match.score];
	a.sendUp({ t: 'vote', v: true });
	b2.sendUp({ t: 'vote', v: true });
	w.run(600);
	assert.equal(w.room.match.round, round + 1, 'round replayed');
	assert.deepEqual(w.room.match.score, score, 'no score for a remake');
	assert.equal(w.room.report.votes.length, 2, 'votes are logged');
	w.run(5000, playLoop(w));
	for (const c of [a, b2]) assert.equal(c.core.mismatches, 0);
	assert.equal(stateHash(a.core.confirmed), stateHash(w.room.match));
});

test('a third player is turned away; refused moves are answered only to the mover', () => {
	const w = world();
	w.addClient(0, 'aaaaaaaa1');
	w.addClient(1, 'bbbbbbbb2');
	w.run(300);
	const c = w.addClient(1, 'cccccccc3');
	w.run(300);
	assert.equal(w.room.seats.length, 2);
	assert.ok(!c.core.confirmed);
});

test('a silent player (dead socket that never closed) is frozen after 20s, and resumes when heard from', () => {
	const w = world();
	const a = w.addClient(0, 'aaaaaaaa1');
	const b = w.addClient(1, 'bbbbbbbb2');
	w.run(300);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(300);
	a.sendUp({ t: 'start' });
	w.run(500);
	const loopA = playLoop(w);
	// Only A acts; B's socket stays "open" but sends nothing.
	b.mute = true;
	b.sentTypes = [];
	w.run(24000, (now) => {
		const keep = b.conn.open;
		b.conn.open = false;
		loopA(now);
		b.conn.open = keep;
	});
	b.mute = false;
	assert.ok(w.room.seats[1].left != null, 'B frozen after going silent');
	assert.ok(w.room.match.sides[1].frozenAt != null);
	b.sendUp({ t: 'sync' });
	w.run(400);
	assert.equal(w.room.seats[1].left, null, 'B resumed');
	assert.equal(w.room.match.sides[1].frozenAt, null);
	w.run(3000, playLoop(w));
	assert.equal(b.core.mismatches, 0);
});

test('a player keeps playing through a dropout; queued moves land on reconnect, once each', () => {
	const w = world();
	const a = w.addClient(0, 'aaaaaaaa1');
	const b = w.addClient(1, 'bbbbbbbb2');
	w.run(300);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(300);
	a.sendUp({ t: 'start' });
	w.run(500);
	w.run(4000, playLoop(w));
	// B's line drops (socket closed); B keeps placing boxes locally for 5 seconds.
	w.drop(1);
	const placedBefore = w.room.match.sides[1].rects.length;
	let made = 0;
	w.run(5000, (now) => {
		const p = b.core.predicted;
		if (now % 1000 < 60 && !p.roundOver) {
			const s = p.sides[1];
			const have = new Set(s.rects.map((r) => `${r.x1},${r.y1},${r.x2},${r.y2}`));
			const r = s.puzzle.layout.find((l) => !have.has(`${l.x1},${l.y1},${l.x2},${l.y2}`));
			if (r && b.core.move({ type: 'place', ax: r.x1, ay: r.y1, bx: r.x2, by: r.y2 }).moved) made++;
		}
	});
	assert.ok(made >= 3, 'B kept playing offline: ' + made);
	assert.equal(w.room.match.sides[1].rects.length, placedBefore, 'server has not seen them yet');
	w.reconnect(1);
	w.run(1500);
	assert.equal(b.core.pending.length, 0, 'queued moves confirmed');
	assert.ok(w.room.match.sides[1].econ.ticks > 0);
	const lastS = w.room.seats[1].lastS;
	// Resending the same moves again changes nothing.
	b.sendUp({ t: 'mv', s: lastS, a: ['e', 0, 0] });
	w.run(500);
	assert.equal(w.room.seats[1].lastS, lastS);
	w.run(3000, playLoop(w));
	assert.equal(b.core.mismatches, 0);
	assert.equal(stateHash(b.core.confirmed), stateHash(w.room.match));
});

test('lag: a move made just before a gravity tick, arriving just after it, still resets the tick', () => {
	const w = world({ latency: [150, 40] });
	const a = w.addClient(0, 'aaaaaaaa1', null);
	w.run(500); // a joins first, so a is seat 0 even though its line is slower
	const b = w.addClient(1, 'bbbbbbbb2', null);
	w.run(1000);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(1000);
	a.sendUp({ t: 'start' });
	w.run(400);
	const m = w.room.match;
	assert.ok(m, 'match started');
	const step = m.rules.gravitySecs * 1000;
	const due = m.sides[0].gAt + step;
	const ticks = m.sides[0].econ.ticks;
	// Seat 0 moves 50ms before its tick is due; its message takes 150ms to arrive.
	w.run(due - 50 - w.now);
	assert.ok(a.core.move(a.bot.decide(a.core.predicted.sides[0])).moved);
	// Seat 1's move lands at the server in between, after the tick was due.
	w.run(40);
	b.core.move(b.bot.decide(b.core.predicted.sides[1]));
	w.run(1000);
	assert.equal(w.room.match.sides[0].econ.ticks, ticks + 1, 'only the move ticked seat 0; no gravity tick slipped in before it');
	for (const c of [a, b]) assert.equal(c.core.mismatches, 0);
	assert.equal(stateHash(a.core.confirmed), stateHash(w.room.match));
});

function startedWorld(o) {
	const w = world({ latency: [40, 60] });
	const a = w.addClient(0, 'aaaaaaaa1', null);
	w.run(300);
	const b = w.addClient(1, 'bbbbbbbb2', null);
	w.run(300);
	if (o) a.sendUp({ t: 'set', o });
	w.run(300);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(300);
	a.sendUp({ t: 'start' });
	w.run(200);
	return { w, a, b };
}

test('countdown: nothing moves before the start; rounds then advance by themselves', () => {
	const { w, a } = startedWorld({ firstTo: 3 });
	const m = w.room.match;
	assert.ok(m.roundStartAt > w.now + 2000, 'the round starts after a 3-second countdown');
	const r = a.core.move(a.bot.decide(a.core.predicted.sides[0]) || { type: 'erase', x: 0, y: 0 });
	assert.equal(r.moved, false, 'a move during the countdown is refused locally');
	w.run(3500);
	let firstEnd = null;
	w.run(10 * 60 * 1000, (now) => {
		playLoop(w)(now);
		if (firstEnd == null && w.room.report.rounds.length) firstEnd = now;
	});
	assert.ok(w.room.report.rounds.length >= 2, 'more than one round was played with no "next" from anyone being needed');
	for (const c of w.clients) assert.equal(c.core.mismatches, 0);
});

test('a match everyone leaves is recorded as abandoned; reports add up in /api/stats', async () => {
	const { w } = startedWorld({ firstTo: 3 });
	w.run(8000, playLoop(w));
	w.drop(0);
	w.drop(1);
	w.run(100);
	assert.equal(w.reports.length, 1);
	assert.equal(w.reports[0].result, 'abandoned');
	const { summarize } = await import('../worker/stats.js');
	const s = summarize([...w.reports, { ...w.reports[0], result: 'finished', endedAt: 1, startedAt: 5 }]);
	assert.equal(s.matches.total, 2);
	assert.equal(s.matches.abandoned, 1);
	assert.equal(s.testers.unique, 2);
	assert.equal(s.matches.byFirstTo[3], 2);
});

test('replays: every round rebuilds exactly from its seed and the recorded messages', async () => {
	const { verifyRound, roundAt } = await import('../shared/replay.js');
	const w = world({ latency: [40, 140] });
	const replays = new Map();
	w.room.io.replay = (id, part, data) => {
		if (!replays.has(id)) replays.set(id, []);
		replays.get(id)[part] = JSON.parse(JSON.stringify(data));
	};
	const a = w.addClient(0, 'aaaaaaaa1', null);
	w.run(300);
	const b = w.addClient(1, 'bbbbbbbb2', null);
	w.run(300);
	a.sendUp({ t: 'set', o: { firstTo: 3 } });
	w.run(300);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(300);
	a.sendUp({ t: 'start' });
	w.run(30 * 60 * 1000, playLoop(w));
	assert.equal(replays.size, 1);
	const [header, ...rounds] = [...replays.values()][0];
	assert.ok(header.rules && header.seed && header.names.length === 2);
	assert.ok(rounds.length >= 3, `rounds recorded: ${rounds.length}`);
	for (const rd of rounds.filter(Boolean)) {
		assert.ok(rd.msgs.length > 10);
		assert.ok(verifyRound(header, rd), `round ${rd.round} replays to the server's hash`);
		assert.ok(roundAt(header, rd, rd.msgs.length - 1).roundOver, 'and ends the same way');
	}
	assert.equal(w.reports[0].replayId, header.id);
	const size = JSON.stringify([header, ...rounds]).length;
	assert.ok(size < 120000, 'a whole first-to-3 replay is small: ' + size);
});

test('hovers: passed to the other player only, saved nowhere, kept in the replay, and the replay still matches', async () => {
	const { verifyRound, hoversAt } = await import('../shared/replay.js');
	const w = world({ latency: [40, 60] });
	const replays = new Map();
	w.room.io.replay = (id, part, data) => {
		if (!replays.has(id)) replays.set(id, []);
		replays.get(id)[part] = JSON.parse(JSON.stringify(data));
	};
	const a = w.addClient(0, 'aaaaaaaa1', null);
	w.run(300);
	const b = w.addClient(1, 'bbbbbbbb2', null);
	w.run(300);
	a.sendUp({ t: 'set', o: { firstTo: 1 } });
	w.run(300);
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(300);
	a.sendUp({ t: 'start' });
	w.run(3500);
	const got = { a: [], b: [] };
	for (const [c, k] of [[a, 'a'], [b, 'b']]) {
		const inbox = c.inbox;
		c.inbox = (msg) => (msg.t === 'hv' ? got[k].push(msg) : inbox(msg));
	}
	const saves = w.saved.length;
	a.sendUp({ t: 'hv', r: [0, 0, 1, 2] });
	a.sendUp({ t: 'hv', r: [9, 9, 9, 9] }); // off the board: passed on as "cleared"
	w.run(300);
	assert.equal(w.saved.length, saves, 'a hover writes nothing');
	assert.deepEqual(got.b.map((m) => m.r), [[0, 0, 1, 2], null]);
	assert.equal(got.a.length, 0, 'never echoed to the sender');
	const step = playLoop(w);
	w.run(30 * 60 * 1000, (now) => {
		if (Math.random() < 0.3) a.sendUp({ t: 'hv', r: [1, 1, 2, 2] });
		step(now);
	});
	const [header, ...rounds] = [...replays.values()][0];
	const rd = rounds.find(Boolean);
	assert.ok(rd.msgs.some((x) => x[0] === 'v'), 'hovers are in the replay');
	assert.ok(verifyRound(header, rd), 'and the replay still lands on the server hash');
	assert.equal(hoversAt(rd, -1)[0], null);
});

test('clock check: the server answers a time ping at once, unsequenced and unsaved', () => {
	const w = world({ latency: [40, 60] });
	const a = w.addClient(0, 'aaaaaaaa1', null);
	w.run(300);
	const got = [];
	const inbox = a.inbox;
	a.inbox = (msg) => (msg.t === 'time' ? got.push(msg) : inbox(msg));
	const saves = w.saved.length;
	a.sendUp({ t: 'time', c: 12345 });
	w.run(200);
	assert.equal(got.length, 1);
	assert.equal(got[0].c, 12345);
	assert.ok(got[0].s > 0);
	assert.equal(w.saved.length, saves);
});
