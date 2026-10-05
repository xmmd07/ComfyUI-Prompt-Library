# ComfyUI Prompt Library

一个**纯前端**的 ComfyUI 侧边栏插件：只读扫描当前工作流里的 Prompt，并把满意的 Prompt 收藏成可搜索的本地库。

- **探针（只读扫描）** —— 检查工作流里的 Prompt 到底能不能被正确读出来，以及它实际来自哪些节点。
- **我的收藏** —— 收藏、搜索、筛选、查看、编辑、复制、删除。

无 Python 依赖、无 npm 依赖、不注册后端节点、不新增 HTTP 路由、不调用任何 AI API、不联网。

---

## 环境要求

| 项目 | 要求 |
|---|---|
| ComfyUI 后端 | 0.37.2 及以上 |
| ComfyUI 前端 | 1.52.7 及以上（侧边栏 API `registerSidebarTab` 由该版本提供） |
| Node.js | 仅在运行自测时需要，插件本身运行不需要 |
| Python / npm 依赖 | **无** |

已在 ComfyUI 后端 0.37.2 + 前端 1.52.7（秋葉 aki-v3 整合版）实测通过。

---

## 安装

### 方式一：git clone（推荐）

```bash
cd <你的 ComfyUI 目录>/custom_nodes
git clone https://github.com/xmmd07/ComfyUI-Prompt-Library.git
```

### 方式二：下载 ZIP

在仓库页面点 **Code → Download ZIP**，解压后把整个 `ComfyUI-Prompt-Library` 文件夹放进：

```
<你的 ComfyUI 目录>/custom_nodes/
```

放好后应存在 `<你的 ComfyUI 目录>/custom_nodes/ComfyUI-Prompt-Library/__init__.py`。

### 装完必须重启 ComfyUI

前端扩展目录（`WEB_DIRECTORY`）是在 ComfyUI **启动时**登记的，启动之后新放进去的 JS 不会被热加载。

- 绘世启动器：停止 → 启动；
- 或直接关闭正在运行的 ComfyUI 窗口，再启动一次。

> ⚠️ 重启会丢失画布上未保存的工作流改动，重启前请先保存正在编辑的工作流。

---

## 验证插件是否已加载

三种方式任选其一。

**方式 A · 看侧边栏（最直观）**

重启后，ComfyUI 左侧竖排图标栏会多出一个放大镜图标，悬停显示 `Prompt Library`；点开即为面板。

**方式 B · 看浏览器控制台**

打开开发者工具（F12 → Console），应能看到：

```
[Prompt Probe] 已注册侧边栏标签「Prompt Library」v0.2.0（提示词探针只读 + 本地收藏）
```

并可在 Console 里执行只读调试命令：

```js
window.__promptProbe.version                                      // "0.2.0"
window.__promptProbe.scanLive()                                   // 扫描当前画布并返回结构化结果
await window.__promptProbe.scanWorkflowFile("my-workflow.json")   // 只读解析某个工作流文件（不打开它）
window.__promptProbe.library.state().library                      // 当前收藏库（内存中）
await window.__promptProbe.library.reload()                       // 从磁盘重新载入收藏
```

**方式 C · 命令行检查服务是否已登记本扩展**

```bash
curl -s http://127.0.0.1:8188/extensions | grep -i prompt-library
# 期望输出包含："/extensions/ComfyUI-Prompt-Library/prompt_probe.js"
```

（重启前这条不会有输出，属正常。）

---

## 使用

顶部布局如下，两个视图共用同一套按钮高度、圆角、间距与徽标配色：

```
┌ Prompt Library   v0.2 · 探针 / 收藏        ← 第 1 行：品牌 + 版本
├ [ 探针 ] [ 我的收藏 (N) ]                   ← 第 2 行：视图切换
├ 探针页：  [重新扫描] [★ 收藏 Prompt]        ← 第 3 行：只放当前视图的操作
│ 收藏页：  [按标题搜索…]                     ←   （搜索框独占一行）
│           [全部模型 ▾] [刷新] [导出]
└ 只读探针 · 收藏存于 user\default\prompt_library\   ← 底部一行简短说明
```

