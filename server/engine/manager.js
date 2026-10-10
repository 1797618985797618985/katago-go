'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { KataGoEngine, probeBuilds } = require('./katago');
const { BuiltinEngine } = require('./builtin');
const { loadConfig, discoverModels, resolvePath } = require('../config');
const {
  paramsForLevel,
  findLevel,
  LEVELS,
  levelIndexFromVisits,
  getVisitsPerSecond,
  setVisitsPerSecond,
} = require('./levels');

/**
 * 引擎管理器。
 *
 * 三个决策全自动：
 *   1. 用哪套构建 —— 实测能否启动（缺 cuDNN 的 CUDA 版会被跳过）
 *   2. 用多大的权重 —— 实测吞吐决定；纯 CPU 机器自动换轻量权重，
 *      否则 19 路一步要等几十秒，等于不能用
 *   3. 能撑到几段 —— 由"单步目标耗时"反推，结果会显示在界面上
 *
 * 只起一个 KataGo 进程：主权重 + default_gtp.cfg，靠搜索加难度。
 * 早先还有第二个进程跑人类风格模型（级位/低段拟人化），实测那条路每步
 * 4~8 秒且时间压不下来，已经整个去掉 —— 详见 levels.js 顶部的说明。
 */

// 单步时间预算由 levels.js 的比率统一控制（每 N 次访问给 1 秒）。
// 能稳定支持到哪一档，就是"本机在这么久里能算完多少访问"：
// 实测吞吐 × 最难档愿意等的时间 = 可支持的访问数上限。
// 6000 是最难档的访问数，所以要除以同一个比率，两边才是同一把尺子。
function targetMoveSeconds() {
  return 6000 / getVisitsPerSecond();
}

class EngineManager {
  constructor() {
    this.cfg = loadConfig();
    this.models = discoverModels();
    this.builds = [];
    this.unavailableBuilds = [];

    this.backend = null;
    this.modelPath = '';
    this.modelKind = 'none'; // main | fast | none

    this.main = null; // KataGoEngine（普通搜索）
    this.builtin = new BuiltinEngine();

    this.visitsPerSec = 0;
    this.maxLevelIndex = 0;
    this.status = 'idle'; // idle | probing | loading | ready | builtin | error
    this.error = null;
    this.warnings = [];
    /** 状态变成 loading 的时刻，用来在界面上显示已经等了多久 */
    this.loadingSince = null;
    /**
     * 状态变化时的回调。引擎初始化是异步的（首次还要做几分钟的 GPU 调优），
     * 如果不在变化时主动通知，界面就会一直停在"初始化中"，
     * 除非用户碰巧做了别的操作触发一次刷新。
     */
    this.onChange = null;

    this.queue = Promise.resolve();
  }

  /** GTP 是单会话协议，所有调用串行排队。 */
  _enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** 通知外部状态变了（界面据此实时刷新） */
  _notify() {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch {
      /* 通知失败不影响引擎本身 */
    }
  }

  // ------------------------------------------------------------ 初始化
  async init() {
    // 时间预算比率允许在 config.json 里覆盖，必须在算难度之前生效
    if (this.cfg.katago.visitsPerSecond != null) {
      setVisitsPerSecond(this.cfg.katago.visitsPerSecond);
    }
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
      this.maxLevelIndex = levelIndexFromVisits(this.visitsPerSec * targetMoveSeconds());
      this.status = 'ready';
      this._notify();
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
  }

  _createEngine(kind = 'main') {
    return new KataGoEngine({
      exe: this.backend.exe,
      model: this.modelPath,
      threads: this.cfg.katago.threads,
      label: kind,
      configName: 'default_gtp.cfg',
    });
  }

  _useBuiltin(reason) {
    this.status = 'builtin';
    this.error = reason || null;
    this.visitsPerSec = 0;
    this.maxLevelIndex = Math.max(this.maxLevelIndex, 20); // 内置引擎大概到 10 级
    console.log(`[engine] 使用内置引擎（${reason}）`);
    this._notify();
  }

  // ------------------------------------------------------------ 出子

  async genmove(game, color, levelId, options = {}) {
    return this._enqueue(async () => {
      const level = findLevel(levelId);
      let params = paramsForLevel(level ? level.id : '10k');
      // 有棋钟时把思考时间压到剩余时间以内
      if (options.maxTimeCap != null) {
        params = { ...params, maxTime: Math.max(0.3, Math.min(params.maxTime, options.maxTimeCap)) };
      }

      if (this.main && this.main.running) {
        try {
          const mv = await this.main.genmove(game, color, params, { useHuman: false });
          return { ...mv, engine: 'katago' };
        } catch (err) {
          console.warn(`[engine] KataGo 出子失败，改用内置引擎: ${err.message}`);
          this._useBuiltin(`运行中出错: ${err.message}`);
        }
      }

      const mv = await this.builtin.genmove(game, color, params);
      return { ...mv, engine: 'builtin' };
    });
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
    await Promise.all([this.main ? this.main.stop() : null]);
    this.main = null;
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

module.exports = { EngineManager, levelIndexFromVisits, targetMoveSeconds };
