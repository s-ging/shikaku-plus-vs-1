// hud.js — the Shikaku+ VS screen: board canvases, the callout lane, combo, poles, hearts, shots
// and the play / spectator views. One copy, used by the lab (lab/app.js) and the playtest
// (client/ui.js), so what Krischan tunes in the lab is exactly what players see.
//
// Cost notes (PRINCIPLES.md, "Optimization is the craft"):
//   canvas  draws only when something changed or is animating (flash, ghost, last-tick mine); idle = 0 frames
//   DOM     poles, hearts and combo update on render() only; callouts are one element per moment
//   effects transform and opacity only
//
// opts:
//   side(i)      the side drawn on screen i (0 = the big board, 1 = the other), or null before a match
//   rules()      the rules object in use
//   onMove(a)    called with { type: 'place', ax, ay, bx, by } or { type: 'erase', x, y } from board 0
//   canInput()   whether board 0 takes input right now
//   onHover(r)   optional: my drag as { x1, y1, x2, y2 }, or null when it ends
import { Rect } from '../engine/puzzle.js';
import { verifyRect, cellUnderBlock } from '../engine/game.js';

export function createHud(opts) {
	const rulesNow = opts.rules; // not "R": drawMine has a local R (the mine radius)
	const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const $ = (id) => document.getElementById(id);
	const PREFIX = ['you', 'them'];

	let C = {};
	function readColors() {
		const cs = getComputedStyle(document.documentElement);
		for (const v of ['cell', 'hatch', 'fg', 'mine', 'ice', 'ink', 'num-on-block', 'drag-fill', 'drag-stroke', 'invalid-fill', 'card'])
			C[v] = cs.getPropertyValue('--' + v).trim();
	}
	// Lavender from the box palette. game.js's rectColor stays untouched (copied from the landing repo).
	const VS_BOX = '#A090C0';
	const FONT = () => getComputedStyle(document.body).fontFamily;

	// —— Drawing on demand ——
	let raf = 0;
	function kick() {
		if (!raf) raf = requestAnimationFrame(frame);
	}
	function frame(now) {
		raf = 0;
		let more = false;
		for (const v of views) more = v.draw(now) || more;
		if (more) kick();
	}

	class BoardView {
		constructor(canvas, idx, interactive) {
			this.canvas = canvas;
			this.idx = idx;
			this.ctx = canvas.getContext('2d');
			this.flashes = [];
			this.drag = null;
			this.ghost = null;
			new ResizeObserver(() => this.resize()).observe(canvas);
			if (interactive) this.bind();
		}
		get side() {
			return opts.side(this.idx);
		}
		resize() {
			this.S = Math.max(80, Math.floor(this.canvas.clientWidth));
			this.dpr = Math.max(1, window.devicePixelRatio || 1);
			this.canvas.width = Math.round(this.S * this.dpr);
			this.canvas.height = Math.round(this.S * this.dpr);
			// Poles sit one cell-gap away from the cells, snap to the cell rows and share their corner radius.
			const frame = this.canvas.parentElement;
			// The gap comes from the frame's width, not the canvas's: the gap resizes the canvas,
			// so basing it on the canvas made the mini board flip between two widths forever.
			const W = frame.clientWidth;
			this._gap = W < 260 ? Math.max(2, Math.round(W / 60)) : Math.max(4, Math.round(W / 85));
			const f = frame.style;
			f.setProperty('--fgap', `${this.gap / 2}px`);
			f.setProperty('--pinset', `${this.gap / 2}px`);
			f.setProperty('--cgap', `${this.gap}px`);
			f.setProperty('--k', `${this.k}px`);
			kick();
		}
		get N() {
			const s = this.side;
			return s ? s.N : 6; // before a match there's no side yet; boards are 6×6
		}
		get k() {
			return this.S / this.N;
		}
		get gap() {
			return this._gap || 4;
		}
		cellAt(e) {
			const b = this.canvas.getBoundingClientRect();
			const cl = (v) => Math.min(this.N - 1, Math.max(0, v));
			return [cl(Math.floor(((e.clientX - b.left) / b.width) * this.N)), cl(Math.floor(((e.clientY - b.top) / b.height) * this.N))];
		}
		bind() {
			const c = this.canvas;
			c.addEventListener('pointerdown', (e) => {
				if (!opts.canInput()) return;
				try {
					c.setPointerCapture(e.pointerId);
				} catch {}
				const [x, y] = this.cellAt(e);
				this.drag = { ax: x, ay: y, bx: x, by: y };
				hover(this.drag);
				kick();
			});
			c.addEventListener('pointermove', (e) => {
				if (!this.drag) return;
				const [x, y] = this.cellAt(e);
				if (x === this.drag.bx && y === this.drag.by) return;
				this.drag.bx = x;
				this.drag.by = y;
				hover(this.drag);
				kick();
			});
			c.addEventListener('pointerup', () => {
				const d = this.drag;
				this.drag = null;
				hover(null);
				kick();
				if (!d) return;
				if (d.ax === d.bx && d.ay === d.by) opts.onMove({ type: 'erase', x: d.ax, y: d.ay });
				else opts.onMove({ type: 'place', ...d });
			});
			c.addEventListener('pointercancel', () => {
				this.drag = null;
				hover(null);
				kick();
			});
		}
		span(r) {
			const g = this.gap / 2;
			const k = this.k;
			return [r.x1 * k + g, r.y1 * k + g, (r.x2 - r.x1 + 1) * k - this.gap, (r.y2 - r.y1 + 1) * k - this.gap];
		}
		rr(x, y, w, h, r) {
			const c = this.ctx;
			const q = Math.min(r ?? Math.max(this.S < 240 ? 2 : 4, this.k * 0.08), w / 2, h / 2);
			c.beginPath();
			c.moveTo(x + q, y);
			c.arcTo(x + w, y, x + w, y + h, q);
			c.arcTo(x + w, y + h, x, y + h, q);
			c.arcTo(x, y + h, x, y, q);
			c.arcTo(x, y, x + w, y, q);
			c.closePath();
		}
		cellBox(i) {
			const x = i % this.N;
			const y = Math.floor(i / this.N);
			return this.span({ x1: x, y1: y, x2: x, y2: y });
		}
		stripes(px, py, pw, ph, color, step) {
			const c = this.ctx;
			c.save();
			this.rr(px, py, pw, ph);
			c.clip();
			c.strokeStyle = color;
			c.lineWidth = step * 0.45;
			for (let t = -ph; t < pw + ph; t += step) {
				c.beginPath();
				c.moveTo(px + t, py + ph);
				c.lineTo(px + t + ph, py);
				c.stroke();
			}
			c.restore();
		}
		flash(kind, cell, intensity = 1) {
			const now = performance.now();
			const f = { kind, cell, start: now, dur: kind === 'shatter' ? 520 : kind === 'freeze' ? 700 : 380 };
			if (kind === 'shatter') {
				f.shards = [];
				const n = Math.round(10 * intensity) + 3;
				for (let i = 0; i < n; i++)
					f.shards.push({ a: (i / n) * 6.283 + Math.random() * 0.6, v: 0.6 + Math.random() * 1.3 * intensity, s: 0.05 + Math.random() * 0.07, rot: Math.random() * 6 });
			}
			this.flashes.push(f);
			kick();
		}

		drawMine(m, now) {
			const c = this.ctx;
			const [px, py, pw, ph] = this.cellBox(m.cell);
			const cx = px + pw / 2;
			const cy = py + ph / 2;
			const pulse = m.fuse <= 1 && !REDUCED ? 0.75 + 0.25 * Math.abs(Math.sin(now / 160)) : 1;
			c.globalAlpha = pulse;
			c.fillStyle = C.mine;
			this.rr(px, py, pw, ph);
			c.fill();
			c.globalAlpha = 1;
			const R = pw * 0.32;
			c.strokeStyle = C.ink;
			c.lineWidth = Math.max(2, pw * 0.065);
			c.beginPath();
			c.arc(cx, cy, R, 0, 6.283);
			c.stroke();
			c.fillStyle = C.ink;
			const total = rulesNow().mineFuse;
			if (m.fuse <= 1) {
				c.beginPath();
				c.arc(cx, cy, R * 0.68, 0, 6.283);
				c.fill();
			} else {
				const p = (total - m.fuse + 1) / total; // fuse 3 → 1/3, fuse 2 → 2/3
				c.beginPath();
				c.moveTo(cx, cy);
				c.arc(cx, cy, R * 0.72, -Math.PI / 2, -Math.PI / 2 + p * 6.283);
				c.closePath();
				c.fill();
			}
		}

		drawIce(f) {
			const c = this.ctx;
			const [px, py, pw, ph] = this.cellBox(f.cell);
			c.fillStyle = C.ice;
			this.rr(px, py, pw, ph);
			c.fill();
			this.stripes(px, py, pw, ph, C.ink, Math.max(5, pw / 7));
			const inset = pw * 0.17;
			const ix = px + inset;
			const iy = py + inset;
			const iw = pw - inset * 2;
			c.fillStyle = C.ink;
			this.rr(ix - 2, iy - 2, iw + 4, iw + 4, 3);
			c.fill();
			c.fillStyle = C.ice;
			this.rr(ix, iy, iw, iw, 3);
			c.fill();
			// Thaw wedge: solid at full thaw, hollow at the last point.
			const total = rulesNow().thawPoints;
			const p = Math.max(0, Math.min(1, (total - f.thaw) / Math.max(1, total - 1)));
			if (p > 0) {
				const b = iw * 0.16;
				c.save();
				c.beginPath();
				c.rect(ix + b, iy + b, iw - 2 * b, iw - 2 * b);
				c.clip();
				c.fillStyle = C.ink;
				const cx = ix + iw / 2;
				const cy = iy + iw / 2;
				c.beginPath();
				c.moveTo(cx, cy);
				c.arc(cx, cy, iw, -Math.PI / 2, -Math.PI / 2 - p * 6.283, true);
				c.closePath();
				c.fill();
				c.restore();
			}
		}

		/** Draws the board; returns true while something on it is still animating. */
		draw(now) {
			if (!this.S || !opts.side(this.idx)) return false;
			const c = this.ctx;
			const side = this.side;
			const N = this.N;
			const k = this.k;
			const nums = side.puzzle.nums;
			const e = side.econ;
			c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
			c.clearRect(0, 0, this.S, this.S);

			c.fillStyle = C.cell;
			for (let i = 0; i < N * N; i++) {
				this.rr(...this.cellBox(i));
				c.fill();
			}
			// The Board gets colder with every Frozen Cell on it, so a Freeze Over is seen coming.
			const chill = [0, 0.07, 0.14, 0.24][Math.min(3, e.ice.length)];
			if (chill) {
				c.globalAlpha = chill;
				c.fillStyle = C.ice;
				for (let i = 0; i < N * N; i++) {
					this.rr(...this.cellBox(i));
					c.fill();
				}
				c.globalAlpha = 1;
			}
			// Telegraphed ice targets (off by default: the left pole shows ice coming instead)
			for (const w of e.iceIncoming) {
				if (w.target < 0) continue;
				const [px, py, pw, ph] = this.cellBox(w.target);
				c.fillStyle = C.hatch;
				this.rr(px, py, pw, ph);
				c.fill();
				this.stripes(px, py, pw, ph, C.cell, Math.max(6, pw / 6));
			}
			c.fillStyle = VS_BOX; // one colour for every box in VS (Krischan, 2026-10-30): hazards are the only colours on the board
			for (const r of side.rects) {
				this.rr(...this.span(r));
				c.fill();
			}
			for (const f of e.ice) this.drawIce(f);
			for (const m of e.mines) this.drawMine(m, now);

			// Clues. The mini board leaves them out: you read its pressure, not its puzzle.
			if (!this.canvas.closest('.seat').classList.contains('mini')) {
			c.font = `${Math.max(this.S < 240 ? 6 : 12, k * 0.42)}px ${FONT()}`;
			c.textAlign = 'center';
			c.textBaseline = 'middle';
			for (let y = 0; y < N; y++)
				for (let x = 0; x < N; x++) {
					const v = nums[y][x];
					if (!v) continue;
					c.fillStyle = cellUnderBlock(x, y, side.rects) ? C['num-on-block'] : C.fg;
					c.fillText(String(v), x * k + k / 2, y * k + k / 2 + 1);
				}
			}

			// The other player's drag, live or replayed: a faint Tile where they're about to place.
			if (this.hover) {
				c.globalAlpha = 0.32;
				c.fillStyle = VS_BOX;
				this.rr(...this.span(this.hover));
				c.fill();
				c.globalAlpha = 0.85;
				c.strokeStyle = VS_BOX;
				c.lineWidth = 1.5;
				c.stroke();
				c.globalAlpha = 1;
			}
			if (this.drag) {
				const d = this.drag;
				const r = new Rect(d.ax, d.ay, d.bx, d.by);
				const blocked = side.isRectBlocked(r);
				const ok = !blocked && verifyRect(r, nums);
				c.fillStyle = blocked ? C.ice : ok ? C['drag-fill'] : C['invalid-fill'];
				c.globalAlpha = blocked ? 0.45 : 1;
				this.rr(...this.span(r));
				c.fill();
				c.globalAlpha = 1;
				c.strokeStyle = ok ? C['drag-stroke'] : blocked ? C.ice : C.mine;
				c.lineWidth = 2;
				c.stroke();
			}
			if (this.ghost) {
				const t = (now - this.ghost.start) / 320;
				if (t >= 1) this.ghost = null;
				else {
					c.globalAlpha = 1 - t;
					c.fillStyle = this.ghost.ice ? C.ice : C['invalid-fill'];
					this.rr(...this.span(this.ghost.r));
					c.fill();
					c.globalAlpha = 1;
				}
			}

			this.flashes = this.flashes.filter((f) => now - f.start < f.dur);
			for (const f of this.flashes) {
				const t = Math.max(0, (now - f.start) / f.dur);
				const x = f.cell % N;
				const y = Math.floor(f.cell / N);
				c.globalAlpha = 1 - t;
				if (f.kind === 'freeze') {
					// Freeze Over: the whole Board flashes ice-blue and fades (opacity only).
					c.fillStyle = C.ice;
					c.globalAlpha = (1 - t) * 0.6;
					c.fillRect(0, 0, this.S, this.S);
				} else if (f.kind === 'blast') {
					c.fillStyle = '#ffffff';
					c.globalAlpha = (1 - t) * 0.85;
					c.fillRect((x - 1) * k, (y - 1) * k, 3 * k, 3 * k);
				} else if (f.kind === 'pulse' || f.kind === 'ring') {
					c.strokeStyle = f.kind === 'pulse' ? '#ffffff' : C.mine;
					c.lineWidth = 3;
					c.beginPath();
					c.arc(x * k + k / 2, y * k + k / 2, k * (0.3 + t * 0.45), 0, 6.283);
					c.stroke();
				} else if (f.kind === 'shatter') {
					const ease = 1 - Math.pow(1 - t, 3);
					c.fillStyle = C.ice;
					for (const s of f.shards) {
						c.save();
						c.translate(x * k + k / 2 + Math.cos(s.a) * s.v * k * ease, y * k + k / 2 + Math.sin(s.a) * s.v * k * ease + t * t * k * 0.5);
						c.rotate(s.rot + t * 4);
						c.fillRect(-s.s * k, -s.s * k * 0.6, s.s * k * 2, s.s * k * 1.2);
						c.restore();
					}
				}
				c.globalAlpha = 1;
			}
			return this.flashes.length > 0 || !!this.ghost || (!REDUCED && e.mines.some((m) => m.fuse <= 1));
		}
	}

	const BLINKS = [0, 2, 3, 4];
	const tierFor = (n, rush) => (rush || n >= 16 ? 3 : n >= 9 ? 2 : n >= 5 ? 1 : 0);
	const comboTier = (c) => (c >= 8 ? 3 : c >= 6 ? 2 : c >= 4 ? 1 : 0);

	// —— The lane above each board: callouts on the left, combo on the right ——
	const lanes = [0, 1].map((i) => ({ el: $(PREFIX[i] + '-calls'), cur: null, nextAt: 0 }));
	function callout(idx, c) {
		const L = lanes[idx];
		const now = performance.now();
		const wait = Math.max(0, L.nextAt - now);
		L.nextAt = now + wait + 240; // two moments on one move play in order instead of overwriting at once
		if (wait) setTimeout(() => showCall(L, c), wait);
		else showCall(L, c);
	}
	function showCall(L, c) {
		if (L.cur) knock(L.cur);
		const el = document.createElement('div');
		el.className = 'call t' + c.tier;
		el.style.setProperty('--life', `${c.life}ms`);
		const span = document.createElement('span');
		span.textContent = c.text;
		if (c.blinks && !REDUCED) {
			span.className = 'flick';
			span.style.setProperty('--n', c.blinks);
		}
		el.appendChild(span);
		el.addEventListener('animationend', (ev) => {
			if (ev.target !== el || !el.classList.contains('fade')) return;
			el.remove();
			if (L.cur === el) L.cur = null;
		});
		L.el.appendChild(el);
		L.cur = el;
		// Full strength for its life (SENT 0.8s, the rest 1.2s), then a slow fade.
		setTimeout(() => el.isConnected && !el.classList.contains('knocked') && el.classList.add('fade'), c.life);
	}
	// A new callout knocks the old one off the top ("graduated prematurely").
	function knock(el) {
		el.classList.add('knocked');
		setTimeout(() => el.remove(), 200);
	}
	function clearLanes() {
		for (const L of lanes) {
			L.el.innerHTML = '';
			L.cur = null;
			L.nextAt = 0;
		}
		comboSeen[0] = comboSeen[1] = 0;
		for (const i of [0, 1]) $(PREFIX[i] + '-combo').hidden = true;
	}

	// Combo: persistent while alive (2+), coloured by size, blinks when it steps up a tier.
	const comboSeen = [0, 0];
	function renderCombo(i) {
		const n = opts.side(i).econ.combo || 0;
		const el = $(PREFIX[i] + '-combo');
		const span = el.firstChild;
		const was = comboSeen[i];
		comboSeen[i] = n;
		if (n === was) return;
		if (n >= 2) {
			const tier = comboTier(n);
			el.hidden = false;
			el.className = 'combo t' + tier;
			span.textContent = `COMBO ${n}`;
			if (REDUCED) return;
			void el.offsetWidth;
			if (tier > comboTier(was) && was >= 2 && BLINKS[tier]) {
				span.className = '';
				void span.offsetWidth;
				span.className = 'flick';
				span.style.setProperty('--n', BLINKS[tier]);
			} else if (tier > 0 && was < 2 && BLINKS[tier]) {
				span.className = 'flick';
				span.style.setProperty('--n', BLINKS[tier]);
			}
			el.classList.add('bump');
		} else if (was >= 2) {
			el.classList.add('gone');
			setTimeout(() => {
				if (comboSeen[i] < 2) el.hidden = true;
			}, 320);
		}
	}

	function pulseHearts(i) {
		const el = $(PREFIX[i] + '-hearts');
		if (!el || REDUCED) return;
		el.classList.remove('healed');
		void el.offsetWidth;
		el.classList.add('healed');
	}
	function shake(i, size) {
		if (REDUCED) return;
		const el = $(PREFIX[i] + '-card');
		el.classList.remove('shake-big', 'shake-small');
		void el.offsetWidth; // restart the animation
		el.classList.add('shake-' + size);
	}


	// —— Poles ——
	const BANK = 12; // = counterCap: a full bank is exactly what one counter-spike can cancel
	const BATCH = 6;
	const HALF = 3; // ice rows per half; frostMaxHeld 12 = 3 ice
	const poles = [0, 1].map(() => ({}));
	// Krischan's icons (2026-11-05): four corners = attack (your frost), three = danger (ice coming in).
	// Krischan's icons (2026-11-05), filled: diamond = attack (your frost), triangle = danger (ice coming in).
	// One per half, at the middle of the pole. Cut-outs use the ice track colour.
	const ICON_ATTACK = '<svg viewBox="0 0 7 7" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path fill="#fff" stroke="#fff" d="M0.788165 3.00436C0.722817 3.06964 0.670976 3.14716 0.635607 3.23249C0.600237 3.31782 0.582031 3.40928 0.582031 3.50165C0.582031 3.59402 0.600237 3.68548 0.635607 3.77081C0.670976 3.85614 0.722817 3.93366 0.788165 3.99894L3.00192 6.21269C3.0672 6.27804 3.14472 6.32988 3.23005 6.36525C3.31537 6.40062 3.40684 6.41882 3.49921 6.41882C3.59158 6.41882 3.68304 6.40062 3.76837 6.36525C3.8537 6.32988 3.93122 6.27804 3.9965 6.21269L6.21025 3.99894C6.2756 3.93366 6.32744 3.85614 6.36281 3.77081C6.39818 3.68548 6.41638 3.59402 6.41638 3.50165C6.41638 3.40928 6.39818 3.31782 6.36281 3.23249C6.32744 3.14716 6.2756 3.06964 6.21025 3.00436L3.9965 0.790607C3.93122 0.725259 3.8537 0.673418 3.76837 0.638048C3.68304 0.602678 3.59158 0.584473 3.49921 0.584473C3.40684 0.584473 3.31537 0.602678 3.23005 0.638048C3.14472 0.673418 3.0672 0.725259 3.00192 0.790607L0.788165 3.00436Z"/><path stroke="#29343F" d="M3.5 2.3335V4.66683"/><path stroke="#29343F" d="M2.33398 3.5H4.66732"/></svg>';
	const ICON_DANGER = '<svg viewBox="0 0 7 7" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path fill="#fff" stroke="#fff" d="M6.33796 5.25015L4.00462 1.16681C3.95375 1.07704 3.87997 1.00237 3.79081 0.950417C3.70165 0.898466 3.60031 0.871094 3.49712 0.871094C3.39394 0.871094 3.29259 0.898466 3.20344 0.950417C3.11428 1.00237 3.0405 1.07704 2.98962 1.16681L0.65629 5.25015C0.604864 5.33921 0.577899 5.44029 0.578126 5.54313C0.578354 5.64597 0.605767 5.74693 0.657587 5.83576C0.709407 5.9246 0.783792 5.99815 0.873202 6.04897C0.962611 6.09979 1.06387 6.12607 1.16671 6.12515H5.83337C5.93572 6.12504 6.03624 6.09801 6.12483 6.04677C6.21343 5.99553 6.28698 5.92188 6.33811 5.83322C6.38923 5.74456 6.41614 5.64401 6.41611 5.54166C6.41608 5.43932 6.38913 5.33878 6.33796 5.25015Z"/><path stroke="#29343F" d="M3.5 2.18066L3.49384 3.65967"/><path stroke="#29343F" d="M3.49414 5.11279H3.49706"/></svg>';
	function buildPoles(i) {
		const p = poles[i];
		const track = (cls, n, html) => {
			const t = Object.assign(document.createElement('div'), { className: 'track ' + cls });
			const out = [];
			for (let k = 0; k < n; k++) {
				const seg = document.createElement('i');
				if (html) seg.innerHTML = html(k, n);
				t.appendChild(seg);
				out.push(seg);
			}
			return [t, out];
		};
		// Right: a gold bank track over a red batch track, 3 pills per cell row.
		const hz = $(PREFIX[i] + '-hazards');
		hz.innerHTML = '';
		const [tb, bank] = track('bank', BANK);
		const [tr, batch] = track('batch', BATCH);
		hz.append(tb, tr);
		p.bank = bank.reverse(); // index 0 = the pill next to the batch: the bank fills upward from there
		p.batch = batch.reverse();
		// Left: frost (attack) over incoming (danger), one pill per cell row, one icon per half at the middle.
		const ip = $(PREFIX[i] + '-ice');
		ip.innerHTML = '';
		const [to, out] = track('out', HALF, (k, n) => '<span class="fill"></span>' + (k === n - 1 ? ICON_ATTACK : ''));
		const [ti, inn] = track('in', HALF, (k) => (k === 0 ? ICON_DANGER : ''));
		ip.append(to, ti);
		p.out = out; // index 0 = the top row: frost fills downward toward the middle
		p.in = inn.reverse(); // index 0 = the bottom row: the soonest ice
		p.ip = ip;
	}
	function boxesLeft(s) {
		return unplacedGivens(s.board()).length;
	}
	function renderPoles(i) {
		const s = opts.side(i);
		const e = s.econ;
		const p = poles[i];
		if (!p.bank) buildPoles(i);
		const bank = e.bank;
		p.bank.forEach((seg, k) => (seg.className = (k < bank ? 'on' : '') + (bank > BANK && k === BANK - 1 ? ' over' : '')));
		const next = e.nextBatch;
		p.batch.forEach((seg, k) => (seg.className = k < next ? 'on' : ''));

		// Frost: each row is one ice; it fills in height as points come in.
		const M = rulesNow().frostMeter || 0;
		const held = M ? e.frostHeld(boxesLeft(s)) : false;
		p.out.forEach((seg, k) => {
			const pts = M ? Math.max(0, Math.min(M, e.frost - k * M)) : 0;
			seg.firstChild.style.height = `${M ? (100 * pts) / M : 0}%`; // a pill growing down, not a squashed one
			seg.className = M && pts === M ? 'full' : M > 1 && pts === M - 1 ? 'near' : '';
		});
		p.ip.title = !M ? 'Frost off' : held ? 'Frost held: fires with your clear' : `Frost ${e.frost % M}/${M}`;
		// Incoming ice, soonest at the bottom.
		const etas = e.iceIncoming.map((w) => w.eta).sort((a, b) => a - b);
		p.in.forEach((seg, k) => {
			const eta = etas[k];
			let cls = '';
			if (eta != null) cls += eta <= 1 ? ' eta1' : ' eta2';
			if (k === 0 && etas.length > HALF) cls += ' over';
			if (k === 0 && seg.classList.contains('landed') && performance.now() < (p.landedUntil || 0)) cls += ' landed';
			seg.className = cls;
		});
	}
	function flashIn(i) {
		const p = poles[i];
		if (!p.in || REDUCED) return;
		const seg = p.in[0];
		seg.classList.remove('landed');
		void seg.offsetWidth;
		seg.classList.add('landed');
		p.landedUntil = performance.now() + 300;
	}

	// —— Hearts as dots ——
	function renderHearts(i) {
		const e = opts.side(i).econ;
		const el = $(PREFIX[i] + '-hearts');
		if (el.children.length !== rulesNow().hearts) {
			el.innerHTML = '';
			for (let k = 0; k < rulesNow().hearts; k++) {
				const h = document.createElement('i');
				h.appendChild(Object.assign(document.createElement('span'), { className: 'fill' }));
				el.appendChild(h);
			}
		}
		// Only the first missing heart can heal: it fills a step per perfect board and beats while
		// this board can still be perfect; a do-over drops it back to the checkpoint (or empty).
		const canHeal = rulesNow().healPerfectBoards && (!rulesNow().maxHealsPerRound || e.heals < rulesNow().maxHealsPerRound);
		const cp = rulesNow().healCheckpoint || 0;
		[...el.children].forEach((h, k) => {
			const alive = k < e.hearts;
			const healable = !alive && k === e.hearts && canHeal;
			const shown = e.doOversThisBoard ? (cp && e.perfectRun >= cp ? cp : 0) : e.perfectRun;
			h.className = alive ? 'on' : healable && e.perfectRun > 0 && !e.doOversThisBoard ? 'healing' : '';
			h.firstChild.style.transform = `scaleY(${healable ? shown / rulesNow().healPerfectBoards : 0})`;
		});
		el.title = `${e.hearts} of ${rulesNow().hearts} hearts`;
	}

	// —— Shots: transform-only projectiles to the other board's poles ——
	function shoot(from, to, cls, delay) {
		const shot = Object.assign(document.createElement('div'), { className: 'shot ' + cls });
		document.body.appendChild(shot);
		const x0 = from.left + from.width / 2;
		const y0 = from.top + from.height / 2;
		const x1 = to.left + to.width / 2;
		const y1 = to.top + to.height / 2;
		const lift = -Math.max(40, Math.abs(x1 - x0) * 0.25);
		shot.animate(
			[
				{ transform: `translate(${x0}px, ${y0}px) scale(1)` },
				{ transform: `translate(${(x0 + x1) / 2}px, ${(y0 + y1) / 2 + lift}px) scale(1.15)`, offset: 0.5 },
				{ transform: `translate(${x1}px, ${y1}px) scale(0.6)` }
			],
			{ duration: 420, delay, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'backwards' }
		).onfinish = () => shot.remove();
	}
	function fire(i, count, big) {
		if (REDUCED) return;
		const from = $(PREFIX[i] + '-board').getBoundingClientRect();
		const hz = $(PREFIX[1 - i] + '-hazards');
		shoot(from, hz.firstElementChild.getBoundingClientRect(), big ? 'big' : '', 0);
	}
	function frostShot(i, count) {
		const ip = poles[i].ip;
		if (!ip) return;
		ip.classList.remove('fired');
		void ip.offsetWidth;
		ip.classList.add('fired');
		if (REDUCED) return;
		const from = poles[i].out[HALF - 1].getBoundingClientRect();
		const to = poles[1 - i].in[0].getBoundingClientRect();
		for (let k = 0; k < count; k++) shoot(from, to, 'frost', k * 90);
	}


	const views = [new BoardView($('you-board'), 0, true), new BoardView($('them-board'), 1, false)];
	// My drag as a Tile ({ x1, y1, x2, y2 }) or null, for whoever wants to show it (opts.onHover).
	function hover(d) {
		if (!opts.onHover) return;
		opts.onHover(d ? { x1: Math.min(d.ax, d.bx), y1: Math.min(d.ay, d.by), x2: Math.max(d.ax, d.bx), y2: Math.max(d.ay, d.by) } : null);
	}
	/** Show a hovering Tile on screen i ({ x1, y1, x2, y2 }), or clear it with null. */
	function setGhost(i, r) {
		const v = views[i];
		if (!v) return;
		v.hover = r ? { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 } : null;
		kick();
	}

	/** Play the visual side of engine events. screenOf(e) → 0, 1, or -1 for match events. */
	function animate(events, screenOf) {
		const calls = [[], []];
		const defuseClear = [0, 0];
		const breaks = [0, 0];
		for (const e of events || []) {
			const si = screenOf(e);
			const v = views[si];
			if (v) {
				if (e.kind === 'newBoard') v.flashes = v.flashes.filter((f) => f.kind === 'freeze'); // a Freeze Over's flash carries over to the new Board
				else if (e.kind === 'mineExplode') {
					v.flash('blast', e.cell);
					shake(si, 'big');
				} else if (e.kind === 'mineLand') shake(si, 'small');
				else if (e.kind === 'frozen') {
					shake(si, 'small');
					flashIn(si);
				} else if (e.kind === 'defuse') v.flash('ring', e.cell);
				else if (e.kind === 'forceBreak') v.flash('shatter', e.cell, 1);
				else if (e.kind === 'thaw') v.flash('shatter', e.cell, 0.3);
			}
			if (si < 0) continue;
			if (e.kind === 'clear' && e.defuseBonus) defuseClear[si] = e.defuseBonus;
			if (e.kind === 'send' && e.pass > 0) {
				fire(si, e.pass, tierFor(e.pass, e.rush) >= 2);
				const counter = e.cancelled > 0;
				const label = counter ? 'COUNTER-SPIKE' : defuseClear[si] ? 'DEFUSE CLEAR' : 'SENT';
				const tier = tierFor(e.pass, e.rush);
				calls[si].push({ text: `${label} ${e.pass}`, tier, blinks: Math.max(BLINKS[tier], counter ? 2 : 0), life: label === 'SENT' ? 800 : 1200 });
			}
			if (e.kind === 'clutch') calls[si].push({ text: e.cancelled ? `CLUTCH −${e.cancelled}` : 'CLUTCH', tier: 1, blinks: 2, life: 1200 });
			if (e.kind === 'frostFire') {
				frostShot(si, e.count);
				if (e.deflected) calls[si].push({ text: e.deflected > 1 ? `DEFLECT ×${e.deflected}` : 'DEFLECT', tier: 'i', blinks: 0, life: 1200 });
			}
			if (e.kind === 'forceBreak') breaks[si]++;
			if (e.kind === 'frozenOut') {
				calls[si].push({ text: 'FROZEN OVER', tier: 'i', blinks: 3, life: 1400 });
				if (v) {
					v.flash('freeze', 0);
					shake(si, 'big');
				}
			}
			if (e.kind === 'heal' && e.healed) {
				pulseHearts(si);
				calls[si].push({ text: '+1 HEART', tier: 2, blinks: 2, life: 1400 });
			}
		}
		for (const i of [0, 1]) {
			if (breaks[i]) calls[i].unshift({ text: breaks[i] > 1 ? `ICEBREAK ×${breaks[i]}` : 'ICEBREAK', tier: 'i', blinks: 0, life: 1200 });
			for (const c of calls[i]) callout(i, c);
		}
		kick();
	}

	/** Poles, hearts and combo from the current sides. Cheap: a few dozen class writes. */
	function render() {
		if (!opts.side(0) || !opts.side(1)) return;
		for (const i of [0, 1]) {
			renderPoles(i);
			renderHearts(i);
			renderCombo(i);
		}
		kick();
	}

	// —— Views: play (your board where solo has it, the other as a mini board) or spectator (side by side) ——
	let view = 'play';
	function setView(v, mines = false) {
		view = v;
		$('stage').className = 'stage ' + v + (mines ? ' mines' : '');
		$('seat-them').classList.toggle('mini', v === 'play');
		kick();
	}

	/** A refused box flashes on board 0. kind: 'ice' or 'invalid'. */
	function deny(a, kind) {
		views[0].ghost = { r: new Rect(a.ax, a.ay, a.bx, a.by), ice: kind === 'ice', start: performance.now() };
		kick();
	}
	/** A new round or match: no leftover flashes, drags or callouts. */
	function reset() {
		for (const v of views) {
			v.flashes = [];
			v.drag = null;
			v.ghost = null;
			v.hover = null;
		}
		clearLanes();
		kick();
	}

	readColors();
	// Canvas text uses Shippori; redraw once the font has arrived.
	if (document.fonts && document.fonts.ready) document.fonts.ready.then(kick);
	return { views, kick, animate, render, setView, get view() { return view; }, deny, reset, setGhost };
}
