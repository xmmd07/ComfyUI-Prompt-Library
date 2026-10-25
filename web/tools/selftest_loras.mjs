/**
 * selftest_loras.mjs —— 自测⑤：LoRA 提示词功能（纯内存，不联网、不碰真实数据）
 *
 * 覆盖：
 *   A. 数据模型：normalize/merge/validate/loraBasename
 *   B. fetchLoraList：实测格式（字符串数组、子目录反斜杠）+ 对象数组容错 + 异常
 *   C. 面板集成：第四个页签、添加（选 LoRA 弹层 + 过滤）、列表渲染、复制按钮、编辑（换 LoRA）、删除二次确认、
 *      loras.json 落盘字段与备份、损坏拒写
 *   D. 回归：探针/收藏/画师串页仍正常
 */

import { installMinidom } from './minidom.mjs';

const minidom = installMinidom();
const restore = () => minidom.restore();
const dom = globalThis.document;

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

/* ---------- 假 api：内存 /userdata + /models/loras（按实测真实格式：字符串数组、子目录反斜杠） ---------- */
function makeFakeApi() {
  const files = new Map();
  const LORAS = [
    'Flux2\\lora_style_a.safetensors',
    'Flux2\\lora_character_b.safetensors',
    'anima\\lora_style_c.safetensors',
    'anima\\lora_detail_d.safetensors',
    'lora_root.safetensors'
  ];
  return {
    files,
    loras: LORAS,
    requests: [],
    async fetchApi(url, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      this.requests.push(`${method} ${url}`);

      if (url === '/models/loras') {
        return { ok: true, status: 200, async json() { return LORAS.slice(); } };
      }
      if (url.startsWith('/userdata?')) {
        const q = new URLSearchParams(url.split('?')[1] || '');
        const dir = q.get('dir') || '';
        const names = [...files.keys()].filter((k) => k.startsWith(dir + '/'));
        return { ok: true, status: 200, async json() { return names.map((path) => ({ path, size: 1, type: 'file' })); } };
      }
      const m = /^\/userdata\/(.+)$/.exec(url);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (method === 'GET') {
          if (!files.has(key)) return { ok: false, status: 404, async text() { return 'nf'; } };
          const v = files.get(key);
          return { ok: true, status: 200, async text() { return typeof v === 'string' ? v : '[bin]'; } };
        }
        if (method === 'POST') {
          files.set(key, typeof opts.body === 'string' ? opts.body : String(opts.body));
          return { ok: true, status: 200, async json() { return { path: key }; }, async text() { return ''; } };
        }
        if (method === 'DELETE') {
          const had = files.delete(key);
          return { ok: true, status: had ? 200 : 404, async text() { return ''; } };
        }
      }
      return { ok: false, status: 404, async text() { return 'no route ' + url; } };
    }
  };
}

