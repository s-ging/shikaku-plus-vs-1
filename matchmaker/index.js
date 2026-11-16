// index.js — the matchmaker: its own Worker (shikaku-plus-mm), deployed apart from the rooms.
//
// Why apart (2026-11-14): deploying a Worker restarts its Durable Objects, which drops their
// WebSockets. Tuning the queue must never drop live matches, so the queues live here and the
// rooms stay in shikaku-plus-vs-1. Deploying this Worker touches no room.
//
//   vs.shikaku.plus/ws/queue/standard   ─┐ vs-1's Worker checks the Origin, then passes the
//   vs.shikaku.plus/ws/queue/knockout   ─┘ request here through its MM service binding.
//
// This Worker has no public address (workers_dev off, no routes): only vs-1 can reach it.
// One Queue object per division. Players wait on a hibernating WebSocket (idle costs nothing).
// When two are waiting, the Queue reserves a fresh room in vs-1 (cross-script binding ROOMS),
// with the queue's settings locked and a one-time ticket per seat, then sends each player
// { t: 'match', code, tk }. They connect to /ws/CODE like any room; everything after that
// (holds, replays, reports) is the room's own code.
//
// Messages, client → queue:  { t: 'queue', id, pv, input?, tok? }  once, right after connecting
//                                (tok: a signed-in player's account token, for whose rating it is)
//                            { t: 'bot' }    took the offered bot: out of the line while it plays
//                            { t: 'free' }   the bot match is over: back in line, same place
//           queue → client:  { t: 'q', say, next? }        text for the searching screen
//                                (next: true when a player is waiting for this one's bot match to end)
//                            { t: 'bot', level, label, say } a bot is offered (decision 0025, ~2 min)
//                            { t: 'match', code, tk, division } then the queue closes with 'matched'
//                            { t: 'err', why: 'update' }        then closes with 'update'
// Close reasons the client acts on: 'matched', 'replaced' (the same browser queued again
// elsewhere), 'update' (client too old).
//
// Pairing is by the quiet rating (2026-11-16, pairing.js): read once per join from vs-1's Reports
// object (cross-script binding REPORTS). The one timer is a Durable Object alarm, set only while
// someone waits, for the next moment something can change (a pair becomes possible, a bot is due).
import { newRoomCode, helloVersion, MIN_PROTOCOL_VERSION } from '../shared/protocol.js';
import { QUEUE_DIVISIONS, INPUTS, pickPair, nextWake, botFor, BOT_AFTER_MS, newTicket, cryptoRand } from './pairing.js';
import { Identity } from '../worker/identity.js';
import { ratingKey } from '../worker/ratings.js';

const MAX_MSG = 8192; // the join may carry an account token, which can pass 2KB
const ROOMS_RETRY_MS = 5000; // the rooms didn't answer: try that pair again this much later
const RATING_LOOKUP_MS = 1500; // a slow lookup pairs the player as new rather than keep them waiting
const RESERVE_TRIES = 5; // a code already in use is refused by its room; try another
const SAY = {
	searching: 'Searching for a player…',
	busy: 'Still searching…',
	bot: 'No one yet. Play a bot while we keep looking?',
	playing: 'Playing a bot. Still looking for a player…',
	next: 'A player is waiting. You meet them after this match.'
};

// Account checks (worker/identity.js), only the signature: the name and badge are the room's business.
let identity = null;
const identityFor = (env) => (env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? (identity ||= new Identity({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY })) : null);

export default {
	async fetch(req, env) {
		const m = new URL(req.url).pathname.match(/^\/ws\/queue\/([a-z]+)$/);
		if (!m || !QUEUE_DIVISIONS.includes(m[1])) return new Response('not found', { status: 404 });
		if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
		const stub = env.QUEUE.get(env.QUEUE.idFromName(m[1]));
		return stub.fetch(new Request('https://queue/' + m[1], req));
	}
};

const send = (sock, obj) => {
	try {
		sock.send(JSON.stringify(obj));
	} catch {
		/* already gone */
	}
};

