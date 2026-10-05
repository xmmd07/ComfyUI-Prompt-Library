/**
 * devtools/mock-app.mjs —— 开发/验证用的"假画布"
 *
 * 作用：把一份工作流 JSON 转成 litegraph 形状的假 app（含 _nodes / links / _groups），
 * 这样就能在浏览器里用真实的 createLiveView + panel 渲染面板，而完全不碰 ComfyUI 服务。
 * 仅用于本地验证，不属于插件运行时逻辑。
 */

import { widgetNamesForClass } from '../web/probe/graphview.mjs';

export function makeMockApp(workflow, objectInfo) {
  const links = {};
  for (const l of workflow.links || []) {
    if (Array.isArray(l) && l.length >= 5) {
      links[l[0]] = { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4] };
    }
  }

  const groups = (workflow.groups || []).map((g) => ({
    title: g.title || '',
    pos: [g.bounding?.[0] ?? 0, g.bounding?.[1] ?? 0],
    size: [g.bounding?.[2] ?? 0, g.bounding?.[3] ?? 0]
  }));

  const graph = { _nodes: [], links, _groups: groups };

  graph._nodes = (workflow.nodes || []).map((n) => {
    const names = widgetNamesForClass(n.type, objectInfo);
    const values = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const widgets = names
      .map((name, i) => (i < values.length ? { name, value: values[i] } : null))
      .filter(Boolean);
    return {
      id: n.id,
      type: n.type,
      title: n.title || '',
      mode: typeof n.mode === 'number' ? n.mode : 0,
      flags: n.flags || {},
      pos: n.pos || [0, 0],
      size: n.size || [0, 0],
      inputs: n.inputs || [],
      outputs: n.outputs || [],
      widgets,
      widgets_values: values,
      graph
    };
  });

  return { rootGraph: graph, graph, __mock: true };
}
