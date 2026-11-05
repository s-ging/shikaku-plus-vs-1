// pack.js — read a sound pack and make it safe to render.
//
// Never trust a pack: players will load their own later. Every number is clamped
// to the range the Sound Lab's sliders allow, unknown layer types and sounds are
// dropped, and a layer that needs a recording the pack doesn't carry is skipped.
// A value inside its range comes through exactly as tuned, so the base pack is
// unchanged by this (test/sound.test.js checks that).
//
// Format: { format:'shikaku-sound-pack', version:1, sampleRate:48000, pack:{sounds}, models }.
// Lab-only fields (locked, savedAt, name, src, builtIn) are ignored.

export const SoundPack = (() => {
	const VERSION = 1;
	const SLOTS = ['place', 'refused', 'clear', 'boom', 'sent', 'combo'];

	// [key, min, max] — the lab's slider ranges (the Sound Lab's SPEC tables).
	const COMMON = [['gain', 0, 1.5], ['delay', 0, 400]];
	const LAYER = {
		fit: [...COMMON, ['pitch', -24, 24], ['tail', 0.3, 3]],
		tone: [...COMMON, ['freq', 20, 8000], ['end', 20, 8000], ['glide', 1, 500], ['attack', 0, 50], ['decay', 1, 1500]],
		noise: [...COMMON, ['freq', 40, 16000], ['q', 0.3, 12], ['attack', 0, 50], ['decay', 0.2, 1500]],
		pluck: [...COMMON, ['freq', 40, 4000], ['decay', 20, 3000], ['bright', 0, 1]]
	};
	const FX = [['lowcut', 20, 1000, 20], ['eqLow', -18, 18, 0], ['eqMid', -18, 18, 0], ['eqHigh', -18, 18, 0], ['highcut', 1000, 20000, 20000],
		['warmth', 0, 1, 0], ['room', 0, 1, 0], ['gain', -24, 6, 0], ['wobble', 0, 10, 0]];
	const SEQ = [['gap', 10, 250], ['stepGain', 0, 1.5], ['lastGain', 0, 1.5], ['lastTail', 0.3, 4]];
	const SIZE = [['tailMax', 1, 3], ['roomMax', 0, 1], ['curve', 0, 0.5]];
	const WAVES = ['sine', 'triangle', 'square', 'saw'];
	const FILTERS = ['bandpass', 'lowpass', 'highpass'];
	const MAX_LAYERS = 24;
	const SENT_MAX = 10;

	const num = (v, lo, hi, dflt) => {
		const x = typeof v === 'number' ? v : parseFloat(v);
		if (!isFinite(x)) return dflt !== undefined ? dflt : lo;
		return x < lo ? lo : x > hi ? hi : x;
	};
	const pick = (v, list) => (list.includes(v) ? v : list[0]);
	// A list of numbers written as text ("0 9 17 21"), kept as text, each number clamped.
	function list(v, lo, hi, max) {
		const out = String(v == null ? '' : v)
			.trim()
			.split(/[\s,]+/)
			.map(Number)
			.filter((x) => isFinite(x))
			.slice(0, max)
			.map((x) => (x < lo ? lo : x > hi ? hi : x));
		return String(v == null ? '' : v).trim() === '' ? '' : out.join(' ');
	}

	function layer(L, models) {
		if (!L || typeof L !== 'object' || !LAYER[L.type]) return null;
		const o = { type: L.type, on: L.on !== false };
		for (const [k, lo, hi] of LAYER[L.type]) o[k] = num(L[k], lo, hi);
		if (L.type === 'tone') o.wave = pick(L.wave, WAVES);
		if (L.type === 'noise') o.filter = pick(L.filter, FILTERS);
		if (L.type === 'fit') {
			if (!models[L.model]) return null;
			o.model = L.model;
			o.env = models[L.env] ? L.env : L.model;
		}
		return o;
	}

	function sound(S, models, slot) {
		if (!S || typeof S !== 'object') return null;
		const o = { layers: [], fx: {}, haptic: list(S.haptic, 0, 500, 10) };
		for (const L of Array.isArray(S.layers) ? S.layers : []) {
			const c = layer(L, models);
			if (c) o.layers.push(c);
			if (o.layers.length >= MAX_LAYERS) break;
		}
		const fx = S.fx || {};
		for (const [k, lo, hi, d] of FX) o.fx[k] = num(fx[k], lo, hi, d);
		if (S.seq && typeof S.seq === 'object') {
			const q = S.seq;
			o.seq = { on: !!q.on, keepLength: !!q.keepLength, steps: list(q.steps, -48, 48, 16) || '0' };
			for (const [k, lo, hi] of SEQ) o.seq[k] = num(q[k], lo, hi, 1);
		}
		if (slot === 'place' && S.size) {
			o.size = {};
			for (const [k, lo, hi] of SIZE) o.size[k] = num(S.size[k], lo, hi);
		}
		if (slot === 'combo') {
			o.plays = list(S.plays, 1, 16, 16);
			o.ladder = list(S.ladder, -24, 36, 16);
		}
		if (slot === 'sent' && S.sizes && typeof S.sizes === 'object') {
			o.sizes = {};
			for (const k of Object.keys(S.sizes)) {
				const n = +k;
				if (!Number.isInteger(n) || n < 2 || n > SENT_MAX) continue;
				const c = sound(S.sizes[k], models, 'sent-size');
				if (c) o.sizes[n] = c;
			}
		}
		return o;
	}

	// A recording rebuild: order+1 filter coefficients (A[0] = 1) and loudness bytes.
	function model(m) {
		if (!m || !Array.isArray(m.A) || !Array.isArray(m.E)) return null;
		if (m.A.length < 2 || m.A.length > 65 || m.E.length < 2 || m.E.length > 4000) return null;
		const A = m.A.map((v) => num(v, -64, 64, 0));
		A[0] = 1;
		return { A, E: m.E.map((v) => Math.round(num(v, 0, 255, 255))) };
	}

	/** Parse text or an object. Returns { ok, pack:{sounds, models}, errors }. Never throws. */
	function read(input) {
		let j = input;
		const errors = [];
		if (typeof j === 'string') {
			try {
				j = JSON.parse(j);
			} catch (e) {
				return { ok: false, errors: ['not JSON'] };
			}
		}
		if (!j || typeof j !== 'object') return { ok: false, errors: ['not a pack'] };
		if (j.format !== undefined && j.format !== 'shikaku-sound-pack') return { ok: false, errors: ['not a Shikaku+ sound pack'] };
		if (j.version !== VERSION) return { ok: false, errors: ['unknown pack version ' + j.version] };
		if (j.sampleRate !== undefined && j.sampleRate !== 48000) return { ok: false, errors: ['sample rate must be 48000'] };
		const models = {};
		for (const k of Object.keys(j.models || {})) {
			const m = model(j.models[k]);
			if (m) models[k] = m;
			else errors.push('bad recording ' + k);
		}
		const src = (j.pack && j.pack.sounds) || {},
			sounds = {};
		for (const slot of SLOTS) {
			const s = sound(src[slot], models, slot);
			if (s) sounds[slot] = s;
		}
		// Keep only the recordings some layer uses.
		const used = {};
		const walk = (s) => s.layers.forEach((L) => L.type === 'fit' && ((used[L.model] = models[L.model]), (used[L.env] = models[L.env])));
		for (const s of Object.values(sounds)) {
			walk(s);
			if (s.sizes) Object.values(s.sizes).forEach(walk);
		}
		return { ok: true, pack: { sounds, models: used }, errors };
	}

	return { VERSION, SLOTS, read };
})();
