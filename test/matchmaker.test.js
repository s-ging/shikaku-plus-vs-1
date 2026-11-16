// The Quickplay queues (2026-11-14): pairing, the Queue object with a fake Cloudflare around it,
// vs-1 passing /ws/queue/* on, and the room side (reserve, tickets, the match starting by itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPair, newTicket, nextWake, allowedGap, botFor, BOT_AFTER_MS, ANYONE_AFTER_MS } from '../matchmaker/pairing.js';
import { RoomCore } from '../worker/room-core.js';

globalThis.WebSocketRequestResponsePair ??= class {
	constructor(req, res) {
		Object.assign(this, { req, res });
	}
};
const mm = await import('../matchmaker/index.js');
const worker = await import('../worker/index.js');

function fakeSocket() {
	let att = null;
	return {
		readyState: 1,
		sent: [],
		closed: null,
		send(d) {
			this.sent.push(JSON.parse(d));
		},
		close(code, why) {
			this.closed = [code, why];
			this.readyState = 3;
		},
		serializeAttachment: (a) => (att = JSON.parse(JSON.stringify(a))),
		deserializeAttachment: () => att
	};
}

/** A Queue object with fake sockets; rooms(code, body) answers each reserve. */
function fakeQueue(rooms, ratings = null) {
	const socks = [];
	const reserves = [];
	const alarms = [];
	const storage = { setAlarm: async (t) => alarms.push(t), deleteAlarm: async () => alarms.push(null) };
	const ctx = { storage, getWebSockets: () => socks.filter((s) => s.readyState !== 3), setWebSocketAutoResponse: () => {}, acceptWebSocket: (s) => socks.push(s) };
	const env = {
		...(ratings
			? {
					REPORTS: {
						idFromName: (n) => n,
						get: () => ({
							fetch: async (url) => {
								const keys = new URL(url).searchParams.get('keys').split(',');
								return Response.json(Object.fromEntries(keys.map((k) => [k, ratings(k)])));
							}
						})
					}
				}
			: {}),
		ROOMS: {
			idFromName: (c) => c,
			get: (code) => ({
				fetch: async (url, init) => {
					const body = JSON.parse(init.body);
					reserves.push({ code, url, body });
					return rooms(code, body, url);
				}
			})
		}
	};
	const q = new mm.Queue(ctx, env);
	let r = 0;
	q.rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280); // repeatable codes and tickets
	const join = async (id, extra = {}) => {
		const s = fakeSocket();
		ctx.acceptWebSocket(s);
		s.serializeAttachment({ division: 'standard' });
		await q.webSocketMessage(s, JSON.stringify({ t: 'queue', id, pv: 4, ...extra }));
		return s;
	};
	/** Pretend a socket joined ms earlier (the queue reads time from Date.now()). */
	const age = (sock, ms) => sock.serializeAttachment({ ...sock.deserializeAttachment(), at: sock.deserializeAttachment().at - ms });
	const say = async (sock, obj) => q.webSocketMessage(sock, JSON.stringify(obj));
	return { q, join, reserves, alarms, age, say };
}

test('pairing: the two waiting longest, never the same browser twice', () => {
	assert.equal(pickPair([]), null);
	assert.equal(pickPair([{ id: 'aaaaaaaa', at: 1 }]), null);
	assert.equal(pickPair([{ id: 'aaaaaaaa', at: 1 }, { id: 'aaaaaaaa', at: 2 }]), null);
	const p = pickPair([{ id: 'cccccccc', at: 3 }, { id: 'aaaaaaaa', at: 1 }, { id: 'bbbbbbbb', at: 2 }]);
	assert.deepEqual(p.map((e) => e.id), ['aaaaaaaa', 'bbbbbbbb']);
	assert.match(newTicket(), /^[a-z0-9]{20}$/);
});

