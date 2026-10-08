'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

/**
 * 极简 GTP 客户端：把 GTP 文本协议封装成 Promise 调用。
 *
 * GTP 应答格式为 "=<id> 内容" （成功）或 "?<id> 错误内容"（失败）。
 * 引擎可能把多行内容拆开发送，因此这里按行读取并缓存未完成的行。
 */
class GtpClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    this.alive = false;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        this.emit('log', line);
      }
    });

    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      const err = new Error(`KataGo 进程退出 (code=${code}, signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.emit('exit', code, signal);
    });

    this.proc.on('error', (err) => {
      this.alive = false;
      this.emit('error', err);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    const m = /^([=?])(\d*)\s?([\s\S]*)$/.exec(line);
    if (!m) {
      this.emit('log', line);
      return;
    }
    const [, status, idStr, payloadRaw] = m;
    const id = idStr ? Number(idStr) : null;
    const payload = payloadRaw.trim();

    // 无 id 的应答：属于上一条命令
    const entry = id !== null ? this.pending.get(id) : this._firstPending();
    if (!entry) {
      this.emit('log', line);
      return;
    }
    if (status === '=') {
      entry.lines.push(payload);
      // GTP 应答可能分多行，直到出现空行才结束；这里用"命令结束"启发式：
      // 立即返回，因为 KataGo 的普通命令都是单行应答。
      this.pending.delete(entry.id);
      clearTimeout(entry.timer);
      entry.resolve(entry.lines.join('\n'));
    } else {
      this.pending.delete(entry.id);
      clearTimeout(entry.timer);
      const err = new Error(payload || 'GTP 命令失败');
      err.gtp = true;
      err.command = entry.command;
      entry.reject(err);
    }
  }

  _firstPending() {
    for (const v of this.pending.values()) return v;
    return null;
  }

  /**
   * 发送一条 GTP 命令。
   * @param {string} command 例如 'genmove B'
   * @param {number} timeoutMs 超时（思考时间长的命令需要放宽）
   */
  send(command, timeoutMs = 30000) {
    if (!this.proc || !this.alive) {
      return Promise.reject(new Error('GTP 引擎未启动'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`GTP 命令超时: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { id, resolve, reject, timer, lines: [], command });
      this.proc.stdin.write(`${id} ${command}\n`, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** 尽力而为地关闭：先 quit，再强杀。 */
  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    try {
      if (this.alive) await Promise.race([this.send('quit', 3000), wait(3000)]);
    } catch {
      /* 忽略 */
    }
    await wait(200);
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
    this.proc = null;
    this.alive = false;
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { GtpClient, wait };
