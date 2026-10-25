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

      // /userdata/{file}
      const m = /^\/userdata\/(.+)$/.exec(url);
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
    flattenHistoryImages, fetchHistoryPage, viewThumbUrl, viewFullUrl, makeThumbBlob,
    loadImageObjectURL, releaseAllImages } = await import('../probe/artists.mjs');
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
    check('摊平：只取 output，跳过 temp', flat.length === 3);
    check('摊平：保留 subfolder', flat.some((x) => x.filename === 'b.png' && x.subfolder === 'sub'));

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

    const segLabels = () => [...hostEl.querySelectorAll('.pp-seg-btn')].map((b) => b.textContent);
    check('页签变成四个（含 画师串 (0) 与 LoRA 提示词 (0)）', segLabels().length === 4 && /画师串 \(0\)/.test(segLabels()[2]) && /LoRA 提示词 \(0\)/.test(segLabels()[3]), segLabels().join(','));

    const artTab = [...hostEl.querySelectorAll('.pp-seg-btn')].find((b) => /画师串/.test(b.textContent));
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
    check('artists.json 已落盘', api.files.has('prompt_library/artists.json'));
    const saved1 = JSON.parse(api.files.get('prompt_library/artists.json'));
    check('落盘结构：version/rev/items', saved1.version === 1 && saved1.rev >= 1 && saved1.items.length === 1, `rev=${saved1.rev} n=${saved1.items.length}`);
    check('无名称字段（只有 text/thumb/时间）', !('title' in saved1.items[0]) && !('name' in saved1.items[0]) && !('model' in saved1.items[0]));

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
