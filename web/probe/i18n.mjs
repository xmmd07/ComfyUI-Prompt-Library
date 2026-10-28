/**
 * i18n.mjs —— 取词器（纯 JS，无 DOM 依赖，可在 Node 自测里直接 import）
 *
 * 依据（本机 ComfyUI 0.42.3 + 前端 1.55.18 实测，非猜测）：
 *   1. 后端 `app/custom_node_manager.py` 只读 `custom_nodes/<插件>/locales/<lang>/main.json`
 *      （另加 nodeDefs/commands/settings 三个），合并后由 `GET /api/i18n` 返回
 *      `{ "<lang>": { ...main.json 的键... } }`；多个插件的 main.json 会被递归合并，
 *      所以必须把自己的键挂在唯一命名空间 `promptLibrary` 下。
 *   2. 前端 `bootstrapStore` 启动时 `api.getCustomNodesI18n()`（axios，`/api/i18n`）
 *      再 `mergeCustomNodesI18n()` 塞进 vue-i18n；**该调用是 fire-and-forget**，
 *      所以侧边栏注册时可能还没回来 → 必须有本地兜底（EN 随代码加载）。
 *   3. 接口 404 被视为"没有自定义节点译文"而非错误（前端源码注释原文如此）→ 我们也静默兜底。
 *   4. 当前语言：`Comfy.Locale` 设置项；语言切换会触发 `Comfy.Locale.change` 事件
 *      （`app.ui.settings.dispatchChange()` → `dispatchEvent(new CustomEvent(id + '.change'))`）。
 *   5. 前端拿不到我们的内部 `t()`（没有 `window.comfyAPI.i18n`），自定义 DOM 面板只能自己取词；
 *      本模块就是那一层。**不经过 vue-i18n 编译器**，所以文案里出现 `{` `}` `@` 都安全。
 *
 * 关键保证：任何失败（接口 404 / 网络错 / 缺键 / 没有 app）都不抛异常、不返回裸露键名。
 */

import { EN } from './i18n-en.mjs';
import { ZH } from './i18n-zh.mjs';

export const NS = 'promptLibrary';

/** 当前支持的语言（其余一律回退英文） */
export const SUPPORTED_LOCALES = ['en', 'zh'];

/**
 * 语言码 → 我们支持的词典。**只有** en / zh 命中；
 * `zh-TW`、`ja`、`ko` 等一律回退英文（按已确认方案：先只支持英文与简体中文）。
 */
const LOCALE_FALLBACK = {
  en: 'en', 'en-us': 'en', 'en-gb': 'en', 'en-au': 'en', 'en-ca': 'en',
  zh: 'zh', 'zh-cn': 'zh', 'zh-hans': 'zh', 'zh-sg': 'zh'
};

let currentLocale = 'en';
/** 各语言的词典（基线 + 服务器覆盖）——BASE 在工具函数之后定义 */
/** 原始服务器数据（全语言一次拿全，切换语言无需再请求） */
let serverData = null;
let serverLoaded = false;
/** 语言变化的订阅者 */
const listeners = new Set();
/** 缺失键只警告一次，避免刷屏 */
const warned = new Set();

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 深合并：base 为底（英文），over 为覆盖（服务器译文）；只覆盖字符串叶子 */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 把 `zh-CN` / `ZH` 之类规范成我们支持的语言码；其余（含 zh-TW / ja / ko）一律 'en' */
export function normalizeLocale(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return 'en';
  return LOCALE_FALLBACK[s] || 'en';
}

