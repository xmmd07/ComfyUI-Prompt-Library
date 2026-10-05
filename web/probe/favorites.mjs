/**
 * favorites.mjs —— 收藏功能的两块界面（原生 DOM，无框架）
 *   1. openItemEditor()     —— 收藏/编辑 弹窗（标题必填、模型必填、Prompt 可编辑）
 *   2. renderLibraryView()  —— 「我的收藏」列表（搜索/筛选/查看/编辑/复制/删除）
 *   3. confirmDialog()      —— 二次确认弹窗（删除、重建空库等）
 *
 * 本文件只负责渲染与收集输入，不直接读写存储；持久化交给 panel.mjs 调 storage.mjs。
 */

import { fmtTime } from './library.mjs';
import { STATUS_TEXT } from './resolver.mjs';

const STATUS_TEXT_FALLBACK = { confirmed: '已确认', partial: '部分确认', candidate: '候选文本', runtime: '运行时生成', unknown: '无法确认' };
const statusTextOf = (s) => STATUS_TEXT[s] || STATUS_TEXT_FALLBACK[s] || s;

const BADGE_CLASS = {
  confirmed: 'pp-badge-ok',
  partial: 'pp-badge-warn',
  candidate: 'pp-badge-info',
  runtime: 'pp-badge-muted',
  unknown: 'pp-badge-bad'
};

/* ------------------------------------------------------------------ *
 * DOM 助手
 * ------------------------------------------------------------------ */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function badge(kind, text) {
  return h('span', { class: `pp-badge ${BADGE_CLASS[kind] || 'pp-badge-muted'}`, text });
}

export async function copyToClipboard(text) {
  const value = String(text ?? '');
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
    throw new Error('no clipboard api');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.('copy');
      ta.remove();
      return !!ok;
    } catch (e2) {
      return false;
    }
  }
}

function copyButton(text, label = '复制') {
  const b = h('button', { class: 'pp-btn pp-btn-mini pp-copy', text: label });
  b.addEventListener('click', async () => {
    const ok = await copyToClipboard(text);
    b.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { b.textContent = label; }, 1200);
  });
  return b;
}

function overlay(host) {
  const wrap = h('div', { class: 'pp-overlay' });
  host.appendChild(wrap);
  return { wrap, close: () => wrap.remove() };
}

/* ------------------------------------------------------------------ *
 * 1) 收藏 / 编辑 弹窗
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {HTMLElement} o.host        面板根节点（弹窗挂在这里面）
 * @param {'create'|'edit'} o.mode
 * @param {object} [o.item]           初始值 {title, model, text, source}
 * @param {string[]} o.models         已存在的模型分类
 * @param {string} [o.warning]        来源状态提示（候选文本/未确认 等），会保留在界面上
 * @param {function} o.onSave         async (item) => {ok:boolean, error?:string}
 * @param {function} [o.onCancel]
 */
