// Sound: the synth renders the base pack safely and the same way every time, the pack
// checker leaves a good pack unchanged and tames a bad one, and the whole set fits a budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { SoundSynth as S } from '../shared/sound/synth.js';
import { SoundPack } from '../shared/sound/pack.js';

const raw = JSON.parse(readFileSync(new URL('../sounds/base.json', import.meta.url), 'utf8'));
const checked = SoundPack.read(raw);

// Every clip the game renders for a pack: [name, sound, opt].
function clips(sounds) {
	const out = [];
	for (let g = 0; g < 4; g++) out.push([`place ${g}`, sounds.place, S.placeOpt(sounds.place, g)]);
	for (const k of SoundPack.SLOTS) if (!['place', 'sent', 'combo'].includes(k) && sounds[k] && sounds[k].layers.length) out.push([k, sounds[k], {}]);
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
		assert.equal(y.length, x.length, a[i][0]);
		let at = -1;
		for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) { at = j; break; } // cheap: a deepEqual diff of two long clips runs out of memory
		assert.equal(at, -1, `${a[i][0]} differs from sample ${at}`);
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

test('a combo note mixed once and reused sounds exactly like one rendered fresh', () => {
	const c = checked.pack.sounds.combo, mix = {};
	for (const tr of S.steps(c.ladder)) {
		S.setSeed(41);
		const shared = S.renderSound(c, { transpose: tr, mix }, checked.pack.models);
		S.setSeed(41);
		assert.deepEqual(shared, S.renderSound(c, { transpose: tr }, checked.pack.models), `combo +${tr}`);
	}
});

test('each sound is stored only as finely as its high cut needs', () => {
	// The rule, not today's tuning: up to 5.4kHz → 12kHz, up to 7.2kHz → 16kHz, above → 24kHz.
	for (const [k, v] of Object.entries(checked.pack.sounds)) {
		const hc = v.fx.highcut;
		assert.equal(S.rateFor(v), hc <= 5400 ? 12000 : hc <= 7200 ? 16000 : 24000, k);
	}
	const n = 4800, d = new Float32Array(n);
	for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 3000 * i) / S.SR) * 0.5;
	const o = S.downsample(d, 4); // 12kHz keeps a 3kHz tone
	let peak = 0;
	for (let i = 100; i < o.length; i++) peak = Math.max(peak, Math.abs(o[i]));
	assert.equal(o.length, n / 4);
	assert.ok(peak > 0.4 && peak < 0.55, `peak ${peak}`);
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
	// A fixed example (plays at 1 3 5 … 15), so retuning the pack's own Plays at can't break the rule's test.
	const combo = { ...checked.pack.sounds.combo, plays: '1 3 5 7 9 11 13 15', ladder: '0 1 2 3 5 7 8 9' };
	assert.deepEqual(S.comboPlan(combo, 2), { kind: 'silent' });
	assert.deepEqual(S.comboPlan(combo, 1), { kind: 'step', idx: 1 });
	assert.deepEqual(S.comboPlan(combo, 5), { kind: 'step', idx: 3 });
	assert.deepEqual(S.comboPlan(combo, 17), S.comboPlan(combo, 1), 'wraps after 16');
	assert.equal(S.comboTranspose(combo, 3), 2);
});

