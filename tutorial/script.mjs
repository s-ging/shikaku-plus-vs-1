// tutorial/script.mjs — prints the tutorial's words as Markdown, for the wiki (versus/tutorial.md).
//   node tutorial/script.mjs > ../shikaku-plus-info/versus/tutorial.md
import { LESSONS } from './steps.js';
const lines = [
	'# VS tutorial: the script',
	'',
	'Generated from `tutorial/steps.js` in `s-ging/shikaku-plus-vs-1`; edit the words there. Four lessons, each its own match. Every step dims the screen except the one move it wants; the small line says what the idea is, the big line says what to do, and the next step comes once it is done. Each lesson ends on a Board you complete with no help. Terms follow the glossary: Given, Tile, Cell, Board, Tick, Do-Over, Hazard, Mine, Mine Bank, Mine Queue, Defuse, Heart, Stock, Frozen Cell, Frost, Freeze Over.',
	''
];
for (const l of LESSONS) {
	lines.push(`## ${l.name}`, '');
	l.steps.forEach((s, i) => {
		const info = s.info ? `${s.info} ` : '';
		const free = s.move === 'free' ? ' *(No help.)*' : '';
		lines.push(`${i + 1}. ${info}**${s.say}**${s.after ? ` → *${s.after}*` : ''}${free}`);
	});
	lines.push('');
}
console.log(lines.join('\n'));
