// game.js — game rules + interaction logic (spec §4 / §9 / §2.1).
import { Rect } from './puzzle.js';

// —— Block palette (theme-independent — never changes). spec §2.1 ——
export const RECT_PALETTE = [
	'#D08080', // 0 rose
	'#80B8B0', // 1 teal
	'#A090C0', // 2 lavender
	'#8098B0', // 3 slate blue
	'#88B098', // 4 sage
	'#D0B878', // 5 amber
	'#B888A8', // 6 mauve
	'#C5956B' // 7 sienna
];

// Deterministic color from a rect's coordinates (stable across save/reload).
/** @param {{ x1: number, y1: number, x2: number, y2: number }} r */
export function rectColor(r) {
	const i = (r.x1 * 31 + r.y1 * 17 + r.x2 * 7 + r.y2) % RECT_PALETTE.length;
	return RECT_PALETTE[i];
}

// —— Validity of a single placed rectangle (spec §4) ——
// nums: N×N grid of clue numbers (0 = empty). r: the rectangle being checked.
// Valid iff it contains exactly one clue AND that clue == area.
/** @param {Rect} r @param {number[][]} nums */
export function verifyRect(r, nums) {
	let found = 0;
	for (let y = r.y1; y <= r.y2; y++) {
		for (let x = r.x1; x <= r.x2; x++) {
			const n = nums[y][x];
			if (n !== 0) {
				if (found !== 0 || r.area !== n) return false; // 2nd clue, or area mismatch
				found = n;
			}
		}
	}
	return found !== 0; // must contain at least one clue
}

// —— Solved check (Classic). spec §4 ——
/** @param {Rect[]} rects @param {number} N */
export function isSolved(rects, N) {
	if (rects.some((r) => r.valid !== true)) return false;
	const cov = Array.from({ length: N }, () => new Array(N).fill(false));
	for (const r of rects)
		for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) cov[y][x] = true;
	return cov.every((row) => row.every(Boolean));
}

// —— Clue number color logic (spec §8.3) ——
// Returns true if the cell sits under a valid placed block (use --num-on-block).
/** @param {number} x @param {number} y @param {Rect[]} rects */
export function cellUnderBlock(x, y, rects) {
	return rects.some((r) => r.valid === true && r.has(x, y));
}

// —— Commit a drag/tap (spec §9.1) ——
// Mutates `rects` in place. Returns a result describing what happened.
/**
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 * @param {{ nums: number[][], rects: Rect[], N: number }} state
 */
export function commit(ax, ay, bx, by, state) {
	const { nums, rects, N } = state;
	if (ax === bx && ay === by) {
		// tap → erase
		const i = rects.findIndex((r) => r.has(ax, ay));
		if (i >= 0) rects.splice(i, 1);
		return { changed: i >= 0, placed: null };
	}
	const nr = new Rect(ax, ay, bx, by);
	if (!verifyRect(nr, nums)) return { changed: false, placed: null, denied: true };
	for (let i = rects.length - 1; i >= 0; i--) if (rects[i].overlaps(nr)) rects.splice(i, 1);
	nr.valid = true;
	rects.push(nr);
	return { changed: true, placed: nr, solved: isSolved(rects, N) };
}
