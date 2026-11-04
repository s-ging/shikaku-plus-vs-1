// tutorial/build.mjs — one self-contained tutorial page: engine + the shared screen + the steps.
//   node tutorial/build.mjs [copy-to.html]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const strip = (src) =>
	src
		.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
		.replace(/^export\s+(?=(const|function|class|let|async))/gm, '');
const engine = ['puzzle.js', 'game.js', 'economy.js', 'match.js', 'versus.js', 'versus-match.js'].map((f) => join(here, '..', 'engine', f));
const files = [...engine, join(here, '..', 'client', 'hud.js'), join(here, 'steps.js')];
const mods = files.map((f) => `// ===== ${f.split('/').slice(-2).join('/')} =====\n` + strip(readFileSync(f, 'utf8'))).join('\n');
const html = `${readFileSync(join(here, 'page.html'), 'utf8')}\n<script>\n${mods}\n</script>\n<script>\n${readFileSync(join(here, 'app.js'), 'utf8')}\n</script>\n`;
mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', 'vs-tutorial.html');
writeFileSync(out, html);
console.log('built', out, Math.round(html.length / 1024) + 'KB');
if (process.argv[2]) copyFileSync(out, process.argv[2]);
