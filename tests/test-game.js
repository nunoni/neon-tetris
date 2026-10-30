/* Run with: node tests/test-game.js */
'use strict';
const {
  Game, COLS, ROWS, HIDDEN_ROWS, SHAPES,
  rotateMatrixCW, rotateMatrixCCW, shapeAt, detectTSpin, gravityDelay,
} = require('../js/game.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}`); }
}

/* --- rotation math --- */
{
  const T = SHAPES.T;
  check('T CW => nub right', JSON.stringify(rotateMatrixCW(T)) === JSON.stringify([[0,1,0],[0,1,1],[0,1,0]]));
  check('T CCW => nub left', JSON.stringify(rotateMatrixCCW(T)) === JSON.stringify([[0,1,0],[1,1,0],[0,1,0]]));
  check('rot 4x = identity', (() => { let m = T; for (let i=0;i<4;i++) m = rotateMatrixCW(m); return JSON.stringify(m) === JSON.stringify(T); })());
  const I = shapeAt('I', 1);
  check('I rot1 vertical col 2', I[0][2] === 1 && I[1][2] === 1 && I[2][2] === 1 && I[3][2] === 1);
}

/* --- 7-bag --- */
{
  const g = new Game();
  const counts = {};
  for (let i = 0; i < 70; i++) {
    const t = g.nextType();
    counts[t] = (counts[t] || 0) + 1;
  }
  const allTen = Object.values(counts).length === 7 && Object.values(counts).every((n) => n === 10);
  check('7-bag: 70 draws = 10 of each', allTen);
}

/* --- spawn + gravity + lock --- */
{
  const g = new Game();
  let clearEv = null, lockEv = null;
  g.on('clear', (e) => { clearEv = e; });
  g.on('lock', (e) => { lockEv = e; });
  g.start();
  check('spawn in hidden rows, no collision', g.active && g.active.y === 0);
  check('queue holds 5', g.queue.length === 5);

  // force a T piece and drop it in an empty well
  g.active = g.makePiece('T');
  g.emit('spawn', { piece: g.active });
  let guard = 0;
  while (g.canMove(0, 1) && guard++ < 100) g.active.y++;
  g.lockPiece();
  check('T locks with cells at bottom', lockEv && lockEv.cells.some(([r]) => r === ROWS - 1));
  check('no clear on single piece', clearEv === null);
  check('lock places T in grid', g.grid[ROWS - 1][4] === 'T');

  // fill rest of bottom row -> single clear
  for (let c = 0; c < COLS; c++) {
    if (g.grid[ROWS - 1][c] === null) g.grid[ROWS - 1][c] = 'J';
  }
  g.active = g.makePiece('O');
  // place O so it completes row ROWS-2? simpler: lock O on top, then clear bottom via full row already
  // directly call beginClear by locking: instead simulate with manual lock of a piece on a full row
  g.grid[ROWS - 2].fill('I');
  // make row ROWS-2 not full again (leave 2 holes) to isolate bottom-row clear
  g.grid[ROWS - 2][0] = null; g.grid[ROWS - 2][9] = null;
  g.active = g.makePiece('I');
  g.active.x = 3; g.active.y = ROWS - 2 - 1; // will collide below
  g.lockPiece();
  check('full row detected -> clearing state', g.state === 'clearing');
  check('clear event: single, 100 pts', clearEv && clearEv.count === 1 && clearEv.points === 100);
  g.finishClear();
  check('after finish: playing again', g.state === 'playing');
  check('lines = 1', g.lines === 1);
  check('cleared row content removed (T gone)', !g.grid[ROWS - 1].includes('T'));
}

/* --- tetris scoring + b2b --- */
{
  const g = new Game();
  g.start();
  // fill rows 18..21 except col 9, then drop I in col 9? I is horizontal only in rot 0.
  // instead fill rows 18..21 fully except leave col 9 empty, rotate I vertical at x=9? I vertical occupies col x+2 => x=7.
  for (let r = 18; r < 22; r++) {
    g.grid[r].fill('J');
    g.grid[r][9] = null;
  }
  g.active = g.makePiece('I');
  g.active.rot = 1;
  g.active.blocks = shapeAt('I', 1);
  g.active.x = 7; // occupies col 9 vertically
  g.active.y = 18 - 3; // top of I at row 15, will rest filling 18..21
  let ev = null;
  g.on('clear', (e) => { ev = e; });
  g.hardDrop();
  check('TETRIS detected', ev && ev.count === 4);
  check('tetris 800 + perfect clear 2500', ev.points === 800 + 2500 && ev.perfect === true);
  check('b2b flag armed', g.b2b === true);
  g.finishClear();
  check('4 rows removed, lines=4', g.lines === 4);
}