test('queue: one player waits; a second one makes a match, both get the same room and their own ticket', async () => {
	const { join, reserves } = fakeQueue(() => new Response('ok'));
	const a = await join('aaaaaaaa1', { input: 'touch' });
	assert.deepEqual(a.sent, [{ t: 'q', say: 'Searching for a player…' }]);
	assert.equal(a.deserializeAttachment().input, 'touch');
	assert.equal(reserves.length, 0);
	const b = await join('bbbbbbbb2', { input: 'joystick' });
	assert.equal(b.deserializeAttachment().input, null, 'unknown inputs are dropped');
	assert.equal(reserves.length, 1);
	const { code, body, url } = reserves[0];
	assert.equal(url, `https://room/${code}/reserve`);
	assert.equal(body.division, 'standard');
	assert.deepEqual(body.seats.map((s) => s.id), ['aaaaaaaa1', 'bbbbbbbb2']);
	const ma = a.sent.at(-1);
	const mb = b.sent.at(-1);
	assert.equal(ma.t, 'match');
	assert.equal(ma.code, code);
	assert.equal(mb.code, code);
	assert.equal(ma.tk, body.seats[0].tk);
	assert.equal(mb.tk, body.seats[1].tk);
	assert.notEqual(ma.tk, mb.tk);
	assert.deepEqual(a.closed, [1000, 'matched']);
	assert.deepEqual(b.closed, [1000, 'matched']);
});

test('queue: the same browser twice replaces its place instead of playing itself', async () => {
	const { join, reserves } = fakeQueue(() => new Response('ok'));
	const a1 = await join('aaaaaaaa1');
	const a2 = await join('aaaaaaaa1');
	assert.deepEqual(a1.closed, [1000, 'replaced']);
	assert.equal(a2.closed, null);
	assert.equal(reserves.length, 0);
});

test('queue: a code in use is skipped; if no room answers, both stay in line', async () => {
	let n = 0;
	const { join, reserves } = fakeQueue(() => (++n === 1 ? new Response('taken', { status: 409 }) : new Response('ok')));
	const a = await join('aaaaaaaa1');
	await join('bbbbbbbb2');
	assert.equal(reserves.length, 2, 'second code tried');
	assert.equal(a.sent.at(-1).code, reserves[1].code);

	const down = fakeQueue(() => {
		throw new Error('down');
	});
	const c = await down.join('cccccccc3');
	const d = await down.join('dddddddd4');
	assert.equal(down.reserves.length, 5);
	assert.deepEqual(c.sent.at(-1), { t: 'q', say: 'Still searching…' });
	assert.equal(c.closed, null);
	assert.equal(d.deserializeAttachment().state, 'waiting');
});

test('queue: an old client is told to update', async () => {
	const { join } = fakeQueue(() => new Response('ok'));
	const s = await join('aaaaaaaa1', { pv: 1 });
	assert.equal(s.sent[0].why, 'update');
	assert.deepEqual(s.closed, [1000, 'update']);
});

test('worker: /ws/queue/* checks the Origin, then goes to the matchmaker; off when MM is not bound', async () => {
	const seen = [];
	const env = { MM: { fetch: async (req) => (seen.push(new URL(req.url).pathname), new Response('queue')) } };
	const ask = (origin, e = env) =>
		worker.default.fetch(new Request('https://vs.shikaku.plus/ws/queue/knockout', { headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) } }), e);
	assert.equal((await ask('https://evil.com')).status, 403);
	assert.equal(await (await ask('https://shikaku.plus')).text(), 'queue');
	assert.equal(await (await ask(null)).text(), 'queue', 'the app sends no Origin');
	assert.deepEqual(seen, ['/ws/queue/knockout', '/ws/queue/knockout']);
	assert.equal((await ask(null, {})).status, 503);
	const mmRes = await mm.default.fetch(new Request('https://x/ws/queue/mines', { headers: { Upgrade: 'websocket' } }), {});
	assert.equal(mmRes.status, 404, 'only the two divisions');
});

// —— the room side ——
function roomWorld() {
	const sent = new Map(); // id → messages
	const conns = [];
	const reports = [];
	const io = {
		send: (conn, obj) => sent.get(conn.id).push(obj),
		conns: () => conns,
		save: () => {},
		report: (r) => reports.push(r),
		replay: () => {}
	};
	const room = new RoomCore('QWER', io, null, null);
	const hello = (id, extra = {}, now = 1000) => {
		if (!sent.has(id)) {
			sent.set(id, []);
			conns.push({ conn: { id }, id });
		}
		return room.hello(id, { t: 'hello', pv: 4, id, name: id, ...extra }, now);
	};
	return { room, hello, sent, reports };
}
const SEATS = [
	{ id: 'aaaaaaaa1', tk: 'tickettickettickett1' },
	{ id: 'bbbbbbbb2', tk: 'tickettickettickett2' }
];

