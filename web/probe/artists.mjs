/**
 * artists.mjs —— 画师串（artist string）收藏：数据模型 + 界面（原生 DOM，无框架）
 *
 * 设计（v0.4.3 起含模型）：
 *   · 条目 = 画师串本身（没有名称/备注字段——串就是标题）；
 *   · 可选一个主模型（diffusion_models，v0.4.3 新增）：同一段画师串配不同微调模型出图有差异，
 *     用途是记「这段串配哪个模型」；可空（历史数据无此字段，归一化为 null）；
 *   · 可选一张参考图：从「出图历史」网格里点选，保存为约 1024px 的 webp 副本，
 *     存进 user\default\prompt_library\artists\（output 清理后仍在）；
 *   · 不做搜索/筛选/导入导出（v1）。
 *
 * 数据文件：prompt_library\artists.json（与收藏库同一套安全写入：备份 + 合并 + 损坏拒写）。
 * 图片文件：prompt_library\artists\img_<id>.webp。
 * 图片显示：新版 /userdata 强制 attachment 头，不能直接 <img src>，
 *   统一走 loadImageObjectURL()（fetch → blob → objectURL，带缓存，卸载时回收）。
 */

import { h, confirmDialog, copyToClipboard } from './favorites.mjs';
import { newId } from './library.mjs';
import { openModelPicker, loraBasename as basenameOf } from './loras.mjs';

/* ===================== 数据模型 ===================== */

export function emptyArtists() {
  return { version: 1, rev: 0, updated_at: null, items: [] };
}

/** 原图路径清洗：filename 去路径分隔符、拒绝 ..；subfolder 去首尾分隔符。不合法 → null */
export function cleanOrig(orig) {
  if (!orig || typeof orig !== 'object') return null;
  const fn = String(orig.filename || '').split(/[\\/]+/).pop().trim();
  if (!fn || fn === '.' || fn === '..' || fn.includes('..')) return null;
  const sub = String(orig.subfolder || '').replace(/^[\\/]+|[\\/]+$/g, '');
  if (sub.includes('..')) return null;
  return { filename: fn, subfolder: sub };
}

export function normalizeArtists(obj) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const items = Array.isArray(src.items) ? src.items : [];
  const seen = new Set();
  const clean = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const text = typeof it.text === 'string' ? it.text : '';
    if (!text.trim()) continue;
    const id = typeof it.id === 'string' && it.id ? it.id : newId();
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push({
      id,
      text,
      thumb: typeof it.thumb === 'string' && it.thumb ? it.thumb : null,
      orig: cleanOrig(it.orig),
      model: typeof it.model === 'string' && it.model.trim() ? it.model : null,
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

/** 磁盘版本更新（rev 更高）时按 id 合并，避免多标签页互相覆盖 */
export function mergeArtists(local, disk) {
  const byId = new Map();
  for (const it of local.items) byId.set(it.id, it);
  for (const it of disk.items) {
    const mine = byId.get(it.id);
    if (!mine || (it.updated_at || '') > (mine.updated_at || '')) byId.set(it.id, it);
  }
  return { version: 1, rev: Math.max(local.rev, disk.rev), updated_at: new Date().toISOString(), items: [...byId.values()] };
}

export function validateArtist(item) {
  const errors = {};
  if (!item || !String(item.text || '').trim()) errors.text = '画师串内容不能为空';
  return { ok: !Object.keys(errors).length, errors };
}

export const thumbFileFor = (id) => `artists/img_${String(id).replace(/-/g, '').slice(0, 12)}.webp`;

/* ===================== /history、/view 辅助 ===================== */

/** 把 /history 的返回摊平成「output 图片」列表（只取真正落盘的出图） */
export function flattenHistoryImages(historyJson) {
  const entries = Object.entries(historyJson || {});
  const out = [];
  const seen = new Set();            // filename+subfolder 去重：同一张图经多个节点回报（如对比器 a/b_images）只取一次
  for (const [promptId, rec] of entries) {
    const outputs = rec?.outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      for (const im of outputs[nodeId]?.images || []) {
        const type = (im.type || 'output') === 'temp' ? 'temp' : 'output';
        if (!im.filename) continue;
        const key = `${im.filename}\u0000${im.subfolder || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ filename: im.filename, subfolder: im.subfolder || '', type, prompt_id: promptId });
      }
    }
  }
  // 新→旧：/history 本身是新的在前，但摊平后同一记录内顺序无保证，稳定排序即可；
  // 选图网格里 output 排前、temp 排后（temp 是预览图，可能被 ComfyUI 定期清理）
  out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'output' ? -1 : 1));
  return out;
}

export async function fetchHistoryPage(api, { limit = 24, offset = 0 } = {}) {
  const res = await api.fetchApi(`/history?max_items=${limit}&offset=${offset}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`读取出图历史失败：HTTP ${res.status}`);
  const j = await res.json();
  const imgs = flattenHistoryImages(j);
  return { imgs, returned: Object.keys(j || {}).length, requested: limit };
}

/** 出图缩略图（官方 /view preview 参数，ComfyUI 自己的历史面板同款；网格用，快） */
export function viewThumbUrl(im) {
  const type = im.type === 'temp' ? 'temp' : 'output';
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type, preview: 'webp;8' });
  return `/view?${q}`;
}

/** 出图原图（保存副本时取这个再压缩） */
export function viewFullUrl(im) {
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: 'output' });
  return `/view?${q}`;
}

