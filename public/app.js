'use strict';

/* ============================================================
 * 围棋对战前端
 *  - 棋盘用 Canvas 绘制（木纹、棋子、最后一手、悬停预览、死子标记）
 *  - 服务端通过 SSE 推送状态，前端只做展示与乐观预览
 *  - 违规落子：禁止落子 + 提示音 + 弹窗 + 棋盘抖动
 * ============================================================ */

// ---------------------------------------------------------------- 基础

const $ = (sel) => document.querySelector(sel);

const els = {
  canvas: $('#board'),
  boardWrap: document.querySelector('.board-wrap'),
  engineLine: $('#engine-line'),
  appVersion: $('#app-version'),
  thinking: $('#thinking'),
  thinkingText: $('#thinking-text'),
  turnText: $('#turn-text'),
  turnChip: $('#turn-chip'),
  statMoves: $('#stat-moves'),
  statCapBlack: $('#stat-cap-black'),
  statCapWhite: $('#stat-cap-white'),
  infoMode: $('#info-mode'),
  infoLevel: $('#info-level'),
  infoEngine: $('#info-engine'),
  infoStatus: $('#info-status'),
  levelSelect: $('#level-select'),
  levelHint: $('#level-hint'),
  levelField: $('#level-field'),
  colorField: $('#color-field'),
  moveList: $('#move-list'),
  resultBox: $('#result-box'),
  resultTitle: $('#result-title'),
  resultText: $('#result-text'),
  resultDetail: $('#result-detail'),
  scoringBox: $('#scoring-box'),
  scorePreview: $('#score-preview'),
  hardwareBox: $('#hardware-box'),
  hardwareStatus: $('#hardware-status'),
  toastLayer: $('#toast-layer'),
  clockBar: $('#clock-bar'),
  clockBlack: $('#clock-black'),
  clockWhite: $('#clock-white'),
  clockBlackTime: $('#clock-black-time'),
  clockBlackByo: $('#clock-black-byo'),
  clockWhiteTime: $('#clock-white-time'),
  clockWhiteByo: $('#clock-white-byo'),
  timeControl: $('#time-control'),
  reviewBar: document.querySelector('.review-bar'),
  reviewLabel: $('#review-label'),
  btnReviewFirst: $('#btn-review-first'),
  btnReviewPrev: $('#btn-review-prev'),
  btnReviewNext: $('#btn-review-next'),
  btnReviewLast: $('#btn-review-last'),
  btnReviewLive: $('#btn-review-live'),
  sgfFile: $('#sgf-file'),
  evalToggle: $('#eval-toggle'),
  evalPanel: $('#eval-panel'),
  wrBlack: $('#wr-black'),
  wrWhite: $('#wr-white'),
  wrText: $('#wr-text'),
  evalDetail: $('#eval-detail'),
  evalMoves: $('#eval-moves'),
  curve: $('#curve'),
  curveHint: $('#curve-hint'),
  btnAnalyzeAll: $('#btn-analyze-all'),
};

const ui = {
  mode: 'pve',
  humanColor: 'black',
  soundOn: true,
  hover: null,
  hintPoint: null,
  sending: false,
  /** 复盘：null = 看当前局面；否则是 {ply, cells, lastMove, turn, ...} */
  review: null,
  /** 形势判断开关 */
  evalOn: false,
  evalPly: -1,
  evalAt: 0,
  /** 上次用来刷新难度文案的引擎能力值，变了才重刷 */
  levelCap: undefined,
};

let state = { game: null, engine: null, hardware: null, levels: [], aiThinking: false };

/** 形势判断与胜率曲线的运行时数据 */
let evalData = null;
let evalBusy = false;
let curveData = null;

// ---------------------------------------------------------------- 音效

const Sound = (() => {
  let ctx = null;
  let enabled = true;

  function ac() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ freq, dur = 0.15, type = 'sine', gain = 0.12, delay = 0, glideTo = null }) {
    if (!enabled) return;
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  return {
    setEnabled(v) {
      enabled = v;
      if (v) ac();
    },
    get enabled() {
      return enabled;
    },
    place() {
      tone({ freq: 520, dur: 0.09, type: 'triangle', gain: 0.09 });
      tone({ freq: 900, dur: 0.05, type: 'sine', gain: 0.05, delay: 0.01 });
    },
    /** 违规落子：明显的下行"错误"音 */
    illegal() {
      tone({ freq: 240, dur: 0.26, type: 'square', gain: 0.1, glideTo: 130 });
      tone({ freq: 180, dur: 0.3, type: 'sawtooth', gain: 0.07, delay: 0.06, glideTo: 90 });
    },
    ai() {
      tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.07 });
      tone({ freq: 880, dur: 0.12, type: 'sine', gain: 0.06, delay: 0.09 });
    },
    win() {
      [523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'sine', gain: 0.09, delay: i * 0.12 }));
    },
    info() {
      tone({ freq: 700, dur: 0.08, type: 'sine', gain: 0.05 });
    },
  };
})();

// ---------------------------------------------------------------- 提示条

const ICONS = { error: '⚠️', warn: '⚠️', info: 'ℹ️', ok: '✅' };

function toast(title, body = '', type = 'info', ms = 3600) {
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.innerHTML = `<span class="ic">${ICONS[type] || 'ℹ️'}</span><div><div class="tt"></div><div class="tb"></div></div>`;
  div.querySelector('.tt').textContent = title;
  div.querySelector('.tb').textContent = body;
  if (!body) div.querySelector('.tb').remove();
  els.toastLayer.appendChild(div);
  setTimeout(() => {
    div.style.transition = 'opacity .3s, transform .3s';
    div.style.opacity = '0';
    div.style.transform = 'translateY(-10px)';
    setTimeout(() => div.remove(), 320);
  }, ms);
}

function shakeBoard() {
  els.boardWrap.classList.remove('shake');
  void els.boardWrap.offsetWidth;
  els.boardWrap.classList.add('shake');
}