test('room: reserved for two; strangers, wrong tickets and late arrivals are turned away', () => {
	const { room, hello } = roomWorld();
	assert.equal(room.reserve({ division: 'knockout', seats: SEATS }, 0), true);
	assert.equal(room.reserve({ division: 'knockout', seats: SEATS }, 0), false, 'only once');
	assert.deepEqual(room.o, { hearts: 1 }, 'Knockout Quickplay: 1 Stock, first to 3');
	assert.equal(hello('cccccccc3', { tk: SEATS[0].tk }), 'gone', 'not one of the two');
	assert.equal(hello('aaaaaaaa1', { tk: SEATS[1].tk }), 'gone', "someone else's ticket");
	assert.equal(hello('aaaaaaaa1', {}), 'gone', 'no ticket');
	assert.equal(hello('aaaaaaaa1', { tk: SEATS[0].tk }, 31000), 'gone', 'too late');
	assert.equal(room.seats.length, 0);
});

test('room: a used room cannot be reserved, and bad reservations are refused', () => {
	const { room, hello } = roomWorld();
	hello('cccccccc3');
	assert.equal(room.reserve({ division: 'standard', seats: SEATS }, 0), false);
	const fresh = roomWorld().room;
	assert.equal(fresh.reserve({ division: 'mines', seats: SEATS }, 0), false);
	assert.equal(fresh.reserve({ division: 'standard', seats: [SEATS[0], SEATS[0]] }, 0), false);
	assert.equal(fresh.reserve({ division: 'standard', seats: [SEATS[0]] }, 0), false);
	assert.equal(fresh.reserve(null, 0), false);
});

test('room: both players arrive, the match starts by itself, settings stay locked, no lobby after', () => {
	const { room, hello, sent } = roomWorld();
	room.reserve({ division: 'standard', seats: SEATS }, 0);
	assert.equal(hello('aaaaaaaa1', { tk: SEATS[0].tk }, 1000), true);
	assert.equal(room.phase, 'lobby');
	assert.equal(sent.get('aaaaaaaa1').at(-1).mm, 'standard', 'the client knows it is matchmade');
	assert.ok(!JSON.stringify(sent.get('aaaaaaaa1')).includes('tickett'), 'tickets never go out');
	room.message('aaaaaaaa1', { t: 'set', o: { hearts: 2, firstTo: 7 } }, 1100);
	room.message('aaaaaaaa1', { t: 'ready', v: true }, 1100);
	assert.deepEqual(room.o, {});
	assert.equal(hello('bbbbbbbb2', { tk: SEATS[1].tk }, 2000), true);
	assert.equal(room.phase, 'match');
	assert.equal(room.match.target, 3, 'first to 3');
	const round = sent.get('bbbbbbbb2').find((m) => m.t === 'round');
	assert.equal(round.startAt, 2000 + 7500, 'a 7.5-second lead: MATCH FOUND!, the face-off, then the 3-2-1');
	assert.equal(room.report.queue, 'quickplay');
	assert.equal(room.report.division, 'standard');
	// A seated player who drops and comes back needs no ticket.
	room.closed('aaaaaaaa1', 3000);
	assert.equal(hello('aaaaaaaa1', {}, 3500), true);
	// After the match nobody is sent back to a lobby.
	room.match.over = true;
	room.match.roundOver = { winner: 0 };
	room.message('aaaaaaaa1', { t: 'next' }, 9000);
	assert.equal(room.phase, 'match');
});

