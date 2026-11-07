// build.mjs — makes public/ (what Cloudflare serves): index.html and one app.js.
// No dependencies. The engine modules are stitched into one classic script, so the
// page is two requests total. If esbuild is installed (npm i -D esbuild on your
// machine), app.js is also down-levelled to ES2017 and minified, so older browsers
// (iOS 12, old Android Chrome) can run it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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
	'engine/versus.js',
	'engine/versus-match.js',
	'shared/settings.js',
	'shared/protocol.js',
	'shared/client-core.js',
	'shared/replay.js',
	'shared/sound/synth.js',
	'shared/sound/pack.js',
	'client/sound.js',
	'client/hud.js',
	'client/ui.js'
];
mkdirSync('public', { recursive: true });
// The base sound pack goes inline (no extra request): sounds/base.json, checked and
// trimmed to what the game renders. Replace that file with a pack from the Sound Lab to
// change the sounds.
const { SoundPack } = await import('./shared/sound/pack.js');
// VS doesn't play the other modes' sounds (the lab's "Whole game, later" group): they stay out of the download.
const NOT_IN_VS = ['perfect', 'timeLow', 'timeUp', 'badge'];
const packRead = SoundPack.read(readFileSync('sounds/base.json', 'utf8'), { skip: NOT_IN_VS });
if (!packRead.ok) throw new Error('sounds/base.json: ' + packRead.errors.join(', '));
const models = SoundPack.smooth(packRead.pack.models);
const soundPack = { format: 'shikaku-sound-pack', version: 1, sampleRate: 48000, pack: { sounds: packRead.pack.sounds }, models };
const js = '"use strict";\nconst SOUND_PACK = ' + JSON.stringify(soundPack) + ";\nconst SOUND_WORKER_URL = '/sound-worker.js';\n" + files.map((f) => `// ===== ${f} =====\n` + strip(readFileSync(f, 'utf8'))).join('\n');
writeFileSync('public/app.js', js);
// The background renderer: the synth plus a few lines of messaging (client/sound-worker.js).
writeFileSync('public/sound-worker.js', '"use strict";\n' + ['shared/sound/synth.js', 'client/sound-worker.js'].map((f) => `// ===== ${f} =====\n` + strip(readFileSync(f, 'utf8'))).join('\n'));

writeFileSync('public/index.html', readFileSync('client/index.html', 'utf8'));
// The tutorial: one self-contained page at /learn (tutorial/build.mjs stitches it together).
await import('./tutorial/build.mjs');
writeFileSync('public/learn.html', readFileSync('tutorial/dist/vs-tutorial.html'));

// esbuild's JS API, not its CLI: the CLI shim is esbuild.cmd on Windows, so
// spawning node_modules/.bin/esbuild there fails with ENOENT.
let note = '(not minified: install esbuild to down-level and minify)';
const esbuild = await import('esbuild').catch(() => null);
if (esbuild) {
	for (const f of ['public/app.js', 'public/sound-worker.js'])
		esbuild.buildSync({ entryPoints: [f], outfile: f, allowOverwrite: true, minify: true, target: ['es2017'], logLevel: 'warning' });
	note = '(ES2017, minified)';
}
const kb = (f) => (readFileSync(f).length / 1024).toFixed(1);
console.log(`public/index.html ${kb('public/index.html')} KB, public/learn.html ${kb('public/learn.html')} KB, public/app.js ${kb('public/app.js')} KB, public/sound-worker.js ${kb('public/sound-worker.js')} KB ${note}`);
