'use strict';

/**
 * 围棋规则引擎。
 *
 * 设计上把「纯规则运算」与「棋局对象」分开：
 *   - tryPlay / groupInfo 等函数只操作一个 Uint8Array，因此可以被蒙特卡洛
 *     搜索在上万次模拟中高速复用，不会产生额外对象开销；
 *   - GoBoard 负责历史记录、禁全同（超级劫）、让子摆放等棋局级别的事务。
 *
 * 坐标约定：x 向右、y 向下，均为 0 起始；索引 = y * size + x。
 */

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const ctxCache = new Map();

function getCtx(size) {
  let ctx = ctxCache.get(size);
  if (ctx) return ctx;

  const n = size * size;
  const neighbors = new Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const list = [];
      if (x > 0) list.push(y * size + x - 1);
      if (x < size - 1) list.push(y * size + x + 1);
      if (y > 0) list.push((y - 1) * size + x);
      if (y < size - 1) list.push((y + 1) * size + x);
      neighbors[y * size + x] = Int32Array.from(list);
    }
  }

  ctx = {
    size,
    neighbors,
    stoneMark: new Int32Array(n), // 遍历棋串时给己方子打标记
    libMark: new Int32Array(n), // 统计气时给空点打标记
    stack: new Int32Array(n),
    gen: 0,
  };
  ctxCache.set(size, ctx);
  return ctx;
}

function other(color) {
  return color === BLACK ? WHITE : BLACK;
}

function idxOf(size, x, y) {
  return y * size + x;
}

function xyOf(size, idx) {
  return { x: idx % size, y: Math.floor(idx / size) };
}

function onBoard(size, x, y) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

/**
 * 洪泛求出一整块棋串的子与气。
 * 使用代次戳（generation stamp）代替 Set，避免每次调用分配内存。
 */
function groupInfo(cells, size, start) {
  const ctx = getCtx(size);
  let gen = ++ctx.gen;
  if (gen > 2_000_000_000) {
    ctx.stoneMark.fill(0);
    ctx.libMark.fill(0);
    gen = ctx.gen = 1;
  }
  const { stoneMark, libMark, stack, neighbors } = ctx;
  const color = cells[start];

  let sp = 0;
  stack[sp++] = start;
  stoneMark[start] = gen;

  const stones = [];
  let liberties = 0;

  while (sp > 0) {
    const p = stack[--sp];
    stones.push(p);
    const nb = neighbors[p];
    for (let i = 0; i < nb.length; i++) {
      const q = nb[i];
      const c = cells[q];
      if (c === EMPTY) {
        if (libMark[q] !== gen) {
          libMark[q] = gen;
          liberties++;
        }
      } else if (c === color && stoneMark[q] !== gen) {
        stoneMark[q] = gen;
        stack[sp++] = q;
      }
    }
  }

  return { stones, liberties, color };
}

/**
 * 在给定的棋盘数组上落子。
 * 直接在 cells 上就地修改，失败时会完整回滚。
 *
 * @returns {{ok: boolean, reason?: string, captured?: number[], suicide?: boolean, newKo?: number|null}}
 */
function tryPlay(cells, size, x, y, color, koPoint) {
  if (!onBoard(size, x, y)) return { ok: false, reason: 'out-of-board' };
  const idx = idxOf(size, x, y);
  if (cells[idx] !== EMPTY) return { ok: false, reason: 'occupied' };
  if (koPoint === idx) return { ok: false, reason: 'ko' };

  const ctx = getCtx(size);
  const opp = other(color);
  cells[idx] = color;

  const captured = [];
  let singleCapture = -1;
  const nb = ctx.neighbors[idx];
  for (let i = 0; i < nb.length; i++) {
    const q = nb[i];
    if (cells[q] !== opp) continue;
    const info = groupInfo(cells, size, q);
    if (info.liberties === 0) {
      for (const s of info.stones) cells[s] = EMPTY;
      for (const s of info.stones) captured.push(s);
      if (info.stones.length === 1) singleCapture = info.stones[0];
    }
  }

  const own = groupInfo(cells, size, idx);
  if (own.liberties === 0) {
    // 自杀手：回滚（此时一定没有提子，因为被提的点会给己方提供气）
    cells[idx] = EMPTY;
    for (const s of captured) cells[s] = opp;
    return { ok: false, reason: 'suicide', suicide: true };
  }

  // 单劫：提一子且己方新子成为只有一口气的单子
  let newKo = null;
  if (singleCapture >= 0 && own.stones.length === 1 && own.liberties === 1) {
    newKo = singleCapture;
  }

  return { ok: true, captured, newKo };
}

/** 不改动原棋盘的合法性判断（用于界面悬停提示）。 */
function isLegal(cells, size, x, y, color, koPoint) {
  if (!onBoard(size, x, y)) return false;
  if (cells[idxOf(size, x, y)] !== EMPTY) return false;
  if (koPoint === idxOf(size, x, y)) return false;
  const probe = Uint8Array.from(cells);
  return tryPlay(probe, size, x, y, color, koPoint).ok;
}

/** 棋盘位置的唯一键，用于禁全同（超级劫）判定。 */
function boardKey(cells) {
  return Buffer.from(cells).toString('base64');
}

