'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { KataGoEngine, probeBuilds } = require('./katago');
const { BuiltinEngine } = require('./builtin');
const { loadConfig, discoverModels, resolvePath } = require('../config');
const { paramsForLevel, findLevel, LEVELS, levelIndexFromVisits } = require('./levels');

/**
 * 引擎管理器。
 *
 * 三个决策全自动：
 *   1. 用哪套构建 —— 实测能否启动（缺 cuDNN 的 CUDA 版会被跳过）
 *   2. 用多大的权重 —— 实测吞吐决定；纯 CPU 机器自动换轻量权重，
 *      否则 19 路一步要等几十秒，等于不能用
 *   3. 能撑到几段 —— 由"单步目标耗时"反推，结果会显示在界面上
 *
 * 另外会起两个 KataGo 进程：
 *   main  ：主权重 + default_gtp.cfg        —— 段位/高难度，靠搜索变强
 *   human ：主权重 + 人类模型 + 官方 human 配置 —— 级位/低段，像人一样下
 * 人类配置里有一批"关闭噪声剪枝、关 LCB、改温度"的参数是配置文件级的，
 * 和普通搜索混在一个进程里会互相污染，所以分开跑最干净。
 */

/** 目标：单步思考时间不超过这个值（秒），据此反推能稳定支持的最高难度。 */
const TARGET_MOVE_SECONDS = 8;

/** 用人类模型时，一步至少留这么多访问给"要不要 pass / 认输"的判断。 */
const HUMAN_MIN_VISITS = 40;

class EngineManager {
  constructor() {
    this.cfg = loadConfig();
    this.models = discoverModels();
    this.builds = [];
    this.unavailableBuilds = [];

    this.backend = null;
    this.modelPath = '';
    this.modelKind = 'none'; // main | fast | none
    this.humanModelPath = '';

    this.main = null; // KataGoEngine（普通搜索）
    this.human = null; // KataGoEngine（人类风格）
    this.builtin = new BuiltinEngine();

    this.visitsPerSec = 0;
    this.maxLevelIndex = 0;
    this.status = 'idle'; // idle | probing | loading | ready | builtin | error
    this.error = null;
    this.warnings = [];
    /** 状态变成 loading 的时刻，用来在界面上显示已经等了多久 */
    this.loadingSince = null;

    this.queue = Promise.resolve();
  }

  /** GTP 是单会话协议，所有调用串行排队。 */
  _enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------ 初始化
  async init() {
    this.status = 'probing';
    const probed = probeBuilds({ force: true });
    this.builds = probed.filter((b) => b.ok);
    this.unavailableBuilds = probed.filter((b) => !b.ok);
    for (const b of this.unavailableBuilds) {
      if (b.reason !== 'missing' && b.kind === 'cuda') {
        this.warnings.push(`CUDA 版无法启动（${b.reason}），通常是没有安装 cuDNN；已自动改用其他构建。`);
      }
    }

    if (!this.cfg.katago.enabled) return this._useBuiltin('配置中已禁用 KataGo');

    let chosen = null;
    const explicit = this.cfg.katago.path;
    if (explicit) {
      chosen = this.builds.find((b) => b.exe.toLowerCase() === explicit.toLowerCase()) || null;
      if (!chosen && fs.existsSync(explicit)) {
        chosen = { kind: 'custom', exe: explicit, label: '自定义', isGpu: true, ok: true };
      }
    }
    if (!chosen) chosen = this.builds[0] || null;
    if (!chosen) return this._useBuiltin('未找到可运行的 KataGo 引擎');
    this.backend = chosen;

    // config.json 里可能写的是相对路径，统一解析成绝对路径
    // （引擎的工作目录是 bin 目录，相对路径会找不到文件）
    const main = this.cfg.katago.model ? resolvePath(this.cfg.katago.model) : this.models.main;
    const fast = this.cfg.katago.fastModel ? resolvePath(this.cfg.katago.fastModel) : this.models.fast;
    const wantFast = !chosen.isGpu || this.cfg.katago.strength === 'fast';
    let model = wantFast && fast ? fast : main || fast;
    if (this.cfg.katago.strength === 'main' && main) model = main;
    if (!model) return this._useBuiltin('没有可用的权重文件');

    this.modelPath = model;
    this.modelKind = fast && model === fast ? 'fast' : 'main';
    this.humanModelPath = this.cfg.katago.useHumanModel
      ? this.cfg.katago.humanModel
        ? resolvePath(this.cfg.katago.humanModel)
        : this.models.human
      : '';

    if (!chosen.isGpu && this.modelKind === 'main') {
      this.warnings.push('当前使用 CPU 推理，速度较慢，建议换用轻量权重或小棋盘。');
    }

    this.status = 'loading';
      this.loadingSince = Date.now();
    const boardSize = this.cfg.defaults.boardSize || 19;
    const t0 = Date.now();
    try {
      this.main = this._createEngine('main');
      await this.main.start();
      this.visitsPerSec = await this.main.measureThroughput({ visits: 300, boardSize });
      this.maxLevelIndex = levelIndexFromVisits(this.visitsPerSec * TARGET_MOVE_SECONDS);
      this.status = 'ready';
      console.log(
        `[engine] ${chosen.label} + ${this.modelKind} 权重，加载 ${((Date.now() - t0) / 1000).toFixed(1)}s，` +
          `实测 ${this.visitsPerSec.toFixed(1)} 访问/秒，最高可稳定支持 ` +
          `${LEVELS[this.maxLevelIndex] ? LEVELS[this.maxLevelIndex].label : '?'}`,
      );
    } catch (err) {
      console.warn(`[engine] KataGo 启动失败: ${err.message}`);
      for (const line of this.main ? this.main.stderrTail : []) console.warn(`  ${line}`);
      this.main = null;
      return this._useBuiltin(`KataGo 启动失败: ${err.message}`);
    }

    // 人类风格进程后台预热，不阻塞服务启动
    if (this.humanModelPath && fs.existsSync(this.humanModelPath)) {
      this._warmHuman().catch((err) => {
        this.warnings.push(`人类风格模型未能启用：${err.message}`);
        console.warn(`[engine] 人类风格模型启动失败: ${err.message}`);
        this.human = null;
      });
    }
  }

