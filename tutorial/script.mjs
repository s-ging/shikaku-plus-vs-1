// tutorial/script.mjs — prints the tutorial's words as Markdown, for the wiki (versus/tutorial.md).
//   node tutorial/script.mjs > ../shikaku-plus-info/versus/tutorial.md
import { CHAPTERS, STEPS } from './steps.js';
const lines = ['# VS tutorial: the script', '', 'Generated from `tutorial/steps.js` in `s-ging/shikaku-plus-vs-1`; edit the words there. Terms follow the glossary: Given, Tile, Cell, Board, Tick, Do-Over, Hazard, Mine, Mine Bank, Mine Queue, Defuse, Heart, Stock, Frozen Cell, Frost, Freeze Over.', ''];
CHAPTERS.forEach((name, ch) => {
	lines.push(`## ${name}`, '');
	STEPS.filter((s) => s.ch === ch).forEach((s, i) => {
		lines.push(`${i + 1}. **${s.title}.** ${s.text}${s.after ? ` → *${s.after}*` : ''}`);
		if (s.math) {
			lines.push('', ...s.math.map((r, n) => (n === 1 ? `   | --- | --- |\n   | ${r.join(' | ')} |` : `   | ${r.join(' | ')} |`)), '');
		}
	});
	lines.push('');
});
console.log(lines.join('\n'));