test('end to end: the Queue reserves a real Room object, and the tickets it hands out open it', async () => {
	const rooms = new Map();
	const fakeRoomCtx = () => {
		const socks = [];
		let stored = null;
		return {
			storage: { get: async () => stored, put: async (k, v) => (stored = v) },
			getWebSockets: () => socks,
			getWebSocketAutoResponseTimestamp: () => null,
			setWebSocketAutoResponse: () => {},
			acceptWebSocket: (s) => socks.push(s)
		};
	};
	const roomEnv = { REPORTS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('ok') }) } };
	const roomOf = (code) => {
		if (!rooms.has(code)) {
			const ctx = fakeRoomCtx();
			rooms.set(code, { ctx, obj: new worker.Room(ctx, roomEnv) });
		}
		return rooms.get(code);
	};
	const { join } = fakeQueue((code, body, url) => roomOf(code).obj.fetch(new Request(url, { method: 'POST', body: JSON.stringify(body) })));
	const a = await join('aaaaaaaa1');
	const b = await join('bbbbbbbb2');
	const m = a.sent.at(-1);
	const { ctx, obj } = roomOf(m.code);
	const open = () => {
		const s = fakeSocket();
		ctx.acceptWebSocket(s);
		s.serializeAttachment({ id: null, code: m.code });
		return s;
	};
	const sa = open();
	await obj.webSocketMessage(sa, JSON.stringify({ t: 'hello', pv: 4, id: 'aaaaaaaa1', name: 'A', tk: m.tk }));
	const stranger = open();
	await obj.webSocketMessage(stranger, JSON.stringify({ t: 'hello', pv: 4, id: 'cccccccc3', name: 'C' }));
	assert.deepEqual(stranger.closed, [1000, 'gone']);
	const sb = open();
	await obj.webSocketMessage(sb, JSON.stringify({ t: 'hello', pv: 4, id: 'bbbbbbbb2', name: 'B', tk: b.sent.at(-1).tk }));
	assert.ok(sb.sent.some((x) => x.t === 'round'), 'the match started');
	assert.ok(sa.sent.some((x) => x.t === 'round'));
});

// —— Step 2 (2026-11-16): pairing by the quiet rating, and the labeled bot (decision 0025) ——
const at = (id, t, r) => ({ id, at: t, ...(r != null ? { rating: { r, rd: 100 } } : {}) });

test('pairing by skill: the closest rating the wait allows; the gap widens; after a minute anyone', () => {
	assert.equal(allowedGap(0), 100);
	assert.equal(allowedGap(30000), 340);
	assert.equal(allowedGap(ANYONE_AFTER_MS), Infinity);
	const now = 100000;
	// The longest waiter meets the closest rating, not the next in line.
	const p = pickPair([at('aaaaaaaa', now - 5000, 1500), at('bbbbbbbb', now - 4000, 1900), at('cccccccc', now - 1000, 1520)], now);
	assert.deepEqual(p.map((e) => e.id), ['aaaaaaaa', 'cccccccc']);
	// 400 apart: not yet at 10 s (allows 180), yes at 40 s (allows 420).
	assert.equal(pickPair([at('aaaaaaaa', now - 10000, 1500), at('bbbbbbbb', now, 1900)], now), null);
	assert.ok(pickPair([at('aaaaaaaa', now - 40000, 1500), at('bbbbbbbb', now, 1900)], now));
	// Far apart: anyone after a minute.
	assert.ok(pickPair([at('aaaaaaaa', now - ANYONE_AFTER_MS, 900), at('bbbbbbbb', now, 2600)], now));
	// No rating yet counts as 1500.
	assert.ok(pickPair([at('aaaaaaaa', now, null), at('bbbbbbbb', now, 1580)], now));
});

test('pairing: the next wake is when a pair becomes possible or a bot is due, whichever is first', () => {
	const now = 100000;
	assert.equal(nextWake([], now), null);
	assert.equal(nextWake([at('aaaaaaaa', now, 1500)], now), now + BOT_AFTER_MS);
	assert.equal(nextWake([{ ...at('aaaaaaaa', now, 1500), offered: true }], now), null, 'offered already: nothing to wait for');
	// 260 apart: possible once the older has waited (260 - 100) / 8 = 20 s.
	assert.equal(nextWake([at('aaaaaaaa', now - 5000, 1500), at('bbbbbbbb', now, 1760)], now), now - 5000 + 20000);
});

