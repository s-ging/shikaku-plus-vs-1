// ratings.js — the quiet Glicko-2 rating on Quickplay (2026-11-16, decision 0025: "Glicko-2 runs quietly
// on every complete human match", so Competitive opens with players already roughly placed).
//
// Hidden: no player sees a rating. The matchmaker reads it to pair players by skill
// (matchmaker/pairing.js); admins can list them (/api/ratings?k=…). Nothing else uses it.
//
// Whose rating: a signed-in player's account ('u:' + account id); a guest's device ('d:' + a hash
// of the device's VS id, so the raw id, which can rejoin a seat, is never stored here).
//
// What counts: a finished Quickplay match between two humans (the queue's bots are played on the
// player's own device and never reach a room). A leaver takes the loss (decision 0025). An
// abandoned match (both gone) counts for nothing.
//
// Revisable: every rated match is kept as one small row (m:…), so rebuild() can recompute every
// rating from scratch with new constants or new rules. Changing GLICKO below and calling
// /api/ratings/rebuild is the whole migration.
//
// One match is one rating period with one game (the usual choice for online games). Between
// matches a player's uncertainty grows again with time away: one period's worth per IDLE_DAY.
//
// Pure apart from crypto.subtle (ratingKey), so test/ratings.test.js runs it in Node.

/** The constants. Changing any of them and rebuilding recomputes every rating. */
export const GLICKO = {
	rating: 1500, // where a new player starts (Glicko scale)
	rd: 350, // how unsure we are about a new player
	vol: 0.06, // how erratic a new player is
	tau: 0.5, // how fast volatility itself may change (Glickman: 0.3–1.2)
	idleDayMs: 24 * 60 * 60 * 1000 // one rating period's worth of uncertainty per day away
};
const SCALE = 173.7178;

/** A new player's rating. */
export const fresh = () => ({ r: GLICKO.rating, rd: GLICKO.rd, vol: GLICKO.vol, n: 0, at: 0 });

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** Uncertainty grown by time away, capped at a new player's. */
export function aged(p, now) {
	if (!p.at || !(now > p.at)) return p;
	const periods = (now - p.at) / GLICKO.idleDayMs;
	const phi = p.rd / SCALE;
	const grown = Math.sqrt(phi * phi + periods * p.vol * p.vol) * SCALE;
	return { ...p, rd: Math.min(GLICKO.rd, grown) };
}

/**
 * One Glicko-2 rating period (Glickman, "Example of the Glicko-2 system", 2013) for player p.
 * games: [{ o, s }] — the opponent { r, rd } and the score (1 win, 0 loss, 0.5 draw). Here a period
 * is always one match; the list form is what lets the test check Glickman's own worked example.
 */
export function update(p, games) {
	const mu = (p.r - 1500) / SCALE;
	const phi = p.rd / SCALE;
	let vInv = 0;
	let sum = 0;
	for (const { o, s } of games) {
		const muJ = (o.r - 1500) / SCALE;
		const gJ = g(o.rd / SCALE);
		const e = E(mu, muJ, o.rd / SCALE);
		vInv += gJ * gJ * e * (1 - e);
		sum += gJ * (s - e);
	}
	const v = 1 / vInv;
	const delta = v * sum;
	// Step 5: the new volatility, by the Illinois algorithm.
	const a = Math.log(p.vol * p.vol);
	const tau = GLICKO.tau;
	const f = (x) => {
		const ex = Math.exp(x);
		const d = phi * phi + v + ex;
		return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (tau * tau);
	};
	let A = a;
	let B;
	if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
	else {
		let k = 1;
		while (f(a - k * tau) < 0) k++;
		B = a - k * tau;
	}
	let fA = f(A);
	let fB = f(B);
	for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
		const C = A + ((A - B) * fA) / (fB - fA);
		const fC = f(C);
		if (fC * fB <= 0) {
			A = B;
			fA = fB;
		} else fA /= 2;
		B = C;
		fB = fC;
	}
	const vol = Math.exp(A / 2);
	const phiStar = Math.sqrt(phi * phi + vol * vol);
	const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
	const muNew = mu + phiNew * phiNew * sum;
	return { r: muNew * SCALE + 1500, rd: phiNew * SCALE, vol };
}

/**
 * The rated match in a room's report, or null if it doesn't count.
 * report: as worker/room-core.js sends it; keys: the two seats' rating keys (ratingKey).
 * Returns { at, keys: [a, b], winner: 0 | 1, score, by } — one m: row.
 */
export function ratedMatch(report, keys) {
	if (!report || report.queue !== 'quickplay' || report.result !== 'finished') return null;
	if (!Array.isArray(keys) || keys.length !== 2 || !keys[0] || !keys[1] || keys[0] === keys[1]) return null;
	const score = Array.isArray(report.score) ? report.score : null;
	let winner = null;
	if (report.forfeitBy === 0 || report.forfeitBy === 1) winner = 1 - report.forfeitBy; // the leaver takes the loss
	else if (score && score[0] !== score[1]) winner = score[0] > score[1] ? 0 : 1;
	if (winner === null) return null;
	return { at: report.endedAt || report.at || Date.now(), keys: [...keys], winner, ...(score ? { score: [...score] } : {}), ...(report.forfeitBy != null ? { by: 'forfeit' } : {}) };
}

/** Both players' new ratings after one rated match. get(key) → stored rating or undefined. */
export function applyMatch(m, get) {
	const [pa, pb] = m.keys.map((k) => aged(get(k) || fresh(), m.at));
	const sa = m.winner === 0 ? 1 : 0;
	const na = update(pa, [{ o: pb, s: sa }]);
	const nb = update(pb, [{ o: pa, s: 1 - sa }]);
	return [
		{ ...na, n: (pa.n || 0) + 1, at: m.at },
		{ ...nb, n: (pb.n || 0) + 1, at: m.at }
	];
}

/** Every rating from the match log alone, oldest first. Returns a Map key → rating. */
export function rebuild(matches) {
	const out = new Map();
	for (const m of [...matches].sort((x, y) => x.at - y.at)) {
		const [a, b] = applyMatch(m, (k) => out.get(k));
		out.set(m.keys[0], a);
		out.set(m.keys[1], b);
	}
	return out;
}

/** Whose rating: the account when signed in, else a hash of the device id (never the raw id). */
export async function ratingKey(id, uid) {
	if (typeof uid === 'string' && uid) return 'u:' + uid;
	if (typeof id !== 'string' || !id) return null;
	const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('shikaku-vs-rating:' + id));
	return 'd:' + [...new Uint8Array(h).slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A rating as the matchmaker uses it: rounded, no history. */
export const forPairing = (p) => (p ? { r: Math.round(p.r), rd: Math.round(p.rd) } : null);
