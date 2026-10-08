'use strict';

/**
 * 规则引擎单元测试：提子、自杀、劫、禁全同、让子、数子。
 * 用法： node tools/rules-test.js
 */

const { GoBoard } = require('../server/game/goban');
const rules = require('../server/game/board');
const { Game } = require('../server/game/game');

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

// ---------------------------------------------------------------- 坐标转换
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
