// stats.js — adds up every stored match report for /api/stats. Pure: reports in, one summary out.
// Runs only when an admin asks; nothing is kept up to date in between.

const median = (xs) => {
	const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
	return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
};
const pct = (xs, f) => {
	const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
	return a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : null;
};
const day = (ms) => (Number.isFinite(ms) ? new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) : 'unknown'); // PHT, the game's clock

export function summarize(reports) {
	const out = {
		generatedAt: new Date().toISOString(),
		matches: { total: 0, finished: 0, abandoned: 0, byMode: {}, byFirstTo: {}, perDayPHT: {} },
		rounds: { total: 0, endedBy: {}, lengthSec: {}, boardsPerPlayer: {}, boardsLostToFreezing: 0, remakeVotes: 0 },
		network: { phone: null, desktop: null, mismatches: 0, resyncs: 0, reconnects: 0, disconnectedSec: 0 },
		pace: { secondsPerMove: null, firstMoveOnABoardSec: null },
		settingsChanged: {},
		testers: { unique: 0, list: [] }
	};
	const lengths = [];
	const boards = [];
	const net = { phone: { p50: [], p95: [], max: [], n: 0 }, desktop: { p50: [], p95: [], max: [], n: 0 } };
	const paces = [];
	const firsts = [];
	const testers = new Map();
	for (const r of reports || []) {
		if (!r || typeof r !== 'object') continue;
		const m = out.matches;
		m.total++;
		if (r.result === 'finished' || r.endedAt) m.finished++;
		else m.abandoned++;
		const mode = r.mode || (r.o && r.o.mode) || 'vs';
		m.byMode[mode] = (m.byMode[mode] || 0) + 1;
		const ft = r.firstTo || (r.o && r.o.firstTo) || 7;
		m.byFirstTo[ft] = (m.byFirstTo[ft] || 0) + 1;
		const d = day(r.startedAt);
		m.perDayPHT[d] = (m.perDayPHT[d] || 0) + 1;
		for (const k of Object.keys(r.o || {})) out.settingsChanged[k] = (out.settingsChanged[k] || 0) + 1;
		out.rounds.remakeVotes += (r.votes || []).length;
		for (const rd of r.rounds || []) {
			out.rounds.total++;
			out.rounds.endedBy[rd.by || 'unknown'] = (out.rounds.endedBy[rd.by || 'unknown'] || 0) + 1;
			if (Number.isFinite(rd.ms)) lengths.push(rd.ms / 1000);
			for (const b of rd.boards || []) boards.push(b);
			for (const f of rd.frozenOut || []) out.rounds.boardsLostToFreezing += f || 0;
		}
		for (const s of r.seats || []) {
			const kind = s.dev && s.dev.touch ? 'phone' : 'desktop';
			const tele = (s.tele || []).at(-1); // client telemetry is cumulative per match: the last one has it all
			if (tele && tele.rttMs && tele.rttMs.n) {
				net[kind].p50.push(tele.rttMs.p50);
				net[kind].p95.push(tele.rttMs.p95);
				net[kind].max.push(tele.rttMs.max);
				net[kind].n++;
			}
			if (tele) {
				out.network.mismatches += tele.mismatches || 0;
				out.network.resyncs += tele.resyncs || 0;
			}
			out.network.reconnects += s.reconnects || 0;
			out.network.disconnectedSec += Math.round((s.disconnectedMs || 0) / 1000);
			if (s.moves && s.moves.n > 5) {
				paces.push(s.moves.meanMs / 1000);
				if (Number.isFinite(s.moves.firstMoveOnBoardMs)) firsts.push(s.moves.firstMoveOnBoardMs / 1000);
			}
			if (s.tester) {
				const t = testers.get(s.tester) || { tester: s.tester, names: [], matches: 0, firstSeen: r.startedAt, lastSeen: r.startedAt, device: kind };
				t.matches++;
				if (s.name && !t.names.includes(s.name)) t.names.push(s.name);
				t.firstSeen = Math.min(t.firstSeen, r.startedAt);
				t.lastSeen = Math.max(t.lastSeen, r.startedAt);
				testers.set(s.tester, t);
			}
		}
	}
	out.rounds.lengthSec = { median: median(lengths), p90: pct(lengths, 0.9) };
	out.rounds.boardsPerPlayer = { median: median(boards), p90: pct(boards, 0.9) };
	for (const k of ['phone', 'desktop'])
		out.network[k] = net[k].n ? { players: net[k].n, typicalPingMs: median(net[k].p50), p95PingMs: median(net[k].p95), worstPingMs: Math.max(...net[k].max) } : null;
	out.pace = { secondsPerMove: median(paces), firstMoveOnABoardSec: median(firsts) };
	out.testers.list = [...testers.values()]
		.sort((a, b) => b.lastSeen - a.lastSeen)
		.map((t) => ({ ...t, firstSeen: new Date(t.firstSeen).toISOString(), lastSeen: new Date(t.lastSeen).toISOString() }));
	out.testers.unique = out.testers.list.length;
	return out;
}