// ---------------------------------------------------------------- 棋盘绘制

const Board = (() => {
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');
  let size = 19;
  let geometry = { pad: 0, cell: 0 };

  const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, rect.width);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout(w);
    draw();
  }

  function layout(w) {
    const pad = w * (size >= 19 ? 0.055 : 0.075);
    geometry = { pad, cell: (w - pad * 2) / (size - 1), width: w };
  }

  function pointToXY(x, y) {
    return [geometry.pad + x * geometry.cell, geometry.pad + y * geometry.cell];
  }

  function xyToPoint(px, py) {
    const x = Math.round((px - geometry.pad) / geometry.cell);
    const y = Math.round((py - geometry.pad) / geometry.cell);
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    // 太远的点击忽略，避免误触
    const [cx, cy] = pointToXY(x, y);
    if (Math.hypot(cx - px, cy - py) > geometry.cell * 0.62) return null;
    return { x, y };
  }

  function drawWood(w) {
    const g = ctx.createLinearGradient(0, 0, w, w);
    g.addColorStop(0, '#e8c88f');
    g.addColorStop(0.45, '#dfb877');
    g.addColorStop(1, '#cf9f5c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
    // 木质纹理
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#6b4a1f';
    for (let i = 0; i < 46; i++) {
      const y = (i / 46) * w + Math.sin(i * 1.7) * 6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + 7, w * 0.6, y - 7, w, y + 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    const w = geometry.width;
    if (!w) return;
    ctx.clearRect(0, 0, w, w);
    drawWood(w);

    const { pad, cell } = geometry;
    const g = state.game;
    // 复盘时看的是历史局面，其余情况看当前局面
    const view = ui.review || g;
    const reviewing = Boolean(ui.review);
    const cells = view ? view.cells : new Array(size * size).fill(0);

    // 网格
    ctx.strokeStyle = 'rgba(60, 40, 15, 0.75)';
    ctx.lineWidth = Math.max(1, w / 620);
    for (let i = 0; i < size; i++) {
      const p = pad + i * cell;
      ctx.beginPath();
      ctx.moveTo(pad, p);
      ctx.lineTo(w - pad, p);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p, pad);
      ctx.lineTo(p, w - pad);
      ctx.stroke();
    }

    // 星位
    const line = size >= 15 ? 3 : 2;
    const far = size - 1 - line;
    const mid = (size - 1) / 2;
    const stars = [];
    for (const y of [line, far]) for (const x of [line, far]) stars.push([x, y]);
    if (Number.isInteger(mid)) {
      stars.push([mid, mid]);
      for (const v of [line, far]) stars.push([mid, v], [v, mid]);
    }
    ctx.fillStyle = 'rgba(50, 32, 10, 0.85)';
    for (const [sx, sy] of stars) {
      const [px, py] = pointToXY(sx, sy);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2, w / 210), 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标
    ctx.fillStyle = 'rgba(70, 48, 18, 0.75)';
    ctx.font = `${Math.max(9, w / 52)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < size; i++) {
      const p = pad + i * cell;
      ctx.fillText(GTP_LETTERS[i], p, pad * 0.5);
      ctx.fillText(GTP_LETTERS[i], p, w - pad * 0.5);
      ctx.fillText(String(size - i), pad * 0.5, p);
      ctx.fillText(String(size - i), w - pad * 0.5, p);
    }

    // 领地（数子阶段）
    if (!reviewing && g && g.status !== 'playing' && g.scorePreview) {
      const dead = new Set(g.deadStones || []);
      for (const t of g.scorePreview.territory || []) {
        const idx = t.y * size + t.x;
        if (dead.has(idx)) continue;
        const [px, py] = pointToXY(t.x, t.y);
        ctx.fillStyle = t.color === 1 ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.72)';
        ctx.fillRect(px - cell * 0.14, py - cell * 0.14, cell * 0.28, cell * 0.28);
      }
    }

    // 棋子
    const dead = new Set((g && g.deadStones) || []);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = cell * 0.13;
    ctx.shadowOffsetY = cell * 0.05;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = cells[y * size + x];
        if (!c) continue;
        drawStone(x, y, c, dead.has(y * size + x));
      }
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 最后一手
    if (view && view.lastMove) {
      const [px, py] = pointToXY(view.lastMove.x, view.lastMove.y);
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = view.lastMove.color === 1 ? 'rgba(255,255,255,0.92)' : 'rgba(20,20,20,0.85)';
      ctx.fill();
    }

    // 提示点
    if (ui.hintPoint) {
      const [px, py] = pointToXY(ui.hintPoint.x, ui.hintPoint.y);
      const t = (Date.now() % 1000) / 1000;
      ctx.beginPath();
      ctx.arc(px, py, cell * (0.3 + t * 0.22), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(76, 154, 255, ${0.95 - t * 0.7})`;
      ctx.lineWidth = Math.max(2, cell * 0.07);
      ctx.stroke();
    }

    // 悬停预览
    if (ui.hover && g && g.status === 'playing' && !reviewing) {
      const idx = ui.hover.y * size + ui.hover.x;
      const occupied = cells[idx] !== 0;
      const legal = !occupied && !ui.hoverIllegal;
      const [px, py] = pointToXY(ui.hover.x, ui.hover.y);
      if (legal) {
        ctx.globalAlpha = 0.45;
        drawStone(ui.hover.x, ui.hover.y, g.turn, false);
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = 'rgba(220, 40, 40, 0.9)';
        ctx.lineWidth = Math.max(2, cell * 0.08);
        ctx.beginPath();
        ctx.moveTo(px - cell * 0.2, py - cell * 0.2);
        ctx.lineTo(px + cell * 0.2, py + cell * 0.2);
        ctx.moveTo(px + cell * 0.2, py - cell * 0.2);
        ctx.lineTo(px - cell * 0.2, py + cell * 0.2);
        ctx.stroke();
      }
    }

    // 违规落子的红圈提示（短暂闪现）
    if (ui.badPoint) {
      const [px, py] = pointToXY(ui.badPoint.x, ui.badPoint.y);
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.52, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230, 40, 40, 0.95)';
      ctx.lineWidth = Math.max(3, cell * 0.09);
      ctx.stroke();
    }
  }

  function drawStone(x, y, color, isDead) {
    const { cell } = geometry;
    const [px, py] = pointToXY(x, y);
    const r = cell * 0.47;
    const g = ctx.createRadialGradient(px - r * 0.35, py - r * 0.4, r * 0.1, px, py, r);
    if (color === 1) {
      g.addColorStop(0, '#7c848f');
      g.addColorStop(0.35, '#31363d');
      g.addColorStop(1, '#05070a');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.7, '#eef1f5');
      g.addColorStop(1, '#c3c9d2');
    }
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(0.6, cell * 0.02);
    ctx.strokeStyle = color === 1 ? 'rgba(0,0,0,0.5)' : 'rgba(120,128,140,0.55)';
    ctx.stroke();

    if (isDead) {
      ctx.strokeStyle = 'rgba(230, 60, 60, 0.95)';
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.beginPath();
      ctx.moveTo(px - r * 0.7, py - r * 0.7);
      ctx.lineTo(px + r * 0.7, py + r * 0.7);
      ctx.moveTo(px + r * 0.7, py - r * 0.7);
      ctx.lineTo(px - r * 0.7, py + r * 0.7);
      ctx.stroke();
    }
  }

  return {
    setSize(n) {
      size = n;
      resize();
    },
    resize,
    draw,
    pointToXY,
    xyToPoint,
    get size() {
      return size;
    },
  };
})();

