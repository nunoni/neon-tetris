/* ------------------------------------------------------------------ *
 * game.js — pure Tetris rules engine (no DOM, no rendering).
 * SRS rotation with wall kicks, 7-bag randomizer, hold, ghost,
 * lock-delay, T-spin detection, combo / back-to-back / perfect clear
 * scoring, guideline-style gravity curve.
 * ------------------------------------------------------------------ */
'use strict';

const COLS = 10;
const VISIBLE_ROWS = 20;
const HIDDEN_ROWS = 2;
const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;

const LOCK_DELAY = 0.5;   // seconds piece rests before locking
const MAX_LOCK_RESETS = 15;
const NEXT_PREVIEW = 5;

const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
  O: [[1, 1], [1, 1]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
};

/* SRS wall kicks. Written in guideline convention (+y is UP);
 * the engine negates y because grid rows grow downward. */
const KICKS_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

function rotateMatrixCW(m) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    out.push([]);
    for (let x = 0; x < n; x++) out[y].push(m[n - 1 - x][y]);
  }
  return out;
}

function rotateMatrixCCW(m) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    out.push([]);
    for (let x = 0; x < n; x++) out[y].push(m[x][n - 1 - y]);
  }
  return out;
}

function shapeAt(type, rot) {
  let m = SHAPES[type];
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) m = rotateMatrixCW(m);
  return m;
}

/* 3-corner T-spin test. Returns null | 'mini' | 'full'. */
function detectTSpin(grid, x, y, rot, lastAction, kickIndex) {
  if (lastAction !== 'rotate') return null;
  const occupied = (r, c) =>
    r < 0 || c < 0 || r >= ROWS || c >= COLS || grid[r][c] !== null;
  const corners = [
    occupied(y, x), occupied(y, x + 2),
    occupied(y + 2, x), occupied(y + 2, x + 2),
  ]; // 0:TL 1:TR 2:BL 3:BR
  const filled = corners.filter(Boolean).length;
  if (filled < 3) return null;
  const frontPairs = { 0: [0, 1], 1: [1, 3], 2: [2, 3], 3: [0, 2] };
  const [a, b] = frontPairs[rot % 4];
  if ((corners[a] && corners[b]) || kickIndex === 4) return 'full';
  return 'mini';
}

const CLEAR_SCORES = {
  normal: [0, 100, 300, 500, 800],
  tspin: [400, 800, 1200, 1600, 1600],
  mini: [100, 200, 400, 400, 400],
};

const CLEAR_NAMES = ['NONE', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];

function gravityDelay(level) {
  const g = Math.pow(0.8 - (level - 1) * 0.007, level - 1);
  return Math.max(0.01, g);
}

class Game {
  constructor() {
    this.events = {};
    this.reset();
  }

  on(name, fn) {
    (this.events[name] || (this.events[name] = [])).push(fn);
  }

  emit(name, data) {
    const list = this.events[name];
    if (!list) return;
    for (const fn of list) fn(data || {});
  }

  reset() {
    this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.bag = [];
    this.queue = [];
    this.hold = null;
    this.canHold = true;
    this.active = null;
    this.state = 'menu'; // menu | playing | clearing | paused | over
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.startLevel = 1;
    this.combo = -1;
    this.b2b = false;
    this.softDrop = false;
    this.gravityTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lastAction = null;
    this.lastKick = 0;
    this.clearingRows = [];
    this._pausedFrom = null;
    this.stats = { pieces: 0, tetris: 0, tSpins: 0, maxCombo: 0, timeMs: 0 };
  }

  /* ------------------------- bag / spawn ------------------------- */

  refillBag() {
    const bag = PIECE_TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.bag.push(...bag);
  }

  nextType() {
    while (this.bag.length === 0) this.refillBag();
    return this.bag.shift();
  }

  makePiece(type) {
    const size = SHAPES[type].length;
    this.stats.pieces++;
    return {
      type,
      rot: 0,
      x: Math.floor((COLS - size) / 2),
      y: 0,
      lowestY: 0,
      blocks: SHAPES[type].map((row) => row.slice()),
    };
  }

  spawnNext() {
    while (this.queue.length < NEXT_PREVIEW) this.queue.push(this.nextType());
    const type = this.queue.shift();
    while (this.queue.length < NEXT_PREVIEW) this.queue.push(this.nextType());
    const piece = this.makePiece(type);
    this.active = piece;
    this.gravityTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lastAction = null;
    if (this.collides(piece.x, piece.y, piece.blocks)) {
      this.active = piece; // keep it visible for the death animation
      this.gameOver();
      return;
    }
    this.emit('spawn', { piece });
  }

  /* ------------------------- collision --------------------------- */

  collides(x, y, blocks) {
    for (let r = 0; r < blocks.length; r++) {
      for (let c = 0; c < blocks[r].length; c++) {
        if (!blocks[r][c]) continue;
        const gr = y + r;
        const gc = x + c;
        if (gc < 0 || gc >= COLS || gr < 0 || gr >= ROWS) return true;
        if (this.grid[gr][gc] !== null) return true;
      }
    }
    return false;
  }

