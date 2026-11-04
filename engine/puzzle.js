// @ts-nocheck — VERBATIM parity-critical port; kept byte-faithful to the Dart
// source (spec §5). Type-checking is disabled here on purpose so the RNG-call
// order is never "tidied" to satisfy the checker. Guarded by the golden-vector
// test in puzzle.test.js instead.
// puzzle.js — deterministic Shikaku generator. Port of puzzle_codec.dart.
// VERBATIM port (see spec §5). Do not "clean up" — the exact order of RNG calls
// determines the output. Verified byte-for-byte against the Dart generator.

// —— Park–Miller LCG (a=48271, m=2³¹−1) via Schrage's method ——
export class Rng {
	static m = 2147483647; // 2³¹ − 1 (Mersenne prime)
	static a = 48271;
	static q = 44488; // floor(m / a)
	static r = 3399; // m mod a

	constructor(seed) {
		this._s = Rng._init(seed);
	}

	static _init(v) {
		// Map any integer into [1, m−1]. (v % m) can be negative in JS, so normalize.
		const s = ((v % Rng.m) + Rng.m) % Rng.m;
		return s <= 0 ? 1 : s;
	}

	_advance() {
		const hi = Math.floor(this._s / Rng.q);
		const lo = this._s % Rng.q;
		this._s = Rng.a * lo - Rng.r * hi;
		if (this._s < 0) this._s += Rng.m;
		return this._s;
	}

	nextInt(bound) {
		if (bound <= 1) return 0;
		return this._advance() % bound;
	}
	nextDouble() {
		return (this._advance() - 1) / (Rng.m - 1);
	}
}

// —— Stable string→seed hash (djb2). Matches Dart's _stableHash on VM + web. ——
// Only needed if you ever seed from an arbitrary string. The daily puzzle seeds
// from an integer (see §6), so this is optional for the landing page.
export function stableHash(s) {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (h * 33 + s.charCodeAt(i)) & 0x7fffffff; // keep low 31 bits, positive
	}
	return h === 0 ? 1 : h;
}

// —— Rectangle (normalizes corners so x1<=x2, y1<=y2) ——
export class Rect {
	constructor(ax, ay, bx, by) {
		this.x1 = Math.min(ax, bx);
		this.y1 = Math.min(ay, by);
		this.x2 = Math.max(ax, bx);
		this.y2 = Math.max(ay, by);
		this.valid = null; // null=unverified, true=valid, false=invalid
	}
	get w() {
		return this.x2 - this.x1 + 1;
	}
	get h() {
		return this.y2 - this.y1 + 1;
	}
	get area() {
		return this.w * this.h;
	}
	has(x, y) {
		return x >= this.x1 && x <= this.x2 && y >= this.y1 && y <= this.y2;
	}
	overlaps(o) {
		return this.x1 <= o.x2 && this.x2 >= o.x1 && this.y1 <= o.y2 && this.y2 >= o.y1;
	}
}

// —— Difficulty: maxAreaFrac ceilings (Classic uses only maxAreaFrac) ——
export const DIFFICULTY = { easy: 0.25, medium: 0.15, hard: 0.09, brutal: 0.05 };

