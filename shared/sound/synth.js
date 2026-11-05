// synth.js — the Shikaku+ sound synthesizer: pure arithmetic, no DOM, no Web Audio.
//
// Moved out of Krischan's Sound Lab artifact (2026-11-06) so the lab and the game
// render with one copy of the rules, as the engine does (decision 0007). Keep it
// line-for-line portable to Dart: plain loops, Float32Array/Float64Array, and a
// seeded xorshift for every random number, so the same seed gives the same clip.
//
// Everything renders at 48kHz, the rate the lab was tuned at. That matters for the
// recording rebuilds ('fit' layers): their resonance coefficients were measured at
// 48kHz and only sound right there. The game halves the finished clip to 24kHz
// with downsample2() to save memory, after rendering.
//
// Wrapped in one object because build.mjs stitches every file into one script,
// and names like room or clamp already exist elsewhere in it.

export const SoundSynth = (() => {
	const SR = 48000;
	const HOP = 24; // a recording's loudness curve has one byte per 0.5ms
	const P = Math.PI * 2;

	let seed = 1;
	const setSeed = (s) => {
		seed = s >>> 0 || 1;
	};
	const rn = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return ((seed >>> 0) / 4294967296) * 2 - 1;
	};

	function norm(o, pk) {
		let m = 0;
		for (let i = 0; i < o.length; i++) {
			const v = Math.abs(o[i]);
			if (v > m) m = v;
		}
		if (m > 0) {
			const k = pk / m;
			for (let i = 0; i < o.length; i++) o[i] *= k;
		}
		return o;
	}

	function resample(src, rate) {
		if (Math.abs(rate - 1) < 1e-4) return src;
		const n = Math.max(1, Math.floor(src.length / rate)),
			o = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const x = i * rate,
				j = Math.floor(x),
				f = x - j;
			o[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f;
		}
		return o;
	}

	function biquad(o, type, f, Q, g) {
		f = Math.min(f, SR * 0.45);
		const A = Math.pow(10, (g || 0) / 40),
			w = (P * f) / SR,
			c = Math.cos(w),
			s = Math.sin(w),
			al = s / (2 * Q);
		let b0, b1, b2, a0, a1, a2;
		if (type === 'lowpass') {
			b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
		} else if (type === 'highpass') {
			b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
		} else if (type === 'bandpass') {
			b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
		} else if (type === 'peak') {
			b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
		} else {
			const q = 2 * Math.sqrt(A) * al;
			if (type === 'lowshelf') {
				b0 = A * (A + 1 - (A - 1) * c + q); b1 = 2 * A * (A - 1 - (A + 1) * c); b2 = A * (A + 1 - (A - 1) * c - q);
				a0 = A + 1 + (A - 1) * c + q; a1 = -2 * (A - 1 + (A + 1) * c); a2 = A + 1 + (A - 1) * c - q;
			} else {
				b0 = A * (A + 1 + (A - 1) * c + q); b1 = -2 * A * (A - 1 + (A + 1) * c); b2 = A * (A + 1 + (A - 1) * c - q);
				a0 = A + 1 - (A - 1) * c + q; a1 = 2 * (A - 1 - (A + 1) * c); a2 = A + 1 - (A - 1) * c - q;
			}
		}
		b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
		let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
		for (let i = 0; i < o.length; i++) {
			const x = o[i],
				y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
			x2 = x1; x1 = x; y2 = y1; y1 = y;
			o[i] = y;
		}
	}

	function renderTone(L, tail) {
		const at = L.attack / 1000,
			tau = Math.max(0.0005, (L.decay / 1000) * tail),
			gl = Math.max(0.001, L.glide / 1000),
			n = Math.min(SR * 3, Math.ceil((at + tau * 7) * SR) + 1),
			o = new Float32Array(n);
		let ph = 0;
		for (let i = 0; i < n; i++) {
			const t = i / SR,
				f = L.end + (L.freq - L.end) * Math.exp(-t / gl);
			ph = (ph + f / SR) % 1;
			let w;
			switch (L.wave) {
				case 'triangle': w = 1 - 4 * Math.abs(ph - 0.5); break;
				case 'square': w = ph < 0.5 ? 1 : -1; break;
				case 'saw': w = 2 * ph - 1; break;
				default: w = Math.sin(P * ph);
			}
			const env = t < at ? t / at : Math.exp(-(t - at) / tau);
			o[i] = w * env;
		}
		return o;
	}

	function renderNoise(L, tail) {
		const at = L.attack / 1000,
			tau = Math.max(0.0001, (L.decay / 1000) * tail),
			n = Math.min(SR * 3, Math.ceil((at + tau * 8) * SR) + 64),
			o = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const t = i / SR;
			o[i] = rn() * (t < at ? t / at : Math.exp(-(t - at) / tau));
		}
		biquad(o, L.filter, L.freq, L.q);
		return o;
	}

	function renderPluck(L, tail) {
		const N0 = Math.max(2, Math.round(SR / L.freq)),
			buf = new Float32Array(N0);
		for (let i = 0; i < N0; i++) buf[i] = rn();
		const dsec = (L.decay / 1000) * tail,
			n = Math.min(SR * 3, Math.ceil(dsec * 6 * SR)),
			o = new Float32Array(n),
			d = Math.exp(-1 / (dsec * L.freq)),
			k = 0.5 - 0.45 * L.bright;
		let j = 0;
		for (let i = 0; i < n; i++) {
			const nx = (j + 1) % N0,
				v = buf[j];
			buf[j] = d * ((1 - k) * v + k * buf[nx]);
			o[i] = v;
			j = nx;
		}
		return o;
	}

	// A recording rebuild: noise shaped by one recording's loudness curve (env),
	// through another's fitted resonances (model).
	function renderFit(L, tail, models) {
		const fm = models[L.model],
			em = models[L.env] || fm;
		if (!fm) return new Float32Array(1);
		const A = fm.A,
			E = em.E,
			p = A.length - 1;
		let pk = 0;
		for (let i = 1; i < E.length; i++) if (E[i] < E[pk]) pk = i;
		const post = E.length - pk,
			nEx = Math.round((pk + post * tail) * HOP),
			n = nEx + Math.round(0.03 * SR),
			y = new Float64Array(n),
			o = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			let ex = 0;
			if (i < nEx) {
				let k = i / HOP;
				if (k > pk) k = pk + (k - pk) / tail;
				const k0 = Math.min(E.length - 1, Math.floor(k)),
					k1 = Math.min(E.length - 1, k0 + 1),
					fr = k - Math.floor(k),
					db = ((E[k0] * (1 - fr) + E[k1] * fr) / 255) * 60;
				ex = rn() * Math.pow(10, -db / 20);
			}
			let acc = ex;
			for (let q = 1; q <= p && q <= i; q++) acc -= A[q] * y[i - q];
			y[i] = acc;
			o[i] = acc;
		}
		return resample(o, Math.pow(2, L.pitch / 12));
	}

	const RENDER = { tone: renderTone, noise: renderNoise, pluck: renderPluck, fit: renderFit };
	function renderLayer(L, tail, models) {
		return norm(RENDER[L.type](L, tail, models), L.gain);
	}

	function mixLayers(layers, tail, models) {
		const parts = [];
		let len = 0;
		for (const L of layers) {
			if (!L.on || L.gain <= 0 || !RENDER[L.type]) continue;
			const b = renderLayer(L, tail, models),
				off = Math.round((L.delay / 1000) * SR);
			parts.push([b, off]);
			len = Math.max(len, off + b.length);
		}
		const o = new Float32Array(Math.max(len, 1));
		for (const [b, off] of parts) for (let i = 0; i < b.length; i++) o[off + i] += b[i];
		return o;
	}

	const steps = (s) =>
		String(s || '')
			.trim()
			.split(/[\s,]+/)
			.map(Number)
			.filter((v) => isFinite(v));

	// Pitch every layer up by st semitones while keeping its length (seq.keepLength).
	function transposeLayers(layers, st) {
		const r = Math.pow(2, st / 12);
		return layers.map((L) => {
			const c = Object.assign({}, L);
			if (c.type === 'fit') {
				c.pitch = (c.pitch || 0) + st;
				c.tail = (c.tail || 1) * r;
			} else {
				if (c.freq) c.freq = Math.min(c.freq * r, SR * 0.45);
				if (c.end) c.end = Math.min(c.end * r, SR * 0.45);
			}
			return c;
		});
	}

	// Four feedback combs, low-passed and mixed in: a small room baked into the clip.
	function room(o, amt) {
		if (amt <= 0) return;
		const wet = new Float32Array(o.length),
			fb = 0.55 + amt * 0.3;
		for (const dd of [0.0297, 0.0371, 0.0411, 0.0437]) {
			const d = Math.round(dd * SR),
				b = new Float32Array(o.length);
			for (let i = 0; i < o.length; i++) b[i] = o[i] + (i >= d ? b[i - d] * fb : 0);
			for (let i = 0; i < o.length; i++) wet[i] += b[i];
		}
		let y = 0;
		const k = 1 - Math.exp((-P * 3500) / SR);
		for (let i = 0; i < o.length; i++) {
			y += k * (wet[i] - y);
			o[i] += y * amt * 0.09;
		}
	}

	const keepOf = (S) => !!(S.seq && S.seq.keepLength);

	/**
	 * One finished clip for a sound. opt: { tail, room, transpose }.
	 * Returns a Float32Array at 48kHz, peak 0.9 × the sound's volume.
	 */
	function renderSound(S, opt, models) {
		opt = opt || {};
		const tail = opt.tail || 1,
			rm = Math.min(1, (S.fx.room || 0) + (opt.room || 0));
		let o;
		if (S.seq && S.seq.on) {
			const st = steps(S.seq.steps).map((v) => v + (opt.transpose || 0));
			// opt.mix: a cache shared across a combo's ladder notes. With keepLength off every note
			// is the same mix pitched, so it's mixed once (same seed, same layers: same samples).
			const mc = opt.mix,
				base = mc && mc.base ? mc.base : mixLayers(S.layers, tail, models),
				last = mc && mc.last ? mc.last : S.seq.lastTail !== 1 ? mixLayers(S.layers, tail * S.seq.lastTail, models) : base;
			if (mc && !keepOf(S)) {
				mc.base = base;
				mc.last = last;
			}
			const gap = Math.round((S.seq.gap / 1000) * SR);
			const keep = S.seq.keepLength,
				memo = {};
			const note = (s, isL) => {
				if (!keep) return resample(isL ? last : base, Math.pow(2, s / 12));
				const k = s + (isL ? 'L' : '');
				if (!memo[k]) memo[k] = mixLayers(transposeLayers(S.layers, s), tail * (isL ? S.seq.lastTail : 1), models);
				return memo[k];
			};
			const parts = st.map((s, i) => {
				const isL = i === st.length - 1;
				return [note(s, isL), i * gap, isL ? S.seq.lastGain : S.seq.stepGain];
			});
			let len = 1;
			for (const [b, off] of parts) len = Math.max(len, off + b.length);
			o = new Float32Array(len);
			for (const [b, off, g] of parts) for (let i = 0; i < b.length; i++) o[off + i] += b[i] * g;
		} else o = mixLayers(S.layers, tail, models);
		if (rm > 0) {
			const ext = new Float32Array(o.length + Math.round((0.05 + rm * 0.4) * SR));
			ext.set(o);
			o = ext;
		}
		const fx = S.fx;
		if (fx.lowcut > 20) biquad(o, 'highpass', fx.lowcut, 0.707);
		if (fx.eqLow) biquad(o, 'lowshelf', 200, 0.707, fx.eqLow);
		if (fx.eqMid) biquad(o, 'peak', 1000, 1, fx.eqMid);
		if (fx.eqHigh) biquad(o, 'highshelf', 5000, 0.707, fx.eqHigh);
		if (fx.highcut < 20000) biquad(o, 'lowpass', fx.highcut, 0.707);
		if (fx.warmth > 0) {
			const d = 1 + fx.warmth * 4,
				nn = Math.tanh(d);
			norm(o, 1);
			for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * d) / nn;
		}
		room(o, rm);
		return norm(o, 0.9 * Math.pow(10, fx.gain / 20));
	}

	// —— Game-side helpers: the rules the lab plays by, kept next to the synth ——

	/** Place: four Tile-size groups, each its own clip; pitch by playback speed. */
	const PLACE_GROUPS = [[1, 2], [3, 4], [5, 8], [9, 12]];
	function placeGroup(size) {
		for (let i = 0; i < PLACE_GROUPS.length; i++) if (size <= PLACE_GROUPS[i][1]) return i;
		return PLACE_GROUPS.length - 1;
	}
	function placeOpt(S, gi) {
		const z = S.size;
		if (!z) return {};
		const g = PLACE_GROUPS[gi],
			u = ((g[0] + g[1]) / 2 - 1) / 11;
		return { tail: 1 + (z.tailMax - 1) * u, room: z.roomMax * u };
	}
	const placeRate = (S, size) => (S.size ? Math.pow(2 / Math.max(1, size), S.size.curve) : 1);

	/** SENT: size 1 is the sound itself; a bigger size uses the nearest smaller size with its own entry. */
	function sentFrom(S, a) {
		for (let k = Math.floor(a); k > 1; k--) if (S.sizes && S.sizes[k]) return k;
		return 1;
	}
	const sentSound = (S, a) => (sentFrom(S, a) === 1 ? S : S.sizes[sentFrom(S, a)]);

	/** Combo: counts wrap after 16; it plays only at the counts in `plays` (empty = all). */
	const COMBO_WRAP = 16;
	function comboPlan(S, n) {
		n = ((n - 1) % COMBO_WRAP) + 1;
		const pl = steps(S.plays);
		if (!pl.length) return { kind: 'step', idx: n };
		let idx = 0;
		for (const v of pl) if (v <= n) idx++;
		return pl.includes(n) ? { kind: 'step', idx } : { kind: 'silent' };
	}
	/** Semitones up for a combo step (idx from comboPlan). */
	function comboTranspose(S, idx) {
		const ld = steps(S.ladder);
		return ld.length ? ld[(idx - 1) % ld.length] : 0;
	}

	/**
	 * Store a sound only as finely as its high cut needs (Krischan, 2026-11-06): 12kHz for a
	 * cut at 5.4kHz or below, 16kHz up to 7.2kHz, otherwise 24kHz. Nothing above the high cut
	 * is left to keep, so this costs nothing you can hear.
	 */
	const rateFor = (S) => {
		const hc = S && S.fx ? S.fx.highcut : 20000;
		return hc <= 5400 ? 12000 : hc <= 7200 ? 16000 : 24000;
	};

	/** Reduce a 48kHz clip to 48000/factor: low-pass at 0.45× the new rate (4 poles), then keep every factor-th sample. */
	function downsample(d, factor) {
		const t = Float32Array.from(d),
			fc = (0.45 * SR) / factor;
		biquad(t, 'lowpass', fc, 0.54);
		biquad(t, 'lowpass', fc, 1.31);
		const o = new Float32Array(Math.ceil(t.length / factor));
		for (let i = 0; i < o.length; i++) o[i] = t[i * factor];
		return o;
	}
	const downsample2 = (d) => downsample(d, 2);

	/** Cut the silent end: everything after the last sample above −50dB of the peak. */
	function trimTail(d, db = -50) {
		let m = 0;
		for (let i = 0; i < d.length; i++) {
			const v = Math.abs(d[i]);
			if (v > m) m = v;
		}
		const th = m * Math.pow(10, db / 20);
		for (let i = d.length - 1; i >= 0; i--) if (Math.abs(d[i]) > th) return d.subarray(0, i + 1);
		return d;
	}

	return {
		SR, HOP, setSeed, renderSound, renderLayer, mixLayers, transposeLayers, steps, biquad, resample, norm,
		PLACE_GROUPS, placeGroup, placeOpt, placeRate, sentFrom, sentSound, COMBO_WRAP, comboPlan, comboTranspose,
		downsample, downsample2, rateFor, trimTail
	};
})();
