/**
 * devtools/cdp-check.mjs —— 升级后的一键体检（只读：GET /history、GET /userdata、DOM 检查）
 *
 * 用法：node devtools/cdp-check.mjs  （需先起 headless Edge --remote-debugging-port=9223）
 * 前提：ComfyUI 在 127.0.0.1:8188 运行中。不发任何写请求、不点任何保存按钮。
 */

import fs from 'node:fs';
import os from 'node:os';

const PORT = 9223;
const OUT = `${os.tmpdir()}/upgrade-check.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8188/' });
  await sleep(12000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  };

  // 1) 面板注册与 DOM
  const dom = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button, [role=button]')].find(e => /Prompt Library/i.test((e.getAttribute('aria-label')||e.title||'')));
    if (!btn) return { found: false };
    btn.click();
    return { found: true, label: btn.getAttribute('aria-label') || btn.title };
  })()`);
  console.log('侧边栏按钮:', JSON.stringify(dom));

  await sleep(1500);
  const panel = await evalJs(`(() => {
    const title = document.querySelector('.pp-title')?.textContent;
    const seg = [...document.querySelectorAll('.pp-seg-btn')].map(b => b.textContent);
    const foot = document.querySelector('.pp-foot')?.textContent;
    const audit = window.__promptProbe?.auditLayout ? window.__promptProbe.auditLayout() : null;
    return { title, seg, foot, auditOk: audit ? audit.ok : 'no-audit', overlaps: audit ? audit.overlaps.length : -1 };
  })()`);
  console.log('面板状态:', JSON.stringify(panel));

  // 2) 收藏库读取（真实 /userdata GET，只读）
  const lib = await evalJs(`fetch('/userdata/prompt_library%2Flibrary.json').then(r => ({ status: r.status, len: r.headers.get('content-length') }))`);
  console.log('收藏库 GET:', JSON.stringify(lib));

  // 3) /history 接口（画师串功能将用它选出图）
  const hist = await evalJs(`fetch('/history?max_items=5').then(async r => {
    const j = await r.json();
    const ids = Object.keys(j);
    let imgs = 0;
    for (const id of ids) for (const o of (j[id].outputs||{}).values?.() || []) imgs += (o.images||[]).length;
    return { status: r.status, prompts: ids.length, sampleImages: imgs };
  })`);
  console.log('/history:', JSON.stringify(hist));

  // 4) /view 接口（显示图片用）
  const view = await evalJs(`fetch('/history?max_items=1').then(async r => {
    const j = await r.json();
    for (const id of Object.keys(j)) {
      for (const o of (j[id].outputs||{}).values?.() || []) {
        for (const im of (o.images||[])) {
          if (im.type !== 'output') continue;
          const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder||'', type: 'output' });
          const v = await fetch('/view?' + q);
          return { status: v.status, type: v.headers.get('content-type'), bytes: (await v.arrayBuffer()).byteLength };
        }
      }
    }
    return { status: 'no-image' };
  })`);
  console.log('/view:', JSON.stringify(view));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
