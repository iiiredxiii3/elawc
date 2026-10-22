/**
 * سرور TCP آزمایشی که شبیه سرور SmartLaunch رفتار می‌کند (فقط برای تست پل و UI).
 * فرمت پاسخ‌ها قراردادی است و پروتکل واقعی SmartLaunch نیست.
 *   node test/mock-sl-server.js [port]
 */
'use strict';
const net = require('net');

const COMPUTERS = [
  { id: 'PC-01', status: 'busy', user: 'ali_gamer', game: 'Valorant', timeLeft: 3600, zone: 'Pro Arena' },
  { id: 'PC-02', status: 'free', zone: 'Pro Arena' },
  { id: 'VIP-01', status: 'busy', user: 'team_a', game: 'CS2', timeLeft: 7200, zone: 'VIP Bootcamp' },
  { id: 'PS5-01', status: 'offline', zone: 'Console Lounge' }
];

function createMock(port) {
  const log = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.write('SL-MOCK READY\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
        log.push(line);
        if (line === 'LIST') sock.write(JSON.stringify({ computers: COMPUTERS }) + '\r\n');
        else if (line === 'FRAG') { sock.write('AB'); setTimeout(() => sock.write('C\r\n'), 40); }
        else if (line === 'BIN') sock.write(Buffer.from([0x01, 0x02, 0xff, 0x00, 0x10, 0x03, 0x04, 0x05]));
        else if (line === 'KV') sock.write('Computer=2&Status=Busy&User=reza&Time=1800\r\n');
        else if (line === 'DROP') sock.destroy();
        else sock.write('OK ' + line + '\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port, log, server,
      kill() { sockets.forEach(s => s.destroy()); return new Promise(r => server.close(r)); }
    }));
  });
}

module.exports = { createMock, COMPUTERS };

if (require.main === module) {
  const port = parseInt(process.argv[2] || '7831', 10);
  createMock(port).then(() => console.log('mock SL server on 127.0.0.1:' + port + '  (LIST / FRAG / BIN / KV / DROP)'));
}