async function main() {
  const { emptyLoras, normalizeLoras, mergeLoras, validateLora, loraBasename, fetchLoraList } = await import('../probe/loras.mjs');
  const { makeFileStore } = await import('../probe/storage.mjs');
  const { createPanel } = await import('../probe/panel.mjs');

  /* ================= A. 数据模型 ================= */
  head('A · 数据模型');
  {
    const e = emptyLoras();
    check('空库结构', e.version === 1 && Array.isArray(e.items) && e.items.length === 0);

    const n = normalizeLoras({ items: [
      { id: 'l1', lora: 'anima\\x.safetensors', prompt: 'p1', created_at: '2026-10-25T00:00:00Z' },
      { id: 'l1', lora: 'dup.safetensors', prompt: '重复 id 应被去掉' },
      { id: '', lora: 'no-id.safetensors', prompt: '缺 id 会补' },
      { lora: 'no-prompt.safetensors', prompt: '   ' },
      { lora: '', prompt: '没选 lora' },
      null,
      'garbage'
    ] });
    check('normalize：去掉重复/空/垃圾，保留 2 条', n.items.length === 2, `n=${n.items.length}`);
    check('normalize：缺 id 自动补', n.items.every((x) => typeof x.id === 'string' && x.id));
    check('normalize：lora 原样保留（不归一化反斜杠）', n.items[0].lora === 'anima\\x.safetensors');

    const m = mergeLoras(
      { version: 1, rev: 3, items: [{ id: 'l1', lora: 'a.safetensors', prompt: '本地旧', updated_at: '2026-10-01T00:00:00Z' }] },
      { version: 1, rev: 5, items: [{ id: 'l1', lora: 'a.safetensors', prompt: '磁盘新', updated_at: '2026-10-02T00:00:00Z' }, { id: 'l2', lora: 'b.safetensors', prompt: '磁盘独有' }] }
    );
    check('merge：取更新的一方 + 保留独有条目', m.items.length === 2 && m.items.find((x) => x.id === 'l1').prompt === '磁盘新');
    check('merge：rev 取大', m.rev === 5);

    check('validate：缺 lora 报错', validateLora({ lora: '', prompt: 'x' }).ok === false);
    check('validate：缺 prompt 报错', validateLora({ lora: 'a.safetensors', prompt: '  ' }).ok === false);
    check('validate：正常通过', validateLora({ lora: 'a.safetensors', prompt: 'x' }).ok === true);

    check('basename：反斜杠子目录取末段', loraBasename('Flux2\\lora_character_b.safetensors') === 'lora_character_b.safetensors');
    check('basename：正斜杠子目录取末段', loraBasename('anima/x.safetensors') === 'x.safetensors');
    check('basename：无目录原样返回', loraBasename('lora_root.safetensors') === 'lora_root.safetensors');
  }

  /* ================= B. fetchLoraList ================= */
  head('B · /models/loras 拉取（实测格式 + 容错）');
  {
    const api = makeFakeApi();
    const list = await fetchLoraList(api);
    check('实测格式：字符串数组原样返回', list.length === 5 && list[0] === api.loras[0]);
    check('子目录反斜杠原样保留（不归一化）', list.some((p) => p.includes('\\')));
    check('请求路径是 GET /models/loras', api.requests.includes('GET /models/loras'));

    const bad = { async fetchApi() { return { ok: false, status: 404, async json() { return []; } }; } };
    let threw = false;
    try { await fetchLoraList(bad); } catch (e) { threw = /HTTP 404/.test(String(e.message || e)); }
    check('HTTP 失败抛错', threw);

    const objArr = { async fetchApi() { return { ok: true, status: 200, async json() { return [{ name: 'a.safetensors' }, 'b.safetensors', null, {}]; } }; } };
    const mixed = await fetchLoraList(objArr);
    check('对象数组容错（{name} 形态）+ 跳过垃圾', mixed.length === 2 && mixed[0] === 'a.safetensors' && mixed[1] === 'b.safetensors');
  }

  /* ================= C. 面板集成 ================= */
  head('C · 面板集成：第四页签 / 添加选 LoRA / 列表 / 复制按钮 / 编辑 / 删除');
  const api = makeFakeApi();
  {
    const wf = { last_link_id: 0, nodes: [], links: [], groups: [], config: {}, version: 0.4 };
    const app = { graph: { nodes: [], links: [], _nodes_by_id: {}, extra: {} }, canvas: {}, async graphToPrompt() { throw new Error('nope'); } };
    const panel = createPanel(app, { api, workflowName: () => 'LoRA自测.json' });
    const hostEl = dom.createElement('div');
    dom.body.appendChild(hostEl);
    panel.mount(hostEl);
    await tick(20);

    const topDlg = () => [...hostEl.querySelectorAll('.pp-overlay .pp-dlg')].at(-1);
    const btnIn = (root, label) => root && [...root.querySelectorAll('button')].find((b) => b.textContent === label);
    const clickBtn = (root, label) => { const b = btnIn(root, label); if (b) b.click(); return !!b; };
    const segLabels = () => [...hostEl.querySelectorAll('.pp-seg-btn')].map((b) => b.getAttribute('title') || b.textContent);

    check('页签有四个（含 LoRA 提示词 (0)）', segLabels().length === 4 && /LoRA 提示词 \(0\)/.test(segLabels()[3]), segLabels().join(','));

    const loraTab = [...hostEl.querySelectorAll('.pp-seg-btn')].find((b) => /LoRA/.test(b.textContent));
    loraTab.click();
    await tick(8);
    check('空态提示', /还没有记录/.test(hostEl.textContent));

    /* 添加：打开弹窗 → 选 LoRA（弹层 + 过滤）→ 输提示词 → 保存 */
    check('点开「添加 LoRA 提示词」', clickBtn(hostEl, '＋ 添加 LoRA 提示词'));
    await tick(4);
    let dlg = topDlg();
    check('添加弹窗打开', !!dlg && /添加 LoRA 提示词/.test(dlg.textContent));
    check('未选 LoRA 时保存被拦', /请选择一个 LoRA/.test((() => { btnIn(dlg, '保存').click(); return dlg.textContent; })()));
    btnIn(dlg, '选择 LoRA…').click();
    await tick(8);
    const pickerDlg = topDlg();
    check('选择弹层出现并显示计数', !!pickerDlg && /共 5 个/.test(pickerDlg.textContent), pickerDlg?.textContent?.slice(0, 60));
    check('弹层显示 basename（不带子目录）', /lora_character_b\.safetensors/.test(pickerDlg.textContent) && !/Flux2\\/.test(pickerDlg.textContent));
    const filterInput = pickerDlg.querySelector('input');
    filterInput.value = 'anima';
    filterInput.dispatch('input');
    await tick(2);
    const items = [...pickerDlg.querySelectorAll('.pp-lora-item')];
    check('过滤框生效（anima → 2 条）', items.length === 2, `n=${items.length}`);
    filterInput.value = '不存在关键字xyz';
    filterInput.dispatch('input');
    await tick(2);
    check('无匹配显示提示', /没有匹配的模型/.test(pickerDlg.textContent));
    filterInput.value = 'lora_character_b';
    filterInput.dispatch('input');
    await tick(2);
    [...pickerDlg.querySelectorAll('.pp-lora-item')][0].click();
    await tick(4);
    dlg = topDlg();
    check('选中后回填到编辑弹窗（显示 basename）', /lora_character_b\.safetensors/.test(dlg.textContent));
    dlg.querySelector('textarea').value = ' masterpiece, best quality, lora_character_b style';
    btnIn(dlg, '保存').click();
    await tick(14);
    check('保存成功：列表出现 LoRA 名', hostEl.textContent.includes('lora_character_b.safetensors'));
    check('提示词也显示在列表', /masterpiece, best quality/.test(hostEl.textContent));
    const saved1 = JSON.parse(api.files.get('prompt_library/loras.json'));
    check('loras.json 已落盘且 lora 存原始路径（反斜杠）', saved1.items.length === 1 && saved1.items[0].lora === api.loras[1], JSON.stringify(saved1.items[0]));
    check('落盘字段：id/lora/prompt/created_at/updated_at', ['id', 'lora', 'prompt', 'created_at', 'updated_at'].every((k) => k in saved1.items[0]));
    check('计数徽标更新（LoRA 提示词 (1)）', /LoRA 提示词 \(1\)/.test(segLabels().join(',')), segLabels().join(','));

    /* 复制按钮 */
    const copyBtn = btnIn(hostEl, '复制提示词');
    check('主按钮是「复制提示词」', !!copyBtn);
    copyBtn.click();
    await tick(4);
    check('复制提示词反馈', /已复制/.test(copyBtn.textContent));
    check('剪贴板内容 = 提示词', minidom.copied.at(-1) === ' masterpiece, best quality, lora_character_b style');
    const copyNameBtn = btnIn(hostEl, '复制 LoRA 名');
    check('次按钮是「复制 LoRA 名」', !!copyNameBtn);
    copyNameBtn.click();
    await tick(4);
    check('剪贴板内容 = 原始 LoRA 路径', minidom.copied.at(-1) === api.loras[1]);

    /* 编辑：换 LoRA */
    const card = [...hostEl.querySelectorAll('.pp-lib-item')].find((c) => c.textContent.includes('lora_character_b'));
    btnIn(card, '编辑').click();
    await tick(8);
    dlg = topDlg();
    dlg.querySelector('textarea').value = 'updated prompt v2';
    btnIn(dlg, '保存修改').click();
    await tick(14);
    const saved2 = JSON.parse(api.files.get('prompt_library/loras.json'));
    check('编辑保存后仍 1 条（更新非新增）', saved2.items.length === 1 && saved2.items[0].prompt === 'updated prompt v2');
    check('rev 持续递增', saved2.rev > saved1.rev);

    /* 删除：二次确认 */
    btnIn(card, '删除').click();
    await tick(6);
    let confirmDlg = topDlg();
    check('删除弹二次确认', /删除这条 LoRA 提示词/.test(confirmDlg.textContent));
    btnIn(confirmDlg, '取消').click();
    await tick(10);
    check('点取消不删除', JSON.parse(api.files.get('prompt_library/loras.json')).items.length === 1);
    btnIn(card, '删除').click();
    await tick(6);
    confirmDlg = topDlg();
    btnIn(confirmDlg, '确认删除').click();
    await tick(14);
    const saved3 = JSON.parse(api.files.get('prompt_library/loras.json'));
    check('确认后剩 0 条且徽标归零', saved3.items.length === 0 && /LoRA 提示词 \(0\)/.test(segLabels().join(',')), segLabels().join(','));
    check('备份文件已生成', api.files.has('prompt_library/loras.bak.json'));

    /* 损坏拒写 */
    api.files.set('prompt_library/loras.json', '{broken json');
    panel.loadLoras();
    await tick(10);
    check('损坏时面板提示且停止写入', /不是合法 JSON/.test(hostEl.textContent));
    const corruptTry = await panel.persistLora({ id: undefined, lora: 'a.safetensors', prompt: 'x' });
    check('损坏时 persistLora 拒绝写入', corruptTry && corruptTry.ok === false && /不是合法 JSON/.test(corruptTry.error || ''));
    check('损坏文件内容原样保留', api.files.get('prompt_library/loras.json') === '{broken json');

    /* 回归：探针/收藏/画师串页仍正常 */
    panel.setView('scan');
    await tick(4);
    check('切回探针页正常', !!hostEl.querySelector('.pp-wf') || /未命名/.test(hostEl.textContent));
    panel.setView('library');
    await tick(10);
    check('收藏页仍正常（无 LoRA UI 混入）', !!hostEl.querySelector('.pp-lib-toolbar input') && !/添加 LoRA 提示词/.test(hostEl.querySelector('.pp-toolbar').textContent));
    [...hostEl.querySelectorAll('.pp-seg-btn')].find((b) => /画师/.test(b.textContent)).click();
    await tick(10);
    check('画师串页仍正常', /添加画师串/.test(hostEl.textContent));
  }

  /* ================= D. 汇总 ================= */
  head('汇总');
  console.log(`断言：通过 ${pass} · 失败 ${fail}`);
  if (failures.length) { console.log('失败项：\n  - ' + failures.join('\n  - ')); }
  console.log('说明：本自测全部在内存里（假 api + minidom），不联网、不读写真实 loras.json。');
  restore();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('自测无法完成：', e); restore(); process.exit(2); });
