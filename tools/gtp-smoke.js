'use strict';

/**
 * 引擎自检：验证 KataGo 能被拉起、权重能加载、难度分级真的起作用。
 * 用法： node tools/gtp-smoke.js [级别ID ...]
 *   例： node tools/gtp-smoke.js 20k 5k 1d 9d
 */

const { EngineManager } = require('../server/engine/manager');
const { Game } = require('../server/game/game');
const { paramsForLevel } = require('../server/engine/levels');

const levels = process.argv.slice(2);
const LEVELS = levels.length ? levels : ['20k', '5k', '1d', '8d'];

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

(async () => {
  const mgr = new EngineManager();
  const t0 = Date.now();
  await mgr.init();
  log(`初始化完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const d = mgr.describe();
  log(`状态      : ${d.status}`);
  log(`后端      : ${d.backend ? d.backend.label : '(无)'} ${d.backendVersion}`);
  log(`权重      : ${d.modelKind} / ${d.model}`);
  log(`人类模型  : ${d.humanModel ? (d.humanModelReady ? '已就绪' : '加载中') : '未配置'}`);
  log(`吞吐      : ${d.visitsPerSec} 次访问/秒`);
  log(`可支持到  : ${d.recommendedMaxLevel}`);
  for (const w of d.warnings) log(`提示      : ${w}`);
  for (const u of d.unavailableBuilds) log(`不可用    : ${u.label} (${u.reason})`);

  for (const id of LEVELS) {
    const p = paramsForLevel(id);
    const game = new Game({ mode: 'pve', boardSize: 19, levelId: id, komi: 7.5 });
    // 给个开局，免得每档都从空棋盘开始
    game.play(15, 3);
    game.play(3, 15);

    const t = Date.now();
    const mv = await mgr.genmove(game, game.turn, id);
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    const desc = mv.pass ? 'pass' : mv.resign ? 'resign' : `(${mv.x},${mv.y})`;
    log(`${id.padEnd(4)} visits=${String(p.visits).padEnd(5)} profile=${String(p.humanProfile).padEnd(10)} -> ${desc.padEnd(10)} ${secs}s  引擎=${mv.engine}`);
  }

  await mgr.shutdown();
  log('自检完成');
  process.exit(0);
})().catch((err) => {
  console.error('自检失败:', err);
  process.exit(1);
});
