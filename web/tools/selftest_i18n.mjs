/**
 * selftest_i18n.mjs —— 多语言 / 回退 / 旧数据兼容 / 侧边栏标签 自测
 *
 * 覆盖（全部在内存里跑，不联网、不写用户数据）：
 *   A. 词典完整性：en/zh 键集合一致、占位符一致、生成物 locales/<lang>/main.json 与词典一致
 *   B. 取词器：en/zh 取词、占位符填充、含花括号文案不被当变量、语言码归一化、fmt 递归
 *   C. 服务器译文：/api/i18n 成功合并 / 404 / 抛错 / 坏结构 / 超时 / 无 api
 *   D. 语言切换：面板文案跟着变、订阅者只触发一次、界面不出现裸键名
 *   E. 旧数据兼容：role / status_text 是中文的老收藏条目照常显示、且不被改写
 *   F. 侧边栏标签：真跑 prompt_probe.js 的注册流程，切换语言后 title/tooltip/label 同步更新
 *   G. 健壮性：无 api / 空数据 / 反复切换刷新都不崩
 *
 * 运行：node web/tools/selftest_i18n.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installMinidom } from './minidom.mjs';
import { makeMockApp } from '../../devtools/mock-app.mjs';

const dom = installMinidom();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const I18N = await import('../probe/i18n.mjs');
const { EN } = await import('../probe/i18n-en.mjs');
const { ZH } = await import('../probe/i18n-zh.mjs');
const { createPanel } = await import('../probe/panel.mjs');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✔ PASS  ${name}`);
  } else {
    failures.push(name + (detail ? `  —  ${detail}` : ''));
    console.log(`  ✘ FAIL  ${name}${detail ? `  —  ${detail}` : ''}`);
  }
}
const head = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const tick = (n = 2) => new Promise((r) => { let i = 0; const step = () => (++i >= n ? r() : setTimeout(step, 0)); step(); });

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};

const placeholders = (s) => [...String(s).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort();

/** 裸键名特征：形如 btn.save / status.confirmed 的标识符点号串 */
const looksLikeKey = (text) => /\b(btn|tab|seg|status|role|mode|meta|src|empty|notice|form|filter|sort|err|warn|probe|art|lora|dlg|lbl|ph|core)\.[a-zA-Z0-9_]+/.test(String(text));

function makeFakeApi() {
  const files = new Map();
  return {
    files,
    async fetchApi(url, opts = {}) {
      const m = /^\/userdata\/(.+)$/.exec(url);
      const key = m ? decodeURIComponent(m[1]) : url;
      if (!opts || opts.method !== 'POST') {
        if (!files.has(key)) return { ok: false, status: 404, async text() { return 'not found'; }, async json() { return null; } };
        return {
          ok: true,
          status: 200,
          async text() { return files.get(key); },
          async json() { return JSON.parse(files.get(key)); }
        };
      }
      files.set(key, String(opts.body));
      return { ok: true, status: 200, async json() { return { path: key }; }, async text() { return ''; } };
    }
  };
}

/* ================================================================== *
 * A. 词典完整性
 * ================================================================== */
