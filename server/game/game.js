'use strict';

const rules = require('./board');
const { GoBoard } = require('./goban');
const { APP_NAME, VERSION } = require('../version');

const { BLACK, WHITE, EMPTY } = rules;

const MODES = ['pve', 'pvp'];
const RULE_SETS = ['chinese', 'japanese'];

/** 按棋盘大小给出常见贴目。 */
function defaultKomi(size, handicap) {
  if (handicap > 0) return 0.5;
  if (size <= 9) return 7;
  if (size <= 13) return 7.5;
  return 7.5;
}

/**
 * 一局棋的完整会话：规则、回合、终局判定、数子与 SGF。
 * 该对象是服务端的唯一权威状态，前端只做展示与乐观预览。
 */
class Game {
  constructor(options = {}) {
    const size = options.boardSize || 19;
    this.id = options.id || `g${Date.now().toString(36)}`;
    this.mode = MODES.includes(options.mode) ? options.mode : 'pve';
    this.boardSize = size;
    this.ruleSet = RULE_SETS.includes(options.ruleSet) ? options.ruleSet : 'chinese';
    this.handicap = Math.max(0, Math.min(9, options.handicap || 0));
    this.komi = typeof options.komi === 'number' ? options.komi : defaultKomi(size, this.handicap);
    this.levelId = options.levelId || '10k';
    this.humanColor = options.humanColor === WHITE ? WHITE : BLACK;
    this.createdAt = new Date().toISOString();

    this.board = new GoBoard(size);
    if (this.handicap > 0) this.board.setHandicap(this.handicap);

    // 让子局由白棋先行
    this.turn = this.handicap > 0 ? WHITE : BLACK;
    this.status = 'playing'; // playing | scoring | finished
    this.passes = 0;
    this.result = null;
    this.deadStones = new Set();
    this.moveLog = []; // UI 用：{ no, color, x, y, pass?, captured }
  }

  get aiColor() {
    return this.humanColor === BLACK ? WHITE : BLACK;
  }

  get isHumanTurn() {
    return this.mode === 'pvp' || this.turn === this.humanColor;
  }

  /** 轮到的这一方是否可以由本地玩家落子。 */
  canHumanMove() {
    return this.status === 'playing' && this.isHumanTurn;
  }

  colorName(c) {
    return c === BLACK ? '黑' : '白';
  }

  _logMove(entry) {
    this.moveLog.push({ no: this.moveLog.length + 1, ...entry });
  }

  /**
   * 落子。会同时维护终局计数与提子记录。
   */
  play(x, y, color) {
    if (this.status !== 'playing') return { ok: false, reason: 'not-playing' };
    const who = color || this.turn;
    if (who !== this.turn) return { ok: false, reason: 'wrong-turn' };

    const res = this.board.play(x, y, who);
    if (!res.ok) return res;

    this._logMove({ color: who, x, y, captured: res.captured.length });
    this.passes = 0;
    this.turn = rules.other(who);
    return { ok: true, captured: res.captured };
  }

  /** 停一手；连续两次停手自动进入数子阶段。 */
  pass(color) {
    if (this.status !== 'playing') return { ok: false, reason: 'not-playing' };
    const who = color || this.turn;
    if (who !== this.turn) return { ok: false, reason: 'wrong-turn' };

    this.board.playPass(who);
    this._logMove({ color: who, pass: true, captured: 0 });
    this.passes += 1;
    this.turn = rules.other(who);

    if (this.passes >= 2) this.beginScoring();
    return { ok: true, pass: true };
  }

  resign(color) {
    if (this.status === 'finished') return { ok: false, reason: 'already-finished' };
    const who = color || this.turn;
    this.status = 'finished';
    this.result = {
      winner: rules.other(who),
      margin: null,
      method: 'resign',
      text: `${this.colorName(rules.other(who))}中盘胜（${this.colorName(who)}认输）`,
    };
    return { ok: true, result: this.result };
  }

