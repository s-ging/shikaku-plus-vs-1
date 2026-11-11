// The Worker's own glue (worker/index.js) in Node, with a fake Cloudflare around it:
// the Origin check, the bigger first message, and a signed-in hello that holds the
// socket's other messages until the account check is done.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// What the Workers runtime provides as globals.
globalThis.WebSocketRequestResponsePair ??= class {
	constructor(req, res) {
		Object.assign(this, { req, res });
	}
};
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

function fakeRoom(env = {}) {
	const socks = [];
	const ctx = {
		storage: { get: async () => null, put: async () => {} },
		getWebSockets: () => socks,
		getWebSocketAutoResponseTimestamp: () => null,
		setWebSocketAutoResponse: () => {},
		acceptWebSocket: (s) => socks.push(s)
	};
	const room = new worker.Room(ctx, { ...env, REPORTS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('ok') }) } });
	const open = () => {
		const s = fakeSocket();
		ctx.acceptWebSocket(s);
		s.serializeAttachment({ id: null, code: 'QWER' });
		return s;
	};
	return { room, open };
}

test('worker: a room refuses WebSockets from other sites, and lets the app (no Origin) and our pages in', async () => {
	const seen = [];
	const env = { ROOMS: { idFromName: (c) => c, get: () => ({ fetch: async () => (seen.push(1), new Response('room')) }) } };
	const ask = (origin) =>
		worker.default.fetch(new Request('https://vs.shikaku.plus/ws/QWER', { headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) } }), env);
	assert.equal((await ask('https://evil.com')).status, 403);
	assert.equal(seen.length, 0, 'never reaches the room');
	assert.equal(await (await ask(null)).text(), 'room');
	assert.equal(await (await ask('https://shikaku.plus')).text(), 'room');
	assert.equal(await (await ask('https://vs.shikaku.plus')).text(), 'room');
});

test('worker: a signed-in hello is checked first; messages sent meanwhile wait, in order, and the token goes nowhere', async () => {
	const { room, open } = fakeRoom({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' });
	// Stand in for the account check: resolves when we say so.
	let release;
	const { Identity } = await import('../worker/identity.js');
	const orig = Identity.prototype.who;
	Identity.prototype.who = function (tok) {
		assert.equal(tok, 'T'.repeat(3000), 'the whole token reaches the check');
		return new Promise((r) => (release = () => r({ uid: '0b9c2f4e-1a2b-4c3d-8e9f-0123456789ab', name: 'Krischan', badge: 'prevs' })));
	};
	try {
		const s = open();
		const hello = JSON.stringify({ t: 'hello', id: 'aaaaaaaa1', name: 'typed', pv: 1, tok: 'T'.repeat(3000) });
		assert.ok(hello.length > 2048, 'bigger than a normal message');
		const h = room.webSocketMessage(s, hello);
		await new Promise((r) => setTimeout(r, 5));
		await room.webSocketMessage(s, JSON.stringify({ t: 'time', c: 1 }));
		await room.webSocketMessage(s, JSON.stringify({ t: 'time', c: 2 }));
		assert.deepEqual(s.sent, [], 'nothing answered before the check');
		release();
		await h;
		const types = s.sent.map((m) => m.t);
		assert.deepEqual(types, ['room', 'time', 'time'], 'seated, then the held messages in order');
		assert.deepEqual(s.sent.filter((m) => m.t === 'time').map((m) => m.c), [1, 2]);
		assert.deepEqual(s.sent[0].seats[0], { name: 'Krischan', ready: false, connected: true, badge: 'prevs', v: true });
		assert.ok(!JSON.stringify(room.core.seats).includes('TTTT'), 'the token is not kept on the seat');
		// After hello, the normal 2KB cap applies.
		await room.webSocketMessage(s, JSON.stringify({ t: 'time', c: 3, pad: 'x'.repeat(3000) }));
		assert.equal(s.sent.filter((m) => m.t === 'time').length, 2);
	} finally {
		Identity.prototype.who = orig;
	}
});

test('worker: without the Supabase settings, or without a token, players join as guests at once', async () => {
	const { room, open } = fakeRoom({});
	const s = open();
	await room.webSocketMessage(s, JSON.stringify({ t: 'hello', id: 'aaaaaaaa1', name: 'Ana', pv: 1, tok: 'whatever' }));
	assert.deepEqual(s.sent[0].seats[0], { name: 'Ana', ready: false, connected: true });
	const { room: r2, open: open2 } = fakeRoom({});
	const s2 = open2();
	await r2.webSocketMessage(s2, JSON.stringify({ t: 'hello', id: 'bbbbbbbb2', name: 'B', pad: 'x'.repeat(9000) }));
	assert.equal(s2.sent.length, 0, 'a first message over 8KB is dropped');
});
