'use strict';

/**
 * 内置引擎与难度曲线测试（完全离线，不需要 KataGo）。
 * 用法： node tools/engine-test.js
 */

const { BuiltinEngine } = require('../server/engine/builtin');
const { Game } = require('../server/game/game');
const levels = require('../server/engine/levels');
const rules = require('../server/game/board');

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

const section = (t) => console.log(`\n${t}`);

/** 从棋盘上提掉的点转成坐标（内置引擎返回的是索引） */
function indexToPoint(size, idx) {
  return { x: idx % size, y: Math.floor(idx / size) };
}

async function selfPlay(size, levelId, moves) {
  const game = new Game({ boardSize: size, mode: 'pvp', levelId });
  const engine = new BuiltinEngine({ size });
  // 测试只关心合法性，把单步时间预算压小，避免整个测试跑几分钟
  const params = { ...levels.paramsForLevel(levelId), builtinTimeMs: 250 };
  const history = [];
  for (let i = 0; i < moves; i++) {
    if (game.status !== 'playing') break;
    const mv = await engine.genmove(game, game.turn, params);
    if (mv.pass) {
      game.pass(game.turn);
      history.push('pass');
      continue;
    }
    const r = game.play(mv.x, mv.y, game.turn);
    if (!r.ok) return { ok: false, reason: r.reason, move: mv, moveNo: i + 1, history };
    history.push(`${mv.x},${mv.y}`);
  }
  return { ok: true, game, history };
}

(async () => {
  section('空棋盘首手');
  {
    for (const size of [9, 13, 19]) {
      const game = new Game({ boardSize: size, mode: 'pvp', levelId: '10k' });
      const engine = new BuiltinEngine({ size });
      const mv = await engine.genmove(game, game.turn, levels.paramsForLevel('10k'));
      check(`${size} 路空棋盘不会直接停一手`, !mv.pass, JSON.stringify(mv));
      check(
        `${size} 路首手是合法点`,
        !mv.pass && rules.isLegal(game.board.cells, size, mv.x, mv.y, game.turn, game.board.koPoint),
        JSON.stringify(mv),
      );
    }
  }

  section('自对弈合法性（内置引擎不能走出非法手）');
  {
    const r9 = await selfPlay(9, '15k', 24);
    check('9 路自对弈 24 手无非法手', r9.ok, JSON.stringify(r9));
    const r19 = await selfPlay(19, '15k', 12);
    check('19 路自对弈 12 手无非法手', r19.ok, JSON.stringify(r19));
  }

  section('难度曲线');
  {
    const list = levels.listLevels();
    check('难度档位数 = 级位数 + 段位数', list.length === levels.KYU_MAX + levels.DAN_MAX, `${list.length}`);
    check('最低档是 25级', list[0].label === `${levels.KYU_MAX}级`, list[0].label);
    check('最高档是 8段', list[list.length - 1].label === `${levels.DAN_MAX}段`, list[list.length - 1].label);

    let monotonic = true;
    let prev = 0;
    for (const l of list) {
      if (l.visits < prev) monotonic = false;
      prev = l.visits;
    }
    check('访问数随难度单调不减', monotonic);
    check('最弱档访问数为 1', list[0].visits === 1, String(list[0].visits));
    check('最强档访问数为 6000', list[list.length - 1].visits === 6000, String(list[list.length - 1].visits));
    check('最弱档建议让 9 子', list[0].recommendHandicap === 9);
    check('最高档不让子', list[list.length - 1].recommendHandicap === 0);

    // 时间预算由访问数按比率推导：maxTime = visits / VISITS_PER_SECOND（含下限）
    const { VISITS_PER_SECOND, MIN_MOVE_TIME, PDA_LIMIT, paramsForLevel } = require('../server/engine/levels');
    const expectedTime = (visits) => Number(Math.max(MIN_MOVE_TIME, visits / VISITS_PER_SECOND).toFixed(2));
    let timeOk = true;
    let timeDetail = '';
    for (const l of list) {
      if (l.maxTime !== expectedTime(l.visits)) {
        timeOk = false;
        timeDetail = l.label + ' visits=' + l.visits + ' maxTime=' + l.maxTime + ' 期望 ' + expectedTime(l.visits);
        break;
      }
    }
    check('时间上限与访问数成正比（visits / VISITS_PER_SECOND）', timeOk, timeDetail);

    // 访问数越多，给的时间不该更少 —— 保证"算得多的档位不会反而被卡时间"
    let timeMonotonic = true;
    for (let i = 1; i < list.length; i++) {
      if (list[i].maxTime < list[i - 1].maxTime) {
        timeMonotonic = false;
        timeDetail = list[i - 1].label + ' -> ' + list[i].label;
        break;
      }
    }
    check('时间上限随难度单调不减', timeMonotonic, timeDetail);

    // playoutDoublingAdvantage 必须落在 KataGo 接受的范围内。
    // 曲线两端写的是 ±5.0，曾经因为没夹紧导致最弱几档被引擎直接拒绝
    // （"Key 'playoutDoublingAdvantage' must be in the range -3 to 3"），
    // 于是那几个档位静默掉回内置引擎 —— 这条测试就是防它复发。
    let pdaOk = true;
    let pdaDetail = '';
    for (const l of levels.LEVELS) {
      const p = paramsForLevel(l.id);
      if (!(p.playoutDoublingAdvantage >= -PDA_LIMIT && p.playoutDoublingAdvantage <= PDA_LIMIT)) {
        pdaOk = false;
        pdaDetail = `${l.label} pda=${p.playoutDoublingAdvantage}（允许 ±${PDA_LIMIT}）`;
        break;
      }
    }
    check(`PDA 全部落在 ±${PDA_LIMIT} 内（引擎只接受这个范围）`, pdaOk, pdaDetail);
  }

  section('响应时间');
  {
    const game = new Game({ boardSize: 9, mode: 'pvp', levelId: '5k' });
    const engine = new BuiltinEngine({ size: 9 });
    const t0 = Date.now();
    await engine.genmove(game, game.turn, { ...levels.paramsForLevel('5k'), builtinTimeMs: 1200 });
    const ms = Date.now() - t0;
    check('5级 9 路单步在 5 秒内返回', ms < 5000, `${ms}ms`);
  }

  console.log(`\n结果： ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
