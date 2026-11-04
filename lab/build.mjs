// lab/build.mjs — bundle the vs-1 engine + the lab UI into one self-contained page.
// The engine stays untouched in ../engine/; only import/export syntax is stripped here.
//   node lab/build.mjs            → lab/dist/vs-lab.html
//   node lab/build.mjs out.html   → also copies the page to out.html (the published artifact file)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, '..', 'engine');
const strip = (src) =>
	src
		.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
		.replace(/^export\s+(?=(const|function|class|let|async))/gm, '');
const MODULES = ['puzzle.js', 'game.js', 'economy.js', 'match.js', 'versus.js', 'versus-match.js'];
const mods = MODULES.map((f) => `// ===== engine/${f} =====\n` + strip(readFileSync(join(engine, f), 'utf8'))).join('\n');
const html = `${readFileSync(join(here, 'page.html'), 'utf8')}\n<script>\n${mods}\n</script>\n<script>\n${readFileSync(join(here, 'app.js'), 'utf8')}\n</script>\n`;
mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', 'vs-lab.html');
writeFileSync(out, html);
console.log('built', out, Math.round(html.length / 1024) + 'KB');
if (process.argv[2]) {
	copyFileSync(out, process.argv[2]);
	console.log('copied to', process.argv[2]);
}
