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
  CHAIN_ROOT_INPUTS, CHAIN_HOP_INPUTS, CONDUIT_INPUTS, MODE_TEXT
} from './adapters.mjs';

export const STATUS_TEXT = {
  confirmed: '已确认',
  partial: '部分确认',
  candidate: '候选文本',
  runtime: '运行时生成',
  unknown: '无法确认'
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
      result.errors.push(`采样链（节点 #${chain?.sampler?.id}）解析异常：${e?.message || e}`);
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
        modeText: MODE_TEXT[node.mode] ?? String(node.mode),
        collapsed: node.collapsed,
        group: node.group,
        field,
        generic: info.generic,
        ...got,
        reason: '该文本编码节点的输出没有连到任何采样器的 positive（未被当前采样链引用）'
      });
    } catch (e) {
      result.errors.push(`候选节点 #${node?.id} 解析异常：${e?.message || e}`);
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
                ? `${guider.cls} #${guider.id} 只有单个 conditioning 输入，已按其作为正向处理`
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
    modeText: MODE_TEXT[sampler.mode] ?? String(sampler.mode),
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
    out.warning = `未能沿 ${entryLink ? chain.entryName : 'positive'} 找到文本编码节点（链路：${traced.hops
      .map((h) => `#${h.id} ${h.cls}`)
      .join(' ← ') || '空'}）`;
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
    modeText: MODE_TEXT[encoder.mode] ?? String(encoder.mode),
    bypassed: encoder.mode === 4 || encoder.mode === 2,
    collapsed: encoder.collapsed,
    group: encoder.group,
    generic: info.generic,
    fields: info.fields.slice()
  };

  info.fields.forEach((field, idx) => {
    const entry = extractField(view, encoder, field);
    const role = /negative|neg\b/i.test(field) ? '负向' : idx === 0 ? '正向' : '附加';
    // 残留控件值检测：控件里有内容，但实际生效的是连线
    const w = view.widget(encoder, field);
    const widgetText = w.found && typeof w.value === 'string' ? w.value : '';
    const staleWidget = !!entry.fromLink && widgetText.trim() && widgetText.trim() !== (entry.text || '').trim();
    out.fields.push({
      name: field,
      role,
      fromLink: !!entry.fromLink,
      statusText: STATUS_TEXT[entry.status] || entry.status,
      ...entry,
      staleWidget,
      staleLen: staleWidget ? widgetText.length : 0,
      notes: (entry.notes || []).concat(staleWidget
        ? [`该控件里还存有 ${widgetText.length} 字的旧文本，但已被连线取代（实际生效的是上面解析出的内容）`]
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
        statusText: STATUS_TEXT[got.status] || got.status,
        notes: got.notes || []
      };
    } else {
      out.negative = {
        target: null,
        note: `负向没有连到文本编码节点（链路：${nt.hops.map((h) => `#${h.id} ${h.cls}`).join(' ← ') || '空'}）`,
        text: null, length: 0, status: 'unknown', statusText: STATUS_TEXT.unknown
      };
    }
  }

  return out;
}

function chainLabel(sampler, via) {
  const g = sampler.group ? `【${sampler.group}】` : '';
  const v = via ? `（经 ${via.cls} #${via.id}）` : '';
  return `${g}${sampler.cls} #${sampler.id}${v}`;
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
      path: `#${encoder.id} ${encoder.cls}.${fieldName}（控件内直接写入）`,
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
    notes: [`字段「${fieldName}」既没有连线，也没有读到控件值`],
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
  if (depth > MAX_DEPTH) return miss(`链路超过 ${MAX_DEPTH} 层，已停止`);
  const node = view.byId(nodeId);
  if (!node) return miss(`节点 #${nodeId} 不在当前图中`);
  const key = String(node.id);
  if (stack.has(key)) return miss(`检测到循环引用（节点 #${node.id}）`);

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
        path: pathOf(node, `${node.cls} 运行期生成`),
        notes: [`${node.cls} 的文本在运行期生成（${rule.why || '动态内容'}），静态读取不到`],
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
    return { ...r, path: pathOf(node, `${field} ← ${r.path || '上游'}`) };
  }
  const w = view.widget(node, field);
  if (w.found && w.value != null) {
    const text = String(w.value);
    return {
      text,
      status: 'confirmed',
      source: self,
      path: pathOf(node, `${node.cls}.${field}（控件）`),
      notes: wildcardNote(text),
      branches: []
    };
  }
  return {
    text: null,
    status: 'unknown',
    source: self,
    path: pathOf(node, `${node.cls}.${field} 读不到值`),
    notes: [`${node.cls} 的控件「${field}」没有读到值（可能被改名为输入口或未初始化）`],
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
  for (let k = 1; k <= count; k++) {
    const name = `string_${k}`;
    const link = view.inputLink(node, name);
    if (link) {
      const r = resolveString(view, link.id, ctx);
      parts.push(r.text == null ? '' : r.text);
      statuses.push(r.status);
      if (r.path) paths.push(r.path);
      if (r.notes?.length) notes.push(`第${k}段：${r.notes.join('；')}`);
    } else {
      const w = view.widget(node, name);
      if (w.found && w.value != null) {
        const text = String(w.value);
        parts.push(text);
        statuses.push('confirmed');
      } else {
        parts.push('');
        statuses.push('partial');
        notes.push(`第${k}段既没有连线也没有控件值（按空串处理）`);
      }
    }
  }
  const text = parts.join(delim);
  return {
    text,
    status: combineStatus(statuses, text),
    source: self,
    path: pathOf(node, `${node.cls}[${count}段 "${delim}"] ← ${paths.join(' + ') || '控件值'}`),
    notes,
    branches: []
  };
}

