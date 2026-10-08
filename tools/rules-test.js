'use strict';

/**
 * 规则引擎单元测试：提子、自杀、劫、禁全同、让子、数子。
 * 用法： node tools/rules-test.js
 */

const { GoBoard } = require('../server/game/goban');
const rules = require('../server/game/board');
const { Game } = require('../server/game/game');
const { gameFromSGF, parseNodes } = require('../server/game/sgf');

const { BLACK, WHITE } = rules;

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

function section(t) {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------- 提子
section('提子');
{
  const b = new GoBoard(19);
  // 白子 (1,1)，黑子在左、上、下三面，只剩 (2,1) 一口气
  b.play(1, 1, WHITE);
  b.play(0, 1, BLACK);
  b.play(1, 0, BLACK);
  b.play(1, 2, BLACK);
  check('围住三面时白子还有气', b.get(1, 1) === WHITE);
  const r = b.play(2, 1, BLACK);
  check('最后一手气被封 → 提子成功', r.ok && r.captured.length === 1 && b.get(1, 1) === 0);
  check('提子数记录正确', b.captures[BLACK] === 1);
  check('这一手不是劫', b.koPoint === null);
}

// ---------------------------------------------------------------- 自杀
section('自杀手');
{
  const b = new GoBoard(19);
  b.play(0, 0, WHITE);
  b.play(1, 0, WHITE);
  b.play(0, 1, WHITE);
  const r = b.play(0, 0, BLACK);
  check('填进对方眼位会被判为自杀（原位置有子，先验证占用）', !r.ok);

  const b2 = new GoBoard(19);
  b2.play(1, 0, WHITE);
  b2.play(0, 1, WHITE);
  const r2 = b2.play(0, 0, BLACK);
  check('无气且提不到子 → 禁止落子', !r2.ok && r2.reason === 'suicide');
  check('非法手不改变棋盘', b2.get(0, 0) === 0);

  const b3 = new GoBoard(19);
  b3.play(1, 0, WHITE);
  b3.play(0, 1, BLACK);
  const r3 = b3.play(0, 0, BLACK);
  check('可以落子吃掉对方（有气）', r3.ok);
}

// ---------------------------------------------------------------- 劫
section('劫争（禁全同）');
{
  // 标准劫形：
  //   白 (1,1) 只剩 (2,1) 一口气；白另在 (2,0)(3,1)(2,2) 有子，
  //   使得黑提子后落在 (2,1) 的黑子本身也只有一口气 → 形成劫
  const bb = new GoBoard(19);
  bb.play(1, 1, WHITE);
  bb.play(2, 0, WHITE);
  bb.play(3, 1, WHITE);
  bb.play(2, 2, WHITE);
  bb.play(0, 1, BLACK);
  bb.play(1, 0, BLACK);
  bb.play(1, 2, BLACK);

  const cap = bb.play(2, 1, BLACK);
  check('黑提劫成功', cap.ok && bb.get(1, 1) === 0);
  check('记录劫点 (1,1)', bb.koPoint === rules.idxOf(19, 1, 1), `koPoint=${bb.koPoint}`);

  const recapture = bb.play(1, 1, WHITE);
  check('白立即回提被禁止', !recapture.ok);

  // 白先在别处找劫材，黑应一手，之后回提就合法
  const threat = bb.play(6, 6, WHITE);
  const answer = bb.play(7, 7, BLACK);
  check('白在别处找劫材、黑应一手', threat.ok && answer.ok);
  const recapture2 = bb.play(1, 1, WHITE);
  check('白回应后可以回提', recapture2.ok);
  check('回提后黑子被吃掉', bb.get(2, 1) === 0);
}

// ---------------------------------------------------------------- 禁全同
section('禁全同（超级劫）');
{
  const g = new Game({ boardSize: 19, mode: 'pvp' });
  // 棋盘已经出现过空局面，重复出现会被拒绝（用一个不可能的构造验证 Set 生效）
  const seenBefore = g.board.seen.size;
  g.play(0, 0, BLACK);
  check('落子后局面集合增长', g.board.seen.size > seenBefore);
}

// ---------------------------------------------------------------- 让子
section('让子与先行');
{
  const g = new Game({ boardSize: 19, handicap: 4, mode: 'pve' });
  const stones = g.board.cells.filter((c) => c === BLACK).length;
  check('4 让子摆放正确', stones === 4);
  check('让子局由白先行', g.turn === WHITE);
  check('让子局贴目为 0.5', g.komi === 0.5);
  const h5 = rules.handicapPoints(19, 5);
  check('5 子包含天元', h5[4].x === 9 && h5[4].y === 9);
  const h8 = rules.handicapPoints(19, 8);
  check('8 子不含天元', !h8.some((p) => p.x === 9 && p.y === 9));
  check('8 子包含四个边星', h8.length === 8);
}

// ---------------------------------------------------------------- 数子
section('终局数子');
{
  const g = new Game({ boardSize: 9, mode: 'pvp', komi: 7 });
  // 黑在第 4 列筑墙，白占 5~8 列，0~3 列全空
  // → 空的那片只被黑棋包围，应判为黑地 36 目
  for (let y = 0; y < 9; y++) {
    g.board.cells[y * 9 + 4] = BLACK;
    for (let x = 5; x <= 8; x++) g.board.cells[y * 9 + x] = WHITE;
  }
  const s = g.computeScore();
  check('黑棋 9 子', s.chinese.black.stones === 9);
  check('白棋 36 子', s.chinese.white.stones === 36);
  check('黑地 36 目', s.chinese.black.territory === 36, `实际 ${s.chinese.black.territory}`);
  check('白无地（被自己填满）', s.chinese.white.territory === 0);
  check('数子法白棋含贴目 7', Math.abs(s.chinese.white.total - 43) < 1e-9);
  check('数子法黑棋 45', s.chinese.black.total === 45);
  check('胜方为黑（黑多 2 目）', s.winner === BLACK && s.margin === 2, `实际 ${s.text}`);

  // 标记死子：点一下会把整块连通的棋一起标记（符合实际数子习惯）
  g.status = 'scoring';
  g.toggleDead(5, 0);
  check('整块连通的白棋被一起标记为死子', g.deadStones.size === 36, `实际 ${g.deadStones.size}`);
  const s2 = g.computeScore();
  check('死子从白棋中移除', s2.chinese.white.stones === 0);
  check('死子计入对方提子（数目法）', s2.japanese.black.prisoners === 36, `实际 ${s2.japanese.black.prisoners}`);

  g.toggleDead(5, 0);
  check('再次点击可取消标记', g.deadStones.size === 0);

  // 孤立的一子只标记自己
  g.board.cells[0] = WHITE;
  g.toggleDead(0, 0);
  check('孤立棋子只标记自己', g.deadStones.size === 1, `实际 ${g.deadStones.size}`);
  g.toggleDead(0, 0);
  check('再点一次取消该子', g.deadStones.size === 0);
}

// ---------------------------------------------------------------- 停一手与终局
section('停一手与终局');
{
  const g = new Game({ boardSize: 9, mode: 'pvp' });
  g.pass(BLACK);
  check('一次停手后仍在进行', g.status === 'playing');
  g.pass(WHITE);
  check('双方连续停手 → 进入数子阶段', g.status === 'scoring');
  g.confirmScore();
  check('确认终局后状态为 finished', g.status === 'finished');
  check('产生结果文本', Boolean(g.result && g.result.text));
}

// ---------------------------------------------------------------- 悔棋
section('悔棋');
{
  const g = new Game({ boardSize: 9, mode: 'pvp' });
  g.play(2, 2, BLACK);
  g.play(3, 3, WHITE);
  check('手数 2', g.moveLog.length === 2);
  g.undo(1);
  check('悔一手后手数 1', g.moveLog.length === 1);
  check('悔棋后轮到白', g.turn === WHITE);
  g.undo(1);
  check('全部悔完', g.moveLog.length === 0 && g.turn === BLACK);
}

// ---------------------------------------------------------------- SGF
section('SGF 导出');
{
  const g = new Game({ boardSize: 19, mode: 'pvp', komi: 7.5 });
  g.play(15, 3, BLACK);
  g.play(3, 15, WHITE);
  const sgf = g.toSGF();
  check('包含棋盘大小', sgf.includes('SZ[19]'));
  check('包含贴目', sgf.includes('KM[7.5]'));
  check('包含落子', sgf.includes(';B[pd]') && sgf.includes(';W[dp]'), sgf);
}

// ---------------------------------------------------------------- 让子局悔棋
section('让子局的轮次');
{
  const g = new Game({ boardSize: 19, mode: 'pvp', handicap: 4 });
  check('让子局开局由白先行', g.turn === WHITE);
  // 让子点占的是四个角，这里挑空点下
  g.play(9, 9, WHITE);
  check('白下完轮到黑', g.turn === BLACK);
  g.play(8, 9, BLACK);
  check('黑下完轮到白', g.turn === WHITE);

  g.undo(1);
  check('悔掉黑那一手后轮到黑', g.turn === BLACK, `实际 ${g.turn === BLACK ? '黑' : '白'}`);
  g.undo(1);
  check('再悔掉白那一手后轮到白', g.turn === WHITE, `实际 ${g.turn === BLACK ? '黑' : '白'}`);

  // 悔完之后还能正常接着下
  check('悔完之后白仍可落子', g.play(9, 9, WHITE).ok);
}

// ---------------------------------------------------------------- 认输与 SGF 结果字段
section('认输与 SGF 结果字段');
{
  const g = new Game({ boardSize: 9, mode: 'pvp' });
  g.play(2, 2, BLACK);
  g.resign(WHITE);
  check('白认输则黑胜', g.result.winner === BLACK && g.status === 'finished');
  const sgf = g.toSGF();
  check('SGF 中盘胜写作 B+R（不是 B+R+）', /RE\[B\+R\]/.test(sgf), sgf);

  const g2 = new Game({ boardSize: 9, mode: 'pvp' });
  g2.pass(BLACK);
  g2.pass(WHITE);
  g2.confirmScore();
  const sgf2 = g2.toSGF();
  check('数目胜写作 B+3.5 这类格式', /RE\[[BW0]\+[\d.]+]/.test(sgf2), sgf2);
}

// ---------------------------------------------------------------- 终局前置条件
section('终局前置条件');
{
  const g = new Game({ boardSize: 9, mode: 'pvp' });
  g.play(2, 2, BLACK);
  const r = g.confirmScore();
  check('未进入数子阶段不能直接终局', !r.ok && r.reason === 'not-scoring', JSON.stringify(r));
  check('对局状态未被改动', g.status === 'playing' && g.result === null);

  g.beginScoring();
  check('进入数子阶段后可以终局', g.confirmScore().ok);
  check('重复终局被拒绝', !g.confirmScore().ok);
}

// ---------------------------------------------------------------- 计时与读秒
section('计时与读秒');
{
  const g = new Game({
    boardSize: 9,
    mode: 'pvp',
    timeControl: { enabled: true, mainTimeSec: 10, byoYomiSec: 5, byoYomiCount: 2 },
  });
  check('开启时间限制', g.clock.enabled === true);
  check('初始剩余 = 基本用时 + 读秒', g.remainingSeconds(BLACK) === 20, String(g.remainingSeconds(BLACK)));
  check('不限时的对局没有棋钟', new Game({ boardSize: 9, mode: 'pvp' }).clock.enabled === false);

  // 手动拨时间：避免测试真的等
  let t = 1_000_000;
  g.clock.lastTick = t;
  t += 3000;
  g.tickClock(t);
  check('基本用时递减', Math.abs(g.clock.black.main - 7) < 0.01, String(g.clock.black.main));

  t += 7000;
  g.tickClock(t);
  check('基本用时走完自动进入读秒', g.clock.black.main === 0 && g.clock.black.period === 5);

  t += 5000;
  g.tickClock(t);
  check('读秒耗尽一次，剩余次数减一', g.clock.black.periods === 1, String(g.clock.black.periods));

  t += 5000;
  g.tickClock(t);
  check('再耗尽一次，剩余次数为 0', g.clock.black.periods === 0, String(g.clock.black.periods));

  t += 5000;
  const over = g.tickClock(t);
  check('次数用尽后判超时', Boolean(over && over.timeout === BLACK), JSON.stringify(over));

  const g2 = new Game({
    boardSize: 9,
    mode: 'pvp',
    timeControl: { enabled: true, mainTimeSec: 1, byoYomiSec: 5, byoYomiCount: 2 },
  });
  g2.clock.lastTick = 0;
  g2.tickClock(2000); // 基本用时走完
  g2.tickClock(6000); // 读秒走了 4 秒
  check('读秒已走 4 秒', Math.abs(g2.clock.black.period - 1) < 0.01, String(g2.clock.black.period));
  g2.play(2, 2, BLACK);
  check('落子后读秒重新计时', g2.clock.black.period === 5, String(g2.clock.black.period));
  check('落子后基本用时仍然是 0', g2.clock.black.main === 0);

  const r = g2.loseOnTime(BLACK);
  check('超时判负', r.ok && g2.result.winner === WHITE && g2.status === 'finished');
  check('结果文案写明超时', /超时/.test(g2.result.text), g2.result.text);
}

// ---------------------------------------------------------------- 坐标转换
section('SGF 导入（复盘用）');
{
  const nodes = parseNodes('(;GM[1]SZ[19];B[pd];W[dp])');
  check('能拆出 SGF 节点', nodes.length === 3 && nodes[1].B[0] === 'pd' && nodes[2].W[0] === 'dp', JSON.stringify(nodes));

  const g = gameFromSGF('(;GM[1]FF[4]SZ[19]KM[7.5]RU[Chinese]PB[甲]PW[乙];B[pd];W[dp];B[pq])');
  check('导入后手数正确', g.moveLog.length === 3, String(g.moveLog.length));
  check('第一手坐标正确', g.moveLog[0].x === 15 && g.moveLog[0].y === 3, JSON.stringify(g.moveLog[0]));
  check('导入的棋只能看不能下', g.reviewOnly === true && g.status === 'finished');
  check('读出了双方名字', g.source.black === '甲' && g.source.white === '乙');
  check('复盘可用', g.toState().canReview === true);

  const gh = gameFromSGF('(;GM[1]SZ[19]HA[4]KM[0.5]AB[dd][pd][dp][pp];W[qf])');
  check('导入让子局的让子数', gh.handicap === 4, String(gh.handicap));
  check('让子位置正确', gh.board.get(3, 3) === BLACK && gh.board.get(15, 15) === BLACK);
  check('让子局第一手是白棋', gh.moveLog[0].color === WHITE);
  check('让子局悔棋轮次也正确', (() => { gh.undo(1); return gh.turn === WHITE; })());

  const gp = gameFromSGF('(;GM[1]SZ[9]KM[7];B[cc];W[])');
  check('能解析停一手', gp.moveLog.length === 2 && gp.moveLog[1].pass === true, JSON.stringify(gp.moveLog));

  const gr = gameFromSGF('(;GM[1]SZ[9]KM[7]RE[B+R];B[cc];W[dd])');
  check('能读出结果', gr.result && gr.result.winner === BLACK, JSON.stringify(gr.result));

  const gr2 = gameFromSGF('(;GM[1]SZ[9]KM[7]RE[W+3.5];B[cc])');
  check('能读出数目胜的差距', gr2.result && gr2.result.winner === WHITE && gr2.result.margin === 3.5, JSON.stringify(gr2.result));

  // 导出再导入，应该还原成一摸一样的棋
  const src = new Game({ boardSize: 19, mode: 'pvp', komi: 7.5 });
  src.play(15, 3, BLACK);
  src.play(3, 15, WHITE);
  src.play(15, 15, BLACK);
  const back = gameFromSGF(src.toSGF());
  check('导出再导入手数一致', back.moveLog.length === 3);
  check(
    '导出再导入每一步都一致',
    back.moveLog.every((m, i) => m.x === src.moveLog[i].x && m.y === src.moveLog[i].y && m.color === src.moveLog[i].color),
  );
  check('导出再导入棋盘一致', back.board.toArray().join(',') === src.board.toArray().join(','));

  let threw = false;
  try {
    gameFromSGF('(;GM[1]SZ[21])');
  } catch {
    threw = true;
  }
  check('不支持的路数会报错', threw);
}

section('GTP 坐标转换');
{
  check('Q16 -> (15,3)', JSON.stringify(rules.fromGtp(19, 'Q16')) === JSON.stringify({ x: 15, y: 3 }));
  check('(15,3) -> Q16', rules.toGtp(19, 15, 3) === 'Q16');
  check('跳过字母 I', rules.fromGtp(19, 'J19').x === 8);
  check('pass 返回 null', rules.fromGtp(19, 'pass') === null);
  for (let i = 0; i < 19; i++) {
    const back = rules.fromGtp(19, rules.toGtp(19, i, i));
    if (back.x !== i || back.y !== i) check(`第 ${i} 列往返一致`, false);
  }
  check('全部列往返一致', true);
}

// ---------------------------------------------------------------- 汇总
console.log(`\n结果： ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
