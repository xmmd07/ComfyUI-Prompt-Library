# ComfyUI-Prompt-Library · 侧边栏 Prompt 探针 + 收藏库

一个 **纯前端** 的 ComfyUI 侧边栏插件，包含两个视图：

- **探针（扫描）**：检查"当前工作流里的 Prompt 到底能不能被正确读出来"（阶段一）。
- **我的收藏**：把满意的 Prompt 收藏起来，支持搜索 / 筛选 / 查看 / 编辑 / 复制 / 删除（阶段二）。

- 插件目录：`D:\APPs\comfyUI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Prompt-Library\`
- 收藏数据目录（独立于插件代码）：`ComfyUI\user\default\prompt_library\library.json`
- 适用环境：ComfyUI 后端 0.37.2 + 前端 1.52.7（秋葉 aki-v3 整合版），实测通过
- 无 Python 依赖、无 npm 依赖、无后端节点、无新增 HTTP 路由、不调 AI API、不联网

---

## 1. 安装

1. **无需安装任何依赖**（没有 requirements.txt，没有 package.json，不调用 pip / npm）。
2. 插件已经就位于 `custom_nodes\ComfyUI-Prompt-Library\`。如果你是从别处拷贝的，只需把整个
   `ComfyUI-Prompt-Library` 文件夹放进 `ComfyUI\custom_nodes\` 即可。
3. **需要重启 ComfyUI**：前端扩展目录（`WEB_DIRECTORY`）是在 ComfyUI 启动时登记的，
   启动器不会热加载新插件目录中的 JS。
   - 用绘世启动器：停止 → 启动；
   - 或直接关闭正在运行的 ComfyUI 窗口，再用启动器启动一次。
   - ⚠️ 重启会丢失画布上未保存的工作流改动，重启前请先保存你在编辑的工作流。

> 说明：本插件不改动 ComfyUI 核心文件、不改动其他自定义节点、不改动工作流，也不写任何用户数据。

## 2. 验证插件是否已加载（三种方式，任选）

**方式 A · 看侧边栏（最直观）**
重启后，ComfyUI 左侧竖排图标栏会多出一个放大镜图标，悬停显示 `Prompt Probe`；点开即为面板。

**方式 B · 看浏览器控制台**
打开浏览器开发者工具（F12 → Console），应能看到：
```
[Prompt Probe] 已注册侧边栏标签「Prompt Probe」v0.2.0（探针只读 + 本地收藏）
```
并可在 Console 里执行只读调试命令：
```js
window.__promptProbe.version                       // "0.2.0"
window.__promptProbe.scanLive()                    // 扫描当前画布并返回结构化结果
await window.__promptProbe.scanWorkflowFile("Krea2全面 (1).json")   // 只读解析某个工作流文件（不打开它）
window.__promptProbe.library.state().library       // 当前收藏库（内存中）
await window.__promptProbe.library.reload()        // 从磁盘重新载入收藏
```

**方式 C · 命令行检查服务是否已登记本扩展**
```bash
curl -s http://127.0.0.1:8188/extensions | grep -i prompt-library
# 期望输出包含："/extensions/ComfyUI-Prompt-Library/prompt_probe.js"
```
（重启前这条不会有输出，属正常。）

## 3. 使用

1. 侧边栏点开 `Prompt Library`（面板第一行也是这个名字，版本号在其右侧）。
2. 打开你要检查的工作流（面板不会改动它）。
3. 点「重新扫描」（面板每次打开时也会自动扫描一次）。
4. 面板内容：
   - **当前工作流名**、节点数、识别到的采样链数、候选文本数；
   - **每条采样链一个标签页**（如 `链1 · KSampler #350`、`链2 · ClownsharKSampler_Beta #288`），
     多条链可点击切换；
   - 链内每个文本字段（正向/负向）是一张**简洁卡片**，默认只显示：
     角色徽标、目标节点、**状态徽标**、**字符数**、**来源节点**、**3 行正文预览**、
     「选为收藏 / 复制 / 展开全文」按钮；
   - **低频技术信息**（取值链、节点 ID、字段名、读取备注、ComfySwitchNode 分支）收在卡片底部的
     **「技术详情」** 里，点一下展开 —— 信息一条都没删，只是不再默认占屏；
   - **候选文本** 标签页：列出"没有被任何采样链引用"的文本编码节点（例如游离节点、被绕过的残留节点），
     它们**不会**被当作有效 Prompt。
