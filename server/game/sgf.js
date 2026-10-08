'use strict';

const { Game } = require('./game');
const rules = require('./board');

const { BLACK, WHITE } = rules;

/**
 * SGF 解析。
 *
 * 只解析对"下棋和复盘"有用的东西：棋盘大小、贴目、让子、规则、双方名字、
 * 结果，以及主线的每一手。变分支、标记、评论这些直接忽略 —— 真要看那些
 * 得用专门的复盘软件。
 */

/** 把 SGF 文本拆成节点数组，每个节点是 { 属性名: [值, ...] }。 */
function parseNodes(text) {
  const nodes = [];
  let i = 0;
  let cur = null;

  const isAlpha = (c) => /[A-Za-z]/.test(c);

  while (i < text.length) {
    const ch = text[i];

    if (ch === '(' || ch === ')') {
      i++;
      continue;
    }

    if (ch === ';') {
      if (cur) nodes.push(cur);
      cur = {};
      i++;
      continue;
    }

    if (isAlpha(ch)) {
      let key = '';
      while (i < text.length && isAlpha(text[i])) key += text[i++];
      key = key.toUpperCase();
      if (!cur) cur = {};

      const values = [];
      // 一个属性后面可以跟多个 [...]，比如 AB[aa][bb]
      while (text[i] === '[') {
        i++;
        let val = '';
        while (i < text.length && text[i] !== ']') {
          if (text[i] === '\\') {
            i++;
            if (i < text.length) val += text[i++];
          } else {
            val += text[i++];
          }
        }
        i++; // 跳过 ]
        values.push(val);
      }
      if (values.length) {
        cur[key] = (cur[key] || []).concat(values);
      }
      continue;
    }

    i++;
  }
  if (cur) nodes.push(cur);
  return nodes;
}

/** SGF 坐标（如 "pd"）转成内部坐标。空字符串表示停一手。 */
function pointFromSgf(value) {
  if (!value || value.length < 2) return null;
  const x = value.charCodeAt(0) - 97;
  const y = value.charCodeAt(1) - 97;
  if (x < 0 || y < 0) return null;
  return { x, y };
}

/**
 * 由 SGF 文本构造一局棋。
 * 返回的 Game 会带上 `reviewOnly = true`，表示这是一局"只能看不能下"的棋。
 */
function gameFromSGF(text) {
  const nodes = parseNodes(String(text || ''));
  if (nodes.length === 0) throw new Error('不是有效的 SGF：没有解析到任何节点');

  const root = nodes[0];
  const first = (k) => (root[k] && root[k][0] != null ? root[k][0] : '');

  const size = Number(first('SZ')) || 19;
  if (![9, 13, 19].includes(size)) {
    throw new Error(`暂不支持 ${size} 路棋盘（只支持 9 / 13 / 19 路）`);
  }

  const ruleText = String(first('RU')).toLowerCase();
  const ruleSet = ruleText.includes('japan') ? 'japanese' : 'chinese';
  const komiRaw = first('KM');
  const komi = komiRaw === '' ? undefined : Number(komiRaw);

  const game = new Game({
    mode: 'pvp',
    boardSize: size,
    ruleSet,
    handicap: 0,
    komi: Number.isFinite(komi) ? komi : undefined,
  });

  // 摆子：AB = 黑（让子），AW = 白
  const readPoints = (key) => (root[key] || []).map(pointFromSgf).filter(Boolean);
  const ab = readPoints('AB');
  const aw = readPoints('AW');
  if (ab.length) {
    game.board.setStones(ab, BLACK);
    game.handicap = ab.length;
    game.turn = WHITE; // 让子局白先
  } else if (aw.length) {
    game.board.setStones(aw, WHITE);
    game.turn = BLACK;
  }

  // 逐手重放
  let played = 0;
  let skipped = 0;
  for (const node of nodes) {
    for (const [key, color] of [['B', BLACK], ['W', WHITE]]) {
      if (!node[key]) continue;
      const pt = pointFromSgf(node[key][0]);
      if (pt) {
        const r = game.play(pt.x, pt.y, color);
        if (r.ok) played++;
        else skipped++;
      } else {
        game.pass(color);
        played++;
      }
    }
  }

  // 结果（RE 形如 B+R、W+3.5、0）
  const re = String(first('RE')).trim();
  if (re) {
    const m = /^([BW0])\+(.*)$/.exec(re);
    if (m) {
      const winner = m[1] === 'B' ? BLACK : m[1] === 'W' ? WHITE : null;
      const how = m[2];
      game.result = {
        winner,
        margin: how === 'R' ? null : Number(how) || null,
        method: how === 'R' ? 'resign' : 'score',
        text: winner ? `${game.colorName(winner)}胜` : '和棋',
      };
    }
  }

  // 导入的棋只看不继续下
  game.reviewOnly = true;
  game.status = 'finished';
  game.source = {
    black: String(first('PB') || ''),
    white: String(first('PW') || ''),
    date: String(first('DT') || ''),
    skipped,
  };
  return game;
}

module.exports = { parseNodes, pointFromSgf, gameFromSGF };
