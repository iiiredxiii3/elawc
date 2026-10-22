/**
 * Smartlaunch Admin — نسخه‌ی سبک (Node.js / pkg EXE)
 * پنل وب را روی HTTP (پیش‌فرض 3080) سرو می‌کند و پل WebSocket → TCP 7831 را بالا می‌آورد.
 * همه‌ی منطق در bridge.js است.
 *
 * متغیرهای محیطی (اختیاری):
 *   HTTP_PORT=3080  WS_PORT=8080  SMARTLAUNCH_HOST=127.0.0.1  SMARTLAUNCH_PORT=7831
 *   SL_EOL="\r\n"   SL_HTTP_BASE=http://127.0.0.1:XXXX   LOG_FILE=bridge.log
 *   BIND_HOST=127.0.0.1   (اگر غیر loopback بگذارید PANEL_PASSWORD اجباری است)
 */
'use strict';
const { exec } = require('child_process');
const { createBridge } = require('./bridge');

let bridge;
try {
  bridge = createBridge();
} catch (e) {
  console.error('[خطای پیکربندی]', e.message);
  process.exit(1);
}

bridge.start().then((info) => {
  console.log('==========================================================');
  console.log(' Smartlaunch Admin Panel is RUNNING');
  console.log(` Web UI : ${info.url}`);
  console.log(' (از همین آدرس باز کنید؛ فایل index.html را مستقیم باز نکنید)');
  console.log('==========================================================');
  if (process.platform === 'win32' && !process.env.NO_BROWSER) {
    exec(`start "" "${info.url}"`);
  }
}).catch((e) => {
  console.error('[خطا در راه‌اندازی]', e.message);
  process.exit(1);
});

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
