// build.mjs — makes public/ (what Cloudflare serves): index.html and one app.js.
// No dependencies. The engine modules are stitched into one classic script, so the
// page is two requests total. If esbuild is installed (npm i -D esbuild on your
// machine), app.js is also down-levelled to ES2017 and minified, so older browsers
// (iOS 12, old Android Chrome) can run it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const strip = (src) =>
	src
		.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
		.replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '')
		.replace(/^export\s+(?=(const|function|class|let|async))/gm, '');

const files = [
	'engine/puzzle.js',
	'engine/game.js',
	'engine/economy.js',
	'engine/match.js',
	'engine/fusefrost.js',
	'engine/ffmatch.js',
	'shared/settings.js',
	'shared/protocol.js',
	'shared/client-core.js',
	'client/board.js',
	'client/ui.js'
];
mkdirSync('public', { recursive: true });
const js = '"use strict";\n' + files.map((f) => `// ===== ${f} =====\n` + strip(readFileSync(f, 'utf8'))).join('\n');
writeFileSync('public/app.js', js);
writeFileSync('public/index.html', readFileSync('client/index.html', 'utf8'));

let note = '(not minified: install esbuild to down-level and minify)';
if (existsSync('node_modules/.bin/esbuild')) {
	execFileSync('node_modules/.bin/esbuild', ['public/app.js', '--minify', '--target=es2017,safari12', '--outfile=public/app.js', '--allow-overwrite'], { stdio: 'inherit' });
	note = '(ES2017, minified)';
}
const kb = (f) => (readFileSync(f).length / 1024).toFixed(1);
console.log(`public/index.html ${kb('public/index.html')} KB, public/app.js ${kb('public/app.js')} KB ${note}`);
