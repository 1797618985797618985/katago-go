'use strict';

/**
 * 实体棋盘回路测试（端到端，不需要真实硬件）。
 *
 * 做的事：
 *   1. 用一个临时配置启动真正的服务端（关掉 KataGo，免得等十几秒）
 *   2. 起一个假的棋盘控制器监听 TCP
 *   3. 模拟玩家在实体棋盘上落子（上报 button 事件）
 *   4. 检查：对局状态确实更新了、来源标成 hardware、
 *      程序把落子指令回发给了控制器、重复落子会被拒绝
 *
 * 用法： node tools/hardware-loop-test.js
 */

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function getJson(url, options) {
  const res = await fetch(url, {
    method: (options && options.method) || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options && options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

async function waitFor(fn, timeoutMs = 30000, stepMs = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-hw-test-'));
  const httpPort = await freePort();
  const boardPort = await freePort();
  const configPath = path.join(tmpDir, 'config.json');

  // 关掉 KataGo，让服务端秒起；硬件走 TCP
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        server: { port: httpPort, host: '127.0.0.1' },
        katago: { enabled: false },
        hardware: {
          enabled: true,
          driver: 'tcp',
          tcp: { host: '127.0.0.1', port: boardPort, reconnectMs: 300 },
          options: { interCommandDelayMs: 0, ackTimeoutMs: 3000 },
        },
        defaults: { boardSize: 9, komi: 7, level: '15k' },
      },
      null,
      2,
    ),
  );

  // ---- 假控制器
  const received = [];
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        received.push(msg);
        if (msg.id != null) socket.write(`${JSON.stringify({ ack: msg.id, ok: true })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(boardPort, '127.0.0.1', resolve));

  // ---- 启动真正的服务端
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, CONFIG_FILE: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  const base = `http://127.0.0.1:${httpPort}`;
  const cleanup = async () => {
    try {
      child.kill();
    } catch {}
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    console.log('实体棋盘回路测试\n');

    const up = await waitFor(async () => {
      try {
        const s = await getJson(`${base}/api/status`);
        return s && s.version ? s : null;
      } catch {
        return null;
      }
    }, 30000);
    check('服务端起来了', Boolean(up), serverLog.slice(-400));

    // 等 TCP 握手完成（服务端是异步连过去的）
    const linked = await waitFor(async () => {
      const s = await getJson(`${base}/api/status`);
      return s.hardware && s.hardware.connected ? s : null;
    }, 10000);
    check('程序主动连上了控制器', Boolean(linked), JSON.stringify((await getJson(`${base}/api/status`)).hardware));

    // 再发一条 ping，确认指令能真正送达
    await getJson(`${base}/api/hardware/test`, { method: 'POST' });
    const gotPing = await waitFor(() => received.some((m) => m.cmd === 'ping'), 5000);
    check('控制器能收到指令', Boolean(gotPing), JSON.stringify(received));

    // ---- 还没开局时也应该能用硬件接口
    const early = await getJson(`${base}/api/hardware/test`, { method: 'POST' });
    check('未开局也能测试硬件连接', early.ok === true, JSON.stringify(early));

    // ---- 新开一局
    let r = await getJson(`${base}/api/game/new`, {
      method: 'POST',
      body: { mode: 'pvp', boardSize: 9, komi: 7 },
    });
    check('新开一局', r.ok && r.game.moveCount === 0);
    const gotReset = await waitFor(() => received.some((m) => m.cmd === 'reset'), 5000);
    check('新对局会通知棋盘复位', Boolean(gotReset));

    // ---- 模拟玩家在实体棋盘上落子
    const sock = sockets[0];
    check('控制器连接存在', Boolean(sock));
    sock.write(`${JSON.stringify({ event: 'button', x: 2, y: 2 })}\n`);

    const afterMove = await waitFor(async () => {
      const s = await getJson(`${base}/api/status`);
      return s.game && s.game.moveCount === 1 ? s : null;
    }, 10000);
    check('实体棋盘落子被接受', Boolean(afterMove), JSON.stringify((await getJson(`${base}/api/status`)).game));
    check('来源标记为 hardware', afterMove && afterMove.lastMoveSource === 'hardware', String(afterMove && afterMove.lastMoveSource));
    check('落的是黑棋', afterMove && afterMove.game.moveLog[0].color === 1);
    check('轮转给白棋', afterMove && afterMove.game.turn === 2);

    const placeCmd = await waitFor(() => received.find((m) => m.cmd === 'place' && m.x === 2 && m.y === 2), 5000);
    check('程序把落子指令回发给控制器', Boolean(placeCmd), JSON.stringify(received.slice(-5)));
    check('指令里带了颜色和手数', placeCmd && placeCmd.color === 'B' && placeCmd.moveNo === 1, JSON.stringify(placeCmd));

    // ---- 违规落子：同一个点再来一次
    received.length = 0;
    sock.write(`${JSON.stringify({ event: 'button', x: 2, y: 2 })}\n`);
    const st = await waitFor(async () => {
      const s = await getJson(`${base}/api/status`);
      return s.error ? s : null;
    }, 8000);
    check('实体棋盘重复落子被拒绝', Boolean(st && st.error), JSON.stringify(st && st.error));
    check('拒绝原因写进了 error', Boolean(st && st.error && st.error.includes('实体棋盘')), String(st && st.error));
    check('手数没有被改动', st && st.game.moveCount === 1, String(st && st.game.moveCount));
    check('被拒绝时不会给控制器发落子指令', !received.some((m) => m.cmd === 'place'));
  } finally {
    await cleanup();
  }

  console.log(`\n结果： ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
