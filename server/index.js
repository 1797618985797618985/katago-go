'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { loadConfig, ROOT, APP_DIR } = require('./config');
const { VERSION } = require('./version');
const { Game, defaultKomi } = require('./game/game');
const { gameFromSGF } = require('./game/sgf');
const { EngineManager } = require('./engine/manager');
const { listLevels, findLevel, paramsForLevel } = require('./engine/levels');
const { HardwareBridge } = require('./hardware');
const rules = require('./game/board');

const cfg = loadConfig();
// 前端资源跟着代码走（打包后在 asar 里），引擎和权重才在 ROOT 下
const PUBLIC_DIR = path.join(APP_DIR, 'public');

const engine = new EngineManager();
const hardware = new HardwareBridge({ config: cfg });

/** 当前对局。本程序定位是"一台机器一盘棋"，所以只保留一个会话。 */
let game = null;
let aiThinking = false;
let lastError = null;

const sseClients = new Set();

// ---------------------------------------------------------------- 工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/** 非法落子的中文提示。 */
const REASON_TEXT = {
  occupied: '这里已经有子了',
  ko: '这里处于"劫"的位置，需要先在别处应一手',
  superko: '这一手会造成全局同形（禁全同），不能落子',
  suicide: '这一手自己的棋没有气（自杀手），不能落子',
  'out-of-board': '落子点超出棋盘范围',
  'not-playing': '当前不在对局中',
  'wrong-turn': '还没轮到你落子',
  'already-finished': '对局已经结束',
  empty: '这里没有棋子',
};

