// app.js — Shikaku+ VS lab on the vs-1 engine (ported from shikaku-plus-info/prototypes/vs-lab, 2026-11-05).
// IIFE so names never collide with the bundled engine modules.
//
// Cost notes (PRINCIPLES.md, "Optimization is the craft"):
//   canvas  draws only when something changed or is animating (flash, ghost, last-tick mine); idle = 0 frames
//   timers  one gravity timeout per due tick (every gravitySecs), one clock-text timeout per second while a round runs
//   DOM     poles, hearts and combo update on events only; callouts are one element per moment
(() => {
	const RULES = { ...VERSUS_RULES };
	// Two modes on one engine: Shikaku+ VS (everything) and Shikaku+ Mines (mines only, no ice, unrated).
	let mode = 'vs';
	const modeRules = () => (mode === 'mines' ? MINES_RULES : VERSUS_RULES);
	let presetKey = 'normal';
	const BOT = { ...BOT_PRESETS.normal };
	let botBoard = 0; // board index the bot last moved on (for its read pause)
	const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const $ = (id) => document.getElementById(id);
	const PREFIX = ['you', 'them'];

	let match;
	let bot;
	let botTimer = 0;
	const logItems = [];
	// Watch mode: a bot plays the left board too, and rounds roll on by themselves.
	let watching = false;
	let leftKey = 'hard';
	const LEFT = { ...BOT_PRESETS.hard };
	let leftBot = null;
	let leftTimer = 0;
	let leftBoard = 0;
	// Round log (for "Copy round log"): every event with time, side and that side's move number.
	let roundLog = [];
	let lastRoundLog = null;
	const moveNo = [0, 0];

	// —— Match clock: virtual ms. Pausing stops it; Watch speed scales it. Gravity and rush read it. ——
	let speed = 1;
	let paused = false;
	let vAnchor = 0;
	let rAnchor = performance.now();
	const clock = () => vAnchor + (paused ? 0 : (performance.now() - rAnchor) * speed);
	function reanchor() {
		vAnchor = clock();
		rAnchor = performance.now();
	}
	let endAt = null; // clock when the round ended

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
			return match.sides[this.idx];
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
			return this.side.N;
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
				if (watching || !match || match.roundOver) return;
				try {
					c.setPointerCapture(e.pointerId);
				} catch {}
				const [x, y] = this.cellAt(e);
				this.drag = { ax: x, ay: y, bx: x, by: y };
				kick();
			});
			c.addEventListener('pointermove', (e) => {
				if (!this.drag) return;
				const [x, y] = this.cellAt(e);
				if (x === this.drag.bx && y === this.drag.by) return;
				this.drag.bx = x;
				this.drag.by = y;
				kick();
			});
			c.addEventListener('pointerup', () => {
				const d = this.drag;
				this.drag = null;
				kick();
				if (!d) return;
				if (d.ax === d.bx && d.ay === d.by) youMove({ type: 'erase', x: d.ax, y: d.ay });
				else youMove({ type: 'place', ...d });
			});
			c.addEventListener('pointercancel', () => {
				this.drag = null;
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
			const f = { kind, cell, start: now, dur: kind === 'shatter' ? 520 : 380 };
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
			const total = RULES.mineFuse;
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
			const total = RULES.thawPoints;
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
			if (!this.S || !match) return false;
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
				if (f.kind === 'blast') {
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

	const views = [new BoardView($('you-board'), 0, true), new BoardView($('them-board'), 1, false)];

	// —— Moves: gravity owed so far is paid first, then the move, all at the same clock ——
	function play(i, action) {
		const now = clock();
		const pre = match.catchUp(now);
		const r = match.act(i, action, now);
		r.events = [...pre, ...r.events];
		return r;
	}
	function youMove(action) {
		if (!match || match.roundOver || paused) return;
		const r = play(0, action);
		if (r.moved) {
			moveNo[0]++;
			// Mirror moves in lockstep: one bot move for each of yours, a beat after it.
			if (BOT.mirror) botMove(0.2 + Math.random() * 0.25);
		}
		if (!r.moved && r.denied && action.type === 'place') {
			views[0].ghost = { r: new Rect(action.ax, action.ay, action.bx, action.by), ice: r.denied === 'ice', start: performance.now() };
			kick();
		}
		handle(r.events);
	}
	function scheduleLeft() {
		clearTimeout(leftTimer);
		if (!watching || paused || !match || match.roundOver) return;
		const jitter = 0.6 + Math.random() * 0.8;
		const side = match.sides[0];
		const reading = side.boardIndex !== leftBoard ? LEFT.read : 0;
		leftBoard = side.boardIndex;
		leftTimer = setTimeout(() => {
			if (!watching || paused || match.roundOver) return;
			const r = play(0, leftBot.decide(match.sides[0]));
			if (r.moved) {
				moveNo[0]++;
				if (BOT.mirror) botMove(0.2 + Math.random() * 0.25);
			}
			handle(r.events);
			scheduleLeft();
		}, ((LEFT.secs * jitter + reading) * 1000) / speed);
	}
	function botMove(delay) {
		setTimeout(() => {
			if (paused || !match || match.roundOver) return;
			const r = play(1, bot.decide(match.sides[1]));
			if (r.moved) moveNo[1]++;
			handle(r.events);
		}, (delay * 1000) / speed);
	}
	function scheduleBot() {
		clearTimeout(botTimer);
		if (paused || !match || match.roundOver || BOT.mirror) return;
		const jitter = 0.6 + Math.random() * 0.8;
		const side = match.sides[1];
		const reading = side.boardIndex !== botBoard ? BOT.read : 0;
		botBoard = side.boardIndex;
		botTimer = setTimeout(() => {
			if (paused || match.roundOver) return;
			const r = play(1, bot.decide(match.sides[1]));
			if (r.moved) moveNo[1]++;
			handle(r.events);
			scheduleBot();
		}, ((BOT.secs * jitter + reading) * 1000) / speed);
	}

	// —— Gravity: one timeout to the next owed tick on either board, nothing in between ——
	let gravTimer = 0;
	function scheduleGravity() {
		clearTimeout(gravTimer);
		const step = (RULES.gravitySecs || 0) * 1000;
		if (!step || paused || !match || match.roundOver) return;
		let due = Infinity;
		for (const s of match.sides) if (s.gAt != null && s.frozenAt == null) due = Math.min(due, s.gAt + step);
		if (due === Infinity) return;
		gravTimer = setTimeout(() => {
			if (paused || match.roundOver) return;
			handle(match.catchUp(clock()));
		}, Math.max(0, (due - clock()) / speed) + 5);
	}
	function regravity() {
		// The gravity slider moved: owe nothing for the time it was off or slower.
		if (!match) return;
		const now = clock();
		for (const s of match.sides) if (s.gAt != null) s.gAt = now;
		scheduleGravity();
	}

	// —— Events ——
	function describe(e) {
		switch (e.kind) {
			case 'minesIncoming': return `${e.count} mine${e.count > 1 ? 's' : ''} incoming, ${e.eta} moves`;
			case 'mineLand': return 'mine landed';
			case 'mineExplode': return e.together > 1 ? `mine exploded with ${e.together - 1} more (one heart lost for all), ${e.hearts} left` : `mine exploded, ${e.hearts} heart${e.hearts === 1 ? '' : 's'} left`;
			case 'iceBlocked': return 'ice dropped: too many on the way';
			case 'rectsBlown': return `blast removed ${e.count} box${e.count > 1 ? 'es' : ''}`;
			case 'defuse': return e.clutch ? 'defused a mine on its last tick' : e.fresh ? 'defused a fresh mine (+1 frost)' : 'defused a mine';
			case 'iceIncoming': return `ice incoming, lands in ${e.eta} moves`;
			case 'frozen': return 'a cell froze';
			case 'thaw': return e.source === 'active' ? 'broke ice by building next to it' : 'ice melted';
			case 'forceBreak': return e.earned ? 'icebreak on your last boxes (+frost)' : 'icebreaker';
			case 'clear': return `board cleared${e.perfect ? ' perfect' : ''}${e.combo > 1 ? `, combo ${e.combo}${e.comboBonus ? ` +${e.comboBonus}` : ''}` : ''}${e.defuseBonus ? `, defuse clear +${e.defuseBonus}` : ''}: ${e.sendMines} mines${e.sendIce ? ` + ${e.sendIce} ice` : ''}${e.wiped ? `, ${e.wiped} waiting mines died with the board` : ''}`;
			case 'comboBreak': return `combo of ${e.combo} broken`;
			case 'heal': return e.boards ? (e.healed ? `${e.boards} perfect boards in a row: healed a heart` : `${e.boards} perfect boards in a row (hearts already full)`) : e.healed ? `${e.streak}x streak: healed a heart` : `${e.streak}x streak (hearts already full)`;
			case 'send': return e.cancelled ? `attack ${e.count}${e.rush ? ' (rush)' : ''}: cancelled ${e.cancelled} of yours, sent ${e.pass}` : `sent ${e.count} mines${e.rush ? ' (rush)' : ''}`;
			case 'sendIce': return `sent ${e.count} ice`;
			case 'frostFire': return `frost fired${e.deflected ? `: deflected ${e.deflected} incoming ice` : ''}${e.count ? `${e.deflected ? ', ' : ': '}sent ${e.count} ice` : ''}${e.withClear ? ', with the clear' : ''}`;
			case 'clutch': return e.cancelled ? `clutch: cancelled ${e.cancelled} incoming` : 'clutch (nothing incoming to cancel)';
			case 'bankFreeze': return `bank of ${e.bank} sat too long: ice on the way`;
			case 'frozenOut': return 'froze over: board lost, its mines go back to the red batch';
			case 'ko': return e.by === 'ice' ? 'frozen over' : 'out of hearts';
			default: return null;
		}
	}

	// Callout tiers by mines sent: ≤4 grey, 5–8 amber, 9–15 red, 16+ or rush white-hot.
	const BLINKS = [0, 2, 3, 4];
	const tierFor = (n, rush) => (rush || n >= 16 ? 3 : n >= 9 ? 2 : n >= 5 ? 1 : 0);
	const comboTier = (c) => (c >= 8 ? 3 : c >= 6 ? 2 : c >= 4 ? 1 : 0);

	function handle(events) {
		const calls = [[], []];
		const defuseClear = [0, 0];
		const breaks = [0, 0];
		let roundEnd = null;
		for (const e of events || []) {
			const si = e.side === 'you' ? 0 : e.side === 'them' ? 1 : -1;
			if (e.kind !== 'gravity' && e.kind !== 'thawPulse') roundLog.push({ t: Math.round(clock() - (match.roundStartAt ?? 0)), move: si >= 0 ? moveNo[si] : null, ...e });
			const v = views[si];
			if (v) {
				if (e.kind === 'newBoard') v.flashes = [];
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
			if (si >= 0) {
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
				if (e.kind === 'frozenOut') calls[si].push({ text: 'FROZEN OVER', tier: 'i', blinks: 0, life: 1200 });
				if (e.kind === 'heal' && e.healed) {
					pulseHearts(si);
					calls[si].push({ text: 'HEALED', tier: 0, blinks: 0, life: 1200 });
				}
			}
			if (e.kind === 'roundOver') roundEnd = e;
			const text = describe(e);
			if (text) logItems.unshift({ side: e.side, text });
		}
		logItems.length = Math.min(logItems.length, 150);
		for (const i of [0, 1]) {
			if (breaks[i]) calls[i].unshift({ text: breaks[i] > 1 ? `ICEBREAK ×${breaks[i]}` : 'ICEBREAK', tier: 'i', blinks: 0, life: 1200 });
			for (const c of calls[i]) callout(i, c);
		}
		renderLog();
		renderHud();
		kick();
		if (roundEnd) showRoundOver(roundEnd);
		else scheduleGravity();
	}

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
		const n = match.sides[i].econ.combo || 0;
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

	function renderLog() {
		const ul = $('log');
		ul.innerHTML = '';
		for (const it of logItems.slice(0, 110)) {
			const li = document.createElement('li');
			li.className = it.side;
			const who = document.createElement('span');
			who.className = 'who';
			who.textContent = it.side === 'you' ? (watching ? 'Left' : 'You') : it.side === 'them' ? (watching ? 'Right' : 'Bot') : '';
			const msg = document.createElement('span');
			msg.textContent = it.text;
			li.append(who, document.createTextNode(' '), msg);
			ul.appendChild(li);
		}
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
		const s = match.sides[i];
		const e = s.econ;
		const p = poles[i];
		if (!p.bank) buildPoles(i);
		const bank = e.bank;
		p.bank.forEach((seg, k) => (seg.className = (k < bank ? 'on' : '') + (bank > BANK && k === BANK - 1 ? ' over' : '')));
		const next = e.nextBatch;
		p.batch.forEach((seg, k) => (seg.className = k < next ? 'on' : ''));

		// Frost: each row is one ice; it fills in height as points come in.
		const M = RULES.frostMeter || 0;
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
		const e = match.sides[i].econ;
		const el = $(PREFIX[i] + '-hearts');
		if (el.children.length !== RULES.hearts) {
			el.innerHTML = '';
			for (let k = 0; k < RULES.hearts; k++) {
				const h = document.createElement('i');
				h.appendChild(Object.assign(document.createElement('span'), { className: 'fill' }));
				el.appendChild(h);
			}
		}
		// Only the first missing heart can heal: it fills a step per perfect board and beats while
		// this board can still be perfect; a do-over drops it back to the checkpoint (or empty).
		const canHeal = RULES.healPerfectBoards && (!RULES.maxHealsPerRound || e.heals < RULES.maxHealsPerRound);
		const cp = RULES.healCheckpoint || 0;
		[...el.children].forEach((h, k) => {
			const alive = k < e.hearts;
			const healable = !alive && k === e.hearts && canHeal;
			const shown = e.doOversThisBoard ? (cp && e.perfectRun >= cp ? cp : 0) : e.perfectRun;
			h.className = alive ? 'on' : healable && e.perfectRun > 0 && !e.doOversThisBoard ? 'healing' : '';
			h.firstChild.style.transform = `scaleY(${healable ? shown / RULES.healPerfectBoards : 0})`;
		});
		el.title = `${e.hearts} of ${RULES.hearts} hearts`;
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

	function renderHud() {
		if (!match) return;
		$('score-you').textContent = match.score[0];
		$('score-them').textContent = match.score[1];
		for (const i of [0, 1]) {
			renderPoles(i);
			renderHearts(i);
			renderCombo(i);
		}
		$('mode-line').textContent = `${mode === 'mines' ? 'Mines · Unrated' : 'VS'} · 6×6 · FT${match.target}${match.rush ? ` · Rush ×${RULES.rushMultiplier}` : ''}`;
	}
	// Round clock, m:ss. One timeout per second while the round runs; none while paused or over.
	let clockTimer = 0;
	function renderTimer() {
		clearTimeout(clockTimer);
		if (!match) return;
		const ms = Math.max(0, (endAt ?? clock()) - (match.roundStartAt ?? 0));
		const t = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
		// Rush: the clock turns white and says so, blinking on a 0.8s beat.
		// The engine's clock only moves when something happens, so ask about now (same rule as VersusMatch.rush).
		const r = RULES;
		const rush = !match.roundOver && (r.rushAfterSecs ? ms >= r.rushAfterSecs * 1000 : !!match.rush);
		for (const id of ['you-time', 'them-time']) {
			const el = $(id);
			el.textContent = rush ? `RUSH • ${t}` : t;
			el.classList.toggle('rush', rush);
		}
		if (!paused && endAt == null) clockTimer = setTimeout(renderTimer, Math.max(50, (1000 - (ms % 1000)) / speed));
	}

	function showRoundOver(e) {
		endAt = clock();
		clearTimeout(gravTimer);
		clearTimeout(clockTimer);
		renderTimer();
		lastRoundLog = buildRoundLog(e);
		const youWon = e.winner === 0;
		$('ov-title').textContent = match.over ? (youWon ? 'Match won' : 'Match lost') : e.winner === null ? 'Double KO' : youWon ? 'Round won' : 'Round lost';
		const how = e.by === 'ice' ? 'froze over' : 'ran out of hearts';
		$('ov-sub').textContent = `${youWon ? (watching ? 'Right bot' : 'Bot') : watching ? 'Left bot' : 'You'} ${how}. ${match.score[0]} – ${match.score[1]}`;
		$('ov-next').textContent = match.over ? 'New match' : 'Next round';
		$('overlay').hidden = false;
		clearTimeout(botTimer);
		clearTimeout(leftTimer);
		if (watching) setTimeout(() => watching && !$('overlay').hidden && $('ov-next').click(), 2500 / speed);
	}
	$('ov-next').addEventListener('click', () => {
		$('overlay').hidden = true;
		if (match.over) return newMatch();
		match.newRound();
		startRound(`round ${match.round}: both boards reset`);
	});

	function buildRoundLog(end) {
		const diff = {};
		for (const k of Object.keys(RULES)) if (JSON.stringify(RULES[k]) !== JSON.stringify(VERSUS_RULES[k])) diff[k] = RULES[k];
		const { label, ...botStats } = BOT;
		return {
			lab: 'Shikaku+ VS lab (vs-1 engine)',
			at: new Date().toISOString(),
			bot: { preset: presetKey, label, ...botStats },
			seed: match.seed,
			round: match.round,
			score: [...match.score],
			result: end ? { winner: end.winner === 0 ? 'you' : end.winner === 1 ? 'bot' : 'double KO', by: end.by } : 'in progress',
			ms: Math.round((endAt ?? clock()) - (match.roundStartAt ?? 0)),
			moves: { you: moveNo[0], bot: moveNo[1] },
			end: match.sides.map((s) => ({ side: s.name, board: s.boardIndex + 1, cleared: s.cleared, hearts: s.econ.hearts, ice: s.econ.ice.length, bank: s.econ.bank, combo: s.econ.combo, frost: s.econ.frost })),
			rulesChanged: diff,
			events: roundLog
		};
	}
	async function copyText(btn, json, idle) {
		try {
			await navigator.clipboard.writeText(json);
			btn.textContent = 'Copied';
		} catch {
			const ta = Object.assign(document.createElement('textarea'), { value: json });
			ta.style.cssText = 'width:100%;height:160px;margin-top:8px;font:12px monospace;background:var(--cell);color:var(--fg);border:0;border-radius:6px';
			btn.after(ta);
			ta.select();
			btn.textContent = 'Select and copy below';
		}
		setTimeout(() => (btn.textContent = idle), 2000);
	}
	$('ov-log').addEventListener('click', () => copyText($('ov-log'), JSON.stringify(lastRoundLog || buildRoundLog(null), null, 1), 'Copy round log'));
	$('t-log').addEventListener('click', () => copyText($('t-log'), JSON.stringify(match.roundOver ? lastRoundLog : buildRoundLog(null), null, 1), 'Copy round log'));

	function startRound(msg) {
		match.startClock(clock());
		endAt = null;
		roundLog = [];
		moveNo[0] = moveNo[1] = 0;
		botBoard = 0;
		leftBoard = 0;
		for (const v of views) {
			v.flashes = [];
			v.drag = null;
			v.ghost = null;
		}
		clearLanes();
		logItems.unshift({ side: 'match', text: msg });
		renderLog();
		renderHud();
		renderTimer();
		kick();
		scheduleGravity();
		scheduleBot();
		scheduleLeft();
	}
	function newMatch() {
		const seed = Math.floor(Math.random() * 1e6) + 1;
		match = new VersusMatch({ rules: RULES, seed });
		bot = new TiltBot({ ...BOT, seed: seed + 17 });
		leftBot = new TiltBot({ ...LEFT, seed: seed + 5 });
		logItems.length = 0;
		$('overlay').hidden = true;
		startRound('match starts, first to 7');
	}
	$('restart').addEventListener('click', newMatch);
	$('pause').addEventListener('click', () => {
		if (!paused) {
			reanchor();
			paused = true;
			clearTimeout(botTimer);
			clearTimeout(leftTimer);
			clearTimeout(gravTimer);
			clearTimeout(clockTimer);
		} else {
			rAnchor = performance.now();
			paused = false;
			renderTimer();
			scheduleGravity();
			scheduleBot();
			scheduleLeft();
		}
		$('pause').textContent = paused ? 'Resume' : 'Pause';
	});

	// —— Views: play (your board where solo has it, opponent as a mini board) or spectator (side by side) ——
	let view = 'play';
	function setView(v) {
		view = v;
		$('stage').className = 'stage ' + v + (mode === 'mines' ? ' mines' : '');
		$('seat-them').classList.toggle('mini', v === 'play');
		kick();
		for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
	}
	for (const b of document.querySelectorAll('#views button')) b.addEventListener('click', () => setView(b.dataset.view));

	// —— Watch bots ——
	function setWho() {
		const you = watching ? `${LEFT.label} bot` : 'You';
		const them = watching ? `${BOT.label} bot` : `${BOT.label} bot`;
		$('you-name').textContent = you;
		$('name-you').textContent = you;
		$('them-name').textContent = them;
		$('name-them').textContent = them;
	}
	$('watch').addEventListener('click', () => {
		watching = !watching;
		$('watch').setAttribute('aria-pressed', String(watching));
		$('watch').textContent = watching ? 'Stop watching' : 'Watch bots';
		$('watch-row').hidden = !watching;
		if (!watching && speed !== 1) setSpeed(1);
		setView(watching ? 'spec' : 'play');
		setWho();
		newMatch();
	});
	function setLeft(key) {
		leftKey = key;
		Object.assign(LEFT, BOT_PRESETS[key]);
		if (leftBot) Object.assign(leftBot, { baseMisplay: LEFT.misplay, tiltPerMine: LEFT.tiltPerMine, tiltPerHeart: LEFT.tiltPerHeart, defuseFirst: LEFT.defuseFirst, counterHold: LEFT.counterHold ?? 0 });
		for (const b of document.querySelectorAll('#left-presets button')) b.setAttribute('aria-pressed', String(b.dataset.key === key));
		setWho();
	}
	for (const [key, pr] of Object.entries(BOT_PRESETS)) {
		if (pr.mirror) continue; // Mirror copies a human; on the left there's nobody to copy
		const b = Object.assign(document.createElement('button'), { textContent: pr.label, type: 'button' });
		b.dataset.key = key;
		b.setAttribute('aria-pressed', String(key === leftKey));
		b.addEventListener('click', () => setLeft(key));
		$('left-presets').appendChild(b);
	}
	function setSpeed(x) {
		reanchor();
		speed = x;
		for (const o of document.querySelectorAll('#speeds button')) o.setAttribute('aria-pressed', String(Number(o.dataset.x) === x));
		scheduleGravity();
		renderTimer();
	}
	for (const x of [1, 2, 4]) {
		const b = Object.assign(document.createElement('button'), { textContent: `${x}×`, type: 'button' });
		b.dataset.x = x;
		b.setAttribute('aria-pressed', String(x === speed));
		b.addEventListener('click', () => setSpeed(x));
		$('speeds').appendChild(b);
	}

	// —— Bot presets ——
	function setPreset(key) {
		presetKey = key;
		Object.assign(BOT, BOT_PRESETS[key]);
		if (!BOT_PRESETS[key].mirror) delete BOT.mirror;
		if (!BOT_PRESETS[key].counterHold) delete BOT.counterHold;
		if (bot) Object.assign(bot, { baseMisplay: BOT.misplay, tiltPerMine: BOT.tiltPerMine, tiltPerHeart: BOT.tiltPerHeart, defuseFirst: BOT.defuseFirst, counterHold: BOT.counterHold ?? 0 });
		for (const b of document.querySelectorAll('#presets button')) b.setAttribute('aria-pressed', String(b.dataset.key === key));
		setWho();
		buildRules();
		scheduleBot();
	}
	for (const [key, p] of Object.entries(BOT_PRESETS)) {
		const b = Object.assign(document.createElement('button'), { textContent: p.label, type: 'button' });
		b.dataset.key = key;
		b.setAttribute('aria-pressed', String(key === presetKey));
		b.addEventListener('click', () => setPreset(key));
		$('presets').appendChild(b);
	}

	// —— Rules lab ——
	const pct = (v) => Math.round(v * 100) + '%';
	const COMBO_ON = VERSUS_RULES.comboTable;
	const GROUPS = [
		['Bot', [
			{ o: BOT, k: 'secs', label: 'Seconds per move', min: 0.6, max: 4, step: 0.1, fmt: (v) => v.toFixed(1) + 's' },
			{ o: BOT, k: 'read', label: 'Reads a new board', min: 0, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) + 's' },
			{ o: BOT, k: 'misplay', label: 'Base misplays', min: 0, max: 0.6, step: 0.02, fmt: pct, bot: 'baseMisplay' },
			{ o: BOT, k: 'tiltPerMine', label: 'Tilt per live mine', min: 0, max: 0.15, step: 0.01, fmt: pct, bot: 'tiltPerMine' },
			{ o: BOT, k: 'tiltPerHeart', label: 'Tilt per lost heart', min: 0, max: 0.2, step: 0.01, fmt: pct, bot: 'tiltPerHeart' },
			{ o: BOT, k: 'defuseFirst', label: 'Defuses first', min: 0, max: 1, step: 0.05, fmt: pct, bot: 'defuseFirst' }
		]],
		['Match', [
			{ k: 'hearts', label: 'Hearts', min: 1, max: 6, step: 1 },
			{ k: 'gravitySecs', label: 'Gravity: a tick every', min: 0, max: 8, step: 0.5, fmt: (v) => (v ? `${v}s` : 'off'), then: regravity },
			{ k: 'comboTable', label: 'Combo', options: [[COMBO_ON, 'On: +1 at 2, +2 at 4, +3 at 6, +4 at 8'], [[], 'Off']] },
			{ k: 'freezeOver', label: 'Freezing over', options: [['loseBoard', 'Loses the board'], ['ko', 'Knocks you out']] },
			{ k: 'freezeOverAt', label: 'Freeze-over at', min: 2, max: 8, step: 1, fmt: (v) => `${v} ice` },
			{ k: 'bankFreezeEvery', label: 'Bank freezes every (moves)', min: 0, max: 20, step: 1, fmt: (v) => (v ? String(v) : 'off') },
			{ k: 'bankFreezeMin', label: 'Bank freezes at', min: 1, max: 16, step: 1, fmt: (v) => `${v}+ mines` },
			{ k: 'icebreakAtBoxesLeft', label: 'Icebreaker on last N boxes', min: 0, max: 6, step: 1, fmt: (v) => (v ? String(v) : 'any time') },
			{ k: 'healPerfectBoards', label: 'Heal after perfect boards', min: 0, max: 8, step: 1, fmt: (v) => (v ? `${v} in a row` : 'off') },
			{ k: 'maxHealsPerRound', label: 'Max heals per round', min: 0, max: 5, step: 1, fmt: (v) => (v ? String(v) : 'no limit') },
			{ k: 'healCheckpoint', label: 'Heal checkpoint', min: 0, max: 4, step: 1, fmt: (v) => (v ? `at ${v}` : 'off') },
			{ k: 'rushAfterSecs', label: 'Rush after', min: 0, max: 360, step: 30, fmt: (v) => (v ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}` : 'off') },
			{ k: 'rushMultiplier', label: 'Rush multiplier', min: 2, max: 20, step: 1, fmt: (v) => `×${v}` },
			{ k: 'clearGrace', label: 'Grace after a clear', min: 0, max: 3, step: 1, fmt: (v) => (v ? `${v} move${v > 1 ? 's' : ''}` : 'off') }
		]],
		['Frost and clutch', [
			{ k: 'frostMeter', label: 'Frost meter size', min: 0, max: 8, step: 1, fmt: (v) => (v ? `${v} pts = 1 ice` : 'off') },
			{ k: 'frostDeflects', label: 'Frost deflects incoming ice first', toggle: true },
			{ k: 'frostArmMoves', label: 'Full frost waits', min: 0, max: 1, step: 1, fmt: (v) => (v ? '1 move (armed)' : 'fires at once') },
			{ k: 'frostHoldAtBoxesLeft', label: 'Frost holds on last N boxes', min: 0, max: 8, step: 1, fmt: (v) => (v ? String(v) : 'never') },
			{ k: 'defuseTiers', label: 'Fresh defuse charges frost', toggle: true },
			{ k: 'icebreakReward', label: 'Late icebreak frost', min: 0, max: 4, step: 1, fmt: (v) => (v ? `+${v}` : 'off') },
			{ k: 'clutchCancels', label: 'Clutch cancels', min: 0, max: 3, step: 1, fmt: (v) => (v ? String(v) : 'nothing') },
			{ k: 'defuseClearBonus', label: 'Defuse clear bonus', min: 0, max: 3, step: 1, fmt: (v) => (v ? `+${v} per mine` : 'off') }
		]],
		['Mines', [
			{ k: 'clearSend', label: 'Clear sends', min: 1, max: 10, step: 1 },
			{ k: 'counterSpike', label: 'Counter', options: [[true, 'Counter-spike (clear cancels yours)'], ['refund', 'Refund (attack cancels, part comes back)'], [false, 'Plain net-cancel']] },
			{ k: 'counterRate', label: 'Counter adds back', min: 0, max: 1, step: 0.25, fmt: (v) => (v ? pct(v) : 'cancel only') },
			{ k: 'cancelOrder', label: 'Cancels first', options: [['redFirst', 'Red batch, then bank'], ['orangeFirst', 'Bank only']] },
			{ k: 'incomingEta', label: 'Moves until landing', min: 1, max: 6, step: 1 },
			{ k: 'batchSize', label: 'Batch size', min: 1, max: 6, step: 1 },
			{ k: 'mineCap', label: 'Max on board', min: 2, max: 10, step: 1 },
			{ k: 'mineFuse', label: 'Fuse (moves)', min: 2, max: 6, step: 1 },
			{ k: 'maxHeartsPerMove', label: 'Hearts lost per move, max', min: 1, max: 4, step: 1 },
			{ k: 'mineCluster', label: 'Mine landing', options: [[true, 'Clustered in the biggest open box'], [false, 'Scattered']] },
			{ k: 'spreadLanding', label: 'Spread across regions', toggle: true },
			{ k: 'clearWipesPool', label: 'Clear kills waiting mines', toggle: true },
			{ k: 'clearWipesIncoming', label: 'Clear kills in-flight mines', toggle: true }
		]],
		['Ice', [
			{ k: 'iceEta', label: 'Moves until landing', min: 1, max: 6, step: 1 },
			{ k: 'maxIceIncoming', label: 'Max ice on the way', min: 0, max: 4, step: 1, fmt: (v) => (v ? String(v) : 'no cap') },
			{ k: 'telegraphIce', label: 'Mark the landing cell', toggle: true },
			{ k: 'thawPoints', label: 'Thaw points', min: 2, max: 8, step: 1 },
			{ k: 'passiveThawEvery', label: 'Passive −1 every', min: 1, max: 6, step: 1, fmt: (v) => `${v} moves` },
			{ k: 'activeThaw', label: 'Adjacent thaw', min: 1, max: 4, step: 1 },
			{ k: 'perfectSendsIce', label: 'Perfect clear sends ice', min: 0, max: 3, step: 1 },
			{ k: 'icebreakSpills', label: 'Icebreak spills to next board', toggle: true }
		]]
	];
	function buildRules() {
		const root = $('groups');
		root.innerHTML = '';
		for (const [name, items] of GROUPS) {
			const fs = document.createElement('fieldset');
			const lg = document.createElement('legend');
			lg.textContent = name;
			fs.appendChild(lg);
			for (const it of items) {
				const o = it.o ?? RULES;
				const id = 'r-' + it.k;
				const row = document.createElement('div');
				const lab = document.createElement('label');
				lab.htmlFor = id;
				lab.textContent = it.label;
				row.appendChild(lab);
				if (it.toggle) {
					row.className = 'row toggle';
					const inp = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked: !!o[it.k] });
					inp.addEventListener('change', () => {
						o[it.k] = inp.checked;
						renderHud();
					});
					row.appendChild(inp);
				} else if (it.options) {
					row.className = 'row toggle';
					const sel = Object.assign(document.createElement('select'), { id });
					it.options.forEach(([, t], n) => sel.appendChild(Object.assign(document.createElement('option'), { value: String(n), textContent: t })));
					const cur = it.options.findIndex(([v]) => JSON.stringify(v) === JSON.stringify(o[it.k]));
					sel.value = String(Math.max(0, cur));
					sel.addEventListener('change', () => {
						o[it.k] = it.options[Number(sel.value)][0];
						renderHud();
					});
					row.appendChild(sel);
				} else {
					row.className = 'row';
					const inp = Object.assign(document.createElement('input'), { type: 'range', id, min: it.min, max: it.max, step: it.step });
					inp.value = o[it.k];
					const out = document.createElement('output');
					out.htmlFor = id;
					const fmt = it.fmt ?? String;
					out.textContent = fmt(Number(o[it.k]));
					inp.addEventListener('input', () => {
						const v = Number(inp.value);
						o[it.k] = v;
						if (it.bot && bot) bot[it.bot] = v;
						out.textContent = fmt(v);
						if (it.then) it.then();
						renderHud();
					});
					row.append(inp, out);
				}
				fs.appendChild(row);
			}
			root.appendChild(fs);
		}
	}

	const tag = (side, evs) => evs.map((e) => ({ side, ...e }));
	$('t-mines').addEventListener('click', () => handle(tag('you', match.sides[0].econ.receiveMines(4))));
	$('t-ice').addEventListener('click', () => handle(tag('you', match.sides[0].econ.receiveIce(2, match.sides[0].landable()))));
	$('t-bot').addEventListener('click', () => handle(tag('them', match.sides[1].econ.receiveMines(4))));
	for (const b of document.querySelectorAll('#modes button'))
		b.addEventListener('click', () => {
			mode = b.dataset.mode;
			for (const o of document.querySelectorAll('#modes button')) o.setAttribute('aria-pressed', String(o === b));
			for (const k of Object.keys(RULES)) delete RULES[k];
			Object.assign(RULES, modeRules());
			$('mode-title').textContent = mode === 'mines' ? 'Mines' : 'Versus';
			setView(view);
			buildRules();
			newMatch();
		});
	$('t-reset').addEventListener('click', () => {
		Object.assign(RULES, modeRules());
		buildRules();
		regravity();
		renderHud();
	});
	$('t-copy').addEventListener('click', () => copyText($('t-copy'), JSON.stringify({ rules: RULES, bot: BOT }, null, 2), 'Copy rules JSON'));

	window.vsLab = { get match() { return match; }, rules: RULES, bot: BOT, clock, handle, play, views };
	readColors();
	setWho();
	buildRules();
	newMatch();
	// Fonts arrive after first paint; redraw once so the clues use Shippori.
	if (document.fonts && document.fonts.ready) document.fonts.ready.then(kick);
})();