5. 复制：点卡片里的「复制」（负向那一行有「复制负向」）。

### 顶部布局与两个页面（v0.2）

```
┌ Prompt Library   v0.2 · 探针 / 收藏        ← 第 1 行：品牌 + 版本（低优先级）
├ [ 探针 ] [ 我的收藏 (N) ]                   ← 第 2 行：统一的页面切换
├ 探针页：  [重新扫描] [★ 收藏 Prompt]        ← 第 3 行：只放当前页面的操作
│ 收藏页：  [按标题搜索…]                     ←   （搜索框独占一行）
│           [全部模型 ▾] [刷新] [导出]
└ 只读探针 · 收藏存于 user\default\prompt_library\   ← 底部一行简短说明
```

两个页面共用同一套按钮高度、圆角、间距、徽标配色；切换页面时工具条会换成该页面的操作，
不再把「重新扫描」和「导出」堆在一起。所有内容都按 ComfyUI 窄侧边栏（约 240–420px）设计：
一律 flex + gap 布局、不用写死的固定高度（唯一的定位是收藏弹窗的遮罩，模态弹窗故意覆盖整屏）。

### 状态徽标的含义（重要）

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

## 4. 阶段二：收藏与管理

### 4.1 收藏一条 Prompt

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

### 4.2 我的收藏

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

## 5. 收藏数据存在哪、怎么保证不丢

- 位置：`ComfyUI\user\default\prompt_library\library.json`（**独立数据目录，不在插件代码目录里**）
  - 上一版内容：`library.bak.json`（每次保存前自动生成）
  - 损坏隔离文件：`library.broken.<时间>.json`（只有你点"另存损坏文件并重建空库"时才会生成）
- 写入方式：
  1. 由 ComfyUI 后端完成落盘（官方 `/userdata` 接口），写入过程是**临时文件 + 原子替换**，写到一半断电/刷新不会产生"半截 JSON"；
  2. 每次保存前把上一版复制到 `library.bak.json`，可随时手工回滚；
  3. 保存前会重新读取磁盘版本，若磁盘更新（例如另一个标签页刚写过），按 `id` **合并**而不是覆盖，避免丢收藏；
  4. 同一浏览器的并发保存用 Web Locks 串行化；
  5. 若 `library.json` 已损坏（不是合法 JSON），**拒绝写入**并在面板上给出提示 +「导出原始内容」/「重试加载」/「另存损坏文件并重建空库」（后两个都需要你确认）。

> 收藏数据与插件代码完全分离：**更新或卸载插件都不会删除收藏数据**。

## 6. 卸载（安全、可逆）

