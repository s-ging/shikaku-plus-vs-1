// steps.js — the VS tutorial: four short lessons, one Board at a time, one move at a time.
// Krischan, 2026-11-07: "do EVERYTHING step by step in ONE tutorial board", then the same day:
// separate the action from the information, split the dense steps, end on a Board with no help,
// and group it into the categories so it is not 30 steps at once.
// The words follow Krischan's Fundamentals (2026-11-05): Given, Tile, Cell, Board, Tick, Do-Over,
// Hazard, Mine, Mine Bank, Mine Queue, Defuse, Stock, Frozen Cell, Frost, Freeze Over.
// Krischan, 2026-11-08: call the lives Stock, not Hearts ("standard language for competitive games").
//
// A step: { info?, say, after?, board?, setup?(t), move?, show?, done?(e, t) }
//   info    the small line: what the idea is. One or two short sentences.
//   say     the big line: what to do now (or, on a step with no move, the one thing to read).
//   after   the line that replaces `say` once it is done.
//   board   'keep' (default): carry on with the Board as it is. { leave: n }: a new Board with
//           all but n Givens already filled, for a step that needs room (or a near-finish).
//   setup   puts the Hazards in (helpers in app.js).
//   move    the one move the Board takes; everything else is dimmed and ignored:
//           'pick' any open Given (no Mine on it if there is a choice), 'avoid' one with no Mine,
//           'mine' one with a Mine, 'ice' one next to a Frozen Cell, 'erase' tap the last Tile,
//           'wrong' a Tile of the wrong size, 'free' any move at all (no spotlight, no help).
//           No `move`: the Board takes nothing (a line to read, or a step to wait out).
//   show    what else stays lit: 'hazards', 'ice', 'combo', 'hearts', 'board', 'mines', 'frozen'.
//   done    the engine event that shows the idea. No `done`: the line is read, then moves on.
// Every lesson starts a new match and ends on a Board you complete with no help.
// tutorial/script.mjs prints these for the wiki (versus/tutorial.md).

const COMPLETE = { say: 'Complete the Board.', move: 'free', done: (e) => e.kind === 'clear', after: 'Board complete.' };

