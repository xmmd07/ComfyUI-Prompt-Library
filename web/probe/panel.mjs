/**
 * panel.mjs —— 侧边栏面板（原生 JS，无框架）
 *
 * 结构（v0.2 UI 整理）：
 *   第 1 行  品牌：Prompt Library + 版本号
 *   第 2 行  页面切换：探针 / 我的收藏（统一的分段控件）
 *   第 3 行  页面工具条：探针页 = 重新扫描 / ★收藏 Prompt；收藏页 = 搜索 / 模型筛选 / 刷新 / 导出
 *   主体     页面内容；底部一行简短安全说明
 *
 * 解析逻辑仍然来自 resolver.mjs（未被改动）：采样链识别、Set/Get、开关分支、折叠节点、候选文本全部保留。
 * 只做展示与"用户主动触发"的收藏读写；不修改工作流、不提交出图任务。
 */

import { scan, STATUS_TEXT } from './resolver.mjs';
import { createLiveView } from './graphview.mjs';
import { renderLibraryView, openItemEditor, confirmDialog } from './favorites.mjs';
import { makeStorage } from './storage.mjs';
import { auditLayout } from './layout-audit.mjs';
import { emptyLibrary, normalizeLibrary, upsertItem, removeItem, filterItems, validateItem, newId } from './library.mjs';

const BADGE_CLASS = {
  confirmed: 'pp-badge-ok',
  partial: 'pp-badge-warn',
  candidate: 'pp-badge-info',
  runtime: 'pp-badge-muted',
  unknown: 'pp-badge-bad'
};

const statusTextOf = (s) => STATUS_TEXT[s] || s;
const PREVIEW_LINES = 3;