  _createEngine(kind) {
    const exe = this.backend.exe;
    const isHuman = kind === 'human';
    return new KataGoEngine({
      exe,
      model: this.modelPath,
      humanModel: isHuman ? this.humanModelPath : '',
      threads: this.cfg.katago.threads,
      label: kind,
      // 人类风格用官方示例配置；普通搜索用默认配置
      configName: isHuman ? 'gtp_human5k_example.cfg' : 'default_gtp.cfg',
    });
  }

  async _warmHuman() {
    if (this.human && this.human.running) return this.human;
    // 后台预热和第一次真实调用可能同时进来，用同一个 promise 去重
    if (!this._humanWarmPromise) {
      this._humanWarmPromise = (async () => {
        const eng = this._createEngine('human');
        await eng.start();
        this.human = eng;
        console.log('[engine] 人类风格模型就绪（级位/低段位将使用拟人化走法）');
        return eng;
      })().finally(() => {
        this._humanWarmPromise = null;
      });
    }
    return this._humanWarmPromise;
  }

  _useBuiltin(reason) {
    this.status = 'builtin';
    this.error = reason || null;
    this.visitsPerSec = 0;
    this.maxLevelIndex = Math.max(this.maxLevelIndex, 20); // 内置引擎大概到 10 级
    console.log(`[engine] 使用内置引擎（${reason}）`);
  }

  // ------------------------------------------------------------ 出子
  /** 该难度该不该用人类风格。 */
  _shouldUseHuman(params) {
    if (!this.humanModelPath) return false;
    const maxIdx = this.cfg.katago.humanModelMaxIndex != null ? this.cfg.katago.humanModelMaxIndex : 32;
    // curve 是 0~38 的强度曲线位置，与人类模型档位一一对应
    return params.curve <= maxIdx;
  }

  async genmove(game, color, levelId, options = {}) {
    return this._enqueue(async () => {
      const level = findLevel(levelId);
      let params = paramsForLevel(level ? level.id : '10k');
      // 有棋钟时把思考时间压到剩余时间以内
      if (options.maxTimeCap != null) {
        params = { ...params, maxTime: Math.max(0.3, Math.min(params.maxTime, options.maxTimeCap)) };
      }

      if (this.main && this.main.running) {
        const useHuman = this._shouldUseHuman(params);
        try {
          if (useHuman) {
            const eng = this.human && this.human.running ? this.human : await this._warmHuman();
            const mv = await eng.genmove(game, color, this._humanParams(params), { useHuman: true });
            return { ...mv, engine: 'katago-human' };
          }
          const mv = await this.main.genmove(game, color, params, { useHuman: false });
          return { ...mv, engine: 'katago' };
        } catch (err) {
          console.warn(`[engine] KataGo 出子失败，改用内置引擎: ${err.message}`);
          if (useHuman) this.human = null;
          else this._useBuiltin(`运行中出错: ${err.message}`);
        }
      }

      const mv = await this.builtin.genmove(game, color, params);
      return { ...mv, engine: 'builtin' };
    });
  }

