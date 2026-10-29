/**
 * selftest_artists.mjs —— 自测④：画师串功能（全部在内存里，不联网、不碰真实数据）
 *
 * 覆盖：
 *   A. 数据模型：normalize/merge/validate
 *   B. /history 摊平与分页 URL
 *   C. 存储层（假 /userdata）：artists.json 读写、备份、损坏拒写、图片二进制写/删
 *   D. 面板集成：第三个页签、添加（含选图）、列表渲染（串=标题）、编辑、删除二次确认、
 *      图片副本经 fetch→blob→objectURL 显示（blob/objectURL 用 Node 真实实现）
 *   E. 回归：探针/收藏两页仍正常
 */

import { installMinidom } from './minidom.mjs';
// 界面文案固定中文：保持与改造前断言口径一致；英文/切换/回退由 selftest_i18n.mjs 覆盖
import { setLocaleForTest } from '../probe/i18n.mjs';
setLocaleForTest('zh');

const minidom = installMinidom();
const restore = () => minidom.restore();
const dom = globalThis.document;

/* ---------- Node 18+ 有 Blob/URL.createObjectURL? createObjectURL 需要垫 ---------- */
if (typeof URL.createObjectURL !== 'function') {
  const objs = new Map();
  let seq = 0;
  URL.createObjectURL = (blob) => { const u = `blob:fake-${++seq}`; objs.set(u, blob); return u; };
  URL.revokeObjectURL = (u) => { objs.delete(u); };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✔ PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✘ FAIL  ${name}${extra ? '  —  ' + extra : ''}`); }
}
function head(t) { console.log(`\n${t}\n${'='.repeat(78)}`); }
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

/* ---------- blob 数值读法（Node Blob → Uint8Array） ---------- */
const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

/* ---------- 假 api：内存版 /userdata + /history + /view ---------- */
function makeFakeApi() {
  const files = new Map();   // path -> string | Uint8Array
  const history = [];        // [{prompt_id, images:[{filename,subfolder,type}]}]

  const viewPng = (name) => {
    // 1x1 PNG（真实字节），canvas 垫片会把它"放大"读尺寸
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };

  return {
    files,
    history,
    async fetchApi(url, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();

      // /models/{folder}（画师串选模型用 diffusion_models；实测纯字符串数组）
      const mm = /^\/models\/(.+)$/.exec(url);
      if (mm) {
        const folder = decodeURIComponent(mm[1]);
        const lists = {
          diffusion_models: [
            'Krea2_Turbo_convrot_int8mixed.safetensors', 'anima-base-v1.0.safetensors',
            'anima-furry-v1.0.safetensors', 'flux3_image_klein_sd_int8_convrot.safetensors',
            'miaomiaoHarem_29BBETA11_fp16.safetensors', 'moss_image_sft_int8_convrot.safetensors',
            'qwen_image_2.1_int8_convrot.safetensors', 'seedvr2_7b_int8_convrot.safetensors'
          ],
          loras: []
        };
        return { ok: true, status: 200, async json() { return (lists[folder] || []).slice(); } };
      }

      // /history
      if (url.startsWith('/history')) {
        const q = new URLSearchParams(url.split('?')[1] || '');
        const max = Number(q.get('max_items') || 64);
        const offset = Number(q.get('offset') || 0);
        const page = history.slice(offset, offset + max);
        const j = {};
        for (const rec of page) j[rec.prompt_id] = { outputs: { n: { images: rec.images } } };
        return { ok: true, status: 200, async json() { return j; } };
      }

      // /view
      if (url.startsWith('/view')) {
        const q = new URLSearchParams(url.split('?')[1] || '');
        const fname = q.get('filename') || '';
        const found = history.some((r) => r.images.some((im) => im.filename === fname));
        if (!found) return { ok: false, status: 404, async text() { return 'nf'; } };
        const body = viewPng(fname);
        return { ok: true, status: 200, headers: { get: () => 'image/png' }, async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); } };
      }

      // /userdata 列目录
      if (url.startsWith('/userdata?')) {
        const q = new URLSearchParams(url.split('?')[1] || '');
        const dir = q.get('dir') || '';
        const names = [...files.keys()].filter((k) => k.startsWith(dir + '/'));
        return { ok: true, status: 200, async json() { return names.map((path) => ({ path, size: 1, type: 'file' })); } };
      }

      // /userdata/{file}（?v= 版本参数需剥掉）
      const m = /^\/userdata\/(.+?)(?:\?v=[0-9]+)?$/.exec(url);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (method === 'GET') {
          if (!files.has(key)) return { ok: false, status: 404, async text() { return 'nf'; } };
          const v = files.get(key);
          const ab = () => (typeof v === 'string')
            ? new TextEncoder().encode(v).buffer
            : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
          return { ok: true, status: 200, async text() { return typeof v === 'string' ? v : '[bin]'; }, async arrayBuffer() { return ab(); } };
        }
        if (method === 'POST') {
          let v = opts.body;
          if (typeof v === 'string') { /* keep */ }
          else if (v instanceof Uint8Array) { /* keep */ }
          else if (v && v.arrayBuffer) { v = new Uint8Array(await v.arrayBuffer()); }
          files.set(key, v);
          return { ok: true, status: 200, async json() { return { path: key }; }, async text() { return ''; } };
        }
        if (method === 'DELETE') {
          const had = files.delete(key);
          return { ok: true, status: had ? 200 : 404, async text() { return ''; } };
        }
      }
      return { ok: false, status: 404, async text() { return 'no route ' + url } };
    }
  };
}

/* ---------- 垫：Image + canvas（压缩路径用；不真解码，只保证流程与字节落地） ---------- */
function installCanvasShim() {
  globalThis.Image = class {
    set src(v) {
      this.naturalWidth = 1024;
      this.naturalHeight = 768;
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.document.createElement = ((orig) => (tag) => {
    const el = orig.call(globalThis.document, tag);
    if (tag === 'canvas') {
      el.width = 0;
      el.height = 0;
      el.getContext = () => ({ drawImage() {} });
      el.toBlob = (cb, type) => {
        cb(new Blob([new Uint8Array([1, 2, 3, 4])], { type }));
      };
    }
    return el;
  })(globalThis.document.createElement);
}

async function main() {
  installCanvasShim();

  const { emptyArtists, normalizeArtists, mergeArtists, validateArtist, thumbFileFor,
    flattenHistoryImages, fetchHistoryPage, viewThumbUrl, viewFullUrl, makeThumbBlob, cleanOrig,
    loadImageObjectURL, releaseImage, invalidateImage, imageRefs, releaseAllImages } = await import('../probe/artists.mjs');
  const { makeFileStore } = await import('../probe/storage.mjs');
  const { createPanel } = await import('../probe/panel.mjs');

  /* ================= A. 数据模型 ================= */
  head('A · 数据模型');
  {
    const e = emptyArtists();
    check('空库结构', e.version === 1 && Array.isArray(e.items) && e.items.length === 0);

    const n = normalizeArtists({ items: [
      { id: 'a1', text: 'artist:foo, artist:bar', thumb: 'artists/img_a1.webp', created_at: '2026-10-01T00:00:00Z' },
      { id: 'a1', text: '重复 id 应被去掉' },
      { id: '', text: '缺 id 会补' },
      { text: '   ' },
      null,
      'garbage'
    ] });
    check('normalize：去掉重复/空/垃圾，保留 2 条', n.items.length === 2);
    check('normalize：缺 id 自动补', n.items.every((x) => typeof x.id === 'string' && x.id));
    check('normalize：thumb 缺省为 null', 'thumb' in n.items[1] && (n.items[1].thumb === null || typeof n.items[1].thumb === 'string'));

    const m = mergeArtists(
      { version: 1, rev: 3, items: [{ id: 'a1', text: '本地旧', updated_at: '2026-10-01T00:00:00Z' }] },
      { version: 1, rev: 5, items: [{ id: 'a1', text: '磁盘新', updated_at: '2026-10-02T00:00:00Z' }, { id: 'a2', text: '磁盘独有' }] }
    );
    check('merge：取更新的一方 + 保留独有条目', m.items.length === 2 && m.items.find((x) => x.id === 'a1').text === '磁盘新');
    check('merge：rev 取大', m.rev === 5);

    check('validate：空串报错', validateArtist({ text: '' }).ok === false);
    check('validate：正常串通过', validateArtist({ text: 'artist:x' }).ok === true);
    check('thumbFileFor：由 id 派生且无连字符', /^artists\/img_[0-9a-f]+\.webp$/.test(thumbFileFor('ec93c66b-9044-4625-a401-76d5f5b97d8a')));
  }

  /* ================= B. /history ================= */
  head('B · /history 摊平与 URL');
  const api = makeFakeApi();
  {
    api.history.push({ prompt_id: 'p1', images: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: 'sub', type: 'output' }, { filename: 'temp.png', type: 'temp' }] });
    api.history.push({ prompt_id: 'p2', images: [{ filename: 'c.png', type: 'output' }] });
    const flat = flattenHistoryImages({ p1: { outputs: { n: { images: api.history[0].images } } }, p2: { outputs: { n: { images: api.history[1].images } } } });
    check('摊平：output 在前、temp 在后（temp 保留不再丢弃）', flat.length === 4
      && flat.slice(0, 3).every((x) => x.type === 'output') && flat.at(-1).type === 'temp', JSON.stringify(flat.map((x) => x.type)));
    check('摊平：保留 subfolder', flat.some((x) => x.filename === 'b.png' && x.subfolder === 'sub'));
    check('去重：同一张图经多节点回报只取一次', (() => {
      const dup = flattenHistoryImages({ p1: { outputs: {
        n1: { images: [{ filename: 'same.png', subfolder: '', type: 'output' }] },
        n2: { images: [{ filename: 'same.png', subfolder: '', type: 'output' }] }
      } } });
      return dup.length === 1;
    })());
    check('排序：output 排在 temp 前', (() => {
      const mixed = flattenHistoryImages({ p1: { outputs: {
        n1: { images: [{ filename: 't.png', subfolder: '', type: 'temp' }, { filename: 'o.png', subfolder: '', type: 'output' }] }
      } } });
      return mixed[0].type === 'output' && mixed[1].type === 'temp';
    })());
    check('temp 图的缩略/原图 URL 带 type=temp', viewThumbUrl({ filename: 't.png', subfolder: '', type: 'temp' }).includes('type=temp'));
    check('temp 图的原图 URL（viewFullUrl）带 type=temp', viewFullUrl({ filename: 't.png', subfolder: '', type: 'temp' }).includes('type=temp'));
    check('output 图的原图 URL 仍是 type=output', viewFullUrl({ filename: 'o.png', subfolder: '' }).includes('type=output'));
    check('cleanOrig：旧数据无 type 归一化为 output（兼容）', (() => {
      const o = cleanOrig({ filename: 'ComfyUI_00377_.png', subfolder: '' });
      return o.type === 'output' && o.filename === 'ComfyUI_00377_.png';
    })());
    check('cleanOrig：temp 图 orig 带 type=temp（灯箱可直连原图）', cleanOrig({ filename: 'ComfyUI_temp_x.png', subfolder: '', type: 'temp' }).type === 'temp');

    const page = await fetchHistoryPage(api, { limit: 1, offset: 0 });
    check('分页：offset/limit 生效', page.returned === 1 && page.imgs.length >= 1);

    const tu = viewThumbUrl({ filename: 'a.png', subfolder: 's 1' });
    check('缩略图 URL：官方 preview 参数 + 编码', tu.startsWith('/view?') && tu.includes('preview=webp%3B8') && tu.includes('filename=a.png'));
    const fu = viewFullUrl({ filename: 'a.png', subfolder: '' });
    check('原图 URL：无 preview', fu.includes('type=output') && !fu.includes('preview'));
  }

  /* ================= C. 存储层 ================= */
  head('C · 存储层（假 /userdata）');
  const store = makeFileStore(api, { dir: 'prompt_library' });
  {
    check('readText：不存在 → null', (await store.readText('artists.json')) === null);
    await store.writeText('artists.json', JSON.stringify({ version: 1, rev: 1, items: [{ id: 'x', text: 't' }] }));
    check('writeText/readText 往返', JSON.parse(await store.readText('artists.json')).items[0].id === 'x');

    const bin = new Uint8Array([9, 9, 9]);
    await store.writeBin('artists/img_x.webp', bin, 'image/webp');
    const back = await store.readBin('artists/img_x.webp');
    check('writeBin/readBin 二进制往返', back && back.length === 3 && back[0] === 9);

    check('remove：删掉返回 true', (await store.remove('artists/img_x.webp')) === true);
    check('remove：再删返回 false', (await store.remove('artists/img_x.webp')) === false);
  }

  /* ================= C2. 图片缓存与失效（v0.4.6：换图后列表立即变新图） ================= */
  head('C2 · 图片缓存：loadImageObjectURL 缓存 + invalidateImage 失效 + 版本参数');
  {
    // 假 api 记录请求 URL，验证 ?v= 版本参数
    const reqUrls = [];
    const cacheApi = makeFakeApi();
    const origFetch = cacheApi.fetchApi.bind(cacheApi);
    cacheApi.fetchApi = async (url, opts) => { reqUrls.push(url); return origFetch(url, opts); };
    cacheApi.files.set('prompt_library/artists/img_cache.webp', new Uint8Array([1, 2, 3]));

    const url1 = await loadImageObjectURL(cacheApi, 'artists/img_cache.webp');
    check('首次加载产生 objectURL 且入缓存（refs=1）', /^blob:/.test(url1) && imageRefs('artists/img_cache.webp') === 1);
    const url2 = await loadImageObjectURL(cacheApi, 'artists/img_cache.webp');
    check('同键二次加载走缓存（refs=2，URL 不变）', url2 === url1 && imageRefs('artists/img_cache.webp') === 2);
    check('首次 fetch 不带版本参数时不影响功能', reqUrls.some((u) => u.includes('/userdata/prompt_library%2Fartists%2Fimg_cache.webp')));

    invalidateImage('artists/img_cache.webp');
    check('invalidateImage 后缓存清空（refs=0）', imageRefs('artists/img_cache.webp') === 0);
    const url3 = await loadImageObjectURL(cacheApi, 'artists/img_cache.webp');
    check('失效后重新 fetch 出新 objectURL（非旧 URL）', /^blob:/.test(url3) && url3 !== url1);
    check('重新 fetch 的 URL 带 ?v= 版本参数', reqUrls.some((u) => /\/userdata\/prompt_library%2Fartists%2Fimg_cache\.webp\?v=[0-9]+$/.test(u)));
    invalidateImage('artists/img_not_exists.webp');   // 不存在的键
    check('invalidateImage 对不存在的键安全', imageRefs('artists/img_cache.webp') === 1);
    releaseAllImages();
  }

  /* ================= D. 面板集成 ================= */
  head('D · 面板集成：第三个页签 / 添加 / 选图 / 编辑 / 删除');
  // C 段往同一个假 api 里写过文件——这里清空，让面板从真正的空库开始
  api.files.clear();
  const wf = { last_link_id: 0, nodes: [], links: [], groups: [], config: {}, version: 0.4 };
  const app = {
    graph: { nodes: [], links: [], _nodes_by_id: {}, extra: {} },
    canvas: {},
    async graphToPrompt() { throw new Error('nope'); }
  };
  {
    const panel = createPanel(app, { api, workflowName: () => '画师串自测.json' });
    const hostEl = dom.createElement('div');
    dom.body.appendChild(hostEl);
    panel.mount(hostEl);
    await tick(20);   // 等 loadLibrary/loadArtists 两次 render

    const segLabels = () => [...hostEl.querySelectorAll('.pp-seg-btn')].map((b) => b.getAttribute('title') || b.textContent);
    check('页签变成四个（含 画师串 (0) 与 LoRA 提示词 (0)）', segLabels().length === 4 && /画师串 \(0\)/.test(segLabels()[2]) && /LoRA 提示词 \(0\)/.test(segLabels()[3]), segLabels().join(','));

    const artTab = [...hostEl.querySelectorAll('.pp-seg-btn')].find((b) => /画师/.test(b.textContent));
    artTab.click();
    await tick(10);
    check('画师串页：空态提示', /还没有画师串/.test(hostEl.textContent));
    check('画师串页工具条：添加 + 刷新', !!hostEl.querySelector('.pp-toolbar .pp-lib-toolbar') && /添加画师串/.test(hostEl.querySelector('.pp-toolbar').textContent));
    check('探针页操作没有混进画师串页', !/重新扫描/.test(hostEl.querySelector('.pp-toolbar').textContent));

    const topDlg = () => [...hostEl.querySelectorAll('.pp-overlay .pp-dlg')].at(-1);   // 最上层弹窗
    const btnIn = (root, label) => root && [...root.querySelectorAll('button')].find((b) => b.textContent === label);
    const clickBtn = (root, label) => { const b = btnIn(root, label); if (b) b.click(); return !!b; };

    /* 添加一条：纯文本 */
    check('点开「添加画师串」', clickBtn(hostEl, '＋ 添加画师串'));
    await tick(4);
    let dlg = topDlg();
    check('「添加画师串」打开弹窗', !!dlg && /添加画师串/.test(dlg.textContent));
    const textArea = dlg.querySelector('textarea');
    textArea.value = '';
    btnIn(dlg, '保存').click();
    await tick(4);
    check('空串被拦下', /不能为空/.test(dlg.querySelector('.pp-dlg-errors')?.textContent || ''));

    textArea.value = 'artist:misaki, artist:nero, artist:shilong';
    btnIn(dlg, '保存').click();
    await tick(10);
    check('保存成功：列表出现串（串就是标题）', hostEl.textContent.includes('artist:misaki'));
    check('列表元信息行显示「未指定模型」（model 为空）', /未指定模型/.test(hostEl.textContent));
    check('artists.json 已落盘', api.files.has('prompt_library/artists.json'));
    const saved1 = JSON.parse(api.files.get('prompt_library/artists.json'));
    check('落盘结构：version/rev/items', saved1.version === 1 && saved1.rev >= 1 && saved1.items.length === 1, `rev=${saved1.rev} n=${saved1.items.length}`);
    check('无名称字段（只有 text/thumb/orig/model/时间）', !('title' in saved1.items[0]) && !('name' in saved1.items[0]) && 'model' in saved1.items[0]);
    check('model 为空时落盘为 null', saved1.items[0].model === null, JSON.stringify(saved1.items[0].model));

    /* 模型选择（v0.4.3）：diffusion_models 选择器 + 过滤 + 原样落盘 */
    api.loras = null;   // 标记：本自测假 api 的 /models/{folder} 支持见 makeFakeApi
    clickBtn(hostEl, '＋ 添加画师串');
    await tick(4);
    dlg = topDlg();
    check('编辑弹窗有「选择模型…」按钮', !!btnIn(dlg, '选择模型…'));
    check('弹窗初始显示「未指定模型」', /未指定模型/.test(dlg.textContent));
    btnIn(dlg, '选择模型…').click();
    await tick(8);
    const modelDlg = topDlg();
    check('模型选择弹层打开并显示计数（8 个 diffusion_models）', !!modelDlg && /共 8 个/.test(modelDlg.textContent), modelDlg?.textContent?.slice(0, 60));
    check('弹层标题指明 diffusion_models', /diffusion_models/.test(modelDlg.textContent));
    const mFilter = modelDlg.querySelector('input');
    mFilter.value = 'anima';
    mFilter.dispatch('input');
    await tick(2);
    const mItems = [...modelDlg.querySelectorAll('.pp-lora-item')];
    check('模型过滤框生效（anima → 2 条）', mItems.length === 2, `n=${mItems.length}`);
    [...mItems][0].dispatch('click');
    await tick(4);
    dlg = topDlg();
    check('选中后回填模型名（basename）', /anima-base-v1\.0\.safetensors/.test(dlg.textContent));
    check('按钮变「换模型…」且有「清除」', !!btnIn(dlg, '换模型…') && !!btnIn(dlg, '清除'));
    dlg.querySelector('textarea').value = 'artist:model-bound-test';
    btnIn(dlg, '保存').click();
    await tick(14);
    const savedModel = JSON.parse(api.files.get('prompt_library/artists.json')).items.find((x) => x.text === 'artist:model-bound-test');
    check('model 原样落盘（不归一化）', savedModel?.model === 'anima-base-v1.0.safetensors', JSON.stringify(savedModel?.model));
    check('列表元信息行显示模型名', /模型 anima-base-v1\.0\.safetensors/.test(hostEl.textContent));

    /* 编辑保留 model（keepModel 路径）：改文案不动模型 */
    const cardModel = [...hostEl.querySelectorAll('.pp-lib-item')].find((c) => c.textContent.includes('model-bound-test'));
    btnIn(cardModel, '编辑').click();
    await tick(8);
    dlg = topDlg();
    check('编辑弹窗回填已有模型', /anima-base-v1\.0\.safetensors/.test(dlg.textContent) && !!btnIn(dlg, '换模型…'));
    dlg.querySelector('textarea').value = 'artist:model-bound-test v2';
    btnIn(dlg, '保存修改').click();
    await tick(14);
    const savedModel2 = JSON.parse(api.files.get('prompt_library/artists.json')).items.find((x) => x.text === 'artist:model-bound-test v2');
    check('编辑改文案后 model 保留', savedModel2?.model === 'anima-base-v1.0.safetensors', JSON.stringify(savedModel2?.model));

    /* 清除模型 → 保存后 model 回 null */
    btnIn([...hostEl.querySelectorAll('.pp-lib-item')].find((c) => c.textContent.includes('model-bound-test v2')), '编辑').click();
    await tick(8);
    dlg = topDlg();
    btnIn(dlg, '清除').click();
    await tick(2);
    check('清除后显示「未指定模型」', /未指定模型/.test(dlg.textContent));
    btnIn(dlg, '保存修改').click();
    await tick(14);
    const savedModel3 = JSON.parse(api.files.get('prompt_library/artists.json')).items.find((x) => x.text === 'artist:model-bound-test v2');
    check('清除模型保存后 model 为 null', savedModel3?.model === null, JSON.stringify(savedModel3?.model));
    check('model 为 null 的条目可正常编辑保存（列表正常）', hostEl.textContent.includes('model-bound-test v2'));

    /* 历史条目兼容：无 model 字段的旧数据归一化为 null，不崩、不空列表 */
    const legacyRaw = { version: 1, rev: 99, items: [{ id: 'legacy-1', text: 'artist:legacy-entry', created_at: '2026-10-01T00:00:00Z' }] };
    api.files.set('prompt_library/artists.json', JSON.stringify(legacyRaw));
    panel.loadArtists();
    await tick(10);
    const legacyItem = panel.state.artists.items.find((x) => x.id === 'legacy-1');
    check('历史条目（无 model 字段）载入不崩且 model 归一化为 null', !!legacyItem && legacyItem.model === null,
      JSON.stringify(legacyItem ? { model: legacyItem.model } : 'missing'));
    check('历史条目在列表中正常显示「未指定模型」', hostEl.textContent.includes('artist:legacy-entry') && /未指定模型/.test(hostEl.textContent));
    check('模型列表拉取容错：对象数组形态', await (async () => {
      const { fetchModelList } = await import('../probe/loras.mjs');
      const objApi = { async fetchApi() { return { ok: true, status: 200, async json() { return [{ name: 'a.safetensors' }, 'b.safetensors', null]; } }; } };
      const list = await fetchModelList(objApi, 'diffusion_models');
      return list.length === 2 && list[0] === 'a.safetensors';
    })());

    /* 添加第二条：带选图 */
    api.history.push({ prompt_id: 'p9', images: [{ filename: 'ref.png', type: 'output' }] });
    clickBtn(hostEl, '＋ 添加画师串');
    await tick(4);
    dlg = topDlg();
    dlg.querySelector('textarea').value = 'artist:kantoku';
    btnIn(dlg, '从出图历史选图…').click();
    await tick(10);
    const cell = hostEl.querySelector('.pp-art-cell');
    check('出图历史网格出现图片单元', !!cell);
    cell.click();
    await tick(2);
    check('点选后单元高亮', cell.classList.contains('pp-art-cell-on'));
    btnIn(topDlg(), '确定').click();
    await tick(6);
    dlg = topDlg();
    check('选择回填到编辑弹窗（提示会压缩副本）', /压缩成约 1024px/.test(dlg.textContent));
    btnIn(dlg, '保存').click();
    await tick(14);
    const saved2 = JSON.parse(api.files.get('prompt_library/artists.json'));
    const kantoku = saved2.items.find((x) => x.text.startsWith('artist:kantoku'));
    check('第二条带 thumb 副本名', !!kantoku && /^artists\/img_.+\.(webp|jpeg)$/.test(kantoku.thumb), JSON.stringify(kantoku));
    check('第二条带 orig（filename 清洗过、无路径分隔符）', !!kantoku?.orig && kantoku.orig.filename === 'a.png'
      && !/[\/]/.test(kantoku.orig.filename) && typeof kantoku.orig.subfolder === 'string', JSON.stringify(kantoku?.orig));
    check('图片副本字节已写入 /userdata', !!kantoku?.thumb && api.files.has('prompt_library/' + kantoku.thumb));
    check('备份文件已生成', api.files.has('prompt_library/artists.bak.json'));
    check('计数徽标更新（画师串 (2)）', /画师串 \(2\)/.test(segLabels().join(',')), segLabels().join(','));

    /* 列表缩略图显示（fetch→blob→objectURL） */
    await tick(10);
    const thumbImgs = [...hostEl.querySelectorAll('.pp-art-thumb')];
    check('列表渲染出参考图 <img>', thumbImgs.length === 1 && /^blob:/.test(thumbImgs[0].getAttribute('src') || ''));
    check('无图条目显示占位', hostEl.textContent.includes('无图'));

    const { imageRefs } = await import('../probe/artists.mjs');
    const savedThumb = JSON.parse(api.files.get('prompt_library/artists.json')).items.find((x) => x.thumb)?.thumb;

    /* 灯箱：点列表缩略图放大（kantoku 有 thumb+orig；misaki 纯文本无图） */
    check('灯箱断言前置：thumb 名可定位', !!savedThumb, 'no thumb in saved items');
    const kantokuItem = JSON.parse(api.files.get('prompt_library/artists.json')).items.find((x) => x.text.includes('kantoku'));
    const kantokuThumb = kantokuItem?.thumb;
    const cardOfLb = [...hostEl.querySelectorAll('.pp-lib-item')].find((c) => c.textContent.includes('kantoku'));
    const noImgCard = [...hostEl.querySelectorAll('.pp-lib-item')].find((c) => !c.querySelector('.pp-art-thumb'));
    check('无图条目的占位不可点灯箱', !!noImgCard && noImgCard.querySelector('.pp-art-thumbph') != null
      && !hostEl.querySelector('.pp-art-lightbox'));
    const cardSrc = cardOfLb.querySelector('.pp-art-thumb').getAttribute('src');
    const refsBefore = imageRefs(kantokuThumb);
    cardOfLb.querySelector('.pp-art-thumb').click();
    await tick(6);
    const lb = hostEl.querySelector('.pp-art-lightbox');
    check('点击后灯箱打开且图在遮罩内', !!lb && !!lb.querySelector('.pp-art-lightbox-img'));
    const lbSrc = lb?.querySelector('.pp-art-lightbox-img')?.getAttribute('src') || '';
    check('有 orig 时灯箱走原图直链（/view 且无 preview）', lbSrc.startsWith('/view?') && !lbSrc.includes('preview')
      && lbSrc.includes(encodeURIComponent('a.png')), lbSrc);
    check('原图直链不占 urlCache 引用', imageRefs(kantokuThumb) === refsBefore, `refs=${imageRefs(kantokuThumb)}`);
    lb.querySelector('.pp-art-lightbox-img').dispatch('error');   // 模拟原图 404
    await tick(6);
    const fbSrc = lb?.querySelector('.pp-art-lightbox-img')?.getAttribute('src') || '';
    check('原图 404 后回退到压缩副本 objectURL', /^blob:/.test(fbSrc) && fbSrc === cardSrc && imageRefs(kantokuThumb) === refsBefore + 1,
      `src=${fbSrc} card=${cardSrc} refs=${imageRefs(kantokuThumb)}`);
    check('回退时显示提示小字', /原图已不在 output/.test(lb?.querySelector('.pp-art-lightbox-note')?.textContent || ''));
    lb.querySelector('.pp-art-lightbox-x').click();
    await tick(4);
    check('回退分支关闭后 refs 归还且节点移除', !hostEl.querySelector('.pp-art-lightbox') && imageRefs(kantokuThumb) === refsBefore,
      `refs=${imageRefs(kantokuThumb)} before=${refsBefore}`);

    /* 灯箱无 orig 回退路径（直接构造：临时清掉 orig，模拟旧数据条目） */
    const stateOf = (a) => JSON.parse(a.files.get('prompt_library/artists.json'));
    const persistJson = async (a, data) => { a.files.set('prompt_library/artists.json', JSON.stringify(data)); };
    const kantokuNoOrig = JSON.parse(JSON.stringify(stateOf(api)));
    kantokuNoOrig.items.find((x) => x.text.includes('kantoku')).orig = null;
    await persistJson(api, kantokuNoOrig);
    panel.loadArtists();
    await tick(10);
    const cardOld = [...hostEl.querySelectorAll('.pp-lib-item')].find((c) => c.textContent.includes('kantoku'));
    const refsOld = imageRefs(kantokuThumb);
    cardOld.querySelector('.pp-art-thumb').click();
    await tick(6);
    let lb3 = hostEl.querySelector('.pp-art-lightbox');
    const oldSrc = lb3?.querySelector('.pp-art-lightbox-img')?.getAttribute('src') || '';
    check('旧数据（无 orig）灯箱走副本独立引用', /^blob:/.test(oldSrc) && imageRefs(kantokuThumb) === refsOld + 1,
      `src=${oldSrc} refs=${imageRefs(kantokuThumb)} before=${refsOld}`);
    lb3.querySelector('.pp-art-lightbox-x').click();
    await tick(4);
    check('旧数据灯箱关闭后 refs 归还', !hostEl.querySelector('.pp-art-lightbox') && imageRefs(kantokuThumb) === refsOld,
      `refs=${imageRefs(kantokuThumb)} before=${refsOld}`);

    /* 编辑：改串不换图（keepThumb） */
    const cardOf = (t) => [...hostEl.querySelectorAll('.pp-lib-item')].find((c) => c.textContent.includes(t));
    btnIn(cardOf('artist:kantoku'), '编辑').click();
    await tick(8);
    dlg = topDlg();
    dlg.querySelector('textarea').value = 'artist:kantoku, artist:mignon';
    btnIn(dlg, '保存修改').click();
    await tick(14);
    const saved3 = JSON.parse(api.files.get('prompt_library/artists.json'));
    check('编辑保存后仍 2 条（更新非新增）', saved3.items.length === 2, `n=${saved3.items.length}`);
    check('编辑后的新文本在列', hostEl.textContent.includes('artist:mignon'));
    check('编辑保留 thumb（keepThumb）', saved3.items.find((x) => x.text.includes('mignon'))?.thumb === kantoku?.thumb);
    check('rev 持续递增', saved3.rev > saved2.rev);

    /* 删除：二次确认 */
    btnIn(cardOf('mignon'), '删除').click();
    await tick(6);
    let confirmDlg = topDlg();
    check('删除弹二次确认', /删除这条画师串/.test(confirmDlg.textContent));
    btnIn(confirmDlg, '取消').click();
    await tick(10);
    check('点取消不删除', JSON.parse(api.files.get('prompt_library/artists.json')).items.length === 2);
    btnIn(cardOf('mignon'), '删除').click();
    await tick(6);
    confirmDlg = topDlg();
    btnIn(confirmDlg, '确认删除').click();
    await tick(14);
    const saved4 = JSON.parse(api.files.get('prompt_library/artists.json'));
    check('确认后剩 1 条', saved4.items.length === 1);
    check('被删条目的图片副本一并删除', kantoku && !api.files.has('prompt_library/' + kantoku.thumb));

    /* 损坏拒写 */
    api.files.set('prompt_library/artists.json', '{broken json');
    panel.loadArtists();
    await tick(10);
    check('损坏时面板提示且停止写入', /不是合法 JSON/.test(hostEl.textContent));
    const corruptTry = await panel.persistArtist({ id: undefined, text: 'artist:save-after-corrupt', keepThumb: false, newPick: null });
    check('损坏时 persistArtist 拒绝写入（返回失败且不改文件）', corruptTry && corruptTry.ok === false && /不是合法 JSON/.test(corruptTry.error || ''));
    check('损坏文件内容原样保留', api.files.get('prompt_library/artists.json') === '{broken json');

    /* 释放与回归 */
    releaseAllImages();
    panel.setView('scan');
    await tick(4);
    check('切回探针页正常', !!hostEl.querySelector('.pp-wf') || /未命名/.test(hostEl.textContent));
    panel.setView('library');
    await tick(10);
    check('收藏页仍正常（无画师串 UI 混入）', !!hostEl.querySelector('.pp-lib-toolbar input') && !/添加画师串/.test(hostEl.querySelector('.pp-toolbar').textContent));
  }

  /* ================= E. 汇总 ================= */
  head('汇总');
  console.log(`断言：通过 ${pass} · 失败 ${fail}`);
  if (failures.length) { console.log('失败项：\n  - ' + failures.join('\n  - ')); }
  console.log('说明：本自测全部在内存里（假 api + 假画布 + canvas 垫片），不联网、不读写真实收藏/画师串数据。');
  restore();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('自测无法完成：', e); restore(); process.exit(2); });