head('A · 词典完整性（键集合 / 占位符 / 生成物一致）');
{
  const en = flatten(EN);
  const zh = flatten(ZH);
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();

  const missingZh = enKeys.filter((k) => !(k in zh));
  const extraZh = zhKeys.filter((k) => !(k in en));
  check('中文词典覆盖英文全部键', missingZh.length === 0, `缺 ${missingZh.slice(0, 6).join(', ')}`);
  check('中文词典没有多余键', extraZh.length === 0, `多 ${extraZh.slice(0, 6).join(', ')}`);
  check('英文词典条目 > 200（完整词典，不是占位）', enKeys.length > 200, `keys=${enKeys.length}`);

  const badPh = [];
  for (const k of enKeys) {
    if (typeof en[k] !== 'string' || typeof zh[k] !== 'string') continue;
    if (placeholders(en[k]).join(',') !== placeholders(zh[k]).join(',')) badPh.push(k);
  }
  check('中英文占位符完全对应（不会漏掉 {n}）', badPh.length === 0, badPh.slice(0, 6).join(', '));

  for (const [lang, dict] of [['en', EN], ['zh', ZH]]) {
    const file = path.join(ROOT, 'locales', lang, 'main.json');
    let ok = false;
    let detail = '';
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      ok = JSON.stringify(raw[I18N.NS]) === JSON.stringify(dict);
      detail = ok ? '' : '与 JS 词典不一致（请跑 node web/tools/gen_locales.mjs）';
    } catch (e) {
      detail = `读不到或非法 JSON：${e.message}`;
    }
    check(`locales/${lang}/main.json 存在且与词典一致`, ok, detail);
    check(`locales/${lang}/main.json 带 promptLibrary 命名空间`, !!(raw && raw[I18N.NS]));
  }

  check('英文词典里没有中文（源语言纯净）', !/[\u4e00-\u9fff]/.test(JSON.stringify(EN)));
}

/* ================================================================== *
 * B. 取词器
 * ================================================================== */
head('B · 取词器（t / fmt / normalizeLocale / deepMerge）');
{
  I18N.__resetForTest();

  check('默认语言为英文', I18N.getLocale() === 'en');
  check('英文取词', I18N.t('btn.save') === 'Save', I18N.t('btn.save'));
  check('英文占位符', I18N.t('meta.chars', { n: 12 }) === '12 chars', I18N.t('meta.chars', { n: 12 }));

  I18N.applyLocale('zh');
  check('切到中文', I18N.getLocale() === 'zh');
  check('中文取词', I18N.t('btn.save') === '保存', I18N.t('btn.save'));
  check('中文占位符', I18N.t('meta.chars', { n: 12 }) === '12 字', I18N.t('meta.chars', { n: 12 }));
  check('含花括号的文案原样保留（不被当成变量）',
    I18N.t('err.importNoItems').includes('{version, items:[...]}'), I18N.t('err.importNoItems'));
  check('含 {a|b} 的说明原样保留',
    I18N.t('core.wildcardBrace').includes('{a|b}'), I18N.t('core.wildcardBrace'));
  check('状态码取词（zh）', I18N.t('status.confirmed') === '已确认');
  check('角色码取词（zh）', I18N.t('role.negative') === '负向');
  check('mode 数字键取词（zh）', I18N.t('mode.4') === '绕过(bypass)', I18N.t('mode.4'));

  check('zh-CN → zh', I18N.normalizeLocale('zh-CN') === 'zh');
  check('ZH_hans → zh', I18N.normalizeLocale('ZH_hans') === 'zh');
  check('zh-TW 回退英文（暂不支持繁体）', I18N.normalizeLocale('zh-TW') === 'en');
  check('ja 回退英文', I18N.normalizeLocale('ja') === 'en');
  check('空值/null 回退英文', I18N.normalizeLocale('') === 'en' && I18N.normalizeLocale(null) === 'en');

  check('fmt 传字符串原样返回', I18N.fmt('hello') === 'hello');
  check('fmt 传 null 返回空串', I18N.fmt(null) === '');
  check('fmt 渲染结构化文案', I18N.fmt({ code: 'core.cycle', params: { id: 7 } }) === '检测到循环引用（节点 #7）',
    I18N.fmt({ code: 'core.cycle', params: { id: 7 } }));
  check('fmt 递归渲染嵌套文案',
    I18N.fmt(I18N.msg('pathFieldLink', {
      field: 'text',
      sep: { code: 'core.pathJoin', params: {} },
      inner: { code: 'core.upstream', params: {} }
    })) === 'text ← 上游');
  check('fmt 渲染数组', I18N.fmt(['a', { code: 'core.upstream', params: {} }]) === 'a; 上游',
    I18N.fmt(['a', { code: 'core.upstream', params: {} }]));

  const merged = I18N.deepMerge(EN, { btn: { save: 'SAVE!' } });
  check('deepMerge 只覆盖指定键', merged.btn.save === 'SAVE!' && merged.btn.cancel === EN.btn.cancel);
  check('deepMerge 不破坏嵌套',
    typeof merged.core.why === 'object' && merged.core.why.clipLlm === EN.core.why.clipLlm);
}