// 提示点闪烁
setInterval(() => {
  if (ui.hintPoint) Board.draw();
}, 90);

// ---------------------------------------------------------------- API

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// ---------------------------------------------------------------- 违规落子

/** 本地快速合法性预判：只挡"已经有子"和"劫"，其余交给服务端判定。 */
function localIllegalHint(x, y, game) {
  const idx = y * game.boardSize + x;
  if (game.cells[idx] !== 0) return '这里已经有子了';
  if (game.koPoint === idx) return '这里处于"劫"的位置，需要先在别处应一手';
  return null;
}

function handleIllegal(message, x, y) {
  Sound.illegal();
  shakeBoard();
  toast('这一手不能下', message, 'error', 4200);
  if (Number.isInteger(x) && Number.isInteger(y)) {
    ui.badPoint = { x, y };
    Board.draw();
    setTimeout(() => {
      ui.badPoint = null;
      Board.draw();
    }, 450);
  }
}

// ---------------------------------------------------------------- 落子

async function tryPlay(x, y) {
  const g = state.game;
  if (!g) {
    toast('还没有开始对局', '请先在左侧点击「开始新对局」', 'warn');
    return;
  }
  if (ui.review) {
    toast('正在复盘', '点「回到当前」后才能继续落子', 'warn', 2600);
    return;
  }
  if (ui.sending) return;

  // 数子阶段：点击是标记死子
  if (g.status !== 'playing') {
    const r = await api('/api/game/dead', { method: 'POST', body: { x, y } });
    if (r.ok) {
      Sound.info();
      applyState(r);
    }
    return;
  }

  if (g.mode === 'pve' && g.turn !== g.humanColor) {
    toast('还没轮到你', '现在是电脑思考中', 'warn');
    return;
  }

  const local = localIllegalHint(x, y, g);
  if (local) {
    handleIllegal(local, x, y);
    return;
  }

  ui.sending = true;
  try {
    const r = await api('/api/game/move', { method: 'POST', body: { x, y } });
    if (!r.ok) {
      handleIllegal(r.message || '落子不合规', x, y);
    } else {
      Sound.place();
      if (g.mode === 'pve') setTimeout(() => Sound.ai(), 240);
      applyState(r);
    }
  } finally {
    ui.sending = false;
  }
}

// ---------------------------------------------------------------- 状态渲染

function applyState(next) {
  const prevMoveCount = state.game ? state.game.moveCount : 0;
  const prevId = state.game ? state.game.id : null;
  state = { ...state, ...next };

  const g = state.game;
  if (g) {
    if (g.id !== prevId) {
      Board.setSize(g.boardSize);
      ui.hintPoint = null;
    }
  }
  // 有新的一手、或者换了新对局，就退出复盘，避免看的是过期局面
  if (ui.review && (!g || g.id !== prevId || g.moveCount !== prevMoveCount)) {
    ui.review = null;
  }
  Board.draw();

  render();
}

