/**
 * Smartlaunch Lightweight Single-EXE Server + Auto-Browser Launcher
 * -----------------------------------------------------------------
 * این فایل در صورتی که بخواهید یک فایل EXE بسیار کم‌حجم (حدود ۳۵ مگابایت) داشته باشید
 * هم پنل وب را روی پورت 3000 سرو می‌کند، هم پل TCP 7831 را روی پورت 8080 بالا می‌آورد،
 * و هم به صورت خودکار مرورگر ویندوز را باز می‌کند.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { exec } = require('child_process');
const WebSocket = require('ws');

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3080', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '8080', 10);
const SMARTLAUNCH_HOST = process.env.SMARTLAUNCH_HOST || '127.0.0.1';
const SMARTLAUNCH_PORT = parseInt(process.env.SMARTLAUNCH_PORT || '7831', 10);
const ALLOWED_OPERATOR = process.env.SL_ADMIN_USER || 'mk_supervisor';

// 1. سرو کردن فایل index.html از داخل باینری EXE
const htmlPath = path.join(__dirname, 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlContent);
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${HTTP_PORT}`;
  console.log('==========================================================');
  console.log(' Smartlaunch Pro Admin Panel (Single-File EXE) is RUNNING ');
  console.log(` Web UI Address      : ${url}`);
  console.log(` WebSocket Bridge    : ws://127.0.0.1:${WS_PORT}`);
  console.log(` Smartlaunch TCP API : ${SMARTLAUNCH_HOST}:${SMARTLAUNCH_PORT}`);
  console.log('==========================================================');

  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  }
});

// 2. راه‌اندازی پل WebSocket به TCP 7831
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
  const tcpClient = new net.Socket();

  tcpClient.connect(SMARTLAUNCH_PORT, SMARTLAUNCH_HOST, () => {
    ws.send(JSON.stringify({ type: 'BRIDGE_STATUS', connected: true, operator: ALLOWED_OPERATOR }));
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
        ws.send(JSON.stringify({ type: 'AUTH_REJECTED', reason: 'Default admin username is disabled.' }));
        return;
      }
      if (parsed.type === 'SMARTLAUNCH_CMD' && parsed.command) {
        tcpClient.write(parsed.command + '\r\n');
      }
    } catch (e) {}
  });

  ws.on('close', () => tcpClient.destroy());
});
