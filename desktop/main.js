'use strict';

/**
 * 桌面版入口。
 *
 * 用的是 Electron：窗口里跑的是本项目自己的界面，
 * 后端仍然是 `server/` 那套逻辑，直接在同一个进程组里启动，
 * 监听的是系统分配的随机端口，只绑 127.0.0.1，外面访问不到。
 *
 * 命令行参数：
 *   --screenshot=<文件>   启动后截图并退出（用于自动验证界面渲染）
 *   --dev                 打开开发者工具
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, shell, dialog } = require('electron');

// 打包后：引擎和权重在 resources/engine（体积大，不能塞进 asar 里），
// 可写的 config.json / 日志放到系统的用户数据目录。
// 这一步必须在 require 服务端之前做，因为配置模块启动时就会读这些环境变量。
if (app.isPackaged) {
  process.env.APP_ROOT = process.resourcesPath;
}
process.env.APP_DATA = app.getPath('userData');

const { startServer } = require('../server/index');

const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const shotPath = shotArg ? path.resolve(shotArg.slice('--screenshot='.length)) : null;
const isDev = process.argv.includes('--dev');

// 只允许跑一个实例，第二次启动就把已有窗口调到前面
if (!app.requestSingleInstanceLock() && !shotPath) {
  app.quit();
}

let mainWindow = null;
let backend = null;

/** 截一张图，顺便先摆几个子，这样截出来像真的在下棋 */
async function captureAndExit(url) {
  const call = (p, body) =>
    fetch(url + p, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json());

  try {
    // 等引擎就绪（首次启动要加载权重，OpenCL 还要做一次内核调优）
    for (let i = 0; i < 600; i++) {
      const s = await call('/api/status');
      if (s.engine && (s.engine.status === 'ready' || s.engine.status === 'builtin')) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    await call('/api/game/new', {
      mode: 'pve',
      boardSize: 19,
      levelId: '10k',
      humanColor: 'black',
      komi: 7.5,
      ruleSet: 'chinese',
      timeControl: { enabled: true, mainTimeSec: 600, byoYomiSec: 30, byoYomiCount: 3 },
    });
    // 走几步，让棋盘上有点内容
    const moves = [
      [15, 3],
      [3, 15],
      [15, 15],
      [3, 3],
    ];
    for (const [x, y] of moves) {
      await call('/api/game/move', { x, y });
      for (let i = 0; i < 200; i++) {
        const s = await call('/api/status');
        if (!s.aiThinking) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (err) {
    console.warn('[screenshot] 摆棋失败:', err.message);
  }

  // 等界面把状态推完再截
  await new Promise((r) => setTimeout(r, 1500));
  // 顺手把形势判断打开，截出来的图更有代表性
  try {
    await mainWindow.webContents.executeJavaScript("document.getElementById('eval-toggle').click()");
    await new Promise((r) => setTimeout(r, 5000));
  } catch {
    /* 界面没准备好就算了 */
  }
  // 清掉鼠标悬停造成的半透明棋子，不然截出来像多了一颗子
  try {
    await mainWindow.webContents.executeJavaScript('window.__clearHover && window.__clearHover()');
    await new Promise((r) => setTimeout(r, 300));
  } catch {
    /* 界面还没准备好就跳过 */
  }
  const image = await mainWindow.webContents.capturePage();
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, image.toPNG());
  console.log(`[screenshot] 已保存: ${shotPath}`);
  await backend.shutdown();
  app.exit(0);
}

async function createWindow() {
  backend = await startServer({ port: 0, quiet: true });

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 1000,
    minHeight: 720,
    backgroundColor: '#12151a',
    title: '围棋对战',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // 截图时必须真正显示窗口：隐藏窗口时 Chromium 不会重绘，
    // capturePage() 拿到的会是旧画面
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 界面里的外链一律丢给系统浏览器，不要在这个窗口里开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(backend.url);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  if (shotPath) await captureAndExit(backend.url);
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error('启动失败:', err);
    dialog.showErrorBox('启动失败', String(err && err.stack ? err.stack : err));
    app.exit(1);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (!backend) return;
  event.preventDefault();
  const b = backend;
  backend = null;
  await b.shutdown();
  app.exit(0);
});
