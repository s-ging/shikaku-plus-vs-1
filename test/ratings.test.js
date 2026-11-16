// The quiet Glicko-2 rating (worker/ratings.js, 2026-11-16) and the Reports object that keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { update, applyMatch, rebuild, ratedMatch, ratingKey, aged, fresh, GLICKO } from '../worker/ratings.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

test("glicko-2: Glickman's worked example (1500/200/0.06 against three opponents)", () => {
	const p = update({ r: 1500, rd: 200, vol: 0.06 }, [
		{ o: { r: 1400, rd: 30 }, s: 1 },
		{ o: { r: 1550, rd: 100 }, s: 0 },
		{ o: { r: 1700, rd: 300 }, s: 0 }
	]);
	near(p.r, 1464.06, 0.05, 'rating');
	near(p.rd, 151.52, 0.05, 'deviation');
	near(p.vol, 0.05999, 0.00001, 'volatility');
});

test('glicko-2: one match moves new players apart, the winner up, by the same amount', () => {
	const m = { at: 1000, keys: ['u:a', 'u:b'], winner: 0 };
	const [a, b] = applyMatch(m, () => undefined);
	assert.ok(a.r > 1500 && b.r < 1500);
	near(a.r - 1500, 1500 - b.r, 1e-6, 'symmetric');
	assert.ok(a.rd < GLICKO.rd && b.rd < GLICKO.rd, 'both more certain');
	assert.equal(a.n, 1);
	assert.equal(a.at, 1000);
});

test('glicko-2: time away grows the uncertainty again, to at most the returning cap (decision 0020)', () => {
	const p = { r: 1600, rd: 80, vol: 0.06, n: 10, at: 0 };
	assert.equal(aged(p, 0).rd, 80, 'no time recorded: unchanged');
	const p1 = { ...p, at: 1 };
	assert.ok(aged(p1, 1 + 30 * GLICKO.idleDayMs).rd > 80);
	assert.equal(aged(p1, 1 + 1e6 * GLICKO.idleDayMs).rd, GLICKO.returnRd);
	assert.equal(aged({ ...p1, rd: 300 }, 1 + 1e6 * GLICKO.idleDayMs).rd, 300, 'never lowered by time away');
});

test('rated matches: finished Quickplay only; the leaver takes the loss; abandoned and rooms never count', () => {
	const base = { queue: 'quickplay', result: 'finished', score: [3, 1], endedAt: 5 };
	assert.deepEqual(ratedMatch(base, ['u:a', 'd:b']), { at: 5, keys: ['u:a', 'd:b'], winner: 0, score: [3, 1] });
	assert.equal(ratedMatch({ ...base, score: [2, 3] }, ['u:a', 'd:b']).winner, 1);
	assert.equal(ratedMatch({ ...base, score: [2, 1], forfeitBy: 0 }, ['u:a', 'd:b']).winner, 1, 'leaver loses even when ahead');
	assert.equal(ratedMatch({ ...base, result: 'abandoned' }, ['u:a', 'd:b']), null);
	assert.equal(ratedMatch({ ...base, queue: undefined }, ['u:a', 'd:b']), null, 'custom rooms are never rated');
	assert.equal(ratedMatch(base, ['u:a', 'u:a']), null, 'one account on both seats');
	assert.equal(ratedMatch(base, ['u:a', null]), null);
});

test('rebuild: the match log alone gives the same ratings, in time order', () => {
	const log = [
		{ at: 3, keys: ['u:a', 'u:c'], winner: 1 },
		{ at: 1, keys: ['u:a', 'u:b'], winner: 0 },
		{ at: 2, keys: ['u:b', 'u:c'], winner: 0 }
	];
	const live = new Map();
	for (const m of [...log].sort((x, y) => x.at - y.at)) {
		const [a, b] = applyMatch(m, (k) => live.get(k));
		live.set(m.keys[0], a);
		live.set(m.keys[1], b);
	}
	assert.deepEqual(rebuild(log), live);
});