/* ================================================================== *
 * C. 服务器译文加载
 * ================================================================== */
head('C · 服务器译文加载与回退');
{
  I18N.__resetForTest();
  const okApi = { async getCustomNodesI18n() { return { zh: { [I18N.NS]: { btn: { save: '保存!' } } } }; } };
  let r = await I18N.loadTranslations(okApi);
  check('成功加载返回 ok', r.ok === true, JSON.stringify(r));
  I18N.applyLocale('zh');
  check('服务器译文覆盖生效', I18N.t('btn.save') === '保存!', I18N.t('btn.save'));
  check('服务器未给的键仍用内置中文', I18N.t('btn.cancel') === '取消', I18N.t('btn.cancel'));

  I18N.__resetForTest();
  r = await I18N.loadTranslations({ async fetchApi() { return { ok: false, status: 404 }; } });
  check('404 不抛异常且标记失败', r.ok === false && /404/.test(r.reason || ''), JSON.stringify(r));
  I18N.applyLocale('zh');
  check('404 后中文仍可用（内置词典兜底）', I18N.t('btn.save') === '保存');

  I18N.__resetForTest();
  r = await I18N.loadTranslations({ async getCustomNodesI18n() { throw new Error('boom'); } });
  check('加载抛错被吞掉', r.ok === false, JSON.stringify(r));

  I18N.__resetForTest();
  r = await I18N.loadTranslations({ async getCustomNodesI18n() { return [1, 2, 3]; } });
  check('非对象 payload 视为失败', r.ok === false, JSON.stringify(r));

  I18N.__resetForTest();
  r = await I18N.loadTranslations({ async getCustomNodesI18n() { return { zh: { otherPlugin: { x: 'y' } } }; } });
  check('没有我们命名空间时不污染词典', r.ok === true && I18N.t('btn.save') === 'Save');

  I18N.__resetForTest();
  const t0 = Date.now();
  r = await I18N.loadTranslations({ getCustomNodesI18n: () => new Promise(() => {}) }, { timeoutMs: 60 });
  check('接口挂住时超时回退（不阻塞启动）',
    r.ok === false && /timeout/.test(r.reason || ''), `${Date.now() - t0}ms ${JSON.stringify(r)}`);

  I18N.__resetForTest();
  r = await I18N.loadTranslations(null);
  check('没有 api 也不报错', r.ok === false && r.reason === 'no-api');

  I18N.__resetForTest();
  await I18N.loadTranslations({ async getCustomNodesI18n() { return { 'zh-TW': { [I18N.NS]: { btn: { save: '儲存' } } } }; } });
  I18N.applyLocale('zh-TW');
  check('zh-TW 译文不会串到简体（回退英文）', I18N.t('btn.save') === 'Save', I18N.t('btn.save'));
}

/* ================================================================== *
 * D. 语言切换 + 面板文案 + 无裸键
 * ================================================================== */
