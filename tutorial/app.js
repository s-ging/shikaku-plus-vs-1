// app.js — the VS tutorial: one match, one Board at a time, played start to finish.
// A director sets up each step on the Board you are playing (a Mine drops in, a Frozen Cell
// lands, your Frost fills), the line under the Board says what to do, and the next step comes
// by itself once you have done it. The opponent never moves; you can't lose the round.
(() => {
	const $ = (id) => document.getElementById(id);
	const RULES = { ...VERSUS_RULES, gravitySecs: 0 }; // gravity only in its own step
	const AFTER_MS = 1800; // how long the result line stays before the next step
	let match = null;
	let at = 0;
	let done = false;
	let again = null; // a step that re-fills each new Board (the Combo step)
	let gravTimer = 0;
	let nextTimer = 0;
	let lesson = 0;
	let STEPS = LESSONS[0].steps;
	let between = false; // the end of a lesson: the Board rests, the line offers what is next

	const hud = createHud({
		side: (i) => (match ? match.sides[i] : null),
		rules: () => RULES,
		onMove: (a) => move(a),
		canInput: () => !!match && !match.roundOver
	});
	hud.setView('play');
	const screenOf = (e) => (e.side === 'you' ? 0 : e.side === 'them' ? 1 : -1);

	// —— Board helpers ——
	const me = () => match.sides[0];
	const key = (r) => [r.x1, r.y1, r.x2, r.y2].join();
	const cellsOf = (r, N) => {
		const out = [];
		for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) out.push(y * N + x);
		return out;
	};
	const area = (r) => (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
	const unplaced = () => {
		const placed = new Set(me().rects.map(key));
		return me().puzzle.layout.filter((r) => !placed.has(key(r)));
	};
	const isGiven = (cell) => !!me().puzzle.nums[Math.floor(cell / me().N)][cell % me().N];
	const taken = () => new Set([...me().econ.mines.map((m) => m.cell), ...me().econ.ice.map((f) => f.cell)]);
	const openCellsIn = (rects) => {
		const busy = taken();
		return rects.flatMap((r) => cellsOf(r, me().N)).filter((c) => !isGiven(c) && !busy.has(c));
	};
	/** Fill every Given except `leave`, and drop any Hazard the new Tiles would sit on. */
	function placeAllBut(leave) {
		const s = me();
		const keep = new Set(leave.map(key));
		s.rects = s.puzzle.layout.filter((r) => !keep.has(key(r))).map((r) => Object.assign(new Rect(r.x1, r.y1, r.x2, r.y2), { valid: true }));
		const filled = new Set(s.rects.flatMap((r) => cellsOf(r, s.N)));
		s.econ.mines = s.econ.mines.filter((m) => !filled.has(m.cell));
		s.econ.ice = s.econ.ice.filter((f) => !filled.has(f.cell));
	}
	// The larger Givens stay open: they have room for Mines and Frozen Cells.
	function pickLeave(n, biggest) {
		const lay = [...me().puzzle.layout].sort((a, b) => area(b) - area(a));
		return biggest ? lay.slice(0, n) : lay.filter((r) => area(r) >= 2).slice(0, Math.min(n, lay.length));
	}
	/** The next Board, nothing on it, with all but `leave` Givens filled. */
	function freshBoard({ leave, biggest = false, again: re = false }) {
		const s = me();
		const e = s.econ;
		s.boardIndex++;
		s.deal(cachedBoard(match.roundSeed, s.boardIndex));
		Object.assign(e, { mines: [], ice: [], iceIncoming: [], incoming: [], pool: 0, doOversThisBoard: 0, graceLeft: 0, armed: 0 });
		if (leave < s.puzzle.layout.length) placeAllBut(pickLeave(leave, biggest));
		again = re ? { leave, biggest } : null;
		hud.reset();
	}
	const t = {
		side: me,
		queue(n) {
			me().econ.pool = n;
			me().econ.graceLeft = 0; // the tutorial's Mines land when it says they will
		},
		bank(n, eta) {
			me().econ.incoming.push({ count: n, eta });
			me().econ.graceLeft = 0;
		},
		mine({ fuse, count = 1, nearTiles = false }) {
			let cells = openCellsIn(unplaced());
			if (nearTiles) {
				const N = me().N;
				const placedCells = new Set(me().rects.flatMap((r) => cellsOf(r, N)));
				const near = (c) => [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => placedCells.has(c + dy * N + dx)));
				cells = cells.filter(near).concat(cells.filter((c) => !near(c)));
			}
			for (const cell of cells.slice(0, count)) me().econ.mines.push({ cell, fuse });
		},
		ice({ count = 1 } = {}) {
			const e = me().econ;
			for (const cell of openCellsIn(unplaced()).slice(0, count)) e.ice.push({ cell, thaw: RULES.thawPoints, seq: e._seq++, landedTick: e.ticks });
		},
		incomingIce(n, eta = 2) {
			for (let k = 0; k < n; k++) me().econ.iceIncoming.push({ eta, target: -1 });
			me().econ.graceLeft = 0;
		},
		frost(points, { armed = 0 } = {}) {
			me().econ.frost = points;
			me().econ.armed = armed;
		},
		combo(n) {
			me().econ.combo = n;
		},
		gravity(on) {
			RULES.gravitySecs = on ? 3 : 0;
			if (on) me().gAt = Date.now();
		},
		// A Frozen Cell with two open Tiles beside it, so two placements break it.
		thawSetup() {
			const s = me();
			const N = s.N;
			const lay = s.puzzle.layout;
			const owner = new Map();
			lay.forEach((r, i) => cellsOf(r, N).forEach((c) => owner.set(c, i)));
			for (const r0 of [...lay].sort((a, b) => area(b) - area(a))) {
				for (const x of cellsOf(r0, N)) {
					if (isGiven(x)) continue;
					const nb = [x - N, x + N, x % N ? x - 1 : -1, x % N < N - 1 ? x + 1 : -1].filter((c) => c >= 0 && c < N * N);
					const others = [...new Set(nb.map((c) => owner.get(c)).filter((i) => lay[i] !== r0))];
					if (others.length < 2) continue;
					placeAllBut([r0, lay[others[0]], lay[others[1]], ...pickLeave(7).filter((r) => r !== r0 && r !== lay[others[0]] && r !== lay[others[1]]).slice(0, 2)]);
					s.econ.ice = [{ cell: x, thaw: RULES.thawPoints, seq: s.econ._seq++, landedTick: s.econ.ticks }];
					return;
				}
			}
			t.ice();
		},
		// Down to the last 2 Givens; one is blocked by a Frozen Cell.
		icebreakSetup() {
			const leave = pickLeave(2);
			placeAllBut(leave);
			const e = me().econ;
			e.mines = [];
			e.ice = [{ cell: openCellsIn([leave[0]])[0], thaw: RULES.thawPoints, seq: e._seq++, landedTick: e.ticks }];
			e.iceIncoming = [];
		}
	};


	// —— The spotlight: everything is dimmed but the one move this step takes, and what the
	// line under the Board talks about. The Board takes only that move. ——
	let target = null; // { place: rect } | { erase: rect } | null (no move: just watch or read)
	let lastPlaced = null;
	function aim() {
		const step = STEPS[at];
		target = null;
		if (!match || done || between || !step.move || step.move === 'free') return;
		const s = me();
		const N = s.N;
		const mineAt = new Set(s.econ.mines.map((m) => m.cell));
		const iceAt = new Set(s.econ.ice.map((f) => f.cell));
		const hasMine = (r) => cellsOf(r, N).some((c) => mineAt.has(c));
		const nextToIce = (r) => cellsOf(r, N).some((c) => [c - N, c + N, c % N ? c - 1 : -1, c % N < N - 1 ? c + 1 : -1].some((n) => iceAt.has(n)));
		if (step.move === 'erase') {
			const r = s.rects.find((r) => lastPlaced && key(r) === key(lastPlaced)) || s.rects.find((r) => !hasMine(r));
			if (r) target = { erase: r };
			return;
		}
		// Open Givens a Tile can go on now, smallest first (a 1-Cell Tile is a tap, so last).
		const free = unplaced()
			.filter((r) => !cellsOf(r, N).some((c) => iceAt.has(c)))
			.sort((a, b) => (area(a) < 2) - (area(b) < 2) || area(a) - area(b));
		const pickers = {
			pick: () => free.find((r) => !hasMine(r)) || free[0],
			avoid: () => free.find((r) => !hasMine(r)),
			mine: () => free.find(hasMine),
			ice: () => free.find(nextToIce)
		};
		if (step.move === 'wrong') {
			// One Cell too many: the smallest open Given, stretched by one Cell.
			const r = free.find((r) => area(r) >= 2) || free[0];
			if (!r) return;
			const grow = [{ ...r, x2: r.x2 + 1 }, { ...r, x1: r.x1 - 1 }, { ...r, y2: r.y2 + 1 }, { ...r, y1: r.y1 - 1 }];
			const w = grow.find((g) => g.x1 >= 0 && g.y1 >= 0 && g.x2 < N && g.y2 < N && !cellsOf(g, N).some((c) => iceAt.has(c)));
			if (w) target = { place: w };
			return;
		}
		const r = (pickers[step.move] || pickers.pick)();
		if (r) target = { place: r };
		else {
			// Nothing fits (the Board ran out of room): a Do-Over still runs the Tick.
			const e = s.rects.find((r) => !hasMine(r));
			if (e) target = { erase: e };
		}
	}
	const allowed = (a) => {
		if (between || done) return false;
		if (STEPS[at].move === 'free') return true;
		if (!target) return false;
		if (target.erase) return a.type === 'erase' && cellsOf(target.erase, me().N).includes(a.y * me().N + a.x);
		const r = target.place;
		const [x1, x2] = [Math.min(a.ax, a.bx), Math.max(a.ax, a.bx)];
		const [y1, y2] = [Math.min(a.ay, a.by), Math.max(a.ay, a.by)];
		return a.type === 'place' ? key({ x1, y1, x2, y2 }) === key(r) : area(r) === 1 && a.x === r.x1 && a.y === r.y1;
	};

	const SVG = 'http://www.w3.org/2000/svg';
	const veil = document.createElementNS(SVG, 'svg');
	veil.setAttribute('class', 'veil');
	veil.setAttribute('aria-hidden', 'true');
	// A mask, not one path with holes: lit areas that overlap (a Mine inside the lit Tile)
	// must stay lit, and an even-odd path would dim the overlap again.
	veil.innerHTML = '<defs><mask id="veil-mask" maskUnits="userSpaceOnUse"><rect x="0" y="0" width="100%" height="100%" fill="#fff"/><path fill="#000"/></mask></defs><rect class="shade" x="0" y="0" width="100%" height="100%" mask="url(#veil-mask)"/><path class="ring"/>';
	const holes = veil.querySelector('mask path');
	const shade = veil.querySelector('.shade');
	const ring = veil.querySelector('.ring');
	document.body.append(veil);
	const box = (x, y, w, h, r = 6) => {
		r = Math.min(r, w / 2, h / 2);
		return `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${2 * r - w}a${r},${r} 0 0 1 ${-r},${-r}v${2 * r - h}a${r},${r} 0 0 1 ${r},${-r}z`;
	};
	const ofEl = (el, pad = 4) => {
		const b = el && el.getBoundingClientRect();
		return b && b.width ? [b.left - pad, b.top - pad, b.width + 2 * pad, b.height + 2 * pad] : null;
	};
	function ofCells(r) {
		const b = $('you-board').getBoundingClientRect();
		const k = b.width / me().N;
		return [b.left + r.x1 * k, b.top + r.y1 * k, (r.x2 - r.x1 + 1) * k, (r.y2 - r.y1 + 1) * k];
	}
	const cellBox = (c) => ofCells({ x1: c % me().N, y1: Math.floor(c / me().N), x2: c % me().N, y2: Math.floor(c / me().N) });
	let veilQueued = false;
	function drawVeil() {
		if (veilQueued) return;
		veilQueued = true;
		requestAnimationFrame(() => {
			veilQueued = false;
			if (!match) return;
			const step = STEPS[at];
			const off = step.move === 'free' && !done && !between;
			shade.style.display = off ? 'none' : '';
			if (off) return ring.setAttribute('d', '');
			const lit = [ofEl(document.querySelector('.coach'), 8)];
			const show = between ? [] : step.show || [];
			const el = { hazards: 'you-hazards', ice: 'you-ice', combo: 'you-combo', hearts: 'you-hearts', board: 'you-board' };
			for (const k of show) if (el[k]) lit.push(ofEl($(el[k])));
			if (show.includes('mines')) for (const m of me().econ.mines) lit.push(cellBox(m.cell));
			if (show.includes('frozen')) for (const f of me().econ.ice) lit.push(cellBox(f.cell));
			const t = target && ofCells(target.place || target.erase);
			if (t) lit.push(t);
			const W = innerWidth;
			const H = innerHeight;
			veil.setAttribute('viewBox', `0 0 ${W} ${H}`);
			holes.setAttribute('d', lit.filter(Boolean).map((b) => box(...b)).join(''));
			ring.setAttribute('d', t ? box(...t) : '');
		});
	}
	addEventListener('resize', drawVeil);
	addEventListener('scroll', drawVeil, { passive: true });
	new ResizeObserver(drawVeil).observe(document.body);

	// —— Moves ——
	function move(a) {
		if (!match || match.roundOver) return;
		if (!allowed(a)) return drawVeil(); // only the lit move counts
		const now = Date.now();
		const events = match.catchUp(now);
		const r = match.act(0, a, now);
		events.push(...r.events);
		if (r.moved) {
			if (a.type === 'place') lastPlaced = r.placed || { x1: Math.min(a.ax, a.bx), y1: Math.min(a.ay, a.by), x2: Math.max(a.ax, a.bx), y2: Math.max(a.ay, a.by) };
			events.push({ kind: a.type === 'place' ? 'placed' : 'erased' });
			if (again && events.some((e) => e.side === 'you' && e.kind === 'newBoard')) placeAllBut(pickLeave(again.leave, again.biggest));
			events.push({ kind: 'settled' });
		} else if (r.denied) {
			hud.deny(a, r.denied);
			events.push({ kind: 'denied', why: r.denied });
		}
		handle(events);
	}
	function handle(events) {
		const s = me();
		if (s.econ.hearts < 1) s.econ.hearts = 1; // the tutorial never ends the round
		hud.animate(events, screenOf);
		hud.render();
		const step = STEPS[at];
		if (!done && step.done && events.some((e) => step.done(e, t))) finish();
		aim();
		drawVeil();
		scheduleGravity();
	}
	function scheduleGravity() {
		clearTimeout(gravTimer);
		const step = (RULES.gravitySecs || 0) * 1000;
		if (!step || !match || match.roundOver) return;
		const s = me();
		if (s.gAt == null) return;
		gravTimer = setTimeout(() => handle(match.catchUp(Date.now())), Math.max(0, s.gAt + step - Date.now()) + 5);
	}

	// —— Steps: the two lines under the Board ——
	function startStep(i) {
		clearTimeout(nextTimer);
		if (i >= STEPS.length) return endLesson();
		at = i;
		done = false;
		between = false;
		const step = STEPS[at];
		RULES.gravitySecs = 0; // a step that wants gravity turns it on in its setup
		if (step.board && step.board !== 'keep') freshBoard(step.board);
		else again = null;
		if (step.setup) step.setup(t);
		hud.render();
		show();
		aim();
		drawVeil();
		scheduleGravity();
		if (step.done) bar(0);
		else {
			// A line to read: it moves on by itself, after enough time to read it.
			const ms = Math.min(9000, 1800 + ((step.info || '') + step.say).length * 45);
			bar(ms);
			nextTimer = setTimeout(() => startStep(at + 1), ms);
		}
	}
	function finish() {
		done = true;
		target = null;
		drawVeil();
		show();
		bar(AFTER_MS);
		nextTimer = setTimeout(() => startStep(at + 1), AFTER_MS);
	}
	function show() {
		const step = STEPS[at];
		const info = between ? '' : step.info || '';
		$('c-info').textContent = info;
		$('c-info').hidden = !info;
		const after = done && step.after;
		$('c-say').textContent = between ? (lesson === LESSONS.length - 1 ? 'That is Shikaku+ VS.' : `${LESSONS[lesson].name}: done.`) : after || step.say;
		$('c-say').classList.toggle('after', !!after && !between);
		$('c-count').textContent = between ? '' : `${LESSONS[lesson].name} · ${at + 1} / ${STEPS.length}`;
		$('c-skip').hidden = between;
		$('c-end').hidden = !between;
	}
	// The end of a lesson: the next lesson first, then the others.
	function endLesson() {
		between = true;
		target = null;
		bar(0);
		const end = $('c-end');
		end.replaceChildren();
		const order = [lesson + 1, ...LESSONS.keys()].filter((l, k, all) => l < LESSONS.length && all.indexOf(l) === k);
		for (const l of order) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = l === lesson + 1 ? 'btn primary' : 'btn';
			b.textContent = l === lesson ? `${LESSONS[l].name} again` : l === lesson + 1 ? `Next: ${LESSONS[l].name}` : LESSONS[l].name;
			b.addEventListener('click', () => begin(l));
			end.append(b);
		}
		show();
		drawVeil();
	}
	// A thin line that runs out while the tutorial waits on its own (reading, or the result).
	function bar(ms) {
		const el = $('c-bar');
		el.style.transition = 'none';
		el.style.transform = 'scaleX(0)';
		if (!ms) return; // waiting on you: the line stays empty
		void el.offsetWidth;
		el.style.transition = `transform ${ms}ms linear`;
		el.style.transform = 'scaleX(1)';
	}
	$('c-skip').addEventListener('click', () => startStep(at + 1));

	// Every lesson is its own match: full Hearts, no Combo, a new Board.
	function begin(l = 0) {
		const now = Date.now();
		lesson = l;
		STEPS = LESSONS[l].steps;
		match = new VersusMatch({ rules: RULES, seed: 4242 + l * 101, target: 7 });
		match.startClock(now);
		match.freezeSide(1, now); // the opponent never moves
		RULES.gravitySecs = 0;
		hud.reset();
		startStep(0);
	}
	begin();
	window.vsTutorial = { get match() { return match; }, go: startStep, begin, lessons: LESSONS, get lesson() { return lesson; }, get steps() { return STEPS; }, get at() { return at; }, get between() { return between; }, get target() { return target; } };
	window.__mv = move; // test hook: the same path a drag takes
})();
