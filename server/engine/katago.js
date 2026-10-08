'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { GtpClient } = require('./gtp');
const { resolvePath, resolveDataPath, engineCacheDir } = require('../config');
const { parseAnalyzeLine, summarize } = require('./analyze');
const rules = require('../game/board');

/**
 * 引擎构建的探测顺序：显卡驱动自带的 OpenCL 最省事，CUDA 最快，CPU 兜底。
 * 这里只做"能不能跑"的判断，具体强弱由 manager 里的实测吞吐决定。
 */
const BUILD_ORDER = ['opencl', 'cuda', 'cpu'];
const BUILD_LABEL = { opencl: 'OpenCL(GPU)', cuda: 'CUDA(GPU)', cpu: 'CPU' };

let buildCache = null;

function binPath(kind) {
  const name = process.platform === 'win32' ? 'katago.exe' : 'katago';
  return path.join(resolvePath('engine/bin'), kind, name);
}

/**
 * 逐个执行 `katago version`，只保留真正能跑起来的构建。
 * 典型场景：CUDA 版因为缺少 cuDNN 而无法启动，会被自动跳过。
 */
function probeBuilds({ force = false } = {}) {
  if (buildCache && !force) return buildCache;
  const results = [];

  for (const kind of BUILD_ORDER) {
    const exe = binPath(kind);
    if (!fs.existsSync(exe)) {
      results.push({ kind, exe, ok: false, reason: 'missing', label: BUILD_LABEL[kind] });
      continue;
    }
    try {
      const r = spawnSync(exe, ['version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      if (r.status === 0) {
        const version = String(r.stdout || '').split(/\r?\n/)[0].trim();
        results.push({ kind, exe, ok: true, version, label: BUILD_LABEL[kind], isGpu: kind !== 'cpu' });
      } else {
        results.push({
          kind,
          exe,
          ok: false,
          label: BUILD_LABEL[kind],
          reason: `启动失败 (0x${(r.status >>> 0).toString(16)})`,
        });
      }
    } catch (err) {
      results.push({ kind, exe, ok: false, label: BUILD_LABEL[kind], reason: err.message });
    }
  }

  buildCache = results;
  return results;
}

const RULE_NAMES = { chinese: 'chinese', japanese: 'japanese' };

/**
 * KataGo 引擎封装（一个 GTP 子进程）。
 *
 * 配置策略：直接使用 KataGo 自带的 default_gtp.cfg（保证键完整、随版本更新），
 * 需要调整的项通过官方的 -override-config 传入，避免手写配置文件漏键导致启动失败。
 */
class KataGoEngine {
  constructor(options = {}) {
    this.exe = options.exe;
    this.model = options.model;
    this.humanModel = options.humanModel && fs.existsSync(options.humanModel) ? options.humanModel : '';
    this.threads = options.threads || 8;
    /** 使用哪个官方配置模板：普通搜索用 default_gtp.cfg，拟人化用 human 示例 */
    this.configName = options.configName || 'default_gtp.cfg';
    this.label = options.label || path.basename(this.model || '');
    this.client = null;
    this.info = { name: '', version: '', humanSL: false };
  }

  get running() {
    return Boolean(this.client && this.client.alive);
  }

  /**
   * 生成 -override-config 参数串。
   *
   * 拟人化模式下只关掉日志，其余全部沿用官方 gtp_human5k_example.cfg
   * （噪声剪枝、LCB、温度、PikLambda 等一整套参数都是为"像人"调好的，
   * 覆盖任何一项都会让棋风或强度跑偏）。
   */
  _baseConfig(extra = {}) {
    const common = {
      logDir: resolveDataPath('logs').replace(/\\/g, '/'),
      logAllGTPCommunication: false,
      logSearchInfo: false,
      logToStderr: false,
    };
    const isHuman = this.configName !== 'default_gtp.cfg';
    const overrides = isHuman
      ? { ...common, ...extra }
      : {
          ...common,
          numSearchThreads: this.threads,
          nnMaxBatchSize: 8,
          ponderingEnabled: false,
          maxVisits: 200,
          maxTime: 2.0,
          ...extra,
        };
    // 缓存目录必须显式指定：KataGo 在 Windows 上默认把 OpenCL 调优结果写进
    // "当前目录"下的子目录，而打包成单文件 exe 后每次启动都解压到临时目录，
    // 那样调优结果每次都会丢，等于每次启动都要重做几分钟的调优。
    const withCacheDir = { homeDataDir: engineCacheDir().replace(/\\/g, '/'), ...overrides };
    return Object.entries(withCacheDir)
      .map(([k, v]) => `${k} = ${v}`)
      .join(', ');
  }

  async start() {
    if (this.running) return;
    const cfgDir = path.dirname(this.exe);
    const cfgFile = path.join(cfgDir, this.configName);
    const args = ['gtp', '-model', this.model];
    if (fs.existsSync(cfgFile)) args.push('-config', cfgFile);
    args.push('-override-config', this._baseConfig());
    if (this.humanModel) args.push('-human-model', this.humanModel);

    this.client = new GtpClient({ command: this.exe, args, cwd: cfgDir });
    this.client.on('log', (line) => {
      // 首次跑 OpenCL 会做一次 GPU 内核调优，这段时间特别长，
      // 记下来好让界面能说得具体一点，而不是笼统的"初始化中"
      if (/autotuning|GPU tuning|Tuning \d+\//i.test(line)) {
        this.info.tuning = true;
        this.info.tuningNote = line.trim().slice(0, 120);
      }
      if (process.env.KATAGO_VERBOSE) console.log(`[katago:${this.label}] ${line}`);
    });
    this.client.start();

    // 首次加载权重 + OpenCL 首次内核调优可能需要几分钟
    this.info.name = await this.client.send('name', 600000);
    this.info.version = await this.client.send('version', 600000);
    this.info.humanSL = Boolean(this.humanModel);
    // 能应答 name 就说明模型加载与调优都结束了
    this.info.tuning = false;
    try {
      await this.client.send('kata-set-param logSearchInfo false', 10000);
    } catch {
      /* 老版本可能不支持 */
    }
  }

  get stderrTail() {
    return this.client ? this.client.stderrTail.slice(-20) : [];
  }

  async stop() {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }

  /**
   * 把整盘棋同步给引擎。
   * 每次 genmove 前全量重放：最多三四百条命令，耗时可以忽略，
   * 但能保证悔棋、复盘跳转之后再出子一定正确。
   */
  async syncBoard(game) {
    const c = this.client;
    await c.send(`boardsize ${game.boardSize}`, 30000);
    await c.send(`komi ${game.komi}`, 30000);
    await c.send('clear_board', 30000);
    try {
      await c.send(`kata-set-rules ${RULE_NAMES[game.ruleSet] || 'chinese'}`, 30000);
    } catch {
      /* 规则名不被支持时保持 default_gtp.cfg 里的设置 */
    }
    for (const line of game.board.toGtpSequence()) {
      await c.send(line, 30000);
    }
  }

  /** 应用难度参数：人类风格档位，或"削弱版"搜索参数。 */
  async applyParams(params, { useHuman = false } = {}) {
    const c = this.client;
    const sets = [];
    if (useHuman && this.humanModel) {
      sets.push(['humanSLProfile', params.humanProfile]);
      // 访问数只用于判断 pass / 认输：官方建议每次至少留 30~40 次
      sets.push(['maxVisits', params.visits]);
      sets.push(['maxTime', params.maxTime]);
    } else {
      sets.push(['humanSLProfile', '']);
      sets.push(['maxVisits', params.visits]);
      sets.push(['maxTime', params.maxTime]);
      sets.push(['playoutDoublingAdvantage', params.playoutDoublingAdvantage]);
      sets.push(['rootPolicyTemperature', params.rootPolicyTemperature]);
      sets.push(['rootNoiseEnabled', params.rootNoiseEnabled ? 'true' : 'false']);
    }
    for (const [key, value] of sets) {
      try {
        await c.send(`kata-set-param ${key} ${value}`, 30000);
      } catch (err) {
        // humanSLProfile 在不支持时会被跳过，其余参数失败应当暴露出来
        if (key !== 'humanSLProfile') throw err;
      }
    }
  }

  async _genmoveRaw(game, color, timeout) {
    const answer = await this.client.send(`genmove ${color === rules.BLACK ? 'B' : 'W'}`, timeout);
    const text = String(answer).trim();
    if (/^pass$/i.test(text)) return { pass: true, raw: text };
    if (/^resign$/i.test(text)) return { resign: true, raw: text };
    const pt = rules.fromGtp(game.boardSize, text);
    if (!pt) throw new Error(`无法解析引擎落子: "${text}"`);
    return { ...pt, raw: text };
  }

  /** 产生一手棋。 */
  async genmove(game, color, params, { useHuman = false } = {}) {
    await this.syncBoard(game);
    if (params) await this.applyParams(params, { useHuman });
    const budget = (params ? params.maxTime : 2) * 1000;
    return this._genmoveRaw(game, color, Math.max(60000, budget + 120000));
  }

  /**
   * 实测吞吐：固定访问数跑一手空棋盘，算出每秒访问数。
   * 这个数字用来决定"这台机器该用多大的权重、能撑到几段"。
   *
   * 注意：访问数太少时线程启动/NN 预热开销会占主导，测出来的值严重偏低，
   * 所以先做一次预热，再用足够大的访问数测量。
   */
  async measureThroughput({ visits = 300, boardSize = 19, warmupVisits = 40 } = {}) {
    await this.client.send(`boardsize ${boardSize}`, 30000);
    await this.client.send('komi 7.5', 30000);
    await this.client.send('clear_board', 30000);
    const clean = {
      maxTime: 120,
      playoutDoublingAdvantage: 0,
      rootPolicyTemperature: 1,
      rootNoiseEnabled: false,
      humanProfile: '',
    };

    await this.applyParams({ ...clean, visits: warmupVisits }, { useHuman: false });
    await this.client.send('genmove B', 300000);

    await this.client.send('clear_board', 30000);
    await this.applyParams({ ...clean, visits }, { useHuman: false });
    const t0 = Date.now();
    await this.client.send('genmove B', 600000);
    const elapsed = (Date.now() - t0) / 1000;
    return Math.max(0.1, visits / Math.max(0.05, elapsed));
  }

  /** 让引擎给一手"参考下法"（提示功能）。 */
  async hint(game, color, params, opts = {}) {
    return this.genmove(game, color, params, opts);
  }

  /**
   * 让引擎判断哪些子是死子（GTP 的 final_status_list dead）。
   * 返回死子坐标数组；引擎不支持这个命令时抛错，由上层降级处理。
   */
  async finalStatusDead(game) {
    await this.syncBoard(game);
    const answer = await this.client.send('final_status_list dead', 180000);
    const text = String(answer).trim();
    if (!text || /^none$/i.test(text)) return [];

    const out = [];
    for (const token of text.split(/\s+/)) {
      if (/^pass$/i.test(token)) continue;
      const pt = rules.fromGtp(game.boardSize, token);
      if (pt) {
        const idx = rules.idxOf(game.boardSize, pt.x, pt.y);
        if (game.board.cells[idx] !== rules.EMPTY) out.push(idx);
      }
    }
    return out;
  }

  /** 引擎给出的最终比分（如 "W+88.0"），用于交叉验证。 */
  async finalScore(game) {
    await this.syncBoard(game);
    return String(await this.client.send('final_score', 180000)).trim();
  }

  /**
   * 形势判断：对指定局面跑一次限定访问数的分析。
   *
   * 用的是 GTP 的 kata-analyze。它会持续把分析结果按行吐出来，
   * 没有结束标志，所以这里的做法是：发出去之后轮询收集输出，
   * 访问数达到目标或者超时，就再发一条无害命令把分析打断。
   *
   * @returns {Promise<{winrate, scoreLead, visits, moves}|null>} 黑棋视角
   */
  async analyze(game, { visits = 120, maxMs = 4000, intervalMs = 120 } = {}) {
    if (!this.running) return null;
    await this.syncBoard(game);
    await this.applyParams(
      {
        visits,
        maxTime: Math.max(1, maxMs / 1000),
        playoutDoublingAdvantage: 0,
        rootPolicyTemperature: 1,
        rootNoiseEnabled: false,
        humanProfile: '',
      },
      { useHuman: false },
    );

    const lines = [];
    const onLog = (line) => {
      if (line.startsWith('info move ')) lines.push(line);
    };
    this.client.on('log', onLog);

    let stopped = false;
    try {
      this.client.proc.stdin.write(`kata-analyze interval ${intervalMs}\n`);
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        await new Promise((r) => setTimeout(r, 80));
        const last = lines[lines.length - 1];
        if (last) {
          const parsed = parseAnalyzeLine(last);
          if (parsed.length && (parsed[0].visits || 0) >= visits) break;
        }
      }
    } finally {
      this.client.off('log', onLog);
      stopped = true;
    }

    // 打断分析：随便发一条无害的查询命令即可
    if (stopped) {
      try {
        await this.client.send('kata-get-param maxVisits', 60000);
      } catch {
        /* 打断失败不影响结果 */
      }
    }

    const last = lines[lines.length - 1];
    if (!last) return null;
    return summarize(parseAnalyzeLine(last), game.turn);
  }
}

module.exports = { KataGoEngine, probeBuilds, BUILD_ORDER, BUILD_LABEL, binPath };