/**
 * 数子法（中国规则）计分：子 + 只被单方包围的空点。
 * 返回各方的地、子与总分（不含贴目）。
 */
function areaScore(cells, size) {
  const ctx = getCtx(size);
  const visited = new Uint8Array(size * size);
  const res = {
    black: { stones: 0, territory: 0, total: 0 },
    white: { stones: 0, territory: 0, total: 0 },
  };

  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === BLACK) res.black.stones++;
    else if (cells[i] === WHITE) res.white.stones++;
  }

  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== EMPTY || visited[i]) continue;
    const region = [];
    const stack = [i];
    visited[i] = 1;
    let borderColor = EMPTY;
    let mixed = false;

    while (stack.length) {
      const p = stack.pop();
      region.push(p);
      const nb = ctx.neighbors[p];
      for (let k = 0; k < nb.length; k++) {
        const q = nb[k];
        const c = cells[q];
        if (c === EMPTY) {
          if (!visited[q]) {
            visited[q] = 1;
            stack.push(q);
          }
        } else if (borderColor === EMPTY) {
          borderColor = c;
        } else if (borderColor !== c) {
          mixed = true;
        }
      }
    }

    if (!mixed && borderColor === BLACK) res.black.territory += region.length;
    else if (!mixed && borderColor === WHITE) res.white.territory += region.length;
  }

  res.black.total = res.black.stones + res.black.territory;
  res.white.total = res.white.stones + res.white.territory;
  return res;
}

/**
 * 列出每一点空地的归属，供界面在数子阶段画出"地盘"。
 * 返回 [{x, y, color}]，color 为 1/2 表示该空点属于黑/白。
 */
function territoryPoints(cells, size) {
  const ctx = getCtx(size);
  const visited = new Uint8Array(size * size);
  const out = [];

  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== EMPTY || visited[i]) continue;
    const region = [];
    const stack = [i];
    visited[i] = 1;
    let borderColor = EMPTY;
    let mixed = false;
    while (stack.length) {
      const p = stack.pop();
      region.push(p);
      const nb = ctx.neighbors[p];
      for (let k = 0; k < nb.length; k++) {
        const q = nb[k];
        const c = cells[q];
        if (c === EMPTY) {
          if (!visited[q]) {
            visited[q] = 1;
            stack.push(q);
          }
        } else if (borderColor === EMPTY) borderColor = c;
        else if (borderColor !== c) mixed = true;
      }
    }
    if (mixed || borderColor === EMPTY) continue;
    for (const p of region) out.push({ x: p % size, y: Math.floor(p / size), color: borderColor });
  }
  return out;
}

/** 星位坐标（用于让子摆放与界面绘制）。 */
function starPoints(size) {
  const line = size >= 15 ? 3 : size >= 11 ? 3 : 2;
  const mid = (size - 1) / 2;
  const pts = [];
  const edges = [line, size - 1 - line];
  for (const y of edges) for (const x of edges) pts.push({ x, y });
  if (Number.isInteger(mid)) {
    pts.push({ x: mid, y: mid });
    for (const v of edges) {
      pts.push({ x: mid, y: v });
      pts.push({ x: v, y: mid });
    }
  }
  return pts;
}

/**
 * 标准让子摆放顺序（按让子数返回前 n 个点）。
 * 遵循传统顺序：先角、再边、最后天元。
 */
function handicapPoints(size, count) {
  const line = size >= 15 ? 3 : 2;
  const far = size - 1 - line;
  const mid = (size - 1) / 2;

  const corners = [
    { x: far, y: line },
    { x: line, y: far },
    { x: far, y: far },
    { x: line, y: line },
  ];
  const sides = [
    { x: line, y: mid },
    { x: far, y: mid },
    { x: mid, y: line },
    { x: mid, y: far },
  ];
  const center = { x: mid, y: mid };

  const table = {
    2: [...corners.slice(0, 2)],
    3: [...corners.slice(0, 3)],
    4: [...corners],
    5: [...corners, center],
    6: [...corners, ...sides.slice(0, 2)],
    7: [...corners, ...sides.slice(0, 2), center],
    8: [...corners, ...sides],
    9: [...corners, ...sides, center],
  };

  const pts = table[count];
  return pts ? pts.map((p) => ({ ...p })) : [];
}

/** 由 GTP 坐标（如 Q16）转换到内部坐标。 */
const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

function fromGtp(size, coord) {
  if (!coord) return null;
  const s = String(coord).trim().toUpperCase();
  if (s === 'PASS' || s === 'RESIGN') return null;
  const m = /^([A-HJ-Z])(\d{1,2})$/.exec(s);
  if (!m) return null;
  const x = GTP_LETTERS.indexOf(m[1]);
  const row = parseInt(m[2], 10);
  if (x < 0 || x >= size || row < 1 || row > size) return null;
  return { x, y: size - row };
}

function toGtp(size, x, y) {
  return `${GTP_LETTERS[x]}${size - y}`;
}

module.exports = {
  EMPTY,
  BLACK,
  WHITE,
  other,
  idxOf,
  xyOf,
  onBoard,
  getCtx,
  groupInfo,
  tryPlay,
  isLegal,
  boardKey,
  areaScore,
  territoryPoints,
  starPoints,
  handicapPoints,
  fromGtp,
  toGtp,
};