所有内容都按 ComfyUI 窄侧边栏（约 240–420px）设计：一律 flex + gap 布局、不用写死的固定高度（唯一的定位是收藏弹窗的遮罩，模态弹窗故意覆盖整屏）。

### 1. 探针（扫描）

1. 侧边栏点开 `Prompt Library`。
2. 打开要检查的工作流（面板不会改动它）。
3. 点「重新扫描」（面板每次打开时也会自动扫描一次）。

面板内容：

- **当前工作流名**、节点数、识别到的采样链数、候选文本数；
- **每条采样链一个标签页**（如 `链1 · KSampler #350`、`链2 · ClownsharKSampler_Beta #288`），多条链可点击切换；
- 链内每个文本字段（正向/负向）是一张**简洁卡片**，默认只显示：角色徽标、目标节点、**状态徽标**、**字符数**、**来源节点**、**3 行正文预览**，以及「选为收藏 / 复制 / 展开全文」按钮；
- **低频技术信息**（取值链、节点 ID、字段名、读取备注、ComfySwitchNode 分支）收在卡片底部的 **「技术详情」** 里，点一下展开 —— 信息一条都没删，只是不再默认占屏；
- **候选文本** 标签页：列出"没有被任何采样链引用"的文本编码节点（例如游离节点、被绕过的残留节点），它们**不会**被当作有效 Prompt。
- 复制：点卡片里的「复制」（负向那一行有「复制负向」）。

### 状态徽标的含义

| 徽标 | 含义 |
|---|---|
| 已确认 | 全部取值都落在具体控件值上，且节点正常参与出图 |
| 部分确认 | 文本读到了，但链路上有部分内容读不到（面板会列出具体位置） |
| 候选文本 | 无法确认它是不是最终生效的文本（例如开关走向取决于运行期、未登记节点靠唯一文本控件推测） |
| 运行时生成 | 文本由模型/节点在运行期生成（如 `TextGenerate`），静态读不到 |
| 无法确认 | 读不到，且证据不足；面板会说明原因（缺配对 Set 节点、无连线等） |

另外两种提示：

- **`⚠ 当前处于「绕过(bypass)/静音(mute)」状态，不参与出图`**：该文本仅供参考。
- **`该控件里还存有 N 字的旧文本，但已被连线取代`**：说明节点控件里的内容是残留值，面板用的是真正生效的连线结果。

### 2. 收藏一条 Prompt

1. 在「探针（扫描）」视图里，点某条 Prompt 的**整行**（或行内的「选为收藏」按钮）→ 该条被选中（蓝色高亮，顶部出现"已选中…"信息条）。
2. 点右上角 **「★ 收藏 Prompt」**（或信息条里的「收藏这条」）。
   - **没有选中任何条目时**，面板会提示"还没有选中 Prompt…"，**不会**随便存一条；
   - 选中的条目内容为空（运行时生成/无法确认的项）时也会提示，不会保存。
3. 弹窗里填写：
   - **标题**（必填）
   - **模型分类**（必填）：默认 Anima / Krea 2 / Qwen Image 2.1；选「＋ 新增模型分类…」可自己输入新的分类，保存后进入分类列表
   - **Prompt 内容**：已自动填入解析结果，**可以随意编辑**（例如删掉固定的质量词）
   - 弹窗顶部会保留**来源状态提示**（如果该条是"候选文本/部分确认/被绕过"，这里会明确写出来）
4. 点「保存」。数据立即写入本地文件。

### 3. 我的收藏

顶部切到 **「我的收藏 (N)」**。工具条分两行排在页面顶部：第一行搜索框，第二行模型筛选 + 刷新 / 导出。

