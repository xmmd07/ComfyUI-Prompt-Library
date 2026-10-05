/**
 * devtools/serve.mjs —— 本地验证台服务器（仅开发验证用，绝不参与 ComfyUI 运行）
 *
 * 提供三个路由：
 *   /                 → devtools/harness.html
 *   /web/*  /devtools/*  → 插件目录内的静态文件（只读）
 *   /wf/<name>        → 只读转发 ComfyUI 用户目录里的工作流 JSON
 *   /object_info      → 服务端转发到运行中的 ComfyUI（绕开浏览器跨域限制）
 *
 * 只读：不写入任何文件、不向 ComfyUI 提交任何任务。
 * 用法：node devtools/serve.mjs   （Ctrl+C 结束；用完请关掉）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WF_DIR = path.resolve(process.env.WF_DIR || 'D:/APPs/comfyUI/ComfyUI-aki-v3/ComfyUI/user/default/workflows');
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const PORT = Number(process.env.PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveFile(res, abs) {
  if (!abs.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.readFile(abs, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(HERE, 'harness.html'));

    if (p === '/object_info') {
      const r = await fetch(`${COMFY}/object_info`);
      const text = await r.text();
      return send(res, r.status, text, 'application/json; charset=utf-8');
    }

    if (p.startsWith('/wf/')) {
      const name = p.slice(4);
      const abs = path.resolve(WF_DIR, name);
      // 只允许读取工作流目录内的文件（防路径穿越），并只读
      if (!abs.startsWith(WF_DIR)) return send(res, 403, 'forbidden');
      return fs.readFile(abs, (err, buf) => {
        if (err) return send(res, 404, 'not found');
        send(res, 200, buf, 'application/json; charset=utf-8');
      });
    }

    return serveFile(res, path.join(ROOT, p.replace(/^\/+/, '')));
  } catch (e) {
    send(res, 500, String(e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[harness] http://127.0.0.1:${PORT}/  （工作流目录：${WF_DIR}）`);
});
