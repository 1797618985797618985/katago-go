'use strict';

/**
 * 端到端接口测试：新对局 -> 落子 -> AI 应手 -> 违规落子拦截 -> 悔棋 -> 数子 -> SGF。
 * 用法： node tools/api-test.js [baseUrl]    默认 http://127.0.0.1:8099
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8099';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

async function call(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从当前局面里挑一个空点，避免测试写死的坐标刚好被引擎占掉 */
function findEmptyPoint(g, prefer = [[3, 3], [15, 15], [3, 15], [15, 3], [9, 9], [2, 2]]) {
  for (const [x, y] of prefer) {
    if (g.cells[y * g.boardSize + x] === 0) return { x, y };
  }
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === 0) return { x: i % g.boardSize, y: Math.floor(i / g.boardSize) };
  }
  return null;
}

/** 等 AI 落子结束 */
async function waitAi(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await call('/api/status');
    if (!s.aiThinking) return s;
    await sleep(300);
  }
  throw new Error('等待 AI 超时');
}

(async () => {
  console.log(`目标服务: ${BASE}\n`);

  const status = await call('/api/status');
  check('服务可访问', Boolean(status.engine));
  check('返回版本号', Boolean(status.version), JSON.stringify(status.version));
  check('返回难度列表（中国段级位 33 档）', Array.isArray(status.levels) && status.levels.length === 33, `实际 ${status.levels && status.levels.length}`);
  check('引擎状态正常', ['ready', 'builtin'].includes(status.engine.status), status.engine.status);
  console.log(`    引擎: ${JSON.stringify(status.engine.backend)} ${status.engine.visitsPerSec} 访问/秒 可支持到 ${status.engine.recommendedMaxLevel}`);

  // ---------------- 人机对战
  console.log('\n人机对战');
  let r = await call('/api/game/new', 'POST', {
    mode: 'pve',
    boardSize: 19,
    levelId: '10k',
    humanColor: 'black',
    handicap: 0,
    komi: 7.5,
    ruleSet: 'chinese',
  });
  check('创建人机对局', r.ok && r.game && r.game.mode === 'pve');
  check('黑先', r.game.turn === 1);
  check('初始手数 0', r.game.moveCount === 0);

  r = await call('/api/game/move', 'POST', { x: 15, y: 3 });
  check('人类落子成功', r.ok);
  check('落子后手数 1', r.game.moveCount === 1);

  let s = await waitAi();
  check('AI 已应手', s.game.moveCount >= 2, `手数 ${s.game.moveCount}`);
  check('AI 走的是白棋', s.game.moveLog[1] && s.game.moveLog[1].color === 2);

  // ---------------- 违规落子
  console.log('\n违规落子拦截');
  r = await call('/api/game/move', 'POST', { x: 15, y: 3 });
  check('已有子的位置被拒绝', !r.ok && r.reason === 'occupied', JSON.stringify(r.reason));
  check('给出中文提示', typeof r.message === 'string' && r.message.length > 0, r.message);
  check('棋盘未被改动', r.game.moveCount === s.game.moveCount);

  r = await call('/api/game/move', 'POST', { x: -1, y: 5 });
  check('越界坐标被拒绝', !r.ok);

  const beforeCount = (await call('/api/status')).game.moveCount;
  const spot = findEmptyPoint(s.game);
  const r2 = await call('/api/game/move', 'POST', { x: spot.x, y: spot.y });
  check('人类继续落子成功（不挑被占的点）', r2.ok, JSON.stringify(r2.reason));
  s = await waitAi();
  check('人类第二手后 AI 继续应手', s.game.moveCount >= beforeCount + 2, `${beforeCount} -> ${s.game.moveCount}`);

  // ---------------- 悔棋
  console.log('\n悔棋');
  const beforeUndo = (await call('/api/status')).game.moveCount;
  r = await call('/api/game/undo', 'POST');
  check('悔棋成功', r.ok);
  check('回退到人类回合', r.game.turn === r.game.humanColor, `turn=${r.game.turn} human=${r.game.humanColor}`);
  check('手数减少', r.game.moveCount < beforeUndo, `${beforeUndo} -> ${r.game.moveCount}`);

  // ---------------- 提示
  console.log('\n提示功能');
  r = await call('/api/game/hint', 'POST');
  check('返回建议点', r.ok && r.move, JSON.stringify(r.move));
  check('建议点在棋盘内', !r.move || r.move.pass || (r.move.x >= 0 && r.move.x < 19 && r.move.y >= 0 && r.move.y < 19));

  // ---------------- SGF
  console.log('\nSGF 导出');
  const sgfRes = await fetch(BASE + '/api/sgf');
  const sgf = await sgfRes.text();
  check('SGF 以 (; 开头', sgf.startsWith('(;'), sgf.slice(0, 40));
  check(
    'SGF 版本号与服务端一致',
    sgf.includes(`AP[katago-go:${status.version}]`),
    `${sgf.slice(0, 90)} | 服务端版本 ${status.version}`,
  );
  check('SGF 含棋盘大小', sgf.includes('SZ[19]'));

  // ---------------- 人人对战 + 数子
  console.log('\n人人对战与终局数子');
  r = await call('/api/game/new', 'POST', {
    mode: 'pvp',
    boardSize: 9,
    komi: 7,
    ruleSet: 'chinese',
  });
  check('创建人人对局', r.ok && r.game.mode === 'pvp' && r.game.boardSize === 9);

  r = await call('/api/game/move', 'POST', { x: 4, y: 4 });
  check('人人模式黑可落子', r.ok);
  r = await call('/api/game/move', 'POST', { x: 4, y: 5 });
  check('人人模式白可落子（同一台设备）', r.ok && r.game.moveLog[1].color === 2);

  r = await call('/api/game/pass', 'POST');
  check('黑停一手', r.ok && r.game.status === 'playing');
  r = await call('/api/game/pass', 'POST');
  check('双方停手后进入数子阶段', r.ok && r.game.status === 'scoring', r.game && r.game.status);
  check('数子阶段提供计分预览', Boolean(r.game.scorePreview), JSON.stringify(r.game.scorePreview && r.game.scorePreview.text));

  // 进入数子阶段后服务端会自动判定一次死子，所以这里只验证"点一下状态会变"
  const deadBefore = r.game.deadStones.length;
  r = await call('/api/game/dead', 'POST', { x: 4, y: 4 });
  check('点击棋块可以切换死子标记', r.ok && r.game.deadStones.length !== deadBefore, `${deadBefore} -> ${r.game.deadStones.length}`);
  const deadMid = r.game.deadStones.length;
  r = await call('/api/game/dead', 'POST', { x: 4, y: 4 });
  check('再点一次可以改回来', r.ok && r.game.deadStones.length === deadBefore, `${deadMid} -> ${r.game.deadStones.length}`);

  // 自动判定死子（有 KataGo 才做，没有则应给出明确提示）
  r = await call('/api/game/auto-dead', 'POST');
  if (r.reason === 'no-engine') {
    check('没有引擎时给出明确提示', /手动/.test(r.message || ''), JSON.stringify(r.message));
  } else {
    check('自动判定死子返回结果', r.ok && Array.isArray(r.dead), JSON.stringify({ ok: r.ok, reason: r.reason }));
  }

  r = await call('/api/game/score', 'POST', { confirm: true });
  check('确认终局', r.ok && r.game.status === 'finished');
  check('给出结果文本', Boolean(r.game.result && r.game.result.text), r.game.result && r.game.result.text);
  console.log(`    结果: ${r.game.result.text}`);

  // ---------------- 人机对战：玩家执白
  console.log('\n人机对战（玩家执白）');
  r = await call('/api/game/new', 'POST', {
    mode: 'pve',
    boardSize: 9,
    levelId: '15k',
    humanColor: 'white',
    komi: 7,
  });
  check('创建执白对局', r.ok && r.game.humanColor === 2 && r.game.aiColor === 1, JSON.stringify(r.game && [r.game.humanColor, r.game.aiColor]));
  check('执白时轮到电脑先走', r.game.turn === 1);

  s = await waitAi(60000);
  check('电脑执黑自动先下了一手', s.game.moveCount >= 1 && s.game.moveLog[0].color === 1, `手数 ${s.game.moveCount}`);

  // 认输必须是玩家认输，不能替电脑认输
  r = await call('/api/game/resign', 'POST');
  check('玩家认输后电脑（黑）获胜', r.ok && r.game.result.winner === 1, JSON.stringify(r.game.result));
  check('执白时认输不会把胜利判给自己', r.game.result.winner !== r.game.humanColor);

  // ---------------- 终局前置条件
  console.log('\n终局前置条件');
  r = await call('/api/game/new', 'POST', { mode: 'pvp', boardSize: 9, komi: 7 });
  r = await call('/api/game/move', 'POST', { x: 4, y: 4 });
  check('新建人人对局并落子', r.ok);
  r = await call('/api/game/score', 'POST', { confirm: true });
  check('未进入数子阶段不能直接确认终局', !r.ok && r.reason === 'not-scoring', JSON.stringify({ ok: r.ok, reason: r.reason, message: r.message }));
  check('对局没有被误结束', r.game.status === 'playing');

  r = await call('/api/game/score', 'POST');
  check('可以主动进入数子阶段', r.ok && r.game.status === 'scoring');
  r = await call('/api/game/score', 'POST', { confirm: true });
  check('数子阶段可以确认终局', r.ok && r.game.status === 'finished');

  // ---------------- 时间限制
  console.log('\n时间限制');
  r = await call('/api/game/new', 'POST', {
    mode: 'pvp',
    boardSize: 9,
    komi: 7,
    timeControl: { enabled: true, mainTimeSec: 600, byoYomiSec: 30, byoYomiCount: 3 },
  });
  check('可以创建带棋钟的对局', r.ok && r.game.clock.enabled === true, JSON.stringify(r.game && r.game.clock));
  check('初始剩余时间等于基本用时', Math.abs(r.game.clock.black.main - 600) < 1, String(r.game.clock.black.main));
  check('初始读秒次数正确', r.game.clock.black.periods === 3 && r.game.clock.black.period === 0);

  await sleep(1600);
  s = await call('/api/status');
  check('轮到我的一方棋钟在走', s.game.clock.black.main < 599, String(s.game.clock.black.main));
  check('对方棋钟不动', Math.abs(s.game.clock.white.main - 600) < 0.01, String(s.game.clock.white.main));

  // ---------------- 复盘
  console.log('\n复盘');
  r = await call('/api/game/new', 'POST', { mode: 'pvp', boardSize: 9, komi: 7 });
  await call('/api/game/move', 'POST', { x: 4, y: 4 });
  await call('/api/game/move', 'POST', { x: 5, y: 5 });
  r = await call('/api/game/position?ply=1');
  check('能取到第 1 手之后的局面', r.ok && r.position.ply === 1, JSON.stringify(r.position && r.position.ply));
  check('第 1 手之后只有一颗子', r.position.cells.filter((c) => c !== 0).length === 1);
  check('第 1 手之后轮到白棋', r.position.turn === 2);
  check(
    '最后一手标记正确',
    r.position.lastMove && r.position.lastMove.x === 4 && r.position.lastMove.y === 4,
    JSON.stringify(r.position.lastMove),
  );
  r = await call('/api/game/position?ply=0');
  check('ply=0 是空盘', r.position.cells.filter((c) => c !== 0).length === 0);
  r = await call('/api/game/position');
  check('不带 ply 时返回当前局面', r.position.isLive === true && r.position.ply === 2, JSON.stringify(r.position.ply));
  r = await call('/api/game/position?ply=99');
  check('ply 超出手数时截到当前局面', r.position.ply === 2 && r.position.isLive === true);

  // ---------------- 形势判断与胜率曲线
  console.log('\n形势判断与胜率曲线');
  r = await call('/api/game/new', 'POST', { mode: 'pvp', boardSize: 9, komi: 7 });
  for (const [x, y] of [[2, 2], [2, 6], [6, 2]]) await call('/api/game/move', 'POST', { x, y });
  check('为分析准备了一盘棋', r.ok !== undefined);

  r = await call('/api/analysis?ply=3&visits=60');
  if (r.reason === 'no-engine') {
    check('没有引擎时形势判断给出明确提示', /KataGo/.test(r.message || ''), JSON.stringify(r.message));
  } else {
    check('形势判断返回成功', r.ok === true, JSON.stringify({ ok: r.ok, message: r.message }));
    check('胜率在 0~1 之间', r.analysis.winrate >= 0 && r.analysis.winrate <= 1, String(r.analysis.winrate));
    check('给出目差', Number.isFinite(r.analysis.scoreLead), String(r.analysis.scoreLead));
    check('给出访问数', r.analysis.visits > 0, String(r.analysis.visits));
    check('分析的是第 3 手之后', r.analysis.ply === 3, String(r.analysis.ply));
    check('返回候选点列表', Array.isArray(r.analysis.moves) && r.analysis.moves.length > 0);
    check(
      '候选点带上了内部坐标',
      r.analysis.moves.every((m) => Number.isInteger(m.x) && Number.isInteger(m.y)),
      JSON.stringify(r.analysis.moves[0]),
    );
  }

  r = await call('/api/analysis/curve', 'POST', { visits: 20 });
  if (r.reason === 'no-engine' || (r.curve && r.curve.total === 0 && !r.ok)) {
    check('无引擎时不启动曲线分析', true);
  } else {
    check('可以启动整盘分析', r.ok === true && r.curve.running === true, JSON.stringify(r.curve));
    check('曲线总点数等于手数', r.curve.total === 3, String(r.curve.total));
    await sleep(6000);
    r = await call('/api/analysis/curve');
    check('分析有进度', r.curve.done > 0, JSON.stringify({ done: r.curve.done, total: r.curve.total }));
    check(
      '曲线的胜率都在 0~1 之间',
      r.curve.points.every((p) => p.winrate >= 0 && p.winrate <= 1),
      JSON.stringify(r.curve.points),
    );
    r = await call('/api/analysis/curve', 'DELETE');
    check('可以取消分析', r.ok === true && r.curve.running === false);
  }

  // ---------------- 硬件接口
  console.log('\n硬件接口');
  const st = await call('/api/status');
  check('返回硬件状态', Boolean(st.hardware), JSON.stringify(st.hardware && st.hardware.driver));

  console.log(`\n结果： ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
