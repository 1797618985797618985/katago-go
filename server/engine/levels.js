'use strict';

/**
 * 难度分级：级位 30级～1级，段位 1段～9段，共 39 档。
 *
 * 每一档不是简单改一个数字，而是同时调节 KataGo 的几个"变弱/拟人"维度：
 *   visits   最大访问数（搜索深度）
 *   maxTime  单步思考时间上限（秒）
 *   pda      playoutDoublingAdvantage，正值让引擎自我削弱
 *   temp     rootPolicyTemperature，提高选点的随机性
 *   noise    是否打开 rootNoise，避免每盘棋一模一样
 *   handicap 建议让子数（低段位给用户让子，保证可玩）
 *   profile 人类风格模型（humanSL）的档位名，用于"像人一样下棋"
 *   playouts/blunder 内置引擎（无 KataGo 时）的模拟次数与"失误率"
 */

const KYU_MAX = 30; // 最弱：30级
const DAN_MAX = 9; // 最强：9段

const BREAKPOINTS = [
  { idx: 0,  visits: 1,    maxTime: 0.5,  pda: 5.0, temp: 3.00, noise: true,  handicap: 9, profile: 'rank_20k', playouts: 80,   blunder: 0.55 },
  { idx: 9,  visits: 2,    maxTime: 0.5,  pda: 4.2, temp: 2.80, noise: true,  handicap: 6, profile: 'rank_18k', playouts: 150,  blunder: 0.50 },
  { idx: 15, visits: 4,    maxTime: 0.6,  pda: 3.4, temp: 2.40, noise: true,  handicap: 4, profile: 'rank_13k', playouts: 250,  blunder: 0.44 },
  { idx: 21, visits: 12,   maxTime: 0.9,  pda: 2.4, temp: 1.90, noise: true,  handicap: 3, profile: 'rank_8k',  playouts: 400,  blunder: 0.36 },
  { idx: 26, visits: 40,   maxTime: 1.4,  pda: 1.6, temp: 1.40, noise: false, handicap: 2, profile: 'rank_4k',  playouts: 700,  blunder: 0.28 },
  { idx: 29, visits: 120,  maxTime: 2.2,  pda: 1.0, temp: 1.15, noise: false, handicap: 0, profile: 'rank_1k',  playouts: 1200, blunder: 0.20 },
  { idx: 32, visits: 450,  maxTime: 3.5,  pda: 0.5, temp: 1.00, noise: false, handicap: 0, profile: 'rank_3d',  playouts: 2200, blunder: 0.12 },
  { idx: 35, visits: 1500, maxTime: 6.0,  pda: 0.2, temp: 1.00, noise: false, handicap: 0, profile: 'rank_6d',  playouts: 4000, blunder: 0.06 },
  { idx: 38, visits: 6000, maxTime: 14.0, pda: 0.0, temp: 1.00, noise: false, handicap: 0, profile: 'rank_9d',  playouts: 8000, blunder: 0.02 },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 把 30级~1级、1段~9段 映射为 0~38 的强度序号。 */
function strengthIndex(kind, rank) {
  if (kind === 'kyu') return KYU_MAX - rank; // 30级->0, 1级->29
  return (KYU_MAX - 1) + rank; // 1段->30, 9段->38
}

function makeLevel(kind, rank) {
  const idx = strengthIndex(kind, rank);
  return {
    id: kind === 'kyu' ? `${rank}k` : `${rank}d`,
    kind,
    rank,
    index: idx,
    label: kind === 'kyu' ? `${rank}级` : `${rank}段`,
    group: kind === 'kyu' ? '级位' : '段位',
    /**
     * 分组标题（下拉框用）。
     *
     * 关于段位刻度：现实中的**业余**段位一般只到 7 段，8、9 段属于荣誉段位，
     * 而 9 段是职业段位的上限。这里 1段~9段 采用的是**线上对弈平台**
     * （KGS / OGS / 弈城 / 野狐）通用的连续刻度，也是 KataGo 人类风格模型
     * 的档位范围（rank_20k ~ rank_9d），用来做难度分级最自然。
     */
    groupLabel: kind === 'kyu' ? '级位（30级 – 1级）' : '段位（1段 – 9段，线上刻度）',
  };
}

const LEVELS = [];
for (let k = KYU_MAX; k >= 1; k--) LEVELS.push(makeLevel('kyu', k));
for (let d = 1; d <= DAN_MAX; d++) LEVELS.push(makeLevel('dan', d));

/** 用分段线性插值得到某一档的全部引擎参数。 */
function paramsForIndex(idx) {
  const i = Math.max(0, Math.min(38, idx));
  let lo = BREAKPOINTS[0];
  let hi = BREAKPOINTS[BREAKPOINTS.length - 1];
  for (let k = 0; k < BREAKPOINTS.length - 1; k++) {
    if (i >= BREAKPOINTS[k].idx && i <= BREAKPOINTS[k + 1].idx) {
      lo = BREAKPOINTS[k];
      hi = BREAKPOINTS[k + 1];
      break;
    }
  }
  const span = hi.idx - lo.idx || 1;
  const t = (i - lo.idx) / span;
  const pick = () => (t < 0.5 ? lo : hi); // 布尔/整数参数取最近的断点
  const p = pick();

  return {
    encounters: i,
    visits: Math.max(1, Math.round(lerp(lo.visits, hi.visits, t))),
    maxTime: Number(lerp(lo.maxTime, hi.maxTime, t).toFixed(2)),
    playoutDoublingAdvantage: Number(lerp(lo.pda, hi.pda, t).toFixed(2)),
    rootPolicyTemperature: Number(lerp(lo.temp, hi.temp, t).toFixed(2)),
    rootNoiseEnabled: p.noise,
    recommendHandicap: p.handicap,
    humanProfile: p.profile,
    builtinPlayouts: Math.round(lerp(lo.playouts, hi.playouts, t)),
    builtinBlunder: Number(lerp(lo.blunder, hi.blunder, t).toFixed(2)),
  };
}

function findLevel(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

/** 对外暴露的难度列表（供前端下拉框使用）。 */
function listLevels() {
  return LEVELS.map((l) => {
    const p = paramsForIndex(l.index);
    return {
      ...l,
      visits: p.visits,
      maxTime: p.maxTime,
      recommendHandicap: p.recommendHandicap,
      humanProfile: p.humanProfile,
      builtinPlayouts: p.builtinPlayouts,
    };
  });
}

function paramsForLevel(id) {
  const l = findLevel(id);
  return paramsForIndex(l ? l.index : 20);
}

module.exports = {
  KYU_MAX,
  DAN_MAX,
  LEVELS,
  findLevel,
  listLevels,
  paramsForIndex,
  paramsForLevel,
  strengthIndex,
};
