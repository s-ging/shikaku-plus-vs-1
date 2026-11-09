// sound.js — plays the sound pack. Build once, replay forever (game/sound.md in the wiki).
//
//   Levels     Full (everything), Minimal (gameplay responses only: no Place, no per-turn
//              sounds, no flair) or Off (no audio at all). Phones that report little memory or
//              few cores start on Minimal (Krischan, 2026-11-07). A level only makes its own clips.
//   Rendering  every clip is rendered once by shared/sound/synth.js (renderJob) on a background
//              thread (client/sound-worker.js), most needed first, stored at the rate its high
//              cut needs (12, 16 or 24kHz). Without workers, one clip per idle moment instead,
//              hurried during the 3-2-1. Nothing is synthesized during play.
//   Variety    one clip per sound; the pack's pitch wobble varies each play for free.
//   Playing    one AudioBufferSource per sound, pitch by playback speed, one master gain.
//   Theirs     the opponent's big moments play too, at 45% and without vibrating (event(e, true)).
//              At most 8 at once; the same clip won't restart within 30ms.
//   Not ready  a clip that isn't rendered yet is skipped and moved to the front of the
//              queue, never rendered on the spot: a long one (SENT 10) could take a second
//              on an old phone, and sound must never stall the game.
//   Memory     each clip lives once: its samples until first played, then only the browser's copy.
//   Resting    between rounds and on other screens the audio is suspended once the last sound
//              ends, so a quiet game costs nothing; the 3-2-1 wakes it before play begins.
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
	const MAX_VOICES = 8;
	// One clip per sound: the pack's pitch wobble already varies every play for free (Krischan, 2026-11-06).
	// Minimal keeps what answers the player or the opponent; it drops Place, the per-turn sounds
	// (Ice on the board, Mine tick, Mine Bank and Queue), Streak and Do-Over (Krischan, 2026-11-06),
	// and the flourishes Crowd and Thunder (Krischan, 2026-11-07). Ice stays: it is gameplay.
	const MINIMAL = new Set(['refused', 'clear', 'combo', 'sent', 'counter', 'boom', 'mineLand', 'defuse', 'clutch', 'iceLand', 'iceBreak', 'frost',
		'frostFire', 'deflect', 'freezeOver', 'force', 'bell', 'comboBreak', 'extraLife', 'countdown', 'start', 'rush', 'win', 'lose', 'matchWin']);
	const LEVELS = ['full', 'minimal', 'off'];

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
	const lowEnd = () => {
		try {
			return (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
		} catch {
			return false;
		}
	};
	let level = (() => {
		try {
			const v = localStorage.getItem('vs.soundLevel');
			if (LEVELS.includes(v)) return v;
			if (localStorage.getItem('vs.sound') === 'off') return 'off'; // the old on/off switch
		} catch {}
		return typeof navigator !== 'undefined' && lowEnd() ? 'minimal' : 'full';
	})();
	let soundOn = level !== 'off';
	let vibeOn = pref('vs.vibe', true);
	const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

	// —— Clips: key → job to render; key → Float32Array once rendered, then the browser's buffer ——
	const jobs = new Map();
	const data = new Map();
	const buffers = new Map();
	const rates = new Map();
	const mixes = {}; // the combo's notes share one mix (synth.js renderJob)
	let queue = [];
	// Seeds stay fixed per sound so a clip is the same on every device.
	const SEEDS = { place: 11, refused: 21, clear: 31, combo: 41, boom: 51, sent: 61, iceLand: 71, iceBoard: 72, iceBreak: 73, thunder: 81, force: 82 };
	const seedOf = (slot) => SEEDS[slot] || 100 + SoundPack.SLOTS.indexOf(slot);
	const wants = (slot) => level === 'full' || (level === 'minimal' && MINIMAL.has(slot));
	function job(key, slot, opt = {}, size = 1, mix = false) {
		const base = sounds[slot];
		const snd = base && size > 1 ? (base.sizes || {})[size] : base;
		if (snd && snd.layers.length && wants(slot)) jobs.set(key, { key, slot, size, opt, mix, seed: seedOf(slot) });
	}
	// The clips this level needs, most needed first: what a round plays most, then the rest.
	function planJobs() {
		jobs.clear();
		if (sounds.place) for (let g = 0; g < 4; g++) job(`place:${g}`, 'place', S.placeOpt(sounds.place, g));
		job('refused', 'refused');
		job('clear', 'clear');
		if (sounds.combo) {
			const on = sounds.combo.seq && sounds.combo.seq.on;
			for (const tr of on ? new Set(S.steps(sounds.combo.ladder)) : [0]) job(`combo:${tr}`, 'combo', { transpose: tr }, 1, true);
		}
		if (sounds.sent) {
			job('sent:1', 'sent');
			for (const k of Object.keys(sounds.sent.sizes || {})) job(`sent:${k}`, 'sent', {}, +k);
		}
		for (const slot of SoundPack.SLOTS) if (!['place', 'combo', 'sent'].includes(slot)) job(slot, slot);
		// Free what this level doesn't play (Full to Minimal gives the memory back).
		for (const k of [...data.keys()]) if (!jobs.has(k)) data.delete(k);
		for (const k of [...buffers.keys()]) if (!jobs.has(k)) buffers.delete(k);
		queue = [...jobs.keys()].filter((k) => !data.has(k) && !buffers.has(k));
		feed();
	}

	function store(key, rate, d) {
		const i = queue.indexOf(key);
		if (i >= 0) queue.splice(i, 1);
		if (!jobs.has(key) || data.has(key) || buffers.has(key)) return; // no longer wanted, or already here
		rates.set(key, rate);
		data.set(key, d); // null: a filter blew up; that clip is skipped, the game carries on
	}
	function render(key) {
		const j = jobs.get(key);
		if (!j || data.has(key) || buffers.has(key)) return;
		const r = S.renderJob(sounds, pack.models, j, mixes);
		store(key, r.rate, r.data);
	}

	// —— Background thread: renders the queue so the board never waits on sound ——
	let worker = null;
	if (typeof Worker !== 'undefined' && typeof SOUND_WORKER_URL !== 'undefined') {
		try {
			worker = new Worker(SOUND_WORKER_URL);
			worker.onmessage = (e) => {
				const m = e.data || {};
				if (m.t === 'clip') store(m.key, m.rate, m.data ? new Float32Array(m.data) : null);
			};
			worker.onerror = () => {
				// No worker after all (blocked, failed to load): render on the page, in idle moments.
				worker = null;
				pump();
			};
			worker.postMessage({ t: 'pack', pack: { sounds, models: pack.models } });
		} catch {
			worker = null;
		}
	}
	function feed() {
		if (!soundOn || !queue.length) return;
		if (worker) worker.postMessage({ t: 'queue', jobs: queue.map((k) => jobs.get(k)) });
		else pump();
	}
	function front(key) {
		const i = queue.indexOf(key);
		if (i > 0) queue.splice(0, 0, ...queue.splice(i, 1));
		if (worker) worker.postMessage({ t: 'front', key });
		else pump();
	}

	let idleBusy = false;
	let hurry = false; // the 3-2-1 is on: finish the queue now, one clip per task so the digits keep ticking
	const idle = typeof requestIdleCallback === 'function' ? (f) => requestIdleCallback(f, { timeout: 500 }) : (f) => setTimeout(f, 30);
	function pump() {
		if (worker || idleBusy || !soundOn || !queue.length) return;
		idleBusy = true;
		(hurry ? (f) => setTimeout(f, 0) : idle)(() => {
			idleBusy = false;
			if (worker || !soundOn || !queue.length) return;
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
		if (!soundOn || typeof window === 'undefined') return null;
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
		const rate = rates.get(key);
		try {
			b = ctx.createBuffer(1, d.length, rate);
			b.getChannelData(0).set(d);
		} catch {
			// Old Safari only takes 22.05kHz and up: stretch the clip to 24kHz for it.
			const u = S.resample(d, rate / 24000);
			b = ctx.createBuffer(1, u.length, 24000);
			b.getChannelData(0).set(u);
		}
		buffers.set(key, b);
		data.delete(key); // the browser's copy is the only one now (half the memory)
		return b;
	}

	function buzz(sound) {
		if (!vibeOn || !canVibrate || !sound || !sound.haptic) return;
		try {
			const pat = S.steps(sound.haptic).map((v) => Math.max(0, Math.round(v)));
			if (pat.length) navigator.vibrate(pat);
		} catch {}
	}

	let scale = 1; // the opponent's sounds play through the same path, quieter
	function play(key, sound, rate, delay = 0, depth = 0, link = null) {
		if (!soundOn || !jobs.has(key)) {
			// A sound this level doesn't make can still bring its links (Counter-spike is all links).
			if (soundOn && sound && sound.also && depth < 2 && (level === 'full' || MINIMAL.has(key.split(':')[0]))) for (const a of sound.also) if (sounds[a.slot]) play(a.slot, sounds[a.slot], 1, delay + a.delay / 1000, depth + 1, a);
			return;
		}
		if (!delay && scale === 1) buzz(sound); // only your own moments vibrate
		// also: play those sounds too, each its own clip with its own level and duration, at most two levels deep (as the lab).
		if (sound && sound.also && depth < 2) for (const a of sound.also) if (sounds[a.slot]) play(a.slot, sounds[a.slot], 1, delay + a.delay / 1000, depth + 1, a);
		if (!data.has(key) && !buffers.has(key)) {
			front(key); // not ready: skip it this once and render it next
			return;
		}
		if (typeof document !== 'undefined' && document.hidden) return;
		const c = audio();
		if (!c || c.state === 'closed') return; // still resuming from the first tap: it starts the moment audio does
		const now = c.currentTime;
		if (now + delay - (lastStart.get(key) || -1) < 0.03) return;
		lastStart.set(key, now + delay);
		resting = false; // a sound outside a round (practice, the lobby) keeps the audio awake until told to rest
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
		// A link's level and duration (cut with a short fade so it doesn't click).
		const lv = (link && link.gain != null ? link.gain : 1) * scale,
			ln = link && link.len > 0 ? link.len / 1000 : 0;
		if (lv !== 1 || ln) {
			const g = c.createGain(),
				t0 = delay ? now + delay : now;
			g.gain.setValueAtTime(lv, t0);
			if (ln) {
				const f = Math.min(0.05, ln / 4);
				g.gain.setValueAtTime(lv, t0 + ln - f);
				g.gain.linearRampToValueAtTime(0, t0 + ln);
				try {
					src.stop(t0 + ln + 0.01);
				} catch {}
			}
			g.connect(out);
			src.connect(g);
		} else src.connect(out);
		src.onended = () => {
			const i = voices.indexOf(src);
			if (i >= 0) voices.splice(i, 1);
			if (resting && !voices.length) sleep();
		};
		voices.push(src);
		src.start(delay ? now + delay : 0);
	}

	// —— What the game calls ——
	function place(size) {
		const s = sounds.place;
		if (!s) return;
		play(`place:${S.placeGroup(size)}`, s, S.placeRate(s, size));
	}
	function refused() {
		if (sounds.refused) play('refused', sounds.refused, 1);
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
	const one = (k) => sounds[k] && play(k, sounds[k], 1);
	// The opponent's big moments, TETR.IO-style (Krischan, 2026-11-07): quieter, no vibration.
	// Not their Tile placing, ticks or hovers: those would drown out your own board.
	const THEIRS = new Set(['clear', 'send', 'mineExplode', 'defuse', 'clutch', 'mineLand', 'frozenOut', 'frostFire']);
	const THEM_GAIN = 0.45;
	/** One engine event (see client/ui.js animate). them: it happened on the other player's board. */
	function event(e, them = false) {
		if (!them) return ownEvent(e);
		if (!THEIRS.has(e.kind)) return;
		scale = THEM_GAIN;
		try {
			ownEvent(e);
		} finally {
			scale = 1;
		}
	}
	function ownEvent(e) {
		const k = e.kind;
		if (k === 'clear') {
			one('clear');
			if (e.combo) combo(e.combo);
		} else if (k === 'mineExplode') one('boom');
		else if (k === 'comboBreak') one('comboBreak'); // your chain ended (an explosion or a Freeze Over)
		else if (k === 'heal') {
			if (e.healed) one('extraLife'); // a Stock came back
		} else if (k === 'send') {
			if (e.counter && sounds.counter) one('counter'); // your attack cancelled theirs
			else if (e.pass > 0) sent(e.pass);
		} else if (k === 'frozen') one('iceLand'); // a Frozen Cell lands (its pack plays Ice on the board with it)
		else if (k === 'thaw') one('iceBreak'); // a Frozen Cell breaks
		else if (k === 'thawPulse') one('iceBoard'); // the ice reacts as it thaws, every turn it's there
		else if (k === 'forceBreak') one('force'); // Icebreak: the board forces a Frozen Cell open
		else if (k === 'frozenOut') one('freezeOver'); // the board froze over
		else if (k === 'shield') one('deflect'); // the Frost shield borrows the deflect sound for now
		else if (k === 'frostFire') {
			one('frostFire');
			if (e.deflected > 0) one('deflect'); // your frost knocked incoming ice away
		} else if (k === 'iceIncoming') one('frost'); // ice is on its way to you
		else if (k === 'mineLand') one('mineLand');
		else if (k === 'defuse') {
			if (!e.clutch) one('defuse'); // a clutch defuse plays Clutch (which plays Defuse with it)
		} else if (k === 'clutch') one('clutch');
		else if (k === 'minesIncoming') one('queue');
		else if (k === 'bankFreeze') one('bank');
		else if (k === 'gravity') one('mineTick');
	}
	/** Moments the screen knows about, not the engine: 3-2-1, start, rush, round and match ends. */
	function cue(name) {
		one(name);
	}
	function doOver() {
		one('doOver');
	}
	function streak() {
		one('streak');
	}

	function setLevel(l) {
		if (!LEVELS.includes(l)) return;
		level = l;
		soundOn = level !== 'off';
		try {
			localStorage.setItem('vs.soundLevel', level);
		} catch {}
		planJobs();
		if (soundOn) {
			audio();
			feed();
		} else {
			for (const v of voices.splice(0)) {
				try {
					v.stop();
				} catch {}
			}
			if (ctx) ctx.suspend().catch(() => {});
		}
	}
	const setSound = (on) => setLevel(on ? (level === 'off' ? 'full' : level) : 'off');
	function setVibrate(on) {
		vibeOn = !!on;
		save('vs.vibe', vibeOn);
	}

	// —— Resting: suspend the audio while nothing can play (between rounds, other screens) ——
	let resting = false;
	function sleep() {
		if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
	}
	/** Round over or off the game screen: let the last sound finish, then suspend. */
	function rest() {
		resting = true;
		if (!voices.length) sleep();
	}

	/** The 3-2-1 has started: wake the audio and render whatever is left now, before play begins. */
	function prepare() {
		if (resting) {
			resting = false;
			if (ctx && soundOn && !(typeof document !== 'undefined' && document.hidden)) ctx.resume().catch(() => {});
		}
		if (worker || hurry || !queue.length) return;
		hurry = true;
		idleBusy = false; // a pending idle callback just finds the queue shorter
		pump();
	}

	planJobs();
	return {
		prepare,
		rest,
		place, refused, combo, sent, event, cue, doOver, streak, setLevel, setSound, setVibrate, LEVELS, MINIMAL,
		get level() { return level; },
		get soundOn() { return soundOn; },
		get vibrateOn() { return vibeOn; },
		canVibrate,
		packErrors: read.errors,
		/** For tests and the budget: render everything now. */
		renderAll() {
			for (const k of [...jobs.keys()]) render(k);
			queue = [];
			let bytes = 0,
				seconds = 0;
			for (const [k, d] of data) if (d) (bytes += d.length * 4), (seconds += d.length / rates.get(k));
			for (const [k, b] of buffers) (bytes += b.length * 4), (seconds += b.length / b.sampleRate);
			return { clips: data.size + buffers.size, bytes, seconds };
		}
	};
}
