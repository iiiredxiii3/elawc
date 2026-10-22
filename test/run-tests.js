/**
 * تست‌های پل (bridge.js) با یک سرور TCP آزمایشی.   اجرا:  npm test
 */
'use strict';
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { createBridge, buildMagicPacket } = require('../bridge');
const { createMock } = require('./mock-sl-server');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const quiet = () => {};

function httpGet(port, path = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

/** کلاینت WS با صف پیام‌ها */
function wsClient(port, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const msgs = []; const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); msgs.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].res(m); waiters.splice(i, 1); }
    });
    const api = {
      ws, msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      wait: (pred, ms = 3000) => new Promise((res, rej) => {
        const hit = msgs.find(pred); if (hit) return res(hit);
        const w = { pred, res }; waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout waiting; got: ' + msgs.map(m => m.type).join(','))); } }, ms);
      }),
      close: () => ws.close()
    };
    ws.on('open', () => resolve(api));
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })));
  });
}

(async () => {
  console.log('SmartLaunch bridge tests');
  const base = 41000 + Math.floor(Math.random() * 1500);
  const mock = await createMock(base);
  const httpMock = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url })); });
  await new Promise(r => httpMock.listen(base + 1, '127.0.0.1', r));

  const bridge = createBridge({ httpPort: base + 2, wsPort: base + 3, slHost: '127.0.0.1', slPort: base, httpBase: `http://127.0.0.1:${base + 1}`, log: quiet, token: 'testtoken123' });
  const info = await bridge.start();
  const origin = `http://127.0.0.1:${base + 2}`;

  await test('HTTP: صفحه با توکن و پورت تزریق‌شده سرو می‌شود', async () => {
    const r = await httpGet(base + 2);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('window.__SL_CONFIG__'), 'config injected');
    assert.ok(r.body.includes('testtoken123'));
    assert.ok(r.body.includes(`"wsPort":${base + 3}`));
  });

  await test('HTTP: /health و 404', async () => {
    assert.strictEqual((await httpGet(base + 2, '/health')).status, 200);
    assert.strictEqual((await httpGet(base + 2, '/nope')).status, 404);
  });

  await test('WS: Origin غیرمجاز رد می‌شود', async () => {
    let err = null;
    try { await wsClient(base + 3, 'http://evil.example.com'); } catch (e) { err = e; }
    assert.ok(err && err.status === 403, 'expected 403, got ' + (err && err.message));
  });

  await test('WS: دستور قبل از HELLO رد می‌شود', async () => {
    const c = await wsClient(base + 3, origin);
    c.send({ type: 'SMARTLAUNCH_CMD', id: 1, command: 'LIST' });
    const m = await c.wait(x => x.type === 'AUTH_REJECTED');
    assert.ok(m.reason);
    c.close();
  });

  await test('WS: توکن اشتباه → AUTH_REJECTED و بستن اتصال', async () => {
    const c = await wsClient(base + 3, origin);
    const closed = new Promise(r => c.ws.on('close', (code) => r(code)));
    c.send({ type: 'HELLO', token: 'wrong', operator: 'mk' });
    await c.wait(x => x.type === 'AUTH_REJECTED');
    assert.strictEqual(await closed, 4003);
  });

  await test('WS: نام کاربری admin رد می‌شود', async () => {
    const c = await wsClient(base + 3, origin);
    c.send({ type: 'HELLO', token: 'testtoken123', operator: 'Admin' });
    const m = await c.wait(x => x.type === 'AUTH_REJECTED');
    assert.ok(/admin/i.test(m.reason));
    c.close();
  });

  const c = await wsClient(base + 3, origin);
  await test('WS: HELLO درست → AUTH_OK و اتصال TCP', async () => {
    c.send({ type: 'HELLO', token: 'testtoken123', operator: 'mk_supervisor' });
    await c.wait(x => x.type === 'AUTH_OK');
    const st = await c.wait(x => x.type === 'BRIDGE_STATUS' && x.tcp === 'connected');
    assert.strictEqual(st.port, base);
    const d = await c.wait(x => x.type === 'SL_DATA' && /SL-MOCK READY/.test(x.text));
    assert.strictEqual(d.binary, false);
  });

  await test('دستور → CMD_ACK و پاسخ JSON به‌صورت SMARTLAUNCH_EVENT', async () => {
    c.send({ type: 'SMARTLAUNCH_CMD', id: 10, command: 'LIST' });
    const ack = await c.wait(x => x.type === 'CMD_ACK' && x.id === 10);
    assert.ok(ack.bytes >= 6);
    const ev = await c.wait(x => x.type === 'SMARTLAUNCH_EVENT' && x.payload.startsWith('{"computers"'));
    assert.strictEqual(JSON.parse(ev.payload).computers.length, 4);
    assert.ok(mock.log.includes('LIST'), 'server received LIST with CRLF-terminated line');
  });

  await test('بافر خط: پاسخ تکه‌تکه یک رویداد می‌شود', async () => {
    c.send({ type: 'SMARTLAUNCH_CMD', id: 11, command: 'FRAG' });
    const ev = await c.wait(x => x.type === 'SMARTLAUNCH_EVENT' && x.payload === 'ABC');
    assert.ok(ev);
  });

  await test('داده‌ی باینری به‌صورت hex گزارش می‌شود', async () => {
    c.send({ type: 'SMARTLAUNCH_CMD', id: 12, command: 'BIN' });
    const d = await c.wait(x => x.type === 'SL_DATA' && x.binary === true);
    assert.strictEqual(d.hex, '010 2ff00100304 05'.replace(/ /g, ''));
  });

  await test('ارسال HEX خام', async () => {
    c.send({ type: 'SMARTLAUNCH_HEX', id: 13, hex: '48 45 4c 50 0d 0a' }); // "HELP\r\n"
    await c.wait(x => x.type === 'CMD_ACK' && x.id === 13);
    await sleep(100);
    assert.ok(mock.log.includes('HELP'));
  });

  await test('WOL: MAC نامعتبر → CMD_NACK', async () => {
    c.send({ type: 'WOL_PACKET', id: 20, mac: 'zz' });
    const m = await c.wait(x => x.type === 'CMD_NACK' && x.id === 20);
    assert.ok(/MAC/.test(m.error));
  });

  await test('WOL: MAC معتبر → CMD_ACK با ۱۰۲ بایت', async () => {
    c.send({ type: 'WOL_PACKET', id: 21, mac: 'AA:BB:CC:DD:EE:FF', broadcast: '127.0.0.1' });
    const m = await c.wait(x => x.type === 'CMD_ACK' && x.id === 21);
    assert.strictEqual(m.bytes, 102);
  });

  await test('ساختار Magic Packet درست است', async () => {
    const p = buildMagicPacket('aa-bb-cc-dd-ee-ff');
    assert.strictEqual(p.length, 102);
    assert.ok(p.subarray(0, 6).every(b => b === 0xff));
    assert.strictEqual(p.subarray(6, 12).toString('hex'), 'aabbccddeeff');
    assert.strictEqual(p.subarray(96, 102).toString('hex'), 'aabbccddeeff');
  });

  await test('پروکسی HTTP → HTTP_RESPONSE', async () => {
    c.send({ type: 'HTTP_REQUEST', id: 30, method: 'GET', path: '/api/computers' });
    const m = await c.wait(x => x.type === 'HTTP_RESPONSE' && x.id === 30);
    assert.strictEqual(m.status, 200);
    assert.strictEqual(JSON.parse(m.body).path, '/api/computers');
  });

  await test('پروکسی HTTP: path بدون / رد می‌شود', async () => {
    c.send({ type: 'HTTP_REQUEST', id: 31, method: 'GET', path: 'http://evil/' });
    const m = await c.wait(x => x.type === 'CMD_NACK' && x.id === 31);
    assert.ok(m.error);
  });

  await test('PING/PONG', async () => {
    c.send({ type: 'PING', t: 5 });
    const m = await c.wait(x => x.type === 'PONG');
    assert.strictEqual(m.t, 5);
  });

  await test('قطع TCP → BRIDGE_STATUS closed، NACK، و اتصال مجدد خودکار', async () => {
    c.msgs.length = 0;
    c.send({ type: 'SMARTLAUNCH_CMD', id: 40, command: 'DROP' });
    await c.wait(x => x.type === 'BRIDGE_STATUS' && x.tcp === 'closed');
    c.send({ type: 'SMARTLAUNCH_CMD', id: 41, command: 'LIST' });
    const nack = await c.wait(x => x.type === 'CMD_NACK' && x.id === 41);
    assert.ok(/TCP/.test(nack.error));
    await c.wait(x => x.type === 'BRIDGE_STATUS' && x.tcp === 'connected', 6000);
  });
  c.close();

  await test('سرور SL خاموش → BRIDGE_ERROR با کد ECONNREFUSED', async () => {
    const b2 = createBridge({ httpPort: base + 4, wsPort: base + 5, slHost: '127.0.0.1', slPort: base + 9, log: quiet, token: 't2' });
    await b2.start();
    const c2 = await wsClient(base + 5, `http://127.0.0.1:${base + 4}`);
    c2.send({ type: 'HELLO', token: 't2', operator: 'op' });
    const e = await c2.wait(x => x.type === 'BRIDGE_ERROR');
    assert.strictEqual(e.code, 'ECONNREFUSED');
    c2.close(); b2.stop();
  });

  await test('BIND_HOST غیر loopback بدون PANEL_PASSWORD خطا می‌دهد', async () => {
    assert.throws(() => createBridge({ bindHost: '0.0.0.0', log: quiet }), /PANEL_PASSWORD/);
  });

  await test('Basic Auth روی صفحه در حالت شبکه', async () => {
    const b3 = createBridge({ bindHost: '127.0.0.1', panelPassword: 'pw', httpPort: base + 6, wsPort: base + 7, log: quiet });
    await b3.start();
    assert.strictEqual((await httpGet(base + 6)).status, 401);
    const ok = await httpGet(base + 6, '/', { Authorization: 'Basic ' + Buffer.from('u:pw').toString('base64') });
    assert.strictEqual(ok.status, 200);
    b3.stop();
  });

  bridge.stop(); await mock.kill(); httpMock.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
