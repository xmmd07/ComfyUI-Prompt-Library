/**
 * selftest_library.mjs —— 阶段二自测（Node 运行，不打开浏览器、不联网、不碰真实数据）
 *
 * 覆盖：
 *   A. 收藏库纯逻辑（校验 / 新增 / 更新 / 删除 / 搜索 / 筛选 / 合并 / 脏数据归一化）
 *   B. 面板真实渲染与交互（用 minidom 垫片 + 假 api）：收藏 Anima / Krea 2 / Qwen Image 2.1 各一条、
 *      必填校验、编辑、搜索、筛选、查看完整、复制、删除二次确认、重开面板后数据仍在、损坏时拒绝写入
 *
 * 运行：node web/tools/selftest_library.mjs
 */

import { installMinidom } from './minidom.mjs';
import * as L from '../probe/library.mjs';

const results = { pass: 0, fail: 0 };
function check(label, cond, detail = '') {
  const ok = !!cond;
  ok ? results.pass++ : results.fail++;
  console.log(`  ${ok ? '✔ PASS' : '✘ FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
  return ok;
}
const head = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const tick = (n = 3) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : setTimeout(f, 0)); setTimeout(f, 0); });

/* ------------------------------------------------------------------ *
 * 假 api（模拟官方 /userdata 接口；文件只存在内存里）
 * ------------------------------------------------------------------ */
function makeFakeApi() {
  const files = new Map();
  return {
    files,
    posts: [],
    async fetchApi(url, opts = {}) {
      const m = /^\/userdata\/(.+)$/.exec(url);
      const key = m ? decodeURIComponent(m[1]) : url;
      if (!opts || opts.method !== 'POST') {
        if (!files.has(key)) return { ok: false, status: 404, async text() { return 'not found'; } };
        return { ok: true, status: 200, async text() { return files.get(key); } };
      }
      files.set(key, String(opts.body));
      return { ok: true, status: 200, async json() { return { path: key }; }, async text() { return ''; } };
    }
  };
}

/* ------------------------------------------------------------------ *
 * 假画布：三条采样链（Anima / Krea 2 / Qwen Image 2.1）+ 一个游离候选节点
 * ------------------------------------------------------------------ */
function makeMockApp() {
  const graph = { _nodes: [], links: {}, _groups: [] };
  const link = (id, from, slot = 0) => { graph.links[id] = { id, origin_id: from, origin_slot: slot }; };
  const node = (o) => { o.graph = graph; o.flags = o.flags || {}; o.mode = o.mode ?? 0; graph._nodes.push(o); return o; };

  // 链 1：Anima（PrimitiveString → CLIPTextEncode ← KSampler），CLIPTextEncode 折叠且带残留旧文本
  link(11, 3); link(10, 2);
  node({ id: 1, type: 'KSampler', inputs: [{ name: 'positive', link: 10 }, { name: 'negative', link: null }], widgets: [{ name: 'seed', value: 1 }] });
  node({ id: 2, type: 'CLIPTextEncode', flags: { collapsed: true }, inputs: [{ name: 'clip', link: null }, { name: 'text', link: 11 }], widgets: [{ name: 'text', value: 'OLD STALE TEXT @96yottea（不该被采用）' }] });
  node({ id: 3, type: 'PrimitiveString', inputs: [], widgets: [{ name: 'value', value: 'masterpiece, best quality, 1girl, solo (Anima 测试)' }] });

  // 链 2：Krea 2（CR Prompt Text → SetNode → GetNode → CLIPTextEncode ← ClownsharKSampler_Beta）
  link(40, 20); link(41, 21); link(42, 22);
  node({ id: 20, type: 'CR Prompt Text', inputs: [{ name: 'prompt', link: null }], widgets: [{ name: 'prompt', value: 'gpt anima render style, a blonde knight (Krea 2 测试)' }] });
  node({ id: 24, type: 'SetNode', title: 'Set_text', inputs: [{ name: 'STRING', link: 40 }], widgets: [{ name: 'value', value: 'text' }] });
  node({ id: 21, type: 'GetNode', title: 'Get_text', inputs: [], widgets: [{ name: 'name', value: 'text' }] });
  node({ id: 22, type: 'CLIPTextEncode', flags: { collapsed: true }, inputs: [{ name: 'clip', link: null }, { name: 'text', link: 41 }], widgets: [{ name: 'text', value: 'STALE KREA TEXT（不该被采用）' }] });
  node({ id: 23, type: 'ClownsharKSampler_Beta', inputs: [{ name: 'positive', link: 42 }, { name: 'negative', link: null }], widgets: [] });

  // 链 3：Qwen Image 2.1（SamplerCustomAdvanced → BasicGuider.conditioning → TextEncodeQwenImage21）
  link(50, 32); link(51, 33);
  node({ id: 31, type: 'SamplerCustomAdvanced', inputs: [{ name: 'guider', link: 50 }, { name: 'noise', link: null }], widgets: [] });
  node({ id: 32, type: 'BasicGuider', inputs: [{ name: 'conditioning', link: 51 }], widgets: [] });
  node({ id: 33, type: 'TextEncodeQwenImage21', inputs: [{ name: 'clip', link: null }, { name: 'prompt', link: null }, { name: 'negative_prompt', link: null }], widgets: [{ name: 'prompt', value: '一位清新自然的日系女生（Qwen Image 2.1 测试）' }, { name: 'negative_prompt', value: '油腻' }] });

  // 游离节点（应进"候选文本"）
  node({ id: 40, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: null }, { name: 'text', link: null }], widgets: [{ name: 'text', value: 'CANDIDATE ONLY TEXT' }] });

  return { rootGraph: graph, graph };
}

/* ------------------------------------------------------------------ */

async function main() {
  const dom = installMinidom();
  const { createPanel } = await import('../probe/panel.mjs');

  /* ---------------- A. 纯逻辑 ---------------- */
  head('A · 收藏库纯逻辑');
  {
    const empty = L.emptyLibrary();
    check('空库带有三个默认模型分类', JSON.stringify(empty.models) === JSON.stringify(['Anima', 'Krea 2', 'Qwen Image 2.1']), empty.models.join('/'));

    check('校验：三项必填都缺失时报错', !L.validateItem({ title: '', model: '', text: '' }).ok);
    check('校验：只填标题仍不通过', !L.validateItem({ title: 't', model: '', text: '' }).ok);
    check('校验：文字为空白也不算通过', !L.validateItem({ title: 't', model: 'Anima', text: '   ' }).ok);
    check('校验：完整填写通过', L.validateItem({ title: 't', model: 'Anima', text: 'x' }).ok);

    let lib = L.emptyLibrary();
    L.upsertItem(lib, { id: 'a', title: 'A', model: 'Anima', text: 'aaa', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
    L.upsertItem(lib, { id: 'b', title: 'B', model: 'Krea 2', text: 'bbb', created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' });
    check('新增两条后 items=2', lib.items.length === 2);
    check('新增时自动把新模型加入分类表', lib.models.includes('Krea 2'));

    L.upsertItem(lib, { id: 'a', title: 'A2', model: 'Qwen Image 2.1', text: 'aaa2', updated_at: '2026-01-03T00:00:00.000Z' });
    check('按 id 更新不会产生重复条目', lib.items.length === 2);
    check('更新保留 created_at', L.getItem(lib, 'a').created_at === '2026-01-01T00:00:00.000Z');
    check('更新后的标题生效', L.getItem(lib, 'a').title === 'A2');

    check('搜索按标题（忽略大小写）', L.filterItems(lib, { query: 'a2' }).length === 1);
    check('搜索"b"命中一条', L.filterItems(lib, { query: 'B' }).length === 1);
    check('搜索不存在返回 0', L.filterItems(lib, { query: 'zzz' }).length === 0);
    check('按模型筛选', L.filterItems(lib, { model: 'Krea 2' }).length === 1 && L.filterItems(lib, { model: 'Anima' }).length === 0);
    check('列表按更新时间倒序', L.filterItems(lib, {})[0].id === 'a');

    const merged = L.mergeLibraries(
      { rev: 1, models: ['Anima'], items: [{ id: 'x', title: '旧', model: 'Anima', text: 'x', updated_at: '2026-01-01T00:00:00.000Z' }] },
      { rev: 5, models: ['Krea 2'], items: [
        { id: 'x', title: '新', model: 'Anima', text: 'x', updated_at: '2026-02-01T00:00:00.000Z' },
        { id: 'y', title: '只有磁盘有', model: 'Krea 2', text: 'y', updated_at: '2026-02-02T00:00:00.000Z' }
      ] }
    );
    check('合并：同 id 取更新时间较新的', L.getItem(merged, 'x').title === '新');
    check('合并：磁盘独有的条目被保留（防丢数据）', !!L.getItem(merged, 'y'));
    check('合并：模型分类取并集', merged.models.length === 2);
    check('合并：rev 取较大值', merged.rev === 5);

    const dirty = L.normalizeLibrary({ items: [null, 42, { title: 'ok', model: 'Anima', text: 'z' }, {}], models: [1, 'Anima', 'Anima', ''] });
    check('脏数据归一化不崩溃且过滤掉空条目', dirty.items.length === 1 && dirty.items[0].title === 'ok');
    check('脏数据里的 models 被清洗去重', JSON.stringify(dirty.models) === JSON.stringify(['Anima']));
    check('normalizeLibrary(null) 返回空库', L.normalizeLibrary(null).items.length === 0);
    check('newId 生成的 id 不重复', new Set([L.newId(), L.newId(), L.newId()]).size === 3);
  }

  /* ---------------- B. 面板交互 ---------------- */
  head('B · 面板渲染与交互（minidom + 假 api）');
  const api = makeFakeApi();
  const app = makeMockApp();
  const panel = createPanel(app, { api, workflowName: () => '阶段二自测工作流.json' });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  panel.mount(host);
  await tick();

  const $$ = (sel) => host.querySelectorAll(sel);
  const text = () => host.textContent;
  const findBtn = (label, scope) => (scope || host).querySelectorAll('button').find((b) => b.textContent.includes(label));
  const selectableWith = (needle) => $$('.pp-selectable').find((el) => el.textContent.includes(needle));
  const openChainTab = async (n) => {
    const tab = host.querySelectorAll('.pp-tabs .pp-tab').find((t) => t.textContent.startsWith(`链${n}`));
    tab?.click();
    await tick();
    return !!tab;
  };
  const libFile = () => {
    const raw = api.files.get('prompt_library/library.json');
    return raw ? JSON.parse(raw) : null;
  };

  const r = panel.state.result;
  check('扫描到 3 条采样链', r.chains.length === 3, r.chains.map((c) => `${c.sampler.cls}#${c.sampler.id}`).join(', '));
  check('检出 1 个候选文本节点', r.candidates.length === 1, `#${r.candidates[0]?.id}`);
  check('阶段一的折叠节点解析仍正常（Anima 正向=上游真实文本）',
    r.chains[0].fields[0].text.includes('masterpiece, best quality'), r.chains[0].fields[0].text.slice(0, 40));
  check('折叠节点控件里的残留旧文本没有被采用', !text().includes('@96yottea'));
  check('Krea 链经 Set/Get 解析成功', r.chains[1].fields[0].text.includes('Krea 2 测试'));
  check('Qwen 链经 Guider→conditioning 解析成功', r.chains[2].fields[0].text.includes('Qwen Image 2.1 测试'));
  check('收藏库初始为空（文件尚不存在）', libFile() === null);

  // 未选中就点收藏 → 提示而不是乱存
  findBtn('★ 收藏 Prompt').click();
  await tick();
  check('未选中时点「收藏 Prompt」给出提示', /还没有选中/.test(text()));
  check('未选中时没有生成任何文件', libFile() === null);

  // —— 收藏一条 Anima ——
  selectableWith('masterpiece, best quality').click();
  await tick();
  check('点整行可选中该条 Prompt', !!panel.state.selected && panel.state.selected.text.includes('masterpiece'));
  findBtn('★ 收藏 Prompt').click();
  await tick();
  const dlg = host.querySelector('.pp-dlg');
  check('弹出收藏窗口', !!dlg);
  check('收藏窗口默认填入解析出来的 Prompt 全文', dlg.querySelector('.pp-textarea').value.includes('1girl, solo'));
  check('收藏窗口默认模型为 Amima（第一个分类）', dlg.querySelector('select').value === 'Anima');
  check('收藏窗口保留了来源状态提示',
    !!dlg.querySelector('.pp-dlg-warn') || /已确认/.test(dlg.textContent),
    dlg.querySelector('.pp-dlg-warn')?.textContent || '（来源已确认，无需警告）');

  // 必填校验
  findBtn('保存', dlg).click();
  await tick();
  check('标题为空时保存被拒绝并提示', /标题必填/.test(host.textContent));
  check('校验失败时没有写文件', libFile() === null);
  check('校验失败时窗口保持打开', !!host.querySelector('.pp-dlg'));

  dlg.querySelector('input').value = 'Anima 测试收藏';
  findBtn('保存', dlg).click();
  await tick(6);
  check('填好标题后保存成功、窗口关闭', !host.querySelector('.pp-dlg'));
  let lib = libFile();
  check('磁盘上出现了 library.json', !!lib);
  check('文件里恰好 1 条收藏', lib.items.length === 1);
  check('标题/模型/内容正确', lib.items[0].title === 'Anima 测试收藏' && lib.items[0].model === 'Anima' && lib.items[0].text.includes('masterpiece'));
  check('保存了来源节点信息（工作流/节点/状态）',
    lib.items[0].source.node_class === 'CLIPTextEncode' && lib.items[0].source.workflow === '阶段二自测工作流.json' && !!lib.items[0].source.status);
  check('首次保存 rev=1', lib.rev === 1);
  check('保存后选中状态被清空', panel.state.selected === null);

  // —— 收藏一条 Krea 2 ——
  check('可以切换到第 2 条采样链标签页', await openChainTab(2));
  selectableWith('Krea 2 测试').click();
  await tick();
  findBtn('★ 收藏 Prompt').click();
  await tick();
  let dlg2 = host.querySelector('.pp-dlg');
  dlg2.querySelector('input').value = 'Krea 2 测试收藏';
  dlg2.querySelector('select').value = 'Krea 2';
  findBtn('保存', dlg2).click();
  await tick(6);
  lib = libFile();
  check('Krea 2 收藏已保存', lib.items.length === 2 && lib.items.some((i) => i.title === 'Krea 2 测试收藏' && i.model === 'Krea 2'));
  check('第二次保存前生成了一份备份 library.bak.json', !!api.files.get('prompt_library/library.bak.json'));
  check('备份里是上一版内容（1 条）', JSON.parse(api.files.get('prompt_library/library.bak.json')).items.length === 1);
  check('rev 递增到 2', lib.rev === 2);

  // —— 收藏一条 Qwen Image 2.1（并测试"新增模型分类"入口）——
  check('可以切换到第 3 条采样链标签页', await openChainTab(3));
  selectableWith('Qwen Image 2.1 测试').click();
  await tick();
  findBtn('★ 收藏 Prompt').click();
  await tick();
  let dlg3 = host.querySelector('.pp-dlg');
  dlg3.querySelector('input').value = 'Qwen 测试收藏';
  const sel3 = dlg3.querySelector('select');
  sel3.value = '__new__';
  sel3.dispatch('change');
  const newModelInput = dlg3.querySelectorAll('input')[1];
  newModelInput.value = 'Qwen Image 2.1';
  findBtn('保存', dlg3).click();
  await tick(6);
  lib = libFile();
  check('Qwen Image 2.1 收藏已保存（用"新增模型分类"填写）', lib.items.length === 3 && lib.items.some((i) => i.model === 'Qwen Image 2.1'));
  check('三种模型各有一条', new Set(lib.items.map((i) => i.model)).size === 3, lib.items.map((i) => i.model).join(' / '));

  // —— 我的收藏视图：搜索 / 筛选 / 查看完整 / 复制 ——
  findBtn('我的收藏').click();
  await tick(6);
  check('切换到「我的收藏」视图', /共 3 条收藏/.test(text()), text().slice(0, 60));
  check('列表显示三条标题', ['Anima 测试收藏', 'Krea 2 测试收藏', 'Qwen 测试收藏'].every((t) => text().includes(t)));
  check('条目上带模型徽标与状态徽标', $$('.pp-badge-model').length === 3);

  const searchInput = host.querySelector('.pp-lib-toolbar input');
  searchInput.value = 'Krea';
  searchInput.dispatch('input');
  await tick();
  check('按标题搜索：只剩 Krea 一条', text().includes('Krea 2 测试收藏') && !text().includes('Anima 测试收藏'));
  check('搜索时显示筛选计数', /筛选后显示 1 \/ 共 3 条/.test(text()));

  searchInput.value = '';
  searchInput.dispatch('input');
  await tick();
  const modelSelect = host.querySelector('.pp-lib-toolbar select');
  modelSelect.value = 'Anima';
  modelSelect.dispatch('change');
  await tick();
  check('按模型筛选：只剩 Anima 一条', text().includes('Anima 测试收藏') && !text().includes('Krea 2 测试收藏'));

  modelSelect.value = '';
  modelSelect.dispatch('change');
  await tick();
  check('清空筛选后恢复三条', /共 3 条收藏/.test(text()));

  check('默认折叠为预览，不含完整文本块', host.querySelectorAll('.pp-lib-item .pp-text').length === 0);
  findBtn('查看完整', host.querySelectorAll('.pp-lib-item')[0]).click();
  await tick();
  check('「查看完整」展开显示全文', host.querySelectorAll('.pp-lib-item .pp-text').length === 1);

  const copiedBefore = dom.copied.length;
  host.querySelectorAll('.pp-lib-item')[0].querySelector('.pp-copy').click();
  await tick();
  check('复制按钮把全文写入剪贴板', dom.copied.length === copiedBefore + 1 && dom.copied[dom.copied.length - 1].length > 20, `${dom.copied[dom.copied.length - 1]?.slice(0, 30)}…`);

  // —— 编辑 ——
  const kreaBefore = libFile().items.find((i) => i.title === 'Krea 2 测试收藏');
  const kreaCreated = kreaBefore.created_at;
  const kreaCard = host.querySelectorAll('.pp-lib-item').find((c) => c.textContent.includes('Krea 2 测试收藏'));
  findBtn('编辑', kreaCard).click();
  await tick();
  const editDlg = host.querySelector('.pp-dlg');
  check('编辑窗口带出原标题', editDlg.querySelector('input').value === 'Krea 2 测试收藏');
  check('编辑窗口带出原模型', editDlg.querySelector('select').value === 'Krea 2');
  editDlg.querySelector('input').value = 'Krea 2 测试收藏（已编辑）';
  const ta = editDlg.querySelector('.pp-textarea');
  ta.value = ta.value + ' [手改追加]';
  findBtn('保存修改', editDlg).click();
  await tick(6);
  lib = libFile();
  const edited = lib.items.find((i) => i.title.includes('已编辑'));
  check('编辑后文件里仍只有 3 条（是更新不是新增）', lib.items.length === 3);
  check('标题已更新', !!edited && edited.title === 'Krea 2 测试收藏（已编辑）', edited?.title);
  check('内容已更新（用户在编辑框里的追加被保存）', !!edited && edited.text.includes('[手改追加]'));
  check('编辑保留 id 与 created_at', edited.id === kreaBefore.id && edited.created_at === kreaCreated);
  check('其他条目未被牵连', lib.items.find((i) => i.title === 'Anima 测试收藏').text.includes('masterpiece'));
  check('编辑后 rev 递增', lib.rev === 4, `rev=${lib.rev}`);

  // —— 删除（二次确认）——
  const kreaCard2 = host.querySelectorAll('.pp-lib-item').find((c) => c.textContent.includes('已编辑'));
  findBtn('删除', kreaCard2).click();
  await tick();
  check('删除弹出二次确认', /删除这条收藏/.test(text()));
  findBtn('取消', host.querySelector('.pp-dlg')).click();
  await tick();
  check('取消后条目仍在', libFile().items.length === 3);

  const kreaCard3 = host.querySelectorAll('.pp-lib-item').find((c) => c.textContent.includes('已编辑'));
  findBtn('删除', kreaCard3).click();
  await tick();
  findBtn('确认删除', host.querySelector('.pp-dlg')).click();
  await tick(6);
  lib = libFile();
  check('确认后条目被删除', lib.items.length === 2 && !lib.items.some((i) => i.title.includes('已编辑')));
  check('删除也写了备份', !!api.files.get('prompt_library/library.bak.json'));

  // —— 重开面板（等价于"关掉再打开 ComfyUI 后数据仍在"）——
  const panel2 = createPanel(app, { api, workflowName: () => '阶段二自测工作流.json' });
  const host2 = dom.document.createElement('div');
  dom.document.body.appendChild(host2);
  panel2.mount(host2);
  await tick(6);
  check('新面板实例能从磁盘读回收藏（持久化）', panel2.state.library.items.length === 2,
    panel2.state.library.items.map((i) => i.title).join(' / '));
  check('读回的条目内容完整', panel2.state.library.items.some((i) => i.text.includes('masterpiece') && i.model === 'Anima'));

  // —— 损坏保护 ——
  api.files.set('prompt_library/library.json', '{ 这不是 JSON');
  await panel2.loadLibrary();
  await tick(4);
  check('损坏文件被识别并停止写入', panel2.state.libNotice?.level === 'error' && /无法解析/.test(panel2.state.libNotice.text));
  const before = api.files.get('prompt_library/library.json');
  const saveRes = await panel2.persistItem({ title: '不该写进去', model: 'Anima', text: 'x' });
  await tick(2);
  check('损坏状态下保存被拒绝（不会覆盖用户数据）', saveRes.ok === false, String(saveRes.error).slice(0, 40));
  check('损坏文件内容原样保留', api.files.get('prompt_library/library.json') === before);

  /* ---------------- C. UI 结构（v0.2 整理） ---------------- */
  head('C · UI 结构：两页顶部统一 / 卡片层级 / 展开收起');
  {
    // 前一段把文件弄"损坏"了，这里放回一份正常数据（模拟真实使用状态）
    api.files.set('prompt_library/library.json', JSON.stringify({
      version: 1, rev: 9, updated_at: '2026-10-04T10:00:00.000Z',
      models: ['Anima', 'Krea 2', 'Qwen Image 2.1'],
      items: [
        { id: 'c1', title: 'Krea2 夜街少女', model: 'Krea 2', text: 'gpt anima render style, a blonde knight, 长文本 '.repeat(6),
          source: { workflow: 'Krea2全面 (1).json', node_class: 'CLIPTextEncode', node_id: 295, role: '正向', status: 'confirmed' },
          created_at: '2026-10-04T09:00:00.000Z', updated_at: '2026-10-04T09:30:00.000Z' },
        { id: 'c2', title: '超长标题：这是一个非常非常非常非常非常非常长的收藏标题用来验证不会撑破卡片', model: 'Anima', text: 'masterpiece, best quality, 1girl, solo',
          source: { workflow: '一个名字很长的工作流文件名称_测试布局.json', node_class: 'CLIPTextEncode', node_id: 6, role: '正向', status: 'candidate' },
          created_at: '2026-10-03T09:00:00.000Z', updated_at: '2026-10-03T09:00:00.000Z' }
      ]
    }));

    const panel3 = createPanel(app, { api, workflowName: () => '阶段二自测工作流.json' });
    const host3 = dom.document.createElement('div');
    dom.document.body.appendChild(host3);
    panel3.mount(host3);
    await tick(4);
    const $3 = (sel) => host3.querySelectorAll(sel);
    const seg = $3('.pp-seg-btn');

    check('第 1 行：品牌名 Prompt Library + 低优先级版本号',
      host3.querySelector('.pp-title')?.textContent === 'Prompt Library' && !!host3.querySelector('.pp-ver'));
    check('第 2 行：统一的页面切换控件（两个分段按钮）', seg.length === 2 && /探针/.test(seg[0].textContent) && /我的收藏/.test(seg[1].textContent));
    check('探针页工具条只放探针页操作（重新扫描 / 收藏），不含导出',
      /重新扫描/.test(host3.querySelector('.pp-toolbar').textContent) && !/导出/.test(host3.querySelector('.pp-toolbar').textContent));

    seg[1].click();
    await tick(6);
    const tbText = host3.querySelector('.pp-toolbar').textContent;
    check('收藏页工具条只放收藏页操作（搜索 / 筛选 / 刷新 / 导出），不含重新扫描',
      /导出/.test(tbText) && /刷新/.test(tbText) && !/重新扫描/.test(tbText));
    check('收藏页搜索框与筛选器位于顶部工具条内', !!host3.querySelector('.pp-toolbar .pp-lib-toolbar input') && !!host3.querySelector('.pp-toolbar .pp-lib-toolbar select'));

    const lcard = host3.querySelector('.pp-lib-item');
    check('收藏卡片第 1 行：标题 + 模型标签', !!lcard.querySelector('.pp-lib-line1 .pp-lib-title') && !!lcard.querySelector('.pp-lib-line1 .pp-badge-model'));
    check('收藏卡片第 2 行：状态 + 字数 + 收藏时间',
      !!lcard.querySelector('.pp-lib-meta .pp-badge') && /字/.test(lcard.querySelector('.pp-lib-meta').textContent) && /收藏于/.test(lcard.querySelector('.pp-lib-meta').textContent));
    check('收藏卡片第 3 行：来源工作流与节点', /来源：/.test(lcard.querySelector('.pp-lib-src')?.textContent || ''));
    check('收藏卡片第 4 行：预览（CSS 3 行截断）', !!lcard.querySelector('.pp-lib-preview'));
    check('收藏卡片底部：查看完整 / 编辑 / 复制 / 删除',
      ['查看完整', '编辑', '复制', '删除'].every((l) => [...lcard.querySelectorAll('button')].some((b) => b.textContent.includes(l))));

    seg[0].click();
    await tick();
    const scard = host3.querySelector('.pp-field.pp-selectable');
    check('探针卡片：默认是折叠预览（.pp-clamp）', !!scard.querySelector('.pp-clamp'));
    check('探针卡片：保留识别信息（技术详情里含取值链）',
      !!scard.querySelector('.pp-details') && scard.querySelectorAll('.pp-details').length >= 1);
    const expandBtn = [...scard.querySelectorAll('button')].find((b) => b.textContent.includes('展开全文'));
    check('探针卡片有「展开全文」按钮', !!expandBtn);
    expandBtn?.click();
    await tick();
    check('点展开后不再是折叠状态', !host3.querySelector('.pp-field.pp-selectable .pp-clamp'));
    const collapseBtn = [...host3.querySelector('.pp-field.pp-selectable').querySelectorAll('button')].find((b) => b.textContent.includes('收起'));
    collapseBtn?.click();
    await tick();
    check('点收起后恢复折叠', !!host3.querySelector('.pp-field.pp-selectable .pp-clamp'));

    const inlineHeights = $3('*').filter((el) => /(^|;)\s*height\s*:/.test(el.getAttribute?.('style') || '')).length;
    check('没有用行内固定高度硬撑布局（避免互相覆盖）', inlineHeights === 0, `inlineH=${inlineHeights}`);
    check('页脚保留安全说明且只有一行', $3('.pp-foot').length === 1 && host3.querySelector('.pp-foot').textContent.length < 60);
    check('三个阶段解析结果未变（三种模型链仍在）', panel3.state.result.chains.length === 3 && panel3.state.result.candidates.length === 1);
  }

  head('汇总');
  console.log(`断言：通过 ${results.pass} · 失败 ${results.fail}`);
  console.log('说明：本自测用内存假 api + 假画布，不联网、不读写真实收藏数据、不修改任何工作流文件。');
  dom.restore();
  process.exitCode = results.fail ? 1 : 0;
}

main().catch((e) => {
  console.error('\n自测无法完成：', e);
  process.exitCode = 2;
});