每条收藏卡片自上而下是固定的四行 + 一行按钮：

```
① 收藏标题（粗体，最醒目，最多 2 行）        [模型标签]
② [状态徽标] 字数 · 收藏于 时间
③ 来源：工作流名 · 节点类 #ID · 角色
④ Prompt 预览（最多 3 行，超出截断）
   [查看完整] [编辑] [复制] [删除]
```

| 功能 | 说明 |
|---|---|
| 展示已保存的 Prompt | 卡片列表（标题比模型/状态标签更醒目；边框只有一层，靠间距分层级） |
| 按标题搜索 | 顶部输入框即时过滤（不区分大小写）；筛选生效时下方显示「筛选后显示 X / 共 Y 条」 |
| 按模型筛选 | 顶部下拉选择"全部模型 / 某个分类" |
| 查看完整 | 展开/收起全文（默认只显示 3 行预览，长 Prompt 不再占满侧边栏） |
| 编辑 | 改标题、模型分类、Prompt 内容（保留创建时间与 id） |
| 一键复制 | 复制全文到剪贴板 |
| 删除 | 弹二次确认，点「确认删除」才真正删除 |
| 导出 JSON | 把收藏库导出成一个文件（浏览器下载），便于备份 |

---

## 收藏数据存在哪、怎么保证不丢

- 位置：`ComfyUI\user\default\prompt_library\library.json`（**独立数据目录，不在插件代码目录里**）
  - 上一版内容：`library.bak.json`（每次保存前自动生成）
  - 损坏隔离文件：`library.broken.<时间>.json`（仅在点"另存损坏文件并重建空库"时才会生成）
- 写入方式：
  1. 由 ComfyUI 后端完成落盘（官方 `/userdata` 接口），写入过程是**临时文件 + 原子替换**，写到一半断电/刷新不会产生"半截 JSON"；
  2. 每次保存前把上一版复制到 `library.bak.json`，可随时手工回滚；
  3. 保存前会重新读取磁盘版本，若磁盘更新（例如另一个标签页刚写过），按 `id` **合并**而不是覆盖，避免丢收藏；
  4. 同一浏览器的并发保存用 Web Locks 串行化；
  5. 若 `library.json` 已损坏（不是合法 JSON），**拒绝写入**并在面板上给出提示 +「导出原始内容」/「重试加载」/「另存损坏文件并重建空库」（后两个都需要二次确认）。

> 收藏数据与插件代码完全分离：**更新或卸载插件都不会删除收藏数据**。

---

## 卸载

