// steps.js — the VS tutorial: every step's words and the board it sets up. The words follow
// Krischan's glossary (2026-11-05): Given, Tile, Cell, Board, Tick, Do-Over, Hazard, Mine, Mine Bank,
// Mine Queue, Defuse, Heart, Stock, Frozen Cell, Frost, Freeze Over. Keep the verbs the same
// everywhere: it keeps the tutorial easy to read and easy to translate.
//
// A step: { ch, title, text, after, math?, setup(t), done(e, t) }
//   setup(t)  builds the board through the helpers in app.js (t.fresh, t.prefill, t.mine, t.ice…)
//   done      returns true on the engine event (or state) that completes the step;
//             a step with no `done` is read-only and shows Next straight away.
// tutorial/script.mjs prints these as the wiki's versus/tutorial.md, so the two never disagree.

export const CHAPTERS = ['Fundamentals', 'Combat System: Mines', 'Combat System: Frozen Cells', 'Advanced Gameplay Systems'];

export const STEPS = [
	// —— Fundamentals ——
	{
		ch: 0,
		title: 'Givens and Tiles',
		text: 'A number on the Board is called a Given. A Given needs a Tile the size of its number. Drag across the Cells to place a Tile over a Given.',
		after: 'That is a Tile. It covers its Given and exactly that many Cells.',
		setup: (t) => t.fresh(),
		done: (e) => e.kind === 'placed'
	},
	{
		ch: 0,
		title: 'A wrong Tile',
		text: 'A Tile can not be placed in an incorrect manner over a Given, and it will not cause a Tick. Try a Tile of the wrong size.',
		after: 'Not placed, and nothing ticked.',
		setup: (t) => t.fresh(),
		done: (e) => e.kind === 'denied' && e.why === 'invalid'
	},
	{
		ch: 0,
		title: 'Do-Overs',
		text: 'Tapping a placed Tile removes it. This is called a Do-Over. A Do-Over counts as a move and runs 1 Tick on the Board. Tap a Tile.',
		after: 'That was a Do-Over, and 1 Tick.',
		setup: (t) => t.prefill({ leave: 8 }),
		done: (e) => e.kind === 'erased'
	},
	{
		ch: 0,
		title: 'Completing a Board',
		text: 'The Board is a 6×6 grid of Cells. The Board is completed when every Given is filled with a correctly placed Tile. Complete this Board.',
		after: 'Board completed. Every Board you complete sends Mines to your opponent.',
		setup: (t) => t.prefill({ leave: 2 }),
		done: (e) => e.kind === 'clear'
	},
	{
		ch: 0,
		title: 'Mines',
		text: 'Mines are a Hazard on your Board. Incoming Mines are shown on the right: the Mine Bank in gold, the Mine Queue in red. Mines land on any empty Cell. They can not land on filled Cells or on Givens. Make a move.',
		after: 'The Mine Queue landed.',
		setup: (t) => {
			t.prefill({ leave: 5 });
			t.queue(3);
		},
		done: (e) => e.kind === 'mineLand'
	},
	{
		ch: 0,
		title: 'Defusing',
		text: 'A Mine explodes after 3 Ticks. Cover it with a valid Tile to Defuse it. Defuse this Mine.',
		after: 'Defused.',
		setup: (t) => {
			t.prefill({ leave: 5 });
			t.mine({ fuse: 3 });
		},
		done: (e) => e.kind === 'defuse'
	},
	{
		ch: 0,
		title: 'Explosions',
		text: 'When a Mine explodes, it removes every placed Tile in the 3×3 around it and takes 1 Heart from your Stock. Lose all 3 Hearts and you lose the round. Let this Mine explode: make a move somewhere else.',
		after: 'That cost 1 Heart. Mines that explode on the same Tick only cost 1 Heart together.',
		setup: (t) => {
			t.prefill({ leave: 5 });
			t.mine({ fuse: 1, nearTiles: true });
		},
		done: (e) => e.kind === 'mineExplode'
	},

	// —— Combat System: Mines ——
	{
		ch: 1,
		title: 'The Mine Bank',
		text: 'The Mine Bank holds Mines on their way to your Board. Sent Mines wait in the Mine Bank for 3 Ticks, then up to 6 drop into the Mine Queue, and the Mine Queue lands on your next Tick. Make moves until they land.',
		after: 'Landed. At most 6 Mines can be on your Board at once; the rest wait.',
		setup: (t) => {
			t.prefill({ leave: 7 });
			t.bank(8, 3);
		},
		done: (e) => e.kind === 'mineLand'
	},
	{
		ch: 1,
		title: 'Cancelling',
		text: 'Completing a Board cancels up to 12 incoming Mines, the Mine Queue first, then the Mine Bank. You still send your full attack. Complete this Board.',
		after: 'Cancelled, and your attack still went out.',
		setup: (t) => {
			t.prefill({ leave: 1 });
			t.queue(4);
			t.bank(5, 3);
		},
		done: (e) => e.kind === 'send' && e.cancelled > 0
	},
	{
		ch: 1,
		title: 'Combos',
		text: 'Complete Boards in a row to build a Combo and send more Mines. Only an exploding Mine or a Freeze Over breaks a Combo. Do-Overs do not. Complete 3 Boards.',
		math: [
			['Board in a row', 'Mines sent'],
			['1st', '4'],
			['2nd, 3rd', '4 + 1 = 5'],
			['4th, 5th', '4 + 2 = 6'],
			['6th, 7th', '4 + 3 = 7'],
			['8th and on', '4 + 4 = 8'],
			['Each Mine Defused by the Tile that completes the Board', '+1'],
			['In Rush', '× 5']
		],
		after: 'Combo 3: that Board sent 5 Mines.',
		setup: (t) => t.prefill({ leave: 1, again: true }),
		done: (e) => e.kind === 'clear' && e.combo >= 3
	},
	{
		ch: 1,
		title: 'Defuse Clear',
		text: 'Each Mine Defused by the Tile that completes a Board adds 1 Mine to that attack. Complete this Board with the Tile that covers the Mines.',
		after: 'Defuse Clear: 4 + 2 = 6 Mines sent.',
		setup: (t) => {
			t.prefill({ leave: 1, biggest: true });
			t.mine({ fuse: 3, count: 2 });
		},
		done: (e) => e.kind === 'clear' && e.defuseBonus > 0
	},
	{
		ch: 1,
		title: 'Clutch',
		text: 'Defusing a Mine on its last Tick is a Clutch. If nothing explodes on that Tick, it also cancels 1 incoming Mine. This Mine explodes on your next Tick: Defuse it now.',
		after: 'Clutch: 1 incoming Mine cancelled.',
		setup: (t) => {
			t.prefill({ leave: 5 });
			t.mine({ fuse: 1 });
			t.bank(3, 3);
		},
		done: (e) => e.kind === 'clutch'
	},
	{
		ch: 1,
		title: 'Grace',
		text: 'After you complete a Board, nothing lands on that move or on your first move on the new Board. Use that move to read the new Board.'
	},

	// —— Combat System: Frozen Cells ——
	{
		ch: 2,
		title: 'Frozen Cells',
		text: 'Frozen Cells are a Hazard your opponent sends you. Incoming Frozen Cells are shown on the bottom half of the left bar: slate lands in 2 Ticks, blinking blue lands on your next Tick. They land on an empty Cell. Make 2 moves.',
		after: 'A Cell froze.',
		setup: (t) => {
			t.prefill({ leave: 6 });
			t.incomingIce(1);
		},
		done: (e) => e.kind === 'frozen'
	},
	{
		ch: 2,
		title: 'Blocked',
		text: 'A Tile can not be placed over a Frozen Cell, and a Board with a Frozen Cell can not be completed. Try to place the Tile under the Frozen Cell.',
		after: 'Not placed. The Frozen Cell is in the way.',
		setup: (t) => {
			t.prefill({ leave: 5 });
			t.ice({ inUnplaced: true });
		},
		done: (e) => e.kind === 'denied' && e.why === 'ice'
	},
	{
		ch: 2,
		title: 'Breaking a Frozen Cell',
		text: 'Place Tiles next to a Frozen Cell to break it. Each Tile that shares an edge with it takes 2 of its 4 points. It also loses 1 point every 2 Ticks by itself. Break this one.',
		after: 'Broken. Breaking a Frozen Cell this way charges your Frost by 2.',
		setup: (t) => t.thawSetup(),
		done: (e) => e.kind === 'thaw'
	},
	{
		ch: 2,
		title: 'The Icebreaker',
		text: 'On your last 2 Givens, the Icebreaker breaks a Frozen Cell that blocks you, 1 per Tick. Place the Tile that is free.',
		after: 'The Icebreaker broke it. On your last 2 Givens, that also charges your Frost by 2.',
		setup: (t) => t.icebreakSetup(),
		done: (e) => e.kind === 'forceBreak'
	},
	{
		ch: 2,
		title: 'Frost',
		text: 'Frost is how you send Frozen Cells. It is the top half of the left bar: 4 points make 1 Frozen Cell, and it holds up to 3. Defusing a Mine on your first move after it lands gives 1 point. Defuse this Mine.',
		after: 'Your Frost is full and outlined: it is armed, and fires on your next Tick.',
		setup: (t) => {
			t.prefill({ leave: 7 });
			t.frost(3);
			t.mine({ fuse: 3 });
		},
		done: (e, t) => e.kind === 'settled' && t.side().econ.armed > 0
	},
	{
		ch: 2,
		title: 'Sending Frozen Cells',
		text: 'Make a move to fire your Frost.',
		after: 'You sent 1 Frozen Cell to your opponent. On your last 4 Givens, Frost holds instead, and fires when you complete the Board.',
		setup: (t) => {
			t.prefill({ leave: 7 });
			t.frost(4, { armed: 1 });
		},
		done: (e) => e.kind === 'frostFire' && e.count > 0
	},
	{
		ch: 2,
		title: 'Deflecting',
		text: 'When your Frost fires, it first cancels Frozen Cells coming at you, 1 for 1. Only the rest goes out. Make a move to fire your Frost.',
		after: 'Deflected: the incoming Frozen Cell is gone.',
		setup: (t) => {
			t.prefill({ leave: 7 });
			t.frost(4, { armed: 1 });
			t.incomingIce(1, 2);
		},
		done: (e) => e.kind === 'frostFire' && e.deflected > 0
	},
	{
		ch: 2,
		title: 'Freeze Over',
		text: '4 Frozen Cells on your Board at once is a Freeze Over: you lose that Board. You do not lose the round, but its Mines come back to your Mine Queue and your Combo breaks. Make a move.',
		after: 'Freeze Over. A new Board, and the Mines are back in your Mine Queue.',
		setup: (t) => {
			t.prefill({ leave: 8 });
			t.ice({ count: 3 });
			t.mine({ fuse: 3 });
			t.incomingIce(1, 1);
		},
		done: (e) => e.kind === 'frozenOut'
	},

	// —— Advanced Gameplay Systems ——
	{
		ch: 3,
		title: 'Gravity',
		text: 'If you do not move for 3 seconds, your Board runs 1 Tick by itself. Every move resets the 3 seconds. Wait without moving.',
		after: 'Your Board ticked by itself.',
		setup: (t) => {
			t.prefill({ leave: 5 });
			t.mine({ fuse: 3 });
			t.gravity(true);
		},
		done: (e) => e.kind === 'gravity'
	},
	{
		ch: 3,
		title: 'Healing',
		text: 'Complete 4 Boards in a row with no Do-Overs and you get back 1 Heart, once per round. After 2 such Boards, a Do-Over only drops your count back to 2.'
	},
	{
		ch: 3,
		title: 'Holding Mines',
		text: 'If 4 or more Mines sit in your Mine Bank for 6 Ticks, 1 Frozen Cell lands on your own Board, and again every 6 Ticks. Waiting to cancel a big Mine Bank has a price.'
	},
	{
		ch: 3,
		title: 'Rush',
		text: 'From 3:00 into a round, every attack sends 5 times as many Mines. The clock turns white and reads RUSH.'
	},
	{
		ch: 3,
		title: 'Ready',
		text: 'That is Shikaku+ VS. The first player to win the set number of rounds wins the match.'
	}
];
