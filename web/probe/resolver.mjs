/**
 * resolver.mjs —— 只读解析核心（纯逻辑，无 DOM）
 *
 * 输入：graphview（活画布 / 工作流 JSON 的统一视图）
 * 输出：采样链 → 目标文本编码节点 → 生效 Prompt（含状态、来源链、警示）
 *
 * 三条硬性规则（来自环境检查结论）：
 *   1. 永远不用 widgets_values 的下标猜文本，一律按"控件名"取值；
 *   2. 输入口有连线时，连线优先于控件值（控件里往往是残留旧文本）；
 *   3. 读不准就标记（部分确认 / 候选文本 / 运行时生成 / 无法确认），绝不冒充已确认。
 */

import {
  isEncoderClass, encoderFields, producerRule, wildcardNote,
  CHAIN_ROOT_INPUTS, CHAIN_HOP_INPUTS, CONDUIT_INPUTS, modeKey
} from './adapters.mjs';

/*
 * 文案策略（结构化文案）：
 *   本文件只产出 `{code, params}`，**不产出任何自然语言**。
 *   code 是词典键，params 是纯数据（数字 / 节点类名 / 嵌套文案）。
 *   显示层用 `fmt()`（i18n.mjs）渲染，所以同一份解析结果可随时切换语言。
 *
 *   为什么这么做：以前 notes / path 里塞的是中文句子，这些值会跟着收藏条目
 *   一起落库、也会被自测断言；界面要出英文就只能重写解析器。
 *
 * 稳定性约定：`status` / `role` / `mode` 是**稳定的内部标识**（永不翻译），
 *   界面文案一律由 `t('status.' + code)` 这类映射生成。
 *   连接符由 `core.pathJoin` / `core.pathPlus` 提供，不写进参数拼接。
 */

/** 构造 `core.*` 命名空间下的结构化文案 */
const m = (code, params) => ({ code: `core.${code}`, params: params || {} });

/** 状态码 → 结构化文案（稳定标识 `status` 本身不变） */
export const statusMsg = (status) => ({ code: `status.${status}`, params: {} });

/** 节点 mode → 结构化文案；未登记的模式回退为原始数字 */
export const modeMsg = (mode) => {
  const key = modeKey(mode);
  return key ? { code: key, params: {} } : { code: 'meta.modeRaw', params: { n: String(mode) } };
};

const MAX_DEPTH = 40;

