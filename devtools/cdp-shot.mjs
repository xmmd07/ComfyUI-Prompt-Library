/**
 * devtools/cdp-shot.mjs —— 用本机已装的 Edge/Chrome（headless）渲染页面、跑 JS、出截图
 *
 * 为什么需要它：Hermes 的浏览器工具在本机不可用，而"窄侧边栏排版"必须看真实渲染结果。
 * 这里只用 Node 内置的 fetch + WebSocket 直连 CDP，零依赖、不安装任何东西。
 *
 * 用法：
 *   node devtools/cdp-shot.mjs <url> <输出png> [--width 360] [--height 900] [--scale 2] [--wait 2500] \
 *        [--eval "js表达式"] [--eval "另一个表达式"] ...
 *
 * 前提：已有一个开启远程调试的 Edge/Chrome 在 9222 端口，例如：
 *   msedge.exe --headless=new --disable-gpu --no-first-run --remote-debugging-port=9222 --user-data-dir=<临时目录> about:blank
 *   （devtools/serve.mjs 也要在跑，验证台页面才能打开）
 */

import fs from 'node:fs';

const argv = process.argv.slice(2);
const url = argv[0];
const outFile = argv[1];
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const all = (name) => argv.reduce((acc, v, i) => (v === name && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);
const WIDTH = Number(flag('--width', 360));
const HEIGHT = Number(flag('--height', 900));
const SCALE = Number(flag('--scale', 2));
const WAIT = Number(flag('--wait', 2500));
const EVALS = all('--eval');
const PORT = Number(flag('--port', 9222));

if (!url || !outFile) {
  console.error('用法: node devtools/cdp-shot.mjs <url> <输出png> [--width N] [--eval "js"]...');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`连不上 CDP（127.0.0.1:${PORT}），请先启动 headless Edge/Chrome`);
}

async function main() {
  const target = await pickTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
  await send('Page.navigate', { url });
  await sleep(WAIT);

  for (const expr of EVALS) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r?.result?.value;
    console.log(`--- eval: ${expr.slice(0, 70)}${expr.length > 70 ? '…' : ''}`);
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
  }
  await sleep(400);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log(`--- 截图已保存: ${outFile}`);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