export class Queue {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.rand = cryptoRand;
		this.botAfterMs = BOT_AFTER_MS; // the dev server can shorten it (BOT_AFTER_S) to try the bot without waiting
		// The client's heartbeat, answered by Cloudflare without waking this object.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async fetch(req) {
		const division = new URL(req.url).pathname.slice(1);
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ division });
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Everyone in line, from the sockets themselves: the line survives hibernation with no storage. */
	_entries() {
		return this.ctx
			.getWebSockets()
			.filter((s) => s.readyState === 1)
			.map((sock) => ({ sock, ...(sock.deserializeAttachment() || {}) }))
			.filter((e) => e.id);
	}
	_waiting() {
		return this._entries().filter((e) => e.state === 'waiting');
	}
	_patch(sock, change) {
		sock.serializeAttachment({ ...(sock.deserializeAttachment() || {}), ...change });
	}

	async webSocketMessage(sock, data) {
		if (typeof data !== 'string' || data.length > MAX_MSG) return;
		let msg;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		const att = sock.deserializeAttachment() || {};
		if (att.id) return this._after(sock, att, msg);
		if (msg.t !== 'queue') return; // the join comes first
		if (typeof msg.id !== 'string' || !/^[a-z0-9]{8,32}$/.test(msg.id)) return sock.close(1008, 'bad id');
		if (helloVersion(msg) < MIN_PROTOCOL_VERSION) {
			send(sock, { t: 'err', why: 'update', min: MIN_PROTOCOL_VERSION });
			return sock.close(1000, 'update');
		}
		// One place in line per browser: a second tab takes it over.
		for (const s of this.ctx.getWebSockets()) {
			if (s !== sock && (s.deserializeAttachment() || {}).id === msg.id) {
				try {
					s.close(1000, 'replaced');
				} catch {}
			}
		}
		const input = INPUTS.has(msg.input) ? msg.input : null;
		sock.serializeAttachment({ ...att, id: msg.id, at: Date.now(), input, state: 'joining' });
		send(sock, { t: 'q', say: SAY.searching });
		const rating = await this._rating(msg.id, typeof msg.tok === 'string' ? msg.tok : null);
		if (sock.readyState !== 1) return;
		// bot: rejoining after a drop mid-bot-match; stays out of pairing until it says 'free'.
		this._patch(sock, msg.bot === true ? { rating, state: 'bot', offered: true } : { rating, state: 'waiting' });
		await this._tick(att.division);
	}

	/** After joining: taking the offered bot, and coming back from it. */
	async _after(sock, att, msg) {
		if (msg.t === 'bot' && att.state === 'waiting' && att.offered) {
			this._patch(sock, { state: 'bot', told: false });
			send(sock, { t: 'q', say: SAY.playing });
			return this._tick(att.division);
		}
		if (msg.t === 'free' && att.state === 'bot') {
			// Back in line at the same place (the original join time), and offered a bot again if no one's here.
			this._patch(sock, { state: 'waiting', offered: false, told: false });
			send(sock, { t: 'q', say: SAY.busy });
			return this._tick(att.division);
		}
	}

	/** The player's quiet rating, or null (new, signed out of the lookup, or the lookup was slow). */
	async _rating(id, tok) {
		if (!this.env.REPORTS) return null;
		try {
			let uid = null;
			const ident = tok ? identityFor(this.env) : null;
			if (ident) uid = await ident.verify(tok);
			const key = await ratingKey(id, uid);
			const stub = this.env.REPORTS.get(this.env.REPORTS.idFromName('all'));
			const r = await Promise.race([stub.fetch('https://reports/ratings?keys=' + encodeURIComponent(key)), new Promise((res) => setTimeout(() => res(null), RATING_LOOKUP_MS))]);
			if (!r || r.status !== 200) return null;
			const got = (await r.json())[key];
			return got && Number.isFinite(got.r) ? { r: got.r, rd: got.rd } : null;
		} catch {
			return null;
		}
	}

	/** Pair whoever can be paired, offer bots that are due, tell bot players someone waits, set the next alarm. */
	async _tick(division) {
		division ||= (this._entries()[0] || {}).division;
		const ok = await this._pair(division);
		const now = Date.now();
		const waiting = this._waiting();
		for (const e of waiting) {
			if (e.offered || now - e.at < this.botAfterMs) continue;
			this._patch(e.sock, { offered: true });
			send(e.sock, { t: 'bot', ...botFor(e), say: SAY.bot });
		}
		if (waiting.length) {
			for (const e of this._entries()) {
				if (e.state !== 'bot' || e.told) continue;
				this._patch(e.sock, { told: true });
				send(e.sock, { t: 'q', say: SAY.next, next: true });
			}
		}
		const wake = nextWake(this._waiting(), now, this.botAfterMs);
		try {
			if (wake == null) await this.ctx.storage?.deleteAlarm?.();
			else await this.ctx.storage?.setAlarm?.(Math.max(wake, Date.now() + (ok ? 250 : ROOMS_RETRY_MS)));
		} catch {
			/* no alarms (tests, dev server): pairing still runs on every join */
		}
	}

	async alarm() {
		await this._tick(null);
	}

	async _pair(division) {
		for (;;) {
			const pair = pickPair(this._waiting(), Date.now());
			if (!pair) return true;
			// Out of the line before the await, so a message arriving meanwhile can't pair them again.
			for (const e of pair) this._patch(e.sock, { state: 'paired' });
			const seats = pair.map((e) => ({ id: e.id, tk: newTicket(this.rand) }));
			const code = await this._reserve(division, seats);
			if (!code) {
				// The rooms didn't answer: back in line, same place, and stop for now.
				for (const e of pair) {
					if (e.sock.readyState !== 1) continue;
					this._patch(e.sock, { state: 'waiting' });
					send(e.sock, { t: 'q', say: SAY.busy });
				}
				return false;
			}
			pair.forEach((e, i) => {
				send(e.sock, { t: 'match', code, tk: seats[i].tk, division });
				try {
					e.sock.close(1000, 'matched');
				} catch {}
			});
		}
	}

	/** A fresh room in vs-1 with both seats reserved, or null. */
	async _reserve(division, seats) {
		for (let k = 0; k < RESERVE_TRIES; k++) {
			const code = newRoomCode(this.rand);
			try {
				const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(code));
				const r = await room.fetch(`https://room/${code}/reserve`, { method: 'POST', body: JSON.stringify({ division, seats }) });
				if (r.status === 200) return code;
			} catch {
				/* that room didn't answer: try another code */
			}
		}
		return null;
	}

	async webSocketClose() {
		/* nothing to clean up: a closed socket simply isn't in getWebSockets() any more */
	}

	async webSocketError() {}
}