export function scan(view) {
  const result = {
    meta: { ...view.meta },
    chains: [],
    candidates: [],
    errors: []
  };

  const usedEncoderIds = new Set();

  for (const chain of findChains(view)) {
    try {
      const built = buildChain(view, chain, usedEncoderIds);
      result.chains.push(built);
    } catch (e) {
      result.errors.push(m('chainScan', { id: chain?.sampler?.id, error: e?.message || String(e) }));
    }
  }

  // 未被任何采样链引用的文本编码节点 → 候选文本（明确标记，不冒充有效 Prompt）
  for (const node of view.nodes) {
    try {
      if (usedEncoderIds.has(String(node.id))) continue;
      if (!isEncoderClass(node.cls, view.widgetNames(node))) continue;
      const info = encoderFields(node.cls, view.widgetNames(node));
      if (!info.fields.length) continue;
      const field = info.fields[0];
      const got = extractField(view, node, field);
      result.candidates.push({
        id: node.id,
        cls: node.cls,
        title: node.title,
        mode: node.mode,
        modeText: modeMsg(node.mode),
        collapsed: node.collapsed,
        group: node.group,
        field,
        generic: info.generic,
        ...got,
        reason: m('candUnreferenced')
      });
    } catch (e) {
      result.errors.push(m('candidateScan', { id: node?.id, error: e?.message || String(e) }));
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 采样链识别
 * ------------------------------------------------------------------ */

function findChains(view) {
  const chains = [];
  const seen = new Set();
  for (const node of view.nodes) {
    const pos = firstLinkedInput(view, node, CHAIN_ROOT_INPUTS);
    if (pos) {
      const key = `${node.id}:positive`;
      if (!seen.has(key)) {
        seen.add(key);
        chains.push({
          sampler: node,
          entryName: pos.name,
          entryLink: pos.link,
          negative: firstLinkedInput(view, node, ['negative']),
          via: null
        });
      }
      continue;
    }
    // SamplerCustomAdvanced 这类：先吃 guider，正向/负向在 Guider 节点上
    const hop = firstLinkedInput(view, node, CHAIN_HOP_INPUTS);
    if (hop) {
      const guider = view.byId(hop.link.id);
      if (guider) {
        // BasicGuider 用的是 conditioning（单个），CFGGuider 用的是 positive/negative
        const gpos = firstLinkedInput(view, guider, CHAIN_ROOT_INPUTS) || firstLinkedInput(view, guider, ['conditioning']);
        if (gpos) {
          const key = `${guider.id}:${gpos.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            chains.push({
              sampler: node,
              entryName: `guider→${gpos.name}`,
              entryLink: gpos.link,
              negative: firstLinkedInput(view, guider, ['negative']),
              via: guider,
              hint: gpos.name === 'conditioning'
                ? m('guiderSingle', { cls: guider.cls, id: guider.id })
                : null
            });
          }
        }
      }
    }
  }
  return chains;
}

function firstLinkedInput(view, node, names) {
  for (const name of names) {
    const link = view.inputLink(node, name);
    if (link) return { name, link };
  }
  return null;
}

/** 从采样器的 positive 出发，沿 conditioning 上游走到文本编码器 */
function traceToEncoder(view, link) {
  const hops = [];
  const visited = new Set();
  let cur = link;
  let guard = 0;
  while (cur && guard++ < 60) {
    const node = view.byId(cur.id);
    if (!node) break;
    const key = String(node.id);
    if (visited.has(key)) break;
    visited.add(key);
    hops.push({ id: node.id, cls: node.cls, title: node.title, mode: node.mode });
    if (isEncoderClass(node.cls, view.widgetNames(node))) return { encoder: node, hops };
    const next = firstLinkedInput(view, node, CONDUIT_INPUTS.concat(['conditioning_2', 'conditioning_3', 'conditioning_4']));
    if (!next) return { encoder: null, hops };
    cur = next.link;
  }
  return { encoder: null, hops };
}

/* ------------------------------------------------------------------ *
 * 单条链的构建
 * ------------------------------------------------------------------ */

function buildChain(view, chain, usedEncoderIds) {
  const { sampler, entryLink, negative } = chain;
  const traced = traceToEncoder(view, entryLink);
  const samplerInfo = {
    id: sampler.id,
    cls: sampler.cls,
    title: sampler.title,
    mode: sampler.mode,
    modeText: modeMsg(sampler.mode),
    bypassed: sampler.mode === 4 || sampler.mode === 2,
    collapsed: sampler.collapsed,
    group: sampler.group,
    via: chain.via ? { id: chain.via.id, cls: chain.via.cls, title: chain.via.title } : null
  };

  const out = {
    id: `chain-${sampler.id}`,
    label: chainLabel(sampler, chain.via),
    entryName: chain.entryName || 'positive',
    sampler: samplerInfo,
    hops: traced.hops,
    target: null,
    fields: [],
    warning: null,
    hint: chain.hint || null,
    negative: null
  };

  if (!traced.encoder) {
    out.warning = m('chainNotTraced', {
      entry: entryLink ? chain.entryName : 'positive',
      hops: traced.hops.length
        ? joinMsgs(traced.hops.map((h) => m('pathHops', { id: h.id, cls: h.cls })), 'pathJoin')
        : m('empty')
    });
    return out;
  }

  const encoder = traced.encoder;
  usedEncoderIds.add(String(encoder.id));
  const info = encoderFields(encoder.cls, view.widgetNames(encoder));

  out.target = {
    id: encoder.id,
    cls: encoder.cls,
    title: encoder.title,
    mode: encoder.mode,
    modeText: modeMsg(encoder.mode),
    bypassed: encoder.mode === 4 || encoder.mode === 2,
    collapsed: encoder.collapsed,
    group: encoder.group,
    generic: info.generic,
    fields: info.fields.slice()
  };

  info.fields.forEach((field, idx) => {
    const entry = extractField(view, encoder, field);
    // role 是稳定内部标识（positive / negative / extra），永不翻译；界面用 t('role.' + role)
    const role = /negative|neg\b/i.test(field) ? 'negative' : idx === 0 ? 'positive' : 'extra';
    // 残留控件值检测：控件里有内容，但实际生效的是连线
    const w = view.widget(encoder, field);
    const widgetText = w.found && typeof w.value === 'string' ? w.value : '';
    const staleWidget = !!entry.fromLink && widgetText.trim() && widgetText.trim() !== (entry.text || '').trim();
    out.fields.push({
      name: field,
      role,
      fromLink: !!entry.fromLink,
      statusText: statusMsg(entry.status),
      ...entry,
      staleWidget,
      staleLen: staleWidget ? widgetText.length : 0,
      notes: (entry.notes || []).concat(staleWidget
        ? [m('staleWidget', { length: widgetText.length })]
        : [])
    });
  });

  if (negative) {
    const nt = traceToEncoder(view, negative.link);
    if (nt.encoder) {
      const nInfo = encoderFields(nt.encoder.cls, view.widgetNames(nt.encoder));
      const nField = nInfo.fields.find((f) => /negative/i.test(f)) || nInfo.fields[0];
      const got = extractField(view, nt.encoder, nField);
      out.negative = {
        target: { id: nt.encoder.id, cls: nt.encoder.cls, title: nt.encoder.title, mode: nt.encoder.mode },
        field: nField,
        sameAsPositive: nt.encoder.id === encoder.id,
        text: got.text,
        length: (got.text || '').length,
        status: got.status,
        statusText: statusMsg(got.status),
        notes: got.notes || []
      };
    } else {
      out.negative = {
        target: null,
        note: m('chainNotTraced', {
          entry: 'negative',
          hops: nt.hops.length
            ? joinMsgs(nt.hops.map((h) => m('pathHops', { id: h.id, cls: h.cls })), 'pathJoin')
            : m('empty')
        }),
        text: null, length: 0, status: 'unknown', statusText: statusMsg('unknown')
      };
    }
  }

  return out;
}

function chainLabel(sampler, via) {
  return m('chainLabel', {
    group: sampler.group ? m('chainLabelGroup', { group: sampler.group }) : '',
    cls: sampler.cls,
    id: sampler.id,
    via: via ? m('chainLabelVia', { cls: via.cls, id: via.id }) : ''
  });
}

/* ------------------------------------------------------------------ *
 * 文本字段提取 / 字符串链递归
 * ------------------------------------------------------------------ */

function extractField(view, encoder, fieldName) {
  const link = view.inputLink(encoder, fieldName);
  const widget = view.widget(encoder, fieldName);

  if (link) {
    const r = resolveString(view, link.id, { stack: new Set(), depth: 0 });
    return {
      text: r.text,
      status: r.status,
      source: r.source,
      path: r.path,
      parts: r.parts,
      branches: r.branches || [],
      notes: (r.notes || []).slice(),
      fromLink: true,
      length: (r.text || '').length
    };
  }
  if (widget.found && widget.value != null) {
    const text = String(widget.value);
    return {
      text,
      status: 'confirmed',
      source: { id: encoder.id, cls: encoder.cls, title: encoder.title },
      path: m('pathDirectWidget', { id: encoder.id, cls: encoder.cls, field: fieldName }),
      branches: [],
      notes: wildcardNote(text),
      fromLink: false,
      length: text.length
    };
  }
  return {
    text: null,
    status: 'unknown',
    source: null,
    path: '',
    branches: [],
    notes: [m('fieldNoValue', { field: fieldName })],
    fromLink: false,
    length: 0
  };
}

/**
 * 解析一个节点的字符串输出（slot 0）
 * @returns {{text: string|null, status: string, source: object|null, path: string, notes: string[], branches: object[]}}
 */
export function resolveString(view, nodeId, ctx = {}) {
  const stack = ctx.stack || new Set();
  const depth = ctx.depth || 0;
  if (depth > MAX_DEPTH) return miss(m('tooDeep', { max: MAX_DEPTH }));
  const node = view.byId(nodeId);
  if (!node) return miss(m('nodeMissing', { id: nodeId }));
  const key = String(node.id);
  if (stack.has(key)) return miss(m('cycle', { id: node.id }));

  const nextStack = new Set(stack);
  nextStack.add(key);
  const nextCtx = { stack: nextStack, depth: depth + 1 };
  const self = { id: node.id, cls: node.cls, title: node.title };

  const rule = producerRule(node.cls);
  if (!rule) return genericFallback(view, node, nextCtx);

  switch (rule.kind) {
    case 'literal':
      return takeField(view, node, rule.field, nextCtx, self);
    case 'passthrough':
      return takeField(view, node, rule.field, nextCtx, self);
    case 'join':
      return resolveJoin(view, node, nextCtx, self);
    case 'concat':
      return resolveConcat(view, node, rule, nextCtx, self);
    case 'switch':
      return resolveSwitch(view, node, nextCtx, self);
    case 'get':
      return resolveGet(view, node, nextCtx, self);
    case 'runtime':
      return {
        text: null,
        status: 'runtime',
        source: self,
        path: pathOf(node, m('pathRuntime', { cls: node.cls })),
        notes: [m('runtimeGenerated', {
          cls: node.cls,
          why: rule.why ? { code: `core.why.${rule.why}`, params: {} } : m('dynamic')
        })],
        branches: []
      };
    default:
      return genericFallback(view, node, nextCtx);
  }
}

function takeField(view, node, field, ctx, self) {
  const link = view.inputLink(node, field);
  if (link) {
    const r = resolveString(view, link.id, ctx);
    return { ...r, path: pathOf(node, m('pathFieldLink', { field, inner: r.path || m('upstream') })) };
  }
  const w = view.widget(node, field);
  if (w.found && w.value != null) {
    const text = String(w.value);
    return {
      text,
      status: 'confirmed',
      source: self,
      path: pathOf(node, m('pathWidget', { cls: node.cls, field })),
      notes: wildcardNote(text),
      branches: []
    };
  }
  return {
    text: null,
    status: 'unknown',
    source: self,
    path: pathOf(node, m('widgetUnreadable', { cls: node.cls, field })),
    notes: [m('widgetMissing', { cls: node.cls, field })],
    branches: []
  };
}

function resolveJoin(view, node, ctx, self) {
  const countW = view.widget(node, 'inputcount');
  const delimW = view.widget(node, 'delimiter');
  const delim = delimW.found && delimW.value != null ? String(delimW.value) : ' ';
  let count = countW.found && Number.isFinite(Number(countW.value)) ? Number(countW.value) : 0;
  if (!count) {
    count = 0;
    while (count < 50 && (view.inputLink(node, `string_${count + 1}`) || view.widget(node, `string_${count + 1}`).found)) count++;
  }
  if (!count) count = 2;

  const parts = [];
  const statuses = [];
  const notes = [];
  const paths = [];
  const segs = [];             // 分段明细（供界面分开展示/复制）：{name, text, status, source}
  for (let k = 1; k <= count; k++) {
    const name = `string_${k}`;
    const link = view.inputLink(node, name);
    if (link) {
      const r = resolveString(view, link.id, ctx);
      parts.push(r.text == null ? '' : r.text);
      statuses.push(r.status);
      if (r.path) paths.push(r.path);
      if (r.notes?.length) notes.push(m('joinPartNotes', { k, notes: r.notes }));
      segs.push({ name, text: r.text, status: r.status, source: r.source || null });
    } else {
      const w = view.widget(node, name);
      if (w.found && w.value != null) {
        const text = String(w.value);
        parts.push(text);
        statuses.push('confirmed');
        segs.push({ name, text, status: 'confirmed', source: self });
      } else {
        parts.push('');
        statuses.push('partial');
        notes.push(m('joinPartEmpty', { k }));
        segs.push({ name, text: '', status: 'partial', source: self });
      }
    }
  }
  const text = parts.join(delim);
  return {
    text,
    parts: segs.filter((s) => (s.text || '') !== '').length > 1 ? segs : undefined,
    status: combineStatus(statuses, text),
    source: self,
    path: pathOf(node, m('pathJoinNode', {
      cls: node.cls,
      count,
      delim,
      paths: joinMsgs(paths, 'pathPlus') || m('widgetValue')
    })),
    notes,
    branches: []
  };
}

function resolveConcat(view, node, rule, ctx, self) {
  const parts = [];
  const statuses = [];
  const notes = [];
  const paths = [];
  const segs = [];             // 分段明细（基于未过滤的原始数组，索引与 rule.parts 一一对应）
  for (const name of rule.parts) {
    const link = view.inputLink(node, name);
    if (link) {
      const r = resolveString(view, link.id, ctx);
      parts.push(r.text == null ? '' : r.text);
      statuses.push(r.status);
      if (r.path) paths.push(r.path);
      segs.push({ name, text: r.text, status: r.status, source: r.source || null });
    } else {
      const w = view.widget(node, name);
      if (w.found && w.value != null) {
        parts.push(String(w.value));
        statuses.push('confirmed');
        segs.push({ name, text: String(w.value), status: 'confirmed', source: self });
      } else {
        parts.push('');
        statuses.push('partial');
        notes.push(m('concatPartMissing', { name }));
        segs.push({ name, text: '', status: 'partial', source: self });
      }
    }
  }
  const dw = view.widget(node, rule.delim || 'delimiter');
  const delim = dw.found && dw.value != null ? String(dw.value) : '';
  const text = parts.filter((p) => p !== '').join(delim || '');
  return {
    text,
    parts: segs.filter((s) => (s.text || '') !== '').length > 1 ? segs : undefined,
    status: combineStatus(statuses, text),
    source: self,
    path: pathOf(node, m('pathConcat', {
      cls: node.cls,
      parts: joinMsgs(rule.parts, 'pathPlus'),
      paths: joinMsgs(paths, 'pathPlus') || m('widgetValue')
    })),
    notes,
    branches: []
  };
}

/** 判断 ComfySwitchNode 的开关状态：控件值优先，其次尝试从连线源头静态取值 */
function resolveSwitchState(view, node) {
  const link = view.inputLink(node, 'switch');
  if (!link) {
    const w = view.widget(node, 'switch');
    if (w.found && w.value != null) return { known: true, value: !!w.value, how: m('switchWidget', { value: String(w.value) }) };
    return { known: false, value: null, how: m('switchWidgetMissing') };
  }
  const src = view.byId(link.id);
  if (!src) return { known: false, value: null, how: m('switchLinkMissing', { id: link.id }) };
  for (const nm of ['value', 'boolean', 'bool', 'switch']) {
    const w = view.widget(src, nm);
    if (w.found && (typeof w.value === 'boolean' || typeof w.value === 'number')) {
      return { known: true, value: !!w.value, how: m('switchFromNode', { cls: src.cls, id: src.id, name: nm, value: String(w.value) }) };
    }
  }
  return { known: false, value: null, how: m('switchRuntime', { cls: src.cls, id: src.id }) };
}

function resolveSwitch(view, node, ctx, self) {
  const sw = resolveSwitchState(view, node);

  const branches = [];
  const nestedNotes = [];
  const get = (slot) => {
    const link = view.inputLink(node, slot);
    if (!link) return null;
    const r = resolveString(view, link.id, ctx);
    if (r.notes?.length) nestedNotes.push(m('nestedNote', { slot, notes: r.notes }));
    const active = sw.known ? (slot === 'on_true') === !!sw.value : null;
    const textPreview = preview(r.text);
    branches.push({
      slot,
      active,
      status: r.status,
      statusText: statusMsg(r.status),
      preview: textPreview,
      hasText: textPreview !== '',
      length: (r.text || '').length,
      source: r.source,
      text: r.text,
      line: m('branchLine', {
        slot,
        marker: active === true ? m('branchActive') : active === false ? m('branchInactive') : '',
        n: (r.text || '').length,
        status: statusMsg(r.status),
        preview: textPreview !== '' ? textPreview : m('empty')
      })
    });
    return r;
  };
  const onTrue = get('on_true');
  const onFalse = get('on_false');
  const notes = [m('switchJudge', { how: sw.how })];
  branches.forEach((b) => notes.push(b.line));
  notes.push(...nestedNotes);

  const active = sw.known ? (sw.value ? onTrue : onFalse) : null;
  if (!active) {
    notes.push(m('switchUndecided'));
    return {
      text: null,
      status: 'candidate',
      source: self,
      path: pathOf(node, m('pathSwitchUndecided', { cls: node.cls, how: sw.how })),
      notes,
      branches
    };
  }
  return {
    text: active.text,
    status: active.status,
    source: active.source || self,
    path: pathOf(node, m('pathSwitchChosen', {
      cls: node.cls,
      slot: sw.value ? 'on_true' : 'on_false',
      inner: active.path || ''
    })),
    notes,
    branches
  };
}

function resolveGet(view, node, ctx, self) {
  const key = view.getKey(node);
  const entries = view.setEntries();
  const hit = entries.find((e) => e.key === key);
  if (!hit) {
    return {
      text: null,
      status: 'unknown',
      source: self,
      path: pathOf(node, m('pathGetUnpaired', { cls: node.cls, key })),
      notes: [m('getNoSetNode', {
        key,
        keys: entries.length ? entries.map((e) => e.key).join(', ') : m('noneValue')
      })],
      branches: []
    };
  }
  const setNode = hit.node;
  const candidateSlots = ['STRING', 'value', 'text', '*', 'any'];
  let link = null;
  let usedName = '';
  for (const name of candidateSlots) {
    link = view.inputLink(setNode, name);
    if (link) { usedName = name; break; }
  }
  if (!link) {
    // 没有连线时，找 Set 节点上第一个有值的控件
    for (const name of ['value', 'STRING', 'text']) {
      const w = view.widget(setNode, name);
      if (w.found && w.value != null) {
        const text = String(w.value);
        return {
          text,
          status: 'confirmed',
          source: self,
          path: pathOf(node, m('pathGetWidget', { cls: node.cls, key })),
          notes: wildcardNote(text),
          branches: []
        };
      }
    }
    return {
      text: null,
      status: 'unknown',
      source: self,
      path: pathOf(node, m('pathGetNoInput', { cls: node.cls, key })),
      notes: [m('setNodeNoValue', { id: setNode.id, cls: setNode.cls })],
      branches: []
    };
  }
  const r = resolveString(view, link.id, ctx);
  return {
    ...r,
    source: r.source || self,
    path: pathOf(node, m('pathGetChain', {
      cls: node.cls,
      key,
      id: setNode.id,
      name: usedName,
      inner: r.path || m('upstream')
    })),
    notes: [m('viaSetNode', { key })].concat(r.notes || []),
    branches: r.branches || []
  };
}

/** 未登记节点的兜底：只在"证据充分"时给出候选文本，否则明确报无法确认 */
function genericFallback(view, node, ctx) {
  const self = { id: node.id, cls: node.cls, title: node.title };
  const names = view.widgetNames(node) || [];
  const textish = names.filter((n) => /^(text|prompt|value|string|positive|body|content|text_g|text_l)$/i.test(n));
  if (textish.length === 1) {
    const w = view.widget(node, textish[0]);
    if (w.found && w.value != null) {
      const text = String(w.value);
      return {
        text,
        status: 'candidate',
        source: self,
        path: pathOf(node, m('pathGenericGuess', { cls: node.cls, field: textish[0] })),
        notes: [m('genericGuess', { cls: node.cls, field: textish[0] })],
        branches: []
      };
    }
  }
  const linkedStringInput = names.concat(['value', 'text', 'prompt', 'string']).find((n) => view.inputLink(node, n));
  if (linkedStringInput) {
    const link = view.inputLink(node, linkedStringInput);
    const r = resolveString(view, link.id, ctx);
    return {
      ...r,
      status: r.status === 'confirmed' ? 'candidate' : r.status,
      path: pathOf(node, m('pathGenericLink', { cls: node.cls, field: linkedStringInput, inner: r.path || m('upstream') })),
      notes: (r.notes || []).concat([m('genericUnregistered', { cls: node.cls, field: linkedStringInput })])
    };
  }
  return {
    text: null,
    status: 'unknown',
    source: self,
    path: pathOf(node, m('pathUnregistered', { cls: node.cls })),
    notes: [m('unregistered', { cls: node.cls })],
    branches: []
  };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function combineStatus(statuses, text) {
  if (text != null && text !== '') {
    return statuses.every((s) => s === 'confirmed') ? 'confirmed' : 'partial';
  }
  if (statuses.includes('runtime')) return 'runtime';
  if (statuses.includes('candidate')) return 'candidate';
  return 'unknown';
}

function miss(why) {
  return { text: null, status: 'unknown', source: null, path: '', notes: [why], branches: [] };
}

/**
 * 构造「节点 #id 类名 + 尾巴」的结构化路径。
 * 尾巴可以是字符串（节点类名/字段名等纯数据）或嵌套文案；由显示层拼接。
 */
function pathOf(node, tail) {
  return m('pathNode', {
    id: node.id,
    cls: node.cls,
    tail: tail ? m('pathTail', { tail }) : ''
  });
}

/**
 * 把多个结构化路径用指定分隔键连起来（分隔符本身也走词典，
 * 所以英文/中文/其它语言可以各自决定连接符）。
 * 返回 null 表示空列表，由调用方决定回退文案。
 */
function joinMsgs(list, sepKey) {
  if (!list || !list.length) return null;
  return list.reduce((acc, item) => (acc === null ? item : m('pathSep', {
    left: acc,
    right: item,
    sep: { code: `core.${sepKey}`, params: {} }
  })), null);
}

/**
 * 文本预览（用户内容，不翻译）。
 * 空内容返回空串，由显示层决定用什么占位文案。
 */
export function preview(text, n = 70) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
