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
  check('SGF 含版本号', /AP\[[^\]]+:\d+\.\d+\.\d+\]/.test(sgf), sgf.slice(0, 90));
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

  r = await call('/api/game/dead', 'POST', { x: 4, y: 4 });
  check('可标记死子', r.ok && r.game.deadStones.length === 1, `dead=${r.game.deadStones && r.game.deadStones.length}`);
  r = await call('/api/game/dead', 'POST', { x: 4, y: 4 });
  check('可取消死子标记', r.ok && r.game.deadStones.length === 0);

  r = await call('/api/game/score', 'POST', { confirm: true });
  check('确认终局', r.ok && r.game.status === 'finished');
  check('给出结果文本', Boolean(r.game.result && r.game.result.text), r.game.result && r.game.result.text);
  console.log(`    结果: ${r.game.result.text}`);

  // ---------------- 实体棋盘输入
  console.log('\n实体棋盘输入（反向驱动）');
  r = await call('/api/game/new', 'POST', { mode: 'pvp', boardSize: 9, komi: 7 });
  check('为硬件输入测试新建对局', r.ok && r.game.moveCount === 0);

  r = await call('/api/hardware/input', 'POST', { x: 2, y: 2 });
  check('实体棋盘上报落子被接受', r.ok, JSON.stringify({ reason: r.reason, message: r.message }));
  check('手数增加', r.game && r.game.moveCount === 1, String(r.game && r.game.moveCount));
  check('落子来源标记为 hardware', r.lastMoveSource === 'hardware', String(r.lastMoveSource));
  check('落的是黑棋、轮转给白', r.game.moveLog[0].color === 1 && r.game.turn === 2);

  r = await call('/api/hardware/input', 'POST', { x: 2, y: 2 });
  check('实体棋盘上报同一位置被拒绝', !r.ok && r.reason === 'occupied', JSON.stringify(r.reason));
  check('给出中文提示', typeof r.message === 'string' && r.message.length > 0, r.message);
  check('拒绝后棋盘未被改动', r.game.moveCount === 1);
  check('拒绝原因同步到 lastError', typeof r.error === 'string' && r.error.includes('实体棋盘'), String(r.error));

  r = await call('/api/hardware/input', 'POST', { x: 99, y: 99 });
  check('实体棋盘上报越界坐标被拒绝', !r.ok, JSON.stringify(r.reason));

  r = await call('/api/hardware/input', 'POST', { x: 5, y: 5 });
  check('实体棋盘可以继续落白棋', r.ok && r.game.moveLog[1].color === 2, JSON.stringify(r.reason));

  // ---------------- 硬件接口
  console.log('\n硬件接口状态');
  const st = await call('/api/status');
  check('返回硬件状态', Boolean(st.hardware), JSON.stringify(st.hardware && st.hardware.driver));
  check('返回最后一手来源', 'lastMoveSource' in st, JSON.stringify(st.lastMoveSource));

  console.log(`\n结果： ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
