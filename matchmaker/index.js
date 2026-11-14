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
// Messages, client → queue:  { t: 'queue', id, pv, input? }   once, right after connecting
//           queue → client:  { t: 'q', say }                   text for the searching screen
//                            { t: 'match', code, tk, division } then the queue closes with 'matched'
//                            { t: 'err', why: 'update' }        then closes with 'update'
// Close reasons the client acts on: 'matched', 'replaced' (the same browser queued again
// elsewhere), 'update' (client too old).
import { newRoomCode, helloVersion, MIN_PROTOCOL_VERSION } from '../shared/protocol.js';
import { QUEUE_DIVISIONS, INPUTS, pickPair, newTicket, cryptoRand } from './pairing.js';

const MAX_MSG = 1024;
const RESERVE_TRIES = 5; // a code already in use is refused by its room; try another
const SAY = {
	searching: 'Searching for a player…',
	busy: 'Still searching…'
};

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

	/** Everyone waiting, from the sockets themselves: the line survives hibernation with no storage. */
	_waiting() {
		return this.ctx
			.getWebSockets()
			.filter((s) => s.readyState === 1)
			.map((sock) => ({ sock, ...(sock.deserializeAttachment() || {}) }))
			.filter((e) => e.state === 'waiting');
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
		if (msg.t !== 'queue' || att.id) return; // one join per socket; nothing else is said here
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
		sock.serializeAttachment({ ...att, id: msg.id, at: Date.now(), input, state: 'waiting' });
		send(sock, { t: 'q', say: SAY.searching });
		await this._pair(att.division);
	}

	async _pair(division) {
		for (;;) {
			const pair = pickPair(this._waiting());
			if (!pair) return;
			// Out of the line before the await, so a message arriving meanwhile can't pair them again.
			for (const e of pair) e.sock.serializeAttachment({ ...e.sock.deserializeAttachment(), state: 'paired' });
			const seats = pair.map((e) => ({ id: e.id, tk: newTicket(this.rand) }));
			const code = await this._reserve(division, seats);
			if (!code) {
				// The rooms didn't answer: back in line, same place, and stop for now.
				for (const e of pair) {
					if (e.sock.readyState !== 1) continue;
					e.sock.serializeAttachment({ ...e.sock.deserializeAttachment(), state: 'waiting' });
					send(e.sock, { t: 'q', say: SAY.busy });
				}
				return;
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
