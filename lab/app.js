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

	// The screen itself (boards, lane, poles, hearts, views) is client/hud.js, shared with the playtest.
	const hud = createHud({
		side: (i) => (match ? match.sides[i] : null),
		rules: () => RULES,
		onMove: (a) => youMove(a),
		canInput: () => !watching && !!match && !match.roundOver && !paused
	});
	const { views, kick } = hud;



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
			hud.deny(action, r.denied);
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

	const seatScreen = (e) => (e.side === 'you' ? 0 : e.side === 'them' ? 1 : -1);
	function handle(events) {
		let roundEnd = null;
		for (const e of events || []) {
			const si = seatScreen(e);
			if (e.kind !== 'gravity' && e.kind !== 'thawPulse') roundLog.push({ t: Math.round(clock() - (match.roundStartAt ?? 0)), move: si >= 0 ? moveNo[si] : null, ...e });
			if (e.kind === 'roundOver') roundEnd = e;
			const text = describe(e);
			if (text) logItems.unshift({ side: e.side, text });
		}
		logItems.length = Math.min(logItems.length, 150);
		hud.animate(events, seatScreen);
		renderLog();
		renderHud();
		if (roundEnd) showRoundOver(roundEnd);
		else scheduleGravity();
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

	function renderHud() {
		if (!match) return;
		$('score-you').textContent = match.score[0];
		$('score-them').textContent = match.score[1];
		hud.render();
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
		hud.reset();
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
		hud.setView(v, mode === 'mines');
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
	setWho();
	buildRules();
	newMatch();
})();
