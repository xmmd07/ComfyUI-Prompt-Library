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

import { scan } from './resolver.mjs';
import { t, fmt, getLocale } from './i18n.mjs';
import { createLiveView } from './graphview.mjs';
import { renderLibraryView, openItemEditor, confirmDialog } from './favorites.mjs';
import { makeStorage, makeFileStore } from './storage.mjs';
import { auditLayout } from './layout-audit.mjs';
import { emptyLibrary, normalizeLibrary, upsertItem, removeItem, filterItems, validateItem, newId } from './library.mjs';
import {
  emptyArtists, normalizeArtists, mergeArtists, validateArtist, thumbFileFor, cleanOrig,
  fetchHistoryPage, viewFullUrl, makeThumbBlob, loadImageObjectURL, releaseImage, releaseAllImages,
  invalidateImage, openArtistEditor, renderArtistsView
} from './artists.mjs';
import {
  emptyLoras, normalizeLoras, mergeLoras, validateLora,
  fetchLoraList, openLoraEditor, renderLorasView
} from './loras.mjs';

const BADGE_CLASS = {
  confirmed: 'pp-badge-ok',
  partial: 'pp-badge-warn',
  candidate: 'pp-badge-info',
  runtime: 'pp-badge-muted',
  unknown: 'pp-badge-bad'
};

/**
 * 状态码 → 界面文案。`status` 本身是**稳定内部标识**（confirmed/candidate/…），
 * 永不翻译、永不入库为新文案；显示时才取词。
 */
const statusTextOf = (s) => (s ? t(`status.${s}`) : '');

/**
 * 角色码 → 界面文案。旧数据里 role 存的是中文（正向/负向/候选/附加），
 * 这里做兼容映射，保证历史收藏条目照常显示（不改写用户数据）。
 */
const LEGACY_ROLE = { '正向': 'positive', '负向': 'negative', '附加': 'extra', '候选': 'candidate' };
const roleCode = (r) => LEGACY_ROLE[r] || r || '';
const roleTextOf = (r) => (r ? t(`role.${roleCode(r)}`) : '');

const PREVIEW_LINES = 3;