  canMove(dx, dy) {
    if (!this.active) return false;
    return !this.collides(this.active.x + dx, this.active.y + dy, this.active.blocks);
  }

  cells(piece) {
    if (!piece) return [];
    const out = [];
    for (let r = 0; r < piece.blocks.length; r++)
      for (let c = 0; c < piece.blocks[r].length; c++)
        if (piece.blocks[r][c]) out.push([piece.y + r, piece.x + c]);
    return out;
  }

  ghostY() {
    if (!this.active) return 0;
    let y = this.active.y;
    while (!this.collides(this.active.x, y + 1, this.active.blocks)) y++;
    return y;
  }

  ghostCells() {
    if (!this.active) return [];
    const y = this.ghostY();
    return this.cells({ ...this.active, y });
  }

  stackHeight() {
    for (let r = 0; r < ROWS; r++) {
      if (this.grid[r].some((cell) => cell !== null)) return ROWS - r;
    }
    return 0;
  }

  /* ------------------------- movement ---------------------------- */

  tryShift(dx) {
    if (this.state !== 'playing' || !this.active) return false;
    if (!this.canMove(dx, 0)) return false;
    this.active.x += dx;
    this.lastAction = 'move';
    this.onSuccessfulMove();
    this.emit('move', { dir: dx });
    return true;
  }

