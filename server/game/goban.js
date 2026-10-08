'use strict';

const rules = require('./board');

const { EMPTY, BLACK, WHITE } = rules;

/**
 * 有状态的棋盘：在纯函数规则层之上增加历史、禁全同与让子摆放。
 * 每一步都保存一份快照，悔棋只是弹栈，代价很低（19 路仅 361 字节）。
 */
class GoBoard {
  constructor(size = 19) {
    this.size = size;
    this.cells = new Uint8Array(size * size);
    this.koPoint = null;
    /** 位置型禁全同：记录出现过的所有局面，重现场面即判违规。 */
    this.seen = new Set([rules.boardKey(this.cells)]);
    /** 手数历史：[{ color, x, y } | { color, pass: true }] */
    this.moves = [];
    /** 提子数：captures[color] 表示该方提掉的对方子数。 */
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.snapshots = [];
  }

  get(x, y) {
    return this.cells[rules.idxOf(this.size, x, y)];
  }

  clone() {
    const b = new GoBoard(this.size);
    b.cells = Uint8Array.from(this.cells);
    b.koPoint = this.koPoint;
    b.seen = new Set(this.seen);
    b.moves = this.moves.map((m) => ({ ...m }));
    b.captures = { ...this.captures };
    b.snapshots = [];
    return b;
  }

  snapshot() {
    this.snapshots.push({
      cells: Uint8Array.from(this.cells),
      koPoint: this.koPoint,
      seenSize: this.seen.size,
      seenKey: rules.boardKey(this.cells),
      captures: { ...this.captures },
      moveCount: this.moves.length,
    });
  }

  /**
   * 落子。返回 { ok, reason?, captured?, ko? }。
   * 非法手不会改变棋盘状态。
   */
  play(x, y, color) {
    // 先在副本上推演，避免"改动后才发现违反禁全同"而需要回滚
    const probe = Uint8Array.from(this.cells);
    const res = rules.tryPlay(probe, this.size, x, y, color, this.koPoint);
    if (!res.ok) return res;

    const key = rules.boardKey(probe);
    if (this.seen.has(key)) {
      return { ok: false, reason: 'superko' };
    }

    this.snapshot();
    this.cells = probe;
    this.seen.add(key);
    this.koPoint = res.newKo;
    this.captures[color] += res.captured.length;
    this.moves.push({ color, x, y });
    return { ok: true, captured: res.captured, ko: res.newKo };
  }

  /** 停一手。注意：这两层规则不禁止停一手，终局由上层 Game 判定。 */
  playPass(color) {
    this.snapshot();
    this.koPoint = null;
    this.moves.push({ color, pass: true });
  }

  /**
   * 悔棋。传入 n 表示回退 n 手。
   * 注意 seen 集合采用"重建"而非"回滚"，因为 Set 无法删除中间项。
   */
  undo(n = 1) {
    let undone = 0;
    while (undone < n && this.snapshots.length > 0) {
      const snap = this.snapshots.pop();
      this.cells = snap.cells;
      this.koPoint = snap.koPoint;
      this.captures = snap.captures;
      this.moves.length = snap.moveCount;
      this.seen = new Set();
      // 重建历史局面集合：逐步重放以恢复禁全同信息
      const replay = new Uint8Array(this.size * this.size);
      this.seen.add(rules.boardKey(replay));
      for (const mv of this.moves) {
        if (mv.pass) continue;
        rules.tryPlay(replay, this.size, mv.x, mv.y, mv.color, null);
        this.seen.add(rules.boardKey(replay));
      }
      undone++;
    }
    return undone;
  }

  /** 摆放让子（黑棋）。返回落子点列表。 */
  setHandicap(count) {
    const pts = rules.handicapPoints(this.size, count);
    for (const p of pts) {
      this.cells[rules.idxOf(this.size, p.x, p.y)] = BLACK;
    }
    if (pts.length > 0) {
      this.seen.add(rules.boardKey(this.cells));
      this.moves.push({ color: BLACK, handicap: true, points: pts });
    }
    return pts;
  }

  /** 当前所有合法落子点（用于随机模拟与"还有棋可下吗"的判断）。 */
  legalMoves(color) {
    const out = [];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.cells[rules.idxOf(this.size, x, y)] !== EMPTY) continue;
        if (rules.isLegal(this.cells, this.size, x, y, color, this.koPoint)) {
          out.push({ x, y });
        }
      }
    }
    return out;
  }

  toArray() {
    return Array.from(this.cells);
  }

  /** 供引擎使用：把棋盘压成一行 GTP 命令序列（让子 + 逐手）。 */
  toGtpSequence() {
    const lines = [];
    const handicapMove = this.moves.find((m) => m.handicap);
    if (handicapMove && handicapMove.points.length > 0) {
      const coords = handicapMove.points.map((p) => rules.toGtp(this.size, p.x, p.y));
      lines.push(`set_free_handicap ${coords.join(' ')}`);
    }
    for (const mv of this.moves) {
      if (mv.handicap) continue;
      if (mv.pass) lines.push(`play ${mv.color === BLACK ? 'B' : 'W'} pass`);
      else lines.push(`play ${mv.color === BLACK ? 'B' : 'W'} ${rules.toGtp(this.size, mv.x, mv.y)}`);
    }
    return lines;
  }
}

module.exports = { GoBoard, EMPTY, BLACK, WHITE };