test('rating keys: the account when signed in, else a hash of the device id, never the id itself', async () => {
	assert.equal(await ratingKey('abcdefgh1', 'acc-1'), 'u:acc-1');
	const d = await ratingKey('abcdefgh1', null);
	assert.match(d, /^d:[0-9a-f]{20}$/);
	assert.ok(!d.includes('abcdefgh1'));
	assert.equal(await ratingKey('abcdefgh1'), d, 'stable');
	assert.notEqual(await ratingKey('abcdefgh2'), d);
	assert.deepEqual(fresh(), { r: 1500, rd: 350, vol: 0.06, n: 0, at: 0 });
});

// —— The Reports object: a Quickplay report updates both ratings once; the matchmaker reads them ——
function fakeStorage() {
	const m = new Map();
	const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
	return {
		map: m,
		async get(k) {
			if (Array.isArray(k)) return new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))]));
			return clone(m.get(k));
		},
		async put(k, v) {
			if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, clone(b));
			else m.set(k, clone(v));
		},
		async delete(k) {
			for (const x of [].concat(k)) m.delete(x);
		},
		async list({ prefix = '', reverse = false, limit = Infinity } = {}) {
			let keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
			if (reverse) keys.reverse();
			return new Map(keys.slice(0, limit).map((k) => [k, clone(m.get(k))]));
		}
	};
}

test('reports: a finished Quickplay match rates both seats once; the queue reads them; rebuild agrees', async () => {
	globalThis.WebSocketRequestResponsePair ??= class {};
	const { Reports } = await import('../worker/index.js');
	const storage = fakeStorage();
	const reports = new Reports({ storage });
	const post = (path, body) => reports.fetch(new Request('https://reports' + path, { method: 'POST', body: JSON.stringify(body) }));
	const a = await ratingKey('aaaaaaaa1', null);
	const rep = { code: 'QWER', startedAt: 100, endedAt: 900, queue: 'quickplay', division: 'standard', result: 'finished', score: [3, 2], rk: [a, 'u:0b0b0b0b-0000-4000-8000-000000000002'], seats: [] };
	await post('/add', { ...rep, result: 'abandoned' }); // the abandoned row first, then the finish replaces it
	assert.equal([...storage.map.keys()].filter((k) => k.startsWith('g:')).length, 0, 'abandoned: no rating');
	await post('/add', rep);
	await post('/add', rep); // sent twice: rated once
	const ms = [...storage.map.keys()].filter((k) => k.startsWith('m:'));
	assert.deepEqual(ms, ['m:000000000000100:QWER']);
	const read = await (await reports.fetch(new Request(`https://reports/ratings?keys=${a},u:0b0b0b0b-0000-4000-8000-000000000002,u:0c0c0c0c-0000-4000-8000-000000000003`))).json();
	assert.ok(read[a].r > 1500 && read['u:0b0b0b0b-0000-4000-8000-000000000002'].r < 1500);
	assert.equal(read['u:0c0c0c0c-0000-4000-8000-000000000003'], null);
	assert.deepEqual(Object.keys(read[a]), ['r', 'rd'], 'the queue gets the rating only');
	const before = storage.map.get('g:' + a);
	const rb = await (await reports.fetch(new Request('https://reports/ratings/rebuild', { method: 'POST' }))).json();
	assert.deepEqual(rb, { matches: 1, players: 2 });
	assert.deepEqual(storage.map.get('g:' + a), before);
	const all = await (await reports.fetch(new Request('https://reports/ratings/all'))).json();
	assert.equal(all.players, 2);
	assert.equal(all.ratings[0].key, a, 'highest first');
	// A custom room's report is never rated.
	await post('/add', { ...rep, code: 'ASDF', startedAt: 200, queue: undefined, rk: undefined });
	assert.equal([...storage.map.keys()].filter((k) => k.startsWith('m:')).length, 1);
});
