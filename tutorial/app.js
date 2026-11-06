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

	// —— Moves ——
	function move(a) {
		if (!match || match.roundOver) return;
		const now = Date.now();
		const events = match.catchUp(now);
		const r = match.act(0, a, now);
		events.push(...r.events);
		if (r.moved) {
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

	// —— Steps: the line under the Board ——
	function startStep(i) {
		clearTimeout(nextTimer);
		at = i;
		done = false;
		const step = STEPS[at];
		RULES.gravitySecs = 0; // a step that wants gravity turns it on in its setup
		if (step.board && step.board !== 'keep') freshBoard(step.board);
		else again = null;
		if (step.setup) step.setup(t);
		hud.render();
		show();
		scheduleGravity();
		if (step.done || step.end) bar(0);
		else {
			// A line to read: it moves on by itself, after enough time to read it.
			const ms = Math.min(9000, 1800 + step.text.length * 45);
			bar(ms);
			nextTimer = setTimeout(() => startStep(at + 1), ms);
		}
	}
	function finish() {
		done = true;
		show();
		bar(AFTER_MS);
		nextTimer = setTimeout(() => startStep(at + 1), AFTER_MS);
	}
	function show() {
		const step = STEPS[at];
		$('c-text').textContent = step.text;
		$('c-after').textContent = done && step.after ? step.after : '';
		$('c-after').hidden = !(done && step.after);
		$('c-count').textContent = `${at + 1} / ${STEPS.length}`;
		$('c-end').hidden = !step.end;
		$('c-skip').hidden = !!step.end;
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
	$('c-again').addEventListener('click', () => begin());
	$('c-skip').addEventListener('click', () => at + 1 < STEPS.length && startStep(at + 1));

	function begin() {
		const now = Date.now();
		match = new VersusMatch({ rules: RULES, seed: 4242, target: 7 });
		match.startClock(now);
		match.freezeSide(1, now); // the opponent never moves
		RULES.gravitySecs = 0;
		hud.reset();
		startStep(0);
	}
	begin();
	window.vsTutorial = { get match() { return match; }, go: startStep, steps: STEPS, get at() { return at; } };
	window.__mv = move; // test hook: the same path a drag takes
})();