export const LESSONS = [
	{
		name: 'Fundamentals',
		steps: [
			{
				info: 'A number on the Board is a Given. A Given needs a Tile the size of its number.',
				say: 'Drag across the lit Cells.',
				after: 'That is a Tile.',
				board: { leave: 99 },
				move: 'pick',
				done: (e) => e.kind === 'placed'
			},
			{
				info: 'A Tile of the wrong size is not placed, and no Tick happens.',
				say: 'Drag across the lit Cells.',
				after: 'Not placed.',
				move: 'wrong',
				done: (e) => e.kind === 'denied'
			},
			{
				info: 'Tapping a placed Tile is a Do-Over. It removes the Tile and runs 1 Tick.',
				say: 'Tap the lit Tile.',
				after: 'That was a Do-Over.',
				move: 'erase',
				done: (e) => e.kind === 'erased'
			},
			{
				say: 'The Board is a 6×6 grid of Cells. It is complete when every Given has its Tile.',
				show: ['board']
			},
			{ ...COMPLETE, after: 'Board complete. Every Board you complete sends Mines to your opponent.' }
		]
	},
	{
		name: 'Mines',
		steps: [
			{
				info: 'Mines are a Hazard. The red pills on the right are your Mine Queue. They land on your next Tick.',
				say: 'Place the lit Tile.',
				after: 'The Mines landed on empty Cells.',
				board: { leave: 6 },
				setup: (t) => t.queue(3),
				move: 'avoid',
				show: ['hazards', 'mines'],
				done: (e) => e.kind === 'mineLand'
			},
			{
				info: 'A Mine explodes in 3 Ticks. Cover it with a Tile to Defuse it.',
				say: 'Defuse a Mine.',
				after: 'Defused.',
				move: 'mine',
				show: ['mines'],
				done: (e) => e.kind === 'defuse'
			},
			{
				info: 'An exploding Mine removes the Tiles around it and costs 1 Stock. Lose all your Stock and you lose the round.',
				say: 'Place the lit Tile. Let the Mine explode.',
				after: 'That cost 1 Stock.',
				setup: (t) => t.mine({ fuse: 1, nearTiles: true }),
				move: 'avoid',
				show: ['mines', 'hearts'],
				done: (e) => e.kind === 'mineExplode'
			},
			{
				info: 'The gold pills are your Mine Bank. After 3 Ticks, Banked Mines drop into the Mine Queue.',
				say: 'Place the lit Tiles until they land.',
				after: 'Landed. At most 6 Mines sit on your Board at once.',
				board: { leave: 7 },
				setup: (t) => t.bank(8, 3),
				move: 'avoid',
				show: ['hazards', 'mines'],
				done: (e) => e.kind === 'mineLand'
			},
			{
				info: 'The Mines a Board sends cancel Mines coming at you first, up to 12. Only the rest is sent.',
				say: 'Complete the Board.',
				after: 'Cancelled.',
				board: { leave: 2 },
				setup: (t) => t.bank(9, 30),
				move: 'pick',
				show: ['hazards'],
				done: (e) => e.kind === 'send' && e.cancelled > 0
			},
			{
				info: 'Complete Boards in a row to build a Combo. A Combo sends more Mines.',
				say: 'Complete 2 more Boards.',
				after: 'Combo 3: 4 + 1 = 5 Mines sent.',
				board: { leave: 2, again: true },
				setup: (t) => t.combo(1),
				move: 'pick',
				show: ['combo'],
				done: (e) => e.kind === 'clear' && e.combo >= 3
			},
			{
				info: 'Each Mine Defused by the last Tile of a Board sends 1 more Mine.',
				say: 'Complete the Board over the Mines.',
				after: '2 more Mines sent.',
				board: { leave: 1, biggest: true },
				setup: (t) => t.mine({ fuse: 3, count: 2 }),
				move: 'mine',
				show: ['mines'],
				done: (e) => e.kind === 'clear' && e.defuseBonus > 0
			},
			{
				info: 'Defusing a Mine on its last Tick is a Clutch. A Clutch cancels 1 incoming Mine.',
				say: 'This Mine explodes on your next Tick. Defuse it.',
				after: 'Clutch.',
				board: { leave: 6 },
				setup: (t) => {
					t.mine({ fuse: 1 });
					t.bank(3, 30);
				},
				move: 'mine',
				show: ['mines', 'hazards'],
				done: (e) => e.kind === 'clutch'
			},
			{
				say: 'After you complete a Board, nothing lands on your first move on the new Board.'
			},
			{
				...COMPLETE,
				board: { leave: 6 },
				setup: (t) => {
					t.queue(2);
					t.mine({ fuse: 3 });
				}
			}
		]
	},
	{
		name: 'Frozen Cells',
		steps: [
			{
				info: 'Frozen Cells are a Hazard your opponent sends. They show on the lower half of the left bar.',
				say: 'Place the lit Tile.',
				after: 'Blinking blue: it lands on your next Tick.',
				board: { leave: 7 },
				setup: (t) => t.incomingIce(1, 2),
				move: 'avoid',
				show: ['ice'],
				done: (e) => e.kind === 'settled'
			},
			{
				info: 'A Frozen Cell lands on an empty Cell.',
				say: 'Place the lit Tile.',
				after: 'A Cell froze.',
				move: 'avoid',
				show: ['ice'],
				done: (e) => e.kind === 'frozen'
			},
			{
				say: 'A Tile can not cover a Frozen Cell, and a Board with a Frozen Cell can not be completed.',
				show: ['frozen']
			},
			{
				info: 'Each Tile placed next to a Frozen Cell takes 2 of its 4 points.',
				say: 'Break it: place the lit Tiles.',
				after: 'Broken. That gives your Frost 2 points.',
				board: { leave: 7 },
				setup: (t) => t.thawSetup(),
				move: 'ice',
				show: ['frozen'],
				done: (e) => e.kind === 'thaw'
			},
			{
				info: 'On your last 2 Givens, the Icebreaker breaks a Frozen Cell that blocks you, 1 per Tick.',
				say: 'Place the lit Tile.',
				after: 'The Icebreaker broke it.',
				setup: (t) => t.icebreakSetup(),
				move: 'pick',
				show: ['frozen'],
				done: (e) => e.kind === 'forceBreak'
			},
			{
				info: 'Frost is the upper half of the left bar. Defusing a Mine on your first move after it lands gives it 1 point.',
				say: 'Defuse the Mine.',
				after: 'Your Frost is full. It fires on your next Tick.',
				board: { leave: 7 },
				setup: (t) => {
					t.frost(3);
					t.mine({ fuse: 3 });
				},
				move: 'mine',
				show: ['ice', 'mines'],
				done: (e, t) => e.kind === 'settled' && t.side().econ.armed > 0
			},
			{
				info: '4 Frost points send 1 Frozen Cell to your opponent.',
				say: 'Place the lit Tile to fire it.',
				after: 'You sent 1 Frozen Cell.',
				move: 'avoid',
				show: ['ice'],
				done: (e) => e.kind === 'frostFire' && e.count > 0
			},
			{
				info: 'Frost cancels Frozen Cells coming at you first. Only the rest is sent.',
				say: 'Place the lit Tile to fire it.',
				after: 'Deflected.',
				board: { leave: 7 },
				setup: (t) => {
					t.frost(4, { armed: 1 });
					t.incomingIce(1, 2);
				},
				move: 'avoid',
				show: ['ice'],
				done: (e) => e.kind === 'frostFire' && e.deflected > 0
			},
			{
				info: '4 Frozen Cells on your Board is a Freeze Over. You lose the Board and your Combo. Its Mines come back.',
				say: 'Place the lit Tile.',
				after: 'Freeze Over. A new Board.',
				board: { leave: 8 },
				setup: (t) => {
					t.ice({ count: 3 });
					t.mine({ fuse: 3 });
					t.incomingIce(1, 1);
				},
				move: 'avoid',
				show: ['ice', 'frozen', 'mines'],
				done: (e) => e.kind === 'frozenOut'
			},
			{ ...COMPLETE, board: { leave: 6 }, setup: (t) => t.ice({ count: 1 }) }
		]
	},
	{
		name: 'Advanced',
		steps: [
			{
				info: 'If you do not move for 3 seconds, your Board runs 1 Tick by itself.',
				say: 'Wait.',
				after: 'It ticked by itself. Every move resets the 3 seconds.',
				board: { leave: 7 },
				setup: (t) => t.gravity(true),
				show: ['board'],
				done: (e) => e.kind === 'gravity'
			},
			{
				say: 'Complete 4 Boards in a row with no Do-Overs to get an Extra Life, once per round.',
				show: ['hearts']
			},
			{
				say: 'If 4 or more Mines wait in your Mine Bank for 6 Ticks, 1 Frozen Cell lands on your own Board, and again every 6 Ticks.',
				show: ['hazards']
			},
			{
				say: 'From 2:00 into a round, everything you send is 3 times as many Mines, and from 3:00, 5 times. The clock reads RUSH.'
			},
			{
				say: 'Every new Board dealt from 2:00 has at most 7 Givens.'
			},
			{
				...COMPLETE,
				board: { leave: 6 },
				setup: (t) => {
					t.queue(2);
					t.incomingIce(1, 3);
				}
			}
		]
	}
];
