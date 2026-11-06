// tutorial/script.mjs — prints the tutorial's words as Markdown, for the wiki (versus/tutorial.md).
//   node tutorial/script.mjs > ../shikaku-plus-info/versus/tutorial.md
import { STEPS } from './steps.js';
const lines = [
	'# VS tutorial: the script',
	'',
	'Generated from `tutorial/steps.js` in `s-ging/shikaku-plus-vs-1`; edit the words there. One Board at a time, played start to finish: the line under the Board says what to do, and the next step comes by itself once you have done it. Terms follow the glossary: Given, Tile, Cell, Board, Tick, Do-Over, Hazard, Mine, Mine Bank, Mine Queue, Defuse, Heart, Stock, Frozen Cell, Frost, Freeze Over.',
	'',
	'*New Board* marks a step that deals the next Board, with most Givens already filled.',
	''
];
STEPS.forEach((s, i) => {
	const fresh = s.board && s.board !== 'keep' && i > 0 ? ' *(New Board.)*' : '';
	lines.push(`${i + 1}. ${s.text}${s.after ? ` → *${s.after}*` : ''}${fresh}`);
});
console.log(lines.join('\n'));
