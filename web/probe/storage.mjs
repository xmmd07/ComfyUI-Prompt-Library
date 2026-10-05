/**
 * storage.mjs —— 收藏库的持久化层（走 ComfyUI 官方 /userdata API）
 *
 * 为什么用 /userdata 而不是插件目录：
 *   · 存放位置是 ComfyUI\user\default\prompt_library\ —— 独立于插件代码目录；
 *   · 更新/卸载插件（删除插件目录）不会带走收藏数据；
 *   · 写入由后端完成：临时文件 + os.replace 原子替换（app/user_manager.py），
 *     前端中断/断电不会写出"半截 JSON"。
 *
 * 额外做的安全措施：
 *   1. 每次保存前把上一版内容复制到 library.bak.json（一份回滚备份）；
 *   2. 保存前重新读取磁盘版本，若磁盘更新则按 id 合并（多标签页/重复打开不丢数据）；
 *   3. 文件损坏（JSON 解析失败）时**拒绝写入**，返回 corrupt 状态交给界面处理；
 *   4. 同一浏览器的并发保存用 Web Locks 串行化（不支持时退化为顺序执行）。
 */

import { emptyLibrary, normalizeLibrary, mergeLibraries, bumpRev } from './library.mjs';

const DEFAULT_DIR = 'prompt_library';
const FILE_MAIN = 'library.json';
const FILE_BACKUP = 'library.bak.json';

export function makeStorage(api, opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const lockName = opts.lockName || 'prompt-library-save';
  // 注意：官方 /userdata/{file} 的 {file} 是"单段路径"，必须把整条相对路径（含 /）一起 URL 编码，
  // 否则 aiohttp 路由匹配不到 → 405。前端自身（api.storeUserData / getUserData）也是这么做的。
  const url = (name) => `/userdata/${encodeURIComponent(`${dir}/${name}`)}`;

  async function readRaw(name) {
    const res = await api.fetchApi(url(name), { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`读取 ${name} 失败：HTTP ${res.status}`);
    return await res.text();
  }

  async function writeRaw(name, text) {
    const res = await api.fetchApi(url(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text
    });
    if (!res.ok) throw new Error(`写入 ${name} 失败：HTTP ${res.status} ${await safeText(res)}`);
    return true;
  }

  async function safeText(res) {
    try {
      return (await res.text()).slice(0, 200);
    } catch (e) {
      return '';
    }
  }

  async function withLock(fn) {
    const locks = globalThis.navigator?.locks;
    if (locks?.request) {
      try {
        return await locks.request(lockName, fn);
      } catch (e) {
        // Web Locks 不可用时退化为直接执行
      }
    }
    return await fn();
  }

  /**
   * 载入收藏库
   * @returns {{state:'ok'|'missing'|'corrupt', library?, raw?, error?}}
   */
  async function load() {
    let raw = null;
    try {
      raw = await readRaw(FILE_MAIN);
    } catch (e) {
      return { state: 'corrupt', raw: null, error: String(e) };
    }
    if (raw == null || raw.trim() === '') {
      return { state: 'missing', library: emptyLibrary() };
    }
    try {
      const parsed = JSON.parse(raw);
      return { state: 'ok', library: normalizeLibrary(parsed), raw };
    } catch (e) {
      return { state: 'corrupt', raw, error: `收藏库文件不是合法 JSON：${e.message}` };
    }
  }

  /**
   * 保存收藏库（含备份 + 磁盘版本合并）
   * @returns {{library, merged, backup:boolean}}
   */
  async function save(library) {
    return await withLock(async () => {
      // 1) 先看磁盘现状
      let diskRaw = null;
      let diskLib = null;
      let diskParsed = true;
      try {
        diskRaw = await readRaw(FILE_MAIN);
        if (diskRaw && diskRaw.trim()) {
          diskLib = normalizeLibrary(JSON.parse(diskRaw));
        }
      } catch (e) {
        diskParsed = false;   // 磁盘内容不可解析
        diskLib = null;
      }

      // 1b) 磁盘文件损坏时**拒绝写入**，避免把用户数据覆盖掉
      //     （界面会提供"导出原始内容 / 另存损坏文件并重建空库"两个用户确认的操作）
      if (diskRaw && diskRaw.trim() && !diskParsed) {
        throw new Error('磁盘上的收藏库文件不是合法 JSON，为避免覆盖已停止写入；请先用面板上的「导出原始内容」或「另存损坏文件并重建空库」处理');
      }

      // 2) 磁盘更新则合并，避免覆盖别的标签页刚写的内容
      let merged = false;
      let next = normalizeLibrary(library);
      if (diskLib && diskLib.rev > next.rev) {
        next = mergeLibraries(next, diskLib);
        merged = true;
      }

      // 3) 备份上一版（尽力而为，失败不阻断保存）
      let backupOk = false;
      if (diskRaw && diskRaw.trim()) {
        try {
          await writeRaw(FILE_BACKUP, diskRaw);
          backupOk = true;
        } catch (e) {
          backupOk = false;
        }
      }

      // 4) 写入新版本（后端原子替换）
      const withRev = bumpRev(next);
      await writeRaw(FILE_MAIN, JSON.stringify(withRev, null, 2));
      return { library: withRev, merged, backup: backupOk };
    });
  }

  /** 载入时的原始文本（用于"损坏时导出"） */
  async function rawContent() {
    try {
      return await readRaw(FILE_MAIN);
    } catch (e) {
      return null;
    }
  }

  /** 把损坏内容另存为一个带时间戳的文件（用户确认后调用，绝不自动执行） */
  async function quarantineBroken(raw) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `library.broken.${stamp}.json`;
    await writeRaw(name, raw ?? '');
    return name;
  }

  /** 用空库覆盖主文件（用户二次确认后调用） */
  async function resetToEmpty() {
    const fresh = bumpRev(emptyLibrary());
    await writeRaw(FILE_MAIN, JSON.stringify(fresh, null, 2));
    return fresh;
  }

  return {
    dir,
    paths: { main: url(FILE_MAIN), backup: url(FILE_BACKUP), human: `ComfyUI\\user\\default\\${dir}\\${FILE_MAIN}` },
    load,
    save,
    rawContent,
    quarantineBroken,
    resetToEmpty
  };
}