test('max length and also, as Krischan set them in the lab', () => {
	const sd = checked.pack.sounds, len = (snd) => render(snd, {}, checked.pack.models).length / S.SR;
	assert.ok(len(sd.boom) <= 0.5 + 1e-9, 'boom cut at 500ms');
	assert.ok(len(sd.sent.sizes[10]) <= 0.8 + 1e-9, 'SENT 10 cut at 800ms');
	assert.ok(sd.sent.sizes[10].also.some((a) => a.slot === 'thunder'), 'SENT 10 plays Thunder');
	assert.ok(sd.iceLand.also.some((a) => a.slot === 'iceBoard'), 'Frozen Cell lands plays Ice on the board');
	assert.deepEqual(sd.counter.also.map((a) => a.slot).sort(), ['crowd', 'force'], 'Counter-spike is Crowd plus Force break');
	const bad = SoundPack.read({ version: 1, pack: { sounds: { boom: { layers: [{ type: 'noise' }], also: [{ slot: 'boom' }, { slot: 'nope' }, { slot: 'thunder', delay: 1e9, gain: 9, len: -4 }] } } } });
	assert.deepEqual(bad.pack.sounds.boom.also, [{ slot: 'thunder', delay: 2000, gain: 2, len: 0 }], 'no self, no unknown, delay, level and duration clamped');
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

test('an empty Plays at means every combo count (it used to read as [0] and silence them all)', () => {
	assert.deepEqual(S.steps(''), []);
	assert.deepEqual(S.steps('  '), []);
	const combo = { ...checked.pack.sounds.combo, plays: '' };
	for (let n = 1; n <= 16; n++) assert.equal(S.comboPlan(combo, n).kind, 'step', `count ${n}`);
});

test('smoothed wind and crowd curves are 8x smaller and sound nearly the same', () => {
	const sm = SoundPack.smooth(checked.pack.models);
	const slow = Object.keys(sm).filter((k) => sm[k].hop);
	assert.ok(slow.length >= 1, 'some curve was smoothed');
	for (const k of slow) {
		assert.ok(sm[k].E.length <= Math.ceil(checked.pack.models[k].E.length / 8), k);
		const layer = { type: 'fit', on: true, model: k, env: k, gain: 1, delay: 0, pitch: 0, tail: 1, start: 0, len: 0, fadeIn: 0, fadeOut: 0 };
		const fx = { lowcut: 20, eqLow: 0, eqMid: 0, eqHigh: 0, highcut: 20000, warmth: 0, room: 0, gain: 0, wobble: 0, maxLen: 0, fadeOut: 0 };
		const a = render({ layers: [layer], fx }, {}, checked.pack.models), b = render({ layers: [layer], fx }, {}, sm);
		const db = (x) => 10 * Math.log10(x.reduce((s, v) => s + v * v, 0) / x.length);
		assert.ok(Math.abs(b.length - a.length) / a.length < 0.02, `${k}: same length`);
		assert.ok(Math.abs(db(a) - db(b)) < 1.5, `${k}: overall level within 1.5dB`);
	}
});

test('renderJob (the background thread and the fallback) makes exactly what renderSound makes', () => {
	const sd = checked.pack.sounds, mixes = {};
	for (const [slot, size, opt] of [['clear', 1, {}], ['sent', 10, {}], ['place', 1, S.placeOpt(sd.place, 2)], ['iceLand', 1, {}]]) {
		const snd = size > 1 ? sd[slot].sizes[size] : sd[slot];
		const r = S.renderJob(sd, checked.pack.models, { slot, size, opt, seed: 9 }, mixes);
		S.setSeed(9);
		const want = S.downsample(S.renderSound(snd, opt, checked.pack.models), S.SR / S.rateFor(snd));
		assert.equal(r.rate, S.rateFor(snd));
		assert.deepEqual(r.data, want, slot);
	}
	assert.equal(S.renderJob(sd, checked.pack.models, { slot: 'nope', size: 1, opt: {}, seed: 1 }, mixes).data, null);
});

test('Off, Minimal and Full make only their own clips', async () => {
	const { createSound } = await import('../client/sound.js');
	const snd = createSound(raw);
	const keys = () => {
		const r = snd.renderAll();
		return r.clips;
	};
	snd.setLevel('full');
	const full = keys();
	snd.setLevel('minimal');
	const minimal = keys();
	snd.setLevel('off');
	const off = keys();
	assert.ok(full > minimal && minimal > 0, `full ${full}, minimal ${minimal}`);
	assert.equal(off, 0, 'off makes nothing');
	assert.ok(snd.MINIMAL.has('refused') && snd.MINIMAL.has('clear'), 'Minimal keeps Refused and Board clear (Krischan)');
	for (const k of ['place', 'iceBoard', 'mineTick', 'bank', 'queue', 'crowd', 'thunder']) assert.ok(!snd.MINIMAL.has(k), `Minimal drops ${k}`);
});

test('the built background renderer runs and makes the same clip', async () => {
	const { readFileSync, existsSync } = await import('node:fs');
	const vm = await import('node:vm');
	const url = new URL('../public/sound-worker.js', import.meta.url);
	if (!existsSync(url)) return; // run `node build.mjs` first to include this check
	const got = [];
	const ctx = { setTimeout, postMessage: (m) => got.push(m), Float32Array, Math, Object, Array, Number, isFinite, String, Set, Map, JSON };
	vm.createContext(ctx);
	vm.runInContext(readFileSync(url, 'utf8'), ctx);
	const shipped = SoundPack.read(raw);
	ctx.onmessage({ data: { t: 'pack', pack: { sounds: shipped.pack.sounds, models: shipped.pack.models } } });
	ctx.onmessage({ data: { t: 'queue', jobs: [{ key: 'clear', slot: 'clear', size: 1, opt: {}, seed: 31 }] } });
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(got.length, 1);
	const want = S.renderJob(shipped.pack.sounds, shipped.pack.models, { slot: 'clear', size: 1, opt: {}, seed: 31 }, {});
	assert.deepEqual(new Float32Array(got[0].data), want.data);
});

test('budget: what the base pack costs to ship, render and hold', () => {
	let ms = 0, samples = 0, seconds = 0;
	const mix = {};
	for (const [, snd, opt] of clips(checked.pack.sounds)) {
		const rate = S.rateFor(snd);
		const t = performance.now();
		const d = S.trimTail(S.downsample(render(snd, snd === checked.pack.sounds.combo ? { ...opt, mix } : opt, checked.pack.models), S.SR / rate));
		ms += performance.now() - t;
		samples += d.length;
		seconds += d.length / rate;
	}
	// What VS ships: the other modes' sounds left out, slow curves smoothed (build.mjs).
	const vs = SoundPack.read(raw, { skip: ['perfect', 'timeLow', 'timeUp', 'badge'] });
	const vsPack = { pack: { sounds: vs.pack.sounds }, models: SoundPack.smooth(vs.pack.models) };
	const shipped = JSON.stringify(vsPack).length;
	const memKB = (samples * 4) / 1024;
	console.log(`  sound budget: ${clips(checked.pack.sounds).length} clips, ${ms.toFixed(0)} ms to render here, ${seconds.toFixed(1)} s of audio, ${memKB.toFixed(0)} KB, ${(shipped / 1024).toFixed(1)} KB of pack`);
	const gz = gzipSync(JSON.stringify(vsPack)).length;
	console.log(`  sound download: ${(gz / 1024).toFixed(1)} KB gzipped`);
	assert.ok(gz < 20 * 1024, 'pack under 20 KB gzipped');
	assert.ok(memKB < 2048, 'every clip, all modes, under 2 MB (VS Full makes fewer; Minimal fewer still)');
	assert.ok(ms < 3000, 'renders in under 3 s here (old phones: about 10–20× longer, spread over idle time)');
});
