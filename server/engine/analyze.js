'use strict';

/**
 * 解析 KataGo 的 `kata-analyze` 输出。
 *
 * 输出是一整行、把所有候选点串在一起的文本，形如：
 *   info move Q4 visits 262 utility -0.249 winrate 0.374 scoreLead -0.957 order 0 pv Q4 D16 F17
 *        info move D16 visits 262 ... order 1 pv D16 Q4
 * 每个 `info move ` 之间用空格连接，`pv` 后面跟的是一串大写坐标。
 *
 * 注意口径：winrate 和 scoreLead 都是**当前该走的一方**的视角，
 * 上层要统一换算成黑棋视角才不会在曲线里跳。
 */

const COORD_RE = /^([A-HJ-T]\d{1,2}|pass)$/i;

/** 把一行 analysis 输出拆成 [{move, visits, winrate, scoreLead, order, pv}, ...] */
function parseAnalyzeLine(line) {
  const segs = String(line).split('info move ').slice(1);
  const out = [];

  for (const seg of segs) {
    const tokens = seg.trim().split(/\s+/);
    if (!tokens.length || !tokens[0]) continue;
    // 每一段的第一个 token 就是这一手的坐标，后面才是 key value
    const info = { move: tokens.shift(), pv: [] };
    let i = 0;
    while (i < tokens.length) {
      const key = tokens[i++];
      if (key === 'pv') {
        while (i < tokens.length && COORD_RE.test(tokens[i])) info.pv.push(tokens[i++]);
        continue;
      }
      const raw = tokens[i++];
      if (raw === undefined) break;
      if (raw === 'true' || raw === 'false') {
        info[key] = raw === 'true';
      } else {
        const num = Number(raw);
        info[key] = Number.isFinite(num) && raw !== '' ? num : raw;
      }
    }
    if (info.move) out.push(info);
  }

  out.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return out;
}

/**
 * 从解析结果里提炼出"这个局面怎么样"。
 * 取 order 0（引擎首选）的胜率作为根节点胜率，这是通用做法。
 */
function summarize(moves, turn) {
  if (!moves.length) return null;
  const top = moves[0];
  const blackWinrate = turn === 1 ? top.winrate : 1 - top.winrate;
  const blackScoreLead = turn === 1 ? top.scoreLead : -top.scoreLead;
  return {
    winrate: blackWinrate,
    scoreLead: blackScoreLead,
    visits: top.visits,
    moves: moves.slice(0, 8).map((m) => ({
      move: m.move,
      visits: m.visits,
      winrate: turn === 1 ? m.winrate : 1 - m.winrate,
      scoreLead: turn === 1 ? m.scoreLead : -m.scoreLead,
      pv: m.pv.slice(0, 12),
    })),
  };
}

module.exports = { parseAnalyzeLine, summarize };
