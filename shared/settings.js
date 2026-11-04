// settings.js — the room settings a host can change before a match, shared by the
// client (to draw the menu) and the server (to accept only these keys, in range).
// The rules themselves live in ../engine/versus.js (VERSUS_RULES); this is
// only the list of knobs a room may turn, and the presets.
import { VERSUS_RULES, MINES_RULES } from '../engine/versus.js';

/** Every setting a room may change. Anything not listed here is fixed at VERSUS_RULES. */
export const SETTINGS = [
	// Match
	{ k: 'mode', group: 'Mode', label: 'Mode', type: 'enum', options: [['vs', 'Shikaku+ VS'], ['mines', 'Shikaku+ Mines (no ice, unrated)']], def: 'vs' },
	{ k: 'firstTo', group: 'Match', label: 'First to', type: 'enum', options: [[1, '1'], [3, '3'], [5, '5'], [7, '7']], def: 7 },
	{ k: 'hearts', group: 'Match', label: 'Hearts', type: 'int', min: 1, max: 5 },
	{ k: 'gravitySecs', group: 'Match', label: 'Gravity: a tick every', type: 'num', min: 0, max: 10, step: 0.5, unit: 's', off: 0 },
	{ k: 'rushAfterSecs', group: 'Match', label: 'Rush after', type: 'int', min: 0, max: 600, step: 30, unit: 's', off: 0 },
	{ k: 'rushMultiplier', group: 'Match', label: 'Rush multiplier', type: 'int', min: 2, max: 10 },
	{ k: 'clearGrace', group: 'Match', label: 'Grace moves after a clear', type: 'int', min: 0, max: 2 },
	// Mines
	{ k: 'clearSend', group: 'Mines', label: 'A clear sends', type: 'int', min: 1, max: 8 },
	{ k: 'counterRate', group: 'Mines', label: 'Counter-spike sends back', type: 'enum', options: [[0, 'Nothing (cancel only)'], [0.5, 'Half'], [1, 'Everything']] },
	{ k: 'cancelOrder', group: 'Mines', label: 'Clears cancel', type: 'enum', options: [['redFirst', 'Red batch first'], ['orangeFirst', 'Orange bank first']] },
	{ k: 'batchSize', group: 'Mines', label: 'Most landing per move', type: 'int', min: 2, max: 8 },
	{ k: 'mineFuse', group: 'Mines', label: 'Fuse (moves)', type: 'int', min: 2, max: 5 },
	{ k: 'mineCluster', group: 'Mines', label: 'Mines land clustered', type: 'bool' },
	{ k: 'defuseClearBonus', group: 'Mines', label: 'Defuse clear bonus per mine', type: 'int', min: 0, max: 3 },
	{ k: 'clutchCancels', group: 'Mines', label: 'Clutch cancels', type: 'int', min: 0, max: 3 },
	// Ice and frost
	{ k: 'freezeOverAt', group: 'Ice', label: 'Freeze-over at', type: 'int', min: 3, max: 6, unit: ' ice' },
	{ k: 'freezeOver', group: 'Ice', label: 'Freezing over', type: 'enum', options: [['loseBoard', 'Loses the board'], ['ko', 'Is a KO (old)']] },
	{ k: 'frostMeter', group: 'Ice', label: 'Frost per ice', type: 'int', min: 0, max: 8, off: 0 },
	{ k: 'frostHoldAtBoxesLeft', group: 'Ice', label: 'Frost holds on last N boxes', type: 'int', min: 0, max: 6 },
	{ k: 'defuseTiers', group: 'Ice', label: 'Only fresh defuses charge frost', type: 'bool' },
	{ k: 'icebreakReward', group: 'Ice', label: 'Endgame icebreak frost', type: 'int', min: 0, max: 4 },
	{ k: 'bankFreezeEvery', group: 'Ice', label: 'Sitting bank freezes every', type: 'int', min: 0, max: 12, unit: ' moves', off: 0 },
	// Healing
	{ k: 'healPerfectBoards', group: 'Hearts', label: 'Heal after perfect boards', type: 'int', min: 0, max: 6, off: 0 },
	{ k: 'healCheckpoint', group: 'Hearts', label: 'Heal checkpoint', type: 'int', min: 0, max: 4, off: 0 },
	{ k: 'maxHealsPerRound', group: 'Hearts', label: 'Heals per round', type: 'int', min: 0, max: 3 }
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.k, s]));
export const defaultOf = (k) => (k in VERSUS_RULES ? VERSUS_RULES[k] : BY_KEY.get(k)?.def);

/** Named starting points. Default is VERSUS_RULES untouched. */
export const PRESETS = [
	{ id: 'default', label: 'Default', set: {} },
	{ id: 'mines', label: 'Mines', set: { mode: 'mines' } },
	{ id: 'spiky', label: 'Spiky', set: { counterRate: 1, cancelOrder: 'orangeFirst' } },
	{ id: 'calm', label: 'No gravity', set: { gravitySecs: 0 } },
	{ id: 'short', label: 'Quick (first to 3)', set: { firstTo: 3, rushAfterSecs: 120 } }
];

/** Keep only known keys, of the right type, in range. Returns a fresh object. */
export function sanitize(input) {
	const out = {};
	if (!input || typeof input !== 'object') return out;
	for (const [k, v] of Object.entries(input)) {
		const s = BY_KEY.get(k);
		if (!s) continue;
		if (s.type === 'bool') {
			if (typeof v === 'boolean') out[k] = v;
		} else if (s.type === 'enum') {
			const hit = s.options.find(([ov]) => ov === v);
			if (hit) out[k] = hit[0];
		} else if (typeof v === 'number' && Number.isFinite(v)) {
			let n = Math.min(s.max, Math.max(s.min, v));
			if (s.type === 'int') n = Math.round(n);
			else if (s.step) n = Math.round(n / s.step) * s.step;
			out[k] = n;
		}
	}
	return out;
}

/** The rules a match runs with: the mode's rules plus the room's sanitized overrides (firstTo is not a rule). */
export function rulesFor(overrides) {
	const { firstTo, mode, ...rest } = sanitize(overrides);
	const base = mode === 'mines' ? MINES_RULES : VERSUS_RULES;
	return { rules: { ...base, ...rest }, firstTo: firstTo ?? 7 };
}
