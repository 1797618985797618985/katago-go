'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  server: { port: 8080, host: '127.0.0.1' },
  katago: {
    enabled: true,
    /** 留空 = 自动探测 engine/bin 下的 opencl / cuda / cpu */
    path: '',
    model: '',
    fastModel: '',
    humanModel: '',
    useHumanModel: true,
    /** 不超过这个难度序号（默认 3 段）时使用人类风格模型 */
    humanModelMaxIndex: 33,
    config: 'engine/gtp.cfg',
    threads: 8,
    /** auto | main | fast */
    strength: 'auto',
  },
  hardware: {
    enabled: false,
    /** none | log | tcp | stdio */
    driver: 'none',
    tcp: { host: '127.0.0.1', port: 9100, reconnectMs: 3000 },
    stdio: { command: '', args: [] },
    /** 电机动作之间的间隔，避免多个机构同时动作抢电流 */
    options: { interCommandDelayMs: 120, ackTimeoutMs: 8000 },
  },
  defaults: { boardSize: 19, komi: 7.5, level: '10k' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

let cached = null;

function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;

  const file = path.join(ROOT, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[config] config.json 解析失败，使用默认配置: ${err.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);
  cfg.root = ROOT;
  // 允许用环境变量临时覆盖端口/监听地址（部署时很方便）
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.server.host = process.env.HOST;
  cached = cfg;
  return cfg;
}

/** 相对路径统一按项目根目录解析。 */
function resolvePath(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function listFiles(dir, filter) {
  const abs = resolvePath(dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter(filter)
    .map((name) => path.join(abs, name));
}

/**
 * 自动发现权重文件。
 * 主权重取体积最大的那份，人类风格权重按文件名识别，轻量权重取最小的一份。
 */
function discoverModels() {
  const files = listFiles('engine/models', (n) => /\.(bin|txt)\.gz$/i.test(n));
  const bySize = files
    .map((f) => ({ path: f, size: fs.statSync(f).size }))
    .sort((a, b) => b.size - a.size);

  const human = bySize.find((f) => /human/i.test(path.basename(f.path)));
  const normal = bySize.filter((f) => !/human/i.test(path.basename(f.path)));

  return {
    main: normal[0] ? normal[0].path : '',
    fast: normal.length > 1 ? normal[normal.length - 1].path : '',
    human: human ? human.path : '',
    all: bySize.map((f) => f.path),
  };
}

module.exports = {
  ROOT,
  DEFAULTS,
  loadConfig,
  resolvePath,
  discoverModels,
  listFiles,
  deepMerge,
};
