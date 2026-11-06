// sound-worker.js — makes the game's clips on a background thread, so the board never waits on sound.
//
// The page sends the checked pack once, then the list of clips it wants, most needed first.
// One clip per task: a "front" message (a sound asked for before it was ready) can jump the
// queue between clips. Each finished clip goes back with its samples handed over, not copied.
// build.mjs stitches this file and shared/sound/synth.js into public/sound-worker.js.
import { SoundSynth } from '../shared/sound/synth.js';

const W = SoundSynth;
let pack = null;
let queue = [];
let busy = false;
const mixes = {};

function step() {
	if (busy || !queue.length || !pack) return;
	busy = true;
	setTimeout(() => {
		busy = false;
		const j = queue.shift();
		if (j) {
			const r = W.renderJob(pack.sounds, pack.models, j, mixes);
			const buf = r.data ? r.data.buffer : null;
			postMessage({ t: 'clip', key: j.key, rate: r.rate, data: buf }, buf ? [buf] : []);
		}
		step();
	}, 0);
}

onmessage = (e) => {
	const m = e.data || {};
	if (m.t === 'pack') pack = m.pack;
	else if (m.t === 'queue') queue = (m.jobs || []).slice();
	else if (m.t === 'front') {
		const i = queue.findIndex((j) => j.key === m.key);
		if (i > 0) queue.unshift(queue.splice(i, 1)[0]);
	}
	step();
};