function render() {
  const g = state.game;
  const e = state.engine || {};

  if (state.version) els.appVersion.textContent = `v${state.version} · `;

  // 引擎信息
  if (e.status === 'ready') {
    els.engineLine.textContent = `${e.backend ? e.backend.label : ''} · ${e.modelKind === 'fast' ? '轻量权重' : '主权重'} · ${e.visitsPerSec} 次访问/秒 · 可支持到 ${e.recommendedMaxLevel}`;
  } else if (e.status === 'loading' || e.status === 'probing') {
    const secs = e.loadingSeconds ? `，已等待 ${e.loadingSeconds} 秒` : '';
    els.engineLine.textContent = e.tuning
      ? `正在对显卡做一次性内核调优（只需一次，可能几分钟${secs}）…`
      : `引擎加载中${secs}…`;
  } else if (e.status === 'builtin') {
    els.engineLine.textContent = `内置引擎（${e.note || '未检测到 KataGo'}）`;
  } else {
    els.engineLine.textContent = '等待引擎…';
  }

  // 难度下拉
  // 引擎能力是异步测出来的，要等它出来之后再刷一次下拉框文案，
  // 否则会拿初始值（0）去判断，把几乎所有难度都标成"性能受限"
  const levelCap = state.engine ? state.engine.maxLevelIndex : null;
  if (
    state.levels &&
    state.levels.length &&
    (els.levelSelect.options.length !== state.levels.length || ui.levelCap !== levelCap)
  ) {
    ui.levelCap = levelCap;
    buildLevelSelect();
  }
  updateLevelHint();

  // 思考中
  els.thinking.hidden = !state.aiThinking;
  if (state.aiThinking) els.thinkingText.textContent = g && g.mode === 'pve' ? '电脑思考中…' : '计算中…';

  if (!g) {
    els.infoMode.textContent = '—';
    els.infoLevel.textContent = '—';
    els.infoStatus.textContent = '未开始';
    els.turnText.textContent = '等待开始';
    els.clockBar.hidden = true;
    return;
  }

  // 基本信息
  els.statMoves.textContent = g.moveCount;
  els.statCapBlack.textContent = g.captures.black;
  els.statCapWhite.textContent = g.captures.white;
  els.infoMode.textContent = g.mode === 'pve' ? '人机对战' : '人人对战';
  const lv = (state.levels || []).find((l) => l.id === g.levelId);
  els.infoLevel.textContent = g.mode === 'pve' && lv ? lv.label : '—';
  els.infoEngine.textContent = state.aiThinking ? '思考中…' : e.engine === 'builtin' ? '内置' : 'KataGo';

  const statusText = { playing: '对局中', scoring: '标记死子', finished: '已结束' }[g.status] || g.status;
  els.infoStatus.textContent = statusText;
  renderClock(g);

  // 回合
  const dot = els.turnChip.querySelector('.stone-dot');
  dot.className = `stone-dot ${g.turn === 1 ? 'black' : 'white'}`;
  if (g.status === 'playing') {
    const who = g.turn === 1 ? '黑棋' : '白棋';
    const isHuman = g.mode === 'pvp' || g.turn === g.humanColor;
    els.turnText.textContent = `${who}落子${isHuman ? '' : '（电脑）'}`;
  } else if (g.status === 'scoring') {
    els.turnText.textContent = '请标记死子后确认终局';
  } else {
    els.turnText.textContent = '对局结束';
  }

  // 按钮可用性
  const playing = g.status === 'playing';
  const myTurn = g.mode === 'pvp' || g.turn === g.humanColor;
  for (const [id, on] of [
    ['#btn-pass', playing && myTurn && !state.aiThinking],
    ['#btn-undo', g.moveCount > 0 && !state.aiThinking],
    ['#btn-hint', playing && !state.aiThinking],
    ['#btn-score', playing || g.status === 'scoring'],
    ['#btn-resign', playing],
  ]) {
    const el = document.querySelector(id);
    if (el) el.disabled = !on;
  }

  // 结果
  if (g.result) {
    els.resultBox.hidden = false;
    els.resultTitle.textContent = '对局结束';
    els.resultText.textContent = g.result.text;
    const d = g.result.detail;
    els.resultDetail.textContent = d
      ? `${d.ruleSet === 'japanese' ? '数目法' : '数子法'}　黑 ${d.black} : 白 ${d.white}（含贴目 ${d.komi}）`
      : '';
  } else {
    els.resultBox.hidden = true;
  }

  // 数子面板
  els.scoringBox.hidden = g.status !== 'scoring';
  if (g.status === 'scoring') renderScorePreview(g);

  // 落子记录
  renderMoveList(g);
  updateMoveHighlight();
  renderReviewBar(g);
  renderEval();
  renderCurveHint();
  drawCurve();

  // 硬件
  const hw = state.hardware;
  if (hw && hw.enabled) {
    els.hardwareBox.hidden = false;
    els.hardwareStatus.textContent = `${hw.driverLabel}：${hw.connected ? '已连接' : '未连接'}${hw.lastError ? ` · ${hw.lastError}` : ''}`;
  } else {
    els.hardwareBox.hidden = true;
  }
}

function renderScorePreview(g) {
  const sp = g.scorePreview;
  if (!sp) {
    els.scorePreview.textContent = '计算中…';
    return;
  }
  const dead = g.deadStones ? g.deadStones.length : 0;
  els.scorePreview.innerHTML =
    `<div>已标记死子：<b>${dead}</b> 颗</div>` +
    `<div>数子法：黑 ${sp.chinese.black.total} ： 白 ${sp.chinese.white.total}</div>` +
    `<div>数目法：黑 ${sp.japanese.black.total} ： 白 ${sp.japanese.white.total}</div>` +
    (g.engineScore ? `<div>KataGo 判定：<b>${g.engineScore}</b></div>` : '') +
    `<div>当前判定：<b>${sp.text}</b></div>`;
}

const fmtTime = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** 棋钟显示。剩余量直接来自服务端，界面不自己倒计时，免得两边对不齐。 */
function renderClock(g) {
  const c = g && g.clock;
  if (!c || !c.enabled) {
    els.clockBar.hidden = true;
    return;
  }
  els.clockBar.hidden = false;

  const sides = [
    [c.black, 1, els.clockBlack, els.clockBlackTime, els.clockBlackByo],
    [c.white, 2, els.clockWhite, els.clockWhiteTime, els.clockWhiteByo],
  ];
  for (const [side, color, card, timeEl, byoEl] of sides) {
    card.classList.toggle('active', c.running === color);
    if (side.main > 0) {
      timeEl.textContent = fmtTime(side.main);
      byoEl.textContent = '';
      card.classList.remove('urgent');
    } else {
      const p = Math.max(0, side.period);
      timeEl.textContent = `${Math.ceil(p)} 秒`;
      byoEl.textContent = `读秒 ×${side.periods}`;
      card.classList.toggle('urgent', p <= 5);
    }
  }
}

