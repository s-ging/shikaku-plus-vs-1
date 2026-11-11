// dev-server.mjs — run the playtest on your own machine with no Cloudflare and no
// dependencies: `node dev-server.mjs` then open http://localhost:8787.
// Same room logic as the Worker (worker/room-core.js), rooms kept in memory.
// ADMIN_KEY=secret node dev-server.mjs  to test admin rooms (/QWER+secret).
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RoomCore } from './worker/room-core.js';
import { isRoomCode } from './shared/protocol.js';
import { summarize } from './worker/stats.js';

const PORT = Number(process.env.PORT || 8787);
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';
const rooms = new Map(); // code → { core, socks: Set }
const reports = [];
const replays = new Map(); // id → [header, round 1, round 2, …]

function roomFor(code) {
	let r = rooms.get(code);
	if (r) return r;
	r = { socks: new Set(), saved: null };
	const io = {
		send: (sock, obj) => sock.sendText(JSON.stringify(obj)),
		conns: () => [...r.socks].filter((s) => !s.closing).map((s) => ({ conn: s, id: s.id })),
		lastPing: (id) => Math.max(0, ...[...r.socks].filter((s) => s.id === id).map((s) => s.lastPing || 0)),
		save: (obj) => (r.saved = JSON.stringify(obj)),
		report: (rep) => reports.unshift(rep),
		replay: (id, part, data) => {
			if (!replays.has(id)) replays.set(id, []);
			replays.get(id)[part] = JSON.parse(JSON.stringify(data));
		}
	};
	r.core = new RoomCore(code, io, ADMIN_KEY, null);
	rooms.set(code, r);
	return r;
}

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	if (url.pathname === '/api/replay') {
		const parts = replays.get(url.searchParams.get('id') || '');
		if (!parts) return res.writeHead(404).end('not found');
		const [header, ...rounds] = parts;
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(JSON.stringify({ header, rounds: rounds.filter(Boolean) }));
	}
	if (url.pathname === '/api/stats') {
		if (url.searchParams.get('k') !== ADMIN_KEY) return res.writeHead(403).end('no');
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(JSON.stringify(summarize(reports)));
	}
	if (url.pathname === '/api/reports') {
		if (url.searchParams.get('k') !== ADMIN_KEY) return res.writeHead(403).end('no');
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(JSON.stringify(reports.slice(0, 100)));
	}
	// Any built .js in public/ by name (app.js, sound-worker.js), and /learn; every other path is the page, like Cloudflare's SPA fallback.
	const name = url.pathname.slice(1);
	// /learn is public/learn.html, as Cloudflare serves it.
	const file = /^[a-z0-9-]+\.js$/.test(name) && existsSync('public/' + name) ? 'public/' + name : name === 'learn' && existsSync('public/learn.html') ? 'public/learn.html' : 'public/index.html';
	if (!existsSync(file)) return res.writeHead(500).end('run: node build.mjs');
	res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
	res.end(readFileSync(file));
});

// A minimal WebSocket server (RFC 6455): text frames, ping/pong, close. Enough for this.
server.on('upgrade', (req, sock) => {
	const m = new URL(req.url, 'http://x').pathname.match(/^\/ws\/([A-Za-z]{4})$/);
	const code = m && m[1].toUpperCase();
	if (!code || !isRoomCode(code)) return sock.destroy();
	const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
	sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	const room = roomFor(code);
	sock.id = null;
	sock.sendText = (text) => {
		if (sock.destroyed) return;
		const body = Buffer.from(text);
		const len = body.length;
		const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255])]);
		sock.write(Buffer.concat([head, body]));
	};
	room.socks.add(sock);
	let buf = Buffer.alloc(0);
	const close = () => {
		if (sock.closing) return;
		sock.closing = true;
		if (sock.id) room.core.closed(sock.id, Date.now());
		room.socks.delete(sock);
		sock.destroy();
	};
	sock.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 2) {
			const op = buf[0] & 15;
			let len = buf[1] & 127;
			let off = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				off = 10;
			}
			const masked = buf[1] & 128;
			if (buf.length < off + (masked ? 4 : 0) + len) return;
			const mask = masked ? buf.subarray(off, off + 4) : null;
			off += masked ? 4 : 0;
			const data = Buffer.from(buf.subarray(off, off + len));
			if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
			buf = buf.subarray(off + len);
			if (op === 8) return close();
			if (op === 9) {
				sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
				continue;
			}
			if (op !== 1) continue;
			if (data.toString() === 'ping') {
				sock.lastPing = Date.now();
				sock.sendText('pong'); // what Cloudflare's auto-response does
				continue;
			}
			let msg;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				continue;
			}
			const now = Date.now();
			if (msg.t === 'hello') {
				if (typeof msg.id !== 'string' || !/^[a-z0-9]{8,32}$/.test(msg.id)) return close();
				sock.id = msg.id;
				const ok = room.core.hello(msg.id, msg, now);
				if (ok !== true) {
					// 'full' or 'update': close with that reason, as the Worker does, so the client doesn't retry.
					const why = Buffer.from(String(ok));
					sock.write(Buffer.concat([Buffer.from([0x88, why.length + 2, 0x03, 0xe8]), why]));
					sock.id = null;
					return close();
				}
			} else if (sock.id) room.core.message(sock.id, msg, now);
			if (process.env.DEBUG) console.log(code, sock.id, msg.t, JSON.stringify(room.core.seats.map((x) => [x.connected, x.left, x.goneFrom, x.goneRound])), JSON.stringify(room.core.vote));
		}
	});
	sock.on('close', () => { if (process.env.DEBUG) console.log(code, sock.id, 'CLOSE'); close(); });
	sock.on('error', close);
});

server.listen(PORT, () => console.log(`Shikaku+ VS playtest on http://localhost:${PORT}  (admin key: ${ADMIN_KEY})`));