head('D · 语言切换与面板文案');
{
  I18N.__resetForTest();
  const app = makeMockApp({ nodes: [], links: [] }, {});
  const api = makeFakeApi();
  const panel = createPanel(app, { api, version: '0.5.0' });
  const host = document.createElement('div');
  document.body.appendChild(host);

  I18N.applyLocale('zh');
  panel.mount(host);
  await tick(3);

  const zhText = host.textContent;
  check('中文界面：页签是「探针」', zhText.includes('探针'), zhText.slice(0, 40));
  check('中文界面：工具条是「重新扫描」', zhText.includes('重新扫描'));
  check('中文界面：底部说明是中文', zhText.includes('只读探针'));
  check('中文界面没有裸露键名', !looksLikeKey(zhText), (zhText.match(/\b(btn|tab|seg|status)\.[a-zA-Z0-9_.]+/) || [''])[0]);

  I18N.applyLocale('en');
  panel.refreshTexts();
  await tick(3);
  const enText = host.textContent;
  check('切英文后页签变 Probe', enText.includes('Probe'), enText.slice(0, 40));
  check('切英文后不再出现「重新扫描」', !enText.includes('重新扫描'));
  check('切英文后版本行是英文', /Probe \/ Favorites \/ Artists/.test(enText), enText.slice(0, 80));
  check('英文界面没有裸露键名', !looksLikeKey(enText), (enText.match(/\b(btn|tab|seg|status)\.[a-zA-Z0-9_.]+/) || [''])[0]);

  I18N.applyLocale('zh');
  panel.refreshTexts();
  await tick(3);
  check('切回中文后页签恢复「探针」', host.textContent.includes('探针'));

  let calls = 0;
  const off = I18N.onLocaleChange(() => { calls += 1; });
  I18N.applyLocale('en');
  I18N.applyLocale('zh');
  off();
  I18N.applyLocale('en');
  check('语言变化会通知订阅者，解绑后不再通知', calls === 2, `calls=${calls}`);

  panel.destroy();
  I18N.applyLocale('en');
}

/* ================================================================== *
 * E. 旧数据兼容
 * ================================================================== */