function resolveConcat(view, node, rule, ctx, self) {
  const parts = [];
  const statuses = [];
  const notes = [];
  const paths = [];
  for (const name of rule.parts) {
    const link = view.inputLink(node, name);
    if (link) {
      const r = resolveString(view, link.id, ctx);
      parts.push(r.text == null ? '' : r.text);
      statuses.push(r.status);
      if (r.path) paths.push(r.path);
    } else {
      const w = view.widget(node, name);
      if (w.found && w.value != null) {
        parts.push(String(w.value));
        statuses.push('confirmed');
      } else {
        parts.push('');
        statuses.push('partial');
        notes.push(`「${name}」读不到值`);
      }
    }
  }
  const dw = view.widget(node, rule.delim || 'delimiter');
  const delim = dw.found && dw.value != null ? String(dw.value) : '';
  const text = parts.filter((p) => p !== '').join(delim || '');
  return {
    text,
    status: combineStatus(statuses, text),
    source: self,
    path: pathOf(node, `${node.cls}(${rule.parts.join(' + ')}) ← ${paths.join(' + ') || '控件值'}`),
    notes,
    branches: []
  };
}

/** 判断 ComfySwitchNode 的开关状态：控件值优先，其次尝试从连线源头静态取值 */
function resolveSwitchState(view, node) {
  const link = view.inputLink(node, 'switch');
  if (!link) {
    const w = view.widget(node, 'switch');
    if (w.found && w.value != null) return { known: true, value: !!w.value, how: `开关控件值 = ${w.value}` };
    return { known: false, value: null, how: '开关控件缺失' };
  }
  const src = view.byId(link.id);
  if (!src) return { known: false, value: null, how: `开关来自连线（源节点 #${link.id} 不存在）` };
  for (const nm of ['value', 'boolean', 'bool', 'switch']) {
    const w = view.widget(src, nm);
    if (w.found && (typeof w.value === 'boolean' || typeof w.value === 'number')) {
      return { known: true, value: !!w.value, how: `开关 ← ${src.cls} #${src.id}.${nm} = ${w.value}` };
    }
  }
  return { known: false, value: null, how: `开关 ← ${src.cls} #${src.id}（运行期决定，静态无法判断）` };
}

