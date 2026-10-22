/**
 * Smartlaunch Pro Admin Desktop + Built-in TCP Bridge (Single-File EXE)
 * ----------------------------------------------------------------------
 * این فایل هم سرور پل ارتباطی WebSocket <-> TCP 7831 را در پس‌زمینه اجرا می‌کند
 * و هم پنجره دسکتاپ پنل مدیریت را بدون نیاز به مرورگر یا نصب Node.js باز می‌کند.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

const SMARTLAUNCH_HOST = process.env.SMARTLAUNCH_HOST || '127.0.0.1';
const SMARTLAUNCH_PORT = parseInt(process.env.SMARTLAUNCH_PORT || '7831', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '8080', 10);
const ALLOWED_OPERATOR = process.env.SL_ADMIN_USER || 'mk_supervisor';

let wss = null;
let mainWindow = null;

function startInternalBridge() {
  try {
    wss = new WebSocket.Server({ port: WS_PORT });
    console.log(`[Smartlaunch Bridge] Listening on ws://127.0.0.1:${WS_PORT}`);

    wss.on('connection', (ws) => {
      const tcpClient = new net.Socket();

      tcpClient.connect(SMARTLAUNCH_PORT, SMARTLAUNCH_HOST, () => {
        ws.send(JSON.stringify({
          type: 'BRIDGE_STATUS',
          connected: true,
          operator: ALLOWED_OPERATOR
        }));
      });

      tcpClient.on('data', (data) => {
        const rawResponse = data.toString('utf8').trim();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'SMARTLAUNCH_EVENT', payload: rawResponse }));
        }
      });

      tcpClient.on('error', (err) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'BRIDGE_ERROR', error: err.message }));
        }
      });

      ws.on('message', (message) => {
        try {
          const parsed = JSON.parse(message.toString());
          if (!parsed.operator || parsed.operator.toLowerCase() === 'admin') {
            ws.send(JSON.stringify({
              type: 'AUTH_REJECTED',
              reason: 'Default admin username is disabled.'
            }));
            return;
          }
          if (parsed.type === 'SMARTLAUNCH_CMD' && parsed.command) {
            tcpClient.write(parsed.command + '\r\n');
          }
        } catch (e) {
          console.error('[Bridge Parse Error]', e.message);
        }
      });

      ws.on('close', () => tcpClient.destroy());
    });

    wss.on('error', (err) => {
      console.warn('[Bridge Port Busy or Warning]:', err.message);
    });
  } catch (err) {
    console.error('[Failed to start internal bridge]:', err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'پنل مدیریت اسمارت‌لانچ — نسخه دسکتاپ',
    backgroundColor: '#080c14',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  startInternalBridge();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (wss) wss.close();
  if (process.platform !== 'darwin') app.quit();
});