  /** 悔棋：人机模式默认一次回退到玩家自己的回合。 */
  undo(steps = 1) {
    if (this.status === 'finished') {
      this.status = 'scoring';
    }
    const n = Math.max(1, steps);
    this.board.undo(n);
    this.moveLog.length = Math.max(0, this.moveLog.length - n);
    this.passes = 0;
    this.deadStones.clear();
    this.result = null;
    if (this.status === 'scoring') this.status = 'playing';
    this.turn = this._expectedTurn();
    return { ok: true, undone: n };
  }

  /** 根据棋盘重建该谁走（用于悔棋后校准）。 */
  _expectedTurn() {
    const moves = this.board.moves.length;
    if (this.handicap > 0) return moves % 2 === 0 ? WHITE : BLACK;
    return moves % 2 === 0 ? BLACK : WHITE;
  }

  // ------------------------------------------------------------ 数子阶段

  beginScoring() {
    this.status = 'scoring';
    this.passes = 2;
    return { ok: true };
  }

  /** 点击棋块标记/取消死子（只有 UI 的"标记死子"模式会调用）。 */
  toggleDead(x, y) {
    const idx = rules.idxOf(this.boardSize, x, y);
    const color = this.board.cells[idx];
    if (color === EMPTY) {
      // 空点：只可能是"死子被提走后留下的位置"，单独取消它的标记即可
      if (this.deadStones.has(idx)) {
        this.deadStones.delete(idx);
        return { ok: true, dead: Array.from(this.deadStones) };
      }
      return { ok: false, reason: 'empty' };
    }
    const info = rules.groupInfo(this.board.cells, this.boardSize, idx);
    const allDead = info.stones.every((s) => this.deadStones.has(s));
    for (const s of info.stones) {
      if (allDead) this.deadStones.delete(s);
      else this.deadStones.add(s);
    }
    return { ok: true, dead: Array.from(this.deadStones) };
  }

  /** 移除死子后的棋盘副本，用于计分。 */
  _scoringCells() {
    const cells = Uint8Array.from(this.board.cells);
    for (const idx of this.deadStones) cells[idx] = EMPTY;
    return cells;
  }

  /**
   * 计算终局结果。
   * 数子法（中国规则）：子 + 围空 + 贴目。
   * 数目法（日本规则）：围空 + 提子 + 死子 + 贴目。
   */
  computeScore() {
    const size = this.boardSize;
    const cells = this._scoringCells();
    const area = rules.areaScore(cells, size);

    // 日本规则：死子计入对方提子
    const deadBlack = [...this.deadStones].filter((i) => this.board.cells[i] === BLACK).length;
    const deadWhite = [...this.deadStones].filter((i) => this.board.cells[i] === WHITE).length;

    const japanese = {
      black: {
        territory: area.black.territory,
        prisoners: this.board.captures[BLACK] + deadWhite,
        total: 0,
      },
      white: {
        territory: area.white.territory,
        prisoners: this.board.captures[WHITE] + deadBlack,
        total: 0,
      },
    };
    japanese.black.total = japanese.black.territory + japanese.black.prisoners;
    japanese.white.total = japanese.white.territory + japanese.white.prisoners + this.komi;

    const chinese = {
      black: { stones: area.black.stones, territory: area.black.territory, total: area.black.total },
      white: {
        stones: area.white.stones,
        territory: area.white.territory,
        total: area.white.total + this.komi,
      },
    };

    const primary = this.ruleSet === 'japanese' ? japanese : chinese;
    const diff = primary.black.total - primary.white.total;
    const winner = Math.abs(diff) < 1e-9 ? null : diff > 0 ? BLACK : WHITE;
    const margin = Math.abs(diff);

    return {
      ruleSet: this.ruleSet,
      komi: this.komi,
      dead: { black: deadBlack, white: deadWhite },
      chinese,
      japanese,
      winner,
      margin,
      text: winner
        ? `${this.colorName(winner)}胜 ${margin} 目`
        : '和棋',
    };
  }

