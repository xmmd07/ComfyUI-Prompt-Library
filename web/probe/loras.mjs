/**
 * loras.mjs —— LoRA 提示词收藏（第四个页签）
 *
 * 用途：为某个 LoRA 记一段提示词（比如「这个 LoRA 配什么咒语好用」），保存后
 *       列表里直接显示 LoRA 名 + 提示词，一键复制。平时**不展示全部 LoRA**，
 *       只在点「添加 / 换 LoRA」时弹层拉 /models/loras 供选择。
 *
 * 数据：prompt_library/loras.json，结构 {version, rev, updated_at, items:[{id, lora, prompt, created_at, updated_at}]}
 *       lora 存 /models/loras 返回的原始相对路径（**不归一化**：Windows 子目录带反斜杠，原样存才对得上）。
 *
 * 依赖：storage.mjs 的 makeFileStore（通用 /userdata 读写）、favorites.mjs 的 h/confirmDialog/copyToClipboard。
 */

import { h, confirmDialog, copyToClipboard, copyButtonFor } from './favorites.mjs';
import { t } from './i18n.mjs';

/* ===================== 数据模型 ===================== */

export function emptyLoras() {
  return { version: 1, rev: 0, updated_at: null, items: [] };
}

/** 单条记录校验：LoRA 名和提示词都必填 */
export function validateLora(item) {
  const errors = {};
  if (!item || !String(item.lora || '').trim()) errors.lora = 'form.errLora';
  if (!item || !String(item.prompt || '').trim()) errors.prompt = 'form.errPrompt';
  return { ok: !Object.keys(errors).length, errors };
}

export function normalizeLoras(obj) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const items = Array.isArray(src.items) ? src.items : [];
  const seen = new Set();
  const clean = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const lora = typeof it.lora === 'string' ? it.lora.trim() : '';
    const prompt = typeof it.prompt === 'string' ? it.prompt : '';
    if (!lora || !prompt.trim()) continue;
    const id = typeof it.id === 'string' && it.id ? it.id : newId();
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push({
      id,
      lora,
      prompt,
      use_count: Number.isFinite(Number(it.use_count)) ? Math.max(0, Math.floor(Number(it.use_count))) : 0,
      last_used_at: typeof it.last_used_at === 'string' ? it.last_used_at : null,
      created_at: it.created_at || new Date().toISOString(),
      updated_at: it.updated_at || it.created_at || new Date().toISOString()
    });
  }
  return {
    version: 1,
    rev: Number.isFinite(src.rev) ? src.rev : 0,
    updated_at: src.updated_at || null,
    items: clean
  };
}