/** 按点号取嵌套值，取不到返回 undefined */
export function lookup(table, dottedKey) {
  if (!isPlainObject(table) || !dottedKey) return undefined;
  let cur = table;
  for (const seg of String(dottedKey).split('.')) {
    if (!isPlainObject(cur) && typeof cur !== 'object') return undefined;
    cur = cur?.[seg];
    if (cur === undefined) return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * 填充占位符。只替换 `{bare_identifier}`：
 * `{version, items:[...]}`、`{a|b}` 这类字面量不会被误当成变量。
 */
export function interpolate(template, params) {
  const s = String(template ?? '');
  if (!params) return s;
  return s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * 随代码一起加载的基线词典。中文也内置，所以：
 *   `/api/i18n` 404、网络失败、启动竞态 → 中文用户看到的仍是中文，不是英文、更不是键名。
 * 服务器译文（locales/<lang>/main.json）在此之上覆盖，方便用户/译者改文案而不改代码。
 */
const BASE = {
  en: EN,
  zh: deepMerge(EN, ZH)
};

/** 各语言的词典（基线 + 服务器覆盖） */
const tables = { en: BASE.en, zh: BASE.zh };

/* ------------------------------------------------------------------ *
 * 取词
 * ------------------------------------------------------------------ */

/**
 * 取词。查表顺序：当前语言 → 英文 → 键名本身（附一次 console.warn）。
 * @param {string} key 例 `btn.save`、`seg.library`
 * @param {object} [params] 占位符参数
 */
export function t(key, params) {
  const table = tables[currentLocale] || BASE.en;
  let s = lookup(table, key);
  if (s === undefined && table !== BASE.en) s = lookup(BASE.en, key);
  if (s === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[Prompt Library] missing i18n key: ${key}`);
    }
    return String(key);
  }
  if (params) {
    const resolved = {};
    for (const [k, v] of Object.entries(params)) resolved[k] = fmt(v);
    return interpolate(s, resolved);
  }
  return s;
}

/**
 * 构造结构化文案 `{ code, params }`（解析核心用：只产出 code + 参数，不产出语言）
 * @param {string} code 词典里的键（不带 `core.` 前缀）
 * @param {object} [params]
 */
export function msg(code, params) {
  return { code: `core.${code}`, params: params || {} };
}

/** 把「字符串 / 结构化文案 / null」统一渲染成字符串 */
export function fmt(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(fmt).join('; ');
  if (typeof value === 'object' && typeof value.code === 'string') {
    const params = {};
    for (const [k, v] of Object.entries(value.params || {})) params[k] = fmt(v);
    return t(value.code, params);
  }
  return String(value);
}

/* ------------------------------------------------------------------ *
 * 语言状态
 * ------------------------------------------------------------------ */

export function getLocale() {
  return currentLocale;
}

/** 切换当前语言（内部用；对外用 applyLocale 更安全） */
export function setLocaleForTest(locale) {
  currentLocale = normalizeLocale(locale);
  if (!tables[currentLocale]) tables[currentLocale] = BASE[currentLocale] || BASE.en;
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitChange() {
  for (const fn of [...listeners]) {
    try { fn(currentLocale); } catch (e) { console.warn('[Prompt Library] locale listener failed', e); }
  }
}

/* ------------------------------------------------------------------ *
 * 读取 ComfyUI 的当前语言
 * ------------------------------------------------------------------ */

/** 从 app 读 `Comfy.Locale`（新老两条路都试，任一失败都不抛） */
export function readAppLocale(app) {
  try {
    const v = app?.extensionManager?.setting?.get?.('Comfy.Locale')
      ?? app?.ui?.settings?.getSettingValue?.('Comfy.Locale');
    if (v) return normalizeLocale(v);
  } catch (e) { /* 忽略：设置项不可用时回退 */ }
  try {
    return normalizeLocale(navigator?.languages?.[0] || navigator?.language || 'en');
  } catch (e) {
    return 'en';
  }
}

/** 订阅 ComfyUI 的语言切换事件（`Comfy.Locale.change`，前端源码里确实会派发） */
export function watchAppLocale(app, onChange) {
  try {
    const target = app?.ui?.settings;
    if (!target?.addEventListener) return () => {};
    const handler = () => {
      const next = readAppLocale(app);
      if (next === currentLocale) return;
      applyLocale(next);
      try { onChange?.(next); } catch (e) { console.warn('[Prompt Library] locale change handler failed', e); }
    };
    target.addEventListener('Comfy.Locale.change', handler);
    return () => { try { target.removeEventListener('Comfy.Locale.change', handler); } catch (e) { /* 忽略 */ } };
  } catch (e) {
    return () => {};
  }
}

/** 应用语言（若该语言无词典就回退英文并通知） */
export function applyLocale(locale) {
  const next = normalizeLocale(locale);
  currentLocale = next;
  if (!tables[next]) tables[next] = BASE[next] || BASE.en;
  emitChange();
  return next;
}

/* ------------------------------------------------------------------ *
 * 加载翻译
 * ------------------------------------------------------------------ */

/**
 * 从 `/api/i18n` 一次性拿全部语言的译文并建表。
 * 任何失败都静默（404 = 老后端/没装 locales；网络错 = 用英文继续）。
 *
 * @param {object} [api] `window.comfyAPI.api.api`
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function loadTranslations(api, { timeoutMs = 3000 } = {}) {
  if (serverLoaded) return { ok: true, reason: 'cached' };
  if (!api) return { ok: false, reason: 'no-api' };
  let payload = null;
  try {
    if (typeof api.getCustomNodesI18n === 'function') {
      // 服务器挂着时不能拖死面板：超过 timeoutMs 就当没有译文（内置词典兜底）
      payload = await Promise.race([
        api.getCustomNodesI18n(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
      ]);
    } else if (typeof api.fetchApi === 'function') {
      const res = await api.fetchApi('/i18n');
      if (!res?.ok) return { ok: false, reason: `http-${res?.status ?? '?'}` };
      payload = await res.json();
    } else {
      return { ok: false, reason: 'no-fetch' };
    }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  if (!isPlainObject(payload)) return { ok: false, reason: 'bad-payload' };

  serverData = payload;
  serverLoaded = true;
  for (const [lang, dict] of Object.entries(payload)) {
    // 只接受我们真正支持的语言码：`zh-TW` 之类归一化后是 en，
    // 直接用它会把繁体译文写进英文词典（会串语言），所以看原始码是否受支持。
    const raw = String(lang || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(LOCALE_FALLBACK, raw)) continue;
    const code = LOCALE_FALLBACK[raw];
    if (!SUPPORTED_LOCALES.includes(code)) continue;
    const ours = isPlainObject(dict) ? dict[NS] : null;
    if (!isPlainObject(ours)) continue;
    tables[code] = deepMerge(BASE[code] || BASE.en, ours);
  }
  emitChange();
  return { ok: true };
}

/** 初始化：读语言 + 加载译文 + 监听切换。返回解绑函数。 */
export async function initI18n({ api, app, onChange } = {}) {
  applyLocale(readAppLocale(app));
  const res = await loadTranslations(api);
  const unwatch = watchAppLocale(app, onChange);
  return { ...res, locale: currentLocale, unwatch };
}

/* ------------------------------------------------------------------ *
 * 自测用
 * ------------------------------------------------------------------ */

/** 清空运行时状态（Node 自测隔离用） */
export function __resetForTest() {
  currentLocale = 'en';
  for (const k of Object.keys(tables)) delete tables[k];
  tables.en = BASE.en;
  tables.zh = BASE.zh;
  serverData = null;
  serverLoaded = false;
  listeners.clear();
  warned.clear();
}

export function __serverData() {
  return serverData;
}