// —— Core layout generator. Returns { nums, layout }. ——
// nums: N×N clue grid (0 = empty). layout: the solution rectangles.
function makeLayout(sz, maxAreaFrac, rng) {
	const total = sz * sz;
	const sizeBoost = Math.max(0, Math.min(0.2, ((sz - 10) / 6.0) * 0.2));
	const maxArea = Math.max(2, Math.trunc(total * maxAreaFrac * (1.0 + sizeBoost)));

	for (let attempt = 0; attempt < 100; attempt++) {
		const occ = Array.from({ length: sz }, () => new Array(sz).fill(false));
		let layout = [];
		let filled = 0;

		while (filled < total) {
			// Pick the (skip+1)-th unoccupied cell in row-major order as the anchor.
			let skip = rng.nextInt(total - filled);
			let ax = 0,
				ay = 0;
			outer: for (let y = 0; y < sz; y++) {
				for (let x = 0; x < sz; x++) {
					if (occ[y][x]) continue;
					if (skip-- > 0) continue;
					ax = x;
					ay = y;
					break outer;
				}
			}

			// Horizontal extent: count free cells left/right, pick the far corner.
			let sl = 0,
				sr = 0;
			for (let x = ax - 1; x >= 0 && !occ[ay][x]; x--) sl++;
			for (let x = ax + 1; x < sz && !occ[ay][x]; x++) sr++;
			const bx = ax - sl + rng.nextInt(sl + sr + 1);
			const xMin = Math.min(ax, bx),
				xMax = Math.max(ax, bx);

			// Vertical extent over the chosen column span, capped by maxArea.
			let sa = 0,
				sb = 0;
			for (let y = ay - 1; y >= 0; y--) {
				let clear = true;
				for (let x = xMin; x <= xMax && clear; x++) clear = !occ[y][x];
				if (!clear) break;
				sa++;
			}
			for (let y = ay + 1; y < sz; y++) {
				let clear = true;
				for (let x = xMin; x <= xMax && clear; x++) clear = !occ[y][x];
				if (!clear) break;
				sb++;
			}
			const maxH = Math.max(1, Math.trunc(maxArea / (xMax - xMin + 1)));
			sa = Math.min(sa, maxH);
			sb = Math.min(sb, maxH);

			const by = ay - sa + rng.nextInt(sa + sb + 1);
			const rect = new Rect(ax, ay, bx, by);

			for (let y = rect.y1; y <= rect.y2; y++)
				for (let x = rect.x1; x <= rect.x2; x++) occ[y][x] = true;
			filled += rect.area;
			layout.push(rect);
		}

		// Eliminate 1×1 rects by absorbing each into an adjacent same-line rect.
		let ok = true;
		let i = 0;
		while (i < layout.length) {
			const r = layout[i];
			if (r.w === 1 && r.h === 1) {
				let merged = false;
				for (let j = 0; j < layout.length && !merged; j++) {
					if (j === i) continue;
					const o = layout[j];
					if (o.h === 1 && o.y1 === r.y1) {
						// same row, height 1
						if (o.x1 === r.x1 + 1) {
							layout[j] = new Rect(r.x1, r.y1, o.x2, o.y2);
							merged = true;
						} else if (o.x2 === r.x1 - 1) {
							layout[j] = new Rect(o.x1, o.y1, r.x1, o.y2);
							merged = true;
						}
					}
					if (!merged && o.w === 1 && o.x1 === r.x1) {
						// same column, width 1
						if (o.y1 === r.y1 + 1) {
							layout[j] = new Rect(o.x1, r.y1, o.x2, o.y2);
							merged = true;
						} else if (o.y2 === r.y1 - 1) {
							layout[j] = new Rect(o.x1, o.y1, o.x2, r.y1);
							merged = true;
						}
					}
				}
				if (!merged) ok = false;
				layout.splice(i, 1); // remove the 1×1 regardless; if unmerged we restart
			} else {
				i++;
			}
		}
		if (!ok) continue; // unmergeable 1×1 — throw away this attempt, try again

		// Place one clue per rect at a random cell inside it.
		// IMPORTANT: nextInt(h) is consumed BEFORE nextInt(w) — preserve this order.
		const nums = Array.from({ length: sz }, () => new Array(sz).fill(0));
		for (const r of layout) {
			const ry = r.y1 + rng.nextInt(r.h);
			const rx = r.x1 + rng.nextInt(r.w);
			nums[ry][rx] = r.area;
		}
		return { nums, layout };
	}

	// Fallback (after 100 failed attempts): each row is one rect of area sz.
	const layout = [];
	const nums = Array.from({ length: sz }, () => new Array(sz).fill(0));
	for (let y = 0; y < sz; y++) {
		layout.push(new Rect(0, y, sz - 1, y));
		nums[y][Math.trunc(sz / 2)] = sz;
	}
	return { nums, layout };
}

// —— Public API: generate the clue grid for a Classic puzzle. ——
export function generateGrid(sz, maxAreaFrac, seed) {
	return makeLayout(sz, maxAreaFrac, new Rng(seed)).nums;
}

// Also expose the full layout (clues + solution rects) for callers that need it.
export function generatePuzzle(sz, maxAreaFrac, seed) {
	return makeLayout(sz, maxAreaFrac, new Rng(seed));
}