function renderMoveList(g) {
  const ol = els.moveList;
  // 棋钟每 0.5 秒推一次状态，这里没必要跟着重建 DOM（会让滚动位置被重置）
  const stamp = `${g.id}:${g.moveCount}`;
  if (ui.moveListStamp === stamp) return;
  ui.moveListStamp = stamp;

  if (!g.moveLog || g.moveLog.length === 0) {
    ol.innerHTML = '<li class="subtle" style="grid-template-columns:1fr">还没有落子</li>';
    return;
  }
  const L = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  const frag = document.createDocumentFragment();
  for (const m of g.moveLog) {
    const li = document.createElement('li');
    li.dataset.ply = String(m.no);
    const coord = m.pass ? '停一手' : `${L[m.x]}${g.boardSize - m.y}`;
    li.innerHTML =
      `<span class="subtle">${m.no}</span>` +
      `<span class="mv-color ${m.color === 1 ? 'black' : 'white'}"></span>` +
      `<span>${coord}</span>` +
      `<span class="mv-cap">${m.captured ? `提${m.captured}` : ''}</span>`;
    frag.appendChild(li);
  }
  ol.innerHTML = '';
  ol.appendChild(frag);
  ol.scrollTop = ol.scrollHeight;
}

/** 只更新落子记录里的"当前手"高亮，不重建整个列表 */
function updateMoveHighlight() {
  const ply = ui.review ? ui.review.ply : -1;
  for (const li of els.moveList.children) {
    li.classList.toggle('current', ply >= 0 && Number(li.dataset.ply) === ply);
  }
}

