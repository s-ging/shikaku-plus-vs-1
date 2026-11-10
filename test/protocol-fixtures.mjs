// protocol-fixtures.mjs — writes the test data the app's Dart port of the protocol and
// netcode must reproduce (2026-11-11). Run: node test/protocol-fixtures.mjs
// It writes test/fixtures/protocol_parity.json; copy that file to the app as
// test/fixtures/vs_protocol_parity.json. test/protocol-fixtures.test.js fails when the
// committed file no longer matches what this script makes, so a protocol or engine change
// can't leave the app's test data silently stale.
//
// What's in it:
//   actions   encodeAction / decodeAction, including what decode refuses
//   codes     isRoomCode, parseRoomPath, testerCode, newRoomCode (fed fixed random numbers)
//   hashes    whole bot matches played on the bare engine: stateHash after every step
//             (chained into one number), plus snapshots (toState) at checkpoints with their hash
//   sessions  real rooms (worker/room-core.js) and real clients (shared/client-core.js) with
//             simulated latency and clock: every message each client received and sent, byte
//             for byte, and each client's confirmed/predicted hashes after every call. This is the
//             "recorded games" data: feed a client the same calls, get the same messages and hashes.
//             Log entries: ['in', at, raw, confirmedHash, predictedHash, pending] a server message
//             ['out', at, raw] sent · ['move', at, action, moved, c, p, pending] · ['tick', at, c, p, pending]
//             (only ticks that did something) · ['inject', at, action, c, p, pending] a move sent though
//             the prediction was stale · ['close', at] / ['open', at] the socket dropped / came back.
//
// Everything here is deterministic: fixed seeds, a fake clock, and a seeded stand-in for
// crypto.getRandomValues (the room's replay id).
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RoomCore } from '../worker/room-core.js';
import { ClientCore } from '../shared/client-core.js';
import { VersusMatch, TiltBot, BOT_PRESETS } from '../engine/versus-match.js';
import { VERSUS_RULES, MINES_RULES } from '../engine/versus.js';
import { encodeAction, decodeAction, stateHash, isRoomCode, parseRoomPath, testerCode, newRoomCode, PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '../shared/protocol.js';

/** Park–Miller, the same tiny picker as the engine parity harness. */
function picker(s) {
	let x = (s % 2147483646) + 1;
	return () => (x = (x * 48271) % 2147483647);
}

function withSeededCrypto(seed, fn) {
	const c = globalThis.crypto;
	const orig = c.getRandomValues;
	const r = picker(seed);
	c.getRandomValues = (a) => {
		for (let i = 0; i < a.length; i++) a[i] = r() & 0xff;
		return a;
	};
	try {
		return fn();
	} finally {
		c.getRandomValues = orig;
	}
}

// —— actions and codes ——
function actions() {
	const enc = [
		{ type: 'place', ax: 0, ay: 0, bx: 2, by: 1 },
		{ type: 'place', ax: 5, ay: 5, bx: 3, by: 4 },
		{ type: 'erase', x: 4, y: 2 },
		{ type: 'erase', x: 0, y: 0 },
		null
	].map((a) => ({ a, wire: encodeAction(a) }));
	const dec = [
		['p', 0, 0, 2, 1],
		['p', 5, 5, 3, 4],
		['e', 4, 2],
		['e', 31, 0],
		['e', 32, 0],
		['e', -1, 0],
		['e', 1.5, 0],
		['e', 1],
		['p', 0, 0, 1],
		['x', 0, 0],
		'p',
		null,
		{ type: 'erase', x: 0, y: 0 },
		['p', '0', 0, 1, 1]
	].map((wire) => ({ wire, a: decodeAction(wire) }));
	return { encode: enc, decode: dec };
}

function codes() {
	const r = picker(4242);
	const rooms = [];
	for (let k = 0; k < 12; k++) {
		const rand = [0, 1, 2, 3].map(() => r() / 2147483647);
		let i = 0;
		rooms.push({ rand, code: newRoomCode(() => rand[i++]) });
	}
	return {
		isRoomCode: ['QWER', 'ABCD', 'qwer', 'QWEI', 'QWEL', 'QWEO', 'QWE', 'QWERT', '', 'Q1ER', null].map((c) => [c, isRoomCode(c)]),
		parseRoomPath: ['/QWER', '/qwer', 'QWER', '/QWER+sekrit', '/QWER+a+b', '/QWER/extra', '/QW', '/%51WER', '', '/', '/QWEI'].map((p) => [p, parseRoomPath(p)]),
		testerCode: ['aaaaaaaa1', 'bbbbbbbb2', 'k3j4h5g6f7d8s9a0', '', 'ü'].map((id) => [id, testerCode(id)]),
		newRoomCode: rooms
	};
}

// —— the bare engine: stateHash and snapshots ——
const VARIANTS = {
	vs: VERSUS_RULES,
	mines: MINES_RULES,
	ko: { ...VERSUS_RULES, freezeOver: 'ko' },
	telegraph: { ...VERSUS_RULES, telegraphIce: true, maxIceIncoming: 2 },
	shield: { ...VERSUS_RULES, frostShield: 4, healEvery: 7 },
	spread: { ...VERSUS_RULES, mineCluster: false, spreadLanding: true, icebreakSpills: true }
};
const fnv = (h, s) => {
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h;
};

function hashScenario({ id, variant, timed, seed, a, b, target, every }) {
	const m = new VersusMatch({ rules: VARIANTS[variant], seed, target });
	const bots = [new TiltBot({ ...BOT_PRESETS[a], seed: seed * 7 + 1 }), new TiltBot({ ...BOT_PRESETS[b], seed: seed * 7 + 2 })];
	const r = picker(seed);
	let now = timed ? 1_000_000 : undefined;
	if (timed) m.startClock(now);
	let chain = 0x811c9dc5;
	const checkpoints = [];
	let step = 0;
	const mark = () => {
		const h = stateHash(m);
		chain = fnv(chain, h + '\n');
		if (step % every === 0 || m.over) checkpoints.push({ step, h, st: m.toState() });
		step++;
	};
	mark();
	for (let k = 0; k < 4000 && !m.over; k++) {
		if (timed) {
			now += 200 + (r() % 2600);
			m.catchUp(now);
		}
		if (m.roundOver) {
			if (m.over) break;
			m.newRound();
			if (timed) m.startClock(now);
			mark();
			continue;
		}
		const i = r() % 2;
		m.act(i, bots[i].decide(m.sides[i]), now);
		mark();
	}
	return { id, variant, timed, seed, a, b, target, steps: step, chain, checkpoints };
}

// —— sessions: real room, real clients ——
function world({ latency, seed }) {
	let now = 1_000_000;
	const q = [];
	let k = 0;
	const later = (ms, fn) => q.push({ at: now + ms, fn, k: k++ });
	const conns = new Map();
	const clients = [];
	const all = []; // every client ever made, in order (an app restart makes a new one for the same seat)
	const io = {
		send: (conn, obj) => {
			const raw = JSON.stringify(obj);
			later(latency[conn.seat], () => conn.open && conn.client.inbox(raw));
		},
		conns: () => [...conns.values()].filter((c) => c.open).map((c) => ({ conn: c, id: c.id })),
		save: () => {},
		report: () => {},
		replay: () => {}
	};
	const room = new RoomCore('QWER', io, null, null);
	const H = (m) => (m ? stateHash(m) : null);
	function addClient(seat, id, name) {
		const conn = { id, seat, open: true };
		const c = {
			seat,
			id,
			name,
			conn,
			log: [], // the recorded calls, in order
			bot: new TiltBot({ seed: seed * 10 + seat, misplay: 0.05, defuseFirst: 0.9 }),
			hover: picker(seed * 10 + seat + 5),
			snap() {
				return [H(c.core.confirmed), H(c.core.predicted), c.core.pending.length];
			},
			// What client/ui.js onServer does with a message, minus drawing.
			inbox(raw) {
				const msg = JSON.parse(raw);
				const e = ['in', now, raw];
				c.log.push(e);
				if (msg.t === 'room') c.core.me = msg.you;
				else if (msg.t === 'time') c.core.clockSample(msg.c, msg.s);
				else if (msg.t === 'hv' || msg.t === 'err' || msg.t === 'report') {
					/* drawn only */
				} else {
					if (msg.t === 'fz' && msg.i === c.core.me) c.send({ t: 'sync' });
					c.core.handle(msg);
				}
				e.push(...c.snap()); // the entry, not log.at(-1): handling may have sent something
			},
			send(obj) {
				const raw = JSON.stringify(obj);
				c.log.push(['out', now, raw]);
				const cn = c.conn;
				if (!cn.open) return;
				later(latency[seat], () => {
					if (!cn.open) return;
					const data = JSON.parse(raw);
					if (data.t === 'hello') room.hello(id, data, now);
					else room.message(id, data, now);
				});
			},
			/** A move this client's prediction allowed but the server won't (a stale prediction): sent the way move() sends. */
			inject(a) {
				const e = ['inject', now, a];
				c.log.push(e);
				const s = ++c.core.seq;
				c.core.pending.push({ s, a, at: now, sentAt: now });
				c.send({ t: 'mv', s, a: encodeAction(a), at: now });
				e.push(...c.snap());
			},
			move(a) {
				const e = ['move', now, a];
				c.log.push(e);
				const r = c.core.move(a);
				e.push(r.moved, ...c.snap());
				return r;
			},
			tick() {
				const before = c.log.length;
				const n = c.core.tick().length;
				// Only ticks that did something are kept (a tick is a catch-up: skipping an idle one changes nothing).
				if (n || c.log.length > before) c.log.splice(before, 0, ['tick', now, ...c.snap()]);
			},
			hello() {
				c.send({ t: 'hello', id, name, dev: { ua: 'fixture' }, pv: PROTOCOL_VERSION });
				for (let i = 0; i < 3; i++) later(i * 400, () => c.conn.open && c.send({ t: 'time', c: now }));
			}
		};
		c.core = new ClientCore({ send: (o) => c.send(o), now: () => now });
		conn.client = c;
		conns.set(id + ':' + now, conn);
		clients[seat] = c;
		all.push(c);
		c.hello();
		return c;
	}
	function reconnect(seat) {
		const c = clients[seat];
		const conn = { id: c.id, seat, open: true, client: c };
		c.conn = conn;
		conns.set(c.id + ':' + now, conn);
		c.log.push(['open', now]);
		c.hello();
	}
	function drop(seat) {
		const c = clients[seat];
		c.conn.open = false;
		c.log.push(['close', now]);
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
	return { room, addClient, reconnect, drop, run, clients, all, get now() { return now; } };
}

function playLoop(w, { pace = [900, 1300], hovers = false, offline = false } = {}) {
	const due = [0, 0];
	const nextSent = [0, 0];
	return (now) => {
		for (const c of w.clients) {
			if (!c || !c.core.predicted) continue;
			if (!c.conn.open && !offline) continue; // a dropped player plays on only when the scenario says so
			c.tick();
			const m = c.core.confirmed;
			if (m.roundOver) {
				if (nextSent[c.seat] !== m.round) {
					nextSent[c.seat] = m.round;
					c.send({ t: 'next' });
				}
				continue;
			}
			if (now >= due[c.seat]) {
				due[c.seat] = now + pace[c.seat];
				const p = c.core.predicted;
				if (p.roundOver) continue;
				const a = c.bot.decide(p.sides[c.core.me]) || { type: 'erase', x: 0, y: 0 };
				// A drag first, like a finger would: the box it's about to place, then gone.
				if (hovers && a.type === 'place' && c.hover() % 3 === 0) {
					c.send({ t: 'hv', r: [Math.min(a.ax, a.bx), Math.min(a.ay, a.by), Math.max(a.ax, a.bx), Math.max(a.ay, a.by)] });
				}
				c.move(a);
				if (hovers && c.hover() % 5 === 0) c.send({ t: 'hv' });
			}
		}
	};
}

function lobbyToMatch(w, a, b, o) {
	w.run(500);
	a.send({ t: 'set', o });
	w.run(300);
	a.send({ t: 'ready', v: true });
	b.send({ t: 'ready', v: true });
	b.send({ t: 'ready', v: false });
	b.send({ t: 'ready', v: true });
	w.run(300);
	a.send({ t: 'start' });
	w.run(500);
}

function sessions() {
	const out = [];
	const pack = (id, about, w) => ({
		id,
		about,
		clients: w.all.map((c) => ({ seat: c.seat, id: c.id, name: c.name, log: c.log })),
		server: w.room.match ? stateHash(w.room.match) : null, // null: the match ended and the room went back to the lobby
		phase: w.room.phase
	});

	// 1. A whole match, first to 2, with hovers, clock checks, telemetry and a ready toggle.
	withSeededCrypto(1, () => {
		const w = world({ latency: [40, 140], seed: 1 });
		const a = w.addClient(0, 'aaaaaaaa1', 'Ana');
		const b = w.addClient(1, 'bbbbbbbb2', 'Ben');
		lobbyToMatch(w, a, b, { firstTo: 2, gravitySecs: 3 });
		const step = playLoop(w, { hovers: true });
		let tele = 0;
		w.run(30 * 60 * 1000, (now) => {
			step(now);
			const m = w.room.match;
			if (m && m.roundOver && tele !== m.round) {
				tele = m.round;
				for (const c of w.clients) c.send({ t: 'tele', d: { ...c.core.telemetry(), reconnects: 0, round: m.round } });
			}
		});
		out.push(pack('match', 'a whole match, first to 2: lobby, settings, ready, start, rounds, hovers, clock checks, telemetry', w));
	});

	// 2. A dropout: B keeps playing offline, the moves queue, and land once each on reconnect.
	withSeededCrypto(2, () => {
		const w = world({ latency: [60, 90], seed: 2 });
		const a = w.addClient(0, 'aaaaaaaa1', 'Ana');
		const b = w.addClient(1, 'bbbbbbbb2', 'Ben');
		lobbyToMatch(w, a, b, { firstTo: 1 });
		w.run(6000, playLoop(w));
		// B moves and the line dies while the server's echo is on its way back: the server has
		// the move, B doesn't know. On reconnect the full state's ls tells B not to resend it.
		const p = b.core.predicted;
		b.move(b.bot.decide(p.sides[b.core.me]) || { type: 'erase', x: 0, y: 0 });
		w.run(100);
		w.drop(1);
		const offline = playLoop(w, { pace: [900, 1100], offline: true });
		w.run(5000, (now) => offline(now));
		w.reconnect(1);
		w.run(2000);
		w.run(6000, playLoop(w));
		out.push(pack('dropout', 'B drops mid-round with an echo still in flight, keeps playing offline, reconnects: queued moves are resent and land once, the one the server already had is not', w));
	});

	// 3. A long dropout: B is frozen, comes back as a fresh client (an app restart: new ClientCore,
	//    same id), and both vote to remake the round. Then A reconnects, asks for a resync, and
	//    sends a move the server refuses.
	withSeededCrypto(3, () => {
		const w = world({ latency: [50, 70], seed: 3 });
		const a = w.addClient(0, 'aaaaaaaa1', 'Ana');
		const b = w.addClient(1, 'bbbbbbbb2', 'Ben');
		lobbyToMatch(w, a, b, { firstTo: 2 });
		w.run(8000, playLoop(w));
		w.drop(1);
		w.run(15000, playLoop(w));
		const b2 = w.addClient(1, 'bbbbbbbb2', 'Ben');
		w.run(600);
		a.send({ t: 'vote', v: true });
		b2.send({ t: 'vote', v: true });
		w.run(600);
		w.run(5000, playLoop(w));
		w.drop(0);
		w.reconnect(0);
		w.run(300);
		a.send({ t: 'resync' });
		w.run(300);
		a.inject({ type: 'erase', x: 0, y: 0 });
		w.run(5000, playLoop(w));
		out.push(pack('remake', 'B drops long enough to freeze, restarts the app and rejoins, a remake vote passes; A reconnects, asks for a resync, and has a move refused', w));
	});
	return out;
}

export function makeFixtures() {
	return {
		about: 'Made by test/protocol-fixtures.mjs in s-ging/shikaku-plus-vs-1. The app must reproduce every value.',
		protocolVersion: PROTOCOL_VERSION,
		minProtocolVersion: MIN_PROTOCOL_VERSION,
		actions: actions(),
		codes: codes(),
		hashes: [
			{ id: 'vs-moves', variant: 'vs', timed: false, seed: 14, a: 'normal', b: 'impossible', target: 3, every: 50 },
			{ id: 'vs-timed', variant: 'vs', timed: true, seed: 21, a: 'hard', b: 'normal', target: 2, every: 50 },
			{ id: 'mines', variant: 'mines', timed: false, seed: 5, a: 'normal', b: 'hard', target: 2, every: 60 },
			{ id: 'ko-timed', variant: 'ko', timed: true, seed: 8, a: 'easy', b: 'hard', target: 2, every: 60 },
			{ id: 'telegraph', variant: 'telegraph', timed: true, seed: 33, a: 'hard', b: 'hard', target: 1, every: 60 },
			{ id: 'shield', variant: 'shield', timed: false, seed: 41, a: 'normal', b: 'normal', target: 1, every: 60 },
			{ id: 'spread', variant: 'spread', timed: true, seed: 57, a: 'impossible', b: 'easy', target: 1, every: 60 }
		].map(hashScenario),
		sessions: sessions()
	};
}

export const FIXTURE_PATH = new URL('./fixtures/protocol_parity.json', import.meta.url);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const f = makeFixtures();
	mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
	const text = JSON.stringify(f) + '\n';
	writeFileSync(FIXTURE_PATH, text);
	console.log(`wrote ${fileURLToPath(FIXTURE_PATH)}: ${(text.length / 1024).toFixed(0)} KB`);
}