/** 磁盘版本更新（rev 更高）时按 id 合并，与 artists/library 同规则 */
export function mergeLoras(local, disk) {
  const byId = new Map();
  for (const it of local.items) byId.set(it.id, it);
  for (const it of disk.items) {
    const mine = byId.get(it.id);
    if (!mine || (it.updated_at || '') > (mine.updated_at || '')) byId.set(it.id, it);
  }
  return { version: 1, rev: Math.max(local.rev, disk.rev), updated_at: new Date().toISOString(), items: [...byId.values()] };
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'l' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/** 显示用：取路径最后一段（/ 和 \ 都当分隔符）；悬停 title 显示全路径 */
export function loraBasename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/* ===================== /models 列表拉取 ===================== */

/**
 * 读取 /models/{folder} 列表。实测：
 *   · loras（aki 整合包 ComfyUI 0.42.3）：字符串数组，子目录用反斜杠拼接；
 *   · diffusion_models：纯字符串数组（unet 与 diffusion_models 两个目录已合并返回）。
 * 容错：对象数组（{name} 形态，其他版本可能）也接受。
 * @returns {Promise<string[]>} 原始相对路径数组（不做归一化）
 */
export async function fetchModelList(api, folder) {
  const res = await api.fetchApi(`/models/${encodeURIComponent(folder)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(t('err.readModelList', { status: res.status }));
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error(t('err.modelListShape'));
  const out = [];
  for (const it of j) {
    if (typeof it === 'string' && it.trim()) out.push(it);
    else if (it && typeof it === 'object' && typeof it.name === 'string' && it.name.trim()) out.push(it.name);
  }
  return out;
}

/** LoRA 列表 = /models/loras */
export const fetchLoraList = (api) => fetchModelList(api, 'loras');

/* ===================== 界面：LoRA 选择弹层（带过滤框） ===================== */

/**
 * 弹出 LoRA 选择列表：顶部过滤框（按包含匹配），点击一条即选中并关闭。
 * @param {object} o {host, api, onPick(loraPath), onCancel?}
 */
/**
 * 模型选择弹层（LoRA / diffusion_models 通用，带过滤框，点击一条即选中并关闭）。
 * @param {object} o {host, api, folder, onPick(path), onCancel?, title?}
 */
export function openModelPicker({ host, api, folder = 'loras', onPick, onCancel, title = null }) {
  // 默认标题在调用时取词（不写进默认参数，避免语言在模块加载期被冻结）
  title = title || t('lora.pickerTitle');
  const ov = h('div', { class: 'pp-overlay' });
  host.appendChild(ov);
  const close = () => { ov.remove(); };
  const cancelBtn = h('button', { class: 'pp-btn', text: t('btn.cancel'), onclick: () => { close(); onCancel?.(); } });

  const listWrap = h('div', { class: 'pp-lora-list' });
  const status = h('div', { class: 'pp-hint', text: t('lora.readingList') });
  const filterInput = h('input', { class: 'pp-input', placeholder: t('lora.filterPlaceholder') });

  let all = [];
  const renderList = () => {
    const kw = (filterInput.value || '').trim().toLowerCase();
    listWrap.textContent = '';
    const shown = kw ? all.filter((p) => p.toLowerCase().includes(kw)) : all;
    if (!shown.length) {
      listWrap.appendChild(h('div', { class: 'pp-empty', text: kw ? t('empty.noMatchModels') : t('empty.listEmpty') }));
      return;
    }
    for (const p of shown) {
      const btn = h('button', { class: 'pp-btn pp-lora-item', title: p }, [
        h('span', { class: 'pp-lora-name', text: loraBasename(p) }),
        p.includes('/') || p.includes('\\') ? h('span', { class: 'pp-len', text: loraDirname(p) }) : null
      ]);
      btn.addEventListener('click', () => { close(); onPick?.(p); });
      listWrap.appendChild(btn);
    }
  };
  filterInput.addEventListener('input', renderList);

  const dlg = h('div', { class: 'pp-dlg' }, [
    h('div', { class: 'pp-dlg-h', text: title }),
    status,
    h('div', { class: 'pp-row', style: 'margin:6px 0' }, [filterInput]),
    listWrap,
    h('div', { class: 'pp-dlg-actions' }, [cancelBtn])
  ]);
  ov.appendChild(dlg);

  (async () => {
    try {
      all = await fetchModelList(api, folder);
      status.textContent = t('meta.modelCount', { n: all.length });
      renderList();
    } catch (e) {
      status.textContent = String(e.message || e);
    }
  })();
}

/** LoRA 选择弹层 = openModelPicker('loras') */
export function openLoraPicker({ host, api, onPick, onCancel }) {
  return openModelPicker({ host, api, folder: 'loras', onPick, onCancel, title: t('lora.pickerTitle') });
}

function loraDirname(p) {
  const i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
  return i >= 0 ? String(p).slice(0, i) : '';
}

/* ===================== 界面：添加 / 编辑弹窗 ===================== */

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {'create'|'edit'} o.mode
 * @param {object} [o.item]        {id?, lora, prompt}
 * @param {function} o.onSave      async ({id?, lora, prompt}) => {ok, error?}
 * @param {function} [o.onCancel]
 * @param {object} o.api
 */
export function openLoraEditor({ host, mode = 'create', item = {}, onSave, onCancel, api = null }) {
  const isEdit = mode === 'edit';
  const ov = h('div', { class: 'pp-overlay' });
  host.appendChild(ov);
  const close = () => { ov.remove(); onCancel?.(); };

  const errEl = h('div', { class: 'pp-dlg-errors' });
  const loraShown = h('div', { class: 'pp-lib-title', text: item.lora ? loraBasename(item.lora) : t('lora.notChosen') });
  loraShown.title = item.lora || '';
  const promptArea = h('textarea', { class: 'pp-input pp-textarea', rows: '6', placeholder: t('ph.loraPrompt') });
  promptArea.value = item.prompt || '';
  const lenEl = h('span', { class: 'pp-len' });
  const refreshLen = () => { lenEl.textContent = t('meta.chars', { n: String(promptArea.value || '').length }); };
  promptArea.addEventListener('input', refreshLen);
  refreshLen();

  let lora = item.lora || null;
  const pickBtn = h('button', {
    class: 'pp-btn pp-btn-mini',
    text: isEdit ? t('btn.changeLora') : t('btn.pickLora'),
    onclick: () => {
      if (!api) return;
      openLoraPicker({
        host: ov,
        api,
        onPick: (p) => { lora = p; loraShown.textContent = loraBasename(p); loraShown.title = p; errEl.textContent = ''; }
      });
    }
  });

  const saveBtn = h('button', { class: 'pp-btn pp-primary', text: isEdit ? t('btn.saveEdit') : t('btn.save') });
  saveBtn.addEventListener('click', async () => {
    errEl.textContent = '';
    if (!lora) { errEl.textContent = t('form.errLora'); return; }
    const check = validateLora({ lora, prompt: promptArea.value });
    if (!check.ok) { errEl.textContent = Object.values(check.errors).map((c) => t(c)).join(t('meta.listSep')); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = t('btn.saving');
    try {
      const r = await onSave({ id: item.id, lora, prompt: promptArea.value });
      if (r && r.ok) { close(); return; }
      errEl.textContent = (r && r.error) || t('err.saveFailedBare');
    } catch (e) {
      errEl.textContent = String(e.message || e);
    }
    saveBtn.disabled = false;
    saveBtn.textContent = isEdit ? t('btn.saveEdit') : t('btn.save');
  });

  const noBtn = h('button', { class: 'pp-btn', text: t('btn.cancel'), onclick: close });
  ov.appendChild(h('div', { class: 'pp-dlg' }, [
    h('div', { class: 'pp-dlg-h', text: isEdit ? t('dlg.editLora') : t('dlg.newLora') }),
    errEl,
    h('div', { class: 'pp-row' }, [h('span', { class: 'pp-len', text: t('lora.label') }), loraShown, h('span', { style: 'flex:1' }), pickBtn]),
    promptArea,
    h('div', { class: 'pp-row' }, [lenEl]),
    h('div', { class: 'pp-dlg-actions' }, [noBtn, saveBtn])
  ]));
}

/* ===================== 界面：列表 ===================== */

/**
 * @param {object} o {data, notice, toolbarSlot, api, handlers:{onAdd,onEdit(item),onDelete(item),onReload}}
 */
export function renderLorasView(o) {
  const { data, notice = null, toolbarSlot = null, handlers = {}, onUsed = null } = o;

  const toolbar = h('div', { class: 'pp-lib-toolbar pp-row' }, [
    h('button', { class: 'pp-btn pp-btn-mini', text: t('btn.addLora'), onclick: () => handlers.onAdd?.() }),
    h('button', { class: 'pp-btn pp-btn-mini', text: t('btn.refresh'), onclick: () => handlers.onReload?.() })
  ]);

  const kids = [];
  if (toolbarSlot) toolbarSlot.appendChild(toolbar);
  else kids.push(toolbar);

  if (notice) {
    kids.push(h('div', { class: `pp-notice pp-notice-${notice.level || 'info'}` }, [
      h('div', { text: notice.text, style: 'overflow-wrap:anywhere' })
    ]));
  }

  const total = data?.items?.length || 0;
  kids.push(h('div', { class: 'pp-sum-line' }, [h('span', { text: t('meta.loraCount', { n: total }) })]));

  if (!total) {
    kids.push(h('div', { class: 'pp-empty', text: total ? t('empty.lorasFiltered') : t('empty.lorasNone') }));
    return h('div', { class: 'pp-lora-page' }, kids);
  }

  for (const it of data.items) {
    kids.push(h('div', { class: 'pp-lib-item pp-lora-item-card' }, [
      h('div', { class: 'pp-lib-title pp-clamp', text: loraBasename(it.lora), title: it.lora }),
      h('div', { class: 'pp-lora-prompt pp-clamp3', text: it.prompt, title: it.prompt }),
      h('div', { class: 'pp-lib-meta' }, [
        h('span', { class: 'pp-len', text: t('meta.chars', { n: String(it.prompt || '').length }) }),
        (Number(it.use_count) || 0) > 0
          ? h('span', { class: 'pp-len', title: it.last_used_at ? t('meta.usedTitle', { time: it.last_used_at.slice(0, 16).replace('T', ' ') }) : '', text: t('meta.used', { n: it.use_count }) })
          : null,
        h('span', { class: 'pp-len', text: t('meta.savedOn', { date: (it.created_at || '').slice(0, 10) }) })
      ]),
      h('div', { class: 'pp-lib-item-actions' }, [
        copyButtonFor(() => it.prompt, t('btn.copyPrompt'), () => { if (onUsed) onUsed(it.id); }),
        copyButtonFor(() => it.lora, t('btn.copyLoraName'), () => { if (onUsed) onUsed(it.id); }),
        h('button', { class: 'pp-btn pp-btn-mini', text: t('btn.edit'), onclick: () => handlers.onEdit?.(it) }),
        h('button', { class: 'pp-btn pp-btn-mini pp-danger', text: t('btn.delete'), onclick: () => handlers.onDelete?.(it) })
      ])
    ]));
  }
  return h('div', { class: 'pp-lora-page' }, kids);
}
