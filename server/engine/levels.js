'use strict';

/**
 * 难度分级：采用**中国围棋协会**的业余段级位体系。
 *
 *   级位：25级 ～ 1级   （25 级最低，1 级最高）
 *   段位：业余 1段 ～ 8段（1～7 段为常规业余段位，8 段为荣誉段位）
 *   合计 33 档
 *
 * 每一档不是简单改一个数字，而是同时调节 KataGo 的几个"变弱"维度：
 *   访问数（搜索深度）、playoutDoublingAdvantage（自我削弱）、
 *   策略温度与 rootNoise（增加选点随机性、避免每盘一样）、建议让子数。
 * 参数由一条 0~38 的**强度曲线**插值得到，档位数与曲线刻度相互独立：
 * 想把段位改成只到 7 段，把 DAN_MAX 改成 7 即可，曲线会自动重新分布。
 *
 * 关于"拟人化"：早先的版本在级位/低段会用 KataGo 的人类风格模型
 * （humanSLProfile = rank_20k ~ rank_9d）来下得更像业余棋手。实测这条路
 * 每步要 4~8 秒，且与访问数几乎无关、波动极大（给 1 秒预算能跑成 5~11 秒），
 * 时间压不下来，于是整个去掉了。现在所有档位都走主权重搜索，
 * 低难度靠 PDA + 策略温度削弱 —— 棋风不再刻意拟人，但时间完全可预测。
 * 曲线刻度因此不再需要与人类模型的档位对应。
 */

/** 级位最低档（中国围棋协会业余级位：25 级最低） */
const KYU_MAX = 25;
/** 业余段位最高档（1~7 为常规段位，8 段为荣誉段位） */
const DAN_MAX = 8;
/** 强度曲线的刻度范围，与 KataGo 人类模型 rank_20k ~ rank_9d 对应 */
const CURVE_MAX = 38;
/**
 * 时间预算的换算比率：每秒算多少次访问。
 *
 * 思考上限不再逐档写死，而是由访问数推导：maxTime = visits / VISITS_PER_SECOND。
 * 这样"算多少"和"给多少时间"永远成正比 —— 想整体调快调慢，只改这一个数即可。
 *
 * 取 1000 的含义是「每 1000 次访问给 1 秒」：
 *   1 级（107 访问）预算 0.11s，8 段（6000 访问）预算 6s。
 * 本机（4070 Laptop）实测吞吐约 400~700 访问/秒，所以这个预算在多数档位上
 * 是「访问数先到」，时间上限只作为保底；高段位则会被时间限制住。
 *
 * 调参时可以用环境变量临时覆盖，不必改代码：
 *   LEVELS_VISITS_PER_SECOND=600 npm start
 */
const VISITS_PER_SECOND = Number(process.env.LEVELS_VISITS_PER_SECOND) || 1000;
/** 时间上限的下限：低于这个值引擎来不及做出有效判断，反而会让行为变得奇怪 */
const MIN_MOVE_TIME = 0.3;

/**
 * playoutDoublingAdvantage 的合法范围。
 * KataGo 会拒绝超出范围的取值（报 "must be in the range -3 to 3"），
 * 而曲线两端的断点写的是 ±5.0，所以下发前必须夹一下。
 */
const PDA_LIMIT = 3;

/**
 * 运行时可覆盖的比率。config.json 里的 katago.visitsPerSecond 会通过
 * setVisitsPerSecond() 传进来 —— 想整体调快调慢改配置即可，不必改代码。
 */
let visitsPerSecond = VISITS_PER_SECOND;

function setVisitsPerSecond(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) visitsPerSecond = n;
  return visitsPerSecond;
}

function getVisitsPerSecond() {
  return visitsPerSecond;
}

/**
 * 强度曲线上的关键点。
 *   visits   最大访问数（搜索深度），时间上限由它按比率推导
 *   pda      playoutDoublingAdvantage，正值让引擎自我削弱
 *            **注意：KataGo 只接受 -3 ~ 3**，超出会直接报错拒绝，
 *            所以下面写 5.0 的那些档位实际会被 PDA_LIMIT 夹到 3。
 *            保留 5.0 只是让插值曲线更平缓，不是真的用 5。
 *   temp     rootPolicyTemperature，提高选点随机性
 *   noise    是否打开 rootNoise，避免每盘棋一模一样
 *   handicap 建议让子数
 *   playouts/blunder 内置引擎（无 KataGo 时）的模拟次数与失误率
 */
const BREAKPOINTS = [
  { idx: 0,  visits: 1,    pda: 5.0, temp: 3.00, noise: true,  handicap: 9, playouts: 80,   blunder: 0.55 },
  { idx: 9,  visits: 2,    pda: 4.2, temp: 2.80, noise: true,  handicap: 6, playouts: 150,  blunder: 0.50 },
  { idx: 15, visits: 4,    pda: 3.4, temp: 2.40, noise: true,  handicap: 4, playouts: 250,  blunder: 0.44 },
  { idx: 21, visits: 12,   pda: 2.4, temp: 1.90, noise: true,  handicap: 3, playouts: 400,  blunder: 0.36 },
  { idx: 26, visits: 40,   pda: 1.6, temp: 1.40, noise: false, handicap: 2, playouts: 700,  blunder: 0.28 },
  { idx: 29, visits: 120,  pda: 1.0, temp: 1.15, noise: false, handicap: 0, playouts: 1200, blunder: 0.20 },
  { idx: 32, visits: 450,  pda: 0.5, temp: 1.00, noise: false, handicap: 0, playouts: 2200, blunder: 0.12 },
  { idx: 35, visits: 1500, pda: 0.2, temp: 1.00, noise: false, handicap: 0, playouts: 4000, blunder: 0.06 },
  { idx: 38, visits: 6000, pda: 0.0, temp: 1.00, noise: false, handicap: 0, playouts: 8000, blunder: 0.02 },
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

  const visits = Math.max(1, Math.round(lerp(lo.visits, hi.visits, t)));

  return {
    curve: Number(i.toFixed(2)),
    visits,
    // 时间上限由访问数推导：算多少就给多少时间，两者永远成正比
    maxTime: Number(Math.max(MIN_MOVE_TIME, visits / visitsPerSecond).toFixed(2)),
    playoutDoublingAdvantage: Number(
      Math.max(-PDA_LIMIT, Math.min(PDA_LIMIT, lerp(lo.pda, hi.pda, t))).toFixed(2),
    ),
    rootPolicyTemperature: Number(lerp(lo.temp, hi.temp, t).toFixed(2)),
    rootNoiseEnabled: p.noise,
    recommendHandicap: p.handicap,
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
  VISITS_PER_SECOND,
  MIN_MOVE_TIME,
  PDA_LIMIT,
  setVisitsPerSecond,
  getVisitsPerSecond,
  LEVEL_COUNT,
  LEVELS,
  findLevel,
  listLevels,
  paramsForCurve,
  paramsForIndex,
  paramsForLevel,
  curvePosition,
  levelIndexFromVisits,
};
