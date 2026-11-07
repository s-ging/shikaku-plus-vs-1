// steps.js — the VS tutorial: one board, played start to finish, every idea in order.
// Krischan, 2026-11-07: "do EVERYTHING step by step in ONE tutorial board". No chapters, no
// panels, no Next buttons: the line under the board says what to do, and moves on by itself.
// The words follow Krischan's Fundamentals (2026-11-05): Given, Tile, Cell, Board, Tick, Do-Over,
// Hazard, Mine, Mine Bank, Mine Queue, Defuse, Heart, Stock, Frozen Cell, Frost, Freeze Over.
//
// A step: { text, after?, board?, setup?(t), done?(e, t) }
//   board   'keep' (default): carry on with the Board as it is. { leave: n }: a new Board with
//           all but n Givens already filled, for a step that needs room (or a near-finish).
//   setup   puts the Hazards in (helpers in app.js).
//   done    the engine event that shows the idea. No `done`: the line is read, then moves on.
//   do      the one move the Board takes (everything else is dimmed and ignored):
//           'pick' any open Given (no Mine on it if there is a choice), 'avoid' one with no Mine,
//           'mine' one with a Mine, 'ice' one next to a Frozen Cell, 'erase' tap the last Tile.
//   show    what else stays lit: 'hazards', 'ice', 'combo', 'hearts', 'board', 'mines', 'frozen'.
// tutorial/script.mjs prints these for the wiki (versus/tutorial.md).