head('E · 旧收藏数据兼容（role / status_text 是中文的老条目）');
{
  I18N.__resetForTest();
  I18N.applyLocale('zh');
  const app = makeMockApp({ nodes: [], links: [] }, {});
  const api = makeFakeApi();

  const legacy = {
    version: 2,
    rev: 3,
    models: ['Anima'],
    updated_at: '2026-10-01T00:00:00.000Z',
    items: [{
      id: 'legacy-1',
      title: '老条目（中文 role）',
      model: 'Anima',
      text: 'masterpiece, best quality',
      source: {
        workflow: 'old.json',
        node_id: 5,
        node_class: 'CLIPTextEncode',
        field: 'text',
        role: '正向',
        status: 'confirmed',
        status_text: '已确认',
        sampler: 'KSampler #1',
        group: '',
        collected_at: '2026-10-01T00:00:00.000Z'
      },
      use_count: 2,
      last_used_at: '2026-10-02T00:00:00.000Z',
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z'
    }, {
      id: 'legacy-2',
      title: '候选老条目',
      model: 'Anima',
      text: 'another prompt',
      source: {
        workflow: 'old.json',
        node_id: 9,
        node_class: 'CLIPTextEncode',
        field: 'text',
        role: '候选',
        status: 'candidate',
        status_text: '候选文本'
      },
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z'
    }]
  };
  api.files.set('prompt_library/library.json', JSON.stringify(legacy));

  const panel = createPanel(app, { api, version: '0.5.0' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  panel.mount(host);
  await tick(4);

  panel.setView('library');
  await tick(4);

  const text = host.textContent;
  check('老条目正常出现在列表', text.includes('老条目（中文 role）') && text.includes('候选老条目'));
  check('老条目的中文 role 按当前语言显示（正向）', text.includes('正向'), text.slice(0, 200));
  check('老条目状态显示「已确认」', text.includes('已确认'));
  check('老条目没有被改写：磁盘里 role 仍是「正向」',
    JSON.parse(api.files.get('prompt_library/library.json')).items[0].source.role === '正向');
  check('老条目已加载进内存且结构完整',
    panel.state.library.items.length === 2
    && panel.state.library.items[0].source.status === 'confirmed');
  check('中文下老数据没有裸键泄漏', !looksLikeKey(text));

  I18N.applyLocale('en');
  panel.refreshTexts();
  await tick(3);
  panel.setView('library');
  await tick(4);
  const enText = host.textContent;
  check('英文下老条目 role 显示 Positive', /Positive/.test(enText), enText.slice(0, 220));
  check('英文下老条目状态显示 Confirmed', /Confirmed/.test(enText));
  check('英文下老数据没有裸键泄漏', !looksLikeKey(enText));

  // 编辑并保存老条目 → 结构不变、数据里不写界面文案
  const item = panel.state.library.items[0];
  const saved = await panel.persistItem({ ...item, title: 'old item renamed' });
  check('老条目可编辑保存', saved && saved.ok === true, JSON.stringify(saved));
  const disk = JSON.parse(api.files.get('prompt_library/library.json'));
  const savedItem = disk.items.find((x) => x.id === legacy.items[0].id);
  check('保存后条目仍在且标题已更新', !!savedItem && savedItem.title === 'old item renamed');
  check('保存后 JSON 结构不变（version/rev/items/models 都在）',
    disk.version !== undefined && typeof disk.rev === 'number' && Array.isArray(disk.items) && Array.isArray(disk.models));
  check('保存写入的 status_text 是稳定标识或原值（不是界面文案）',
    savedItem && ['confirmed', 'candidate', '已确认', '候选文本'].includes(String(savedItem.source.status_text)),
    String(savedItem && savedItem.source.status_text));

  // 新数据只写稳定标识（不写界面文案），且与语言无关
  const fresh = await panel.persistItem({
    id: undefined,
    title: 'new item',
    text: 'foo',
    source: {
      workflow: 'w.json', node_id: 1, node_class: 'CLIPTextEncode', field: 'text·seg1',
      role: 'positive', status: 'confirmed', status_text: 'confirmed',
      sampler: 'KSampler #1', group: '', collected_at: new Date().toISOString()
    }
  });
  const disk2 = JSON.parse(api.files.get('prompt_library/library.json'));
  const freshItem = disk2.items.find((x) => x.title === 'new item');
  check('新条目落库成功', !!(fresh && fresh.ok && freshItem));
  check('新条目 role/status_text 写的是稳定标识（positive / confirmed）',
    freshItem.source.role === 'positive' && freshItem.source.status_text === 'confirmed',
    `${freshItem.source.role} / ${freshItem.source.status_text}`);
  check('新条目落库内容和界面语言无关（英文下写入，中文下读出来一样）',
    !/[一-鿿]/.test(JSON.stringify(freshItem.source)), JSON.stringify(freshItem.source));

  I18N.applyLocale('zh');
  panel.refreshTexts();
  await tick(3);
  check('中文下新条目 role 显示「正向」', panel.state.library.items.some((x) => x.source.role === 'positive'));
  check('中英混存（老条目中文值 + 新条目稳定码）都能显示', panel.state.library.items.length === disk2.items.length);

  panel.destroy();
  I18N.applyLocale('en');
}

/* ================================================================== *
 * F. 侧边栏标签（真跑 prompt_probe.js 的注册流程）
 * ================================================================== */
head('F · 侧边栏标签注册与语言切换');
{
  I18N.__resetForTest();

  const tabs = [];
  const listeners = {};
  let locale = 'zh';
  const settingGet = (k) => (k === 'Comfy.Locale' ? locale : undefined);

  let extension = null;
  const app = {
    extensionManager: {
      registerSidebarTab: (tab) => tabs.push(tab),
      getSidebarTabs: () => tabs,
      setting: { get: settingGet }
    },
    ui: {
      settings: {
        getSettingValue: settingGet,
        addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
        removeEventListener: (ev, fn) => {
          const arr = listeners[ev] || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        }
      }
    },
    registerExtension: (ext) => { extension = ext; }
  };

  globalThis.window = {
    comfyAPI: {
      app: { app },
      api: { api: { async getCustomNodesI18n() { return null; } } }
    }
  };

  await import(`../prompt_probe.js?i18n=${Date.now()}`);
  await tick(3);

  check('prompt_probe.js 注册了扩展', !!extension && extension.name === 'ComfyUI.PromptLibrary.PromptProbe');
  await extension.setup();
  await tick(3);

  check('侧边栏标签已注册', tabs.length === 1, `tabs=${tabs.length}`);
  const tab = tabs[0] || {};
  check('标签标题是英文专名', tab.title === 'Prompt Library', String(tab.title));
  check('标签提示在中文环境下是中文', String(tab.tooltip).includes('提示词探针'), String(tab.tooltip));
  check('标签 label 为英文专名', tab.label === 'Prompt Library', String(tab.label));
  check('注册时没有裸露键名', !looksLikeKey(`${tab.title} ${tab.tooltip} ${tab.label}`));

  locale = 'en';
  for (const fn of [...(listeners['Comfy.Locale.change'] || [])]) fn({ detail: { value: 'en' } });
  await tick(3);
  check('切英文后 tooltip 变英文',
    String(tab.tooltip) === 'Prompt Library · read-only prompt probe + local library', String(tab.tooltip));
  check('切英文后没有裸露键名', !looksLikeKey(`${tab.title} ${tab.tooltip} ${tab.label}`));

  locale = 'zh';
  for (const fn of [...(listeners['Comfy.Locale.change'] || [])]) fn({ detail: { value: 'zh' } });
  await tick(3);
  check('切回中文后 tooltip 恢复中文', String(tab.tooltip).includes('提示词探针'), String(tab.tooltip));

  locale = 'ja';
  for (const fn of [...(listeners['Comfy.Locale.change'] || [])]) fn({ detail: { value: 'ja' } });
  await tick(3);
  check('不支持的语种回退英文', String(tab.tooltip).includes('read-only prompt probe'), String(tab.tooltip));
  check('不支持语种也没有裸露键名', !looksLikeKey(`${tab.title} ${tab.tooltip} ${tab.label}`));

  delete globalThis.window;
  I18N.applyLocale('en');
}

/* ================================================================== *
 * G. 健壮性
 * ================================================================== */
head('G · 健壮性（无 api / 空数据 / 反复刷新）');
{
  I18N.__resetForTest();
  I18N.applyLocale('zh');
  const app = makeMockApp({ nodes: [], links: [] }, {});
  const panel = createPanel(app, { api: null, version: '0.5.0' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  panel.mount(host);
  await tick(3);
  check('没有 api 时面板仍渲染（不白屏）', !!host.querySelector('.pp-root') && host.textContent.includes('探针'));
  panel.setView('library');
  await tick(3);
  check('没有 api 时收藏页给出可读提示（未取到 API）', /API/.test(host.textContent), host.textContent.slice(0, 80));
  check('没有 api 时没有裸键', !looksLikeKey(host.textContent));
  panel.setView('scan');
  await tick(2);

  for (let i = 0; i < 6; i += 1) {
    I18N.applyLocale(i % 2 ? 'zh' : 'en');
    panel.refreshTexts();
  }
  await tick(3);
  check('反复切换语言 + 刷新不崩溃、面板仍在', !!host.querySelector('.pp-root'));
  check('反复切换后仍无裸键泄漏', !looksLikeKey(host.textContent));

  panel.destroy();
  I18N.applyLocale('en');
}

/* ================================================================== *
 * H. 源码不再有写死的中文界面文案（回归闸门）
 * ================================================================== */
head('H · 源码里没有漏网的写死文案');
{
  const TARGETS = [
    'web/prompt_probe.js', 'web/probe/panel.mjs', 'web/probe/favorites.mjs',
    'web/probe/artists.mjs', 'web/probe/loras.mjs', 'web/probe/resolver.mjs',
    'web/probe/adapters.mjs', 'web/probe/library.mjs', 'web/probe/storage.mjs',
    'web/probe/i18n.mjs'
  ];
  const CJK = /[\u4e00-\u9fff]/;
  const STR = /`[^`]*`|'[^'\n]*'|"[^"\n]*"/g;
  const leaks = [];
  for (const rel of TARGETS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
      if (trimmed.startsWith('console.') || /^(warn|log)\(/.test(trimmed)) return;
      if (line.includes('LEGACY_ROLE')) return;
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      for (const hit of code.match(STR) || []) {
        if (CJK.test(hit)) leaks.push(`${rel}:${i + 1} ${hit.slice(0, 40)}`);
      }
    });
  }
  check('10 个目标文件里没有写死的中文界面文案', leaks.length === 0, leaks.slice(0, 5).join(' | '));
  check('中文词典确实是中文的来源', CJK.test(fs.readFileSync(path.join(ROOT, 'web/probe/i18n-zh.mjs'), 'utf8')));
}

/* ================================================================== *
 * I. 取值链真实渲染回归（历史缺陷 A / B）
 *
 * 缺陷 A：控件直写的取值链丢了节点号（`CLIPTextEncode.text` 而不是 `#9 CLIPTextEncode.text`）
 * 缺陷 B：多段拼接的取值链出现 `[object Object]`（把 m() 的结构化文案喂给了 Array.join）
 *
 * 这两条只有把面板真渲染出来、读 DOM 里的文字才能测到 —— 只查翻译键是否存在是测不出的。
 * 所以这里用 minidom + 假画布造两种图，读 `.pp-path` 的 textContent（就是用户看到的那行）。
 * ================================================================== */
head('I · 取值链渲染回归（缺陷 A：丢节点号 / 缺陷 B：[object Object]）');

/** 造一张假画布：graph 形状与 litegraph 一致（_nodes + links id->{origin_id}） */
function makeChainGraph({ directWidget, concat }) {
  const graph = { _nodes: [], links: {}, _groups: [] };
  const link = (id, from, slot = 0) => { graph.links[id] = { id, origin_id: from, origin_slot: slot }; };
  const node = (o) => { o.graph = graph; o.flags = o.flags || {}; o.mode = o.mode ?? 0; graph._nodes.push(o); return o; };

  if (directWidget) {
    // 采样器 #1 positive → link 2 → CLIPTextEncode #9，文本直接写在控件里（没有连线）
    link(2, 9);
    node({ id: 1, type: 'KSampler', inputs: [{ name: 'positive', link: 2 }, { name: 'negative', link: null }], widgets: [{ name: 'seed', value: 1 }] });
    node({ id: 9, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: null }, { name: 'text', link: null }], widgets: [{ name: 'text', value: 'widget written prompt' }] });
  }

  if (concat) {
    // 采样器 #20 positive →(link 11) CLIPTextEncode #30
    // CLIPTextEncode #30 的 text ←(link 12) StringConcatenate #10
    // StringConcatenate #10 的 string_a ←(link 13) #21，string_b ←(link 14) #23
    link(11, 30); link(12, 10); link(13, 21); link(14, 23);
    node({ id: 20, type: 'KSampler', inputs: [{ name: 'positive', link: 11 }, { name: 'negative', link: null }], widgets: [{ name: 'seed', value: 2 }] });
    node({ id: 30, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: null }, { name: 'text', link: 12 }], widgets: [] });
    node({ id: 10, type: 'StringConcatenate', title: '质量词 + 主体词', inputs: [{ name: 'string_a', link: 13 }, { name: 'string_b', link: 14 }, { name: 'delimiter', link: null }], widgets: [{ name: 'delimiter', value: ', ' }] });
    node({ id: 21, type: 'PrimitiveStringMultiline', inputs: [], widgets: [{ name: 'value', value: 'best quality' }] });
    node({ id: 23, type: 'PrimitiveStringMultiline', inputs: [], widgets: [{ name: 'value', value: '1girl, solo' }] });
  }

  return { rootGraph: graph, graph };
}

