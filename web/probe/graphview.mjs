/**
 * graphview.mjs —— 把"图"抽象成 resolver 需要的统一接口（纯逻辑，无 UI）
 *
 * 提供两种实现，供不同场景复用同一套解析逻辑：
 *   1. createLiveView(app)                      —— 浏览器里读"当前画布"（含 mode/折叠/标题）
 *   2. createJsonView(workflowJSON, objectInfo) —— 读"工作流文件 JSON"（离线/只读校验、自测）
 *
 * 统一接口：
 *   view.nodes            -> [{ id, cls, title, mode, collapsed, group }]
 *   view.byId(id)         -> node | undefined
 *   view.inputLink(node,name) -> { id, slot } | null      // 该输入口连到哪个节点
 *   view.widget(node,name)    -> { found, value }         // 按"名字"取值（不用下标）
 *   view.widgetNames(node)    -> string[]
 *   view.getKey(node)         -> Get/Set 虚拟节点的键
 *   view.setEntries()         -> [{ key, node }]
 *   view.meta                 -> { workflowName, nodeCount, kind }
 */

import { SOCKET_TYPES, SET_CLASSES, GET_CLASSES } from './adapters.mjs';

const isSetClass = (cls) => SET_CLASSES.includes(cls);
const isGetClass = (cls) => GET_CLASSES.includes(cls);

/**
 * object_info → 某类的"控件名"列表（按声明顺序，排除连线型输入与 forceInput）
 * 供"工作流文件视图"与开发用的 mock 环境共用。
 */