export const STEPS = [
	{
		do: 'pick',
		text: "A number on the Board is called a Given. A Given needs a Tile the size of its number. Drag across the Cells to place a Tile over a Given.",
		after: 'That is a Tile.',
		board: { leave: 99 },
		done: (e) => e.kind === 'placed'
	},
	{
		do: 'erase',
		text: 'A Tile can not be placed in an incorrect manner over a Given, and it will not cause a Tick to happen. Tapping a placed Tile is called a Do-Over. It removes the Tile, counts as a move and runs 1 Tick. Tap a Tile.',
		after: 'That was a Do-Over.',
		done: (e) => e.kind === 'erased'
	},
	{
		do: 'pick',
		text: 'The Board is a 6×6 grid of Cells. The Board is completed when all Givens are filled with correctly placed Tiles. Complete the Board.',
		after: 'Completed. Every Board you complete sends Mines to your opponent.',
		done: (e) => e.kind === 'clear'
	},
	{
		do: 'avoid',
		show: ['hazards'],
		text: 'Mines are a Hazard on your Board. Incoming Mines are shown on the right: the Mine Bank in gold and the Mine Queue in red. The Mine Queue lands on your next Tick, on any un-filled Cell. Mines can not land on filled Cells or on Givens. Make a move.',
		after: 'The Mines landed.',
		board: { leave: 6 },
		setup: (t) => t.queue(3),
		done: (e) => e.kind === 'mineLand'
	},
	{
		do: 'mine',
		show: ['mines'],
		text: 'Mines explode in 3 Ticks. Cover a Mine with a valid Tile to Defuse it. Defuse a Mine.',
		after: 'Defused.',
		done: (e) => e.kind === 'defuse'
	},
	{
		do: 'avoid',
		show: ['mines'],
		text: 'When a Mine explodes, it removes all placed Tiles in a 3×3 around it, and it removes a Heart from your Stock. Lose all 3 Hearts and you lose the round. Let this Mine explode: make a move anywhere else.',
		after: 'That cost you a Heart.',
		setup: (t) => t.mine({ fuse: 1, nearTiles: true }),
		done: (e) => e.kind === 'mineExplode'
	},
	{
		do: 'avoid',
		show: ['hazards', 'mines'],
		text: 'The Mine Bank holds Mines on their way to your Board. After 3 Ticks, up to 6 Banked Mines drop to the Mine Queue, and the Mine Queue lands on your next Tick. Make moves until they land.',
		after: 'Landed. At most 6 Mines can be on your Board at once. The rest wait.',
		board: { leave: 7 },
		setup: (t) => t.bank(8, 3),
		done: (e) => e.kind === 'mineLand'
	},
	{
		do: 'pick',
		show: ['hazards'],
		text: 'Completing a Board cancels up to 12 incoming Mines, the Mine Queue first, then the Mine Bank. You still send all of yours. Complete the Board.',
		after: 'Cancelled, and your Mines still went out.',
		board: { leave: 2 },
		setup: (t) => t.bank(9, 30),
		done: (e) => e.kind === 'send' && e.cancelled > 0
	},
	{
		do: 'pick',
		show: ['combo'],
		text: 'Complete Boards in a row to build a Combo and send more Mines. A Board sends 4. A Combo of 2 or 3 adds 1, 4 or 5 adds 2, 6 or 7 adds 3, and 8 or more adds 4. Only an exploding Mine or a Freeze Over breaks a Combo. Complete 2 more Boards.',
		after: 'Combo 3: that Board sent 4 + 1 = 5 Mines.',
		board: { leave: 2, again: true },
		setup: (t) => t.combo(1),
		done: (e) => e.kind === 'clear' && e.combo >= 3
	},
	{
		do: 'mine',
		show: ['mines'],
		text: 'Every Mine Defused by the Tile that completes a Board adds 1 more Mine to what you send. Complete the Board with the Tile under the Mines.',
		after: '2 Mines Defused with the last Tile: 2 more Mines sent.',
		board: { leave: 1, biggest: true },
		setup: (t) => t.mine({ fuse: 3, count: 2 }),
		done: (e) => e.kind === 'clear' && e.defuseBonus > 0
	},
	{
		do: 'mine',
		show: ['mines', 'hazards'],
		text: 'Defusing a Mine on its last Tick is called a Clutch. If nothing explodes on that Tick, a Clutch also cancels 1 incoming Mine. This Mine explodes on your next Tick. Defuse it.',
		after: 'Clutch. 1 incoming Mine cancelled.',
		board: { leave: 6 },
		setup: (t) => {
			t.mine({ fuse: 1 });
			t.bank(3, 30);
		},
		done: (e) => e.kind === 'clutch'
	},
	{
		text: 'After you complete a Board, nothing lands on that move or on your first move on the new Board. Use it to read the new Board.'
	},
	{
		do: 'avoid',
		show: ['ice', 'frozen'],
		text: 'Frozen Cells are a Hazard your opponent sends. Incoming Frozen Cells are shown on the lower half of the left bar: slate lands in 2 Ticks, blinking blue lands on your next Tick. Frozen Cells land on any un-filled Cell. Make 2 moves.',
		after: 'A Cell froze.',
		board: { leave: 7 },
		setup: (t) => t.incomingIce(1, 2),
		done: (e) => e.kind === 'frozen'
	},
	{
		do: 'ice',
		show: ['frozen'],
		text: 'A Tile can not be placed over a Frozen Cell, and a Board with a Frozen Cell can not be completed. Place a Tile next to a Frozen Cell to break it. Every Tile that shares an edge with it takes 2 of its 4 points. Break this one.',
		after: 'Broken. Breaking a Frozen Cell gives your Frost 2 points.',
		board: { leave: 7 },
		setup: (t) => t.thawSetup(),
		done: (e) => e.kind === 'thaw'
	},
	{
		do: 'pick',
		show: ['frozen'],
		text: 'On your last 2 Givens, the Icebreaker breaks a Frozen Cell that blocks you, 1 per Tick. Place the Tile that is free.',
		after: 'The Icebreaker broke it. That gives your Frost 2 points too.',
		setup: (t) => t.icebreakSetup(),
		done: (e) => e.kind === 'forceBreak'
	},
	{
		do: 'mine',
		show: ['ice', 'mines'],
		text: 'Frost is how you send Frozen Cells. It is the upper half of the left bar: 4 points make 1 Frozen Cell, and it holds up to 3. Defusing a Mine on your first move after it lands gives 1 point. Defuse this Mine.',
		after: 'Your Frost is full and outlined. It is armed, and fires on your next Tick.',
		board: { leave: 7 },
		setup: (t) => {
			t.frost(3);
			t.mine({ fuse: 3 });
		},
		done: (e, t) => e.kind === 'settled' && t.side().econ.armed > 0
	},
	{
		do: 'pick',
		show: ['ice'],
		text: 'Make a move to fire your Frost.',
		after: 'You sent 1 Frozen Cell. On your last 4 Givens, Frost holds instead and fires when you complete the Board.',
		done: (e) => e.kind === 'frostFire' && e.count > 0
	},
	{
		do: 'pick',
		show: ['ice'],
		text: 'When your Frost fires, it cancels Frozen Cells coming at you first, 1 for 1. Only the rest is sent. Make a move to fire your Frost.',
		after: 'Deflected. The incoming Frozen Cell is gone.',
		board: { leave: 7 },
		setup: (t) => {
			t.frost(4, { armed: 1 });
			t.incomingIce(1, 2);
		},
		done: (e) => e.kind === 'frostFire' && e.deflected > 0
	},
	{
		do: 'avoid',
		show: ['ice', 'frozen', 'mines'],
		text: '4 Frozen Cells on your Board at once is a Freeze Over. You lose that Board. You do not lose the round, but its Mines come back to your Mine Queue and your Combo breaks. Make a move.',
		after: 'Freeze Over. A new Board, and the Mines are back in your Mine Queue.',
		board: { leave: 8 },
		setup: (t) => {
			t.ice({ count: 3 });
			t.mine({ fuse: 3 });
			t.incomingIce(1, 1);
		},
		done: (e) => e.kind === 'frozenOut'
	},
	{
		show: ['board'],
		text: 'If you do not move for 3 seconds, your Board runs 1 Tick by itself. Every move resets the 3 seconds. Wait without moving.',
		after: 'Your Board ticked by itself.',
		setup: (t) => t.gravity(true),
		done: (e) => e.kind === 'gravity'
	},
	{
		show: ['hearts'],
		text: 'Complete 4 Boards in a row with no Do-Overs and you get an Extra Life, once per round. After 2 of those Boards, a Do-Over only drops your count back to 2.'
	},
	{
		show: ['hazards'],
		text: 'If 4 or more Mines sit in your Mine Bank for 6 Ticks, 1 Frozen Cell lands on your own Board, and again every 6 Ticks.'
	},
	{
		text: 'From 3:00 into a round, everything you send is 5 times as many Mines. The clock turns white and reads RUSH.'
	},
	{
		text: 'That is Shikaku+ VS. The first player to win the set number of rounds wins the match.',
		end: true
	}
];
