// ui.js — the playtest client: home, lobby, match, practice. No framework.
// The game screen is client/hud.js, the same one the lab uses; this file feeds it the
// two boards (mine predicted, theirs confirmed) and handles the network.
// Rendering is on demand: a frame is drawn when something changes, never on a loop.
(() => {
	const $ = (id) => document.getElementById(id);
	const show = (id) => {
		['home', 'lobby', 'game', 'practice-page'].forEach((s) => ($(s).hidden = s !== id));
		if (id !== 'game') {
			try {
				sound.rest(); // off the game screen: suspend once the last sound ends
			} catch {} // show() can run before sound exists
		}
		$('brand').hidden = id === 'game';
	};
	const store = {
		get: (k) => {
			try {
				return localStorage.getItem(k);
			} catch {
				return null;
			}
		},
		set: (k, v) => {
			try {
				localStorage.setItem(k, v);
			} catch {
				/* private mode */
			}
		}
	};
	const rid = () => {
		let s = '';
		const a = 'abcdefghijkmnpqrstuvwxyz23456789';
		for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
		return s;
	};
	const myId = store.get('vs.id') || (store.set('vs.id', rid()), store.get('vs.id') || rid());
	const myName = () => ($('name').value || store.get('vs.name') || 'Player').slice(0, 16);

	// —— Sound: the base pack is inlined by build.mjs (SOUND_PACK); see client/sound.js ——
	const sound = createSound(typeof SOUND_PACK !== 'undefined' ? SOUND_PACK : null);
	let streakCount = 0; // placements in a row with no Do-Over
	let rushCued = null; // the round whose Rush sound has played
	let endCued = null; // the round whose won / lost sound has played
	function showSoundToggles() {
		const sb = $('sound-toggle');
		sb.textContent = `Sound: ${sound.level}`; // full, minimal or off
		sb.setAttribute('aria-pressed', String(sound.soundOn));
		sb.title = sound.level === 'minimal' ? 'Gameplay sounds only: no tile placing, no per-turn sounds' : sound.level === 'full' ? 'Every sound' : 'No sound';
		const vb = $('vibe-toggle');
		vb.hidden = !sound.canVibrate; // iPhone web pages can't vibrate
		vb.textContent = sound.vibrateOn ? 'Vibration: on' : 'Vibration: off';
		vb.setAttribute('aria-pressed', String(sound.vibrateOn));
	}
	$('sound-toggle').addEventListener('click', () => {
		const L = sound.LEVELS; // full → minimal → off → full
		sound.setLevel(L[(L.indexOf(sound.level) + 1) % L.length]);
		showSoundToggles();
	});
	$('vibe-toggle').addEventListener('click', () => {
		sound.setVibrate(!sound.vibrateOn);
		showSoundToggles();
	});
	showSoundToggles();

	function device() {
		const n = navigator;
		const c = n.connection || {};
		return { ua: n.userAgent.slice(0, 200), w: screen.width, h: screen.height, dpr: window.devicePixelRatio || 1, mem: n.deviceMemory || null, cores: n.hardwareConcurrency || null, net: c.effectiveType || null, touch: 'ontouchstart' in window };
	}

	// —— Views ——
	let mode = null; // 'online' | 'practice'
	let core = null; // ClientCore (online) or a practice adapter with the same shape
	let room = null; // last 'room' message
	let rules = VERSUS_RULES;
	let gravTimer = 0;
	let held = null; // server messages waiting behind a round result
	let lastRoundSeen = null;

	function sides() {
		if (!core || !core.predicted) return null;
		const me = core.me;
		return { me, you: core.predicted.sides[me], them: core.confirmed.sides[1 - me], match: core.confirmed, pmatch: core.predicted };
	}

	// The shared screen. Screen 0 is my board (predicted, so my moves show at once); screen 1 is theirs.
	const hud = createHud({
		side: (i) => {
			const v = sides();
			return v ? (i === 0 ? v.you : v.them) : null;
		},
		rules: () => rules,
		onMove: (a) => onMove(a),
		canInput: () => mode !== 'replay' && !!core && !!core.predicted && !core.predicted.roundOver,
		onHover: (r) => sendHover(r)
	});
	let view = 'play';
	let shownRound = null;
	const setView = (v) => {
		view = v;
		hud.setView(v, rules.mode === 'mines');
		for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
		showGhost();
	};

	// —— Hovers: my drag goes to the other player as it moves; theirs shows as a faint Tile ——
	// Sent only when the drag reaches a new Cell, at most every 50ms (the last one always goes).
	let hoverOut = { last: 0, timer: 0, r: undefined, sent: undefined };
	function sendHover(r) {
		if (mode !== 'online') return;
		hoverOut.r = r ? [r.x1, r.y1, r.x2, r.y2] : null;
		const go = () => {
			hoverOut.timer = 0;
			if (JSON.stringify(hoverOut.r) === JSON.stringify(hoverOut.sent)) return;
			hoverOut.sent = hoverOut.r;
			hoverOut.last = performance.now();
			net.send(hoverOut.r ? { t: 'hv', r: hoverOut.r } : { t: 'hv' });
		};
		const wait = 50 - (performance.now() - hoverOut.last);
		if (wait <= 0 || hoverOut.r === null) {
			clearTimeout(hoverOut.timer);
			go();
		} else if (!hoverOut.timer) hoverOut.timer = setTimeout(go, wait);
	}
	// Always on side by side; in play view the player can turn it off (remembered in this browser).
	let ghostPref = true;
	try {
		ghostPref = localStorage.getItem('vs.ghost') !== 'off';
	} catch {}
	let theirHover = null;
	function showGhost() {
		const on = view === 'spec' || ghostPref;
		hud.setGhost(1, on && theirHover ? { x1: theirHover[0], y1: theirHover[1], x2: theirHover[2], y2: theirHover[3] } : null);
		const b = $('ghost-toggle');
		if (b) {
			b.hidden = view === 'spec' || mode === 'replay';
			b.textContent = ghostPref ? 'Their hovers: on' : 'Their hovers: off';
			b.setAttribute('aria-pressed', String(ghostPref));
		}
	}
	$('ghost-toggle').addEventListener('click', () => {
		ghostPref = !ghostPref;
		try {
			localStorage.setItem('vs.ghost', ghostPref ? 'on' : 'off');
		} catch {}
		showGhost();
	});
	for (const b of document.querySelectorAll('#views button')) b.addEventListener('click', () => setView(b.dataset.view));
	const serverNow = () => (core && core.serverNow ? core.serverNow() : Date.now());

	function render() {
		const v = sides();
		if (!v) return;
		const m = v.match;
		const mines = rules.mode === 'mines';
		if ($('stage').classList.contains('mines') !== mines) setView(view);
		if (shownRound !== m.round + ':' + m.seed) {
			shownRound = m.round + ':' + m.seed; // a new round or match: clear the lanes and flashes
			theirHover = null;
			hud.reset();
		}
		hud.render();
		$('score-you').textContent = m.score[v.me];
		$('score-them').textContent = m.score[1 - v.me];
		$('mode-title').textContent = mines ? 'Mines' : 'Versus';
		const rx = m.rushFactor;
		const fo = mode === 'online' && room ? room.o : mode === 'practice' ? { ...practice.o, mode: practice.mode } : null;
		$('mode-line').textContent = `${fo ? formatName(fo) : mines ? 'Mines · Unrated' : 'S+VS'} · FT${m.target}${rx > 1 ? ` · Rush ×${rx}` : ''}`;
		$('brand').hidden = true;
		let you = 'You';
		let them = 'Them';
		if (mode === 'online' && room) {
			const opp = room.seats[1 - v.me];
			them = opp ? opp.name : 'Waiting';
		} else if (mode === 'practice' && practice.preset) them = `${practice.preset.label} bot`;
		else if (mode === 'replay' && rp.data) [you, them] = rp.data.header.names.map((n) => n || 'Player');
		$('name-you').textContent = you;
		$('you-name').textContent = you;
		$('name-them').textContent = them;
		$('them-name').textContent = them;
		renderTime();
		roundOverlay(m, v.me);
		updateCount();
		scheduleGravity();
	}

	// The 3-2-1 before a round: digits replace each other; nothing else moves.
	let countTimer = 0;
	function updateCount() {
		clearTimeout(countTimer);
		const v = sides();
		const el = $('count');
		const left = v && !v.match.roundOver ? (v.match.roundStartAt ?? 0) - serverNow() : 0;
		if (left <= 0) {
			if (el.dataset.n && mode !== 'replay' && left > -500) sound.cue('start'); // the 3-2-1 just ran out
			el.hidden = true;
			el.dataset.n = '';
			return;
		}
		const n = Math.ceil(left / 1000);
		sound.prepare(); // wake the audio and finish any clip not made yet, while nothing can be played
		if (el.dataset.n !== String(n)) {
			el.innerHTML = `<span>${n}</span>`;
			el.dataset.n = String(n);
			if (mode !== 'replay') sound.cue('countdown');
			streakCount = 0; // a new round starts cold
		}
		el.hidden = false;
		countTimer = setTimeout(() => (left - (n - 1) * 1000 <= 1000 && n === 1 ? render() : updateCount()), left - (n - 1) * 1000 + 5);
	}

	// Round clock, m:ss, from the server's clock. One timeout per second while a round runs.
	let clockTimer = 0;
	function renderTime() {
		clearTimeout(clockTimer);
		const v = sides();
		if (!v) return;
		const m = v.match;
		const over = !!m.roundOver;
		const ms = Math.max(0, serverNow() - (m.roundStartAt ?? serverNow()));
		const t = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
		// Rush: the clock turns white and says so, blinking on a 0.8s beat (same rule as VersusMatch.rushFactor, asked about now).
		// The ramp (Krischan, 2026-11-08): ×3 from 2:00 with the bell, ×5 from 3:00 with the bell and the crowd.
		const full = rules.rushAfterSecs * 1000;
		const early = rules.rushEarlySecs && rules.rushEarlyMultiplier > 1 ? rules.rushEarlySecs * 1000 : 0;
		const rx = over ? 1 : rules.rushAfterSecs ? (ms >= full ? rules.rushMultiplier : early && ms >= early ? rules.rushEarlyMultiplier : 1) : m.rushFactor;
		const rush = rx > 1;
		const roundKey = m.roundStartAt ?? 0;
		const cueKey = `${roundKey}:${rx}`;
		if (rush && rushCued !== cueKey && mode !== 'replay') {
			rushCued = cueKey;
			const stepAt = rx === rules.rushMultiplier ? full : early;
			if (!rules.rushAfterSecs || ms - stepAt < 2000) {
				// not when joining long after it began
				sound.cue('bell');
				if (rx === rules.rushMultiplier) sound.cue('crowd');
			}
		}
		for (const id of ['you-time', 'them-time']) {
			const el = $(id);
			if (over && el.textContent) continue; // keep the time the round ended on
			el.textContent = rush ? `RUSH ×${rx} • ${t}` : t;
			el.classList.toggle('rush', rush);
		}
		if (!over) clockTimer = setTimeout(renderTime, Math.max(50, 1000 - (ms % 1000)));
	}

	function roundOverlay(m, me) {
		const ov = $('overlay');
		if (!m.roundOver) {
			ov.hidden = true;
			return;
		}
		const ro = m.roundOver;
		const endKey = `${m.roundStartAt ?? 0}:${m.score.join('-')}`;
		if (endCued !== endKey && mode !== 'replay') {
			endCued = endKey;
			sound.cue(ro.winner === me ? (m.over ? 'matchWin' : 'win') : 'lose');
		}
		sound.rest(); // let the result sound finish, then rest until the next 3-2-1 wakes it
		const who = ro.winner == null ? null : mode === 'replay' ? $(ro.winner === 0 ? 'name-you' : 'name-them').textContent : ro.winner === me ? 'You' : $('name-them').textContent;
		$('ov-title').textContent = who == null ? 'Double KO' : `${who} won the ${m.over ? 'match' : 'round'}`;
		$('ov-sub').textContent = `${m.score[me]} – ${m.score[1 - me]}`;
		$('ov-next').hidden = !m.over || mode === 'replay'; // rounds move on by themselves; only a finished match waits
		const rid = mode === 'online' && room && room.replay;
		$('ov-replay').hidden = !(m.over && rid);
		if (rid) $('ov-replay').href = '/replay/' + rid;
		$('ov-next').disabled = false;
		ov.hidden = false;
		// Keyed on the round's own start time: practice starts every new game at round 1 again,
		// so a round number alone made a second game's first round look already handled (and stuck).
		if (lastRoundSeen !== endKey) {
			lastRoundSeen = endKey;
			// The winner's score blinks: replacement and opacity only.
			if (ro.winner != null) {
				const box = $(ro.winner === me ? 'score-you' : 'score-them');
				box.classList.remove('win');
				void box.offsetWidth;
				box.classList.add('win');
			}
			if (mode === 'online') net.send({ t: 'tele', d: { ...core.telemetry(), reconnects: net.reconnects, round: m.round } });
			if (mode === 'practice' && !m.over) practice.later();
		}
	}

	function scheduleGravity() {
		clearTimeout(gravTimer);
		const ms = core && core.msToGravity ? core.msToGravity() : null;
		if (ms == null) return;
		gravTimer = setTimeout(() => {
			animate(core.tick(), 0);
			render();
		}, Math.min(ms, 60000));
	}

	/** Animate events for one seat (0 = me, 1 = them in screen terms). */
	function animate(events, onlyScreen) {
		const v = sides();
		if (!v || !events || !events.length) return;
		const screenOf = (e) => {
			const seat = e.side === 'you' ? 0 : e.side === 'them' ? 1 : -1;
			if (seat < 0) return -1;
			const screen = seat === v.me ? 0 : 1;
			return onlyScreen != null && screen !== onlyScreen ? -2 : screen;
		};
		for (const e of events) {
			const sc = screenOf(e);
			if (sc === 0) sound.event(e);
			else if (sc === 1) sound.event(e, true); // the other board's big moments, quieter
		}
		hud.animate(events.filter((e) => screenOf(e) !== -2), screenOf);
	}

	function onMove(action) {
		if (!core || mode === 'replay') return;
		const r = core.move(action);
		if (!r.moved && action.type === 'place' && (r.denied === 'ice' || r.denied === 'invalid')) {
			hud.deny(action, r.denied);
			sound.refused();
		}
		if (r.moved && action.type === 'place') {
			sound.place((Math.abs(action.bx - action.ax) + 1) * (Math.abs(action.by - action.ay) + 1));
			// Streak: placements in a row with no Do-Over; it sounds every 5th (Krischan, 2026-11-06).
			if (++streakCount % 5 === 0) sound.streak(streakCount);
		}
		if (r.moved && action.type === 'erase') {
			sound.doOver();
			streakCount = 0;
		}
		if (r.moved) animate(r.events, 0);
		if (mode === 'practice') practice.afterYou();
		render();
	}

	// —— Online ——
	const net = {
		ws: null,
		code: null,
		key: null,
		reconnects: 0,
		retry: 0,
		timer: 0,
		beat: 0,
		lastPong: 0,
		closedByUs: false,
		outbox: [],
		send(obj) {
			if (this.ws && this.ws.readyState === 1 && this.ready) this.ws.send(JSON.stringify(obj));
			else if (obj.t !== 'mv' && this.outbox.length < 50) this.outbox.push(obj); // moves are resent from pending instead
		},
		connect(code, key) {
			this.code = code;
			this.key = key;
			this.closedByUs = false;
			const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}`;
			let ws;
			try {
				ws = new WebSocket(url);
			} catch {
				return this.later();
			}
			this.ws = ws;
			ws.onopen = () => {
				if (this.retry) this.reconnects++;
				this.retry = 0;
				// Heartbeat: one 4-byte ping every 4s, answered by the edge without waking the
				// room. No pong for 10s means the connection is dead even if the socket says open.
				this.lastPong = Date.now();
				clearInterval(this.beat);
				this.beat = setInterval(() => {
					if (ws.readyState !== 1) return;
					if (Date.now() - this.lastPong > 10000) {
						clearInterval(this.beat);
						this.ready = false;
						ws.onclose = null;
						try {
							ws.close();
						} catch {}
						banner('Connection lost. Reconnecting…');
						return this.later();
					}
					ws.send('ping');
				}, 4000);
				banner(null);
				ws.send(JSON.stringify({ t: 'hello', id: myId, name: myName(), k: key || undefined, dev: device(), pv: PROTOCOL_VERSION }));
				// Learn the server's clock now, not at the first move: a device clock a few seconds off
				// showed a 10-second "3-2-1" and stamped early moves wrong. Three samples, the best one wins.
				for (let k = 0; k < 3; k++) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'time', c: Date.now() })), k * 400);
				this.ready = true;
				const q = this.outbox.splice(0);
				for (const o of q) this.send(o);
			};
			ws.onmessage = (ev) => {
				if (ev.data === 'pong') {
					this.lastPong = Date.now();
					return;
				}
				let msg;
				try {
					msg = JSON.parse(ev.data);
				} catch {
					return;
				}
				onServer(msg);
			};
			ws.onclose = (ev) => {
				clearInterval(this.beat);
				this.ready = false;
				if (this.closedByUs) return;
				if (ev.reason === 'full') return banner('This room is full: two players are already in it.');
				if (ev.reason === 'update') return banner('Shikaku+ VS has been updated. Reload the page to play online.');
				banner('Connection lost. Reconnecting…');
				this.later();
			};
		},
		later() {
			clearTimeout(this.timer);
			const ms = Math.min(8000, 500 * 2 ** this.retry++);
			this.timer = setTimeout(() => this.connect(this.code, this.key), ms);
		},
		close() {
			this.closedByUs = true;
			clearTimeout(this.timer);
			clearInterval(this.beat);
			if (this.ws) this.ws.close();
		}
	};
	// A phone that slept comes back with a dead socket: reconnect straight away.
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && mode === 'online' && net.ws && net.ws.readyState > 1) {
			net.retry = 0;
			net.connect(net.code, net.key);
		}
	});

	function banner(text) {
		$('banner').hidden = !text;
		$('banner').textContent = text || '';
	}

	function onServer(msg) {
		if (msg.t === 'room') {
			room = msg;
			if (core) core.me = msg.you;
			if (msg.phase === 'lobby') {
				lobby();
				return;
			}
			show('game');
			const opp = msg.seats[1 - msg.you];
			banner(opp && !opp.connected ? `${opp.name} disconnected. Their board is frozen until they come back.` : null);
			$('vote').hidden = !msg.vote;
			$('g-report').hidden = !msg.admin;
			render();
			return;
		}
		if (msg.t === 'time') {
			if (core && Number.isFinite(msg.c) && Number.isFinite(msg.s)) core.clockSample(msg.c, msg.s);
			updateCount();
			return;
		}
		if (msg.t === 'hv') {
			if (core && msg.i !== core.me) {
				theirHover = msg.r || null;
				showGhost();
			}
			return;
		}
		if (msg.t === 'report') {
			copy(JSON.stringify(msg.r, null, 1), 'Report copied');
			return;
		}
		if (msg.t === 'err') {
			if (msg.why === 'update') return banner('Shikaku+ VS has been updated. Reload the page to play online.');
			banner(msg.why === 'full' ? 'This room is full.' : 'Something went wrong: ' + msg.why);
			return;
		}
		// A round just ended and the next one arrived with it: keep the last boards and the result
		// up until the countdown, holding every later message behind it so order is kept.
		if (held) {
			held.push(msg);
			return;
		}
		if (msg.t === 'round' && msg.prev && core && core.confirmed) {
			const wait = msg.startAt - COUNTDOWN_MS - serverNow();
			if (wait > 30) {
				held = [msg];
				setTimeout(() => {
					const q = held || [];
					held = null;
					for (const x of q) onServer(x);
				}, wait);
				return;
			}
		}
		if (msg.t === 'fz' && msg.i === core.me) net.send({ t: 'sync' }); // we were only quiet: say so
		if (msg.t === 'round' || msg.t === 'full') rules = msg.rules || rules;
		if (msg.t === 'round') lastRoundSeen = null;
		if (msg.t === 'full') $('ov-next').disabled = false;
		const events = core.handle(msg);
		// The other board's events come from the server; mine were shown when I moved.
		animate(events, 1);
		if (msg.t === 'mv' && msg.i !== core.me && theirHover) {
			theirHover = null;
			showGhost();
		}
		if (msg.t === 'mv' && msg.i !== core.me) animate(events.filter((e) => e.kind === 'minesIncoming' || e.kind === 'iceIncoming'), 0);
		if (msg.t === 'round' || msg.t === 'full') show('game');
		render();
	}

	function lobby() {
		show('lobby');
		$('room-code').textContent = room.code;
		$('seats').innerHTML = '';
		room.seats.forEach((s, i) => {
			const d = document.createElement('div');
			d.className = 'lobby-seat';
			d.innerHTML = `<span></span><span class="${s.ready ? 'ok' : 'off'}">${s.connected ? (s.ready ? 'Ready' : 'Not ready') : 'Disconnected'}</span>`;
			d.firstChild.textContent = `${s.name}${i === 0 ? ' (host)' : ''}${i === room.you ? ' · you' : ''}`;
			$('seats').appendChild(d);
		});
		if (room.seats.length < 2) {
			const d = document.createElement('div');
			d.className = 'lobby-seat';
			d.innerHTML = '<span class="off">Waiting for a second player. Send them the link.</span>';
			$('seats').appendChild(d);
		}
		const meSeat = room.seats[room.you];
		$('ready').textContent = meSeat && meSeat.ready ? 'Not ready' : 'Ready';
		$('start').hidden = !room.host;
		$('start').disabled = !(room.seats.length === 2 && room.seats.every((s) => s.ready));
		$('lobby-hint').textContent = room.host ? '' : 'The host starts the match.';
		$('rules-who').textContent = room.host ? '(you are the host: you choose)' : '(the host chooses)';
		$('admin-tools').hidden = !room.admin;
		useSettings(roomCtx);
	}

	// —— Match settings, TETR.IO-style: a Match tab and a Game tab ——
	// One panel (#cfg-panel), used by the room (the host edits a draft and saves) and by the
	// Practice page (every change applies at once and is remembered on this device).
	let draft = null; // unsaved settings
	let savedJSON = null; // the saved settings as last drawn
	const roomCtx = {
		slot: 'lobby-cfg-slot',
		get host() {
			return !!(room && room.host);
		},
		get saved() {
			return (room && room.o) || {};
		},
		save: (o) => net.send({ t: 'set', o }),
		auto: false
	};
	let ctx = roomCtx;
	function useSettings(c) {
		if (ctx !== c) {
			ctx = c;
			draft = null; // a different set of settings: start from what it has saved
			savedJSON = null;
		}
		const slot = $(c.slot);
		if (slot.nextElementSibling !== $('cfg-panel')) slot.after($('cfg-panel'));
		$('rules-who').textContent = c.auto ? '' : c.host ? '(you are the host: you choose)' : '(the host chooses)';
		drawSettings();
	}
	const sameO = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
	const fmtSet = (s, v) => (s.off != null && v === s.off ? 'off' : s.type === 'bool' ? (v ? 'on' : 'off') : `${v}${s.unit || ''}`);
	for (const t of document.querySelectorAll('.tabs [data-tab]'))
		t.addEventListener('click', () => {
			for (const o of document.querySelectorAll('.tabs [data-tab]')) o.setAttribute('aria-selected', String(o === t));
			$('tab-match').hidden = t.dataset.tab !== 'match';
			$('tab-game').hidden = t.dataset.tab !== 'game';
		});
	$('save').addEventListener('click', () => {
		if (draft) ctx.save(draft);
	});
	function setDraft(k, v) {
		draft = { ...draft };
		if (JSON.stringify(v) === JSON.stringify(defaultOf(k))) delete draft[k];
		else draft[k] = v;
		saveState();
	}
	function saveState() {
		if (ctx.auto) {
			ctx.save(draft); // practice: nothing to confirm with anyone
			return;
		}
		const dirty = !sameO(draft, ctx.saved);
		$('save').disabled = !dirty;
		$('save-note').textContent = dirty ? 'Unsaved changes. Saving un-readies both players.' : 'Saved.';
	}
	function seg(el, options, current, onPick, enabled) {
		el.innerHTML = '';
		for (const [v, label] of options) {
			const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, disabled: !enabled });
			b.setAttribute('aria-pressed', String(JSON.stringify(v) === JSON.stringify(current)));
			b.addEventListener('click', () => {
				for (const o of el.children) o.setAttribute('aria-pressed', String(o === b));
				onPick(v); // last: it may redraw the whole row
			});
			el.appendChild(b);
		}
	}
	/** Like seg(), for the Start-a-game style choices: a title and, if given, a line under it. */
	function cards(el, options, current, onPick, enabled) {
		el.innerHTML = '';
		for (const [v, title, sub] of options) {
			const b = Object.assign(document.createElement('button'), { type: 'button', disabled: !enabled });
			b.appendChild(Object.assign(document.createElement('strong'), { textContent: title }));
			if (sub) b.appendChild(Object.assign(document.createElement(el.classList.contains('cfg-cards') ? 'span' : 'small'), { textContent: sub }));
			b.setAttribute('aria-pressed', String(JSON.stringify(v) === JSON.stringify(current)));
			b.addEventListener('click', () => {
				for (const o of el.children) o.setAttribute('aria-pressed', String(o === b));
				onPick(v); // last: it may redraw the whole row
			});
			el.appendChild(b);
		}
	}
	function drawSettings() {
		const host = ctx.host;
		const saved = ctx.saved;
		// A new saved value replaces the draft unless the host is mid-edit.
		if (!draft || savedJSON !== JSON.stringify(saved)) {
			if (!draft || sameO(draft, JSON.parse(savedJSON || '{}'))) draft = { ...saved };
			savedJSON = JSON.stringify(saved);
		}
		const val = (k) => (k in draft ? draft[k] : defaultOf(k));
		const modeSet = SETTINGS.find((x) => x.k === 'mode');
		const ftSet = SETTINGS.find((x) => x.k === 'firstTo');
		// Division and match (Krischan, 2026-11-08): Standard or Knockout, Quickplay or Competitive.
		const fmt = formatOf(draft);
		// Save first, then redraw: the redraw compares the draft with what's saved.
		const pickFormat = (d, q) => {
			draft = formatSet(draft, d, q);
			saveState();
			drawSettings();
		};
		const d = fmt.division || DIVISIONS[0];
		cards($('pick-division'), DIVISIONS.map((x) => [x.id, x.label, x.blurb]), fmt.division && fmt.division.id, (id) => pickFormat(id, (fmt.queue || QUEUES[0]).id), host);
		cards($('pick-queue'), QUEUES.map((q) => [q.id, q.label, `First to ${q.id === 'competitive' ? d.competitiveTo : 3}`]), fmt.queue && fmt.queue.id, (id) => pickFormat(d.id, id), host);
		$('queue-note').textContent = !fmt.division || !fmt.queue ? 'Custom: Stock or First to changed.' : ctx.auto ? 'Bot matches are never rated.' : fmt.queue.rated ? 'The long set.' : 'Never rated.';
		$('ft-note').textContent = 'Rounds to win the match.';
		$('mode-row').hidden = val('mode') !== 'mines'; // Mines is soft-retired: only shown for a room already set to it
		seg($('pick-mode'), modeSet.options.map(([v, t]) => [v, t.replace(' (no ice, unrated)', '')]), val('mode'), (v) => setDraft('mode', v), host);
		cards($('pick-ft'), ftSet.options.map(([v, t]) => [v, t]), val('firstTo'), (v) => {
			setDraft('firstTo', v); // saves (practice) or marks unsaved (room)
			drawSettings();
		}, host);
		seg($('presets'), PRESETS.filter((p) => !p.retired).map((p) => [p.id, p.label]), null, (id) => {
			draft = { ...PRESETS.find((p) => p.id === id).set };
			saveState();
			drawSettings();
		}, host);
		const box = $('settings');
		box.innerHTML = '';
		let group = '';
		for (const st of SETTINGS) {
			if (st.k === 'mode' || st.k === 'firstTo') continue;
			if (st.group !== group) {
				group = st.group;
				box.appendChild(Object.assign(document.createElement('h3'), { textContent: group }));
			}
			const v = val(st.k);
			const row = document.createElement('div');
			row.className = 'set-row' + (st.type === 'bool' || st.type === 'enum' ? ' toggle' : '') + (st.k in draft ? ' changed' : '');
			const id = 'set-' + st.k;
			const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: st.label });
			row.appendChild(label);
			let input;
			if (st.type === 'bool') {
				input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!v });
				input.addEventListener('change', () => setDraft(st.k, input.checked));
				row.appendChild(input);
			} else if (st.type === 'enum') {
				input = document.createElement('select');
				st.options.forEach(([ov, t], n) => input.appendChild(Object.assign(document.createElement('option'), { value: String(n), textContent: t })));
				input.value = String(Math.max(0, st.options.findIndex(([ov]) => JSON.stringify(ov) === JSON.stringify(v))));
				input.addEventListener('change', () => setDraft(st.k, st.options[Number(input.value)][0]));
				row.appendChild(input);
			} else {
				input = Object.assign(document.createElement('input'), { type: 'range', min: st.min, max: st.max, step: st.step || 1, value: v });
				const out = Object.assign(document.createElement('output'), { textContent: fmtSet(st, v) });
				input.addEventListener('input', () => {
					const n = Number(input.value);
					out.textContent = fmtSet(st, n);
					row.classList.toggle('changed', JSON.stringify(n) !== JSON.stringify(defaultOf(st.k)));
					setDraft(st.k, n);
				});
				row.append(input, out);
			}
			input.id = id;
			input.disabled = !host;
			box.appendChild(row);
		}
		$('save-row').hidden = !host || ctx.auto;
		if (host && !ctx.auto) saveState();
	}

	function copy(text, msg) {
		const done = () => ($('admin-msg').textContent = msg);
		if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => prompt('Copy this:', text));
		else prompt('Copy this:', text);
	}

	$('ready').addEventListener('click', () => net.send({ t: 'ready', v: !(room.seats[room.you] || {}).ready }));
	$('start').addEventListener('click', () => net.send({ t: 'start' }));
	$('copy-link').addEventListener('click', () => copy(`${location.origin}/${room.code}`, 'Link copied'));
	$('copy-report').addEventListener('click', () => net.send({ t: 'report' }));
	$('g-report').addEventListener('click', () => net.send({ t: 'report' }));
	$('copy-reports').addEventListener('click', async () => {
		try {
			const r = await fetch(`/api/reports?k=${encodeURIComponent(net.key || '')}`);
			copy(await r.text(), 'Recent matches copied');
		} catch {
			$('admin-msg').textContent = 'Could not load reports';
		}
	});
	$('vote-yes').addEventListener('click', () => {
		net.send({ t: 'vote', v: true });
		$('vote').hidden = true;
	});
	$('vote-no').addEventListener('click', () => {
		net.send({ t: 'vote', v: false });
		$('vote').hidden = true;
	});
	$('ov-next').addEventListener('click', () => {
		$('ov-next').disabled = true;
		if (mode === 'online') net.send({ t: 'next' });
		else practice.next();
	});
	$('leave').addEventListener('click', () => {
		if (mode === 'online') net.close();
		const back = mode === 'practice' ? '/practice' : '/'; // a bot match goes back to its setup
		practice.stop();
		history.pushState(null, '', back);
		route();
	});

	// —— Practice: everything local, nothing sent ——
	const practice = {
		bot: null,
		timer: 0,
		level: 'normal',
		start(level, modeKey = 'vs', o = {}) {
			this.level = level;
			this.mode = modeKey;
			this.o = o;
			// The same rules a room with these settings would play (shared/settings.js rulesFor).
			const run = rulesFor({ ...o, mode: modeKey });
			rules = run.rules;
			const m = new VersusMatch({ rules, seed: Math.floor(Math.random() * 1e6) + 1, target: run.firstTo });
			m.startClock(Date.now(), COUNTDOWN_MS);
			const preset = BOT_PRESETS[level] || BOT_PRESETS.normal;
			this.preset = preset;
			this.bot = new TiltBot({ ...preset, seed: Math.floor(Math.random() * 1e6) });
			core = {
				me: 0,
				predicted: m,
				confirmed: m,
				rules,
				move(a) {
					const now = Date.now();
					const ev = m.catchUp(now);
					const r = m.act(0, a, now);
					r.events = [...ev, ...r.events];
					return r;
				},
				tick() {
					return m.catchUp(Date.now());
				},
				msToGravity() {
					const step = (rules.gravitySecs || 0) * 1000;
					const s = m.sides[0];
					return step && !m.roundOver && s.gAt != null ? Math.max(0, s.gAt + step - Date.now()) + 5 : null;
				}
			};
			mode = 'practice';
			$('replay-bar').hidden = true;
			show('game');
			banner(null);
			$('vote').hidden = true;
			this.schedule();
			render();
		},
		schedule() {
			clearTimeout(this.timer);
			const m = core && core.confirmed;
			if (!m || m.roundOver || mode !== 'practice') return;
			const p = this.preset;
			if (p.mirror) return; // Mirror moves when you do
			const ms = (p.secs * (0.6 + Math.random() * 0.8)) * 1000 + Math.max(0, (m.roundStartAt ?? 0) - Date.now());
			this.timer = setTimeout(() => this.botMove(), ms);
		},
		botMove() {
			const m = core.confirmed;
			if (m.roundOver) return;
			const now = Date.now();
			animate(m.catchUp(now));
			const r = m.act(1, this.bot.decide(m.sides[1]), now);
			animate(r.events);
			render();
			this.schedule();
		},
		afterYou() {
			if (this.preset && this.preset.mirror) setTimeout(() => this.botMove(), 200 + Math.random() * 250);
		},
		next() {
			const m = core.confirmed;
			if (m.over) return this.start(this.level, this.mode, this.o);
			m.newRound();
			m.startClock(Date.now(), COUNTDOWN_MS);
			render();
			this.schedule();
		},
		/** A round ended: show the result, then the next round counts down by itself. */
		later() {
			clearTimeout(this.nextTimer);
			this.nextTimer = setTimeout(() => mode === 'practice' && this.next(), RESULT_MS);
		},
		stop() {
			clearTimeout(this.timer);
			clearTimeout(this.nextTimer);
			if (mode === 'practice') mode = null;
		}
	};

	// —— Replays: rebuild a recorded match on the same screen, from its seed and the server's messages ——
	const rp = { data: null, ri: 0, exact: null, k: -1, playhead: 0, playing: false, speed: 1, last: 0, timer: 0, nextTimer: 0, dragging: false };
	const fmtMs = (ms) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor((Math.max(0, ms) % 60000) / 1000)).padStart(2, '0')}`;
	const replay = {
		async open(id) {
			practice.stop();
			if (net.ws) net.close();
			mode = 'replay';
			show('game');
			$('replay-bar').hidden = false;
			$('game-controls').hidden = false;
			$('vote').hidden = true;
			$('g-report').hidden = true;
			banner('Loading the replay…');
			let data = null;
			try {
				const res = await fetch('/api/replay?id=' + id);
				if (res.ok) data = await res.json();
			} catch {}
			if (!data || !data.rounds || !data.rounds.length) return banner('This replay could not be found. It may be from before replays were recorded (5 November 2026).');
			banner(null);
			rp.data = { header: data.header, rounds: data.rounds.filter(Boolean).sort((a, b) => a.round - b.round) };
			rules = rp.data.header.rules;
			setView('spec');
			const rb = $('rp-rounds');
			rb.innerHTML = '';
			rp.data.rounds.forEach((rd, n) => {
				const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `Round ${n + 1}${rd.partial ? ' (unfinished)' : ''}` });
				b.addEventListener('click', () => this.load(n, true));
				rb.appendChild(b);
			});
			this.load(0, true);
		},
		load(n, play) {
			clearTimeout(rp.nextTimer);
			rp.ri = n;
			const rd = rp.data.rounds[n];
			rp.exact = roundStart(rp.data.header, rd);
			rp.k = -1;
			rp.playhead = rd.t0;
			core = { me: 0, predicted: rp.exact, confirmed: rp.exact, serverNow: () => rp.playhead };
			hud.reset();
			[...$('rp-rounds').children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === n)));
			$('rp-scrub').max = String(Math.max(1000, roundEnd(rd) - rd.t0));
			$('rp-check').textContent = verifyRound(rp.data.header, rd) ? '✓ matches the server' : '⚠ differs from the server';
			this.show([]);
			if (play) this.play();
		},
		/** Bring the exact copy up to the playhead; draw a gravity preview between messages. */
		advance(animateIt) {
			const rd = rp.data.rounds[rp.ri];
			const ev = [];
			const k0 = rp.k;
			while (rp.k + 1 < rd.msgs.length && msgAt(rd.msgs[rp.k + 1]) <= rp.playhead) ev.push(...applyMsg(rp.exact, rd.msgs[++rp.k]));
			if (rp.k !== k0) this.ghosts();
			this.show(animateIt ? ev : []);
			return rp.k + 1 >= rd.msgs.length && rp.playhead >= roundEnd(rd);
		},
		show(ev) {
			const rd = rp.data.rounds[rp.ri];
			let view = rp.exact;
			// The server paid gravity lazily, at the next message; ticks owed before that message's
			// horizon are certain, so show them on time instead of late.
			const next = rd.msgs[rp.k + 1];
			const step = (rules.gravitySecs || 0) * 1000;
			if (step && !rp.exact.roundOver) {
				const horizon = next ? Math.min(rp.playhead, next[0] === 'm' ? next[4] : next[3] ?? msgAt(next)) : rp.playhead;
				if (rp.exact.sides.some((s) => s.frozenAt == null && s.gAt != null && s.gAt + step <= horizon)) {
					view = VersusMatch.fromState(rp.exact.toState(), rules);
					view.catchUp(horizon);
				}
			}
			core.predicted = core.confirmed = view;
			if (ev.length) animate(ev);
			render();
			if (!rp.dragging) $('rp-scrub').value = String(rp.playhead - rd.t0);
			$('rp-time').textContent = `${fmtMs(rp.playhead - rd.startAt)} / ${fmtMs(roundEnd(rd) - rd.startAt)}`;
		},
		play() {
			rp.playing = true;
			$('rp-play').textContent = 'Pause';
			rp.last = performance.now();
			clearTimeout(rp.timer);
			const tick = () => {
				if (!rp.playing || mode !== 'replay') return;
				const now = performance.now();
				rp.playhead += (now - rp.last) * rp.speed;
				rp.last = now;
				const ended = this.advance(true);
				if (ended) {
					rp.playing = false;
					$('rp-play').textContent = 'Play';
					if (rp.ri + 1 < rp.data.rounds.length) rp.nextTimer = setTimeout(() => mode === 'replay' && this.load(rp.ri + 1, true), RESULT_MS / rp.speed);
					return;
				}
				rp.timer = setTimeout(tick, 50); // 20 frames a second while playing; nothing while paused
			};
			rp.timer = setTimeout(tick, 50);
		},
		pause() {
			rp.playing = false;
			clearTimeout(rp.timer);
			$('rp-play').textContent = 'Play';
		},
		seek(ms) {
			const rd = rp.data.rounds[rp.ri];
			rp.playhead = rd.t0 + ms;
			let k = -1;
			while (k + 1 < rd.msgs.length && msgAt(rd.msgs[k + 1]) <= rp.playhead) k++;
			rp.exact = roundAt(rp.data.header, rd, k);
			rp.k = k;
			hud.reset();
			this.ghosts();
			this.show([]);
		},
		/** Both players' hovers as of the playhead (screen = seat in the viewer). */
		ghosts() {
			const h = hoversAt(rp.data.rounds[rp.ri], rp.k);
			h.forEach((r, i) => hud.setGhost(i, r ? { x1: r[0], y1: r[1], x2: r[2], y2: r[3] } : null));
		},
		stop() {
			rp.playing = false;
			clearTimeout(rp.timer);
			clearTimeout(rp.nextTimer);
			if (mode === 'replay') mode = null;
		}
	};
	$('rp-play').addEventListener('click', () => {
		if (!rp.data) return;
		if (rp.playing) return replay.pause();
		const rd = rp.data.rounds[rp.ri];
		if (rp.playhead >= roundEnd(rd)) replay.seek(0);
		replay.play();
	});
	for (const x of [0.5, 1, 2, 4]) {
		const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `${x}×` });
		b.setAttribute('aria-pressed', String(x === 1));
		b.addEventListener('click', () => {
			rp.speed = x;
			for (const o of $('rp-speed').children) o.setAttribute('aria-pressed', String(o === b));
		});
		$('rp-speed').appendChild(b);
	}
	$('rp-scrub').addEventListener('input', () => {
		if (!rp.data) return;
		rp.dragging = true;
		replay.seek(Number($('rp-scrub').value));
	});
	$('rp-scrub').addEventListener('change', () => (rp.dragging = false));

	// —— Home and routing ——
	for (const [k, p] of Object.entries(BOT_PRESETS)) $('bot-level').appendChild(Object.assign(document.createElement('option'), { value: k, textContent: p.label }));
	$('bot-level').value = 'normal';
	$('name').value = store.get('vs.name') || '';
	$('name').addEventListener('change', () => store.set('vs.name', $('name').value.slice(0, 16)));
	$('create').addEventListener('click', () => go('/' + newRoomCode()));
	const joinIt = () => {
		const c = $('join-code').value.trim().toUpperCase();
		if (isRoomCode(c)) go('/' + c);
		else $('join-code').focus();
	};
	$('join').addEventListener('click', joinIt);
	$('join-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinIt());
	// —— Home: create, join, practice ——
	$('join-open').addEventListener('click', () => {
		const open = $('join-row').hidden;
		$('join-row').hidden = !open;
		$('join-open').setAttribute('aria-expanded', String(open));
		if (open) $('join-code').focus();
	});
	$('practice-open').addEventListener('click', () => go('/practice'));
	$('practice-back').addEventListener('click', () => go('/'));

	// —— Practice page: the room's settings panel, applied at once, remembered on this device ——
	let practiceO = {};
	try {
		practiceO = sanitize(JSON.parse(store.get('vs.practice') || '{}'));
	} catch {}
	const practiceCtx = {
		slot: 'practice-cfg-slot',
		host: true,
		get saved() {
			return practiceO;
		},
		save: (o) => {
			practiceO = sanitize(o);
			store.set('vs.practice', JSON.stringify(practiceO));
		},
		auto: true
	};
	$('practice').addEventListener('click', () => {
		store.set('vs.name', $('name').value.slice(0, 16));
		practice.start($('bot-level').value, $('practice-mode').value, practiceO);
	});
	function go(path) {
		store.set('vs.name', $('name').value.slice(0, 16));
		history.pushState(null, '', path);
		route();
	}
	window.addEventListener('popstate', route);

	function route() {
		$('replay-bar').hidden = true;
		const rpm = location.pathname.match(/^\/replay\/([a-z0-9]{12,24})\/?$/);
		if (rpm) return replay.open(rpm[1]);
		replay.stop();
		if (/^\/practice\/?$/.test(location.pathname)) {
			practice.stop();
			mode = null;
			show('practice-page');
			useSettings(practiceCtx);
			return;
		}
		const r = parseRoomPath(location.pathname);
		if (!r) {
			mode = null;
			show('home');
			return;
		}
		if (!store.get('vs.name')) store.set('vs.name', 'Player' + Math.floor(Math.random() * 90 + 10));
		practice.stop();
		$('replay-bar').hidden = true;
		mode = 'online';
		core = new ClientCore({ send: (o) => net.send(o) });
		room = null;
		show('lobby');
		$('room-code').textContent = r.code;
		$('seats').textContent = 'Connecting…';
		net.retry = 0;
		net.connect(r.code, r.key);
	}

	// Read-only handle for testing and for bug reports from the console.
	window.vsDebug = { get core() { return core; }, get room() { return room; }, move: (a) => onMove(a) };
	$('tester-code').textContent = testerCode(myId);
	route();
	// Canvas text uses Shippori; repaint once the font has arrived.
	if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
})();