test('bot level follows the rating, and the label always says bot', () => {
	assert.deepEqual(botFor({}), { level: 'normal', label: 'Bot · Normal' });
	assert.deepEqual(botFor({ rating: { r: 1200 } }), { level: 'easy', label: 'Bot · Easy' });
	assert.deepEqual(botFor({ rating: { r: 1700 } }), { level: 'hard', label: 'Bot · Hard' });
	assert.deepEqual(botFor({ rating: { r: 2200 } }), { level: 'expert', label: 'Bot · Expert' });
});

test('queue: ratings are read on join; two far-apart players wait, then meet once the gap allows', async () => {
	const r = { 'aaaaaaaa1': 1300, 'bbbbbbbb2': 1800 };
	const { ratingKey } = await import('../worker/ratings.js');
	const byKey = new Map();
	for (const [id, v] of Object.entries(r)) byKey.set(await ratingKey(id, null), { r: v, rd: 80 });
	const { q, join, reserves, alarms, age } = fakeQueue(() => new Response('ok'), (k) => byKey.get(k) || null);
	const a = await join('aaaaaaaa1');
	assert.deepEqual(a.deserializeAttachment().rating, { r: 1300, rd: 80 });
	const b = await join('bbbbbbbb2');
	assert.equal(reserves.length, 0, '500 apart: not yet');
	assert.ok(alarms.at(-1) > Date.now() + 40000, 'an alarm for when they may meet');
	age(a, 50000); // the older one has waited 50 s: 500 allowed
	await q.alarm();
	assert.equal(reserves.length, 1);
	assert.equal(b.sent.at(-1).t, 'match');
	assert.equal(alarms.at(-1), null, 'nobody waits: no alarm');
});

test('queue: after two minutes a labeled bot is offered; taking it keeps the place; a waiting human meets them after', async () => {
	const { q, join, reserves, age, say } = fakeQueue(() => new Response('ok'));
	const a = await join('aaaaaaaa1');
	age(a, BOT_AFTER_MS);
	await q.alarm();
	const offer = a.sent.at(-1);
	assert.equal(offer.t, 'bot');
	assert.equal(offer.level, 'normal');
	assert.match(offer.label, /^Bot · /);
	await q.alarm();
	assert.equal(a.sent.filter((m) => m.t === 'bot').length, 1, 'offered once');
	await say(a, { t: 'bot' });
	assert.equal(a.deserializeAttachment().state, 'bot');
	// Someone arrives mid-bot-match: nothing is interrupted; the bot player hears that someone waits.
	const b = await join('bbbbbbbb2');
	assert.equal(reserves.length, 0);
	assert.deepEqual(a.sent.at(-1), { t: 'q', say: 'A player is waiting. You meet them after this match.', next: true });
	await join('cccccccc3'); // and a third: told once only
	assert.equal(reserves.length, 1, 'the two waiting humans meet');
	assert.equal(a.sent.filter((m) => m.next).length, 1);
	const d = await join('dddddddd4');
	// The bot match ends: back in line at the original place, so the oldest waiter is matched first.
	await say(a, { t: 'free' });
	assert.equal(reserves.length, 2);
	assert.deepEqual(reserves[1].body.seats.map((s) => s.id), ['aaaaaaaa1', 'dddddddd4']);
	assert.equal(b.sent.at(-1).t, 'match');
	assert.equal(d.sent.at(-1).t, 'match');
});

test('queue: a bot that was never offered cannot be taken; free only after a bot; back alone, the bot is offered again', async () => {
	const { q, join, age, say } = fakeQueue(() => new Response('ok'));
	const a = await join('aaaaaaaa1');
	await say(a, { t: 'bot' });
	assert.equal(a.deserializeAttachment().state, 'waiting');
	await say(a, { t: 'free' });
	assert.equal(a.deserializeAttachment().state, 'waiting');
	age(a, BOT_AFTER_MS);
	await q.alarm();
	await say(a, { t: 'bot' });
	await say(a, { t: 'free' });
	assert.equal(a.sent.filter((m) => m.t === 'bot').length, 2, 'still alone after the bot match: offered again');
});
