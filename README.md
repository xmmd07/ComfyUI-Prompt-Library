# ComfyUI Prompt Library

A **pure-frontend** ComfyUI sidebar extension: it read-only scans the prompts in your current workflow, saves the good ones into a searchable local library, and keeps an artist-string list with reference images.

[English](./README.md) | [简体中文](./README.zh-CN.md)

**Four tabs in the sidebar:**

- **Probe** (read-only scan) — checks whether prompts in your workflow can actually be read correctly, and which node each one comes from. For prompts assembled by concat nodes (`StringConcatenate` family / `JoinStringMulti` / `CR Combine Prompt`), it shows **per-segment breakdown**: each segment can be copied or favorited on its own.
- **Favorites** — save, search, filter, view, edit, copy, delete; import from a JSON export (merge by id, duplicates skipped); sort by recent or most-used (copy count).
- **Artist Strings** — each entry is the artist string itself; optionally attach a reference image from your output history and zoom it in a lightbox.
- **LoRA Notes** — attach a note ("which spell works with this LoRA") to any LoRA; pick from your LoRA list when adding.

No Python deps, no npm deps, no backend nodes, no new HTTP routes, no AI API calls, fully offline.

## Requirements

| Item | Requirement |
|---|---|
| ComfyUI backend | 0.37.2 or later |
| ComfyUI frontend | 1.52.7 or later (sidebar API `registerSidebarTab`) |
| Node.js | only for running the self-tests; the extension itself doesn't need it |
| Python / npm dependencies | **none** |

Tested on ComfyUI backend 0.42.3 + frontend 1.55.18 (AIO packages fine).

## Install

### Option A: git clone (recommended)

```bash
cd <your ComfyUI dir>/custom_nodes
git clone https://github.com/xmmd07/ComfyUI-Prompt-Library.git
```

### Option B: download ZIP

On the repo page, **Code → Download ZIP**, unzip, and put the whole `ComfyUI-Prompt-Library` folder into `<your ComfyUI dir>/custom_nodes/`. You should end up with `<your ComfyUI dir>/custom_nodes/ComfyUI-Prompt-Library/__init__.py`.

### You must restart ComfyUI after installing

Frontend extension folders (`WEB_DIRECTORY`) are registered **at startup**; JS dropped in afterwards is not hot-loaded. Restarting discards unsaved canvas changes — save your workflow first.

## Verify it loaded

Any one of these:

- `curl http://127.0.0.1:8188/extensions | grep -i prompt-library` → path shown;
- Browser console (F12) shows: `[Prompt Probe] sidebar tab registered "Prompt Library" v0.4.4`;
- A magnifier icon appears in the left sidebar icon rail; hovering shows `Prompt Library`.

## Usage

### 1. Probe (scan)

Open the sidebar tab, click **Rescan**. Each recognized prompt card shows: role (positive/negative), target encode node, status badge, character count, and a 3-line preview. The **status badge** tells you how trustworthy the text is:

- **Confirmed** — read statically from a widget or fully-traced link; safe to favorite.
- **Partially confirmed** — assembled from linked sources where at least one segment couldn't be read statically.
- **Candidate** — from an unregistered third-party text node; shown but flagged.
- **Runtime-generated** — the text is produced at run time (TextGenerate, StringFormat, etc.); static analysis can't read it.
- **Unconfirmed** — nothing readable.

Cards assembled from concat nodes have a **Segments (N)** block: expand it to see each segment (source node + input slot + full text) with its own **Copy** and **★ Favorite this segment** buttons. That's the fix for "my quality words and subject prompt got merged and I can only copy the whole blob".

### 2. Favorite a prompt

Click a card (or **★ Favorite**), pick a model category, add a title, save. Favorites live in `ComfyUI/user/default/prompt_library/library.json`, searchable by title and filterable by category.

### 3. Artist Strings

Third tab. **The string itself is the entry** — no name/remark fields. Optionally pick a reference image from your output history; on save the plugin compresses it to a ~1024px webp copy stored in `user/default/prompt_library/artists/`, so it survives output-folder cleanups. If the workflow recorded where the original lives, the lightbox shows the full-res original first and falls back to the copy when it's gone.

Each entry can also record a **main model** (from `diffusion_models`) — useful because the same artist string renders differently across fine-tunes.

### 4. LoRA Notes

Fourth tab. Click **Add**, pick a LoRA from the popup list (with a filter box), type the prompt that works with it. Each entry shows the LoRA name and the note, each with a one-click copy button. Nothing about your LoRA list is displayed until you click Add.

## Where data lives

Everything is stored under `ComfyUI/user/default/prompt_library/` via the official `/userdata` API:

- `library.json` — favorites
- `artists.json` + `artists/` — artist strings and reference-image copies
- `loras.json` — LoRA notes

Writes are atomic with a `.bak.json` backup; if the on-disk JSON is corrupt the panel refuses to write instead of clobbering it. Uninstalling the extension never deletes this folder.

## Known limitations

The panel marks these cases explicitly instead of guessing:

1. **Runtime-generated text** (TextGenerate, QwenImage21PromptEnhancerT8, StringFormat, RegexExtract, …) can't be read statically → labeled "runtime-generated".
2. **Switch paths driven by runtime nodes** → no final text is claimed; both branches are listed as candidates.
3. **Unregistered third-party text nodes** → a guess only when the node has exactly one text widget; otherwise "unconfirmed".
4. **Segment breakdown only works for registered concat nodes** (StringConcatenate family, JoinStringMulti, CR Combine Prompt). Text merged by StringFormat or custom runtime nodes shows merged only.
5. **Deep subgraphs** or unusual shapes may not be fully traced; it says so.
6. **Temp (preview) images** can be picked for reference, but ComfyUI cleans them up on restart — the saved 1024px copy in the data folder is the durable one.
7. **Model / LoRA names are not validated**: if you later delete or rename a model, the stored entry still shows the old name.
8. The probe scans the **current canvas state** — click Rescan after changing the workflow.

## Design constraints

- Pure frontend; read-only toward the workflow. No Python packages installed, no core files touched.
- Nothing is sent anywhere: no AI APIs, no telemetry, no network calls beyond your own ComfyUI server.
- Layout is tuned for the narrow sidebar (240–420px) and audited with real rendering at 240/300/312/420px.

## Development & self-tests

```bash
node web/tools/selftest.mjs           # ① resolver core: read-only parse of real workflow files
node web/tools/selftest_library.mjs   # ② favorites logic + panel interactions (in-memory)
node web/tools/selftest_storage.mjs   # ③ persistence: hits real /userdata, temp dir only (needs ComfyUI running)
node web/tools/selftest_artists.mjs   # ④ artist strings (in-memory)
node web/tools/selftest_loras.mjs     # ⑤ LoRA notes (in-memory)
```

316 assertions across the five suites (36+134+23+89+49). Interactions that depend on event bubbling can't be covered by the in-memory DOM shim — verify those in a real browser.

## Uninstall

1. Stop ComfyUI.
2. Delete `custom_nodes/ComfyUI-Prompt-Library/`.
3. Your data in `user/default/prompt_library/` is **not** deleted; remove that folder manually if you want it gone.

## License

MIT
