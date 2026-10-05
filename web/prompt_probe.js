/**
 * prompt_probe.js —— 插件入口（唯一会被前端自动加载为扩展的文件）
 *
 * 只做三件事：
 *   1. 加载样式（相对本文件 URL）
 *   2. 用官方 app.registerExtension + app.extensionManager.registerSidebarTab 注册一个只读面板
 *   3. 暴露 window.__promptProbe 只读调试入口（扫描画布 / 只读解析工作流文件）
 *
 * 任何异常都在内部捕获并只写 console，绝不影响 ComfyUI 启动或其他插件。
 */

import { createPanel } from './probe/panel.mjs';
import { createLiveView, createJsonView } from './probe/graphview.mjs';
import { scan } from './probe/resolver.mjs';

const NAME = 'ComfyUI-Prompt-Library · Prompt Probe';
const VERSION = '0.2.0';
const log = (...a) => console.log('[Prompt Probe]', ...a);
const warn = (...a) => console.warn('[Prompt Probe]', ...a);

function getApp() {
  try {
    return window?.comfyAPI?.app?.app || null;
  } catch (e) {
    return null;
  }
}

function loadStyle() {
  try {
    const href = new URL('./style.css', import.meta.url).href;
    if (document.querySelector('link[data-prompt-probe-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-prompt-probe-style', '1');
    document.head.appendChild(link);
  } catch (e) {
    warn('样式加载失败（不影响功能）', e);
  }
}

/* ---------- 按类名懒加载 /object_info（只在"只读解析工作流文件"时需要） ---------- */
const oiCache = new Map();

async function fetchObjectInfoFor(classes) {
  const api = window?.comfyAPI?.api?.api;
  const out = {};
  if (!api?.fetchApi) return out;
  await Promise.all(
    [...new Set(classes)].filter(Boolean).map(async (cls) => {
      if (oiCache.has(cls)) {
        out[cls] = oiCache.get(cls);
        return;
      }
      try {
        const res = await api.fetchApi(`/object_info/${encodeURIComponent(cls)}`);
        if (!res.ok) return;
        const data = await res.json();
        const spec = data?.[cls];
        if (spec) {
          oiCache.set(cls, spec);
          out[cls] = spec;
        }
      } catch (e) {
        /* 单类失败不影响整体 */
      }
    })
  );
  return out;
}

/**
 * 只读解析某个工作流文件（不打开它、不改动画布、不写任何文件）
 * @param {string} name 例如 "Krea2全面 (1).json"
 */
async function scanWorkflowFile(name) {
  const api = window?.comfyAPI?.api?.api;
  if (!api?.fetchApi) throw new Error('api.fetchApi 不可用');
  // /userdata/{file} 的 {file} 是单段路径：整条相对路径（含 /）必须一起编码
  const res = await api.fetchApi(`/userdata/${encodeURIComponent(`workflows/${name}`)}`);
  if (!res.ok) throw new Error(`读取工作流失败：HTTP ${res.status}`);
  const workflow = await res.json();
  const oi = await fetchObjectInfoFor((workflow.nodes || []).map((n) => n.type));
  return scan(createJsonView(workflow, oi, { workflowName: name }));
}

function boot() {
  const app = getApp();
  if (!app) {
    warn('未找到 window.comfyAPI.app.app；扩展未注册（ComfyUI 本身不受影响）');
    return;
  }
  loadStyle();

  app.registerExtension({
    name: 'ComfyUI.PromptLibrary.PromptProbe',

    async setup() {
      try {
        const em = app.extensionManager;
        if (!em || typeof em.registerSidebarTab !== 'function') {
          warn('当前前端不支持 extensionManager.registerSidebarTab，面板未注册');
          return;
        }
        const panel = createPanel(app, { api: window.comfyAPI?.api?.api });
        em.registerSidebarTab({
          id: 'prompt-probe',
          icon: 'pi pi-search',
          title: 'Prompt Library',
          tooltip: 'Prompt Library · 提示词探针（只读）+ 本地收藏',
          label: 'Prompt Library',
          type: 'custom',
          render: (el) => {
            try {
              el.classList.add('pp-host');
              panel.mount(el);
            } catch (e) {
              warn('面板挂载失败（不影响 ComfyUI）', e);
            }
          },
          destroy: () => {
            try {
              panel.destroy();
            } catch (e) {
              /* 忽略 */
            }
          }
        });

        // 只读 + 收藏调试入口：便于自检，不参与界面渲染
        window.__promptProbe = {
          version: VERSION,
          name: NAME,
          scanLive: () => {
            try {
              panel.rescan();
              return panel.state.result;
            } catch (e) {
              return { error: String(e) };
            }
          },
          scanView: (workflowJson, objectInfo) => scan(createJsonView(workflowJson, objectInfo)),
          scanWorkflowFile,
          createLiveView: () => createLiveView(app),
          /* 阶段二：收藏库调试入口（等价于界面上的操作，仍是用户主动触发） */
          library: {
            state: () => panel.state,
            reload: () => panel.loadLibrary(),
            save: (draft) => panel.persistItem(draft),
            path: 'ComfyUI\\user\\default\\prompt_library\\library.json'
          },
          /* UI 专项：排版体检（只读测量，不发请求）—— 在真实侧边栏里跑一次即可验收 */
          auditLayout: () => panel.auditLayout()
        };
        log(`已注册侧边栏标签「Prompt Library」v${VERSION}（提示词探针只读 + 本地收藏）`);
      } catch (e) {
        warn('初始化失败（ComfyUI 不受影响）', e);
      }
    }
  });
}

try {
  boot();
} catch (e) {
  warn('扩展加载失败（ComfyUI 不受影响）', e);
}
