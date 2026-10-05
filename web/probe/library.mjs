/**
 * library.mjs —— 收藏库的纯数据模型（无 DOM、无 IO，可被 Node 直接测试）
 *
 * 数据结构：
 * {
 *   version: 1,
 *   rev: 3,                     // 每次写入 +1，用于发现"磁盘上的比我手里的新"
 *   updated_at: "ISO",
 *   models: ["Anima", "Krea 2", "Qwen Image 2.1"],   // 分类可自行增加
 *   items: [{
 *     id, title, model, text,
 *     source: { workflow, node_id, node_class, field, role, status, status_text },
 *     created_at, updated_at
 *   }]
 * }
 */

export const LIBRARY_VERSION = 1;
export const DEFAULT_MODELS = ['Anima', 'Krea 2', 'Qwen Image 2.1'];

export function newId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (e) {
    /* 忽略 */
  }
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function emptyLibrary() {
  return {
    version: LIBRARY_VERSION,
    rev: 0,
    updated_at: nowISO(),
    models: DEFAULT_MODELS.slice(),
    items: []
  };
}

/** 归一化：容忍缺字段/类型不对的文件内容，绝不让脏数据把界面搞崩 */
export function normalizeLibrary(raw) {
  const base = emptyLibrary();
  if (!raw || typeof raw !== 'object') return base;
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))]
    : [];
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [];
  return {
    version: Number.isFinite(raw.version) ? raw.version : LIBRARY_VERSION,
    rev: Number.isFinite(raw.rev) ? raw.rev : 0,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowISO(),
    models: models.length ? models : base.models.slice(),
    items
  };
}

export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  const model = typeof raw.model === 'string' ? raw.model : '';
  if (!title && !text) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    title,
    model,
    text,
    source: raw.source && typeof raw.source === 'object' ? raw.source : {},
    created_at: typeof raw.created_at === 'string' ? raw.created_at : nowISO(),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowISO()
  };
}

/** 校验一条待保存的收藏；返回 {ok, errors:{title?,model?,text?}} */
export function validateItem({ title, model, text }) {
  const errors = {};
  if (!String(title ?? '').trim()) errors.title = '标题必填';
  if (!String(model ?? '').trim()) errors.model = '请选择模型分类';
  if (!String(text ?? '').trim()) errors.text = 'Prompt 内容不能为空';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** 新增或按 id 更新（保留 created_at） */
export function upsertItem(library, item) {
  const lib = library || emptyLibrary();
  const item2 = { ...item, updated_at: item.updated_at || nowISO() };
  const idx = lib.items.findIndex((x) => x.id === item2.id);
  if (idx >= 0) {
    const old = lib.items[idx];
    lib.items[idx] = { ...item2, created_at: old.created_at || item2.created_at || nowISO() };
  } else {
    lib.items.push({ created_at: item2.created_at || nowISO(), ...item2 });
  }
  if (item2.model && !lib.models.includes(item2.model)) lib.models.push(item2.model);
  return lib;
}

export function removeItem(library, id) {
  const lib = library || emptyLibrary();
  lib.items = lib.items.filter((x) => x.id !== id);
  return lib;
}

export function getItem(library, id) {
  return (library?.items || []).find((x) => x.id === id) || null;
}

/** 视图：按标题搜索 + 按模型筛选 + 按更新时间倒序 */
export function filterItems(library, { query = '', model = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (library?.items || [])
    .filter((it) => (model ? it.model === model : true))
    .filter((it) => (q ? String(it.title || '').toLowerCase().includes(q) : true))
    .slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

export function addModel(library, name) {
  const lib = library || emptyLibrary();
  const n = String(name || '').trim();
  if (n && !lib.models.includes(n)) lib.models.push(n);
  return lib;
}

/**
 * 合并两份收藏库（同 id 取 updated_at 较新者，models 取并集）
 * 用于"磁盘上的库比我手里的新"（多标签页/多次打开）时避免丢数据。
 */
export function mergeLibraries(mine, disk) {
  const a = normalizeLibrary(mine);
  const b = normalizeLibrary(disk);
  const byId = new Map();
  for (const it of a.items) byId.set(it.id, it);
  for (const it of b.items) {
    const cur = byId.get(it.id);
    if (!cur) byId.set(it.id, it);
    else if (String(it.updated_at) > String(cur.updated_at)) byId.set(it.id, it);
  }
  return {
    version: LIBRARY_VERSION,
    rev: Math.max(a.rev, b.rev),
    updated_at: nowISO(),
    models: [...new Set([...a.models, ...b.models])],
    items: [...byId.values()]
  };
}

export function bumpRev(library) {
  const lib = normalizeLibrary(library);
  lib.rev = (Number.isFinite(lib.rev) ? lib.rev : 0) + 1;
  lib.updated_at = nowISO();
  return lib;
}

/** 供界面显示的短时间 */
export function fmtTime(iso) {
  const t = String(iso || '');
  return t.length >= 16 ? t.slice(0, 16).replace('T', ' ') : t;
}
