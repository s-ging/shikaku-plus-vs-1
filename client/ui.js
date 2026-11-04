// ui.js — the playtest client: home, lobby, match, practice. No framework.
// Rendering is on demand: a frame is drawn when something changes, never on a loop.
(() => {
	const $ = (id) => document.getElementById(id);
	const show = (id) => ['home', 'lobby', 'game'].forEach((s) => ($(s).hidden = s !== id));
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

	function device() {
		const n = navigator;
		const c = n.connection || {};
		return { ua: n.userAgent.slice(0, 200), w: screen.width, h: screen.height, dpr: window.devicePixelRatio || 1, mem: n.deviceMemory || null, cores: n.hardwareConcurrency || null, net: c.effectiveType || null, touch: 'ontouchstart' in window };
	}

	// —— Views ——
	const painters = [new BoardPainter($('you-board'), (a) => onMove(a)), new BoardPainter($('them-board'), null)];
	let mode = null; // 'online' | 'practice'
	let core = null; // ClientCore (online) or a practice adapter with the same shape
	let room = null; // last 'room' message
	let rules = FF_RULES;
	let gravTimer = 0;
	let lastRoundSeen = null;

	function sides() {
		if (!core || !core.predicted) return null;
		const me = core.me;
		return { me, you: core.predicted.sides[me], them: core.confirmed.sides[1 - me], match: core.confirmed, pmatch: core.predicted };
	}

	function poles(prefix, side) {
		const e = side.econ;
		const lives = $(prefix + '-lives');
		if (lives.childElementCount !== rules.hearts) {
			lives.innerHTML = '';
			for (let i = 0; i < rules.hearts; i++) {
				const seg = document.createElement('i');
				seg.innerHTML = '<span class="fill"></span><span class="frost"></span>';
				lives.appendChild(seg);
			}
		}
		const segs = [...lives.children].reverse();
		const cp = rules.healCheckpoint || 0;
		segs.forEach((seg, i) => {
			seg.className = i < e.hearts ? 'on' : '';
			const healable = i === e.hearts && rules.healPerfectBoards && (!rules.maxHealsPerRound || e.heals < rules.maxHealsPerRound);
			const run = e.doOversThisBoard ? (cp && e.perfectRun >= cp ? cp : 0) : e.perfectRun;
			seg.firstChild.style.height = healable ? `${(100 * run) / rules.healPerfectBoards}%` : '0';
			// Ice on the board frosts your top heart: one step per ice, toward losing the board.
			const top = i === e.hearts - 1;
			seg.lastChild.style.height = top ? `${(100 * Math.min(e.ice.length, rules.freezeOverAt)) / rules.freezeOverAt}%` : '0';
		});
		const hz = $(prefix + '-hz');
		const BANK = 12;
		if (hz.childElementCount !== BANK + rules.batchSize + 1) {
			hz.innerHTML = '';
			for (let i = 0; i < BANK; i++) hz.appendChild(Object.assign(document.createElement('i'), { className: 'bank' }));
			for (let i = 0; i < rules.batchSize; i++) hz.appendChild(Object.assign(document.createElement('i'), { className: 'batch' }));
			hz.appendChild(Object.assign(document.createElement('i'), { className: 'ice' }));
		}
		const kids = [...hz.children];
		const bank = e.bank;
		kids.slice(0, BANK).reverse().forEach((s, i) => (s.className = 'bank' + (i < bank ? ' on' : '')));
		const next = e.nextBatch;
		kids.slice(BANK, BANK + rules.batchSize).reverse().forEach((s, i) => (s.className = 'batch' + (i < next ? ' on' : '')));
		const soon = e.iceIncoming.length ? Math.min(...e.iceIncoming.map((w) => w.eta)) : null;
		kids[kids.length - 1].className = 'ice' + (soon == null ? '' : soon <= 1 ? ' e1' : ' e2');
	}

	function footer(prefix, idx, side, m) {
		const pv = m.attackPreview(idx);
		const send = $(prefix + '-send');
		send.textContent = `+${pv.send}`;
		send.className = pv.counter > 0 ? 'hot' : '';
		const pill = $(prefix + '-frost');
		const size = rules.frostMeter || 0;
		pill.hidden = !size;
		if (size) {
			if (pill.childElementCount !== size) pill.innerHTML = '<i></i>'.repeat(size);
			const e = side.econ;
			const full = Math.floor(e.frost / size);
			[...pill.children].forEach((s, k) => (s.className = full > 0 || k < e.frost % size ? 'on' : ''));
			const placed = side.rects.length;
			pill.className = 'pill' + (e.frostHeld(Math.max(0, side.puzzle.layout.length - placed)) ? ' held' : '');
		}
		$(prefix + '-info').textContent = `Board ${side.boardIndex + 1}`;
	}

	function render() {
		const v = sides();
		if (!v) return;
		painters[0].set(v.you, rules);
		painters[1].set(v.them, rules);
		poles('you', v.you);
		poles('them', v.them);
		footer('you', v.me, v.you, v.pmatch);
		footer('them', 1 - v.me, v.them, v.match);
		const m = v.match;
		$('score').innerHTML = `You <b>${m.score[v.me]}</b>–<b>${m.score[1 - v.me]}</b> ${mode === 'practice' ? 'Bot' : 'Them'} · first to ${m.target}${m.rush ? ' · RUSH' : ''}`;
		if (mode === 'online' && room) {
			const opp = room.seats[1 - v.me];
			$('them-name').textContent = opp ? opp.name : 'Waiting';
			$('you-name').textContent = 'You';
		}
		roundOverlay(m, v.me);
		scheduleGravity();
	}

	function roundOverlay(m, me) {
		const ov = $('overlay');
		if (!m.roundOver) {
			ov.hidden = true;
			return;
		}
		const ro = m.roundOver;
		const won = ro.winner === me;
		$('ov-title').textContent = m.over ? (won ? 'Match won' : 'Match lost') : ro.winner == null ? 'Double KO' : won ? 'Round won' : 'Round lost';
		$('ov-sub').textContent = `${m.score[me]} – ${m.score[1 - me]}`;
		$('ov-next').textContent = m.over ? 'Back to the room' : 'Next round';
		$('ov-next').disabled = false;
		ov.hidden = false;
		if (lastRoundSeen !== m.round && mode === 'online') {
			lastRoundSeen = m.round;
			net.send({ t: 'tele', d: { ...core.telemetry(), reconnects: net.reconnects, round: m.round } });
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

	// —— Animations: a callout over the board, short flashes on cells ——
	function callout(idx, text) {
		const card = $(idx === 0 ? 'card-you' : 'card-them');
		const el = Object.assign(document.createElement('div'), { className: 'callout', textContent: text });
		el.style.marginTop = card.querySelectorAll('.callout').length * 28 + 'px';
		card.appendChild(el);
		setTimeout(() => el.classList.add('out'), 700);
		setTimeout(() => el.remove(), 1300);
	}
	/** Animate events for one seat (0 = me, 1 = them in screen terms). */
	function animate(events, onlyScreen) {
		const v = sides();
		if (!v) return;
		for (const e of events || []) {
			const seat = e.side === 'you' ? 0 : e.side === 'them' ? 1 : -1;
			if (seat < 0) continue;
			const screen = seat === v.me ? 0 : 1;
			if (onlyScreen != null && screen !== onlyScreen) continue;
			const p = painters[screen];
			if (e.kind === 'mineExplode') p.flash('blast', e.cell);
			else if (e.kind === 'defuse') p.flash('ring', e.cell);
			else if (e.kind === 'forceBreak') {
				p.flash('break', e.cell);
				if (e.earned) callout(screen, 'BREAK');
			} else if (e.kind === 'clutch') callout(screen, e.cancelled ? `CLUTCH −${e.cancelled}` : 'CLUTCH');
			else if (e.kind === 'send' && e.pass > 0) callout(screen, e.counter ? `COUNTER-SPIKE ${e.pass}` : `SENT ${e.pass}`);
			else if (e.kind === 'frostFire') callout(screen, `FROST ${e.count}`);
			else if (e.kind === 'frozenOut') callout(screen, 'FROZEN OVER');
			else if (e.kind === 'heal' && e.healed) callout(screen, 'HEALED');
		}
	}

	function onMove(action) {
		if (!core) return;
		const r = core.move(action);
		if (!r.moved && action.type === 'place' && (r.denied === 'ice' || r.denied === 'invalid')) painters[0].deny(action.ax, action.ay, action.bx, action.by);
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
				ws.send(JSON.stringify({ t: 'hello', id: myId, name: myName(), k: key || undefined, dev: device() }));
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
		if (msg.t === 'report') {
			copy(JSON.stringify(msg.r, null, 1), 'Report copied');
			return;
		}
		if (msg.t === 'err') {
			banner(msg.why === 'full' ? 'This room is full.' : 'Something went wrong: ' + msg.why);
			return;
		}
		if (msg.t === 'fz' && msg.i === core.me) net.send({ t: 'sync' }); // we were only quiet: say so
		if (msg.t === 'round' || msg.t === 'full') rules = msg.rules || rules;
		if (msg.t === 'round') lastRoundSeen = null;
		if (msg.t === 'full') $('ov-next').disabled = false;
		const events = core.handle(msg);
		// The other board's events come from the server; mine were shown when I moved.
		animate(events, 1);
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
			d.className = 'seat';
			d.innerHTML = `<span></span><span class="${s.ready ? 'ok' : 'off'}">${s.connected ? (s.ready ? 'Ready' : 'Not ready') : 'Disconnected'}</span>`;
			d.firstChild.textContent = `${s.name}${i === 0 ? ' (host)' : ''}${i === room.you ? ' · you' : ''}`;
			$('seats').appendChild(d);
		});
		if (room.seats.length < 2) {
			const d = document.createElement('div');
			d.className = 'seat';
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
		drawSettings();
	}

	function drawSettings() {
		const o = room.o || {};
		const host = room.host;
		const pre = $('presets');
		pre.innerHTML = '';
		for (const p of PRESETS) {
			const b = Object.assign(document.createElement('button'), { textContent: p.label, type: 'button', disabled: !host });
			b.addEventListener('click', () => net.send({ t: 'set', o: { ...p.set } }));
			pre.appendChild(b);
		}
		const box = $('settings');
		box.innerHTML = '';
		let group = '';
		for (const s of SETTINGS) {
			if (s.group !== group) {
				group = s.group;
				box.appendChild(Object.assign(document.createElement('h3'), { textContent: group }));
			}
			const val = s.k in o ? o[s.k] : defaultOf(s.k);
			const row = document.createElement('div');
			row.className = 'set' + (s.k in o ? ' changed' : '');
			const id = 'set-' + s.k;
			const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: s.label });
			let input;
			if (s.type === 'bool') {
				input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!val });
			} else if (s.type === 'enum') {
				input = document.createElement('select');
				for (const [v, t] of s.options) input.appendChild(Object.assign(document.createElement('option'), { value: JSON.stringify(v), textContent: t }));
				input.value = JSON.stringify(val);
			} else {
				input = Object.assign(document.createElement('input'), { type: 'number', min: s.min, max: s.max, step: s.step || 1, value: val });
			}
			input.id = id;
			input.disabled = !host;
			input.addEventListener('change', () => {
				const v = s.type === 'bool' ? input.checked : s.type === 'enum' ? JSON.parse(input.value) : Number(input.value);
				net.send({ t: 'set', o: { ...o, [s.k]: v } });
			});
			row.append(label, input);
			box.appendChild(row);
		}
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
		practice.stop();
		history.pushState(null, '', '/');
		route();
	});

	// —— Practice: everything local, nothing sent ——
	const practice = {
		bot: null,
		timer: 0,
		level: 'normal',
		start(level) {
			this.level = level;
			rules = { ...FF_RULES };
			const m = new FFMatch({ rules, seed: Math.floor(Math.random() * 1e6) + 1, target: 7 });
			m.startClock(Date.now());
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
			show('game');
			banner(null);
			$('vote').hidden = true;
			$('them-name').textContent = `${preset.label} bot`;
			$('you-name').textContent = 'You';
			this.schedule();
			render();
		},
		schedule() {
			clearTimeout(this.timer);
			const m = core && core.confirmed;
			if (!m || m.roundOver || mode !== 'practice') return;
			const p = this.preset;
			if (p.mirror) return; // Mirror moves when you do
			const ms = (p.secs * (0.6 + Math.random() * 0.8)) * 1000;
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
			if (m.over) return this.start(this.level);
			m.newRound();
			m.startClock(Date.now());
			render();
			this.schedule();
		},
		stop() {
			clearTimeout(this.timer);
			if (mode === 'practice') mode = null;
		}
	};

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
	$('practice').addEventListener('click', () => {
		store.set('vs.name', $('name').value.slice(0, 16));
		practice.start($('bot-level').value);
	});
	function go(path) {
		store.set('vs.name', $('name').value.slice(0, 16));
		history.pushState(null, '', path);
		route();
	}
	window.addEventListener('popstate', route);

	function route() {
		const r = parseRoomPath(location.pathname);
		if (!r) {
			mode = null;
			show('home');
			return;
		}
		if (!store.get('vs.name')) store.set('vs.name', 'Player' + Math.floor(Math.random() * 90 + 10));
		practice.stop();
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
	$('foot').textContent = 'Playtest build. Tell Krischan what broke.';
	route();
})();
