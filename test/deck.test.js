// The server deals the boards (2026-11-14, decision 0026): a curve of Givens, the same Board N for both
// players, a deck the app can play without generating anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curvedBoard, encodeBoard, decodeBoard, vsBoard } from '../engine/match.js';
import { VersusMatch, vsDeck, DECK_SIZE } from '../engine/versus-match.js';
import { VERSUS_RULES } from '../engine/versus.js';

const CURVE = VERSUS_RULES.givens;

test('deck: Givens follow the curve (5-10, a bell on 7 and 8, mean about 7.7)', () => {
	const h = {};
	let n = 0, sum = 0;
	for (let r = 1; r <= 60; r++) for (const b of vsDeck(1000 + r, CURVE).boards) (h[b.layout.length] = (h[b.layout.length] || 0) + 1), n++, (sum += b.layout.length);
	const total = Object.values(CURVE).reduce((a, b) => a + b, 0);
	for (const [g, w] of Object.entries(CURVE)) assert.ok(Math.abs((h[g] || 0) / n - w / total) < 0.03, `${g} givens: ${(((h[g] || 0) / n) * 100).toFixed(1)}% vs ${w}%`);
	assert.deepEqual(Object.keys(h).map(Number).sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
	assert.ok(sum / n > 7.5 && sum / n < 7.9, 'mean ' + (sum / n).toFixed(2));
});

test('deck: both players get the same Board N, whoever reaches it first', () => {
	const m = new VersusMatch({ rules: VERSUS_RULES, seed: 42, target: 3 });
	const [a, b] = m.sides;
	assert.equal(encodeBoard(a.puzzle), encodeBoard(b.puzzle));
	for (let i = 0; i < 70; i++) assert.equal(encodeBoard(m._board(i)), m.deck.codes[i % DECK_SIZE]);
	// One side far ahead: its Board 9 is the other side's Board 9 when they get there.
	a.boardIndex = 9;
	a.deal(m._board(9));
	const later = VersusMatch.fromState(m.toState(true), VERSUS_RULES);
	later.sides[1].boardIndex = 9;
	later.sides[1].deal(later._board(9));
	assert.equal(encodeBoard(later.sides[1].puzzle), encodeBoard(a.puzzle));
});

test('deck: a Board survives being sent as text', () => {
	for (let i = 0; i < 300; i++) {
		const p = curvedBoard(7 + i, i, CURVE);
		const code = encodeBoard(p);
		assert.equal(code.length, p.layout.length * 6);
		const q = decodeBoard(code);
		assert.deepEqual(q.nums, p.nums);
		assert.deepEqual(q.layout.map((r) => [r.x1, r.y1, r.x2, r.y2]), p.layout.map((r) => [r.x1, r.y1, r.x2, r.y2]));
	}
});

test('deck: rules without givens deal exactly as before (old rooms, old replays)', () => {
	const { givens, ...old } = VERSUS_RULES;
	const m = new VersusMatch({ rules: old, seed: 42, target: 3 });
	assert.equal(m.deck, null);
	assert.equal(encodeBoard(m.sides[0].puzzle), encodeBoard(vsBoard(m.roundSeed, 0)));
	assert.equal(m.toState(true).deck, undefined);
});

test('deck: only round and full carry it; a state from the deck rebuilds the same match', () => {
	const m = new VersusMatch({ rules: VERSUS_RULES, seed: 9, target: 3 });
	assert.equal(m.toState().deck, undefined, 'saves stay small: the server rebuilds the deck');
	const st = JSON.parse(JSON.stringify(m.toState(true)));
	assert.equal(st.deck.length, DECK_SIZE);
	assert.ok(JSON.stringify(st.deck).length < 4096, 'a deck is ' + JSON.stringify(st.deck).length + ' bytes');
	const fromWire = VersusMatch.fromState(st, VERSUS_RULES);
	const rebuilt = VersusMatch.fromState(m.toState(), VERSUS_RULES);
	assert.deepEqual(fromWire.deck.codes, rebuilt.deck.codes);
	assert.equal(encodeBoard(fromWire.sides[0].puzzle), encodeBoard(m.sides[0].puzzle));
});

test('deck: dealing a round costs a few milliseconds', () => {
	const t = performance.now();
	for (let r = 0; r < 10; r++) vsDeck(5000 + r, CURVE);
	const ms = (performance.now() - t) / 10;
	assert.ok(ms < 50, ms.toFixed(1) + ' ms a deck');
	console.log(`# a deck: ${ms.toFixed(1)} ms`);
});
