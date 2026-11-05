// sound.js — plays the sound pack. Build once, replay forever (game/sound.md in the wiki).
//
//   Rendering  every clip is rendered by shared/sound/synth.js once, one clip per idle
//              moment after the page loads (place and refused first), then halved to
//              24kHz and trimmed at −50dB. Nothing is synthesized during play.
//   Playing    one AudioBufferSource per sound, pitch by playback speed, one master gain.
//              At most 8 at once; the same clip won't restart within 30ms.
//   Not ready  a clip that isn't rendered yet is skipped and moved to the front of the
//              queue, never rendered on the spot: a long one (SENT 10) could take a second
//              on an old phone, and sound must never stall the game.
//   Muted      no AudioContext, nothing rendered. Idle: no timers once the queue is done.
//   Haptics    navigator.vibrate where it exists (Android). iPhone web pages can't vibrate.
//
// Slots not designed yet are listed so events can name them, and stay silent.

import { SoundSynth } from '../shared/sound/synth.js';
import { SoundPack } from '../shared/sound/pack.js';

export function createSound(rawPack) {
	const S = SoundSynth;
	const read = SoundPack.read(rawPack);
	const pack = read.ok ? read.pack : { sounds: {}, models: {} };
	const sounds = pack.sounds;
	const RATE = 24000;
	const MAX_VOICES = 8;
	const VARIANTS = { place: 3, refused: 3 }; // a fresh-sounding clack each time, as the lab plays it
	const SILENT = ['ice', 'mineTick', 'defuse', 'mineReceived', 'bank', 'queue', 'frostWarning', 'countdown', 'rush', 'win', 'lose'];

	const pref = (k, dflt) => {
		try {
			const v = localStorage.getItem(k);
			return v == null ? dflt : v === 'on';
		} catch {
			return dflt;
		}
	};
	const save = (k, on) => {
		try {
			localStorage.setItem(k, on ? 'on' : 'off');
		} catch {}
	};
	let soundOn = pref('vs.sound', true);
	let vibeOn = pref('vs.vibe', true);
	const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

	// —— Clips: key → { sound, opt, seed } to render; key → Float32Array once rendered ——
	const jobs = new Map();
	const data = new Map();
	const buffers = new Map();
	function job(key, sound, opt, seed) {
		if (sound && sound.layers.length) jobs.set(key, { sound, opt, seed });
	}
	for (let v = 0; v < VARIANTS.place; v++) for (let g = 0; g < 4; g++) sounds.place && job(`place:${g}:${v}`, sounds.place, S.placeOpt(sounds.place, g), 11 + v);
	for (let v = 0; v < VARIANTS.refused; v++) job(`refused:${v}`, sounds.refused, {}, 21 + v);
	job('clear', sounds.clear, {}, 31);
	if (sounds.combo) {
		const on = sounds.combo.seq && sounds.combo.seq.on;
		for (const tr of on ? new Set(S.steps(sounds.combo.ladder)) : [0]) job(`combo:${tr}`, sounds.combo, { transpose: tr }, 41);
	}
	job('boom', sounds.boom, {}, 51);
	if (sounds.sent) {
		job('sent:1', sounds.sent, {}, 61);
		for (const k of Object.keys(sounds.sent.sizes || {})) job(`sent:${k}`, sounds.sent.sizes[k], {}, 61);
	}
	const queue = [...jobs.keys()];

	function render(key) {
		const j = jobs.get(key);
		if (!j || data.has(key)) return;
		S.setSeed(j.seed);
		let d = S.trimTail(S.downsample2(S.renderSound(j.sound, j.opt, pack.models)));
		for (let i = 0; i < d.length; i++) if (!isFinite(d[i])) {
			d = null; // a pack that makes an unstable filter: drop that clip, keep the game going
			break;
		}
		data.set(key, d);
		const i = queue.indexOf(key);
		if (i >= 0) queue.splice(i, 1);
	}

	let idleBusy = false;
	const idle = typeof requestIdleCallback === 'function' ? (f) => requestIdleCallback(f, { timeout: 500 }) : (f) => setTimeout(f, 30);
	function pump() {
		if (idleBusy || !soundOn || !queue.length) return;
		idleBusy = true;
		idle(() => {
			idleBusy = false;
			if (!soundOn || !queue.length) return;
			render(queue[0]);
			pump();
		});
	}

	// —— Audio: one context, made on the first tap ——
	let ctx = null;
	let out = null;
	const voices = [];
	const lastStart = new Map();
	function audio() {
		if (!soundOn) return null;
		if (!ctx) {
			const C = window.AudioContext || window.webkitAudioContext;
			if (!C) return null;
			try {
				ctx = new C();
			} catch {
				return null;
			}
			out = ctx.createGain();
			out.gain.value = 0.7; // the lab's default volume, where the pack was tuned
			out.connect(ctx.destination);
			// Old iOS only unlocks audio once something plays inside the tap.
			const b = ctx.createBuffer(1, 1, 22050);
			const s = ctx.createBufferSource();
			s.buffer = b;
			s.connect(out);
			s.start(0);
		}
		if (ctx.state === 'suspended') ctx.resume().catch(() => {});
		return ctx;
	}
	function unlock() {
		if (soundOn) audio();
	}
	if (typeof window !== 'undefined') {
		for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, unlock, { passive: true });
		document.addEventListener('visibilitychange', () => {
			if (!ctx) return;
			if (document.hidden) ctx.suspend().catch(() => {});
			else if (soundOn) ctx.resume().catch(() => {});
		});
	}

	function bufferFor(key) {
		let b = buffers.get(key);
		if (b) return b;
		const d = data.get(key);
		if (!d) return null;
		b = ctx.createBuffer(1, d.length, RATE);
		b.getChannelData(0).set(d);
		buffers.set(key, b);
		return b;
	}

	function buzz(sound) {
		if (!vibeOn || !canVibrate || !sound || !sound.haptic) return;
		try {
			const pat = S.steps(sound.haptic).map((v) => Math.max(0, Math.round(v)));
			if (pat.length) navigator.vibrate(pat);
		} catch {}
	}

	let rr = 0;
	function play(key, sound, rate) {
		buzz(sound);
		if (!soundOn || !jobs.has(key)) return;
		if (!data.has(key)) {
			// Not ready: skip it this once and render it next.
			const i = queue.indexOf(key);
			if (i > 0) queue.splice(0, 0, ...queue.splice(i, 1));
			pump();
			return;
		}
		if (typeof document !== 'undefined' && document.hidden) return;
		const c = audio();
		if (!c || c.state === 'closed') return; // still resuming from the first tap: it starts the moment audio does
		const now = c.currentTime;
		if (now - (lastStart.get(key) || -1) < 0.03) return;
		lastStart.set(key, now);
		const b = bufferFor(key);
		if (!b) return;
		while (voices.length >= MAX_VOICES) {
			try {
				voices.shift().stop();
			} catch {}
		}
		const src = c.createBufferSource();
		src.buffer = b;
		const w = (sound.fx.wobble || 0) / 100;
		src.playbackRate.value = rate * (w ? 1 + (Math.random() * 2 - 1) * w : 1);
		src.connect(out);
		src.onended = () => {
			const i = voices.indexOf(src);
			if (i >= 0) voices.splice(i, 1);
		};
		voices.push(src);
		src.start(0);
	}

	// —— What the game calls ——
	function place(size) {
		const s = sounds.place;
		if (!s) return;
		play(`place:${S.placeGroup(size)}:${rr++ % VARIANTS.place}`, s, S.placeRate(s, size));
	}
	function refused() {
		if (sounds.refused) play(`refused:${rr++ % VARIANTS.refused}`, sounds.refused, 1);
	}
	function combo(count) {
		const s = sounds.combo;
		if (!s) return;
		const plan = S.comboPlan(s, count);
		if (plan.kind === 'silent') return;
		const tr = S.comboTranspose(s, plan.idx);
		if (s.seq && s.seq.on) play(`combo:${tr}`, s, 1);
		else play('combo:0', s, Math.pow(2, tr / 12));
	}
	function sent(size) {
		const s = sounds.sent;
		if (!s) return;
		const a = Math.max(1, Math.min(10, Math.round(size)));
		const from = S.sentFrom(s, a);
		play(`sent:${from}`, from === 1 ? s : s.sizes[from], 1);
	}
	/** One engine event on your own board (see client/ui.js animate). */
	function event(e) {
		if (e.kind === 'clear') {
			if (sounds.clear) play('clear', sounds.clear, 1);
			if (e.combo) combo(e.combo);
		} else if (e.kind === 'mineExplode') {
			if (sounds.boom) play('boom', sounds.boom, 1);
		} else if (e.kind === 'send' && e.pass > 0) sent(e.pass);
	}

	function setSound(on) {
		soundOn = !!on;
		save('vs.sound', soundOn);
		if (soundOn) {
			audio();
			pump();
		} else {
			for (const v of voices.splice(0)) {
				try {
					v.stop();
				} catch {}
			}
			if (ctx) ctx.suspend().catch(() => {});
		}
	}
	function setVibrate(on) {
		vibeOn = !!on;
		save('vs.vibe', vibeOn);
	}

	pump();
	return {
		place, refused, combo, sent, event, setSound, setVibrate, SILENT,
		get soundOn() { return soundOn; },
		get vibrateOn() { return vibeOn; },
		canVibrate,
		packErrors: read.errors,
		/** For tests and the budget: render everything now. */
		renderAll() {
			for (const k of [...jobs.keys()]) render(k);
			let samples = 0;
			for (const d of data.values()) if (d) samples += d.length;
			return { clips: data.size, bytes: samples * 4, seconds: samples / RATE };
		}
	};
}
