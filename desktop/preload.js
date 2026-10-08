'use strict';

/**
 * 预加载脚本。
 * 界面本身是通过 HTTP 和后端说话的，这里暂时不需要额外暴露能力，
 * 只留给以后要用系统能力（打印、文件对话框等）时扩展。
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
});
