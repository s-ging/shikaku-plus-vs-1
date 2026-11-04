// index.js — the Cloudflare Worker: static files, one Durable Object per room, one for reports.
//
//   /ws/QWER          WebSocket into room QWER (the Room object named "QWER")
//   /api/reports?k=…  admin: recent match reports (k must equal the ADMIN_KEY secret)
//   everything else   static client files; unknown paths (like /QWER) get index.html
//
// Rooms use the WebSocket Hibernation API: while nobody sends anything, the object
// can sleep and costs nothing; it wakes on the next message and reloads from storage.
import { RoomCore } from './room-core.js';
import { isRoomCode } from '../shared/protocol.js';

const MAX_MSG = 2048; // bytes; every real message is far smaller
const MAX_PER_SEC = 40; // per socket; a human makes at most a few moves a second

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const ws = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
		if (ws) {
			const code = ws[1].toUpperCase();
			if (!isRoomCode(code)) return new Response('bad room', { status: 400 });
			if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
			const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
			return stub.fetch(new Request(`https://room/${code}`, req));
		}
		if (url.pathname === '/api/reports') {
			if (!env.ADMIN_KEY || url.searchParams.get('k') !== env.ADMIN_KEY) return new Response('no', { status: 403 });
			return env.REPORTS.get(env.REPORTS.idFromName('all')).fetch('https://reports/list');
		}
		return env.ASSETS.fetch(req);
	}
};

export class Room {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.core = null;
		this.closing = null;
		this.rate = new WeakMap();
		// Heartbeat answered by Cloudflare itself: a 'ping' gets 'pong' without waking this
		// object, so idle heartbeats cost no Durable Object time. We read the time of each
		// socket's last ping lazily, when something real arrives.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	async _load(code) {
		if (this.core) return this.core;
		const saved = await this.ctx.storage.get('room');
		const io = {
			send: (sock, obj) => {
				try {
					sock.send(JSON.stringify(obj));
				} catch {
					/* socket already gone */
				}
			},
			conns: () =>
				this.ctx
					.getWebSockets()
					.filter((s) => s !== this.closing)
					.map((s) => ({ conn: s, id: s.deserializeAttachment()?.id || null })),
			save: (obj) => this.ctx.storage.put('room', obj),
			lastPing: (id) => {
				let t = 0;
				for (const s of this.ctx.getWebSockets()) {
					if (s.deserializeAttachment()?.id !== id) continue;
					const d = this.ctx.getWebSocketAutoResponseTimestamp(s);
					if (d && d.getTime() > t) t = d.getTime();
				}
				return t;
			},
			report: (r) => this.env.REPORTS.get(this.env.REPORTS.idFromName('all')).fetch('https://reports/add', { method: 'POST', body: JSON.stringify(r) })
		};
		this.core = new RoomCore(saved?.code || code, io, this.env.ADMIN_KEY, saved);
		return this.core;
	}

	async fetch(req) {
		const code = new URL(req.url).pathname.slice(1);
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ id: null, code });
		await this._load(code);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(sock, data) {
		if (typeof data !== 'string' || data.length > MAX_MSG) return;
		// Cheap flood guard, per socket per second.
		const sec = Math.floor(Date.now() / 1000);
		const r = this.rate.get(sock);
		if (r && r.sec === sec) {
			if (++r.n > MAX_PER_SEC) return;
		} else this.rate.set(sock, { sec, n: 1 });
		let msg;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		const att = sock.deserializeAttachment() || {};
		const core = await this._load(att.code);
		const now = Date.now();
		if (msg.t === 'hello') {
			if (typeof msg.id !== 'string' || !/^[a-z0-9]{8,32}$/.test(msg.id)) return sock.close(1008, 'bad id');
			sock.serializeAttachment({ ...att, id: msg.id });
			if (!core.hello(msg.id, msg, now)) sock.close(1000, 'full');
			return;
		}
		if (att.id) core.message(att.id, msg, now);
	}

	async webSocketClose(sock) {
		const att = sock.deserializeAttachment() || {};
		const core = await this._load(att.code);
		this.closing = sock;
		if (att.id) core.closed(att.id, Date.now());
		this.closing = null;
	}

	async webSocketError(sock) {
		return this.webSocketClose(sock);
	}
}

/** Keeps the last 500 match reports for the admin list. One write per finished match. */
export class Reports {
	constructor(ctx) {
		this.ctx = ctx;
	}
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === '/add' && req.method === 'POST') {
			const r = await req.json();
			const key = `r:${String(Date.now()).padStart(15, '0')}:${r.code || ''}`;
			await this.ctx.storage.put(key, r);
			const old = await this.ctx.storage.list({ prefix: 'r:', limit: 50 });
			const total = (await this.ctx.storage.list({ prefix: 'r:' })).size;
			if (total > 500) await this.ctx.storage.delete([...old.keys()].slice(0, total - 500));
			return new Response('ok');
		}
		if (url.pathname === '/list') {
			const list = await this.ctx.storage.list({ prefix: 'r:', reverse: true, limit: 100 });
			return Response.json([...list.values()]);
		}
		return new Response('not found', { status: 404 });
	}
}