export function openItemEditor({ host, mode = 'create', item = {}, models = [], warning = '', onSave, onCancel }) {
  const isEdit = mode === 'edit';
  const ov = overlay(host);
  const errEl = h('div', { class: 'pp-dlg-errors' });

  const titleInput = h('input', { class: 'pp-input', type: 'text', value: item.title || '', placeholder: '给这条 Prompt 起个标题（必填）' });
  const modelSelect = h('select', { class: 'pp-input' });
  const seen = [...new Set(models.filter(Boolean))];
  for (const m of seen) modelSelect.appendChild(h('option', { value: m, text: m }));
  if (!seen.length) modelSelect.appendChild(h('option', { value: 'Anima', text: 'Anima' }));
  modelSelect.appendChild(h('option', { value: '__new__', text: '＋ 新增模型分类…' }));
  modelSelect.value = item.model && seen.includes(item.model) ? item.model : seen[0];
  const newModelInput = h('input', { class: 'pp-input', type: 'text', placeholder: '新分类名称（必填）' });
  newModelInput.style.display = 'none';
  modelSelect.addEventListener('change', () => {
    newModelInput.style.display = modelSelect.value === '__new__' ? '' : 'none';
  });

  const textArea = h('textarea', { class: 'pp-input pp-textarea', rows: '10' });
  textArea.value = item.text || '';

  const lenEl = h('span', { class: 'pp-len' });
  const refreshLen = () => { lenEl.textContent = `${String(textArea.value || '').length} 字`; };
  textArea.addEventListener('input', refreshLen);
  refreshLen();

  const src = item.source || {};
  const srcLine = src.node_class
    ? `来源：${src.workflow || '（未命名工作流）'} · ${src.node_class} #${src.node_id ?? '?'}${src.role ? ` · ${src.role}` : ''}`
    : '来源：（手动录入）';

  const saveBtn = h('button', { class: 'pp-btn pp-primary', text: isEdit ? '保存修改' : '保存' });
  const cancelBtn = h('button', { class: 'pp-btn', text: '取消' });

  saveBtn.addEventListener('click', async () => {
    errEl.textContent = '';
    const isNew = modelSelect.value === '__new__';
    const model = isNew ? newModelInput.value.trim() : modelSelect.value;
    const draft = {
      id: item.id,
      title: titleInput.value.trim(),
      model,
      text: textArea.value,
      source: item.source || {},
      created_at: item.created_at
    };
    const errors = {};
    if (!draft.title) errors.title = '标题必填';
    if (!draft.model) errors.model = '请选择或填写模型分类';
    if (!draft.text.trim()) errors.text = 'Prompt 内容不能为空';
    if (Object.keys(errors).length) {
      errEl.appendChild(h('div', { class: 'pp-warn', text: '请先修正：' }));
      for (const v of Object.values(errors)) errEl.appendChild(h('div', { class: 'pp-warn', text: `· ${v}` }));
      return;
    }
    try {
      const r = await onSave(draft);
      if (r && r.ok === false) {
        errEl.appendChild(h('div', { class: 'pp-warn', text: `保存失败：${r.error || '未知错误'}` }));
        return;
      }
      ov.close();
    } catch (e) {
      errEl.appendChild(h('div', { class: 'pp-warn', text: `保存失败：${e?.message || e}` }));
    }
  });

  cancelBtn.addEventListener('click', () => {
    ov.close();
    onCancel?.();
  });

  const card = h('div', { class: 'pp-dlg' }, [
    h('div', { class: 'pp-dlg-h', text: isEdit ? '编辑收藏' : '收藏 Prompt' }),
    warning ? h('div', { class: 'pp-dlg-warn', text: `⚠ ${warning}` }) : null,
    h('div', { class: 'pp-dlg-field' }, [h('label', { class: 'pp-label', text: '标题（必填）' }), titleInput]),
    h('div', { class: 'pp-dlg-field' }, [
      h('label', { class: 'pp-label', text: '模型分类（必填）' }),
      h('div', { class: 'pp-row' }, [modelSelect, newModelInput])
    ]),
    h('div', { class: 'pp-dlg-field' }, [
      h('div', { class: 'pp-row pp-row-between' }, [h('label', { class: 'pp-label', text: 'Prompt 内容（可编辑）' }), lenEl]),
      textArea
    ]),
    h('div', { class: 'pp-hint', text: srcLine }),
    errEl,
    h('div', { class: 'pp-dlg-actions' }, [cancelBtn, saveBtn])
  ]);

  ov.wrap.appendChild(card);
  return { close: ov.close, elements: { titleInput, modelSelect, newModelInput, textArea, saveBtn, cancelBtn, errEl } };
}

/* ------------------------------------------------------------------ *
 * 2) 二次确认
 * ------------------------------------------------------------------ */
export function confirmDialog({ host, title, message, confirmLabel = '确认删除', onConfirm, onCancel }) {
  const ov = overlay(host);
  const ok = h('button', { class: 'pp-btn pp-danger', text: confirmLabel });
  const no = h('button', { class: 'pp-btn', text: '取消' });
  ok.addEventListener('click', async () => {
    ov.close();
    await onConfirm?.();
  });
  no.addEventListener('click', () => {
    ov.close();
    onCancel?.();
  });
  ov.wrap.appendChild(h('div', { class: 'pp-dlg pp-dlg-sm' }, [
    h('div', { class: 'pp-dlg-h', text: title || '确认操作' }),
    h('div', { class: 'pp-dlg-msg', text: message || '' }),
    h('div', { class: 'pp-dlg-actions' }, [no, ok])
  ]));
  return { close: ov.close };
}

/* ------------------------------------------------------------------ *
 * 3) 「我的收藏」列表
 * ------------------------------------------------------------------ */

/**
 * 卡片结构（自上而下）：
 *   1 行  标题（醒目）+ 模型标签
 *   2 行  状态 · 字数 · 收藏时间
 *   3 行  来源工作流与节点
 *   4 行  Prompt 预览（最多 3 行，超出截断）
 *   底部 查看完整 / 编辑 / 复制 / 删除
 *
 * @param {object} o
 * @param {object} o.library
 * @param {string} o.query
 * @param {string} o.model
 * @param {object[]} o.items              已过滤排序后的条目
 * @param {object} o.handlers             {onQuery,onModel,onEdit,onDelete,onExport,onReload}
 * @param {HTMLElement} [o.toolbarSlot]   若提供，工具条渲染到这个槽位（放在页面顶部工具栏里）
 * @param {object} [o.notice]
 * @param {Set} [o.expanded]
 * @param {function} [o.onToggleExpand]
 */
