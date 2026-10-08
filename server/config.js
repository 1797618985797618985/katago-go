'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 代码和前端资源所在目录。打包后它在 app.asar 里，只读。 */
const APP_DIR = path.resolve(__dirname, '..');

/**
 * 资源根目录：引擎、权重放在这里。
 * 开发时就是项目根目录；打包后由桌面外壳设成 resources 目录
 * （引擎体积太大，不能塞进 asar，得放在外面）。
 */
function appRoot() {
  return process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : APP_DIR;
}

/**
 * 可写数据目录：config.json、日志、联调记录写这里。
 * 打包后指向系统的用户数据目录（asar 里是写不了的），开发时就用项目根目录。
 */
function dataDir() {
  return process.env.APP_DATA ? path.resolve(process.env.APP_DATA) : appRoot();
}

/**
 * 引擎缓存目录（OpenCL 调优结果等）。
 *
 * 特意固定放在用户目录下，而不是跟着 dataDir 走：
 *   - KataGo 在 Windows 上默认写"当前目录"，而打包成单文件 exe 后每次启动
 *     都会解压到临时目录，缓存每次都会丢，等于每次启动都要重新调优几分钟；
 *   - 固定位置还能让"安装时预热"与"运行时"共用同一份缓存，
 *     开发模式与打包版也共用，不至于各调一次。
 */
function engineCacheDir() {
  const base =
    process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'katago-go');
}

const ROOT = appRoot();

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

  // 配置文件放在可写目录里（打包后 asar 是只读的）
  const file = process.env.CONFIG_FILE ? path.resolve(process.env.CONFIG_FILE) : path.join(dataDir(), 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[config] ${file} 解析失败，使用默认配置: ${err.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);
  cfg.root = ROOT;
  cfg.dataDir = dataDir();
  // 允许用环境变量临时覆盖端口/监听地址（部署时很方便）
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.server.host = process.env.HOST;
  cached = cfg;
  return cfg;
}

/** 相对路径按资源根目录解析（引擎、权重都在这下面）。 */
function resolvePath(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** 需要写入的文件（日志等）走可写目录。 */
function resolveDataPath(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(dataDir(), p);
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
  // 资源目录和用户数据目录都找一遍，方便用户自己往数据目录里放权重
  const files = [
    ...listFiles('engine/models', (n) => /\.(bin|txt)\.gz$/i.test(n)),
    ...(() => {
      const dir = resolveDataPath('engine/models');
      if (!fs.existsSync(dir) || dir === resolvePath('engine/models')) return [];
      return fs.readdirSync(dir).filter((n) => /\.(bin|txt)\.gz$/i.test(n)).map((n) => path.join(dir, n));
    })(),
  ];
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
  APP_DIR,
  appRoot,
  dataDir,
  engineCacheDir,
  DEFAULTS,
  loadConfig,
  resolvePath,
  resolveDataPath,
  discoverModels,
  listFiles,
  deepMerge,
};