  onSuccessfulMove() {
    if (!this.canMove(0, 1) && this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  rotate(dir) {
    if (this.state !== 'playing' || !this.active) return false;
    if (dir !== 1 && dir !== -1) return false;
    const piece = this.active;
    if (piece.type === 'O') {
      this.emit('rotate', { dir, kicked: false, kickIndex: 0 });
      return true;
    }
    const from = piece.rot;
    const to = ((from + dir) % 4 + 4) % 4;
    const rotated = dir === 1 ? rotateMatrixCW(piece.blocks) : rotateMatrixCCW(piece.blocks);
    const table = piece.type === 'I' ? KICKS_I : KICKS_JLSTZ;
    const kicks = table[`${from}>${to}`] || [[0, 0]];
    for (let i = 0; i < kicks.length; i++) {
      const [kx, ky] = kicks[i];
      const nx = piece.x + kx;
      const ny = piece.y - ky; // guideline +y is up; grid +y is down
      if (!this.collides(nx, ny, rotated)) {
        piece.x = nx;
        piece.y = ny;
        piece.rot = to;
        piece.blocks = rotated;
        this.lastAction = 'rotate';
        this.lastKick = i;
        this.onSuccessfulMove();
        this.emit('rotate', { dir, kicked: i > 0, kickIndex: i, from, to });
        return true;
      }
    }
    return false;
  }

  setSoftDrop(on) {
    this.softDrop = on;
    if (on) this.gravityTimer = 1e9; // nudge immediate step
  }

  /* ------------------------- update ------------------------------ */

  update(dt) {
    if (this.state === 'playing' || this.state === 'clearing') {
      this.stats.timeMs += dt * 1000;
      if (this.state === 'playing' && this.active) this.stepGravity(dt);
    }
  }

  stepGravity(dt) {
    const base = gravityDelay(this.level);
    const delay = this.softDrop ? Math.min(base / 20, 0.04) : base;
    if (this.gravityTimer >= 1e8) this.gravityTimer = delay; // soft-drop nudge
    this.gravityTimer += dt;
    let moved = false;
    while (this.gravityTimer >= delay) {
      this.gravityTimer -= delay;
      if (this.canMove(0, 1)) {
        this.active.y++;
        moved = true;
        if (this.softDrop) {
          this.lastAction = 'fall';
          this.score += 1;
          this.emit('score', { total: this.score, gain: 1, soft: true });
          this.emit('softstep', {});
        } else {
          this.emit('fall', {});
        }
        if (this.active.y > this.active.lowestY) {
          this.active.lowestY = this.active.y;
          this.lockTimer = 0;
          this.lockResets = 0;
        }
      } else {
        this.gravityTimer = 0;
        break;
      }
    }
    if (!this.canMove(0, 1)) {
      this.lockTimer += dt;
      if (this.lockTimer >= LOCK_DELAY) this.lockPiece();
    }
  }

  hardDrop() {
    if (this.state !== 'playing' || !this.active) return false;
    let distance = 0;
    while (this.canMove(0, 1)) {
      this.active.y++;
      distance++;
    }
    if (distance > 0) {
      this.score += distance * 2;
      this.emit('score', { total: this.score, gain: distance * 2, hard: true });
      this.lastAction = 'drop';
    }
    this.emit('harddrop', { distance, cells: this.cells(this.active) });
    this.lockPiece();
    return true;
  }

  holdPiece() {
    if (this.state !== 'playing' || !this.active || !this.canHold) return false;
    this.canHold = false;
    const prev = this.hold;
    this.hold = this.active.type;
    this.emit('hold', { type: this.hold, prev });
    if (prev === null) {
      this.spawnNext();
    } else {
      const piece = this.makePiece(prev);
      this.active = piece;
      this.gravityTimer = 0;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.lastAction = null;
      if (this.collides(piece.x, piece.y, piece.blocks)) {
        this.gameOver();
        return true;
      }
      this.emit('spawn', { piece });
    }
    return true;
  }

  /* ------------------------- locking ----------------------------- */

  lockPiece() {
    if (!this.active) return;
    const piece = this.active;
    const pieceCells = this.cells(piece);
    const tspin = piece.type === 'T'
      ? detectTSpin(this.grid, piece.x, piece.y, piece.rot, this.lastAction, this.lastKick)
      : null;

    let lockout = true;
    for (const [r] of pieceCells) if (r >= HIDDEN_ROWS) lockout = false;
    for (const [r, c] of pieceCells) {
      if (r >= 0) this.grid[r][c] = piece.type;
    }
    this.active = null;
    this.canHold = true;
    if (tspin) this.stats.tSpins++;

    const fullRows = [];
    for (let r = 0; r < ROWS; r++) {
      if (this.grid[r].every((cell) => cell !== null)) fullRows.push(r);
    }

    this.emit('lock', { cells: pieceCells, type: piece.type, tspin });

    if (lockout) {
      this.gameOver();
      return;
    }

    if (fullRows.length > 0) {
      this.beginClear(fullRows, tspin);
    } else {
      if (tspin) {
        const pts = CLEAR_SCORES[tspin === 'full' ? 'tspin' : 'mini'][0] * this.level;
        this.score += pts;
        this.emit('score', { total: this.score, gain: pts, clear: false });
        this.emit('tspin0', { tspin, points: pts });
      }
      this.combo = -1;
      this.spawnNext();
    }
  }

  beginClear(rows, tspin) {
    const count = rows.length;
    this.clearingRows = rows;

    // perfect clear: every non-cleared row is empty
    let perfect = true;
    for (let r = 0; r < ROWS; r++) {
      if (rows.includes(r)) continue;
      if (this.grid[r].some((cell) => cell !== null)) { perfect = false; break; }
    }

    this.combo++;
    const table = tspin === 'full' ? CLEAR_SCORES.tspin
      : tspin === 'mini' ? CLEAR_SCORES.mini
        : CLEAR_SCORES.normal;
    let points = table[count] * this.level;
    const difficult = count === 4 || (tspin && count > 0);
    let b2bApplied = false;
    if (difficult && this.b2b) {
      points = Math.floor(points * 1.5);
      b2bApplied = true;
    }
    if (this.combo > 0) points += 50 * this.combo * this.level;
    if (perfect) points += 2500 * this.level;
    if (difficult) this.b2b = true;
    else this.b2b = false;
    if (this.combo > this.stats.maxCombo) this.stats.maxCombo = this.combo;
    if (count === 4) this.stats.tetris++;

    this.score += points;
    this.state = 'clearing';
    this.emit('score', { total: this.score, gain: points, clear: true });

    this.emit('clear', {
      rows,
      count,
      tspin,
      combo: this.combo,
      b2b: b2bApplied,
      perfect,
      points,
      total: this.score,
      name: this.clearName(count, tspin),
    });
  }

  clearName(count, tspin) {
    if (tspin === 'full') return count === 0 ? 'T-SPIN' : `T-SPIN ${CLEAR_NAMES[count]}`;
    if (tspin === 'mini') return 'MINI T-SPIN' + (count > 0 ? ` ${CLEAR_NAMES[count]}` : '');
    return CLEAR_NAMES[count];
  }

  finishClear() {
    if (this.state !== 'clearing') return;
    const count = this.clearingRows.length;
    for (const r of this.clearingRows) {
      this.grid.splice(r, 1);
      this.grid.unshift(Array(COLS).fill(null));
    }
    this.clearingRows = [];
    this.lines += count;

    const newLevel = this.startLevel + Math.floor(this.lines / 10);
    if (newLevel > this.level) {
      this.level = newLevel;
      this.emit('levelup', { level: this.level });
    }
    this.state = 'playing';
    this.emit('lines', { lines: this.lines, level: this.level });
    this.spawnNext();
  }

  /* ------------------------- control ----------------------------- */

  pause() {
    if (this.state === 'playing' || this.state === 'clearing') {
      this._pausedFrom = this.state;
      this.state = 'paused';
      this.emit('pause', {});
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = this._pausedFrom || 'playing';
      this.emit('resume', {});
    }
  }

  gameOver() {
    if (this.state === 'over') return;
    this.state = 'over';
    this.emit('gameover', { stats: this.stats, score: this.score, lines: this.lines, level: this.level });
  }

  start(level) {
    this.reset();
    this.startLevel = level || 1;
    this.level = this.startLevel;
    this.state = 'playing';
    this.emit('start', {});
    this.spawnNext();
  }
}

/* Node (tests) vs browser */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Game, COLS, ROWS, VISIBLE_ROWS, HIDDEN_ROWS, PIECE_TYPES,
    SHAPES, KICKS_JLSTZ, KICKS_I, CLEAR_SCORES,
    rotateMatrixCW, rotateMatrixCCW, shapeAt, detectTSpin, gravityDelay,
  };
}