1. 关闭 ComfyUI（启动器 → 停止）。
2. 删除整个目录：`ComfyUI\custom_nodes\ComfyUI-Prompt-Library\`
3. 重新启动 ComfyUI。

- **不会删除任何用户数据**：收藏文件在 `user\default\prompt_library\`，卸载插件不影响它；想让收藏也消失，需**手工**删除该目录（插件永远不会自动删）。
- **不影响其他插件**：独立目录，不修改 `custom_nodes` 里的其他文件夹，也不修改 ComfyUI 核心。
- 临时停用：把文件夹改名为 `ComfyUI-Prompt-Library.disabled`（或移到 `custom_nodes\.disabled\`），重启即可。

---

## 目录结构

```
ComfyUI-Prompt-Library/
├── __init__.py                  # 只声明 WEB_DIRECTORY = "./web"（不注册后端节点/路由）
├── README.md                    # 本文件
├── web/                         # 前端资源（会被 ComfyUI 挂到 /extensions/ComfyUI-Prompt-Library/）
│   ├── prompt_probe.js          # 入口：registerExtension + registerSidebarTab（唯一被自动加载的文件）
│   ├── style.css                # 面板样式（走 ComfyUI 主题变量）
│   ├── probe/
│   │   ├── adapters.mjs         # 节点适配器表：哪些类存文本、字符串来源规则（加新模型只改这里）
│   │   ├── graphview.mjs        # 图抽象：活画布视图 / 工作流 JSON 视图（同一接口）
│   │   ├── resolver.mjs         # 解析核心：采样链识别 + 文本递归解析 + 状态判定
│   │   ├── library.mjs          # 收藏库数据模型：校验/新增/更新/删除/搜索/筛选/合并
│   │   ├── storage.mjs          # 持久化：/userdata 读写 + 备份 + 合并 + 损坏保护
│   │   ├── favorites.mjs        # 收藏弹窗 / 二次确认弹窗 / 收藏列表渲染
│   │   ├── layout-audit.mjs     # 排版体检：重叠 / 横向溢出 / 撑破父容器 / 被裁切（只读测量）
│   │   └── panel.mjs            # 侧边栏面板：顶部三行布局、扫描卡片、收藏列表
│   └── tools/
│       ├── selftest.mjs         # 自测①：解析核心（真实工作流，只读）
│       ├── selftest_library.mjs # 自测②：收藏库逻辑 + 面板交互 + UI 结构（minidom + 假 api，不碰真实数据）
│       ├── selftest_storage.mjs # 自测③：持久化（打真实 /userdata，只用临时目录并自动清理）
│       └── minidom.mjs          # 极简 DOM 垫片（仅供自测②使用）
└── devtools/                    # 可选：本地验证台（不参与 ComfyUI 运行，可直接删除）
    ├── harness.html             # 假画布页面，用真实工作流 JSON 驱动面板（含窄侧边栏两种宽度 + 假收藏库）
    ├── mock-app.mjs             # 把工作流 JSON 变成 litegraph 形状的假 app
    ├── serve.mjs                # 本地静态服务器（只读，默认 127.0.0.1:8791）
    └── cdp-shot.mjs             # 用本地 Edge/Chrome(headless) 渲染页面、跑 JS、出截图（零依赖）