export function createPanel(app, opts = {}) {
  const api = opts.api || globalThis.comfyAPI?.api?.api || null;
  const storage = api && typeof api.fetchApi === 'function' ? makeStorage(api) : null;

  const state = {
    /* 探针 */
    result: null,
    error: null,
    activeTab: 0,
    scannedAt: null,
    expanded: new Set(),          // 展开全文的字段 key
    /* 收藏 */
    view: 'scan',
    selected: null,
    scanNotice: null,
    library: emptyLibrary(),
    libQuery: '',
    libModel: '',
    libExpanded: new Set(),
    libNotice: null,
    libLoading: false,
    lastModel: null
  };

  let rootEl = null;
  let toolbarEl = null;
  let sumEl = null;
  let tabsEl = null;
  let bodyEl = null;
  let segEl = null;

  /* ---------- DOM 小工具 ---------- */
  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function badge(kind, text) {
    return h('span', { class: `pp-badge ${BADGE_CLASS[kind] || 'pp-badge-muted'}`, text });
  }

  async function copyText(text, btn) {
    const label = btn.textContent;
    const ok = await copyViaClipboard(text);
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { btn.textContent = label; }, 1200);
  }

  async function copyViaClipboard(text) {
    const value = String(text ?? '');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
      throw new Error('no clipboard');
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

  function actionBtn(label, onClick, cls = 'pp-btn pp-btn-mini') {
    const b = h('button', { class: cls, text: label });
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  function negCopyBtn(text) {
    const b = h('button', { class: 'pp-btn pp-btn-mini pp-copy', text: '复制负向' });
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      copyText(text, b);
    });
    return b;
  }

  function downloadText(filename, text) {
    try {
      if (typeof URL?.createObjectURL !== 'function') return false;
      const blob = new Blob([String(text ?? '')], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ================= 选中 & 收藏 ================= */

  const errText = (e) => e?.message || String(e);

  function warningsFor({ chain, field, status }) {
    // 只保留"字段级"提示；采样器/编码节点的绕过状态由卡片抬头统一说明一次，避免重复
    const parts = [];
    if (status !== 'confirmed') parts.push(`解析状态为「${statusTextOf(status)}」，未确认就是最终生效的文本`);
    if (field?.staleWidget) parts.push('节点控件里还存有被连线取代的旧文本（已忽略）');
    return parts.join('；');
  }

  function selectionFromField(chain, field) {
    const t = chain.target || {};
    const status = field.status;
    return {
      text: field.text ?? '',
      status,
      source: {
        workflow: state.result?.meta?.workflowName || '',
        node_id: t.id,
        node_class: t.cls,
        field: field.name,
        role: field.role,
        status,
        status_text: statusTextOf(status),
        sampler: `${chain.sampler.cls} #${chain.sampler.id}`,
        group: chain.sampler.group || '',
        collected_at: new Date().toISOString()
      },
      warning: warningsFor({ chain, field, status })
    };
  }

  function selectionFromCandidate(c) {
    return {
      text: c.text ?? '',
      status: c.status,
      source: {
        workflow: state.result?.meta?.workflowName || '',
        node_id: c.id,
        node_class: c.cls,
        field: c.field,
        role: '候选',
        status: c.status,
        status_text: statusTextOf(c.status),
        group: c.group || '',
        collected_at: new Date().toISOString()
      },
      warning: `该条来自"候选文本"：${c.reason}；解析状态为「${statusTextOf(c.status)}」，未确认它就是最终生效的 Prompt`
    };
  }

  function toggleSelect(payload, key) {
    state.scanNotice = null;
    state.selected = state.selected?.key === key ? null : { key, ...payload };
    render();
  }

  const guessModel = () => state.lastModel || (state.library.models || [])[0] || 'Anima';

  function openFavorite({ fromSelection = false, item = null } = {}) {
    if (fromSelection) {
      if (!state.selected) {
        state.scanNotice = { level: 'warn', text: '还没有选中 Prompt：请先在「探针」页点一条 Prompt（点卡片或「选为收藏」），再点「★ 收藏 Prompt」。' };
        state.view = 'scan';
        render();
        return;
      }
      if (!String(state.selected.text || '').trim()) {
        state.scanNotice = { level: 'warn', text: '选中的这条内容为空（通常是"运行时生成"或"无法确认"的项），无法收藏，请换一条。' };
        state.view = 'scan';
        render();
        return;
      }
    }

    const draft = fromSelection
      ? { title: '', model: guessModel(), text: state.selected.text, source: state.selected.source, warningText: state.selected.warning || '' }
      : {
        id: item?.id,
        title: item?.title || '',
        model: item?.model || guessModel(),
        text: item?.text || '',
        source: item?.source || {},
        created_at: item?.created_at
      };

    openItemEditor({
      host: rootEl,
      mode: item ? 'edit' : 'create',
      item: draft,
      models: state.library.models,
      warning: fromSelection ? draft.warningText : '',
      onSave: async (saved) => {
        const check = validateItem(saved);
        if (!check.ok) return { ok: false, error: Object.values(check.errors).join('；') };
        return await persistItem(saved);
      }
    });
  }

  async function persistItem(draft) {
    if (!storage) return { ok: false, error: '未取到 ComfyUI API，无法保存' };
    const isNew = !draft.id;
    const item = { ...draft, id: draft.id || newId(), created_at: draft.created_at || new Date().toISOString() };
    const lib = normalizeLibrary({ ...state.library, items: (state.library.items || []).slice() });
    upsertItem(lib, item);
    try {
      const res = await storage.save(lib);
      state.library = res.library;
      state.library.__path = storage.paths.human;
      state.lastModel = item.model;
      state.libNotice = {
        level: 'info',
        text: `已${isNew ? '收藏' : '更新'}：${item.title}${res.merged ? '（磁盘上有更新版本，已合并保存）' : ''}`
      };
      if (isNew) state.selected = null;
      render();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  async function loadLibrary() {
    if (!storage) {
      state.libNotice = { level: 'error', text: '未取到 ComfyUI API：收藏功能不可用（只读探针不受影响）。' };
      render();
      return;
    }
    state.libLoading = true;
    render();
    try {
      const r = await storage.load();
      state.libLoading = false;
      if (r.state === 'corrupt') {
        state.libNotice = {
          level: 'error',
          text: `收藏库文件无法解析，已停止写入以保护数据：${r.error || ''}`,
          actions: [
            { label: '导出原始内容', onClick: () => downloadText('prompt_library.broken.json', r.raw || '') },
            { label: '重试加载', onClick: () => { loadLibrary(); } },
            {
              label: '另存损坏文件并重建空库',
              onClick: () => confirmDialog({
                host: rootEl,
                title: '重建空库？',
                message: '会把当前内容另存为 library.broken.<时间>.json，然后把 library.json 重置为空库。此操作需要你确认，且不可撤销。',
                confirmLabel: '确认重建',
                onConfirm: async () => {
                  try {
                    const name = await storage.quarantineBroken(r.raw);
                    const fresh = await storage.resetToEmpty();
                    state.library = fresh;
                    state.library.__path = storage.paths.human;
                    state.libNotice = { level: 'info', text: `已重建空库；原内容已另存为 ${name}` };
                  } catch (e) {
                    state.libNotice = { level: 'error', text: `重建失败：${errText(e)}` };
                  }
                  render();
                }
              })
            }
          ]
        };
        render();
        return;
      }
      state.library = r.library || emptyLibrary();
      state.library.__path = storage.paths.human;
      state.libNotice = r.state === 'missing'
        ? { level: 'info', text: '收藏库为空（首次使用），保存第一条后会自动创建文件。' }
        : null;
      render();
    } catch (e) {
      state.libLoading = false;
      state.libNotice = { level: 'error', text: `读取收藏库失败：${errText(e)}` };
      render();
    }
  }

  function askDelete(item) {
    confirmDialog({
      host: rootEl,
      title: '删除这条收藏？',
      message: `「${item.title || '(无标题)'}」将被删除，存储文件会被覆盖为新版本（上一版仍保留在 library.bak.json）。`,
      confirmLabel: '确认删除',
      onConfirm: async () => {
        const lib = normalizeLibrary({ ...state.library, items: (state.library.items || []).slice() });
        removeItem(lib, item.id);
        try {
          const res = await storage.save(lib);
          state.library = res.library;
          state.library.__path = storage.paths.human;
          state.libNotice = { level: 'info', text: `已删除：${item.title || '(无标题)'}` };
        } catch (e) {
          state.libNotice = { level: 'error', text: `删除失败（未写入，数据未变）：${errText(e)}` };
        }
        render();
      }
    });
  }

  /* ================= 探针：Prompt 卡片 ================= */

  /**
   * 简洁卡片：标题行（角色 / 目标节点 / 状态 / 字数）→ 来源行 → 3 行预览 → 操作行 → 技术详情（可展开）
   * 所有识别信息都保留，只是把低频技术细节收进 details。
   */
  function promptCard({ key, role, nodeLabel, status, mode, text, length, sourceLabel, warnings = [], details = [], selectPayload, extraMeta = null }) {
    const isSelected = state.selected?.key === key;
    const isOpen = state.expanded.has(key);

    const selectBtn = actionBtn(
      isSelected ? '已选中 ✓' : '选为收藏',
      () => toggleSelect(selectPayload, key),
      `pp-btn pp-btn-mini ${isSelected ? 'pp-primary' : ''}`
    );

    const head = h('div', { class: 'pp-field-h' }, [
      h('span', { class: `pp-role ${role === '负向' ? 'pp-role-neg' : ''}`, text: role }),
      h('span', { class: 'pp-mono pp-ellip', text: nodeLabel, title: nodeLabel }),
      badge(status, statusTextOf(status)),
      mode ? badge(mode === 4 ? 'unknown' : 'partial', mode) : null,
      h('span', { class: 'pp-spacer' }),
      h('span', { class: 'pp-len', text: `${length ?? String(text || '').length} 字` })
    ]);

    const kids = [head];
    if (sourceLabel) kids.push(h('div', { class: 'pp-src', text: sourceLabel }));
    for (const w of warnings) kids.push(h('div', { class: 'pp-warn', text: `⚠ ${w}` }));
    if (extraMeta) kids.push(extraMeta);

    const previewWrap = h('div', { class: isOpen ? '' : 'pp-clamp' }, [
      h('pre', { class: 'pp-text', text: text == null || text === '' ? '（空）' : String(text) })
    ]);
    kids.push(previewWrap);

    const actions = h('div', { class: 'pp-row', style: 'margin-top:6px' }, [
      selectBtn,
      actionBtn('复制', () => copyText(text ?? '', actions.querySelector('.pp-copy')), 'pp-btn pp-btn-mini pp-copy'),
      actionBtn(isOpen ? '收起' : '展开全文', () => {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      })
    ]);
    kids.push(actions);

    if (details.length) {
      const d = h('details', { class: 'pp-details' }, [
        h('summary', { class: 'pp-summary', text: '技术详情' }),
        ...details.filter(Boolean)
      ]);
      // 点「技术详情」不应触发卡片的选中/取消选中
      d.addEventListener('click', (ev) => ev.stopPropagation());
      kids.push(d);
    }

    const card = h('div', { class: `pp-field pp-selectable${isSelected ? ' pp-selected' : ''}` }, kids);
    card.addEventListener('click', () => toggleSelect(selectPayload, key));
    return card;
  }

  /** 字段（正向/负向）→ 卡片 */
  function fieldCard(field, target, chain) {
    const key = `chain-${chain.sampler.id}-${field.name}`;
    const srcNode = field.source ? `${field.source.cls} #${field.source.id}${field.source.title ? ` 「${field.source.title}」` : ''}` : '（未知）';

    const details = [];
    if (field.path) details.push(h('div', { class: 'pp-path', text: `取值链：${field.path}` }));
    if (field.source) details.push(h('div', { class: 'pp-path', text: `目标节点：${target.cls} #${target.id} · 字段 ${field.name}${field.fromLink ? '（来自连线）' : '（控件直写）'}` }));
    if (field.notes?.length) details.push(h('ul', { class: 'pp-notes' }, field.notes.map((n) => h('li', { text: n }))));
    if (field.branches?.length) {
      details.push(h('div', { class: 'pp-branches' }, [
        h('div', { text: '分支（ComfySwitchNode 等）：' }),
        ...field.branches.map((b) => h('div', {
          class: 'pp-branch',
          text: `${b.slot}${b.active === true ? '（当前生效）' : b.active === false ? '（未生效）' : ''} · ${b.length} 字 · ${b.statusText} — ${b.preview}`
        }))
      ]));
    }

    return promptCard({
      key,
      role: field.role,
      nodeLabel: `${target.cls} #${target.id} · ${field.name}`,
      status: field.status,
      mode: null,
      text: field.text,
      length: field.length,
      sourceLabel: `来源：${srcNode}`,
      warnings: warningsFor({ chain, field, status: field.status }) ? [warningsFor({ chain, field, status: field.status })] : [],
      details,
      selectPayload: selectionFromField(chain, field)
    });
  }

  function chainCard(chain, index, total) {
    const s = chain.sampler;
    const head = h('div', { class: 'pp-card-h' }, [
      h('span', { class: 'pp-tag', text: total > 1 ? `采样链 ${index + 1}/${total}` : '采样链' }),
      h('b', { class: 'pp-mono', text: `${s.cls} #${s.id}` }),
      s.group ? h('span', { class: 'pp-group', text: `【${s.group}】` }) : null,
      s.mode !== 0 ? badge(s.mode === 4 ? 'unknown' : 'partial', s.modeText) : badge('confirmed', s.modeText),
      h('span', { class: 'pp-spacer' }),
      h('span', { class: 'pp-len', text: `positive ← ${chain.entryName || 'positive'}` })
    ]);

    const kids = [head];
    if (chain.hint) kids.push(h('div', { class: 'pp-hint', text: chain.hint }));
    if (chain.warning) {
      kids.push(h('div', { class: 'pp-warn', text: `⚠ ${chain.warning}` }));
      return h('div', { class: 'pp-card' }, kids);
    }
    // 采样器 / 文本编码节点的"不参与出图"状态只说明一次
    const offParts = [];
    if (s.bypassed) offParts.push(`采样器「${s.modeText}」`);
    if (chain.target?.bypassed) offParts.push(`文本编码节点 #${chain.target.id}「${chain.target.modeText}」`);
    if (offParts.length) {
      kids.push(h('div', { class: 'pp-warn', text: `⚠ 本轮不参与出图：${offParts.join('、')}（下方文本仅作参考）` }));
    }

    for (const field of chain.fields) kids.push(fieldCard(field, chain.target, chain));

    if (chain.negative) {
      const n = chain.negative;
      kids.push(h('div', { class: 'pp-neg' }, [
        h('span', { class: 'pp-src', text: '负向：' }),
        h('span', { class: 'pp-mono', text: n.target ? `${n.target.cls} #${n.target.id} · ${n.field}` : '无文本编码节点' }),
        h('span', { class: 'pp-len', text: `${n.length} 字` }),
        badge(n.status, n.statusText),
        n.sameAsPositive ? h('span', { class: 'pp-hint', text: '（与正向同一节点）' }) : null,
        n.note ? h('span', { class: 'pp-hint', text: n.note }) : null,
        n.text ? negCopyBtn(n.text) : null
      ]));
    }
    return h('div', { class: 'pp-card' }, kids);
  }

  function candidatesCard(list) {
    const kids = [
      h('div', { class: 'pp-card-h' }, [
        h('span', { class: 'pp-tag', text: '候选文本' }),
        h('b', { text: `${list.length} 个文本编码节点未被采样链引用` })
      ]),
      h('div', { class: 'pp-hint', text: '这些节点的文本无法确认是否参与出图，仅作候选展示。' })
    ];
    for (const c of list) {
      const key = `candidate-${c.id}-${c.field}`;
      kids.push(promptCard({
        key,
        role: '候选',
        nodeLabel: `${c.cls} #${c.id} · ${c.field}`,
        status: c.status,
        mode: c.modeText && c.mode !== 0 ? c.modeText : null,
        text: c.text,
        length: c.length,
        sourceLabel: c.reason,
        details: [
          c.path ? h('div', { class: 'pp-path', text: `取值链：${c.path}` }) : null,
          c.notes?.length ? h('ul', { class: 'pp-notes' }, c.notes.map((n) => h('li', { text: n }))) : null
        ],
        selectPayload: selectionFromCandidate(c)
      }));
    }
    return h('div', { class: 'pp-card' }, kids);
  }

  /* ================= 渲染 ================= */

  function rescan() {
    if (!rootEl) return;
    try {
      const view = createLiveView(app, { workflowName: opts.workflowName?.() });
      state.result = scan(view);
      state.error = null;
    } catch (e) {
      state.result = null;
      state.error = `扫描异常：${e?.message || e}`;
      console.error('[Prompt Probe] scan failed', e);
    }
    state.scannedAt = new Date();
    state.expanded.clear();
    if (state.selected && state.result) {
      const inChains = state.result.chains.some((c) => state.selected.key === `chain-${c.sampler.id}-${state.selected.source?.field}`);
      const inCands = state.result.candidates.some((c) => state.selected.key === `candidate-${c.id}-${c.field}`);
      if (!inChains && !inCands) state.selected = null;
    }
    render();
  }

  function renderSeg() {
    segEl.textContent = '';
    const favCount = (state.library.items || []).length;
    const items = [
      { id: 'scan', label: '探针' },
      { id: 'library', label: `我的收藏 (${favCount})` }
    ];
    for (const it of items) {
      const b = h('button', { class: `pp-seg-btn ${state.view === it.id ? 'pp-seg-on' : ''}`, text: it.label });
      b.addEventListener('click', () => {
        state.view = it.id;
        if (it.id === 'library') {
          loadLibrary();
          return;
        }
        render();
      });
      segEl.appendChild(b);
    }
  }

  function renderToolbar() {
    toolbarEl.textContent = '';
    if (state.view === 'scan') {
      toolbarEl.appendChild(actionBtn('重新扫描', rescan, 'pp-btn'));
      toolbarEl.appendChild(actionBtn('★ 收藏 Prompt', () => openFavorite({ fromSelection: true }), 'pp-btn pp-primary'));
      return;
    }
    // 收藏页工具条由 favorites 渲染（搜索 / 筛选 / 刷新 / 导出）
    const holder = h('div', { class: 'pp-lib-toolbar' });
    toolbarEl.appendChild(holder);
    toolbarEl.__libSlot = holder;
  }

  function renderLibrary() {
    const items = filterItems(state.library, { query: state.libQuery, model: state.libModel });
    bodyEl.appendChild(renderLibraryView({
      library: state.library,
      query: state.libQuery,
      model: state.libModel,
      items,
      expanded: state.libExpanded,
      toolbarSlot: toolbarEl.__libSlot || null,
      notice: state.libLoading ? { level: 'info', text: '正在读取收藏库…' } : state.libNotice,
      onToggleExpand: (id) => {
        if (state.libExpanded.has(id)) state.libExpanded.delete(id);
        else state.libExpanded.add(id);
        render();
      },
      handlers: {
        onQuery: (v) => { state.libQuery = v; render(); },
        onModel: (v) => { state.libModel = v; render(); },
        onReload: () => loadLibrary(),
        onExport: () => {
          const payload = { ...state.library };
          delete payload.__path;
          const ok = downloadText(`prompt_library_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
          state.libNotice = { level: ok ? 'info' : 'warn', text: ok ? '已导出 JSON（浏览器下载）' : '当前环境不支持下载导出' };
          render();
        },
        onEdit: (item) => openFavorite({ item }),
        onDelete: (item) => askDelete(item)
      }
    }));
  }

  function renderScan() {
    if (state.error) {
      sumEl.appendChild(h('span', { class: 'pp-warn', text: state.error }));
      return;
    }
    const r = state.result;
    if (!r) return;

    sumEl.appendChild(h('div', { class: 'pp-wf', text: r.meta.workflowName || '未命名 / 未能取得工作流名' }));
    sumEl.appendChild(h('div', { class: 'pp-sum-line' }, [
      h('span', { text: `节点 ${r.meta.nodeCount} · 采样链 ${r.chains.length} · 候选 ${r.candidates.length}` }),
      state.scannedAt ? h('span', { text: `· 扫描于 ${state.scannedAt.toLocaleTimeString()}` }) : null
    ]));

    if (state.selected) {
      sumEl.appendChild(h('div', { class: 'pp-selected-bar' }, [
        h('span', { text: `已选中：${state.selected.source?.node_class || ''} #${state.selected.source?.node_id ?? '?'} · ${state.selected.source?.role || ''} · ${String(state.selected.text || '').length} 字` }),
        h('span', { class: 'pp-spacer' }),
        actionBtn('收藏这条', () => openFavorite({ fromSelection: true }), 'pp-btn pp-btn-mini pp-primary'),
        actionBtn('取消选择', () => { state.selected = null; render(); })
      ]));
      if (state.selected.warning) sumEl.appendChild(h('div', { class: 'pp-warn', text: `⚠ ${state.selected.warning}` }));
    }
    if (state.scanNotice) {
      sumEl.appendChild(h('div', { class: `pp-notice pp-notice-${state.scanNotice.level || 'warn'}` }, [h('div', { text: state.scanNotice.text })]));
    }

    const tabs = r.chains.map((c, i) => ({ label: `链${i + 1} · ${c.sampler.cls} #${c.sampler.id}`, card: () => chainCard(c, i, r.chains.length) }));
    if (r.candidates.length) tabs.push({ label: `候选文本 (${r.candidates.length})`, card: () => candidatesCard(r.candidates) });

    if (!tabs.length) {
      bodyEl.appendChild(h('div', { class: 'pp-empty', text: '当前工作流没有检测到「带 positive 输入的采样器 → 文本编码节点」结构。请确认画布上确实打开了工作流。' }));
      return;
    }
    if (state.activeTab >= tabs.length) state.activeTab = 0;

    tabs.forEach((t, i) => {
      const b = h('button', { class: `pp-tab ${i === state.activeTab ? 'pp-tab-active' : ''}`, text: t.label });
      b.addEventListener('click', () => { state.activeTab = i; render(); });
      tabsEl.appendChild(b);
    });

    bodyEl.appendChild(tabs[state.activeTab].card());

    if (r.errors?.length) {
      bodyEl.appendChild(h('div', { class: 'pp-card' }, [
        h('div', { class: 'pp-card-h' }, [h('span', { class: 'pp-tag', text: '解析异常' })]),
        h('ul', { class: 'pp-notes' }, r.errors.map((e) => h('li', { text: e })))
      ]));
    }
  }

  function render() {
    if (!rootEl) return;
    renderSeg();
    renderToolbar();
    sumEl.textContent = '';
    tabsEl.textContent = '';
    bodyEl.textContent = '';

    if (state.view === 'library') {
      renderLibrary();
      return;
    }
    tabsEl.style.display = '';
    renderScan();
  }

  function mount(el) {
    rootEl = h('div', { class: 'pp-root' });
    rootEl.appendChild(h('div', { class: 'pp-head' }, [
      h('span', { class: 'pp-title', text: 'Prompt Library' }),
      h('span', { class: 'pp-ver', text: 'v0.2 · 探针 / 收藏' })
    ]));
    segEl = h('div', { class: 'pp-seg' });
    toolbarEl = h('div', { class: 'pp-toolbar' });
    sumEl = h('div', { class: 'pp-sum' });
    tabsEl = h('div', { class: 'pp-tabs' });
    bodyEl = h('div', { class: 'pp-body' });
    rootEl.appendChild(segEl);
    rootEl.appendChild(toolbarEl);
    rootEl.appendChild(sumEl);
    rootEl.appendChild(tabsEl);
    rootEl.appendChild(bodyEl);
    rootEl.appendChild(h('div', { class: 'pp-foot', text: '只读探针 · 收藏存于 user\\default\\prompt_library\\' }));

    el.textContent = '';
    el.appendChild(rootEl);

    rescan();
    loadLibrary();
  }

  function destroy() {
    rootEl = null;
    segEl = null;
    toolbarEl = null;
    sumEl = null;
    tabsEl = null;
    bodyEl = null;
  }

  return {
    mount,
    destroy,
    rescan,
    state,
    /* 供自测 / 调试 */
    openFavorite,
    loadLibrary,
    persistItem,
    setView: (v) => { state.view = v; render(); },
    /** 排版体检（只读测量，验收用） */
    auditLayout: () => auditLayout(rootEl)
  };
}
