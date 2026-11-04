// board.js — paints one board on a canvas. Built to the low-end rules:
//   - paints only when told (paint()), never on a loop while idle
//   - a short flash (blast, defuse, icebreak) runs a few frames, then stops
//   - flat fills and alpha only: no blur, no shadows, no gradients, no particles
// Colors: lavender boxes in VS; red is mines, blue is ice, nothing else is saturated.
// The VS lab's tokens (lab/page.html in this repo).
export const BOARD_COLORS = {
	cell: '#2b2b2b',
	clue: '#ffffff',
	box: '#a090c0',
	boxClue: 'rgba(0,0,0,0.35)',
	mine: '#d08080',
	ink: '#121212',
	ice: '#80b3e6',
	drag: 'rgba(68,136,255,0.3)',
	dragLine: '#4488ff',
	bad: 'rgba(255,85,85,0.35)'
};

export class BoardPainter {
	/** onMove(action) is called for a finished drag or a tap; leave it null for a view-only board. */
	constructor(canvas, onMove) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.onMove = onMove;
		this.side = null;
		this.rules = null;
		this.drag = null;
		this.flashes = [];
		this.ghost = null;
		this._raf = 0;
		if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._resize()).observe(canvas);
		else window.addEventListener('resize', () => this._resize());
		this._resize();
		if (onMove) this._bind();
	}
	set(side, rules) {
		this.side = side;
		this.rules = rules;
		this.paint();
	}
	_resize() {
		const S = Math.max(60, Math.floor(this.canvas.clientWidth || 300));
		const dpr = Math.min(2, window.devicePixelRatio || 1); // cap at 2x: sharper than that costs fill rate for nothing
		if (S === this.S && dpr === this.dpr) return;
		this.S = S;
		this.dpr = dpr;
		this.canvas.width = Math.round(S * dpr);
		this.canvas.height = Math.round(S * dpr);
		this.paint();
	}
	get N() {
		return this.side ? this.side.puzzle.nums.length : 6;
	}
	_cellAt(ev) {
		const b = this.canvas.getBoundingClientRect();
		const N = this.N;
		const cl = (v) => Math.min(N - 1, Math.max(0, v));
		return [cl(Math.floor(((ev.clientX - b.left) / b.width) * N)), cl(Math.floor(((ev.clientY - b.top) / b.height) * N))];
	}
	_bind() {
		const c = this.canvas;
		c.addEventListener('pointerdown', (e) => {
			if (!this.side) return;
			c.setPointerCapture(e.pointerId);
			const [x, y] = this._cellAt(e);
			this.drag = { ax: x, ay: y, bx: x, by: y };
			this.paint();
		});
		c.addEventListener('pointermove', (e) => {
			if (!this.drag) return;
			const [x, y] = this._cellAt(e);
			if (x === this.drag.bx && y === this.drag.by) return;
			this.drag.bx = x;
			this.drag.by = y;
			this.paint();
		});
		c.addEventListener('pointerup', () => {
			const d = this.drag;
			this.drag = null;
			if (!d) return;
			if (d.ax === d.bx && d.ay === d.by) this.onMove({ type: 'erase', x: d.ax, y: d.ay });
			else this.onMove({ type: 'place', ax: d.ax, ay: d.ay, bx: d.bx, by: d.by });
			this.paint();
		});
		c.addEventListener('pointercancel', () => {
			this.drag = null;
			this.paint();
		});
	}

	/** Brief feedback: 'blast' | 'ring' | 'break' at a cell, or a refused box (deny). */
	flash(kind, cell) {
		this.flashes.push({ kind, cell, start: performance.now(), dur: kind === 'blast' ? 320 : 260 });
		this._animate();
	}
	deny(ax, ay, bx, by) {
		this.ghost = { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by), start: performance.now() };
		this._animate();
	}
	_animate() {
		if (this._raf) return;
		const step = () => {
			this._raf = 0;
			this.paint();
			if (this.flashes.length || this.ghost) this._raf = requestAnimationFrame(step);
		};
		this._raf = requestAnimationFrame(step);
	}

	_box(x1, y1, x2, y2) {
		const k = this.S / this.N;
		const g = Math.max(4, Math.round(this.S / 80));
		return [x1 * k + g / 2, y1 * k + g / 2, (x2 - x1 + 1) * k - g, (y2 - y1 + 1) * k - g];
	}
	_cell(i) {
		const x = i % this.N;
		const y = Math.floor(i / this.N);
		return this._box(x, y, x, y);
	}
	_rr(x, y, w, h) {
		const c = this.ctx;
		const r = Math.min(Math.max(4, (this.S / this.N) * 0.08), w / 2, h / 2);
		c.beginPath();
		c.moveTo(x + r, y);
		c.arcTo(x + w, y, x + w, y + h, r);
		c.arcTo(x + w, y + h, x, y + h, r);
		c.arcTo(x, y + h, x, y, r);
		c.arcTo(x, y, x + w, y, r);
		c.closePath();
	}

	paint() {
		if (!this.S) return;
		const c = this.ctx;
		const C = BOARD_COLORS;
		c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		c.clearRect(0, 0, this.S, this.S);
		const side = this.side;
		if (!side) return;
		const N = this.N;
		const nums = side.puzzle.nums;
		const e = side.econ;
		const k = this.S / N;
		const font = (px) => `${Math.round(px)}px 'Shippori Antique B1', 'Hiragino Sans', system-ui, sans-serif`;
		c.textAlign = 'center';
		c.textBaseline = 'middle';

		for (let i = 0; i < N * N; i++) {
			const [x, y, w, h] = this._cell(i);
			c.fillStyle = C.cell;
			this._rr(x, y, w, h);
			c.fill();
		}
		const covered = new Uint8Array(N * N);
		for (const r of side.rects) {
			const [x, y, w, h] = this._box(r.x1, r.y1, r.x2, r.y2);
			c.fillStyle = C.box;
			this._rr(x, y, w, h);
			c.fill();
			for (let yy = r.y1; yy <= r.y2; yy++) for (let xx = r.x1; xx <= r.x2; xx++) covered[yy * N + xx] = 1;
		}
		for (const m of e.mines) this._mine(m);
		for (const f of e.ice) this._ice(f);
		c.font = font(k * 0.42);
		for (let y = 0; y < N; y++)
			for (let x = 0; x < N; x++) {
				const v = nums[y][x];
				if (!v) continue;
				c.fillStyle = covered[y * N + x] ? C.boxClue : C.clue;
				c.fillText(String(v), x * k + k / 2, y * k + k / 2 + k * 0.02);
			}
		if (this.drag) {
			const d = this.drag;
			const [x, y, w, h] = this._box(Math.min(d.ax, d.bx), Math.min(d.ay, d.by), Math.max(d.ax, d.bx), Math.max(d.ay, d.by));
			c.fillStyle = C.drag;
			this._rr(x, y, w, h);
			c.fill();
			c.strokeStyle = C.dragLine;
			c.lineWidth = 2;
			c.stroke();
			const area = (Math.abs(d.ax - d.bx) + 1) * (Math.abs(d.ay - d.by) + 1);
			c.fillStyle = '#ffffff';
			c.font = font(k * 0.3);
			c.fillText(String(area), x + w - k * 0.25, y + k * 0.25);
		}
		const now = performance.now();
		if (this.ghost) {
			const g = this.ghost;
			const t = (now - g.start) / 300;
			if (t >= 1) this.ghost = null;
			else {
				const [x, y, w, h] = this._box(g.x1, g.y1, g.x2, g.y2);
				c.globalAlpha = 1 - t;
				c.fillStyle = C.bad;
				this._rr(x, y, w, h);
				c.fill();
				c.globalAlpha = 1;
			}
		}
		this.flashes = this.flashes.filter((f) => now - f.start < f.dur);
		for (const f of this.flashes) {
			const t = (now - f.start) / f.dur;
			const cx = (f.cell % N) * k + k / 2;
			const cy = Math.floor(f.cell / N) * k + k / 2;
			c.globalAlpha = 1 - t;
			if (f.kind === 'blast') {
				c.fillStyle = C.mine;
				const s = k * (1 + 2 * t);
				c.fillRect(cx - s / 2, cy - s / 2, s, s);
			} else {
				c.strokeStyle = f.kind === 'break' ? C.ice : '#ffffff';
				c.lineWidth = 3;
				c.beginPath();
				c.arc(cx, cy, k * (0.3 + 0.4 * t), 0, 6.283);
				c.stroke();
			}
			c.globalAlpha = 1;
		}
	}

	_mine(m) {
		const c = this.ctx;
		const [x, y, w, h] = this._cell(m.cell);
		c.fillStyle = BOARD_COLORS.mine;
		this._rr(x, y, w, h);
		c.fill();
		const cx = x + w / 2;
		const cy = y + h / 2;
		const R = w * 0.3;
		c.strokeStyle = BOARD_COLORS.ink;
		c.lineWidth = Math.max(2, w * 0.06);
		c.beginPath();
		c.arc(cx, cy, R, 0, 6.283);
		c.stroke();
		c.fillStyle = BOARD_COLORS.ink;
		const total = this.rules?.mineFuse || 3;
		const p = m.fuse <= 1 ? 1 : (total - m.fuse + 1) / total;
		c.beginPath();
		c.moveTo(cx, cy);
		c.arc(cx, cy, R * 0.72, -Math.PI / 2, -Math.PI / 2 + p * 6.283);
		c.closePath();
		c.fill();
	}
	/** Ice as in the lab: blue, ink hatching, an inset square, and a thaw wedge that grows as it melts. */
	_ice(f) {
		const c = this.ctx;
		const C = BOARD_COLORS;
		const [x, y, w, h] = this._cell(f.cell);
		c.fillStyle = C.ice;
		this._rr(x, y, w, h);
		c.fill();
		c.save();
		this._rr(x, y, w, h);
		c.clip();
		c.strokeStyle = C.ink;
		const step = Math.max(5, w / 7);
		c.lineWidth = step * 0.45;
		c.beginPath();
		for (let t = -h; t < w + h; t += step) {
			c.moveTo(x + t, y + h);
			c.lineTo(x + t + h, y);
		}
		c.stroke();
		c.restore();
		const inset = w * 0.17;
		const ix = x + inset;
		const iy = y + inset;
		const iw = w - inset * 2;
		c.fillStyle = C.ink;
		c.fillRect(ix - 2, iy - 2, iw + 4, iw + 4);
		c.fillStyle = C.ice;
		c.fillRect(ix, iy, iw, iw);
		const total = this.rules?.thawPoints || 4;
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
}