```

> 注意：`web/**` 下除 `prompt_probe.js` 外都刻意用 `.mjs` 后缀 —— ComfyUI 会把
> `WEB_DIRECTORY` 下所有 `*.js` 当作扩展入口自动加载，用 `.mjs` 可避免子模块被当成独立扩展重复加载
> （它们仍能被入口文件通过相对路径 `import`，也能被 Node 自测直接引入）。

---

## 开发与自测

三个自测都不需要打开浏览器，在插件目录下运行（需要 Node.js）：

```bash
node web/tools/selftest.mjs           # ① 解析核心：真实工作流只读解析（29 项断言）
node web/tools/selftest_library.mjs   # ② 收藏库逻辑 + 面板交互 + UI 结构（100 项断言）
node web/tools/selftest_storage.mjs   # ③ 持久化：打真实 /userdata，只写临时目录并在结束前清理（23 项断言）
```

附加参数：

```bash
node web/tools/selftest.mjs --workflows "<你的 ComfyUI 目录>/user/default/workflows"
node web/tools/selftest.mjs --oi "<object_info.json 的路径>"    # 服务器没开时用本地快照
node web/tools/selftest_storage.mjs --dir prompt_library_selftest --comfy http://127.0.0.1:8188
```

退出码 0 = 全部通过。三个自测都不会读写真实收藏数据（①③ 只读工作流/临时目录，② 全部在内存里）。

### 窄侧边栏排版体检（真实渲染，不是读代码）

**方式 A · 直接在真实侧边栏里量**

1. 打开 ComfyUI，侧边栏点开 `Prompt Library`；
2. 按 `F12` → Console，粘贴回车：

```js
copy(JSON.stringify(window.__promptProbe.auditLayout(), null, 2))
```

输出 `ok: true` 表示**没有元素重叠、没有横向溢出、没有内容被撑破/裁切**（`hostWidth` 是当前侧边栏实际宽度）。
若 `ok: false`，`overlaps / overflowX / overflowRight / clipped` 会逐条列出是哪个元素、和谁重叠、面积多少。

**方式 B · 本地验证台（不用连 ComfyUI 图形界面）**

```bash
node devtools/serve.mjs            # 然后浏览器打开 http://127.0.0.1:8791/
```

页面左右各一个容器（300px / 420px，模拟窄侧边栏），加载真实工作流 JSON + 一份假收藏库（含超长标题/超长 Prompt/超长工作流名），可逐个点着看。

**方式 C · 命令行出截图 + 自动体检（零依赖，用本地已装的 Edge 或 Chrome）**

```bash
# 1) 先起一个开了远程调试的 headless Edge/Chrome（临时的，不影响正在用的浏览器）
"<Edge 或 Chrome 的可执行文件路径>" --headless=new --disable-gpu --no-first-run \
  --remote-debugging-port=9222 --user-data-dir="%TEMP%\edge-cdp" about:blank
# 2) 渲染 + 体检 + 截图
node devtools/cdp-shot.mjs "http://127.0.0.1:8791/" out.png --width 860 --height 1000 \
  --eval "window.__harness.load('my-workflow.json').then(()=>{window.__harness.setWidth(300,'a');return 1})" \
  --eval "window.__harness.audit('a')"
```

---

## 已知局限

面板会明确标注这些情况，不会猜。

1. **运行期生成的文本**（`TextGenerate`、`QwenImage21PromptEnhancerT8`、`StringFormat`、`RegexExtract` 等）静态读不到 → 标为「运行时生成」，收藏时内容为空会被拦下。
2. **开关走向无法静态判断时**（`ComfySwitchNode.switch` 由运行期节点驱动）→ 不给出"最终文本"，只列出两个分支并标为「候选文本」；此时仍可收藏，但弹窗会保留"未确认"提示，列表里也带同样徽标。
3. **未登记的第三方文本节点**：只在"有唯一文本控件"时给出推测值并降级为「候选文本」，否则标「无法确认」。
4. **子图（Subgraph，前端 1.52 新特性）**：会尝试向下递归，但嵌套很深或形态特殊时可能读不全，会标注。
5. **云 API 伙伴节点**（如 `Krea2ImageNode`）不产生本地 conditioning 链，不会被识别为采样链目标。
6. **动态提示符**（`{a|b}`、`__wildcard__`）：命中时按字面展示，并提示"实际执行文本可能不同"。
7. 面板基于**当前画布状态**扫描；改了工作流后请点「重新扫描」。
8. 搜索目前只匹配**标题**；模型分类需要手动选择或新增（暂不做自动识别）。
9. **极窄侧边栏下的折行**：侧边栏宽度小于约 330px 时，很长的节点类名（如 `TextEncodeKrea2OstrisEdit`）那一个信息行会自动折成 2–3 行。这是刻意选择 —— **宁可折行也不截断信息**（截断只用于标题/预览）。所有排版体检（重叠/溢出/撑破/裁切）在 240 / 300 / 312 / 420px 下均为 `ok: true`。

---

## 设计约束

- 只改动 `custom_nodes\ComfyUI-Prompt-Library\` 内的文件；不修改 ComfyUI 核心、其他自定义节点、模型、工作流、启动配置。
- 无第三方依赖、不接入 MCP、不调用任何 AI API、不联网。
- 唯一的数据写入发生在用户主动点保存/编辑/删除时（写 `user\default\prompt_library\library.json` 及 `library.bak.json` 备份）；插件不会在后台自动写任何东西，也不会自动删除收藏。
- 不向 `/prompt` 提交任务（不会触发出图）；所有探针读取都是 GET。
- 任何异常都在内部捕获并只写 `console.warn`，不会阻断 ComfyUI 启动。

---

## 许可证

本项目采用 [MIT License](LICENSE) 授权，可自由使用、修改、分发与商用，只需保留版权声明。