export function widgetNamesForClass(cls, objectInfo) {
  if (isSetClass(cls) || isGetClass(cls)) return cls.startsWith('Get') ? ['name'] : ['value'];
  const spec = objectInfo?.[cls]?.input;
  const names = [];
  if (!spec) return names;
  for (const section of ['required', 'optional']) {
    for (const [k, v] of Object.entries(spec[section] || {})) {
      const type = Array.isArray(v) ? v[0] : undefined;
      const flags = Array.isArray(v) && v[1] && typeof v[1] === 'object' ? v[1] : {};
      if (flags.forceInput) continue;
      if (typeof type === 'string' && SOCKET_TYPES.has(type)) continue;
      names.push(k);
    }
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * 1) 活画布视图（浏览器）
 * ------------------------------------------------------------------ */

export function createLiveView(app, opts = {}) {
  const graphs = [];
  const seenGraphs = new Set();

  function collectGraph(graph, depth = 0) {
    if (!graph || seenGraphs.has(graph) || depth > 4) return;
    seenGraphs.add(graph);
    graphs.push(graph);
    for (const n of graph._nodes || []) {
      // 子图（1.52+）：节点上可能挂着 subgraph / 形态不同的嵌套图
      const sub = n.subgraph || n.graph?.subgraph;
      if (sub && (sub._nodes || sub.nodes)) collectGraph(sub, depth + 1);
    }
  }
  collectGraph(app?.rootGraph || app?.graph);

  const nodes = [];
  for (const g of graphs) {
    for (const n of g._nodes || []) {
      nodes.push({
        id: n.id,
        cls: n.type || n.comfyClass || '?',
        title: n.title || '',
        mode: typeof n.mode === 'number' ? n.mode : 0,
        collapsed: !!(n.flags && n.flags.collapsed),
        group: groupTitleOfLive(n),
        ref: n
      });
    }
  }
  const byIdMap = new Map(nodes.map((n) => [String(n.id), n]));

  // link id -> { 源节点 id, 源槽位 }
  const linkMap = new Map();
  for (const g of graphs) {
    const links = g.links || {};
    const entries = Array.isArray(links) ? links.map((l, i) => [l && l.id != null ? l.id : i, l]) : Object.entries(links);
    for (const [k, l] of entries) {
      if (!l) continue;
      const from = l.origin_id != null ? l.origin_id : l.origin_node?.id;
      const slot = l.origin_slot != null ? l.origin_slot : l.origin_node_slot;
      if (from != null) linkMap.set(String(k), { id: from, slot: slot ?? 0 });
    }
  }

  function groupTitleOfLive(node) {
    const g = node?.graph;
    for (const grp of g?._groups || []) {
      const [x, y] = grp.pos || [0, 0];
      const [w, h] = grp.size || grp.bounding?.slice(2) || [0, 0];
      const [nx, ny] = node.pos || [0, 0];
      if (nx >= x && nx <= x + w && ny >= y && ny <= y + h) return grp.title || '';
    }
    return '';
  }

  const view = {
    kind: 'live',
    nodes,
    meta: {
      kind: 'live',
      workflowName: opts.workflowName || detectWorkflowName(app),
      nodeCount: nodes.length
    },
    byId: (id) => byIdMap.get(String(id)),
    inputLink(node, name) {
      const raw = node?.ref;
      const inp = (raw?.inputs || []).find((i) => i.name === name || i.localized_name === name);
      if (!inp || inp.link == null) return null;
      const hit = linkMap.get(String(inp.link));
      return hit ? { id: hit.id, slot: hit.slot } : null;
    },
    widget(node, name) {
      const raw = node?.ref;
      const w = (raw?.widgets || []).find((x) => x.name === name);
      if (w) return { found: true, value: w.value };
      // 极少见：控件数组里没有，但 widgets_values 有（旧序列化）
      if (Array.isArray(raw?.widgets_values) && (raw?.widgets || []).length === 0) {
        return { found: false, value: undefined };
      }
      return { found: false, value: undefined };
    },
    widgetNames: (node) => (node?.ref?.widgets || []).map((w) => w.name),
    getKey(node) {
      const raw = node?.ref;
      const byWidget = (raw?.widgets || []).find((w) => ['name', 'value'].includes(w.name));
      if (byWidget && byWidget.value != null) return String(byWidget.value);
      if (Array.isArray(raw?.widgets_values) && raw.widgets_values.length) return String(raw.widgets_values[0]);
      return String(node?.title || '').replace(/^(Get|Set)[_\-\s]*/, '');
    },
    setEntries() {
      return nodes.filter((n) => isSetClass(n.cls)).map((n) => ({ key: view.getKey(n), node: n }));
    },
    isGet: (node) => isGetClass(node?.cls)
  };
  return view;
}

function detectWorkflowName(app) {
  try {
    const wf = app?.extensionManager?.workflow?.activeWorkflow || app?.workflowManager?.activeWorkflow;
    if (wf?.filename) return wf.filename;
    if (wf?.name) return wf.name;
    const el = document?.querySelector?.('[data-testid="workflow-name"]');
    if (el?.textContent) return el.textContent.trim();
  } catch (e) {
    /* 取不到就返回空串，面板显示"未命名工作流" */
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 2) 工作流文件视图（只读 JSON；Node 自测与浏览器"按文件校验"共用）
 * ------------------------------------------------------------------ */

/**
 * @param {object} workflow  编辑器格式工作流 JSON（含 nodes / links / groups）
 * @param {object} objectInfo 可选：{ [类名]: { input: { required, optional } } }，用于按名字定位控件
 */
export function createJsonView(workflow, objectInfo = null, opts = {}) {
  const rawNodes = workflow?.nodes || [];
  const linksRaw = workflow?.links || [];
  const linkMap = new Map();
  if (Array.isArray(linksRaw)) {
    for (const l of linksRaw) {
      if (Array.isArray(l) && l.length >= 5) linkMap.set(String(l[0]), { id: l[1], slot: l[2] });
    }
  } else if (linksRaw && typeof linksRaw === 'object') {
    for (const [k, l] of Object.entries(linksRaw)) {
      if (l && l.origin_id != null) linkMap.set(String(k), { id: l.origin_id, slot: l.origin_slot ?? 0 });
    }
  }

  const groups = workflow?.groups || [];
  const nodes = rawNodes.map((n) => ({
    id: n.id,
    cls: n.type,
    title: n.title || '',
    mode: typeof n.mode === 'number' ? n.mode : 0,
    collapsed: !!(n.flags && n.flags.collapsed),
    group: groupTitleOfJson(n),
    ref: n
  }));
  const byIdMap = new Map(nodes.map((n) => [String(n.id), n]));

  function groupTitleOfJson(n) {
    const [nx, ny] = n.pos || [0, 0];
    for (const g of groups) {
      const b = g.bounding || [g.pos?.[0], g.pos?.[1], g.size?.[0], g.size?.[1]];
      if (!b || b.length < 4) continue;
      const [x, y, w, h] = b;
      if (nx >= x && nx <= x + w && ny >= y && ny <= y + h) return g.title || '';
    }
    return '';
  }

  /** object_info → 该类的"控件名"列表（按声明顺序，排除连线型与 forceInput） */
  const widgetNameCache = new Map();
  function widgetNamesOfClass(cls) {
    if (widgetNameCache.has(cls)) return widgetNameCache.get(cls);
    const names = widgetNamesForClass(cls, objectInfo);
    widgetNameCache.set(cls, names);
    return names;
  }

  const view = {
    kind: 'json',
    nodes,
    meta: {
      kind: 'json',
      workflowName: opts.workflowName || workflow?.extra?.name || '',
      nodeCount: nodes.length
    },
    byId: (id) => byIdMap.get(String(id)),
    inputLink(node, name) {
      const raw = node?.ref;
      const inp = (raw?.inputs || []).find((i) => i.name === name || i.localized_name === name);
      if (!inp || inp.link == null) return null;
      return linkMap.get(String(inp.link)) || null;
    },
    widget(node, name) {
      const raw = node?.ref;
      const wv = raw?.widgets_values;
      if (wv == null) return { found: false, value: undefined };
      if (!Array.isArray(wv) && typeof wv === 'object') {
        return name in wv ? { found: true, value: wv[name] } : { found: false, value: undefined };
      }
      const names = widgetNamesOfClass(node.cls);
      const idx = names.indexOf(name);
      if (idx < 0 || idx >= wv.length) return { found: false, value: undefined };
      return { found: true, value: wv[idx] };
    },
    widgetNames: (node) => widgetNamesOfClass(node?.cls),
    getKey(node) {
      const wv = node?.ref?.widgets_values;
      if (Array.isArray(wv) && wv.length) return String(wv[0]);
      if (wv && typeof wv === 'object') return String(wv.name ?? wv.value ?? '');
      return String(node?.title || '').replace(/^(Get|Set)[_\-\s]*/, '');
    },
    setEntries() {
      return nodes.filter((n) => isSetClass(n.cls)).map((n) => ({ key: view.getKey(n), node: n }));
    },
    isGet: (node) => isGetClass(node?.cls)
  };
  return view;
}
