// Sound: the synth renders the base pack safely and the same way every time, the pack
// checker leaves a good pack unchanged and tames a bad one, and the whole set fits a budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SoundSynth as S } from '../shared/sound/synth.js';
import { SoundPack } from '../shared/sound/pack.js';

const raw = JSON.parse(readFileSync(new URL('../sounds/base.json', import.meta.url), 'utf8'));
const checked = SoundPack.read(raw);

// Every clip the game renders for a pack: [name, sound, opt].
function clips(sounds) {
	const out = [];
	for (let g = 0; g < 4; g++) out.push([`place ${g}`, sounds.place, S.placeOpt(sounds.place, g)]);
	for (const k of ['refused', 'clear', 'boom']) out.push([k, sounds[k], {}]);
	out.push(['sent 1', sounds.sent, {}]);
	for (const k of Object.keys(sounds.sent.sizes || {})) out.push([`sent ${k}`, sounds.sent.sizes[k], {}]);
	for (const tr of new Set(S.steps(sounds.combo.ladder))) out.push([`combo +${tr}`, sounds.combo, { transpose: tr }]);
	return out;
}
const render = (snd, opt, models, seed = 7) => {
	S.setSeed(seed);
	return S.renderSound(snd, opt, models);
};

test('the base pack passes the checker with nothing dropped', () => {
	assert.ok(checked.ok, checked.errors.join(', '));
	assert.deepEqual(checked.errors, []);
	assert.deepEqual(Object.keys(checked.pack.sounds).sort(), [...SoundPack.SLOTS].sort());
	for (const k of SoundPack.SLOTS) assert.equal(checked.pack.sounds[k].layers.length, raw.pack.sounds[k].layers.length, k);
});

test('the checker changes nothing Krischan tuned: checked and raw packs render identically', () => {
	const a = clips(raw.pack.sounds), b = clips(checked.pack.sounds);
	assert.equal(a.length, b.length);
	for (let i = 0; i < a.length; i++) {
		const x = render(a[i][1], a[i][2], raw.models), y = render(b[i][1], b[i][2], checked.pack.models);
		assert.deepEqual(y, x, a[i][0]);
	}
});

test('every clip: a sensible length, no NaN, peak at most 1, and the same for the same seed', () => {
	for (const [name, snd, opt] of clips(checked.pack.sounds)) {
		const d = render(snd, opt, checked.pack.models);
		assert.ok(d.length > S.SR * 0.05 && d.length < S.SR * 6, `${name}: ${d.length} samples`);
		let peak = 0;
		for (const v of d) {
			assert.ok(Number.isFinite(v), `${name}: not finite`);
			peak = Math.max(peak, Math.abs(v));
		}
		assert.ok(peak <= 1 && peak > 0.05, `${name}: peak ${peak}`);
		assert.deepEqual(render(snd, opt, checked.pack.models), d, `${name}: not deterministic`);
	}
});

test('different seeds give different noise (the place variants are not identical)', () => {
	const s = checked.pack.sounds.place;
	assert.notDeepEqual(render(s, {}, checked.pack.models, 11), render(s, {}, checked.pack.models, 12));
});

test('downsample2 halves the clip and keeps a tone below 10kHz', () => {
	const n = 4800, d = new Float32Array(n);
	for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 1000 * i) / S.SR) * 0.5;
	const o = S.downsample2(d);
	assert.equal(o.length, n / 2);
	let peak = 0;
	for (let i = 200; i < o.length; i++) peak = Math.max(peak, Math.abs(o[i]));
	assert.ok(peak > 0.45 && peak < 0.55, `peak ${peak}`);
});

test('the game rules: place groups, SENT inheritance, combo plays-at and wrap', () => {
	assert.deepEqual([1, 2, 3, 4, 5, 8, 9, 12].map(S.placeGroup), [0, 0, 1, 1, 2, 2, 3, 3]);
	const sent = checked.pack.sounds.sent; // sizes 2, 5, 8, 10 have their own sound
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((a) => S.sentFrom(sent, a)), [1, 2, 2, 2, 5, 5, 5, 8, 8, 10]);
	const combo = checked.pack.sounds.combo; // plays at 1 3 5 … 15
	assert.deepEqual(S.comboPlan(combo, 2), { kind: 'silent' });
	assert.deepEqual(S.comboPlan(combo, 1), { kind: 'step', idx: 1 });
	assert.deepEqual(S.comboPlan(combo, 5), { kind: 'step', idx: 3 });
	assert.deepEqual(S.comboPlan(combo, 17), S.comboPlan(combo, 1), 'wraps after 16');
	assert.equal(S.comboTranspose(combo, 3), 2);
});

test('a hostile pack is tamed, not trusted', () => {
	assert.equal(SoundPack.read('{nope').ok, false);
	assert.equal(SoundPack.read({ version: 2 }).ok, false);
	assert.equal(SoundPack.read({ format: 'other', version: 1 }).ok, false);
	const bad = SoundPack.read({
		version: 1,
		pack: {
			sounds: {
				boom: {
					layers: [
						{ type: 'tone', freq: 1e9, decay: -5, gain: 99, wave: 'evil' },
						{ type: 'script', src: 'alert(1)' },
						{ type: 'fit', model: 'missing' },
						...Array(100).fill({ type: 'noise' })
					],
					fx: { gain: 1e6, highcut: -1, room: 'x' },
					haptic: '9999 1 2 3 4 5 6 7 8 9 10 11'
				},
				nonsense: { layers: [] }
			}
		},
		models: { huge: { A: Array(5000).fill(1), E: [0] } }
	});
	assert.ok(bad.ok);
	const b = bad.pack.sounds.boom;
	assert.equal(Object.keys(bad.pack.sounds).join(), 'boom');
	assert.equal(b.layers.length, 24, 'layers capped, script and missing recording dropped');
	assert.deepEqual([b.layers[0].freq, b.layers[0].decay, b.layers[0].gain, b.layers[0].wave], [8000, 1, 1.5, 'sine']);
	assert.deepEqual([b.fx.gain, b.fx.highcut, b.fx.room], [6, 1000, 0]);
	assert.equal(b.haptic.split(' ').length, 10);
	assert.equal(b.haptic.split(' ')[0], '500');
	assert.deepEqual(bad.pack.models, {});
	const d = render(b, {}, bad.pack.models);
	for (const v of d) assert.ok(Number.isFinite(v) && Math.abs(v) <= 1.8); // +6dB at most, as in the lab
});

test('budget: what the base pack costs to ship, render and hold', () => {
	let ms = 0, samples = 0;
	for (const [, snd, opt] of clips(checked.pack.sounds)) {
		const t = performance.now();
		const d = S.trimTail(S.downsample2(render(snd, opt, checked.pack.models)));
		ms += performance.now() - t;
		samples += d.length;
	}
	const shipped = JSON.stringify({ pack: { sounds: checked.pack.sounds }, models: checked.pack.models }).length;
	// place ×4 groups and refused get 3 variants each in the game (client/sound.js)
	const memKB = (samples * 4) / 1024;
	console.log(`  sound budget: ${clips(checked.pack.sounds).length} clips, ${ms.toFixed(0)} ms to render here, ${(samples / 24000).toFixed(1)} s of audio, ${memKB.toFixed(0)} KB at 24kHz, ${(shipped / 1024).toFixed(1)} KB of pack`);
	assert.ok(shipped < 24 * 1024, 'pack under 24 KB before gzip');
	assert.ok(memKB < 2048, 'clips under 2 MB');
	assert.ok(ms < 3000, 'renders in under 3 s here (old phones: about 10–20× longer, spread over idle time)');
});
