/**
 * bridge.js — پل مشترک بین پنل وب و سرور SmartLaunch
 * ---------------------------------------------------
 * هم standalone-server.js و هم main.js (Electron) از همین ماژول استفاده می‌کنند.
 *
 *  - سرو index.html روی HTTP (با تزریق توکن امنیتی پل)
 *  - پل WebSocket → TCP (پورت SmartLaunch، پیش‌فرض 7831)
 *  - ارسال هر دستور با شناسه (id) و برگرداندن CMD_ACK / CMD_NACK
 *  - دریافت داده‌ی خام TCP (متن + hex) تا بشود پروتکل واقعی را کشف کرد
 *  - Wake-on-LAN واقعی (UDP)
 *  - پروکسی HTTP برای تست API های REST/XML سرور (SL_HTTP_BASE)
 *  - اتصال مجدد خودکار TCP
 *
 * امنیت:
 *  - به‌صورت پیش‌فرض فقط روی 127.0.0.1 گوش می‌دهد
 *  - بررسی Origin (جلوگیری از سوءاستفاده‌ی وب‌سایت‌های دیگر از مرورگر اپراتور)
 *  - پیام اول هر اتصال باید HELLO با توکن تصادفی باشد
 *  - اگر BIND_HOST غیر از loopback باشد، PANEL_PASSWORD (Basic Auth) اجباری است
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const WebSocket = require('ws');

const BRIDGE_VERSION = '5.0.0';
const MAX_HTTP_BODY = 200 * 1024;

function envInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function unescapeEol(s) {
  return String(s).replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\0/g, '\0');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function looksBinary(buf) {
  if (!buf.length) return false;
  let bad = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) bad++;
  }
  return bad / n > 0.15;
}

function buildMagicPacket(mac) {
  const clean = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length !== 12) throw new Error('MAC نامعتبر است (باید ۱۲ رقم هگز باشد)');
  const macBuf = Buffer.from(clean, 'hex');
  const pkt = Buffer.alloc(102);
  pkt.fill(0xff, 0, 6);
  for (let i = 6; i < 102; i += 6) macBuf.copy(pkt, i);
  return pkt;
}

function sendWol(mac, broadcast) {
  return new Promise((resolve, reject) => {
    let pkt;
    try { pkt = buildMagicPacket(mac); } catch (e) { return reject(e); }
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => { try { sock.close(); } catch (_) {} reject(e); });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (_) {}
      sock.send(pkt, 0, pkt.length, 9, broadcast || '255.255.255.255', (err) => {
        try { sock.close(); } catch (_) {}
        err ? reject(err) : resolve(pkt.length);
      });
    });
  });
}


function loadConfigFile(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.SL_CONFIG) candidates.push(process.env.SL_CONFIG);
  candidates.push(path.join(process.cwd(), 'smartlaunch.config.json'));
  try { candidates.push(path.join(path.dirname(process.execPath), 'smartlaunch.config.json')); } catch (_) {}
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return Object.assign({ _path: c }, JSON.parse(fs.readFileSync(c, 'utf8')));
    } catch (e) { throw new Error(`فایل پیکربندی ${c} نامعتبر است: ${e.message}`); }
  }
  return {};
}

function createBridge(options = {}) {
  const env = process.env;
  const file = loadConfigFile(options.configPath);
  const cfg = {
    httpPort: envInt(options.httpPort ?? env.HTTP_PORT ?? file.httpPort, 3080),
    wsPort: envInt(options.wsPort ?? env.WS_PORT ?? file.wsPort, 8080),
    bindHost: options.bindHost || env.BIND_HOST || file.bindHost || '127.0.0.1',
    slHost: options.slHost || env.SMARTLAUNCH_HOST || file.slHost || '127.0.0.1',
    slPort: envInt(options.slPort ?? env.SMARTLAUNCH_PORT ?? file.slPort, 7831),
    eol: unescapeEol(options.eol ?? env.SL_EOL ?? file.eol ?? '\\r\\n'),
    httpBase: options.httpBase || env.SL_HTTP_BASE || file.httpBase || '',
    panelPassword: options.panelPassword || env.PANEL_PASSWORD || file.panelPassword || '',
    token: options.token || env.BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex'),
    htmlPath: options.htmlPath || path.join(__dirname, 'index.html'),
    logFile: options.logFile || env.LOG_FILE || file.logFile || '',
    reconnectMs: envInt(env.SL_RECONNECT_MS ?? file.reconnectMs, 3000),
    configPath: file._path || ''
  };

  const log = options.log || ((...a) => console.log(...a));
  function out(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    log(line);
    if (cfg.logFile) { try { fs.appendFileSync(cfg.logFile, line + '\n'); } catch (_) {} }
  }

  if (!isLoopback(cfg.bindHost) && !cfg.panelPassword) {
    throw new Error('BIND_HOST غیر از 127.0.0.1 است؛ برای امنیت باید PANEL_PASSWORD هم تنظیم شود.');
  }

  let httpServer = null;
  let wss = null;
  const clients = new Set();

  function allowedOrigins() {
    const hosts = new Set(['127.0.0.1', 'localhost', cfg.bindHost]);
    const set = new Set();
    hosts.forEach(h => set.add(`http://${h}:${cfg.httpPort}`));
    return set;
  }

  // ---------- HTTP: سرو پنل ----------
  function checkBasicAuth(req) {
    if (!cfg.panelPassword) return true;
    const h = req.headers['authorization'] || '';
    if (!h.startsWith('Basic ')) return false;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return safeEqual(pass, cfg.panelPassword);
  }

  function renderHtml() {
    const html = fs.readFileSync(cfg.htmlPath, 'utf8');
    const conf = {
      wsPort: cfg.wsPort,
      token: cfg.token,
      bridgeVersion: BRIDGE_VERSION,
      slHost: cfg.slHost,
      slPort: cfg.slPort,
      httpProxy: !!cfg.httpBase
    };
    const inject = `<script>window.__SL_CONFIG__=${JSON.stringify(conf)};</script>`;
    return html.includes('<head>') ? html.replace('<head>', '<head>' + inject) : inject + html;
  }

  function onHttp(req, res) {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SmartLaunch Panel"' });
      return res.end('Unauthorized');
    }
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      try {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        return res.end(renderHtml());
      } catch (e) {
        out('ERROR', 'خواندن index.html ناموفق: ' + e.message);
        res.writeHead(500); return res.end('index.html not found');
      }
    }
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: BRIDGE_VERSION, clients: clients.size }));
    }
    res.writeHead(404); res.end('Not found');
  }

  // ---------- پروکسی HTTP به سرور ----------
  function proxyHttp(msg, reply) {
    if (!cfg.httpBase) return reply({ type: 'CMD_NACK', id: msg.id, error: 'SL_HTTP_BASE تنظیم نشده است' });
    const method = String(msg.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return reply({ type: 'CMD_NACK', id: msg.id, error: 'متد مجاز نیست' });
    const p = String(msg.path || '/');
    if (!p.startsWith('/')) return reply({ type: 'CMD_NACK', id: msg.id, error: 'path باید با / شروع شود' });

    let target;
    try { target = new URL(cfg.httpBase.replace(/\/+$/, '') + p); } catch (e) {
      return reply({ type: 'CMD_NACK', id: msg.id, error: 'آدرس نامعتبر: ' + e.message });
    }
    const body = msg.body ? String(msg.body) : '';
    const headers = Object.assign({}, msg.headers || {});
    if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const r = http.request({
      hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search,
      method, headers, timeout: 8000
    }, (resp) => {
      const chunks = []; let size = 0;
      resp.on('data', (c) => { size += c.length; if (size <= MAX_HTTP_BODY) chunks.push(c); });
      resp.on('end', () => reply({
        type: 'HTTP_RESPONSE', id: msg.id, status: resp.statusCode,
        contentType: resp.headers['content-type'] || '',
        truncated: size > MAX_HTTP_BODY,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => reply({ type: 'CMD_NACK', id: msg.id, error: 'HTTP: ' + e.message }));
    if (body) r.write(body);
    r.end();
  }

  // ---------- WebSocket ----------
  function onConnection(ws, req) {
    const peer = (req.socket && req.socket.remoteAddress) || '?';
    const state = { authed: false, operator: '', tcp: null, tcpStatus: 'idle', lineBuf: '', retryTimer: null, closed: false };
    clients.add(ws);
    out('INFO', `WS client connected from ${peer}`);

    const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

    const helloTimer = setTimeout(() => {
      if (!state.authed) { send({ type: 'AUTH_REJECTED', reason: 'HELLO timeout' }); ws.close(4001, 'hello timeout'); }
    }, 5000);

    function setTcpStatus(status, extra) {
      state.tcpStatus = status;
      send(Object.assign({ type: 'BRIDGE_STATUS', tcp: status, connected: status === 'connected',
        host: cfg.slHost, port: cfg.slPort, version: BRIDGE_VERSION, operator: state.operator }, extra || {}));
    }

    function connectTcp() {
      if (state.closed) return;
      if (state.tcp) { try { state.tcp.destroy(); } catch (_) {} }
      const sock = new net.Socket();
      state.tcp = sock;
      state.lineBuf = '';
      sock.setKeepAlive(true, 10000);
      sock.setNoDelay(true);
      setTcpStatus('connecting');

      sock.connect(cfg.slPort, cfg.slHost, () => {
        out('INFO', `TCP connected ${cfg.slHost}:${cfg.slPort}`);
        setTcpStatus('connected');
      });

      sock.on('data', (buf) => {
        const binary = looksBinary(buf);
        send({
          type: 'SL_DATA', bytes: buf.length, binary,
          text: binary ? '' : buf.toString('utf8'),
          hex: buf.subarray(0, 4096).toString('hex'),
          truncated: buf.length > 4096
        });
        if (!binary) {
          state.lineBuf += buf.toString('utf8');
          let idx;
          while ((idx = state.lineBuf.search(/\r?\n/)) >= 0) {
            const line = state.lineBuf.slice(0, idx);
            state.lineBuf = state.lineBuf.slice(state.lineBuf[idx] === '\r' ? idx + 2 : idx + 1);
            if (line.trim()) send({ type: 'SMARTLAUNCH_EVENT', payload: line });
          }
          if (state.lineBuf.length > 65536) state.lineBuf = '';
        }
      });

      sock.on('error', (err) => {
        out('WARN', `TCP error: ${err.code || ''} ${err.message}`);
        send({ type: 'BRIDGE_ERROR', code: err.code || '', error: err.message, host: cfg.slHost, port: cfg.slPort });
      });

      sock.on('close', () => {
        if (state.tcp !== sock) return;
        if (state.closed) return;
        setTcpStatus('closed');
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(connectTcp, cfg.reconnectMs);
      });
    }

    function tcpWrite(buf, id) {
      if (!state.tcp || state.tcpStatus !== 'connected' || state.tcp.destroyed) {
        return send({ type: 'CMD_NACK', id, error: `اتصال TCP به ${cfg.slHost}:${cfg.slPort} برقرار نیست` });
      }
      state.tcp.write(buf, (err) => {
        if (err) send({ type: 'CMD_NACK', id, error: err.message });
        else send({ type: 'CMD_ACK', id, bytes: buf.length });
      });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) {
        return send({ type: 'BRIDGE_ERROR', error: 'JSON نامعتبر از کلاینت' });
      }

      if (msg.type === 'PING') return send({ type: 'PONG', t: msg.t });

      if (!state.authed) {
        if (msg.type !== 'HELLO') return send({ type: 'AUTH_REJECTED', reason: 'ابتدا HELLO لازم است' });
        const op = String(msg.operator || '').trim();
        if (!safeEqual(msg.token || '', cfg.token)) {
          out('WARN', 'HELLO با توکن نامعتبر');
          send({ type: 'AUTH_REJECTED', reason: 'توکن پل نامعتبر است (صفحه را از آدرس سرور باز کنید)' });
          return ws.close(4003, 'bad token');
        }
        if (!op || ['admin', 'administrator'].includes(op.toLowerCase())) {
          send({ type: 'AUTH_REJECTED', reason: 'نام کاربری پیش‌فرض admin غیرفعال است.' });
          return;
        }
        state.authed = true; state.operator = op;
        clearTimeout(helloTimer);
        out('INFO', `operator "${op}" authenticated`);
        send({ type: 'AUTH_OK', operator: op, version: BRIDGE_VERSION, slHost: cfg.slHost, slPort: cfg.slPort, eol: JSON.stringify(cfg.eol), httpProxy: !!cfg.httpBase });
        connectTcp();
        return;
      }

      switch (msg.type) {
        case 'SMARTLAUNCH_CMD': {
          if (typeof msg.command !== 'string' || !msg.command) return send({ type: 'CMD_NACK', id: msg.id, error: 'command خالی است' });
          const eol = typeof msg.eol === 'string' ? unescapeEol(msg.eol) : cfg.eol;
          out('TX', msg.command);
          return tcpWrite(Buffer.from(msg.command + eol, 'utf8'), msg.id);
        }
        case 'SMARTLAUNCH_HEX': {
          const hex = String(msg.hex || '').replace(/[^0-9a-fA-F]/g, '');
          if (!hex || hex.length % 2) return send({ type: 'CMD_NACK', id: msg.id, error: 'hex نامعتبر' });
          out('TX', 'hex:' + hex.slice(0, 80));
          return tcpWrite(Buffer.from(hex, 'hex'), msg.id);
        }
        case 'WOL_PACKET': {
          return sendWol(msg.mac, msg.broadcast)
            .then((n) => { out('INFO', `WOL → ${msg.mac}`); send({ type: 'CMD_ACK', id: msg.id, bytes: n, wol: true }); })
            .catch((e) => send({ type: 'CMD_NACK', id: msg.id, error: 'WOL: ' + e.message }));
        }
        case 'HTTP_REQUEST':
          out('TX', `HTTP ${msg.method || 'GET'} ${msg.path}`);
          return proxyHttp(msg, send);
        case 'TCP_RECONNECT':
          clearTimeout(state.retryTimer); connectTcp(); return;
        default:
          return send({ type: 'BRIDGE_ERROR', error: 'نوع پیام ناشناخته: ' + msg.type });
      }
    });

    ws.on('close', () => {
      state.closed = true;
      clearTimeout(helloTimer); clearTimeout(state.retryTimer);
      if (state.tcp) { try { state.tcp.destroy(); } catch (_) {} }
      clients.delete(ws);
      out('INFO', `WS client closed (${peer})`);
    });
    ws.on('error', (e) => out('WARN', 'WS error: ' + e.message));
  }

  function start() {
    return new Promise((resolve, reject) => {
      httpServer = http.createServer(onHttp);
      httpServer.once('error', (e) => {
        reject(new Error(e.code === 'EADDRINUSE'
          ? `پورت HTTP ${cfg.httpPort} اشغال است (نمونه‌ی دیگری از برنامه باز است؟)`
          : e.message));
      });
      httpServer.listen(cfg.httpPort, cfg.bindHost, () => {
        const origins = allowedOrigins();
        wss = new WebSocket.Server({
          host: cfg.bindHost, port: cfg.wsPort, maxPayload: 256 * 1024,
          verifyClient: (info, cb) => {
            const origin = info.origin || info.req.headers.origin || '';
            if (origins.has(origin)) return cb(true);
            if (!isLoopback(cfg.bindHost)) {
              // حالت شبکه: صفحه با Basic Auth محافظت شده؛ فقط پورت را چک می‌کنیم
              try { if (new URL(origin).port === String(cfg.httpPort)) return cb(true); } catch (_) {}
            }
            out('WARN', `WS با Origin غیرمجاز رد شد: "${origin}"`);
            cb(false, 403, 'Forbidden origin');
          }
        });
        wss.once('error', (e) => {
          reject(new Error(e.code === 'EADDRINUSE'
            ? `پورت WebSocket ${cfg.wsPort} اشغال است (WS_PORT را عوض کنید)`
            : e.message));
        });
        wss.once('listening', () => {
          wss.on('connection', onConnection);
          const url = `http://${cfg.bindHost === '0.0.0.0' ? '127.0.0.1' : cfg.bindHost}:${cfg.httpPort}`;
          if (cfg.configPath) out('INFO', `Config: ${cfg.configPath}`);
          out('INFO', `Panel : ${url}`);
          out('INFO', `WS    : ws://${cfg.bindHost}:${cfg.wsPort}`);
          out('INFO', `SL TCP: ${cfg.slHost}:${cfg.slPort}  (EOL=${JSON.stringify(cfg.eol)})`);
          if (cfg.httpBase) out('INFO', `SL HTTP proxy base: ${cfg.httpBase}`);
          resolve({ url, wsPort: cfg.wsPort, token: cfg.token, config: cfg });
        });
      });
    });
  }

  function stop() {
    clients.forEach((c) => { try { c.close(); } catch (_) {} });
    if (wss) { try { wss.close(); } catch (_) {} }
    if (httpServer) { try { httpServer.close(); } catch (_) {} }
  }

  return { start, stop, cfg };
}

module.exports = { createBridge, buildMagicPacket, BRIDGE_VERSION };
