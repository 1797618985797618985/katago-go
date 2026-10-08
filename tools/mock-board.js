'use strict';

/**
 * 模拟棋盘控制器：监听 TCP 端口，接收电驱棋盘指令并回 ack。
 * 没有实体硬件时，用它验证协议与驱动是否正确。
 *
 * 用法： node tools/mock-board.js [port]     默认 9100
 * 然后 config.json 里把 hardware.driver 设为 "tcp" 即可。
 */

const net = require('node:net');

const port = Number(process.argv[2] || 9100);
const t = () => new Date().toISOString().slice(11, 23);

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[${t()}] 控制器已连接: ${peer}`);

  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch {
        console.log(`[${t()}] 无法解析: ${line}`);
        continue;
      }
      handle(socket, cmd);
    }
  });

  socket.on('close', () => console.log(`[${t()}] 连接断开: ${peer}`));
  socket.on('error', (err) => console.log(`[${t()}] 连接错误: ${err.message}`));

  // 上线后主动上报一次
  socket.write(`${JSON.stringify({ event: 'ready', firmware: 'mock-1.0' })}\n`);
});

const coord = (x, y) => `${String.fromCharCode(65 + x)}${19 - y}`;

function handle(socket, cmd) {
  const id = cmd.id;
  switch (cmd.cmd) {
    case 'ping':
      console.log(`[${t()}] ping`);
      break;
    case 'reset':
      console.log(`[${t()}] reset 清空棋盘（${cmd.size} 路，贴目 ${cmd.komi}，让子 ${cmd.handicap}）`);
      // 模拟机构耗时
      setTimeout(() => ack(socket, id), 300);
      return;
    case 'place': {
      const cap = (cmd.capture || []).map(([x, y]) => coord(x, y));
      console.log(
        `[${t()}] place 第${cmd.moveNo || '?'}手 ${cmd.color === 'B' ? '黑' : '白'} ${coord(cmd.x, cmd.y)}` +
          (cap.length ? `，取子 ${cap.join(' ')}` : ''),
      );
      setTimeout(() => ack(socket, id), 250 + (cmd.capture ? cmd.capture.length * 200 : 0));
      return;
    }
    case 'pass':
      console.log(`[${t()}] pass ${cmd.color === 'B' ? '黑' : '白'} 停一手`);
      break;
    case 'sync':
      console.log(`[${t()}] sync 对齐棋盘，共 ${(cmd.stones || []).length} 子`);
      setTimeout(() => ack(socket, id), 600);
      return;
    case 'sync_last':
      console.log(`[${t()}] sync_last 标记最后一手 ${cmd.color} ${coord(cmd.x, cmd.y)}`);
      break;
    case 'end':
      console.log(`[${t()}] end 对局结束: ${cmd.text}`);
      break;
    case 'led':
      console.log(`[${t()}] led 闪烁 ${coord(cmd.x, cmd.y)}`);
      break;
    default:
      console.log(`[${t()}] 未知指令: ${JSON.stringify(cmd)}`);
  }
  ack(socket, id);
}

function ack(socket, id) {
  if (id == null) return;
  socket.write(`${JSON.stringify({ ack: id, ok: true })}\n`);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`模拟棋盘控制器已启动: tcp://127.0.0.1:${port}`);
  console.log('把 config.json 的 hardware.driver 设为 "tcp" 即可接入。');
});
