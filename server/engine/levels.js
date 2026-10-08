'use strict';

/**
 * 难度分级：采用**中国围棋协会**的业余段级位体系。
 *
 *   级位：25级 ～ 1级   （25 级最低，1 级最高）
 *   段位：业余 1段 ～ 8段（1～7 段为常规业余段位，8 段为荣誉段位）
 *   合计 33 档
 *
 * 每一档不是简单改一个数字，而是同时调节 KataGo 的几个"变弱 / 拟人"维度。
 * 参数由一条 0~38 的**强度曲线**插值得到，档位数与曲线刻度相互独立：
 * 想把段位改成只到 7 段，把 DAN_MAX 改成 7 即可，曲线会自动重新分布。
 *
 * 曲线刻度与 KataGo 人类风格模型的档位范围（rank_20k ~ rank_9d）一一对应，
 * 因此 33 档难度都能映射到一个真实的拟人化档位上。
 */

/** 级位最低档（中国围棋协会业余级位：25 级最低） */
const KYU_MAX = 25;
/** 业余段位最高档（1~7 为常规段位，8 段为荣誉段位） */
const DAN_MAX = 8;
/** 强度曲线的刻度范围，与 KataGo 人类模型 rank_20k ~ rank_9d 对应 */
const CURVE_MAX = 38;

/**
 * 强度曲线上的关键点。
 *   visits   最大访问数（搜索深度）
 *   maxTime  单步思考时间上限（秒）
 *   pda      playoutDoublingAdvantage，正值让引擎自我削弱
 *   temp     rootPolicyTemperature，提高选点随机性
 *   noise    是否打开 rootNoise，避免每盘棋一模一样
 *   handicap 建议让子数
 *   playouts/blunder 内置引擎（无 KataGo 时）的模拟次数与失误率
 */
const BREAKPOINTS = [
  { idx: 0,  visits: 1,    maxTime: 0.5,  pda: 5.0, temp: 3.00, noise: true,  handicap: 9, playouts: 80,   blunder: 0.55 },
  { idx: 9,  visits: 2,    maxTime: 0.5,  pda: 4.2, temp: 2.80, noise: true,  handicap: 6, playouts: 150,  blunder: 0.50 },
  { idx: 15, visits: 4,    maxTime: 0.6,  pda: 3.4, temp: 2.40, noise: true,  handicap: 4, playouts: 250,  blunder: 0.44 },
  { idx: 21, visits: 12,   maxTime: 0.9,  pda: 2.4, temp: 1.90, noise: true,  handicap: 3, playouts: 400,  blunder: 0.36 },
  { idx: 26, visits: 40,   maxTime: 1.4,  pda: 1.6, temp: 1.40, noise: false, handicap: 2, playouts: 700,  blunder: 0.28 },
  { idx: 29, visits: 120,  maxTime: 2.2,  pda: 1.0, temp: 1.15, noise: false, handicap: 0, playouts: 1200, blunder: 0.20 },
  { idx: 32, visits: 450,  maxTime: 3.5,  pda: 0.5, temp: 1.00, noise: false, handicap: 0, playouts: 2200, blunder: 0.12 },
  { idx: 35, visits: 1500, maxTime: 6.0,  pda: 0.2, temp: 1.00, noise: false, handicap: 0, playouts: 4000, blunder: 0.06 },
  { idx: 38, visits: 6000, maxTime: 14.0, pda: 0.0, temp: 1.00, noise: false, handicap: 0, playouts: 8000, blunder: 0.02 },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function makeLevel(kind, rank) {
  const index = kind === 'kyu' ? KYU_MAX - rank : KYU_MAX - 1 + rank;
  return {
    id: kind === 'kyu' ? `${rank}k` : `${rank}d`,
    kind,
    rank,
    index,
    label: kind === 'kyu' ? `${rank}级` : `${rank}段`,
    group: kind === 'kyu' ? '级位' : '业余段位',
    groupLabel: kind === 'kyu' ? `级位（${KYU_MAX}级 – 1级）` : `业余段位（1段 – ${DAN_MAX}段）`,
  };
}

const LEVELS = [];
for (let k = KYU_MAX; k >= 1; k--) LEVELS.push(makeLevel('kyu', k));
for (let d = 1; d <= DAN_MAX; d++) LEVELS.push(makeLevel('dan', d));

const LEVEL_COUNT = LEVELS.length;

/** 把档位序号映射到 0~CURVE_MAX 的强度曲线位置。 */
function curvePosition(levelIndex) {
  if (LEVEL_COUNT <= 1) return 0;
  return (levelIndex / (LEVEL_COUNT - 1)) * CURVE_MAX;
}

/**
 * 曲线刻度 -> KataGo 人类风格模型的档位名。
 * 人类模型支持 rank_20k ~ rank_9d，低于 20 级的一律取 rank_20k。
 */
function profileForCurve(pos) {
  const idx = Math.round(Math.max(0, Math.min(CURVE_MAX, pos)));
  if (idx <= 29) return `rank_${Math.min(20, 30 - idx)}k`;
  return `rank_${idx - 29}d`;
}

/** 在强度曲线上做分段线性插值，得到某一档的全部引擎参数。 */
function paramsForCurve(pos) {
  const i = Math.max(0, Math.min(CURVE_MAX, pos));
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
    curve: Number(i.toFixed(2)),
    visits: Math.max(1, Math.round(lerp(lo.visits, hi.visits, t))),
    maxTime: Number(lerp(lo.maxTime, hi.maxTime, t).toFixed(2)),
    playoutDoublingAdvantage: Number(lerp(lo.pda, hi.pda, t).toFixed(2)),
    rootPolicyTemperature: Number(lerp(lo.temp, hi.temp, t).toFixed(2)),
    rootNoiseEnabled: p.noise,
    recommendHandicap: p.handicap,
    humanProfile: profileForCurve(i),
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
    const p = paramsForLevel(l.id);
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
  return paramsForCurve(curvePosition(l ? l.index : Math.floor(LEVEL_COUNT / 2)));
}

/** 兼容旧调用：按档位序号取参数。 */
function paramsForIndex(levelIndex) {
  return paramsForCurve(curvePosition(levelIndex));
}

/** 按当前段级位体系反推：给定访问数能支撑到哪一档。 */
function levelIndexFromVisits(visits) {
  let best = 0;
  for (const l of LEVELS) {
    if (paramsForLevel(l.id).visits <= visits) best = Math.max(best, l.index);
  }
  return best;
}

module.exports = {
  KYU_MAX,
  DAN_MAX,
  CURVE_MAX,
  LEVEL_COUNT,
  LEVELS,
  findLevel,
  listLevels,
  paramsForCurve,
  paramsForIndex,
  paramsForLevel,
  curvePosition,
  profileForCurve,
  levelIndexFromVisits,
};