1. 关闭 ComfyUI（启动器 → 停止）。
2. 删除整个目录：`ComfyUI\custom_nodes\ComfyUI-Prompt-Library\`
3. 重新启动 ComfyUI。

- **不会删除任何用户数据**：收藏文件在 `user\default\prompt_library\`，卸载插件不影响它；想让收藏也消失，请**手工**删除该目录（插件永远不会自动删）。
- **不影响其他插件**：独立目录，不修改 `custom_nodes` 里的其他文件夹，也不修改 ComfyUI 核心。
- 临时停用：把文件夹改名为 `ComfyUI-Prompt-Library.disabled`（或移到 `custom_nodes\.disabled\`），重启即可。

## 7. 目录结构与文件用途

```
ComfyUI-Prompt-Library/
├── __init__.py                  # 只声明 WEB_DIRECTORY = "./web"（不注册后端节点/路由）
├── README.md                    # 本文件
├── web/                         # 前端资源（会被 ComfyUI 挂到 /extensions/ComfyUI-Prompt-Library/）
│   ├── prompt_probe.js          # 入口：registerExtension + registerSidebarTab（唯一被自动加载的文件）
│   ├── style.css                # 面板样式（走 ComfyUI 主题变量）
│   ├── probe/
│   │   ├── adapters.mjs         # 节点适配器表：哪些类存文本、字符串来源规则（以后加模型只改这里）
│   │   ├── graphview.mjs        # 图抽象：活画布视图 / 工作流 JSON 视图（同一接口）
│   │   ├── resolver.mjs         # 解析核心：采样链识别 + 文本递归解析 + 状态判定（阶段一）
│   │   ├── library.mjs          # 收藏库数据模型：校验/新增/更新/删除/搜索/筛选/合并（阶段二）
│   │   ├── storage.mjs          # 持久化：/userdata 读写 + 备份 + 合并 + 损坏保护（阶段二）
│   │   ├── favorites.mjs        # 收藏弹窗 / 二次确认弹窗 / 收藏列表渲染（阶段二）
│   │   ├── layout-audit.mjs     # 排版体检：重叠 / 横向溢出 / 撑破父容器 / 被裁切（v0.2，只读测量）
│   │   └── panel.mjs            # 侧边栏面板：顶部三行布局、扫描卡片、收藏列表（阶段一+二+v0.2 UI）
│   └── tools/
│       ├── selftest.mjs         # 自测①：解析核心（真实工作流，只读）
│       ├── selftest_library.mjs # 自测②：收藏库逻辑 + 面板交互 + UI 结构（minidom + 假 api，不碰真实数据）
│       ├── selftest_storage.mjs # 自测③：持久化（打真实 /userdata，只用临时目录并自动清理）
│       └── minidom.mjs          # 极简 DOM 垫片（仅供自测②使用）
└── devtools/                    # 可选：本地验证台（不参与 ComfyUI 运行，可直接删除）
    ├── harness.html             # 假画布页面，用真实工作流 JSON 驱动面板（含窄侧边栏两种宽度 + 假收藏库）
    ├── mock-app.mjs             # 把工作流 JSON 变成 litegraph 形状的假 app
    ├── serve.mjs                # 本地静态服务器（只读，默认 127.0.0.1:8791）
    └── cdp-shot.mjs             # 用本机 Edge/Chrome(headless) 渲染页面、跑 JS、出截图（零依赖，验收排版用）