function resolveSwitch(view, node, ctx, self) {
  const sw = resolveSwitchState(view, node);

  const branches = [];
  const nestedNotes = [];
  const get = (slot) => {
    const link = view.inputLink(node, slot);
    if (!link) return null;
    const r = resolveString(view, link.id, ctx);
    if (r.notes?.length) nestedNotes.push(`↳ ${slot} 内部：${r.notes.join('；')}`);
    branches.push({
      slot,
      active: sw.known ? (slot === 'on_true') === !!sw.value : null,
      status: r.status,
      statusText: STATUS_TEXT[r.status] || r.status,
      preview: preview(r.text),
      length: (r.text || '').length,
      source: r.source,
      text: r.text
    });
    return r;
  };
  const onTrue = get('on_true');
  const onFalse = get('on_false');
  const notes = [`开关判定：${sw.how}`];
  branches.forEach((b) => notes.push(`分支 ${b.slot}：${b.length} 字${b.active === true ? '（当前生效）' : b.active === false ? '（未生效）' : ''} — ${b.preview}`));
  notes.push(...nestedNotes);

  const active = sw.known ? (sw.value ? onTrue : onFalse) : null;
  if (!active) {
    notes.push('开关走向无法静态确定 → 不给出"最终文本"，仅列出两个分支供人工判断');
    return {
      text: null,
      status: 'candidate',
      source: self,
      path: pathOf(node, `${node.cls} 分支未定（${sw.how}）`),
      notes,
      branches
    };
  }
  return {
    text: active.text,
    status: active.status,
    source: active.source || self,
    path: pathOf(node, `${node.cls} → ${sw.value ? 'on_true' : 'on_false'} → ${active.path || ''}`),
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
      path: pathOf(node, `${node.cls}(Set_${key}) 未配对`),
      notes: [`找不到键为「${key}」的 Set 节点（现有键：${entries.map((e) => e.key).join(', ') || '无'}）`],
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
          path: pathOf(node, `${node.cls}(Set_${key}) ← 控件`),
          notes: wildcardNote(text),
          branches: []
        };
      }
    }
    return {
      text: null,
      status: 'unknown',
      source: self,
      path: pathOf(node, `${node.cls}(Set_${key}) 无输入`),
      notes: [`配对的 Set 节点（#${setNode.id} ${setNode.cls}）既没有连线也没有控件值`],
      branches: []
    };
  }
  const r = resolveString(view, link.id, ctx);
  return {
    ...r,
    source: r.source || self,
    path: pathOf(node, `${node.cls}(Set_${key}) ← Set #${setNode.id}(${usedName}) ← ${r.path || '上游'}`),
    notes: [`经 SetNode/GetNode 取值（键「${key}」）`].concat(r.notes || []),
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
        path: pathOf(node, `${node.cls}.${textish[0]}（通用规则推测）`),
        notes: [`节点类 ${node.cls} 未登记在适配器表里，按其唯一文本控件「${textish[0]}」推测，未逐字校验`],
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
      path: pathOf(node, `${node.cls}.${linkedStringInput} ← ${r.path || '上游'}`),
      notes: (r.notes || []).concat([`节点类 ${node.cls} 未登记，已按输入口「${linkedStringInput}」向上游取值（状态降级为候选）`])
    };
  }
  return {
    text: null,
    status: 'unknown',
    source: self,
    path: pathOf(node, `${node.cls} 未登记`),
    notes: [`节点类 ${node.cls} 未登记为文本来源，无法确定其文本内容`],
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

function pathOf(node, tail) {
  return `#${node.id} ${node.cls}${tail ? ' ' + tail : ''}`;
}

export function preview(text, n = 70) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s || '(空)';
}
