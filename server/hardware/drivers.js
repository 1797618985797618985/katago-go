'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const { resolvePath } = require('../config');

/**
 * 传输层：负责把一条 JSON 指令送到棋盘控制器。
 * 上层只关心"指令语义"，不关心走 TCP 还是串口。
 *
 * 之所以都用「一行一个 JSON」这种最笨的格式，是因为单片机一侧
 * 用 ArduinoJson 之类的库解析起来最简单，也便于用串口助手手工调试。
 */

class Transport extends EventEmitter {
  get connected() {
    return false;
  }
  async connect() {}
  async send() {}
  async close() {}
}

/** 不接硬件：所有指令直接丢弃。 */
class NullTransport extends Transport {
  get connected() {
    return false;
  }
  async send(obj) {
    this.emit('sent', obj);
  }
}

/**
 * 联调用：把指令按行追加到文件，不驱动任何电机。
 * 没有实体棋盘时，打开 engine/hardware.log 就能看到"如果接了硬件会执行什么"。
 */
class LogTransport extends Transport {
  constructor(options = {}) {
    super();
    this.file = options.file || resolvePath('engine/hardware.log');
    this.ready = false;
  }

  get connected() {
    return this.ready;
  }

  async connect() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.ready = true;
    this.emit('open');
  }

  async send(obj) {
    const line = `${new Date().toISOString()} ${JSON.stringify(obj)}\n`;
    if (this.stream) this.stream.write(line);
    this.emit('sent', obj);
  }

  async close() {
    if (this.stream) this.stream.end();
    this.ready = false;
  }
}

/**
 * TCP 客户端：连到棋盘控制器（ESP32 / 树莓派 / 串口转网口模块）。
 * 断线后按 reconnectMs 自动重连。
 */
class TcpTransport extends Transport {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 9100;
    this.reconnectMs = options.reconnectMs || 3000;
    this.socket = null;
    this.buffer = '';
    this.closed = false;
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.readyState === 'open');
  }

  async connect() {
    return new Promise((resolve) => {
      const tryConnect = () => {
        if (this.closed) return;
        this.socket = net.createConnection({ host: this.host, port: this.port });
        this.socket.setEncoding('utf8');

        this.socket.on('connect', () => {
          this.emit('open');
          resolve();
        });
        this.socket.on('data', (chunk) => {
          this.buffer += chunk;
          let nl;
          while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            try {
              this.emit('message', JSON.parse(line));
            } catch {
              this.emit('message', { event: 'raw', text: line });
            }
          }
        });
        this.socket.on('error', (err) => {
          this.emit('error', err);
          resolve();
        });
        this.socket.on('close', () => {
          this.emit('close');
          if (!this.closed) setTimeout(tryConnect, this.reconnectMs);
        });
      };
      tryConnect();
    });
  }

  async send(obj) {
    if (!this.connected) throw new Error('棋盘控制器未连接');
    this.socket.write(`${JSON.stringify(obj)}\n`);
    this.emit('sent', obj);
  }

  async close() {
    this.closed = true;
    if (this.socket) this.socket.destroy();
  }
}

/**
 * 子进程 + stdio：适合本机用 Python(pyserial) 之类的脚本去驱动串口。
 * 主机写 stdin，脚本读串口；脚本把控制器的回包写到 stdout。
 */
class StdioTransport extends Transport {
  constructor(options = {}) {
    super();
    this.command = options.command;
    this.args = options.args || [];
    this.proc = null;
    this.buffer = '';
  }

  get connected() {
    return Boolean(this.proc && !this.proc.killed);
  }

  async connect() {
    if (!this.command) throw new Error('未配置 stdio.command');
    this.proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          this.emit('message', JSON.parse(line));
        } catch {
          this.emit('message', { event: 'raw', text: line });
        }
      }
    });
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', () => this.emit('close'));
    this.emit('open');
  }

  async send(obj) {
    if (!this.connected) throw new Error('棋盘驱动进程未运行');
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    this.emit('sent', obj);
  }

  async close() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        /* 忽略 */
      }
    }
    this.proc = null;
  }
}

function createTransport(cfg) {
  switch (cfg.driver) {
    case 'tcp':
      return new TcpTransport(cfg.tcp);
    case 'stdio':
      return new StdioTransport(cfg.stdio);
    case 'log':
      return new LogTransport({});
    default:
      return new NullTransport();
  }
}

module.exports = { Transport, NullTransport, LogTransport, TcpTransport, StdioTransport, createTransport };
