/**
 * Smartlaunch Admin — نسخه‌ی دسکتاپ (Electron)
 * پل و سرور HTTP از bridge.js می‌آید؛ پنجره آدرس http://127.0.0.1:PORT را باز می‌کند
 * تا توکن امنیتی پل به‌صورت خودکار به صفحه تزریق شود.
 */
'use strict';
const { app, BrowserWindow, shell, dialog } = require('electron');
const { createBridge } = require('./bridge');

let bridge = null;
let mainWindow = null;

async function boot() {
  try {
    bridge = createBridge();
    const info = await bridge.start();

    mainWindow = new BrowserWindow({
      width: 1560, height: 920, minWidth: 1024, minHeight: 680,
      title: 'پنل مدیریت اسمارت‌لانچ',
      backgroundColor: '#080c14',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });

    mainWindow.loadURL(info.url);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(info.url)) e.preventDefault();
    });
  } catch (e) {
    dialog.showErrorBox('خطا در راه‌اندازی پنل', e.message);
    app.quit();
  }
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (bridge) bridge.stop();
  app.quit();
});
