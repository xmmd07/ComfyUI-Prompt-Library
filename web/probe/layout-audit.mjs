/**
 * layout-audit.mjs —— 排版体检（只读测量，不发请求、不改数据）
 *
 * 用真实浏览器渲染后的几何信息做检查：
 *   1. overlaps           两个可见元素矩形相交（重叠）
 *   2. overflowX          元素内容横向撑破自己（scrollWidth > clientWidth）
 *   3. overflowRight      子元素越过父容器右边界（卡片被撑破）
 *   4. horizontalOverflow 整个面板出现横向滚动
 *   5. clipped            内容被 overflow:hidden 裁掉（**有意折叠的预览不算**，它们带 .pp-clamp 标记）
 *
 * 复用于：验证台页面、真实 ComfyUI 侧边栏（window.__promptProbe.auditLayout()）、自测。
 */

const SKIP_TAGS = new Set(['HTML', 'BODY']);
const CLAMP_MARK = 'pp-clamp';   // 有意做折叠预览的元素（不算缺陷）

export function auditLayout(rootEl, opts = {}) {
  const minArea = opts.minArea ?? 6;
  const out = {
    hostWidth: 0, rootWidth: 0, horizontalOverflow: false,
    overlaps: [], overflowX: [], overflowRight: [], clipped: [], ok: false
  };
  if (!rootEl) return out;

  const host = rootEl.parentElement || rootEl;
  out.hostWidth = host.clientWidth;
  out.rootWidth = rootEl.scrollWidth;
  out.horizontalOverflow = rootEl.scrollWidth > host.clientWidth + 1;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const label = (el) => {
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18);
    return `${el.tagName}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const isClamp = (el) => el.closest?.(`.${CLAMP_MARK}`) != null;
  // 固定定位子树（模态弹窗遮罩）本身就脱离父容器布局，不参与"撑破父容器/被裁切"的判定
  const inFixedSubtree = (el) => {
    let n = el;
    while (n && n !== host) {
      if (getComputedStyle(n).position === 'fixed') return true;
      n = n.parentElement;
    }
    return false;
  };

  const all = [rootEl, ...rootEl.querySelectorAll('*')].filter((el) => !SKIP_TAGS.has(el.tagName));

  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const fixedSub = inFixedSubtree(el);

    if (!fixedSub && el.scrollWidth > el.clientWidth + 1 && !['auto', 'scroll', 'hidden'].includes(cs.overflowX)) {
      out.overflowX.push(`${label(el)}  scrollW=${el.scrollWidth} clientW=${el.clientWidth}`);
    }
    const parent = el.parentElement;
    if (!fixedSub && parent && parent !== host && !['auto', 'scroll', 'hidden'].includes(getComputedStyle(parent).overflowX)) {
      const pr = parent.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.right - pr.right > 1.5 && er.width > 2) {
        out.overflowRight.push(`${label(el)} 右边界 ${Math.round(er.right)} > 父容器 ${label(parent)} 右边界 ${Math.round(pr.right)}`);
      }
    }
    if (!fixedSub && el.scrollHeight > el.clientHeight + 1 && cs.overflowY === 'hidden' && !isClamp(el)) {
      out.clipped.push(`${label(el)} 被裁切 内容高=${el.scrollHeight} 可视高=${el.clientHeight}`);
    }
  }

  const boxes = all
    .filter((el) => visible(el) && el.matches('button, input, select, .pp-badge, .pp-tab, .pp-seg-btn, .pp-len, .pp-role, b, .pp-title, .pp-ver, .pp-tag, .pp-summary'))
    .map((el) => ({ el, inOverlay: el.closest('.pp-overlay') != null, r: el.getBoundingClientRect() }));

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // 弹窗（.pp-overlay）本来就盖在页面之上：只和同为弹窗内部的元素比较，避免误报
      if (a.inOverlay !== b.inOverlay) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      const area = Math.max(0, w) * Math.max(0, h);
      if (area > minArea) out.overlaps.push(`${label(a.el)} ∩ ${label(b.el)}  area=${Math.round(area)}px²`);
    }
  }

  out.overlaps = out.overlaps.slice(0, 12);
  out.overflowX = out.overflowX.slice(0, 12);
  out.overflowRight = out.overflowRight.slice(0, 12);
  out.clipped = out.clipped.slice(0, 12);
  out.ok = !out.overlaps.length && !out.overflowX.length && !out.overflowRight.length
    && !out.horizontalOverflow && !out.clipped.length;
  return out;
}
