// The app's test data for the protocol and netcode (test/fixtures/protocol_parity.json,
// made by test/protocol-fixtures.mjs) must stay true: this fails when the protocol, the
// engine or the room changes and the file wasn't remade. Remake it with
//   node test/protocol-fixtures.mjs
// and copy it to the app as test/fixtures/vs_protocol_parity.json.
//
// It also replays every recorded client through a fresh ClientCore, which is exactly what
// the app's Dart test does: same calls in, same messages and hashes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFixtures, FIXTURE_PATH } from './protocol-fixtures.mjs';
import { ClientCore, stateHash } from '../shared/client-core.js';

const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

test('protocol fixtures: the committed file is what the script makes today', () => {
	assert.deepEqual(JSON.parse(JSON.stringify(makeFixtures())), committed, 'run node test/protocol-fixtures.mjs and copy the file to the app');
});

/**
 * Replays one recorded client. The client/ui.js parts that touch the core are copied in:
 * 'room' sets who I am, 'time' is a clock sample, 'fz' of my own seat says sync.
 */
function replayClient(log) {
	let t = 0;
	const sent = [];
	const core = new ClientCore({ send: (o) => sent.push(JSON.stringify(o)), now: () => t });
	const H = (m) => (m ? stateHash(m) : null);
	const snap = () => [H(core.confirmed), H(core.predicted), core.pending.length];
	for (let k = 0; k < log.length; k++) {
		const e = log[k];
		t = e[1];
		sent.length = 0;
		let got;
		if (e[0] === 'in') {
			const msg = JSON.parse(e[2]);
			if (msg.t === 'room') core.me = msg.you;
			else if (msg.t === 'time') core.clockSample(msg.c, msg.s);
			else if (msg.t !== 'hv' && msg.t !== 'err' && msg.t !== 'report') {
				if (msg.t === 'fz' && msg.i === core.me) core.send({ t: 'sync' });
				core.handle(msg);
			}
			got = snap();
			assert.deepEqual(got, e.slice(3), `entry ${k} (in ${msg.t})`);
		} else if (e[0] === 'move') {
			const r = core.move(e[2]);
			assert.deepEqual([r.moved, ...snap()], e.slice(3), `entry ${k} (move)`);
		} else if (e[0] === 'tick') {
			core.tick();
			assert.deepEqual(snap(), e.slice(2), `entry ${k} (tick)`);
		} else if (e[0] === 'inject') {
			const s = ++core.seq;
			core.pending.push({ s, a: e[2], at: t, sentAt: t });
			core.send({ t: 'mv', s, a: [e[2].type === 'erase' ? 'e' : 'p', ...(e[2].type === 'erase' ? [e[2].x, e[2].y] : [e[2].ax, e[2].ay, e[2].bx, e[2].by])], at: t });
			assert.deepEqual(snap(), e.slice(3), `entry ${k} (inject)`);
		} else continue; // 'out' sent by the screen (hello, ready, …), 'open', 'close'
		// Whatever the core sent must be the very next 'out' entries, byte for byte.
		for (const raw of sent) {
			k++;
			assert.equal(log[k]?.[0], 'out', `entry ${k}: expected the core's message ${raw}`);
			assert.equal(log[k][2], raw, `entry ${k}`);
		}
	}
}

for (const s of committed.sessions) {
	test(`protocol fixtures: session ${s.id}: a fresh client fed the recorded calls says and predicts the same`, () => {
		for (const c of s.clients) replayClient(c.log);
	});
}

test('protocol fixtures: the clients agree with the server at the end of each session', () => {
	for (const s of committed.sessions) {
		if (!s.server) continue;
		const live = new Map(s.clients.map((c) => [c.seat, c])); // the last client per seat
		for (const c of live.values()) {
			const last = c.log.filter((e) => e[0] === 'in' && e[3]).at(-1);
			assert.equal(last[3], s.server, `${s.id}: seat ${c.seat} confirmed state ends on the server's`);
		}
	}
});