function buildLevelSelect() {
  const sel = els.levelSelect;
  sel.innerHTML = '';
  const groups = {};
  for (const lv of state.levels) {
    const gname = lv.groupLabel || lv.group;
    if (!groups[gname]) {
      groups[gname] = document.createElement('optgroup');
      groups[gname].label = gname;
      sel.appendChild(groups[gname]);
    }
    const opt = document.createElement('option');
    opt.value = lv.id;
    groups[gname].appendChild(opt);
  }
  // 每次都刷新文案（引擎能力可能后到）
  for (const lv of state.levels) {
    const opt = [...sel.querySelectorAll('option')].find((o) => o.value === lv.id);
    if (!opt) continue;
    const limit = state.engine && state.engine.maxLevelIndex != null && lv.index > state.engine.maxLevelIndex;
    opt.textContent = `${lv.label}（访问 ${lv.visits}${lv.recommendHandicap ? `，建议让 ${lv.recommendHandicap} 子` : ''}）${limit ? ' ⚠ 本机性能受限' : ''}`;
  }
  // 注意不能拿 sel.value 当兜底：新建 select 时它已经是第一个选项了
  const wanted = (state.game && state.game.levelId) || '10k';
  if ([...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
}

function updateLevelHint() {
  const lv = (state.levels || []).find((l) => l.id === els.levelSelect.value);
  if (!lv) {
    els.levelHint.textContent = '';
    return;
  }
  const parts = [
    lv.kind === 'kyu'
      ? `搜索访问 ${lv.visits} 次，思考上限 ${lv.maxTime}s`
      : `搜索访问 ${lv.visits} 次，思考上限 ${lv.maxTime}s`,
  ];
  if (lv.recommendHandicap) parts.push(`推荐让子 ${lv.recommendHandicap} 子`);
  const limit = state.engine && state.engine.maxLevelIndex != null && lv.index > state.engine.maxLevelIndex;
  if (limit) parts.push('⚠ 超出本机性能，每步会明显变慢');
  els.levelHint.textContent = parts.join('；');
}

// ---------------------------------------------------------------- 交互

// ---------------------------------------------------------------- 复盘

// ---------------------------------------------------------------- 形势判断

/** 当前正在看的第几手（复盘时是复盘位置，否则是当前局面） */
function currentPly() {
  const g = state.game;
  if (!g) return 0;
  return ui.review ? ui.review.ply : g.moveCount;
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

async function refreshEval(force = false) {
  if (!ui.evalOn || evalBusy || !state.game) return;
  if (state.aiThinking && !force) return;
  const ply = currentPly();
  if (!force && ui.evalPly === ply && Date.now() - ui.evalAt < 2000) return;

  evalBusy = true;
  try {
    const r = await api(`/api/analysis?ply=${ply}&visits=200`);
    if (r.ok) {
      evalData = r.analysis;
      ui.evalPly = ply;
      ui.evalAt = Date.now();
      renderEval();
    } else {
      evalData = null;
      els.evalDetail.textContent = r.message || '暂时拿不到形势判断';
    }
  } catch (err) {
    els.evalDetail.textContent = `分析失败：${err.message}`;
  } finally {
    evalBusy = false;
  }
}

function renderEval() {
  els.evalPanel.hidden = !ui.evalOn;
  if (!ui.evalOn) return;
  if (!evalData) {
    els.evalDetail.textContent = '等待分析…';
    return;
  }
  const w = Math.max(0, Math.min(1, evalData.winrate));
  els.wrBlack.style.width = `${(w * 100).toFixed(1)}%`;
  els.wrWhite.style.width = `${((1 - w) * 100).toFixed(1)}%`;
  els.wrText.textContent = `黑 ${pct(w)}　白 ${pct(1 - w)}`;

  const lead = evalData.scoreLead;
  const side = lead >= 0 ? '黑' : '白';
  els.evalDetail.textContent = `第 ${evalData.ply} 手 · ${side}领先 ${Math.abs(lead).toFixed(1)} 目 · ${evalData.visits} 次访问`;

  const L = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  els.evalMoves.innerHTML = '';
  for (const m of (evalData.moves || []).slice(0, 4)) {
    const li = document.createElement('li');
    const coord = m.x != null ? `${L[m.x]}${state.game.boardSize - m.y}` : m.move;
    li.innerHTML = `<b>${coord}</b><span>${pct(m.winrate)}</span><span class="pv"></span>`;
    li.querySelector('.pv').textContent = (m.pv || []).slice(1, 8).join(' ');
    li.dataset.x = m.x;
    li.dataset.y = m.y;
    li.title = '点一下在棋盘上标出这个点';
    els.evalMoves.appendChild(li);
  }
}

// ---------------------------------------------------------------- 胜率曲线

function drawCurve() {
  const cv = els.curve;
  const c2 = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  c2.clearRect(0, 0, W, H);

  const pts = curveData && curveData.points ? curveData.points : [];
  const total = curveData ? curveData.total : 0;

  // 中线是五五开，上半偏黑、下半偏白
  c2.fillStyle = 'rgba(255,255,255,0.06)';
  c2.fillRect(0, 0, W, H / 2);
  c2.strokeStyle = 'rgba(255,255,255,0.18)';
  c2.lineWidth = 1;
  c2.beginPath();
  c2.moveTo(0, H / 2);
  c2.lineTo(W, H / 2);
  c2.stroke();

  if (pts.length === 0) return;

  const xOf = (ply) => (total > 0 ? (ply / total) * (W - 2) + 1 : 1);
  const yOf = (wr) => H - wr * H;

  c2.beginPath();
  c2.moveTo(xOf(pts[0].ply), H / 2);
  for (const p of pts) c2.lineTo(xOf(p.ply), yOf(p.winrate));
  c2.lineTo(xOf(pts[pts.length - 1].ply), H / 2);
  c2.closePath();
  c2.fillStyle = 'rgba(76,154,255,0.22)';
  c2.fill();

  c2.beginPath();
  pts.forEach((p, i) => (i ? c2.lineTo(xOf(p.ply), yOf(p.winrate)) : c2.moveTo(xOf(p.ply), yOf(p.winrate))));
  c2.strokeStyle = '#4c9aff';
  c2.lineWidth = 1.8;
  c2.stroke();

  const cur = currentPly();
  if (cur <= total) {
    c2.strokeStyle = 'rgba(255,200,87,0.9)';
    c2.lineWidth = 1.5;
    c2.beginPath();
    c2.moveTo(xOf(cur), 0);
    c2.lineTo(xOf(cur), H);
    c2.stroke();
  }
}

async function pollCurve() {
  const r = await api('/api/analysis/curve');
  if (!r.ok) return;
  const c = r.curve;
  const changed = !curveData || c.points.length !== curveData.points.length || c.running !== curveData.running;
  curveData = c;
  if (changed) {
    drawCurve();
    renderCurveHint();
  }
  if (c.running) setTimeout(pollCurve, 1200);
}

function renderCurveHint() {
  const c = curveData;
  const canAnalyze = state.game && state.game.canReview && state.game.moveCount > 0;
  els.btnAnalyzeAll.disabled = !canAnalyze || Boolean(c && c.running);

  if (!canAnalyze) {
    els.curveHint.textContent =
      state.game && state.game.moveCount > 0 ? '对局结束后可以逐手分析，画出胜率曲线' : '还没有落子';
  } else if (c && c.running) {
    els.curveHint.textContent = `正在分析… ${c.done} / ${c.total + 1}`;
  } else if (c && c.error) {
    els.curveHint.textContent = `分析中断：${c.error}`;
  } else if (c && c.points && c.points.length) {
    els.curveHint.textContent = `已分析 ${c.points.length} 个局面，点曲线可以跳到对应手数`;
  } else {
    els.curveHint.textContent = '点「分析整盘」逐手分析，画出胜率曲线';
  }
}

async function startCurve() {
  els.curveHint.textContent = '正在开始分析…';
  const r = await api('/api/analysis/curve', { method: 'POST', body: { visits: 40 } });
  if (!r.ok) {
    toast('无法开始分析', r.message || '', 'warn');
    return;
  }
  curveData = r.curve;
  renderCurveHint();
  pollCurve();
}

/** 跳到"下完第 ply 手"之后的局面。ply 等于总手数就是回到当前。 */
async function gotoPly(ply) {
  const g = state.game;
  if (!g) return;
  // 对局进行中不给复盘，只有结束之后才能翻
  if (!g.canReview) {
    toast('对局进行中不能复盘', '等下完这盘再看', 'warn', 2600);
    return;
  }
  const total = g.moveCount;
  const n = Math.max(0, Math.min(Math.floor(ply), total));
  if (n === total) return exitReview();

  const r = await api(`/api/game/position?ply=${n}`);
  if (r.ok) {
    ui.review = r.position;
    ui.hover = null;
    Board.draw();
    render();
  }
}

function exitReview() {
  if (!ui.review) return;
  ui.review = null;
  Board.draw();
  render();
}

function renderReviewBar(g) {
  const total = g ? g.moveCount : 0;
  const ply = ui.review ? ui.review.ply : total;
  const allowed = Boolean(g && g.canReview && total > 0);
  els.reviewBar.classList.toggle('reviewing', Boolean(ui.review));
  els.reviewLabel.textContent = !g
    ? '对局进行中不能复盘'
    : total === 0
      ? '还没有落子'
      : !allowed
        ? '对局进行中不能复盘'
        : ui.review
          ? `第 ${ply} 手 / 共 ${total} 手`
          : '当前局面';
  els.btnReviewLive.hidden = !ui.review;
  els.btnReviewFirst.disabled = !allowed || ply <= 0;
  els.btnReviewPrev.disabled = !allowed || ply <= 0;
  els.btnReviewNext.disabled = !allowed || !ui.review || ply >= total;
  els.btnReviewLast.disabled = !allowed || !ui.review || ply >= total;
  els.reviewBar.classList.toggle('locked', !allowed);
}

function bind() {
  // 模式
  $('#mode-group').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    ui.mode = btn.dataset.mode;
    [...ev.currentTarget.children].forEach((b) => b.classList.toggle('active', b === btn));
    const pve = ui.mode === 'pve';
    els.levelField.style.display = pve ? '' : 'none';
    els.colorField.style.display = pve ? '' : 'none';
  });

  // 执子颜色
  $('#color-group').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    ui.humanColor = btn.dataset.color;
    [...ev.currentTarget.children].forEach((b) => b.classList.toggle('active', b === btn));
  });

  // 难度变化时同步推荐让子
  els.levelSelect.addEventListener('change', () => {
    updateLevelHint();
    const lv = (state.levels || []).find((l) => l.id === els.levelSelect.value);
    if (lv && lv.recommendHandicap && ui.mode === 'pve') {
      $('#handicap').value = String(lv.recommendHandicap);
      autoKomi();
    }
  });

  $('#board-size').addEventListener('change', autoKomi);
  $('#handicap').addEventListener('change', autoKomi);

  function autoKomi() {
    const size = Number($('#board-size').value);
    const hc = Number($('#handicap').value);
    $('#komi').value = hc > 0 ? '0.5' : size <= 9 ? '7' : '7.5';
  }

  // 新对局
  $('#btn-new').addEventListener('click', newGame);

  // 操作按钮
  $('#btn-pass').addEventListener('click', async () => {
    const r = await api('/api/game/pass', { method: 'POST' });
    if (r.ok) {
      Sound.info();
      applyState(r);
      if (state.game && state.game.mode === 'pve') setTimeout(() => Sound.ai(), 240);
    } else toast('无法停一手', r.message || '', 'warn');
  });

  $('#btn-undo').addEventListener('click', async () => {
    const r = await api('/api/game/undo', { method: 'POST' });
    if (r.ok) {
      Sound.info();
      applyState(r);
      toast('已悔棋', '', 'info', 1500);
    } else toast('无法悔棋', r.message || '', 'warn');
  });

  $('#btn-resign').addEventListener('click', async () => {
    if (!confirm('确定认输吗？')) return;
    const r = await api('/api/game/resign', { method: 'POST' });
    if (r.ok) {
      Sound.win();
      applyState(r);
    }
  });

  $('#btn-score').addEventListener('click', async () => {
    const r = await api('/api/game/score', { method: 'POST' });
    if (r.ok) {
      Sound.info();
      applyState(r);
    }
  });

  $('#btn-confirm-score').addEventListener('click', async () => {
    const r = await api('/api/game/score', { method: 'POST', body: { confirm: true } });
    if (r.ok) {
      Sound.win();
      applyState(r);
    }
  });

  $('#btn-auto-dead').addEventListener('click', async () => {
    const r = await api('/api/game/auto-dead', { method: 'POST' });
    if (r.ok) {
      applyState(r);
      Sound.info();
      toast('已按 KataGo 的判断标好死子', `共 ${r.dead.length} 颗`, 'ok', 2600);
    } else {
      toast('自动判定不可用', r.message || '', 'warn', 4200);
    }
  });

  // 复盘控制
  els.btnReviewFirst.addEventListener('click', () => gotoPly(0));

  // 形势判断
  els.evalToggle.addEventListener('change', () => {
    ui.evalOn = els.evalToggle.checked;
    els.evalPanel.hidden = !ui.evalOn;
    if (ui.evalOn) {
      evalData = null;
      refreshEval(true);
    }
  });

  els.evalMoves.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-x]');
    if (!li) return;
    const x = Number(li.dataset.x);
    const y = Number(li.dataset.y);
    if (!Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 0) return;
    ui.hintPoint = { x, y };
    Board.draw();
    setTimeout(() => {
      ui.hintPoint = null;
      Board.draw();
    }, 4000);
  });

  // 胜率曲线
  els.btnAnalyzeAll.addEventListener('click', startCurve);
  els.curve.addEventListener('click', (ev) => {
    if (!curveData || !curveData.total) return;
    const rect = els.curve.getBoundingClientRect();
    const ratio = (ev.clientX - rect.left) / rect.width;
    gotoPly(Math.round(ratio * curveData.total));
  });
  els.btnReviewPrev.addEventListener('click', () => {
    const cur = ui.review ? ui.review.ply : (state.game ? state.game.moveCount : 0);
    gotoPly(cur - 1);
  });
  els.btnReviewNext.addEventListener('click', () => gotoPly((ui.review ? ui.review.ply : 0) + 1));
  els.btnReviewLast.addEventListener('click', exitReview);
  els.btnReviewLive.addEventListener('click', exitReview);

  els.moveList.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-ply]');
    if (!li) return;
    gotoPly(Number(li.dataset.ply));
  });

  $('#btn-hint').addEventListener('click', async () => {
    ui.hintPoint = null;
    const r = await api('/api/game/hint', { method: 'POST' });
    if (r.ok && r.move && !r.move.pass) {
      ui.hintPoint = { x: r.move.x, y: r.move.y };
      Board.draw();
      Sound.info();
      toast('建议下在这里', `坐标 ${'ABCDEFGHJKLMNOPQRSTUVWXYZ'[r.move.x]}${Board.size - r.move.y}`, 'info', 2500);
      setTimeout(() => {
        ui.hintPoint = null;
        Board.draw();
      }, 6000);
    } else if (r.ok) {
      toast('建议停一手', '', 'info');
    } else {
      toast('暂时无法提示', r.message || '', 'warn');
    }
  });

  $('#btn-sgf').addEventListener('click', () => {
    window.location.href = '/api/sgf';
  });

  // 导入 SGF 复盘：用文件选择框读成文本再发给服务端
  $('#btn-sgf-load').addEventListener('click', () => els.sgfFile.click());
  els.sgfFile.addEventListener('change', async () => {
    const file = els.sgfFile.files && els.sgfFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const r = await api('/api/sgf/load', { method: 'POST', body: { sgf: text } });
      if (r.ok) {
        ui.review = null;
        ui.moveListStamp = null;
        applyState(r);
        const g = r.game;
        toast(
          '已载入棋谱',
          `${g.boardSize} 路 · 共 ${g.moveCount} 手${g.source && g.source.black ? ` · ${g.source.black} vs ${g.source.white}` : ''}`,
          'ok',
          3200,
        );
        if (g.moveCount > 0) gotoPly(0);
      } else {
        toast('载入失败', r.message || '', 'error', 5000);
      }
    } catch (err) {
      toast('读文件失败', String(err.message || err), 'error');
    } finally {
      els.sgfFile.value = '';
    }
  });

  // 硬件
  $('#btn-hw-test').addEventListener('click', async () => {
    const r = await api('/api/hardware/test', { method: 'POST' });
    toast('已发送测试指令', r.hardware ? `${r.hardware.driverLabel}：${r.hardware.connected ? '已连接' : '未连接'}` : '', 'info');
  });
  $('#btn-hw-reset').addEventListener('click', async () => {
    const r = await api('/api/hardware/reset', { method: 'POST' });
    toast('已发送复位指令', r.hardware ? `${r.hardware.driverLabel}：${r.hardware.connected ? '已连接' : '未连接'}` : '', 'info');
  });

  // 提示音开关
  $('#btn-sound').addEventListener('click', (ev) => {
    ui.soundOn = !ui.soundOn;
    Sound.setEnabled(ui.soundOn);
    ev.currentTarget.textContent = ui.soundOn ? '🔊 提示音' : '🔇 已静音';
    ev.currentTarget.classList.toggle('ghost-btn', true);
  });

  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

  // 棋盘交互
  els.canvas.addEventListener('mousemove', (ev) => {
    const rect = els.canvas.getBoundingClientRect();
    const pt = Board.xyToPoint(ev.clientX - rect.left, ev.clientY - rect.top);
    const changed = (pt && (!ui.hover || pt.x !== ui.hover.x || pt.y !== ui.hover.y)) || (!pt && ui.hover);
    ui.hover = pt;
    if (pt && state.game && state.game.status === 'playing') {
      ui.hoverIllegal = Boolean(localIllegalHint(pt.x, pt.y, state.game));
    } else {
      ui.hoverIllegal = false;
    }
    if (changed) Board.draw();
  });

  els.canvas.addEventListener('mouseleave', () => {
    ui.hover = null;
    Board.draw();
  });

  els.canvas.addEventListener('click', (ev) => {
    const rect = els.canvas.getBoundingClientRect();
    const pt = Board.xyToPoint(ev.clientX - rect.left, ev.clientY - rect.top);
    if (pt) tryPlay(pt.x, pt.y);
  });

  // 触屏
  els.canvas.addEventListener(
    'touchend',
    (ev) => {
      if (!ev.changedTouches.length) return;
      const rect = els.canvas.getBoundingClientRect();
      const t = ev.changedTouches[0];
      const pt = Board.xyToPoint(t.clientX - rect.left, t.clientY - rect.top);
      if (pt) {
        ev.preventDefault();
        tryPlay(pt.x, pt.y);
      }
    },
    { passive: false },
  );

  // 快捷键
  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    const k = ev.key.toLowerCase();

    // 复盘翻页
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
      if (!state.game || !state.game.canReview) return;
      const total = state.game.moveCount;
      const cur = ui.review ? ui.review.ply : total;
      if (ev.key === 'ArrowLeft') gotoPly(cur - 1);
      else if (ev.key === 'ArrowRight') gotoPly(cur + 1);
      else if (ev.key === 'Home') gotoPly(0);
      else exitReview();
      ev.preventDefault();
      return;
    }

    const map = { p: '#btn-pass', u: '#btn-undo', h: '#btn-hint', s: '#btn-score', n: '#btn-new' };
    if (map[k]) {
      const el = document.querySelector(map[k]);
      if (el && !el.disabled) el.click();
      ev.preventDefault();
    }
  });

  window.addEventListener('resize', () => Board.resize());

  // 实体棋盘按键 -> 落子
  window.__hardwareInput = (pt) => tryPlay(pt.x, pt.y);
}