/** 渲染一张图，返回所有「取值链」那一行的文字（用户实际看到的字符串） */
async function renderValueChains(graph, lang) {
  I18N.applyLocale(lang);
  const panel = createPanel(graph, { api: null, workflowName: () => '取值链自测.json' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  panel.mount(host);
  await tick(4);
  // 展开「技术详情」并不需要：details 里的文字同样在 DOM 里
  const lines = [...host.querySelectorAll('.pp-path')].map((el) => el.textContent);
  const whole = host.textContent;
  panel.destroy();
  return { lines, whole };
}

{
  /* ---------- 缺陷 A：控件直写要带节点号 ---------- */
  const gA = makeChainGraph({ directWidget: true });
  const zhA = await renderValueChains(gA, 'zh');
  const enA = await renderValueChains(gA, 'en');

  const zhDirect = zhA.lines.find((x) => x.includes('控件内直接写入')) || '';
  const enDirect = enA.lines.find((x) => x.toLowerCase().includes('written directly')) || '';

  check('缺陷A·中文：取值链渲染出了「控件内直接写入」那一行', !!zhDirect, zhA.lines.join(' | ').slice(0, 160));
  check('缺陷A·中文：带节点号 #9（不是只有 CLIPTextEncode.text）', zhDirect.includes('#9 CLIPTextEncode.text'),
    JSON.stringify(zhDirect));
  check('缺陷A·中文：格式与改造前一致（#9 CLIPTextEncode.text（控件内直接写入））',
    zhDirect === '取值链：#9 CLIPTextEncode.text（控件内直接写入）', JSON.stringify(zhDirect));

  check('缺陷A·英文：取值链渲染出了 written directly 那一行', !!enDirect, enA.lines.join(' | ').slice(0, 160));
  check('缺陷A·英文：带节点号 #9', enDirect.includes('#9 CLIPTextEncode.text'), JSON.stringify(enDirect));
  check('缺陷A·英文：格式正确（Value chain: #9 CLIPTextEncode.text (written directly in the widget)）',
    enDirect === 'Value chain: #9 CLIPTextEncode.text (written directly in the widget)', JSON.stringify(enDirect));

  /* ---------- 缺陷 B：多段拼接不能出现 [object Object] ---------- */
  const gB = makeChainGraph({ concat: true });
  const zhB = await renderValueChains(gB, 'zh');
  const enB = await renderValueChains(gB, 'en');

  const zhConcat = zhB.lines.find((x) => x.includes('StringConcatenate')) || '';
  const enConcat = enB.lines.find((x) => x.includes('StringConcatenate')) || '';

  check('缺陷B·中文：渲染出了 StringConcatenate 的取值链', !!zhConcat, zhB.lines.join(' | ').slice(0, 160));
  check('缺陷B·中文：不含 [object Object]', !zhB.whole.includes('[object Object]'),
    (zhB.whole.match(/.{0,60}\[object Object\].{0,40}/) || [''])[0]);
  check('缺陷B·中文：分段名用「 + 」连接（string_a + string_b）', zhConcat.includes('string_a + string_b'),
    JSON.stringify(zhConcat));

  check('缺陷B·英文：渲染出了 StringConcatenate 的取值链', !!enConcat, enB.lines.join(' | ').slice(0, 160));
  check('缺陷B·英文：不含 [object Object]', !enB.whole.includes('[object Object]'),
    (enB.whole.match(/.{0,60}\[object Object\].{0,40}/) || [''])[0]);
  check('缺陷B·英文：分段名用「 + 」连接（string_a + string_b）', enConcat.includes('string_a + string_b'),
    JSON.stringify(enConcat));

  /* ---------- 兜底：整块界面任何语言都不该出现 [object Object] ---------- */
  const gBoth = makeChainGraph({ directWidget: true, concat: true });
  for (const lang of ['zh', 'en']) {
    const r = await renderValueChains(gBoth, lang);
    check(`两张图混在一起渲染也没有 [object Object]（${lang}）`, !r.whole.includes('[object Object]'));
  }

  I18N.applyLocale('en');
}

/* ================================================================== */
console.log(`\n${'='.repeat(78)}\n汇总\n${'='.repeat(78)}`);
console.log(`断言：通过 ${pass} · 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('说明：本自测全部在内存里（假 api + minidom + 假 app），不联网、不读写真实收藏数据。');
if (dom && typeof dom.restore === 'function') dom.restore();
process.exit(failures.length ? 1 : 0);
