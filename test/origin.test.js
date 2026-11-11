import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed } from '../worker/origin.js';

test('origin: our pages and the app may open a room; other sites may not', () => {
	for (const o of [
		null,
		'',
		'https://shikaku.plus',
		'https://www.shikaku.plus',
		'https://vs.shikaku.plus',
		'https://shikaku-plus.pages.dev',
		'https://staging.shikaku-plus.pages.dev',
		'https://3f2a1b.shikaku-plus.pages.dev',
		'http://localhost:8787',
		'http://localhost',
		'http://127.0.0.1:5000'
	])
		assert.ok(originAllowed(o), `${o} should be allowed`);
	for (const o of [
		'https://evil.com',
		'https://shikaku.plus.evil.com',
		'https://evilshikaku.plus',
		'http://shikaku.plus',
		'https://shikaku-plus.pages.dev.evil.com',
		'https://notshikaku-plus.pages.dev',
		'https://other-app.someone.workers.dev',
		'https://evil-shikaku-plus-vs-1.someone.workers.dev.evil.com',
		'https://a.b-shikaku-plus-vs-1.someone.workers.dev',
		'https://shikaku-plus-vs-1.someone.workers.dev', // anyone can name a Worker this
		'https://localhost.evil.com',
		'null',
		'file://'
	])
		assert.ok(!originAllowed(o), `${o} should be refused`);
});
