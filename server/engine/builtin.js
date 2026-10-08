'use strict';

const rules = require('../game/board');

const { EMPTY, BLACK, WHITE } = rules;

/**
 * 内置引擎：纯 JavaScript 的轻量蒙特卡洛。
 *
 * 存在的意义有三个：
 *   1. 机器上没有 KataGo / 没有 GPU 时，程序依然可用；
 *   2. 30级~20级这种超低难度，用它比"削弱 KataGo"更自然、响应也更快；
 *   3. KataGo 进程崩溃时可以无缝接管，不至于整局卡死。
 *
 * 算法：候选点（棋盘上棋子附近的空点）各做若干次随机模拟，取平均得分最高者；
 * 模拟中带最基本的提子 / 避免送死 / 不做自己眼的判断。
 */

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 简单眼判断：四邻都是己方（或边界），模拟时不去填自己的眼。 */
function isSimpleEye(cells, size, x, y, color) {
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (cells[ny * size + nx] !== color) return false;
  }
  let diagOwn = 0;
  let diagTotal = 0;
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      diagTotal++;
      if (cells[ny * size + nx] === color) diagOwn++;
    }
  }
  return diagTotal === 0 || diagOwn >= 1;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成候选点：只考虑棋子附近（切比雪夫距离 radius 以内）的空点。
 * 这是让随机模拟在 19 路棋盘上依然可用的关键优化。
 */
function candidatePoints(cells, size, color, radius = 2) {
  const near = new Uint8Array(size * size);
  let any = false;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cells[y * size + x] === EMPTY) continue;
      any = true;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          near[ny * size + nx] = 1;
        }
      }
    }
  }
  if (!any) return { points: [], emptyBoard: true };

  const points = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (!near[idx] || cells[idx] !== EMPTY) continue;
      if (isSimpleEye(cells, size, x, y, color)) continue;
      points.push({ x, y });
    }
  }
  return { points, emptyBoard: false };
}

/** 这一手能提掉对方几子？（不真的落子，快速估计） */
function captureCount(cells, size, x, y, color) {
  const opp = color === BLACK ? WHITE : BLACK;
  let total = 0;
  const seen = new Set();
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    const ni = ny * size + nx;
    if (cells[ni] !== opp || seen.has(ni)) continue;
    const g = rules.groupInfo(cells, size, ni);
    for (const s of g.stones) seen.add(s);
    if (g.liberties === 1) total += g.stones.length;
  }
  return total;
}

/** 落子后自己这块会不会只剩一口气（等于送死）。 */
function isSelfAtari(cells, size, x, y, color) {
  const probe = Uint8Array.from(cells);
  const r = rules.tryPlay(probe, size, x, y, color, null);
  if (!r.ok) return true;
  if (r.captured && r.captured.length > 0) return false;
  const g = rules.groupInfo(probe, size, y * size + x);
  return g.liberties <= 1;
}

/** 一次随机模拟，返回最终局面（用数子法统计）。 */
function playout(cells, size, toMove, koPoint, rand, maxMoves) {
  let ko = koPoint;
  let passes = 0;
  for (let step = 0; step < maxMoves && passes < 2; step++) {
    const { points, emptyBoard } = candidatePoints(cells, size, toMove);
    if (emptyBoard || points.length === 0) {
      passes++;
      toMove = toMove === BLACK ? WHITE : BLACK;
      ko = null;
      continue;
    }

    // 提子优先
    let chosen = null;
    for (const p of points) {
      if (captureCount(cells, size, p.x, p.y, toMove) > 0 && rand() < 0.85) {
        chosen = p;
        break;
      }
    }
    if (!chosen) {
      for (let tries = 0; tries < 6 && !chosen; tries++) {
        const p = points[Math.floor(rand() * points.length)];
        if (!isSelfAtari(cells, size, p.x, p.y, toMove)) chosen = p;
      }
      if (!chosen) chosen = points[Math.floor(rand() * points.length)];
    }

    const r = rules.tryPlay(cells, size, chosen.x, chosen.y, toMove, ko);
    if (!r.ok) {
      passes++;
      toMove = toMove === BLACK ? WHITE : BLACK;
      ko = null;
      continue;
    }
    ko = r.newKo;
    passes = 0;
    toMove = toMove === BLACK ? WHITE : BLACK;
  }
  return rules.areaScore(cells, size);
}