  /**
   * 人类风格下的搜索参数。
   * 官方 5k 配置用"只看模型、几乎不搜索"来保证像人；
   * 访问数只留给 pass/认输判断，所以这里用固定的小值。
   */
  _humanParams(params) {
    return {
      ...params,
      visits: Math.max(HUMAN_MIN_VISITS, Math.min(120, params.visits)),
      maxTime: Math.max(1.0, Math.min(3.0, params.maxTime)),
    };
  }

  /** 人人的"提示"：固定用较强设置。 */
  async hint(game, color, levelId) {
    return this._enqueue(async () => {
      if (this.main && this.main.running) {
        const base = paramsForLevel(levelId || '5d');
        const strong = { ...base, visits: Math.max(base.visits, 500), maxTime: Math.max(base.maxTime, 3) };
        const mv = await this.main.hint(game, color, strong, { useHuman: false });
        return { ...mv, engine: 'katago' };
      }
      const params = paramsForLevel('1k');
      return { ...(await this.builtin.genmove(game, color, params)), engine: 'builtin' };
    });
  }

  /**
   * 自动判断死子（终局数子用）。
   *
   * 走的是 KataGo 的 final_status_list，由引擎按死活搜索来判断，
   * 比让用户一个个点棋块准确得多。没有 KataGo 时返回 null，
   * 界面会提示改用手动标记。
   */
  async autoDead(game) {
    return this._enqueue(async () => {
      if (!this.main || !this.main.running) return null;
      try {
        const dead = await this.main.finalStatusDead(game);
        let score = null;
        try {
          score = await this.main.finalScore(game);
        } catch {
          /* 部分版本可能没有 final_score，不影响死子判定 */
        }
        return { dead, score, engine: 'katago' };
      } catch (err) {
        console.warn(`[engine] 自动判定死子失败: ${err.message}`);
        return null;
      }
    });
  }

  /**
   * 形势判断：分析第 ply 手之后的局面。
   * 没有 KataGo 时返回 null，界面会把面板标成不可用。
   */
  async analyzeAt(game, ply, options = {}) {
    if (!this.main || !this.main.running) return null;
    return this._enqueue(async () => {
      try {
        const snapshot = game.reviewGameAt(ply);
        const r = await this.main.analyze(snapshot, {
          visits: options.visits || 120,
          maxMs: options.maxMs || 4000,
          intervalMs: options.intervalMs || 100,
        });
        return r ? { ...r, ply: snapshot.moveLog.length, turn: snapshot.turn, engine: 'katago' } : null;
      } catch (err) {
        console.warn(`[engine] 形势判断失败: ${err.message}`);
        return null;
      }
    });
  }

  async shutdown() {
    await Promise.all([
      this.main ? this.main.stop() : null,
      this.human ? this.human.stop() : null,
    ]);
    this.main = null;
    this.human = null;
  }

  describe() {
    const usableLevels = LEVELS.filter((l) => l.index <= this.maxLevelIndex).map((l) => l.id);
    return {
      status: this.status,
      // 首次 OpenCL 要做 GPU 内核调优，界面据此显示更具体的原因
      tuning: Boolean(this.main && this.main.info && this.main.info.tuning),
      loadingSeconds: this.loadingSince ? Math.round((Date.now() - this.loadingSince) / 1000) : 0,
      engine: this.main && this.main.running ? 'katago' : 'builtin',
      backend: this.backend ? { kind: this.backend.kind, label: this.backend.label } : null,
      backendVersion: this.main ? this.main.info.version : '',
      model: this.modelPath ? path.basename(this.modelPath) : '',
      modelKind: this.modelKind,
      humanModel: Boolean(this.humanModelPath),
      humanModelReady: Boolean(this.human && this.human.running),
      visitsPerSec: Number(this.visitsPerSec.toFixed(1)),
      maxLevelIndex: this.maxLevelIndex,
      recommendedMaxLevel: LEVELS[this.maxLevelIndex] ? LEVELS[this.maxLevelIndex].label : '',
      usableLevels,
      unavailableBuilds: this.unavailableBuilds
        .filter((b) => b.reason !== 'missing')
        .map((b) => ({ kind: b.kind, label: b.label, reason: b.reason })),
      warnings: this.warnings,
      note: this.error || '',
    };
  }
}

module.exports = { EngineManager, levelIndexFromVisits, TARGET_MOVE_SECONDS, HUMAN_MIN_VISITS };