export function createPanel(app, opts = {}) {
  const api = opts.api || globalThis.comfyAPI?.api?.api || null;
  const storage = api && typeof api.fetchApi === 'function' ? makeStorage(api) : null;
  const artFiles = api && typeof api.fetchApi === 'function' ? makeFileStore(api, { dir: 'prompt_library' }) : null;

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
    libSort: 'recent',           // 'recent'（默认，最新在前）| 'used'（最常用）
    libExpanded: new Set(),
    libNotice: null,
    libLoading: false,
    lastModel: null,
    /* 画师串 */
    artists: emptyArtists(),
    artNotice: null,
    artLoading: false,
    /* LoRA 提示词 */
    loras: emptyLoras(),
    loraNotice: null,
    loraLoading: false,
    /* 探针拼接分段区（chainKey -> 是否展开） */
    partsOpen: new Set()
  };

  let rootEl = null;
  let mountEl = null;            // 当前挂载的容器（幂等守卫用）
  let toolbarEl = null;
  let sumEl = null;
  let tabsEl = null;
  let bodyEl = null;
  let segEl = null;
  let titleEl = null;
  let verEl = null;
  let footEl = null;

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
    btn.textContent = ok ? t('notice.copied') : t('notice.copyFailed');
    // 恢复时按当前语言重算按键文案（存 key，不存当时的文字）
    setTimeout(() => { btn.textContent = btn.__ppLabelKey ? t(btn.__ppLabelKey) : label; }, 1200);
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
    const b = h('button', { class: 'pp-btn pp-btn-mini pp-copy', text: t('btn.copyNegative') });
    b.__ppLabelKey = 'btn.copyNegative';
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
    if (status !== 'confirmed') parts.push(t('warn.statusNotConfirmed', { status: statusTextOf(status) }));
    if (field?.staleWidget) parts.push(t('warn.staleWidget'));
    return parts.join(t('meta.listSep'));
  }

  function selectionFromField(chain, field) {
    const target = chain.target || {};
    const status = field.status;
    return {
      text: field.text ?? '',
      status,
      source: {
        workflow: state.result?.meta?.workflowName || '',
        node_id: target.id,
        node_class: target.cls,
        field: field.name,
        role: field.role,
        status,
        // 只存稳定标识（不再写界面文案）；旧数据里的中文值由 roleCode/statusTextOf 兼容
        status_text: status,
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
        role: 'candidate',
        status: c.status,
        status_text: c.status,
        group: c.group || '',
        collected_at: new Date().toISOString()
      },
      warning: t('warn.fromCandidate', { reason: fmt(c.reason), status: statusTextOf(c.status) })
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
        state.scanNotice = { level: 'warn', text: t('notice.noSelection') };
        state.view = 'scan';
        render();
        return;
      }
      if (!String(state.selected.text || '').trim()) {
        state.scanNotice = { level: 'warn', text: t('notice.selectionEmpty') };
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
      // 分段收藏传了带预填内容的 item 但不是编辑模式：用 item?.id 区分（新增时 id 为 undefined）
      mode: (item && item.id) ? 'edit' : 'create',
      item: draft,
      models: state.library.models,
      warning: fromSelection ? draft.warningText : '',
      onSave: async (saved) => {
        const check = validateItem(saved);
        if (!check.ok) return { ok: false, error: t('meta.errors', { list: Object.values(check.errors).map((c) => t(c)).join(t('meta.listSep')) }) };
        return await persistItem(saved);
      }
    });
  }

  async function persistItem(draft) {
    if (!storage) return { ok: false, error: t('err.noApiSave') };
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
        text: t(isNew ? 'notice.saved' : 'notice.updated', { title: item.title })
          + (res.merged ? t('notice.merged') : '')
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
      state.libNotice = { level: 'error', text: t('err.noApiLibrary') };
      render();
      return;
    }
    if (state.libLoading) return;   // in-flight 守卫：重入直接跳过（幂等 mount 后可能并发触发）
    state.libLoading = true;
    render();
    try {
      const r = await storage.load();
      state.libLoading = false;
      if (r.state === 'corrupt') {
        state.libNotice = {
          level: 'error',
          text: t('err.libraryCorrupt', { error: r.error || '' }),
          actions: [
            { label: t('btn.exportRaw'), onClick: () => downloadText('prompt_library.broken.json', r.raw || '') },
            { label: t('btn.retry'), onClick: () => { loadLibrary(); } },
            {
              label: t('btn.quarantine'),
              onClick: () => confirmDialog({
                host: rootEl,
                title: t('dlg.rebuildTitle'),
                message: t('dlg.rebuildMsg'),
                confirmLabel: t('btn.confirmRebuild'),
                onConfirm: async () => {
                  try {
                    const name = await storage.quarantineBroken(r.raw);
                    const fresh = await storage.resetToEmpty();
                    state.library = fresh;
                    state.library.__path = storage.paths.human;
                    state.libNotice = { level: 'info', text: t('notice.rebuilt', { name }) };
                  } catch (e) {
                    state.libNotice = { level: 'error', text: t('err.rebuildFailed', { error: errText(e) }) };
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
        ? { level: 'info', text: t('notice.libraryEmpty') }
        : null;
      render();
    } catch (e) {
      state.libLoading = false;
      state.libNotice = { level: 'error', text: t('err.readLibrary', { error: errText(e) }) };
      render();
    }
  }

  function askDelete(item) {
    confirmDialog({
      host: rootEl,
      title: t('dlg.deleteFavoriteTitle'),
      message: t('dlg.deleteFavoriteMsg', { title: item.title || t('meta.untitled') }),
      confirmLabel: t('btn.confirmDelete'),
      onConfirm: async () => {
        const lib = normalizeLibrary({ ...state.library, items: (state.library.items || []).slice() });
        removeItem(lib, item.id);
        try {
          const res = await storage.save(lib);
          state.library = res.library;
          state.library.__path = storage.paths.human;
          state.libNotice = { level: 'info', text: t('notice.deleted', { title: item.title || t('meta.untitled') }) };
        } catch (e) {
          state.libNotice = { level: 'error', text: t('err.deleteFailed', { error: errText(e) }) };
        }
        render();
      }
    });
  }

  /* ================= 画师串：读写与界面动作 ================= */

  const ART_FILE = 'artists.json';
  const ART_BACKUP = 'artists.bak.json';

  async function loadArtists() {
    if (!artFiles) {
      state.artNotice = { level: 'error', text: t('err.noApiArtists') };
      render();
      return;
    }
    if (state.artLoading) return;   // in-flight 守卫
    state.artLoading = true;
    render();
    try {
      const raw = await artFiles.readText(ART_FILE);
      state.artLoading = false;
      if (raw == null || !raw.trim()) {
        state.artists = emptyArtists();
        state.artNotice = null;
      } else {
        try {
          state.artists = normalizeArtists(JSON.parse(raw));
          state.artNotice = null;
        } catch (e) {
          state.artNotice = { level: 'error', text: t('err.artistsBadJson', { error: e.message }) };
        }
      }
    } catch (e) {
      state.artLoading = false;
      state.artNotice = { level: 'error', text: t('err.readArtists', { error: errText(e) }) };
    }
    render();
  }

  /** 保存 artists.json（备份 + rev 合并，与收藏库同规则）。传入最终数据，返回保存后的数据。 */
  async function saveArtists(next) {
    if (!artFiles) throw new Error(t('err.noApi'));
    // 损坏拒写：磁盘内容不可解析时停手
    const diskRaw = await artFiles.readText(ART_FILE);
    let diskParsed = null;
    if (diskRaw && diskRaw.trim()) {
      try { diskParsed = normalizeArtists(JSON.parse(diskRaw)); } catch (e) { diskParsed = null; }
      if (!diskParsed) throw new Error(t('err.artistsDiskBad'));
    }
    let merged = normalizeArtists(next);
    if (diskParsed && diskParsed.rev > merged.rev) merged = mergeArtists(merged, diskParsed);
    if (diskRaw && diskRaw.trim()) {
      try { await artFiles.writeText(ART_BACKUP, diskRaw); } catch (e) { /* 备份失败不阻断 */ }
    }
    const withRev = { ...merged, rev: Math.max(merged.rev, diskParsed?.rev || 0) + 1, updated_at: new Date().toISOString() };
    await artFiles.writeText(ART_FILE, JSON.stringify(withRev, null, 2));
    return withRev;
  }

  function askDeleteArtist(item) {
    confirmDialog({
      host: rootEl,
      title: t('dlg.deleteArtistTitle'),
      message: t('dlg.deleteArtistMsg', {
        text: `${(item.text || '').slice(0, 60)}${(item.text || '').length > 60 ? '…' : ''}`
      }),
      confirmLabel: t('btn.confirmDelete'),
      onConfirm: async () => {
        try {
          const next = normalizeArtists({ ...state.artists, items: state.artists.items.filter((x) => x.id !== item.id) });
          state.artists = await saveArtists(next);
          if (item.thumb) { try { await artFiles.remove(item.thumb); } catch (e) { /* 图片删不掉不影响数据 */ } }
          state.artNotice = { level: 'info', text: t('notice.artistDeleted') };
        } catch (e) {
          state.artNotice = { level: 'error', text: t('err.deleteFailed', { error: errText(e) }) };
        }
        render();
      }
    });
  }

  /** 收藏导入：选文件 → 校验 → 按 id 合并（本地已有即跳过，绝不覆盖/整库替换） */
  function importLibrary() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        state.libNotice = { level: 'error', text: t('err.fileTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }) };
        render();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch (e) {
        state.libNotice = { level: 'error', text: t('err.importNotJson') };
        render();
        return;
      }
      const incoming = (Array.isArray(parsed?.items) ? parsed.items : []).map(normalizeItem).filter(Boolean);
      if (!incoming.length) {
        state.libNotice = { level: 'error', text: t('err.importNoItems') };
        render();
        return;
      }
      // 按 id 合并：本地已有该 id 一律跳过（导入是"补充"不是"同步"，不覆盖手工攒的数据）
      const existing = new Set((state.library.items || []).map((x) => x.id));
      let added = 0;
      let skipped = 0;
      const models = new Set(state.library.models || []);
      const next = normalizeLibrary({ ...state.library, items: state.library.items.slice() });
      for (const it of incoming) {
        if (existing.has(it.id)) { skipped++; continue; }
        existing.add(it.id);
        next.items.push(it);
        if (it.model) models.add(it.model);
        added++;
      }
      if (!added) {
        state.libNotice = { level: 'warn', text: t('notice.importNone', { skipped }) };
        render();
        return;
      }
      next.models = [...models];
      try {
        const res = await storage.save(next);
        state.library = res.library;
        state.library.__path = storage.paths.human;
        state.libNotice = { level: 'info', text: t('notice.importOk', { added }) + (skipped ? t('notice.importSkipped', { skipped }) : '') };
        render();
      } catch (e) {
        state.libNotice = { level: 'error', text: t('err.importFailed', { error: errText(e) }) };
        render();
      }
    });
    input.click();
  }

  /** 收藏使用频率：复制成功后 +1（内存），防抖 5 秒落盘一次；切页/关面板立即 flush */
  const usageTimers = new Map();          // id -> timer
  function flushUsage() {
    for (const id of [...usageTimers.keys()]) {
      clearTimeout(usageTimers.get(id));
    }
    usageTimers.clear();
    if (!storage || !state.library) return;
    storage.save(normalizeLibrary({ ...state.library, items: state.library.items.slice() }))
      .then((res) => { state.library = res.library; state.library.__path = storage.paths.human; })
      .catch(() => { /* 静默 */ });
  }
  function bumpUsage(id) {
    const it = (state.library.items || []).find((x) => x.id === id);
    if (!it) return;
    it.use_count = (Number(it.use_count) || 0) + 1;
    it.last_used_at = new Date().toISOString();
    if (usageTimers.has(id)) clearTimeout(usageTimers.get(id));
    usageTimers.set(id, setTimeout(() => {
      usageTimers.delete(id);
      if (!storage || !state.library) return;
      storage.save(normalizeLibrary({ ...state.library, items: state.library.items.slice() }))
        .then((res) => { state.library = res.library; state.library.__path = storage.paths.human; })
        .catch(() => { /* 静默：下次复制再落盘 */ });
    }, 5000));
  }

  /** 画师串使用频率：复制成功后 +1（内存），防抖 5 秒落盘一次；切页/关面板立即 flush */
  const artUsageTimers = new Map();
  function flushArtistUsage() {
    for (const id of [...artUsageTimers.keys()]) clearTimeout(artUsageTimers.get(id));
    artUsageTimers.clear();
    if (!artFiles || !state.artists) return;
    saveArtists(normalizeArtists({ ...state.artists, items: state.artists.items.slice() }))
      .then((saved) => { state.artists = saved; })
      .catch(() => { /* 静默 */ });
  }
  function bumpArtistUsage(id) {
    const it = (state.artists.items || []).find((x) => x.id === id);
    if (!it) return;
    it.use_count = (Number(it.use_count) || 0) + 1;
    it.last_used_at = new Date().toISOString();
    if (artUsageTimers.has(id)) clearTimeout(artUsageTimers.get(id));
    artUsageTimers.set(id, setTimeout(() => {
      artUsageTimers.delete(id);
      if (!artFiles || !state.artists) return;
      saveArtists(normalizeArtists({ ...state.artists, items: state.artists.items.slice() }))
        .then((saved) => { state.artists = saved; })
        .catch(() => { /* 静默：下次复制再落盘 */ });
    }, 5000));
  }

  /** LoRA 使用频率：复制提示词/复制 LoRA 名成功后 +1（内存），防抖 5 秒落盘一次；切页/关面板立即 flush */
  const loraUsageTimers = new Map();
  function flushLoraUsage() {
    for (const id of [...loraUsageTimers.keys()]) clearTimeout(loraUsageTimers.get(id));
    loraUsageTimers.clear();
    if (!artFiles || !state.loras) return;
    saveLoras(normalizeLoras({ ...state.loras, items: state.loras.items.slice() }))
      .then((saved) => { state.loras = saved; })
      .catch(() => { /* 静默 */ });
  }
  function bumpLoraUsage(id) {
    const it = (state.loras.items || []).find((x) => x.id === id);
    if (!it) return;
    it.use_count = (Number(it.use_count) || 0) + 1;
    it.last_used_at = new Date().toISOString();
    if (loraUsageTimers.has(id)) clearTimeout(loraUsageTimers.get(id));
    loraUsageTimers.set(id, setTimeout(() => {
      loraUsageTimers.delete(id);
      if (!artFiles || !state.loras) return;
      saveLoras(normalizeLoras({ ...state.loras, items: state.loras.items.slice() }))
        .then((saved) => { state.loras = saved; })
        .catch(() => { /* 静默：下次复制再落盘 */ });
    }, 5000));
  }

  /** 保存（新增/编辑）：处理选图 → 压缩 1024px 副本 → 写 artists.json；串就是标题，没有名称字段 */
  async function persistArtist({ id, text, model, keepThumb, newPick }) {
    if (!artFiles) return { ok: false, error: t('err.noApiSave') };
    const check = validateArtist({ text });
    // 校验错误是 code，显示时才翻译
    if (!check.ok) return { ok: false, error: Object.values(check.errors).map((c) => t(c)).join('; ') };
    try {
      const isNew = !id;
      const itemId = id || newId();
      let thumb = null;
      let orig = null;
      const old = state.artists.items.find((x) => x.id === itemId);

      if (newPick) {
        // 换图/新选图：拉原图 → canvas 压缩约 1024px → webp 副本；同时记下 output 原图位置
        const { blob, ext } = await makeThumbBlob(viewFullUrl(newPick), 1024);
        const name = `artists/img_${String(itemId).replace(/-/g, '').slice(0, 12)}.${ext}`;
        await artFiles.writeBin(name, new Uint8Array(await blob.arrayBuffer()), `image/${ext}`);
        thumb = name;
        orig = cleanOrig(newPick);
        // 换图覆盖了同名（或新旧不同名）文件：强制失效图片缓存 + bump 版本参数，
        // 否则列表会继续显示内存缓存里的旧 objectURL（灯箱走 /view 直链所以是对的）
        if (old?.thumb) invalidateImage(old.thumb);
        invalidateImage(name);
        // 新副本用同名（id 派生）：老扩展名不同时（webp↔jpeg）清理旧文件
        if (old?.thumb && old.thumb !== name) {
          try { await artFiles.remove(old.thumb); } catch (e) { /* 尽力而为 */ }
        }
      } else if (keepThumb) {
        // 不动图：沿用旧 thumb 和旧 orig（否则编辑文案一次原图路径就丢了）
        thumb = old?.thumb || null;
        orig = old?.orig || null;
      }
      // 都不是（明确移除图片）→ thumb/orig 为 null，旧副本在保存成功后清理
      let oldThumbWhenDropped = null;
      if (!newPick && !keepThumb) {
        oldThumbWhenDropped = old?.thumb || null;
      }

      const now = new Date().toISOString();
      const next = normalizeArtists({ ...state.artists, items: state.artists.items.slice() });
      const idx = next.items.findIndex((x) => x.id === itemId);
      const entry = {
        id: itemId,
        text: String(text),
        thumb,
        orig,
        // model：弹窗里选择了就存；清除（null）时也保存 null —— 不能回退旧值，否则"清除"无效
        model: typeof model === 'string' && model.trim() ? model : null,
        created_at: idx >= 0 ? next.items[idx].created_at : now,
        updated_at: now
      };
      if (idx >= 0) next.items[idx] = entry;
      else next.items.push(entry);

      state.artists = await saveArtists(next);
      if (oldThumbWhenDropped) {
        try { await artFiles.remove(oldThumbWhenDropped); } catch (e) { /* 尽力而为 */ }
      }
      state.artNotice = { level: 'info', text: t(isNew ? 'notice.artistAdded' : 'notice.artistUpdated') };
      render();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /* ================= LoRA 提示词：读写与界面动作 ================= */

  const LORA_FILE = 'loras.json';
  const LORA_BACKUP = 'loras.bak.json';

  async function loadLoras() {
    if (!artFiles) {
      state.loraNotice = { level: 'error', text: t('err.noApiLoras') };
      render();
      return;
    }
    if (state.loraLoading) return;   // in-flight 守卫
    state.loraLoading = true;
    render();
    try {
      const raw = await artFiles.readText(LORA_FILE);
      state.loraLoading = false;
      if (raw == null || !raw.trim()) {
        state.loras = emptyLoras();
        state.loraNotice = null;
      } else {
        try {
          state.loras = normalizeLoras(JSON.parse(raw));
          state.loraNotice = null;
        } catch (e) {
          state.loraNotice = { level: 'error', text: t('err.lorasBadJson', { error: e.message }) };
        }
      }
    } catch (e) {
      state.loraLoading = false;
      state.loraNotice = { level: 'error', text: t('err.readLoras', { error: errText(e) }) };
    }
    render();
  }

  /** 保存 loras.json（备份 + rev 合并，与画师串/收藏库同规则）。传入最终数据，返回保存后的数据。 */
  async function saveLoras(next) {
    if (!artFiles) throw new Error(t('err.noApi'));
    const diskRaw = await artFiles.readText(LORA_FILE);
    let diskParsed = null;
    if (diskRaw && diskRaw.trim()) {
      try { diskParsed = normalizeLoras(JSON.parse(diskRaw)); } catch (e) { diskParsed = null; }
      if (!diskParsed) throw new Error(t('err.lorasDiskBad'));
    }
    let merged = normalizeLoras(next);
    if (diskParsed && diskParsed.rev > merged.rev) merged = mergeLoras(merged, diskParsed);
    if (diskRaw && diskRaw.trim()) {
      try { await artFiles.writeText(LORA_BACKUP, diskRaw); } catch (e) { /* 备份失败不阻断 */ }
    }
    const withRev = { ...merged, rev: Math.max(merged.rev, diskParsed?.rev || 0) + 1, updated_at: new Date().toISOString() };
    await artFiles.writeText(LORA_FILE, JSON.stringify(withRev, null, 2));
    return withRev;
  }

  function askDeleteLora(item) {
    confirmDialog({
      host: rootEl,
      title: t('dlg.deleteLoraTitle'),
      message: t('dlg.deleteLoraMsg', { name: loraBasenameOf(item.lora) }),
      confirmLabel: t('btn.confirmDelete'),
      onConfirm: async () => {
        try {
          const next = normalizeLoras({ ...state.loras, items: state.loras.items.filter((x) => x.id !== item.id) });
          state.loras = await saveLoras(next);
          state.loraNotice = { level: 'info', text: t('notice.deletedPlain') };
        } catch (e) {
          state.loraNotice = { level: 'error', text: t('err.deleteFailed', { error: errText(e) }) };
        }
        render();
      }
    });
  }

  const loraBasenameOf = (p) => {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (i >= 0 ? s.slice(i + 1) : s).slice(0, 60);
  };

  /** 保存（新增/编辑）LoRA 提示词 */
  async function persistLora({ id, lora, prompt }) {
    if (!artFiles) return { ok: false, error: t('err.noApiSave') };
    const check = validateLora({ lora, prompt });
    if (!check.ok) return { ok: false, error: Object.values(check.errors).map((c) => t(c)).join('; ') };
    try {
      const isNew = !id;
      const itemId = id || globalThis.crypto?.randomUUID?.() || 'l' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      const now = new Date().toISOString();
      const next = normalizeLoras({ ...state.loras, items: state.loras.items.slice() });
      const idx = next.items.findIndex((x) => x.id === itemId);
      const entry = {
        id: itemId,
        lora: String(lora).trim(),
        prompt: String(prompt),
        created_at: idx >= 0 ? next.items[idx].created_at : now,
        updated_at: now
      };
      if (idx >= 0) next.items[idx] = entry;
      else next.items.push(entry);

      state.loras = await saveLoras(next);
      state.loraNotice = { level: 'info', text: t(isNew ? 'notice.loraAdded' : 'notice.loraUpdated') };
      render();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /* ================= 探针：Prompt 卡片 ================= */

  /**
   * 简洁卡片：标题行（角色 / 目标节点 / 状态 / 字数）→ 来源行 → 3 行预览 → 操作行 → 技术详情（可展开）
   * 所有识别信息都保留，只是把低频技术细节收进 details。
   */
  function promptCard({ key, role, nodeLabel, status, mode, text, length, sourceLabel, warnings = [], details = [], selectPayload, extraMeta = null, extraAfterActions = null }) {
    const isSelected = state.selected?.key === key;
    const isOpen = state.expanded.has(key);

    const selectBtn = actionBtn(
      isSelected ? t('btn.selected') : t('btn.select'),
      () => toggleSelect(selectPayload, key),
      `pp-btn pp-btn-mini ${isSelected ? 'pp-primary' : ''}`
    );

    const roleCodeOf = roleCode(role);
    const head = h('div', { class: 'pp-field-h' }, [
      h('span', { class: `pp-role ${roleCodeOf === 'negative' ? 'pp-role-neg' : ''}`, text: roleTextOf(role) }),
      h('span', { class: 'pp-mono pp-ellip', text: nodeLabel, title: nodeLabel }),
      badge(status, statusTextOf(status)),
      mode ? badge(mode === 'mode.4' ? 'unknown' : 'partial', fmt(mode)) : null,
      h('span', { class: 'pp-spacer' }),
      h('span', { class: 'pp-len', text: t('meta.chars', { n: length ?? String(text || '').length }) })
    ]);

    const kids = [head];
    if (sourceLabel) kids.push(h('div', { class: 'pp-src', text: sourceLabel }));
    for (const w of warnings) kids.push(h('div', { class: 'pp-warn', text: `⚠ ${w}` }));
    if (extraMeta) kids.push(extraMeta);

    const previewWrap = h('div', { class: isOpen ? '' : 'pp-clamp' }, [
      h('pre', { class: 'pp-text', text: text == null || text === '' ? t('meta.empty') : String(text) })
    ]);
    kids.push(previewWrap);

    const actions = h('div', { class: 'pp-row', style: 'margin-top:6px' }, [
      selectBtn,
      actionBtn(t('btn.copy'), () => copyText(text ?? '', actions.querySelector('.pp-copy')), 'pp-btn pp-btn-mini pp-copy'),
      actionBtn(isOpen ? t('btn.collapse') : t('btn.expandAll'), () => {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      })
    ]);
    kids.push(actions);
    if (extraAfterActions) kids.push(extraAfterActions);

    if (details.length) {
      const d = h('details', { class: 'pp-details' }, [
        h('summary', { class: 'pp-summary', text: t('probe.details') }),
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

  /** 拼接分段区块：默认折叠，每段节点title/输入口 + 全文（3 行截断可展开）+ 独立复制/收藏 */
  function partsBlock(field, chain, chainKey) {
    const segs = Array.isArray(field.parts) ? field.parts.filter((s) => (s.text || '') !== '') : [];
    if (segs.length <= 1) return null;
    const segKids = segs.map((s, i) => {
      const segKey = `${chainKey}-seg-${i}`;
      const segOpen = state.expanded.has(segKey);
      const src = s.source ? `${s.source.cls} #${s.source.id}${s.source.title ? `「${s.source.title}」` : ''}` : t('meta.unknown');
      const segActions = h('div', { class: 'pp-row', style: 'margin:4px 0' }, [
        actionBtn(t('btn.copySegment', { n: String(s.text || '').length }), () => copyText(s.text ?? '', segActions.querySelector('.pp-copy')), 'pp-btn pp-btn-mini pp-copy'),
        actionBtn(t('btn.favoriteSegment'), () => favoriteSeg(chain, field, s, i), 'pp-btn pp-btn-mini pp-primary'),
        actionBtn(segOpen ? t('btn.collapse') : t('btn.expand'), () => {
          if (state.expanded.has(segKey)) state.expanded.delete(segKey);
          else state.expanded.add(segKey);
          render();
        }, 'pp-btn pp-btn-mini')
      ]);
      return h('div', { class: 'pp-part' }, [
        h('div', { class: 'pp-part-h' }, [
          h('span', {
            class: 'pp-mono pp-ellip',
            text: t('probe.segLine', { index: i + 1, src, name: s.name }),
            title: `${src} · ${s.name}`
          }),
          badge(s.status, statusTextOf(s.status))
        ]),
        h('div', { class: segOpen ? '' : 'pp-clamp' }, [
          h('pre', { class: 'pp-text', text: (s.text || '') === '' ? t('meta.empty') : String(s.text) })
        ]),
        segActions
      ]);
    });
    const d = h('details', { class: 'pp-details pp-parts' }, [
      h('summary', { class: 'pp-summary', text: t('probe.segSummary', { count: segs.length }) }),
      ...segKids
    ]);
    // 整区展开状态受控（存 state.partsOpen）：render 重建后不丢；点击不冒泡到卡片（避免误触发"选为收藏"）
    d.open = state.partsOpen.has(chainKey);
    d.addEventListener('click', (ev) => ev.stopPropagation());
    d.querySelector('summary').addEventListener('click', (ev) => {
      ev.preventDefault();
      if (state.partsOpen.has(chainKey)) state.partsOpen.delete(chainKey);
      else state.partsOpen.add(chainKey);
      render();
    });
    return d;
  }

  /** 收藏某个分段：走 openFavorite 同一条管道，预填该段全文，source 带分段来源标记 */
  function favoriteSeg(chain, field, seg, index) {
    const segSource = seg.source || {};
    openFavorite({
      fromSelection: false,
      item: {
        id: undefined,
        title: segSource.title ? t('probe.segTitleSuffix', { title: segSource.title, index: index + 1 }) : '',
        text: String(seg.text || ''),
        source: {
          workflow: state.result?.meta?.workflowName || '',
          node_id: segSource.id,
          node_class: segSource.cls,
          // 落库用 ASCII 稳定后缀（不写界面文案），旧数据里的「·分段N」显示时同样可读
          field: `${field.name}·seg${index + 1}`,
          seg: { index: index + 1, input: seg.name, node_title: segSource.title || '' },
          role: field.role,
          status: seg.status,
          // 落库只写稳定标识，不写界面文案（显示时再翻译）
          status_text: seg.status,
          sampler: `${chain.sampler.cls} #${chain.sampler.id}`,
          group: chain.sampler.group || '',
          collected_at: new Date().toISOString()
        }
      }
    });
  }

  /** 字段（正向/负向）→ 卡片 */
  function fieldCard(field, target, chain) {
    const key = `chain-${chain.sampler.id}-${field.name}`;
    const srcNode = field.source ? `${field.source.cls} #${field.source.id}${field.source.title ? ` 「${field.source.title}」` : ''}` : t('meta.unknown');

    const details = [];
    if (field.path) details.push(h('div', { class: 'pp-path', text: t('probe.valueChain', { path: fmt(field.path) }) }));
    if (field.source) {
      details.push(h('div', {
        class: 'pp-path',
        text: t('probe.targetNode', {
          cls: target.cls,
          id: target.id,
          field: field.name,
          how: field.fromLink ? t('probe.fromLink') : t('probe.fromWidget')
        })
      }));
    }
    if (field.notes?.length) details.push(h('ul', { class: 'pp-notes' }, field.notes.map((n) => h('li', { text: fmt(n) }))));
    if (field.branches?.length) {
      details.push(h('div', { class: 'pp-branches' }, [
        h('div', { text: t('probe.branches') }),
        ...field.branches.map((b) => h('div', { class: 'pp-branch', text: fmt(b.line) }))
      ]));
    }

    const partsEl = partsBlock(field, chain, key);

    return promptCard({
      key,
      role: field.role,
      nodeLabel: `${target.cls} #${target.id} · ${field.name}`,
      status: field.status,
      mode: null,
      text: field.text,
      length: field.length,
      sourceLabel: t('src.line', { src: srcNode }),
      warnings: warningsFor({ chain, field, status: field.status }) ? [warningsFor({ chain, field, status: field.status })] : [],
      details,
      extraAfterActions: partsEl,
      selectPayload: selectionFromField(chain, field)
    });
  }

  function chainCard(chain, index, total) {
    const s = chain.sampler;
    const head = h('div', { class: 'pp-card-h' }, [
      h('span', {
        class: 'pp-tag',
        text: total > 1 ? t('probe.samplingChainN', { i: index + 1, total }) : t('probe.samplingChain')
      }),
      h('b', { class: 'pp-mono', text: `${s.cls} #${s.id}` }),
      s.group ? h('span', { class: 'pp-group', text: t('probe.group', { group: s.group }) }) : null,
      s.mode !== 0 ? badge(s.mode === 4 ? 'unknown' : 'partial', fmt(s.modeText)) : badge('confirmed', fmt(s.modeText)),
      h('span', { class: 'pp-spacer' }),
      h('span', { class: 'pp-len', text: `positive ← ${chain.entryName || 'positive'}` })
    ]);

    const kids = [head];
    if (chain.hint) kids.push(h('div', { class: 'pp-hint', text: fmt(chain.hint) }));
    if (chain.warning) {
      kids.push(h('div', { class: 'pp-warn', text: `⚠ ${fmt(chain.warning)}` }));
      return h('div', { class: 'pp-card' }, kids);
    }
    // 采样器 / 文本编码节点的"不参与出图"状态只说明一次
    const offParts = [];
    if (s.bypassed) offParts.push(t('warn.bypassedSampler', { mode: fmt(s.modeText) }));
    if (chain.target?.bypassed) offParts.push(t('warn.bypassedEncoder', { id: chain.target.id, mode: fmt(chain.target.modeText) }));
    if (offParts.length) {
      kids.push(h('div', { class: 'pp-warn', text: t('warn.bypassed', { parts: offParts.join('; ') }) }));
    }

    for (const field of chain.fields) kids.push(fieldCard(field, chain.target, chain));

    if (chain.negative) {
      const n = chain.negative;
      kids.push(h('div', { class: 'pp-neg' }, [
        h('span', { class: 'pp-src', text: t('probe.negative') }),
        h('span', { class: 'pp-mono', text: n.target ? `${n.target.cls} #${n.target.id} · ${n.field}` : t('probe.noEncoder') }),
        h('span', { class: 'pp-len', text: t('meta.chars', { n: n.length }) }),
        badge(n.status, statusTextOf(n.status)),
        n.sameAsPositive ? h('span', { class: 'pp-hint', text: t('probe.sameAsPositive') }) : null,
        n.note ? h('span', { class: 'pp-hint', text: fmt(n.note) }) : null,
        n.text ? negCopyBtn(n.text) : null
      ]));
    }
    return h('div', { class: 'pp-card' }, kids);
  }

  function candidatesCard(list) {
    const kids = [
      h('div', { class: 'pp-card-h' }, [
        h('span', { class: 'pp-tag', text: t('probe.candidates') }),
        h('b', { text: t('probe.candidatesCount', { n: list.length }) })
      ]),
      h('div', { class: 'pp-hint', text: t('probe.candidatesHint') })
    ];
    for (const c of list) {
      const key = `candidate-${c.id}-${c.field}`;
      kids.push(promptCard({
        key,
        role: 'candidate',
        nodeLabel: `${c.cls} #${c.id} · ${c.field}`,
        status: c.status,
        mode: c.mode !== 0 ? (c.modeText || null) : null,
        text: c.text,
        length: c.length,
        sourceLabel: fmt(c.reason),
        details: [
          c.path ? h('div', { class: 'pp-path', text: t('probe.valueChain', { path: fmt(c.path) }) }) : null,
          c.notes?.length ? h('ul', { class: 'pp-notes' }, c.notes.map((n) => h('li', { text: fmt(n) }))) : null
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
      state.error = t('err.scanFailed', { error: e?.message || e });
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
    const artCount = (state.artists.items || []).length;
    const loraCount = (state.loras.items || []).length;
    // 长名给 title（悬停全名），短名给按钮；计数为 0 时不显示「·0」
    const segOf = (id, count) => ({
      label: t(`seg.${id}`, { count }),
      short: count ? t(`seg.${id}Short`, { count }) : t(`seg.${id}Short0`)
    });
    const items = [
      { id: 'scan', label: t('seg.scan'), short: t('seg.scanShort') },
      { id: 'library', ...segOf('library', favCount) },
      { id: 'artists', ...segOf('artists', artCount) },
      { id: 'loras', ...segOf('loras', loraCount) }
    ];
    for (const it of items) {
      const b = h('button', { class: `pp-seg-btn ${state.view === it.id ? 'pp-seg-on' : ''}`, text: it.short, title: it.label });
      b.addEventListener('click', () => {
        state.view = it.id;
        if (it.id === 'library') {
          loadLibrary();
          return;
        }
        if (it.id === 'artists') {
          loadArtists();
          return;
        }
        if (it.id === 'loras') {
          loadLoras();
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
      toolbarEl.appendChild(actionBtn(t('btn.rescan'), rescan, 'pp-btn'));
      toolbarEl.appendChild(actionBtn(t('btn.favoritePrompt'), () => openFavorite({ fromSelection: true }), 'pp-btn pp-primary'));
      return;
    }
    if (state.view === 'artists') {
      // 画师串页工具条由 artists 视图渲染（添加 / 刷新）
      const holder = h('div', { class: 'pp-lib-toolbar' });
      toolbarEl.appendChild(holder);
      toolbarEl.__artSlot = holder;
      return;
    }
    if (state.view === 'loras') {
      // LoRA 页工具条由 loras 视图渲染（添加 / 刷新）
      const holder = h('div', { class: 'pp-lib-toolbar' });
      toolbarEl.appendChild(holder);
      toolbarEl.__loraSlot = holder;
      return;
    }
    // 收藏页工具条由 favorites 渲染（搜索 / 筛选 / 刷新 / 导出）
    const holder = h('div', { class: 'pp-lib-toolbar' });
    toolbarEl.appendChild(holder);
    toolbarEl.__libSlot = holder;
  }

  function renderLibrary() {
    const items = filterItems(state.library, { query: state.libQuery, model: state.libModel })
      .slice()
      .sort((a, b) => state.libSort === 'used'
        ? ((Number(b.use_count) || 0) - (Number(a.use_count) || 0))
        : String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    bodyEl.appendChild(renderLibraryView({
      library: state.library,
      query: state.libQuery,
      model: state.libModel,
      items,
      sort: state.libSort,
      expanded: state.libExpanded,
      toolbarSlot: toolbarEl.__libSlot || null,
      notice: state.libLoading ? { level: 'info', text: t('notice.loadingLibrary') } : state.libNotice,
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
          state.libNotice = { level: ok ? 'info' : 'warn', text: ok ? t('notice.exported') : t('notice.exportUnsupported') };
          render();
        },
        onEdit: (item) => openFavorite({ item }),
        onDelete: (item) => askDelete(item),
        onImport: () => importLibrary(),
        onSort: (v) => { state.libSort = v; render(); },
        onUsed: (id) => { bumpUsage(id); render(); },
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

    sumEl.appendChild(h('div', { class: 'pp-wf', text: r.meta.workflowName || t('meta.unnamedWorkflow') }));
    sumEl.appendChild(h('div', { class: 'pp-sum-line' }, [
      h('span', {
        text: t('probe.summary', {
          nodes: r.meta.nodeCount,
          chains: r.chains.length,
          candidates: r.candidates.length
        })
      }),
      // 时间按当前语言格式化（zh 与 en 的时分秒写法不同）
      state.scannedAt
        ? h('span', { text: t('probe.scannedAt', { time: state.scannedAt.toLocaleTimeString(getLocale()) }) })
        : null
    ]));

    if (state.selected) {
      sumEl.appendChild(h('div', { class: 'pp-selected-bar' }, [
        h('span', {
          text: t('probe.selectedBar', {
            cls: state.selected.source?.node_class || '',
            id: state.selected.source?.node_id ?? '?',
            role: roleTextOf(state.selected.source?.role) || '',
            n: String(state.selected.text || '').length
          })
        }),
        h('span', { class: 'pp-spacer' }),
        actionBtn(t('btn.favoriteThis'), () => openFavorite({ fromSelection: true }), 'pp-btn pp-btn-mini pp-primary'),
        actionBtn(t('btn.deselect'), () => { state.selected = null; render(); })
      ]));
      if (state.selected.warning) sumEl.appendChild(h('div', { class: 'pp-warn', text: `⚠ ${state.selected.warning}` }));
    }
    if (state.scanNotice) {
      sumEl.appendChild(h('div', { class: `pp-notice pp-notice-${state.scanNotice.level || 'warn'}` }, [h('div', { text: state.scanNotice.text })]));
    }

    const tabs = r.chains.map((c, i) => ({
      label: t('probe.chainTab', { i: i + 1, cls: c.sampler.cls, id: c.sampler.id }),
      card: () => chainCard(c, i, r.chains.length)
    }));
    if (r.candidates.length) {
      tabs.push({ label: t('probe.candidateTab', { n: r.candidates.length }), card: () => candidatesCard(r.candidates) });
    }

    if (!tabs.length) {
      bodyEl.appendChild(h('div', { class: 'pp-empty', text: t('empty.noChain') }));
      return;
    }
    if (state.activeTab >= tabs.length) state.activeTab = 0;

    tabs.forEach((tab, i) => {
      const b = h('button', { class: `pp-tab ${i === state.activeTab ? 'pp-tab-active' : ''}`, text: tab.label });
      b.addEventListener('click', () => { state.activeTab = i; render(); });
      tabsEl.appendChild(b);
    });

    bodyEl.appendChild(tabs[state.activeTab].card());

    if (r.errors?.length) {
      bodyEl.appendChild(h('div', { class: 'pp-card' }, [
        h('div', { class: 'pp-card-h' }, [h('span', { class: 'pp-tag', text: t('probe.errors') })]),
        h('ul', { class: 'pp-notes' }, r.errors.map((e) => h('li', { text: fmt(e) })))
      ]));
    }
  }

  function renderArtists() {
    bodyEl.appendChild(renderArtistsView({
      data: state.artists,
      items: state.artists.items,
      notice: state.artLoading ? { level: 'info', text: t('notice.loadingArtists') } : state.artNotice,
      toolbarSlot: toolbarEl.__artSlot || null,
      api,
      host: rootEl,
      onUsed: (id) => { bumpArtistUsage(id); render(); },
      loadImage: (name) => loadImageObjectURL(api, name),
      releaseImageRef: releaseImage,
      handlers: {
        onAdd: () => openArtistEditor({ host: rootEl, mode: 'create', item: {}, api, onSave: persistArtist }),
        onEdit: (item) => openArtistEditor({ host: rootEl, mode: 'edit', item, api, onSave: persistArtist }),
        onDelete: (item) => askDeleteArtist(item),
        onReload: () => loadArtists()
      }
    }));
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
    if (state.view === 'artists') {
      tabsEl.style.display = 'none';
      renderArtists();
      return;
    }
    if (state.view === 'loras') {
      tabsEl.style.display = 'none';
      renderLoras();
      return;
    }
    tabsEl.style.display = '';
    renderScan();
  }

  function renderLoras() {
    bodyEl.appendChild(renderLorasView({
      data: state.loras,
      notice: state.loraLoading ? { level: 'info', text: t('notice.loadingLoras') } : state.loraNotice,
      toolbarSlot: toolbarEl.__loraSlot || null,
      api,
      onUsed: (id) => { bumpLoraUsage(id); render(); },
      handlers: {
        onAdd: () => openLoraEditor({ host: rootEl, mode: 'create', item: {}, api, onSave: persistLora }),
        onEdit: (item) => openLoraEditor({ host: rootEl, mode: 'edit', item, api, onSave: persistLora }),
        onDelete: (item) => askDeleteLora(item),
        onReload: () => loadLoras()
      }
    }));
  }

  /** 面板版本号（由入口注入，避免与 prompt_probe.js 各写一份） */
  const VERSION = opts.version || '0.5.0';

  function mount(el) {
    // 幂等守卫：同一容器且还在文档里 → 不重建 DOM、不重新拉数据。
    // （新版 ComfyUI 前端在画布交互时会重新触发 render 回调，无此守卫会导致
    //   面板反复重建 + 「正在读取收藏库…」闪烁。真关闭侧边栏时 destroy 会清 rootEl，再开照常全量加载。）
    if (rootEl && mountEl === el && el && el.isConnected) return;

    rootEl = h('div', { class: 'pp-root' });
    titleEl = h('span', { class: 'pp-title', text: t('tab.title') });
    verEl = h('span', { class: 'pp-ver', text: t('tab.version', { version: VERSION }) });
    footEl = h('div', { class: 'pp-foot', text: t('tab.foot') });
    rootEl.appendChild(h('div', { class: 'pp-head' }, [titleEl, verEl]));
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
    rootEl.appendChild(footEl);

    el.textContent = '';
    el.appendChild(rootEl);
    mountEl = el;

    rescan();
    loadLibrary();
    loadArtists();
    loadLoras();
  }

  function destroy() {
    flushUsage();            // 防抖中的使用计数立即落盘，避免关面板丢计数
    flushArtistUsage();
    flushLoraUsage();
    releaseAllImages();
    rootEl = null;
    mountEl = null;
    segEl = null;
    titleEl = null;
    verEl = null;
    footEl = null;
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
    loadArtists,
    persistArtist,
    loadLoras,
    persistLora,
    setView: (v) => { state.view = v; render(); },
    /** 语言切换后调用：重建头部文案并整页重渲染（保留当前页/选中/展开状态） */
    refreshTexts: () => {
      try {
        if (titleEl) titleEl.textContent = t('tab.title');
        if (verEl) verEl.textContent = t('tab.version', { version: VERSION });
        if (footEl) footEl.textContent = t('tab.foot');
        state.libNotice = null;
        state.artNotice = null;
        state.loraNotice = null;
        state.scanNotice = null;
        render();
      } catch (e) {
        console.warn('[Prompt Library] refreshTexts failed', e);
      }
    },
    /** 排版体检（只读测量，验收用） */
    auditLayout: () => auditLayout(rootEl)
  };
}
