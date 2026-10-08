'use strict';

const { EventEmitter } = require('node:events');
const { createTransport } = require('./drivers');
const { loadConfig } = require('../config');

const { BLACK, WHITE } = require('../game/board');

/**
 * 实体电驱棋盘桥接层。
 *
 * 这一层把"棋局事件"翻译成"机械动作指令"，是程序和硬件之间唯一的接口：
 *
 *   落子      -> place  (落子 + 提子一次性下发，控制器自行安排取子/落子顺序)
 *   停一手    -> pass
 *   悔棋      -> sync   (直接让棋盘和软件状态对齐，最省事也最不容易出错)
 *   新开一局  -> reset
 *   终局      -> end
 *
 * 反向也能走：控制器上报 {"event":"button","x":..,"y":..} 时，
 * 会以 'input' 事件抛给上层，于是实体棋盘上的落子能直接驱动界面。
 *
 * 坐标约定与程序内部一致：x 从左到右 0..size-1，y 从上到下 0..size-1。
 * 电机机构如何把 (x,y) 映射到实际的 XY/极坐标滑台，由控制器一侧决定。
 */

const DRIVER_LABEL = {
  none: '未启用',
  log: '日志模拟',
  tcp: 'TCP 控制器',
  stdio: '串口桥接进程',
};

class HardwareBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cfg = options.config || loadConfig();
    this.hw = this.cfg.hardware;
    this.transport = createTransport(this.hw);
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, timer}
    this.history = [];
    this.connected = false;
    this.lastError = null;

    this.transport.on('message', (msg) => this._onMessage(msg));
    this.transport.on('open', () => {
      this.connected = true;
      this.emit('status', this.status());
    });
    this.transport.on('close', () => {
      this.connected = false;
      this.emit('status', this.status());
    });
    this.transport.on('error', (err) => {
      this.lastError = err.message;
      this.emit('status', this.status());
    });
  }

  get enabled() {
    return Boolean(this.hw.enabled) && this.hw.driver !== 'none';
  }

  async start() {
    if (!this.enabled) return;
    try {
      await this.transport.connect();
      this.connected = this.transport.connected;
    } catch (err) {
      this.lastError = err.message;
      console.warn(`[hardware] 控制器连接失败: ${err.message}`);
    }
  }

  async stop() {
    await this.transport.close();
  }

  _onMessage(msg) {
    if (msg && msg.ack != null) {
      const entry = this.pending.get(msg.ack);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.ack);
        entry.resolve(msg);
      }
      return;
    }
    if (msg && msg.event === 'button' && Number.isInteger(msg.x) && Number.isInteger(msg.y)) {
      // 实体棋盘上的按键落子
      this.emit('input', { x: msg.x, y: msg.y });
      return;
    }
    this.emit('message', msg);
  }

  /**
   * 下发一条指令。硬件不在线时静默跳过（不能让棋盘没接就下不了棋），
   * 但会记录到 history 便于排查。
   */
  async send(cmd, { requireAck = null } = {}) {
    const payload = { id: this.nextId++, ...cmd };
    this.history.push({ t: Date.now(), dir: 'out', payload });
    if (this.history.length > 500) this.history.shift();

    if (!this.enabled) return null;

    const waitAck = requireAck != null ? requireAck : this.hw.options.ackTimeoutMs > 0;
    const delay = this.hw.options.interCommandDelayMs || 0;

    try {
      const promise = this.transport.send(payload);
      if (waitAck) {
        const id = payload.id;
        const ackPromise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            resolve({ timeout: true });
          }, this.hw.options.ackTimeoutMs || 8000);
          this.pending.set(id, { resolve, timer });
        });
        await promise;
        if (delay) await sleep(delay);
        return await ackPromise;
      }
      await promise;
      if (delay) await sleep(delay);
      return null;
    } catch (err) {
      this.lastError = err.message;
      this.emit('status', this.status());
      return null;
    }
  }

  // ------------------------------------------------------------ 棋局事件

  /** 新开一局：清空棋盘，告知棋盘尺寸与让子。 */
  async onGameStart(game) {
    if (!this.enabled) return;
    await this.send({
      cmd: 'reset',
      size: game.boardSize,
      komi: game.komi,
      handicap: game.handicap,
      mode: game.mode,
    });
    for (const m of game.board.moves) {
      if (m.handicap) {
        for (const p of m.points) {
          await this.send({ cmd: 'place', color: 'B', x: p.x, y: p.y, capture: [] });
        }
      }
    }
    const last = game.moveLog[game.moveLog.length - 1];
    if (last) await this._syncLast(game, last);
  }

  /** 一步棋：落子 + 提子，合并成一条指令下发。 */
  async onMove(game, move, capturedPoints = []) {
    if (!this.enabled) return;
    if (move.pass) {
      await this.send({ cmd: 'pass', color: colorChar(move.color), moveNo: move.no });
      return;
    }
    await this.send({
      cmd: 'place',
      color: colorChar(move.color),
      x: move.x,
      y: move.y,
      // 被提掉的子必须从棋盘上取走，控制器据此驱动取子机构
      capture: capturedPoints.map((p) => [p.x, p.y]),
      moveNo: move.no,
    });
  }

  /** 悔棋 / 跳转：直接对齐，避免逐手倒推。 */
  async onSync(game) {
    if (!this.enabled) return;
    const stones = [];
    for (let y = 0; y < game.boardSize; y++) {
      for (let x = 0; x < game.boardSize; x++) {
        const c = game.board.cells[y * game.boardSize + x];
        if (c === BLACK) stones.push([x, y, 'B']);
        else if (c === WHITE) stones.push([x, y, 'W']);
      }
    }
    await this.send({ cmd: 'sync', size: game.boardSize, stones });
  }

  async onGameEnd(game) {
    if (!this.enabled) return;
    await this.send({
      cmd: 'end',
      winner: game.result ? colorChar(game.result.winner) : null,
      text: game.result ? game.result.text : '',
    });
  }

  /** 可选：在棋盘上点亮提示灯（如果硬件有 LED 阵列）。 */
  async onHint(point, color) {
    if (!this.enabled || !point) return;
    await this.send({ cmd: 'led', color: colorChar(color), x: point.x, y: point.y, mode: 'blink' });
  }

  async _syncLast(game, last) {
    await this.send({ cmd: 'sync_last', color: colorChar(last.color), x: last.x, y: last.y });
  }

  status() {
    return {
      enabled: this.enabled,
      driver: this.hw.driver,
      driverLabel: DRIVER_LABEL[this.hw.driver] || this.hw.driver,
      connected: this.connected,
      pending: this.pending.size,
      lastError: this.lastError,
      recent: this.history.slice(-10),
    };
  }
}

function colorChar(c) {
  return c === BLACK ? 'B' : c === WHITE ? 'W' : '?';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { HardwareBridge, colorChar, DRIVER_LABEL };