/** 空棋盘开局用的角部好点，避免内置引擎开局下出莫名其妙的棋。 */
function openingBook(size) {
  const line = size >= 15 ? 3 : 2;
  const far = size - 1 - line;
  const mid = (size - 1) / 2;
  const pts = [];
  for (const y of [line, far]) {
    for (const x of [line, far]) {
      pts.push({ x, y });
      pts.push({ x: x === line ? x + 1 : x - 1, y });
    }
  }
  if (size >= 13) {
    for (const v of [line, far]) pts.push({ x: mid, y: v }, { x: v, y: mid });
  }
  return pts.filter((p) => p.x >= 0 && p.y >= 0 && p.x < size && p.y < size);
}

class BuiltinEngine {
  constructor(options = {}) {
    this.size = options.size || 19;
    this.komi = typeof options.komi === 'number' ? options.komi : 7.5;
    this.seed = options.seed || Date.now() % 2147483647;
    this.playoutsDone = 0;
  }

  /**
   * 出子。params 使用 builtinPlayouts / builtinBlunder。
   * @returns {Promise<{x:number,y:number}|{pass:true}>}
   */
  async genmove(game, color, params = {}) {
    const size = game.boardSize;
    const komi = game.komi;
    const rand = mulberry32(this.seed++);
    const base = Uint8Array.from(game.board.cells);
    const ko = game.board.koPoint;

    const budgetPlayouts = Math.max(1, Math.round(params.builtinPlayouts || 200));
    const blunder = params.builtinBlunder != null ? params.builtinBlunder : 0.25;

    const { points, emptyBoard } = candidatePoints(base, size, color);
    if (points.length === 0) return { pass: true };

    // 开局直接从角部好点里挑，省时间也更像样
    if (emptyBoard || game.board.moves.length < 4) {
      const book = openingBook(size).filter(
        (p) => base[p.y * size + p.x] === EMPTY && rules.isLegal(base, size, p.x, p.y, color, ko),
      );
      if (book.length > 0) return book[Math.floor(rand() * book.length)];
    }

    const legalPoints = points.filter((p) => rules.isLegal(base, size, p.x, p.y, color, ko));
    if (legalPoints.length === 0) return { pass: true };

    // 低级难度：直接下"随手棋"的概率
    if (rand() < blunder * 0.5) {
      return legalPoints[Math.floor(rand() * legalPoints.length)];
    }

    const perPoint = Math.max(1, Math.floor(budgetPlayouts / legalPoints.length));
    const maxMoves = size * size * 2;
    const totals = new Float64Array(legalPoints.length);
    const counts = new Int32Array(legalPoints.length);

    const deadline = Date.now() + Math.max(800, params.builtinTimeMs || 2500);
    let chunkStart = Date.now();

    for (let round = 0; round < perPoint; round++) {
      for (let i = 0; i < legalPoints.length; i++) {
        const p = legalPoints[i];
        const probe = Uint8Array.from(base);
        const r = rules.tryPlay(probe, size, p.x, p.y, color, ko);
        if (!r.ok) continue;
        const score = playout(probe, size, color === BLACK ? WHITE : BLACK, r.newKo, rand, maxMoves);
        const diff = color === BLACK
          ? score.black.total - score.white.total - komi
          : score.white.total + komi - score.black.total;
        totals[i] += diff;
        counts[i] += 1;
        this.playoutsDone++;
      }
      // 让出事件循环，避免界面和其它请求被算死
      if (Date.now() - chunkStart > 40) {
        await new Promise((r2) => setImmediate(r2));
        chunkStart = Date.now();
        if (Date.now() > deadline) break;
      }
    }

    let bestIdx = -1;
    let bestAvg = -Infinity;
    for (let i = 0; i < legalPoints.length; i++) {
      if (counts[i] === 0) continue;
      const avg = totals[i] / counts[i];
      if (avg > bestAvg) {
        bestAvg = avg;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return legalPoints[Math.floor(rand() * legalPoints.length)];

    // 中级难度：保留一点"看走眼"的概率
    if (rand() < blunder * 0.35) {
      return legalPoints[Math.floor(rand() * legalPoints.length)];
    }
    return { x: legalPoints[bestIdx].x, y: legalPoints[bestIdx].y };
  }

  async stop() {
    /* 无需清理 */
  }
}

module.exports = { BuiltinEngine, candidatePoints, playout, openingBook };