export function renderLibraryView(o) {
  const { library, query = '', model = '', items = [], handlers = {}, notice = null, expanded, toolbarSlot = null } = o;

  /* ---- 工具条：搜索 → 模型筛选 → 刷新 / 导出 ---- */
  const searchInput = h('input', { class: 'pp-input pp-lib-search', type: 'text', value: query, placeholder: '按标题搜索…' });
  searchInput.addEventListener('input', () => handlers.onQuery?.(searchInput.value));

  const modelSelect = h('select', { class: 'pp-input' });
  modelSelect.appendChild(h('option', { value: '', text: '全部模型' }));
  for (const m of library?.models || []) modelSelect.appendChild(h('option', { value: m, text: m }));
  modelSelect.value = model;
  modelSelect.addEventListener('change', () => handlers.onModel?.(modelSelect.value));

  const toolbar = h('div', { class: 'pp-lib-toolbar pp-row' }, [
    searchInput,
    modelSelect,
    h('button', { class: 'pp-btn pp-btn-mini', text: '刷新', onclick: () => handlers.onReload?.() }),
    h('button', { class: 'pp-btn pp-btn-mini', text: '导出', onclick: () => handlers.onExport?.() })
  ]);

  const kids = [];
  if (toolbarSlot) toolbarSlot.appendChild(toolbar);
  else kids.push(toolbar);

  if (notice) {
    kids.push(h('div', { class: `pp-notice pp-notice-${notice.level || 'info'}` }, [
      h('div', { text: notice.text, style: 'overflow-wrap:anywhere' }),
      (notice.actions || []).length
        ? h('div', { class: 'pp-row' }, notice.actions.map((a) => h('button', { class: 'pp-btn pp-btn-mini', text: a.label, onclick: a.onClick })))
        : null
    ]));
  }

  const total = library?.items?.length || 0;
  const isFiltered = !!String(query || '').trim() || !!model || items.length !== total;
  kids.push(h('div', { class: 'pp-sum-line' }, [
    h('span', { text: isFiltered ? `筛选后显示 ${items.length} / 共 ${total} 条` : `共 ${total} 条收藏` })
  ]));

  if (!items.length) {
    kids.push(h('div', { class: 'pp-empty', text: library?.items?.length
      ? '没有匹配的收藏（换个关键词或筛选条件）'
      : '还没有收藏。到「探针」页选中一条 Prompt，点上方「★ 收藏 Prompt」。' }));
    return h('div', { class: 'pp-lib' }, kids);
  }

  for (const it of items) {
    const isOpen = expanded?.has?.(it.id);
    const src = it.source || {};
    const srcText = src.node_class
      ? `${src.workflow || '（未命名工作流）'} · ${src.node_class} #${src.node_id ?? '?'}${src.role ? ` · ${src.role}` : ''}`
      : '手动录入';
    const sBadge = src.status
      ? (['confirmed', 'partial', 'candidate', 'runtime', 'unknown'].includes(src.status)
        ? badge(src.status, statusTextOf(src.status))
        : badge('muted', src.status))
      : badge('muted', '未记录状态');

    const card = h('div', { class: 'pp-lib-item' }, [
      h('div', { class: 'pp-lib-line1' }, [
        // pp-clamp 是"有意截断"的标记：标题最多 2 行、预览最多 3 行（见 style.css）
        h('span', { class: 'pp-lib-title pp-clamp', text: it.title || '(无标题)' }),
        it.model ? h('span', { class: 'pp-badge pp-badge-model', text: it.model }) : null
      ]),
      h('div', { class: 'pp-lib-meta' }, [
        sBadge,
        h('span', { class: 'pp-len', text: `${String(it.text || '').length} 字` }),
        h('span', { class: 'pp-len', text: `收藏于 ${fmtTime(it.created_at || it.updated_at)}` })
      ]),
      h('div', { class: 'pp-lib-src', text: `来源：${srcText}` }),
      h('div', { class: 'pp-lib-preview pp-clamp', text: String(it.text || '') || '（空）' }),
      h('div', { class: 'pp-lib-item-actions' }, [
        h('button', {
          class: 'pp-btn pp-btn-mini',
          text: isOpen ? '收起' : '查看完整',
          onclick: () => o.onToggleExpand?.(it.id)
        }),
        h('button', { class: 'pp-btn pp-btn-mini', text: '编辑', onclick: () => handlers.onEdit?.(it) }),
        copyButton(it.text),
        h('button', { class: 'pp-btn pp-btn-mini pp-danger', text: '删除', onclick: () => handlers.onDelete?.(it) })
      ])
    ]);
    if (isOpen) card.appendChild(h('pre', { class: 'pp-text', text: it.text || '（空）' }));
    kids.push(card);
  }

  return h('div', { class: 'pp-lib' }, kids);
}