```

> 注意：`web/**` 下除 `prompt_probe.js` 外都刻意用 `.mjs` 后缀 —— ComfyUI 会把
> `WEB_DIRECTORY` 下所有 `*.js` 当作扩展入口自动加载，用 `.mjs` 可避免子模块被当成独立扩展重复加载
> （它们仍能被入口文件通过相对路径 `import`，也能被 Node 自测直接引入）。

## 8. 自测（都不需要打开浏览器）

在插件目录下运行（都需要 Node，ComfyUI 自带的 python 无关）：

```bash
node web/tools/selftest.mjs           # ① 解析核心：真实工作流只读解析（29 项断言）
node web/tools/selftest_library.mjs   # ② 收藏库逻辑 + 面板交互 + UI 结构：minidom + 假 api，不碰真实数据（100 项断言）
node web/tools/selftest_storage.mjs   # ③ 持久化：打真实 /userdata，只写临时目录并在结束前清理（23 项断言）
```
附加参数：
```bash
node web/tools/selftest.mjs --workflows "D:/APPs/comfyUI/ComfyUI-aki-v3/ComfyUI/user/default/workflows"
node web/tools/selftest.mjs --oi "C:/path/object_info.json"          # 服务器没开时用本地快照
node web/tools/selftest_storage.mjs --dir prompt_library_selftest --comfy http://127.0.0.1:8188
```
退出码 0 = 全部通过。三个自测都不会读写真实收藏数据（①③ 只读工作流/临时目录，② 全部在内存里）。

### 8.1 窄侧边栏排版体检（真实渲染，不是读代码）

**方式 A · 直接在真实侧边栏里量（推荐，你机器上就能跑）**

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

**方式 C · 命令行出截图 + 自动体检（零依赖，用你机器上已有的 Edge）**

```bash
# 1) 先起一个开了远程调试的 headless Edge/Chrome（临时的，不影响你正在用的浏览器）
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --no-first-run \
  --remote-debugging-port=9222 --user-data-dir="%TEMP%\edge-cdp" about:blank
# 2) 渲染 + 体检 + 截图
node devtools/cdp-shot.mjs "http://127.0.0.1:8791/" out.png --width 860 --height 1000 \
  --eval "window.__harness.load('Krea2全面 (1).json').then(()=>{window.__harness.setWidth(300,'a');return 1})" \
  --eval "window.__harness.audit('a')"
```

## 9. 已知局限（面板会明确标注，不猜）

1. **运行期生成的文本**（`TextGenerate`、`QwenImage21PromptEnhancerT8`、`StringFormat`、`RegexExtract` 等）静态读不到 → 标为「运行时生成」，收藏时内容为空会被拦下。
2. **开关走向无法静态判断时**（`ComfySwitchNode.switch` 由运行期节点驱动）→ 不给出"最终文本"，只列出两个分支并标为「候选文本」；此时仍可收藏，但弹窗会保留"未确认"提示，列表里也带同样徽标。
3. **未登记的第三方文本节点**：只在"有唯一文本控件"时给出推测值并降级为「候选文本」，否则标「无法确认」。
4. **子图（Subgraph，前端 1.52 新特性）**：会尝试向下递归，但嵌套很深或形态特殊时可能读不全，会标注。
5. **云 API 伙伴节点**（如 `Krea2ImageNode`）不产生本地 conditioning 链，不会被识别为采样链目标。
6. **动态提示符**（`{a|b}`、`__wildcard__`）：命中时按字面展示，并提示"实际执行文本可能不同"。
7. 面板基于**当前画布状态**扫描；改了工作流后请点「重新扫描」。
8. 搜索目前只匹配**标题**（按需求）；模型分类需要手动选择或新增（第一版不做自动识别）。
9. **极窄侧边栏下的折行**：侧边栏宽度小于约 330px 时，很长的节点类名（如 `TextEncodeKrea2OstrisEdit`）
   那一个信息行会自动折成 2–3 行。这是刻意选择——**宁可折行也不截断信息**（截断只用于你明确要截断的
   标题/预览）。所有排版体检（重叠/溢出/撑破/裁切）在 240 / 300 / 312 / 420px 下均为 `ok: true`。

## 10. 安全边界（本阶段遵守的情况）

- 只改动 `custom_nodes\ComfyUI-Prompt-Library\` 内的文件；未修改 ComfyUI 核心、其他自定义节点、模型、工作流、启动配置。
- 未安装任何软件或 Python 包（纯前端，无需依赖）；未接入 MCP，未调用任何 AI API。
- 唯一新增的"数据写入"是**你主动点保存/编辑/删除**时写 `user\default\prompt_library\library.json`（含 `library.bak.json` 备份）；插件不会在后台自动写任何东西，也不会自动删除收藏。
- 不向 `/prompt` 提交任务（不会触发出图）；所有探针读取都是 GET。
- 任何异常都在内部捕获并只写 `console.warn`，不会阻断 ComfyUI 启动。

### v0.2（UI 专项整理）本阶段额外说明

- 只改了 `custom_nodes\ComfyUI-Prompt-Library\` 内的前端文件（`style.css`、`probe/panel.mjs`、`probe/favorites.mjs`、
  `prompt_probe.js`、新增 `probe/layout-audit.mjs`、`devtools/*`）；**解析逻辑（`resolver.mjs` / `adapters.mjs` / `graphview.mjs`）一行未动**。
- **未读写、未迁移收藏数据**：本阶段只是渲染层面的改动；实际运行中数据文件 `library.json` 的修改时间保持在你上次保存的时刻（未被本阶段触碰）。
- 排版验收用**真实浏览器渲染**完成：本机 Hermes 自带浏览器工具当时不可用，因此用本机已装的 Edge（headless + CDP）渲染
  真实 ComfyUI 页面并测量，另外在本地验证台按 240 / 300 / 312 / 420px 四种宽度复核。