  /** 确认终局，写入结果。 */
  confirmScore() {
    const score = this.computeScore();
    const primary = this.ruleSet === 'japanese' ? score.japanese : score.chinese;
    this.result = {
      winner: score.winner,
      margin: score.margin,
      method: 'score',
      text: score.text,
      detail: {
        black: primary.black.total,
        white: primary.white.total,
        komi: this.komi,
        ruleSet: this.ruleSet,
        deadBlack: score.dead.black,
        deadWhite: score.dead.white,
      },
    };
    this.status = 'finished';
    return { ok: true, result: this.result, score };
  }

  // ------------------------------------------------------------ 导出

  /** 当前需要落子的一方（引擎与前端都用它）。 */
  currentPlayer() {
    return this.turn;
  }

  toState() {
    // 数子阶段额外给出计分预览，便于界面画出地盘与实时比分
    let scorePreview = null;
    if (this.status !== 'playing') {
      const s = this.computeScore();
      scorePreview = {
        chinese: s.chinese,
        japanese: s.japanese,
        komi: s.komi,
        dead: s.dead,
        winner: s.winner,
        margin: s.margin,
        text: s.text,
        territory: rules.territoryPoints(this._scoringCells(), this.boardSize),
      };
    }
    return {
      id: this.id,
      mode: this.mode,
      boardSize: this.boardSize,
      ruleSet: this.ruleSet,
      komi: this.komi,
      handicap: this.handicap,
      levelId: this.levelId,
      humanColor: this.humanColor,
      aiColor: this.aiColor,
      turn: this.turn,
      status: this.status,
      passes: this.passes,
      cells: this.board.toArray(),
      koPoint: this.board.koPoint,
      lastMove: (() => {
        for (let i = this.moveLog.length - 1; i >= 0; i--) {
          const m = this.moveLog[i];
          if (!m.pass) return { x: m.x, y: m.y, color: m.color, no: m.no };
          return null;
        }
        return null;
      })(),
      captures: { black: this.board.captures[BLACK], white: this.board.captures[WHITE] },
      moveCount: this.moveLog.length,
      moveLog: this.moveLog,
      deadStones: Array.from(this.deadStones),
      scorePreview,
      result: this.result,
      canUndo: this.moveLog.length > 0,
      createdAt: this.createdAt,
    };
  }

  /** 生成 SGF，方便存档与复盘。 */
  toSGF(names = {}) {
    const L = 'abcdefghijklmnopqrstuvwxyz';
    const coord = (x, y) => `${L[x]}${L[y]}`;
    const esc = (s) => String(s || '').replace(/([\\\]])/g, '\\$1');

    const parts = [];
    parts.push('GM[1]FF[4]CA[UTF-8]');
    parts.push(`AP[${APP_NAME}:${VERSION}]`);
    parts.push(`SZ[${this.boardSize}]`);
    parts.push(`KM[${this.komi}]`);
    parts.push(`RU[${this.ruleSet === 'japanese' ? 'Japanese' : 'Chinese'}]`);
    parts.push(`PB[${esc(names.black || '黑方')}]`);
    parts.push(`PW[${esc(names.white || '白方')}]`);
    if (this.handicap > 0) parts.push(`HA[${this.handicap}]`);

    const handicapMove = this.board.moves.find((m) => m.handicap);
    if (handicapMove) {
      parts.push(`AB${handicapMove.points.map((p) => `[${coord(p.x, p.y)}]`).join('')}`);
    }

    let body = `(;${parts.join('')}`;
    for (const mv of this.moveLog) {
      const c = mv.color === BLACK ? 'B' : 'W';
      body += mv.pass ? `;${c}[]` : `;${c}[${coord(mv.x, mv.y)}]`;
    }
    if (this.result) {
      const w = this.result.winner === BLACK ? 'B' : this.result.winner === WHITE ? 'W' : '0';
      const re = this.result.method === 'resign' ? `R+` : `${this.result.margin}`;
      body += `RE[${w}+${re}]`;
    }
    return `${body})`;
  }
}

module.exports = { Game, defaultKomi, BLACK, WHITE, EMPTY };
