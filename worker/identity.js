// identity.js — who a player is, from their Shikaku+ account (2026-11-11, decision 0017).
//
// The app sends its Supabase access token in hello (tok). The Worker checks it here, on
// its own: Supabase signs tokens with an ES256 key whose public half is published at
// <SUPABASE_URL>/auth/v1/.well-known/jwks.json, so checking needs no secret and no library,
// only WebCrypto. A good token gives the account id (sub); the name and badge then come
// from the public get_public_profile RPC, so a player can't claim someone else's name.
// Anything wrong (no token, bad signature, expired, network trouble) gives null: the
// player joins as a guest with the name they typed, never refused.
//
// Cost (the optimization rule): per join, one signature check (well under 1ms) and, unless
// cached, one profile request (~50ms, off the game's path: it only delays that player's
// seat). The key list is fetched once per 10 minutes per Worker instance; profiles are
// cached 10 minutes per account. Nothing runs between joins.
//
// Pure apart from the fetch it's given, so test/identity.test.js runs it in Node.

const KEYS_TTL_MS = 10 * 60 * 1000;
const KEYS_RETRY_MS = 60 * 1000; // an unknown key id refetches the list at most this often
const PROFILE_TTL_MS = 10 * 60 * 1000;
const PROFILE_CACHE_MAX = 500;
const SKEW_S = 60; // a phone's clock may be a little off; so may ours
export const NAME_MAX_VERIFIED = 32; // user_profiles.display_name allows 1–32 characters

const b64url = (s) => {
	const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
	const out = new Uint8Array(b.length);
	for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
	return out;
};
const json = (part) => JSON.parse(new TextDecoder().decode(b64url(part)));

/** An account name as stored, minus control characters, at most 32 characters. */
export const cleanVerifiedName = (s) =>
	[...String(s || '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, NAME_MAX_VERIFIED).join('') || null;
/** Badge ids are short lowercase words (badge_catalog). Anything else is dropped. */
export const cleanBadge = (b) => (typeof b === 'string' && /^[a-z0-9_]{1,40}$/.test(b) ? b : null);

export class Identity {
	/**
	 * url: the Supabase project URL. anonKey: its public anon key (it ships in every app build).
	 * fetch / now: injected so tests can run without a network or a real clock.
	 */
	constructor({ url, anonKey, fetch = globalThis.fetch.bind(globalThis), now = () => Date.now() }) {
		this.url = String(url).replace(/\/+$/, '');
		this.anonKey = anonKey;
		this.fetch = fetch;
		this.now = now;
		this.keys = new Map(); // kid → CryptoKey
		this.keysAt = 0;
		this.keysTriedAt = 0;
		this.profiles = new Map(); // sub → { at, name, badge }
	}

	/** { uid, name, badge } for a good token, else null. Never throws. */
	async who(token) {
		try {
			const sub = await this.verify(token);
			if (!sub) return null;
			const p = await this.profile(sub);
			return { uid: sub, name: p ? p.name : null, badge: p ? p.badge : null };
		} catch {
			return null;
		}
	}

	/** The account id (sub) if the token is a good, current Supabase user token; else null. */
	async verify(token) {
		if (typeof token !== 'string' || token.length > 8000) return null;
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const head = json(parts[0]);
		if (head.alg !== 'ES256' || typeof head.kid !== 'string') return null;
		const key = await this._key(head.kid);
		if (!key) return null;
		const ok = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			key,
			b64url(parts[2]),
			new TextEncoder().encode(parts[0] + '.' + parts[1])
		);
		if (!ok) return null;
		const c = json(parts[1]);
		const t = this.now() / 1000;
		if (!(typeof c.exp === 'number' && c.exp > t - SKEW_S)) return null;
		if (typeof c.nbf === 'number' && c.nbf > t + SKEW_S) return null;
		if (c.iss !== this.url + '/auth/v1') return null;
		const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
		if (!aud.includes('authenticated') || c.role !== 'authenticated') return null;
		return typeof c.sub === 'string' && /^[0-9a-f-]{36}$/.test(c.sub) ? c.sub : null;
	}

	async _key(kid) {
		const t = this.now();
		const fresh = t - this.keysAt < KEYS_TTL_MS;
		if (fresh && this.keys.has(kid)) return this.keys.get(kid);
		// Stale list, or a key we haven't seen (Supabase rotated): refetch, but not in a loop.
		if (fresh && t - this.keysTriedAt < KEYS_RETRY_MS) return null;
		this.keysTriedAt = t;
		const res = await this.fetch(this.url + '/auth/v1/.well-known/jwks.json');
		if (!res.ok) return this.keys.get(kid) || null;
		const { keys = [] } = await res.json();
		const next = new Map();
		for (const k of keys) {
			if (k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.kid !== 'string') continue;
			try {
				const jwk = { kty: k.kty, crv: k.crv, x: k.x, y: k.y };
				next.set(k.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
			} catch {
				/* a key we can't read: skip it */
			}
		}
		this.keys = next;
		this.keysAt = t;
		return next.get(kid) || null;
	}

	/** { name, badge } from the account's public profile (cached), or null. */
	async profile(sub) {
		const t = this.now();
		const hit = this.profiles.get(sub);
		if (hit && t - hit.at < PROFILE_TTL_MS) return hit;
		const res = await this.fetch(this.url + '/rest/v1/rpc/get_public_profile', {
			method: 'POST',
			headers: { apikey: this.anonKey, authorization: 'Bearer ' + this.anonKey, 'content-type': 'application/json' },
			body: JSON.stringify({ p_user_id: sub })
		});
		if (!res.ok) return null;
		const rows = await res.json();
		const row = Array.isArray(rows) ? rows[0] : rows;
		if (!row) return null;
		const p = { at: t, name: cleanVerifiedName(row.display_name), badge: cleanBadge(row.active_badge_id) };
		if (this.profiles.size >= PROFILE_CACHE_MAX) this.profiles.delete(this.profiles.keys().next().value);
		this.profiles.set(sub, p);
		return p;
	}
}