/* --- T-spin detection --- */
{
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  // T piece at x=3,y=18, box corners (3,18),(5,18),(3,20),(5,20) in grid coords
  grid[18][3] = 'J'; grid[18][5] = 'J'; grid[20][3] = 'J'; // 3 corners
  // T pointing down (rot 2): front corners are BL+BR -> (3,20),(5,20): BL filled, BR empty => mini unless kick4
  const spin = detectTSpin(grid, 3, 18, 2, 'rotate', 0);
  check('t-spin mini (3 corners, 1 front)', spin === 'mini');
  grid[20][5] = 'J'; // both front corners now
  const spin2 = detectTSpin(grid, 3, 18, 2, 'rotate', 0);
  check('t-spin full (3+ corners, both front)', spin2 === 'full');
  const spin3 = detectTSpin(grid, 3, 18, 2, 'move', 0);
  check('no t-spin if last action was move', spin3 === null);
}

/* --- wall kicks --- */
{
  const g = new Game();
  g.start();
  // I piece against right wall rotates into vertical (kick 0 works from spawn)
  g.active = g.makePiece('I');
  g.active.x = 6; // near right edge (blocks cols 6..9)
  check('I CW against wall succeeds', g.rotate(1) === true);
  check('I now vertical within bounds', g.cells(g.active).every(([, c]) => c >= 0 && c < COLS));
  // rotate back
  check('I CCW back succeeds', g.rotate(-1) === true);
}

/* --- gravity curve --- */
{
  check('level 1 gravity 1s', Math.abs(gravityDelay(1) - 1) < 1e-9);
  check('gravity decreases with level', gravityDelay(5) < gravityDelay(2));
  check('gravity floors at 10ms', gravityDelay(25) >= 0.0099);
}

/* --- top out --- */
{
  const g = new Game();
  g.start();
  g.grid[0].fill('X'); // block the spawn area entirely
  g.active = g.makePiece('T');
  g.lockPiece();
  check('block-out -> game over', g.state === 'over');
}

/* --- lock out (piece fully above visible) --- */
{
  const g = new Game();
  g.start();
  // stack that fills everything below spawn except leaves spawn cells free
  for (let r = HIDDEN_ROWS; r < ROWS; r++) g.grid[r].fill('X');
  g.active = g.makePiece('O'); // occupies rows 0-1 (hidden)
  g.lockPiece();
  check('lock-out above visible -> game over', g.state === 'over');
}

/* --- hold --- */
{
  const g = new Game();
  g.start();
  const first = g.active.type;
  check('hold works', g.holdPiece() === true);
  check('hold stores type', g.hold === first);
  check('double hold denied', g.holdPiece() === false);
}

/* --- soft drop scoring --- */
{
  const g = new Game();
  g.start();
  g.active = g.makePiece('O');
  g.setSoftDrop(true);
  g.update(0.05);
  g.setSoftDrop(false);
  check('soft drop adds score', g.score > 0);
}

/* --- review fixes --- */
{
  const g = new Game();
  g.start();
  check('pieces cannot exist above the buffer', g.collides(3, -1, SHAPES.T) === true);
}

{
  const g = new Game();
  g.start();
  g.active = g.makePiece('O');
  g.setSoftDrop(true);
  g.update(0.06);
  g.setSoftDrop(false);
  check('soft drop invalidates T-spin (lastAction fall)', g.lastAction === 'fall');
}

{
  const g = new Game();
  g.start();
  let ev0 = null;
  g.on('tspin0', (e) => { ev0 = e; });
  g.grid[18][3] = 'J'; g.grid[18][5] = 'J';
  g.grid[20][3] = 'J'; g.grid[20][5] = 'J';
  g.active = g.makePiece('T');
  g.active.x = 3; g.active.y = 18;
  g.rotate(1);
  g.rotate(1);
  g.lockPiece();
  check('no-line T-spin: 400 pts + tspin0 event', ev0 && ev0.tspin === 'full' && g.score === 400);
}

{
  const g = new Game();
  g.start();
  let ev0 = null;
  g.on('tspin0', (e) => { ev0 = e; });
  g.grid[18][3] = 'J'; g.grid[18][5] = 'J';
  g.grid[20][3] = 'J'; g.grid[20][5] = 'J';
  g.active = g.makePiece('T');
  g.active.x = 3; g.active.y = 18;
  g.rotate(1);
  g.rotate(1);
  g.hardDrop();
  check('zero-distance hard drop still credits T-spin',
    ev0 && ev0.tspin === 'full' && g.score === 400);
}

{
  const g = new Game();
  g.start();
  g.active = g.makePiece('T');
  g.active.x = 3; g.active.y = 18;
  const before = g.stats.pieces;
  g.holdPiece();
  check('held piece spawn counts in stats', g.stats.pieces === before + 1);
  check('second hold denied', g.holdPiece() === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