function fullState() {
  return {
    version: VERSION,
    game: game ? game.toState() : null,
    aiThinking,
    engine: engine.describe(),
    hardware: hardware.status(),
    levels: listLevels(),
    error: lastError,
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(fullState())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function moveBody(move) {
  return move ? { x: move.x, y: move.y, pass: move.pass, color: move.color, no: move.no } : null;
}

// ---------------------------------------------------------------- AI 回合

let aiScheduled = false;

async function maybeRunAi() {
  if (!game || game.mode !== 'pve') return;
  if (game.status !== 'playing') return;
  if (game.turn !== game.aiColor) return;
  if (aiScheduled) return;
  aiScheduled = true;
  aiThinking = true;
  broadcast();

  try {
    const color = game.turn;
    // 电脑的思考时间也要受自己的棋钟限制，不然读秒会直接被拖死
    const remain = game.remainingSeconds(color);
    const maxTimeCap = Number.isFinite(remain) ? Math.max(0.5, Math.min(remain * 0.5, 30)) : undefined;
    const mv = await engine.genmove(game, color, game.levelId, { maxTimeCap });
    if (!game || game.status !== 'playing' || game.turn !== color) return;

    if (mv.resign) {
      game.resign(color);
      await hardware.onGameEnd(game);
    } else if (mv.pass) {
      game.pass(color);
      if (game.status === 'scoring') await hardware.onSync(game);
    } else {
      const r = game.play(mv.x, mv.y, color);
      if (!r.ok) {
        // 引擎给出非法手：停一手兜底，避免整局卡死
        lastError = `AI 给出的落子非法（${REASON_TEXT[r.reason] || r.reason}），已改为停一手`;
        game.pass(color);
      } else {
        const move = game.moveLog[game.moveLog.length - 1];
        await hardware.onMove(game, move, (r.captured || []).map((i) => rules.xyOf(game.boardSize, i)));
      }
      if (game.status === 'scoring') await hardware.onSync(game);
    }
    if (game.status === 'scoring') maybeAutoDead();
  } catch (err) {
    lastError = `AI 出子失败：${err.message}`;
    console.warn('[ai]', err);
  } finally {
    aiThinking = false;
    aiScheduled = false;
    broadcast();
  }
}

/**
 * 进入数子阶段后自动判定死子。
 * 用 game.id + 手数 做去重，同一局面只判一次，避免用户手动改完又被覆盖。
 */
let autoDeadKey = null;
async function maybeAutoDead() {
  if (!game || game.status !== 'scoring') {
    autoDeadKey = null;
    return;
  }
  const key = `${game.id}:${game.moveLog.length}`;
  if (autoDeadKey === key) return;
  autoDeadKey = key;

  const result = await engine.autoDead(game);
  if (!result) {
    lastError = null;
    broadcast();
    return;
  }
  if (game && game.status === 'scoring' && `${game.id}:${game.moveLog.length}` === key) {
    game.setDeadStones(result.dead);
    if (result.score) game.engineScore = result.score;
    broadcast();
  }
}

// ---------------------------------------------------------------- 路由

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(fullState())}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (p === '/api/status' && method === 'GET') {
    return sendJson(res, 200, fullState());
  }

  if (p === '/api/game/new' && method === 'POST') {
    const body = await readBody(req);
    const boardSize = [9, 13, 19].includes(body.boardSize) ? body.boardSize : cfg.defaults.boardSize || 19;
    const levelId = findLevel(body.levelId) ? body.levelId : cfg.defaults.level || '10k';
    const handicap = Math.max(0, Math.min(9, body.handicap || 0));
    let komi = typeof body.komi === 'number' ? body.komi : defaultKomi(boardSize, handicap);
    if (handicap > 0 && body.komi == null) komi = 0.5;

    game = new Game({
      mode: body.mode === 'pvp' ? 'pvp' : 'pve',
      boardSize,
      ruleSet: body.ruleSet === 'japanese' ? 'japanese' : 'chinese',
      handicap,
      komi,
      levelId,
      humanColor: body.humanColor === 'white' ? rules.WHITE : rules.BLACK,
      timeControl: body.timeControl,
    });
    lastError = null;
    await hardware.onGameStart(game);
    broadcast();
    maybeRunAi();
    return sendJson(res, 200, { ok: true, ...fullState() });
  }

  if (!game) return sendJson(res, 400, { ok: false, message: '还没有开始对局' });

  if (p === '/api/game/move' && method === 'POST') {
    const body = await readBody(req);
    if (game.status !== 'playing') {
      return sendJson(res, 200, { ok: false, reason: 'not-playing', message: REASON_TEXT['not-playing'], ...fullState() });
    }
    if (game.mode === 'pve' && game.turn !== game.humanColor) {
      return sendJson(res, 200, { ok: false, reason: 'wrong-turn', message: '现在是电脑思考中', ...fullState() });
    }
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return sendJson(res, 200, { ok: false, reason: 'bad-point', message: '落子点不合法', ...fullState() });
    }
    const r = game.play(x, y, game.turn);
    if (!r.ok) {
      const message = REASON_TEXT[r.reason] || `不能落子（${r.reason}）`;
      return sendJson(res, 200, { ok: false, reason: r.reason, x, y, message, ...fullState() });
    }
    const move = game.moveLog[game.moveLog.length - 1];
    await hardware.onMove(game, move, (r.captured || []).map((i) => rules.xyOf(game.boardSize, i)));
    broadcast();
    maybeRunAi();
    return sendJson(res, 200, { ok: true, captured: r.captured, ...fullState() });
  }

  if (p === '/api/game/pass' && method === 'POST') {
    if (game.mode === 'pve' && game.turn !== game.humanColor) {
      return sendJson(res, 200, { ok: false, reason: 'wrong-turn', message: '现在是电脑思考中' });
    }
    const r = game.pass(game.turn);
    if (!r.ok) return sendJson(res, 200, { ok: false, reason: r.reason, message: REASON_TEXT[r.reason] });
    await hardware.onSync(game);
    broadcast();
    if (game.status === 'scoring') maybeAutoDead();
    maybeRunAi();
    return sendJson(res, 200, { ok: true, ...fullState() });
  }

  if (p === '/api/game/undo' && method === 'POST') {
    if (game.moveLog.length === 0) return sendJson(res, 200, { ok: false, message: '没有可悔的棋' });
    // 人机模式：一次回退到玩家自己的回合
    let steps = 1;
    if (game.mode === 'pve') {
      steps = game.turn === game.humanColor ? 2 : 1;
      steps = Math.min(steps, game.moveLog.length);
    }
    game.undo(steps);
    await hardware.onSync(game);
    broadcast();
    return sendJson(res, 200, { ok: true, ...fullState() });
  }

  if (p === '/api/game/resign' && method === 'POST') {
    if (game.status !== 'playing') {
      return sendJson(res, 200, { ok: false, reason: 'not-playing', message: REASON_TEXT['not-playing'], ...fullState() });
    }
    // 人机对战里认输的永远是玩家，不能替电脑认输
    const who = game.mode === 'pve' ? game.humanColor : game.turn;
    const r = game.resign(who);
    if (r.ok) await hardware.onGameEnd(game);
    broadcast();
    return sendJson(res, 200, { ok: r.ok, ...fullState() });
  }

  if (p === '/api/game/dead' && method === 'POST') {
    const body = await readBody(req);
    const r = game.toggleDead(Number(body.x), Number(body.y));
    broadcast();
    return sendJson(res, 200, { ok: r.ok, ...fullState() });
  }

  if (p === '/api/game/score' && method === 'POST') {
    const body = await readBody(req);
    if (body.confirm) {
      // 第二步：确认终局
      if (game.status !== 'scoring') {
        return sendJson(res, 200, {
          ok: false,
          reason: 'not-scoring',
          message: game.status === 'finished' ? '对局已经结束' : '请先进入数子阶段并标记死子',
          ...fullState(),
        });
      }
      const preview = game.computeScore();
      if (!game.result) game.confirmScore();
      await hardware.onGameEnd(game);
      broadcast();
      return sendJson(res, 200, { ok: true, score: preview, ...fullState() });
    }
    // 第一步：进入数子阶段，让用户标记死子
    if (game.status === 'playing') game.beginScoring();
    broadcast();
    maybeAutoDead();
    return sendJson(res, 200, { ok: true, ...fullState() });
  }

  /** 手动触发自动判定死子（界面上的"自动判定死子"按钮）。 */
  if (p === '/api/game/auto-dead' && method === 'POST') {
    if (game.status !== 'scoring') {
      return sendJson(res, 200, { ok: false, reason: 'not-scoring', message: '还没进入数子阶段', ...fullState() });
    }
    const result = await engine.autoDead(game);
    if (!result) {
      return sendJson(res, 200, {
        ok: false,
        reason: 'no-engine',
        message: '自动判定需要 KataGo，当前不可用，请手动点击棋块标记死子',
        ...fullState(),
      });
    }
    game.setDeadStones(result.dead);
    if (result.score) game.engineScore = result.score;
    autoDeadKey = `${game.id}:${game.moveLog.length}`;
    broadcast();
    return sendJson(res, 200, { ok: true, dead: result.dead, score: result.score, ...fullState() });
  }

  if (p === '/api/game/hint' && method === 'POST') {
    if (game.status !== 'playing') return sendJson(res, 200, { ok: false, message: '当前不能提示' });
    aiThinking = true;
    broadcast();
    try {
      const color = game.turn;
      const mv = await engine.hint(game, color, game.levelId);
      await hardware.onHint(mv.pass || mv.resign ? null : mv, color);
      return sendJson(res, 200, { ok: true, move: moveBody(mv), ...fullState() });
    } finally {
      aiThinking = false;
      broadcast();
    }
  }

  /**
   * 复盘用：取"下完第 ply 手之后"的局面。
   * ply 省略或等于手数时就是当前局面。
   */
  if (p === '/api/game/position' && method === 'GET') {
    const ply = url.searchParams.get('ply');
    return sendJson(res, 200, { ok: true, position: game.positionAt(ply == null ? game.moveLog.length : Number(ply)) });
  }

  if (p === '/api/sgf' && method === 'GET') {
    const sgf = game.toSGF();
    res.writeHead(200, {
      'Content-Type': 'application/x-go-sgf; charset=utf-8',
      'Content-Disposition': `attachment; filename="game-${Date.now()}.sgf"`,
    });
    return res.end(sgf);
  }

  /**
   * 读入 SGF 复盘。
   * 前端用文件选择框读成文本 POST 过来（桌面版同样走这条路，不需要额外权限）。
   */
  if (p === '/api/sgf/load' && method === 'POST') {
    const body = await readBody(req);
    if (!body.sgf || typeof body.sgf !== 'string') {
      return sendJson(res, 200, { ok: false, message: '没有收到 SGF 内容' });
    }
    try {
      const loaded = gameFromSGF(body.sgf);
      game = loaded;
      lastError = null;
      autoDeadKey = null;
      aiThinking = false;
      aiScheduled = false;
      broadcast();
      return sendJson(res, 200, { ok: true, ...fullState() });
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: `SGF 解析失败：${err.message}` });
    }
  }

  if (p === '/api/hardware/test' && method === 'POST') {
    await hardware.send({ cmd: 'ping' });
    return sendJson(res, 200, { ok: true, hardware: hardware.status() });
  }

  if (p === '/api/hardware/reset' && method === 'POST') {
    await hardware.send({ cmd: 'reset', size: game ? game.boardSize : 19, komi: game ? game.komi : 7.5 });
    return sendJson(res, 200, { ok: true, hardware: hardware.status() });
  }

  return sendJson(res, 404, { ok: false, message: '未知接口' });
}