/* ===================== 图片压缩（副本） ===================== */

/**
 * 把图片 URL 压成最长边 maxPx 的 webp 副本（浏览器 canvas；webp 编码失败退回 jpeg）。
 * @returns {Promise<{blob:Blob, ext:'webp'|'jpeg'}>}
 */
export async function makeThumbBlob(url, maxPx = 1024) {
  const img = await new Promise((res, rej) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = () => rej(new Error('参考图加载失败（文件可能已被清理）'));
    el.src = url;
  });
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || maxPx) * scale));
  const hgt = Math.max(1, Math.round((img.naturalHeight || maxPx) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  canvas.getContext('2d').drawImage(img, 0, 0, w, hgt);
  const tryBlob = (type, q) => new Promise((res) => canvas.toBlob((b) => res(b), type, q));
  const webp = await tryBlob('image/webp', 0.85);
  if (webp && webp.size > 0) return { blob: webp, ext: 'webp' };
  const jpeg = await tryBlob('image/jpeg', 0.85);
  if (jpeg && jpeg.size > 0) return { blob: jpeg, ext: 'jpeg' };
  throw new Error('浏览器无法生成小图副本（canvas 编码失败）');
}

/* ===================== /userdata 图片读取（attachment 头 → objectURL） ===================== */

const urlCache = new Map();   // name -> {url, refs}

/** 读取数据目录里的图片并给出可显示的 objectURL；用 releaseImage() 归还。
 *  name 是相对于数据根（如 prompt_library）的路径：artists/img_xxx.webp */
export async function loadImageObjectURL(api, name, dir = 'prompt_library') {
  if (!name) return null;
  const full = name.startsWith(dir + '/') ? name : `${dir}/${name}`;
  const hit = urlCache.get(full);
  if (hit) { hit.refs += 1; return hit.url; }
  const res = await api.fetchApi(`/userdata/${encodeURIComponent(full)}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取图片失败：HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const type = full.endsWith('.webp') ? 'image/webp' : full.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const url = URL.createObjectURL(new Blob([buf], { type }));
  urlCache.set(full, { url, refs: 1 });
  return url;
}

export function releaseImage(name, dir = 'prompt_library') {
  const full = name && !name.startsWith(dir + '/') ? `${dir}/${name}` : name;
  const hit = urlCache.get(full);
  if (!hit) return;
  hit.refs -= 1;
  if (hit.refs <= 0) {
    URL.revokeObjectURL(hit.url);
    urlCache.delete(full);
  }
}

/** 面板销毁时整体回收 */
export function releaseAllImages() {
  for (const { url } of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/** 测试辅助：查看某张图的当前引用数（0 = 未加载或已回收） */
export function imageRefs(name, dir = 'prompt_library') {
  const full = name && !name.startsWith(dir + '/') ? `${dir}/${name}` : name;
  return urlCache.get(full)?.refs || 0;
}

/* ===================== 灯箱（点列表缩略图放大查看） ===================== */

/**
 * 打开灯箱：优先显示 output 原图直链（orig 存在时），加载失败（原图被删/移动）回退到压缩副本。
 * 原图走服务器直链不进 urlCache；只有回退分支才借一次副本引用，关闭时归还。
 * @returns {() => void} close
 */
export function openLightbox(host, { url, releaseRef, orig = null, loadImage = null, releaseImageRef = null }) {
  const ov = h('div', {
    class: 'pp-overlay pp-art-lightbox',
    title: '点击空白处关闭',
    onclick: (ev) => { if (ev.target === ov) close(); }
  }, [
    h('div', { class: 'pp-art-lightbox-inner' }, [
      h('img', { class: 'pp-art-lightbox-img', alt: '参考图放大', onclick: () => close() }),
      h('div', { class: 'pp-art-lightbox-note', text: '加载中…' })
    ]),
    h('button', { class: 'pp-art-lightbox-x pp-btn', text: '×', onclick: () => close() })
  ]);
  const img = ov.querySelector('.pp-art-lightbox-img');
  const note = ov.querySelector('.pp-art-lightbox-note');
  let copyRefHeld = false;    // 回退分支借到的副本引用；只归还一次

  const useOriginal = () => {
    note.textContent = '';
    img.src = url;                                  // 原图直链 /view?filename=...（无 preview）
    img.addEventListener('error', () => {
      if (copyRefHeld) return;
      copyRefHeld = true;
      // 原图不在了 → 借一次副本引用回退
      Promise.resolve()
        .then(() => (loadImage && releaseImageRef ? loadImage(orig.thumbName) : null))
        .then((fbUrl) => {
          if (!fbUrl || !ov.isConnected) {
            if (fbUrl && releaseImageRef) { releaseImageRef(orig.thumbName); copyRefHeld = false; }
            if (ov.isConnected) note.textContent = '图片加载失败';
            return;
          }
          note.textContent = '原图已不在 output，显示压缩副本';
          img.src = fbUrl;
        })
        .catch(() => { if (ov.isConnected) note.textContent = '图片加载失败'; });
    });
  };

  const useCopy = () => {
    note.textContent = '';
    img.src = url;
  };

  function close() {
    ov.remove();
    if (copyRefHeld) {
      copyRefHeld = false;
      try { releaseImageRef?.(orig.thumbName); } catch { /* 已回收就算了 */ }
    } else if (!orig) {
      try { releaseRef?.(); } catch { /* 已回收就算了 */ }
    }
  }

  if (orig && orig.filename && loadImage) useOriginal();
  else useCopy();
  host.appendChild(ov);
  return close;
}

/* ===================== 界面：编辑弹窗（添加 / 编辑） ===================== */

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {'create'|'edit'} o.mode
 * @param {object} [o.item]           {id?, text, thumb(数据目录相对名|null)}
 * @param {function} o.onSave         async ({id?, text, keepThumb, newPick}) => {ok, error?}
 *                                    newPick = 选中的出图 {filename, subfolder} | null（表示换图）
 *                                    keepThumb = true 表示沿用原图不动
 * @param {function} [o.onCancel]
 * @param {object} o.api              comfy api（取历史用；null 则选图入口禁用）
 */
export function openArtistEditor({ host, mode = 'create', item = {}, onSave, onCancel, api = null }) {
  const isEdit = mode === 'edit';
  const ov = h('div', { class: 'pp-overlay' });
  host.appendChild(ov);
  const close = () => { ov.remove(); };

  const errEl = h('div', { class: 'pp-dlg-errors' });
  const textArea = h('textarea', { class: 'pp-input pp-textarea', rows: '8', placeholder: '画师串，例如：artist:xxx, artist:yyy, ...（保存后它就是这条的标题）' });
  textArea.value = item.text || '';
  const lenEl = h('span', { class: 'pp-len' });
  const refreshLen = () => { lenEl.textContent = `${String(textArea.value || '').length} 字`; };
  textArea.addEventListener('input', refreshLen);
  refreshLen();

  /* —— 图片选择区 —— */
  let pick = null;                 // 新选的出图 {filename, subfolder}
  let dropImage = false;           // 编辑时明确移除图片
  const imgBox = h('div', { class: 'pp-art-pickbox' });
  const pickThumbImg = h('img', { class: 'pp-art-pickthumb', alt: '参考图预览' });
  const pickThumbWrap = h('div', { class: 'pp-art-thumbwrap' }, [pickThumbImg]);
  pickThumbWrap.style.display = 'none';

  /* —— 模型选择区（v0.4.3：diffusion_models，可空） —— */
  let model = typeof item.model === 'string' ? item.model : null;
  const modelShown = h('span', {
    class: 'pp-lib-title pp-art-model-shown',
    text: model ? basenameOf(model) : '未指定模型',
    title: model || '未指定模型（可点「选择模型」从主模型列表里挑）'
  });
  const refreshModelRow = () => {
    modelShown.textContent = model ? basenameOf(model) : '未指定模型';
    modelShown.title = model || '未指定模型';
    modelPickBtn.textContent = model ? '换模型…' : '选择模型…';
    clearBtnWrap.textContent = '';
    if (model) clearBtnWrap.appendChild(modelClearBtn);
  };
  const modelPickBtn = h('button', {
    class: 'pp-btn pp-btn-mini',
    text: '选择模型…',
    onclick: () => {
      if (!api) return;
      openModelPicker({
        host: ov, api, folder: 'diffusion_models', title: '选择主模型（diffusion_models）',
        onPick: (p) => { model = p; refreshModelRow(); }
      });
    }
  });
  const modelClearBtn = h('button', {
    class: 'pp-btn pp-btn-mini',
    text: '清除',
    onclick: () => { model = null; refreshModelRow(); }
  });
  const clearBtnWrap = h('span');

  let previewUrl = null;           // objectURL（编辑已有图时）
  refreshModelRow();
  const renderPick = () => {
    imgBox.textContent = '';
    if (previewUrl) {
      pickThumbImg.src = previewUrl;
      pickThumbWrap.style.display = '';
    } else {
      pickThumbWrap.style.display = 'none';
    }
    const line = h('div', { class: 'pp-row' }, [
      pickThumbWrap,
      h('div', { class: 'pp-art-pickinfo' }, [
        h('div', { class: 'pp-hint', text: pick
          ? `已选：${pick.filename}${pick.subfolder ? ` （${pick.subfolder}）` : ''} —— 保存时会压缩成约 1024px 副本`
          : previewUrl ? '沿用当前参考图（保存时不变）' : '可以不选图（纯文本画师串）' }),
        h('div', { class: 'pp-row', style: 'margin-top:6px' }, [
          api ? h('button', {
            class: 'pp-btn pp-btn-mini', text: isEdit && (previewUrl || pick) ? '换一张…' : '从出图历史选图…',
            onclick: () => openHistoryPicker({
              host: ov,
              api,
              onPick: (im) => {
                if (previewUrl) { previewUrl = null; }
                pick = im ? { filename: im.filename, subfolder: im.subfolder || '' } : null;
                dropImage = false;
                if (im) previewUrl = viewThumbUrl(im);   // 预览用官方缩略图直链
                renderPick();
              }
            })
          }) : h('span', { class: 'pp-hint', text: '（未取到 API，无法选图）' }),
          (previewUrl && isEdit) ? h('button', {
            class: 'pp-btn pp-btn-mini pp-danger', text: '移除图片',
            onclick: () => { previewUrl = null; pick = null; dropImage = true; renderPick(); }
          }) : null,
          pick ? h('button', { class: 'pp-btn pp-btn-mini', text: '取消选择', onclick: () => { pick = null; previewUrl = isEdit ? null : null; dropImage = isEdit; renderPick(); } }) : null
        ])
      ])
    ]);
    imgBox.appendChild(line);
  };
  renderPick();

  /* —— 编辑已有图：先显示当前副本 —— */
  if (isEdit && item.thumb && api) {
    loadImageObjectURL(api, item.thumb).then((u) => {
      if (u && !pick && !dropImage && ov.isConnected) { previewUrl = u; renderPick(); }
    }).catch(() => { /* 显示不出来就当没有图 */ });
  }

  const saveBtn = h('button', { class: 'pp-btn pp-primary', text: isEdit ? '保存修改' : '保存' });
  const cancelBtn = h('button', { class: 'pp-btn', text: '取消' });
  saveBtn.addEventListener('click', async () => {
    errEl.textContent = '';
    const text = textArea.value;
    const check = validateArtist({ text });
    if (!check.ok) {
      errEl.appendChild(h('div', { class: 'pp-warn', text: `· ${Object.values(check.errors).join('；')}` }));
      return;
    }
    // 保存可能要拉原图+压缩+上传（几秒）——按钮进入"保存中"状态，防止重复点击
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const r = await onSave({ id: item.id, text, model, keepThumb: isEdit && !pick && !dropImage, newPick: pick });
      if (r && r.ok === false) {
        errEl.appendChild(h('div', { class: 'pp-warn', text: `保存失败：${r.error || '未知错误'}` }));
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? '保存修改' : '保存';
        return;
      }
      close();
    } catch (e) {
      errEl.appendChild(h('div', { class: 'pp-warn', text: `保存失败：${e?.message || e}` }));
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? '保存修改' : '保存';
    }
  });
  cancelBtn.addEventListener('click', () => { close(); onCancel?.(); });

  ov.appendChild(h('div', { class: 'pp-dlg' }, [
    h('div', { class: 'pp-dlg-h', text: isEdit ? '编辑画师串' : '添加画师串' }),
    h('div', { class: 'pp-dlg-field' }, [
      h('div', { class: 'pp-row pp-row-between' }, [h('label', { class: 'pp-label', text: '画师串（必填，保存后即标题）' }), lenEl]),
      textArea
    ]),
    h('div', { class: 'pp-dlg-field' }, [
      h('div', { class: 'pp-row pp-row-between' }, [h('label', { class: 'pp-label', text: '主模型（可选：这段串配哪个模型出图）' })]),
      h('div', { class: 'pp-row' }, [modelShown, h('span', { style: 'flex:1' }), modelPickBtn, modelClearBtn])
    ]),
    h('div', { class: 'pp-dlg-field' }, [h('label', { class: 'pp-label', text: '参考图（可选）' }), imgBox]),
    errEl,
    h('div', { class: 'pp-dlg-actions' }, [cancelBtn, saveBtn])
  ]));
  return { close };
}

/* ===================== 界面：出图历史网格选择器 ===================== */

/**
 * 覆盖层网格：懒加载出图缩略图（官方 preview 参数），点选一张；或不选。
 * @param {object} o {host, api, onPick(im|null)}
 */
export function openHistoryPicker({ host, api, onPick }) {
  const ov = h('div', { class: 'pp-overlay' });
  host.appendChild(ov);
  const grid = h('div', { class: 'pp-art-grid' });
  const status = h('div', { class: 'pp-hint', text: '正在读取出图历史…' });
  const moreBtn = h('button', { class: 'pp-btn pp-btn-mini', text: '加载更多' });
  let selected = null;
  let offset = 0;
  let totalLoaded = 0;
  let noMore = false;
  let selBox = null;

  const markSel = () => {
    if (selBox) selBox.classList.remove('pp-art-cell-on');
    selBox = selected ? selected.box : null;
    if (selBox) selBox.classList.add('pp-art-cell-on');
  };

  const addCells = (imgs) => {
    for (const im of imgs) {
      const isTemp = im.type === 'temp';
      const box = h('div', {
        class: `pp-art-cell${isTemp ? ' pp-art-cell-temp' : ''}`,
        title: `${im.filename}${im.subfolder ? ` · ${im.subfolder}` : ''}${isTemp ? '（临时图：可能被 ComfyUI 清理，收藏时已存副本）' : ''}`
      }, [
        h('img', { class: 'pp-art-img', loading: 'lazy', src: viewThumbUrl(im), alt: im.filename }),
        isTemp ? h('span', { class: 'pp-art-temp-badge', text: '临时图' }) : null
      ]);
      box.addEventListener('click', () => {
        selected = (selected && selected.im.filename === im.filename && selected.im.subfolder === im.subfolder) ? null : { im, box };
        markSel();
      });
      grid.appendChild(box);
    }
    totalLoaded += imgs.length;
  };

  const loadPage = async () => {
    moreBtn.disabled = true;
    status.textContent = '正在读取出图历史…';
    try {
      const PAGE = 48;
      const r = await fetchHistoryPage(api, { limit: PAGE, offset });
      offset += r.returned;
      addCells(r.imgs);
      noMore = r.returned < r.requested;
      status.textContent = totalLoaded ? `已加载 ${totalLoaded} 张（点击选中，再点一次取消）` : '出图历史里没有找到图片';
      moreBtn.style.display = noMore ? 'none' : '';
    } catch (e) {
      status.textContent = e?.message || String(e);
    }
    moreBtn.disabled = false;
  };
  moreBtn.addEventListener('click', loadPage);

  const okBtn = h('button', { class: 'pp-btn pp-primary', text: '确定' });
  const noneBtn = h('button', { class: 'pp-btn', text: '不使用图片' });
  const cancelBtn = h('button', { class: 'pp-btn', text: '取消' });
  okBtn.addEventListener('click', () => { ov.remove(); onPick?.(selected ? selected.im : (totalLoaded ? null : null)); });
  noneBtn.addEventListener('click', () => { ov.remove(); onPick?.(null); });
  cancelBtn.addEventListener('click', () => { ov.remove(); });

  ov.appendChild(h('div', { class: 'pp-dlg pp-dlg-artpick' }, [
    h('div', { class: 'pp-dlg-h', text: '从出图历史选参考图' }),
    status,
    grid,
    h('div', { class: 'pp-dlg-actions' }, [moreBtn, h('span', { class: 'pp-spacer' }), noneBtn, cancelBtn, okBtn])
  ]));
  loadPage();
  return { close: () => ov.remove() };
}

/* ===================== 界面：列表页 ===================== */

/**
 * @param {object} o {data, items, notice, toolbarSlot, api,
 *   onAdd, onEdit(item), onDelete(item), onReload,
 *   loadImage(name)->Promise<url|null>, releaseImage(name)}
 */
export function renderArtistsView(o) {
  const { data, items = [], notice = null, toolbarSlot = null, api = null, host = null, handlers = {}, loadImage, releaseImageRef } = o;

  const toolbar = h('div', { class: 'pp-lib-toolbar pp-row' }, [
    h('button', { class: 'pp-btn pp-btn-mini', text: '＋ 添加画师串', onclick: () => handlers.onAdd?.() }),
    h('button', { class: 'pp-btn pp-btn-mini', text: '刷新', onclick: () => handlers.onReload?.() })
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
  kids.push(h('div', { class: 'pp-sum-line' }, [h('span', { text: `共 ${total} 条画师串` })]));

  if (!items.length) {
    kids.push(h('div', { class: 'pp-empty', text: total ? '没有画师串' : '还没有画师串。点上方「＋ 添加画师串」，粘贴串即可；可选一张出图做参考图。' }));
    return h('div', { class: 'pp-art-list' }, kids);
  }

  for (const it of items) {
    const thumbWrap = h('div', { class: 'pp-art-cardthumb' }, [h('div', { class: 'pp-art-thumbph', text: '无图' })]);
    const card = h('div', { class: 'pp-lib-item pp-art-item' }, [
      h('div', { class: 'pp-art-linerow' }, [
        thumbWrap,
        h('div', { class: 'pp-art-main' }, [
          h('div', { class: 'pp-lib-title pp-clamp', text: it.text }),
          h('div', { class: 'pp-lib-meta' }, [
            h('span', { class: 'pp-len', text: `${String(it.text || '').length} 字` }),
            h('span', {
              class: 'pp-len pp-art-model',
              text: it.model ? `模型 ${basenameOf(it.model)}` : '未指定模型',
              title: it.model || '未指定模型'
            }),
            h('span', { class: 'pp-len', text: it.thumb ? '有参考图' : '无参考图' }),
            h('span', { class: 'pp-len', text: `收藏于 ${(it.created_at || '').slice(0, 10)}` })
          ])
        ])
      ]),
      h('div', { class: 'pp-lib-item-actions' }, [
        h('button', { class: 'pp-btn pp-btn-mini pp-copy', text: '复制', onclick: async (ev) => {
          const b = ev.currentTarget;
          const ok = await copyToClipboard(it.text);
          b.textContent = ok ? '已复制 ✓' : '复制失败';
          setTimeout(() => { b.textContent = '复制'; }, 1200);
        } }),
        h('button', { class: 'pp-btn pp-btn-mini', text: '编辑', onclick: () => handlers.onEdit?.(it) }),
        h('button', { class: 'pp-btn pp-btn-mini pp-danger', text: '删除', onclick: () => handlers.onDelete?.(it) })
      ])
    ]);

    if (it.thumb && api && loadImage) {
      loadImage(it.thumb).then((url) => {
        if (!url || !card.isConnected) { if (url && releaseImageRef) releaseImageRef(it.thumb); return; }
        thumbWrap.textContent = '';
        const img = h('img', { class: 'pp-art-thumb', alt: '参考图', src: url, title: '点击放大' });
        if (host && releaseImageRef) {
          // 灯箱：有 orig 走原图直链（不进 urlCache），原图 404 时在 onerror 里回退副本
          img.style.cursor = 'pointer';
          img.addEventListener('click', () => {
            if (it.orig && it.orig.filename) {
              openLightbox(host, {
                url: viewFullUrl(it.orig),
                orig: { ...it.orig, thumbName: it.thumb },
                loadImage,
                releaseImageRef
              });
            } else {
              loadImage(it.thumb).then((bigUrl) => {
                if (!bigUrl) return;
                openLightbox(host, { url: bigUrl, releaseRef: () => releaseImageRef(it.thumb) });
              }).catch(() => { /* 打不开就当没点 */ });
            }
          });
        }
        thumbWrap.appendChild(img);
      }).catch(() => { /* 显示不出就保持"无图"占位 */ });
    }
    kids.push(card);
  }
  return h('div', { class: 'pp-art-list' }, kids);
}
