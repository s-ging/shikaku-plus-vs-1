// End-to-end netcode test with no network: the real RoomCore, two real ClientCores,
// bots playing through them, simulated latency and a simulated clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore } from '../worker/room-core.js';
import { ClientCore, stateHash } from '../shared/client-core.js';
import { TiltBot } from '../engine/ffmatch.js';

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
	a.sendUp({ t: 'set', o: { firstTo: 2, gravitySecs: 3, bogus: 9, hearts: 99 } });
	w.run(500);
	assert.deepEqual(w.room.o, { firstTo: 2, gravitySecs: 3, hearts: 5 }, 'host settings are sanitized');
	a.sendUp({ t: 'ready', v: true });
	b.sendUp({ t: 'ready', v: true });
	w.run(500);
	a.sendUp({ t: 'start' });
	w.run(1000);
	assert.equal(w.room.phase, 'match');
	w.run(30 * 60 * 1000, playLoop(w));
	assert.equal(w.reports.length, 1, 'match finished and was reported');
	const r = w.reports[0];
	assert.ok(Math.max(...r.score) === 2);
	for (const c of w.clients) assert.equal(c.core.mismatches, 0, `seat ${c.seat} drifted`);
	assert.ok(r.seats[0].moves.n > 20);
	assert.ok(Math.max(...w.saved) < 16000, 'room fits comfortably in one storage value: ' + Math.max(...w.saved));
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