/** 把下拉框的值解析成服务端要的时间限制对象。 */
function parseTimeControl(value) {
  if (!value || value === 'none') return { enabled: false };
  const m = /^(\d+)\+(\d+)x(\d+)$/.exec(value);
  if (!m) return { enabled: false };
  return {
    enabled: true,
    mainTimeSec: Number(m[1]) * 60,
    byoYomiSec: Number(m[2]),
    byoYomiCount: Number(m[3]),
  };
}

async function newGame() {
  const body = {
    mode: ui.mode,
    levelId: els.levelSelect.value,
    humanColor: ui.humanColor,
    boardSize: Number($('#board-size').value),
    handicap: Number($('#handicap').value),
    komi: Number($('#komi').value),
    ruleSet: $('#ruleset').value,
    timeControl: parseTimeControl(els.timeControl.value),
  };
  const r = await api('/api/game/new', { method: 'POST', body });
  if (r.ok) {
    Sound.info();
    ui.hintPoint = null;
    applyState(r);
    toast('新对局开始', `${body.mode === 'pve' ? '人机对战' : '人人对战'} · ${body.boardSize} 路`, 'ok', 2200);
  } else {
    toast('无法开始对局', r.message || '', 'error');
  }
}

// ---------------------------------------------------------------- 启动

