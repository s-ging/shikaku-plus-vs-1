// Account checks (worker/identity.js) with real ES256 signatures made here, and a fake
// network standing in for Supabase's key list and profile RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity, cleanVerifiedName, cleanBadge } from '../worker/identity.js';
import { RoomCore } from '../worker/room-core.js';

const URL_ = 'https://example.supabase.co';
const UID = '0b9c2f4e-1a2b-4c3d-8e9f-0123456789ab';
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function keyPair() {
	const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
	return { kp, jwk };
}
async function sign(kp, kid, claims, head = {}) {
	const h = enc({ alg: 'ES256', kid, typ: 'JWT', ...head });
	const p = enc(claims);
	const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + p));
	return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

async function world() {
	const a = await keyPair();
	const calls = { jwks: 0, profile: 0 };
	let keys = [{ ...a.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }];
	let profile = [{ user_id: UID, display_name: 'Krischan', active_badge_id: 'prevs' }];
	let t = 1_800_000_000_000;
	const fetch = async (url, init) => {
		if (url === URL_ + '/auth/v1/.well-known/jwks.json') {
			calls.jwks++;
			return new Response(JSON.stringify({ keys }));
		}
		if (url === URL_ + '/rest/v1/rpc/get_public_profile') {
			calls.profile++;
			assert.equal(init.method, 'POST');
			assert.equal(init.headers.apikey, 'anon');
			assert.deepEqual(JSON.parse(init.body), { p_user_id: UID });
			return new Response(JSON.stringify(profile));
		}
		return new Response('no', { status: 404 });
	};
	const id = new Identity({ url: URL_ + '/', anonKey: 'anon', fetch, now: () => t });
	const claims = (o = {}) => ({ iss: URL_ + '/auth/v1', aud: 'authenticated', role: 'authenticated', sub: UID, exp: t / 1000 + 3600, is_anonymous: true, ...o });
	return {
		id,
		a,
		calls,
		claims,
		setKeys: (k) => (keys = k),
		setProfile: (p) => (profile = p),
		advance: (ms) => (t += ms)
	};
}

test('identity: a good token gives the account, its name and badge; the key list and profile are cached', async () => {
	const w = await world();
	const tok = await sign(w.a.kp, 'k1', w.claims());
	assert.deepEqual(await w.id.who(tok), { uid: UID, name: 'Krischan', badge: 'prevs' });
	assert.deepEqual(await w.id.who(tok), { uid: UID, name: 'Krischan', badge: 'prevs' });
	assert.deepEqual(w.calls, { jwks: 1, profile: 1 }, 'second join costs nothing');
	w.advance(11 * 60 * 1000);
	await w.id.who(await sign(w.a.kp, 'k1', w.claims()));
	assert.deepEqual(w.calls, { jwks: 2, profile: 2 }, 'refreshed after 10 minutes');
});

test('identity: bad tokens give null, never an error', async () => {
	const w = await world();
	const other = await keyPair();
	const bad = [
		null,
		'',
		'abc',
		'a.b.c',
		await sign(other.kp, 'k1', w.claims()), // signed by someone else
		await sign(w.a.kp, 'k1', w.claims({ exp: 1 })), // expired
		await sign(w.a.kp, 'k1', w.claims({ iss: 'https://evil.supabase.co/auth/v1' })), // another project
		await sign(w.a.kp, 'k1', w.claims({ aud: 'anon', role: 'anon' })), // the anon key itself, not a user
		await sign(w.a.kp, 'k1', w.claims({ sub: 'not-a-uuid' })),
		await sign(w.a.kp, 'k1', w.claims(), { alg: 'HS256' }),
		await sign(w.a.kp, 'nope', w.claims()) // a key id the project doesn't publish
	];
	const good = await sign(w.a.kp, 'k1', w.claims());
	bad.push(good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA')); // tampered signature
	const [h, , s] = good.split('.');
	bad.push(`${h}.${enc(w.claims({ sub: '11111111-1111-4111-8111-111111111111' }))}.${s}`); // someone else's id, same signature
	for (const t of bad) assert.equal(await w.id.who(t), null, String(t).slice(0, 40));
});

test('identity: a rotated key is picked up, but an unknown key id can not make us refetch in a loop', async () => {
	const w = await world();
	await w.id.who(await sign(w.a.kp, 'k1', w.claims()));
	const b = await keyPair();
	w.setKeys([{ ...b.jwk, kid: 'k2' }]);
	assert.equal(w.calls.jwks, 1);
	w.advance(61 * 1000);
	assert.equal((await w.id.who(await sign(b.kp, 'k2', w.claims())))?.uid, UID, 'new key fetched');
	assert.equal(w.calls.jwks, 2);
	for (let i = 0; i < 5; i++) await w.id.who(await sign(b.kp, 'k9', w.claims()));
	assert.equal(w.calls.jwks, 2, 'unknown kids within a minute cost nothing');
});

test('identity: a profile without a name still gives the account; names and badges are cleaned', async () => {
	const w = await world();
	w.setProfile([]);
	assert.deepEqual(await w.id.who(await sign(w.a.kp, 'k1', w.claims())), { uid: UID, name: null, badge: null });
	assert.equal(cleanVerifiedName('  Ana\u0000‎ María  '), 'Ana María');
	assert.equal(cleanVerifiedName('x'.repeat(40)).length, 32);
	assert.equal(cleanVerifiedName(''), null);
	assert.equal(cleanBadge('prevs'), 'prevs');
	assert.equal(cleanBadge('<img>'), null);
	assert.equal(cleanBadge(7), null);
});

test('room: a checked account shows its name and badge; a failed check on rejoin keeps them; guests are as before', () => {
	const sent = [];
	const conns = [{ conn: 'a', id: 'aaaaaaaa1' }, { conn: 'b', id: 'bbbbbbbb2' }];
	const io = { send: (c, o) => sent.push([c, o]), conns: () => conns, save: () => {}, report: () => {} };
	const room = new RoomCore('QWER', io, null, null);
	room.hello('aaaaaaaa1', { t: 'hello', id: 'aaaaaaaa1', name: 'Typed' }, 1000, { uid: UID, name: 'Krischan', badge: 'prevs' });
	room.hello('bbbbbbbb2', { t: 'hello', id: 'bbbbbbbb2', name: 'Guest!!' }, 1000, null);
	const last = sent.filter(([c, o]) => c === 'b' && o.t === 'room').at(-1)[1];
	assert.deepEqual(last.seats, [
		{ name: 'Krischan', ready: false, connected: true, badge: 'prevs', v: true },
		{ name: 'Guest', ready: false, connected: true }
	]);
	room.closed('aaaaaaaa1', 2000);
	room.hello('aaaaaaaa1', { t: 'hello', id: 'aaaaaaaa1', name: 'Impostor' }, 3000, null);
	assert.equal(room.seats[0].name, 'Krischan', 'a checked name stays when the rejoin had no good token');
	assert.equal(room.seats[0].badge, 'prevs');
	assert.equal(room.seats[0].uid, UID);
});