function createHttpServer() {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: err.message });
    else res.end();
  }
  });
}

// ---------------------------------------------------------------- 启动

/**
 * 启动整套服务。
 * 桌面版（Electron）和命令行版都用这一个入口，区别只是谁来开窗口。
 *
 * @param {{port?: number, host?: string, quiet?: boolean}} options
 *        port 传 0 表示让系统分配一个空闲端口，避免和别的程序撞车
 */
async function startServer(options = {}) {
  const host = options.host || cfg.server.host || '127.0.0.1';
  const port = options.port != null ? options.port : cfg.server.port || 8080;
  const quiet = Boolean(options.quiet);

  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;

  if (!quiet) {
    console.log('');
    console.log(`  围棋对战程序 v${VERSION}`);
    console.log('  ----------------------------------------');
    console.log(`  界面地址: ${url}`);
    console.log('');
    console.log('  引擎正在后台初始化（首次使用 OpenCL 需要做一次性内核调优，可能要几分钟）...');
  }

  hardware.start();

  // 棋钟：每 0.5 秒推进一次。只有开了时间限制的对局才需要推送。
  const clockTimer = setInterval(() => {
    if (!game || game.status !== 'playing' || !game.clock.enabled) return;
    const t = game.tickClock();
    if (t && t.timeout != null) {
      game.loseOnTime(t.timeout);
      Promise.resolve(hardware.onGameEnd(game)).catch(() => {});
    }
    broadcast();
  }, 500);
  clockTimer.unref?.();

  // 引擎初始化放在后台跑，别挡住窗口打开
  const engineReady = engine.init().catch((err) => {
    console.error('[engine] 初始化异常:', err);
  });
  broadcast();

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    // 先掐掉所有 SSE 长连接：它们是 keep-alive 的，
    // 不断开的话 server.close() 会一直等下去，桌面版退出就会卡住
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* 忽略 */
      }
    }
    sseClients.clear();
    clearInterval(clockTimer);
    await engine.shutdown();
    await hardware.stop();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };

  return { server, port: actualPort, host, url, engineReady, shutdown };
}

// 直接 node server/index.js 运行时才进命令行模式
if (require.main === module) {
  startServer().then(({ shutdown }) => {
    process.on('SIGINT', async () => {
      console.log('\n正在关闭 ...');
      await shutdown();
      process.exit(0);
    });
  });
}

module.exports = { startServer, createHttpServer };