async function boot() {
  bind();
  Board.setSize(19);
  Board.resize();

  // 形势判断开着的时候，定时刷新当前看的那一手
  setInterval(() => refreshEval(), 2500);

  // 给截图工具留的钩子：鼠标悬停会有半透明棋子，截图时先清掉
  window.__clearHover = () => {
    ui.hover = null;
    document.body.style.cursor = 'default';
    Board.draw();
  };

  const res = await api('/api/status');
  applyState(res);

  // SSE：引擎状态与对局变化实时推送
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const before = state.game ? `${state.game.moveCount}:${state.game.status}:${state.game.id}` : '';
      applyState(data);
      const after = data.game ? `${data.game.moveCount}:${data.game.status}:${data.game.id}` : '';
      if (before && before !== after && data.game && data.game.moveLog && data.game.moveLog.length) {
        const last = data.game.moveLog[data.game.moveLog.length - 1];
        // 电脑落子时给一声提示音
        if (
          data.game.mode === 'pve' &&
          last.color === data.game.aiColor &&
          !state.aiThinking &&
          data.game.moveCount > 0
        ) {
          Sound.place();
        }
      }
    } catch {
      /* 忽略坏消息 */
    }
  };
  es.onerror = () => {
    els.engineLine.textContent = '与服务端的连接中断，正在重连…';
  };
}

boot();
