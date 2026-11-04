// app.js — the VS tutorial. Each step builds a real match on the real screen (client/hud.js),
// sets up the Hazards it talks about, then waits for the engine event that shows the idea.
// The opponent never moves. Nothing is sent anywhere. Progress is kept in this browser only.
(() => {
	const $ = (id) => document.getElementById(id);
	const RULES = { ...VERSUS_RULES, gravitySecs: 0 }; // gravity only where a step turns it on
	let match = null;
	let at = 0; // step index
	let done = false;
	let gravTimer = 0;
	let again = null; // a step that re-prefills each new Board (the Combo step)

	const hud = createHud({
		side: (i) => (match ? match.sides[i] : null),
		rules: () => RULES,
		onMove: (a) => move(a),
		canInput: () => !!match && !match.roundOver
	});
	hud.setView('play');
	const screenOf = (e) => (e.side === 'you' ? 0 : e.side === 'them' ? 1 : -1);

	// —— Board helpers the steps use ——
	const me = () => match.sides[0];
	const key = (r) => [r.x1, r.y1, r.x2, r.y2].join();
	const cellsOf = (r, N) => {
		const out = [];
		for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) out.push(y * N + x);
		return out;
	};
	const area = (r) => (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
	const unplaced = () => {
		const s = me();
		const placed = new Set(s.rects.map(key));
		return s.puzzle.layout.filter((r) => !placed.has(key(r)));
	};
	const isGiven = (cell) => {
		const s = me();
		return !!s.puzzle.nums[Math.floor(cell / s.N)][cell % s.N];
	};
	const taken = () => new Set([...me().econ.mines.map((m) => m.cell), ...me().econ.ice.map((f) => f.cell)]);
	const openCellsIn = (rects) => {
		const s = me();
		const busy = taken();
		return rects.flatMap((r) => cellsOf(r, s.N)).filter((c) => !isGiven(c) && !busy.has(c));
	};
	function placeAllBut(leave) {
		const s = me();
		const keep = new Set(leave.map(key));
		s.rects = s.puzzle.layout.filter((r) => !keep.has(key(r))).map((r) => Object.assign(new Rect(r.x1, r.y1, r.x2, r.y2), { valid: true }));
	}
	// Leave the larger Givens open: they have room for Mines and Frozen Cells.
	function pickLeave(n, biggest) {
		const lay = [...me().puzzle.layout].sort((a, b) => area(b) - area(a));
		return biggest ? lay.slice(0, n) : lay.filter((r) => area(r) >= 2).slice(0, n);
	}
	const t = {
		side: me,
		fresh() {},
		prefill({ leave, biggest = false, again: re = false }) {
			placeAllBut(pickLeave(leave, biggest));
			again = re ? { leave, biggest } : null;
		},
		queue(n) {
			me().econ.pool = n;
		},
		bank(n, eta) {
			me().econ.incoming.push({ count: n, eta });
		},
		mine({ fuse, count = 1, nearTiles = false }) {
			let cells = openCellsIn(unplaced());
			if (nearTiles) {
				const s = me();
				const placedCells = new Set(s.rects.flatMap((r) => cellsOf(r, s.N)));
				const near = (c) => [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => placedCells.has(c + dy * s.N + dx)));
				cells = cells.filter(near).concat(cells.filter((c) => !near(c)));
			}
			for (const cell of cells.slice(0, count)) me().econ.mines.push({ cell, fuse });
		},
		ice({ count = 1, inUnplaced = false } = {}) {
			const e = me().econ;
			const cells = inUnplaced ? openCellsIn(unplaced().slice(0, 1)) : openCellsIn(unplaced());
			for (const cell of cells.slice(0, count)) e.ice.push({ cell, thaw: RULES.thawPoints, seq: e._seq++, landedTick: e.ticks });
		},
		incomingIce(n, eta = 2) {
			for (let k = 0; k < n; k++) me().econ.iceIncoming.push({ eta, target: -1 });
		},
		frost(points, { armed = 0 } = {}) {
			me().econ.frost = points;
			me().econ.armed = armed;
		},
		gravity(on) {
			RULES.gravitySecs = on ? 3 : 0;
		},
		// A Frozen Cell with two different open Tiles beside it, so two placements break it.
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
					placeAllBut([r0, lay[others[0]], lay[others[1]]]);
					s.econ.ice.push({ cell: x, thaw: RULES.thawPoints, seq: s.econ._seq++, landedTick: s.econ.ticks });
					return;
				}
			}
			t.prefill({ leave: 4 });
			t.ice({ count: 1 });
		},
		// Two Givens left; one is blocked by a Frozen Cell. Placing the other leaves 1 Given and 1 Frozen Cell.
		icebreakSetup() {
			const leave = pickLeave(2);
			placeAllBut(leave);
			const cell = openCellsIn([leave[0]])[0];
			const e = me().econ;
			e.ice.push({ cell, thaw: RULES.thawPoints, seq: e._seq++, landedTick: e.ticks });
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
		hud.animate(events, screenOf);
		hud.render();
		const step = STEPS[at];
		if (!done && step.done && events.some((e) => step.done(e, t))) {
			done = true;
			showStep();
		}
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

	// —— Steps ——
	function startStep(i) {
		at = Math.max(0, Math.min(STEPS.length - 1, i));
		done = false;
		again = null;
		RULES.gravitySecs = 0;
		clearTimeout(gravTimer);
		const now = Date.now();
		match = new VersusMatch({ rules: RULES, seed: 4100 + at * 7, target: 7 });
		match.startClock(now);
		match.freezeSide(1, now); // the opponent never moves
		hud.reset();
		const step = STEPS[at];
		if (step.setup) step.setup(t);
		if (!step.done) done = true;
		hud.render();
		showStep();
		scheduleGravity();
		try {
			localStorage.setItem('vs.tutorial', String(at));
		} catch {}
	}
	function showStep() {
		const step = STEPS[at];
		const inCh = STEPS.filter((s) => s.ch === step.ch);
		$('t-chapter').textContent = `${CHAPTERS[step.ch]} · ${inCh.indexOf(step) + 1} of ${inCh.length}`;
		$('t-title').textContent = step.title;
		$('t-text').textContent = step.text;
		const math = $('t-math');
		math.hidden = !step.math;
		if (step.math) {
			math.innerHTML = '';
			step.math.forEach((row, n) => {
				const tr = document.createElement('tr');
				for (const cell of row) tr.appendChild(Object.assign(document.createElement(n ? 'td' : 'th'), { textContent: cell }));
				math.appendChild(tr);
			});
		}
		$('t-after').hidden = !done || !step.after;
		$('t-after').textContent = step.after || '';
		$('t-next').disabled = !done;
		$('t-next').textContent = at === STEPS.length - 1 ? 'Start over' : 'Next';
		$('t-back').disabled = at === 0;
		for (const b of document.querySelectorAll('#t-chapters button')) b.setAttribute('aria-pressed', String(Number(b.dataset.ch) === step.ch));
	}
	$('t-next').addEventListener('click', () => startStep(at === STEPS.length - 1 ? 0 : at + 1));
	$('t-back').addEventListener('click', () => startStep(at - 1));
	$('t-retry').addEventListener('click', () => startStep(at));
	CHAPTERS.forEach((name, ch) => {
		const b = Object.assign(document.createElement('button'), { type: 'button', textContent: name });
		b.dataset.ch = ch;
		b.addEventListener('click', () => startStep(STEPS.findIndex((s) => s.ch === ch)));
		$('t-chapters').appendChild(b);
	});

	let resume = 0;
	try {
		resume = Number(localStorage.getItem('vs.tutorial')) || 0;
	} catch {}
	startStep(resume < STEPS.length ? resume : 0);
	window.vsTutorial = { get match() { return match; }, go: startStep, steps: STEPS };
	window.__mv = move; // test hook: the same path a drag takes
})();
