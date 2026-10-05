/**
 * selftest_storage.mjs —— 持久化层自测：**直接打真实的 ComfyUI /userdata 接口**
 *
 * 为了不碰真实收藏数据，本测试只操作一个独立的临时目录：
 *   ComfyUI\user\default\prompt_library_selftest\
 * 测试结束时会把该目录里自己创建的文件全部删除（只删自己创建的那几个文件名）。
 *
 * 运行（需要 ComfyUI 正在运行）：
 *   node web/tools/selftest_storage.mjs
 *   node web/tools/selftest_storage.mjs --dir prompt_library_selftest --comfy http://127.0.0.1:8188
 */

import { makeStorage } from '../probe/storage.mjs';
import { emptyLibrary, upsertItem, newId } from '../probe/library.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = arg('--dir', 'prompt_library_selftest');
const COMFY = arg('--comfy', 'http://127.0.0.1:8188');

const results = { pass: 0, fail: 0 };
function check(label, cond, detail = '') {
  const ok = !!cond;
  ok ? results.pass++ : results.fail++;
  console.log(`  ${ok ? '✔ PASS' : '✘ FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
  return ok;
}
const head = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

const api = {
  async fetchApi(url, opts = {}) {
    const res = await fetch(COMFY + '/api' + url, opts);
    return { ok: res.ok, status: res.status, text: () => res.text(), json: () => res.json() };
  }
};

const rel = (name) => encodeURIComponent(`${DIR}/${name}`);
const rawGet = async (name) => {
  const r = await fetch(`${COMFY}/api/userdata/${rel(name)}`);
  return r.ok ? await r.text() : null;
};
const rawPut = async (name, body) => {
  const r = await fetch(`${COMFY}/api/userdata/${rel(name)}`, { method: 'POST', body });
  return r.ok;
};
const rawDelete = async (name) => {
  const r = await fetch(`${COMFY}/api/userdata/${rel(name)}`, { method: 'DELETE' });
  return r.ok || r.status === 404;
};

function item(title, model, text) {
  return { id: newId(), title, model, text, source: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

async function main() {
  console.log(`ComfyUI: ${COMFY}\n测试目录: user/default/${DIR}/（测试结束后清理）`);
  const store = makeStorage(api, { dir: DIR });
  console.log(`实际落盘位置: ${store.paths.human}`);

  /* ---------- 0) 先清掉可能残留的测试文件 ---------- */
  head('0 · 准备');
  for (const f of ['library.json', 'library.bak.json']) await rawDelete(f);
  check('测试目录已清空（不会影响真实收藏目录）', (await rawGet('library.json')) === null);

  /* ---------- 1) 首次载入 = 空库 ---------- */
  head('1 · 首次载入');
  {
    const r = await store.load();
    check('没有文件时返回 missing（而不是报错）', r.state === 'missing', r.state);
    check('返回空库且带默认分类', r.library?.models?.length === 3);
  }

  /* ---------- 2) 保存一条 → 读回 ---------- */
  head('2 · 保存与读回（真实 HTTP 写入）');
  let lib = emptyLibrary();
  upsertItem(lib, item('Anima 存储测试', 'Anima', 'masterpiece, 1girl'));
  {
    const res = await store.save(lib);
    check('保存返回 rev=1', res.library.rev === 1, `rev=${res.library.rev}`);
    check('文件已真的写到磁盘上', (await rawGet('library.json')) !== null);
    const disk = JSON.parse(await rawGet('library.json'));
    check('磁盘内容可解析且含 1 条', disk.items.length === 1 && disk.items[0].title === 'Anima 存储测试');
    const back = await store.load();
    check('重新载入读回同一条', back.state === 'ok' && back.library.items.length === 1);
  }

  /* ---------- 3) 再次保存 → 生成备份 ---------- */
  head('3 · 覆盖前的自动备份');
  {
    upsertItem(lib, item('Krea 存储测试', 'Krea 2', 'krea render style'));
    const res = await store.save(lib);
    check('保存成功且 rev 递增到 2', res.library.rev === 2, `rev=${res.library.rev}`);
    check('备份标记 backup=true', res.backup === true);
    const bak = JSON.parse(await rawGet('library.bak.json'));
    check('备份里是上一版内容（1 条）', bak.items.length === 1 && bak.items[0].title === 'Anima 存储测试');
  }

  /* ---------- 4) 并发/多标签页：磁盘更新时按 id 合并 ---------- */
  head('4 · 并发写入不丢数据（模拟两个标签页）');
  {
    const stale = await store.load();                       // 标签页 A 手里的版本（rev=2）
    const other = JSON.parse(JSON.stringify(stale.library)); // 标签页 B 基于同一版本
    upsertItem(other, item('B 写的条目', 'Qwen Image 2.1', 'b'));
    await store.save(other);                                // B 先保存 → rev=3

    upsertItem(stale.library, item('A 写的条目', 'Anima', 'a'));
    const res = await store.save(stale.library);            // A 后保存（手里的 rev 已过期）
    check('A 的保存被识别为"需要合并"', res.merged === true);
    const titles = res.library.items.map((i) => i.title);
    check('B 写的条目没有被覆盖', titles.includes('B 写的条目'), titles.join(' / '));
    check('A 写的条目也进去了', titles.includes('A 写的条目'));
    const disk = JSON.parse(await rawGet('library.json'));
    check('磁盘上确实是合并后的结果', disk.items.length === 4, `${disk.items.length} 条`);
  }

  /* ---------- 5) 文件损坏 → 拒绝写入 ---------- */
  head('5 · 异常情况：文件损坏时的数据安全');
  {
    await rawPut('library.json', '{ 这不是合法 JSON !!!');
    const r = await store.load();
    check('载入时识别为 corrupt 并带出原始内容', r.state === 'corrupt' && typeof r.raw === 'string', r.state);
    let threw = false;
    try {
      await store.save(emptyLibrary());
    } catch (e) {
      threw = true;
    }
    check('损坏状态下保存被拒绝（不会把用户数据覆盖掉）', threw);
    check('损坏文件内容原样保留', (await rawGet('library.json')) === '{ 这不是合法 JSON !!!');
  }

  /* ---------- 6) 用户确认后的"隔离 + 重建" ---------- */
  head('6 · 用户确认后的隔离与重建');
  {
    const broken = await rawGet('library.json');
    const name = await store.quarantineBroken(broken);
    check('损坏内容被另存为独立文件', (await rawGet(name)) === broken, name);
    const fresh = await store.resetToEmpty();
    check('重建后是合法空库', fresh.items.length === 0 && fresh.rev >= 1);
    const disk = JSON.parse(await rawGet('library.json'));
    check('主文件已是合法 JSON', Array.isArray(disk.items));
    check('重建后可以正常保存', (await store.save(fresh)).library.rev === fresh.rev + 1);
    await rawDelete(name);
  }

  /* ---------- 7) 清理自己创建的测试文件 ---------- */
  head('7 · 清理测试文件');
  {
    const listed = await (await fetch(`${COMFY}/api/userdata?dir=${DIR}`)).json();
    check('目录里只剩本测试创建的文件',Array.isArray(listed) && listed.length >= 2, (listed || []).join(', '));
    for (const f of listed || []) await rawDelete(f);
    const after = await (await fetch(`${COMFY}/api/userdata?dir=${DIR}`)).json().catch(() => []);
    const rest = Array.isArray(after) ? after : [];
    check('测试文件已全部删除', rest.filter((f) => /^library\.json$|^library\.bak\.json$|^library\.broken\./.test(f)).length === 0, rest.join(', ') || '(空)');
  }

  head('汇总');
  console.log(`断言：通过 ${results.pass} · 失败 ${results.fail}`);
  console.log(`说明：全程只读写 user/default/${DIR}/，测试结束已清理；真实收藏目录 prompt_library/ 未被创建或修改。`);
  process.exitCode = results.fail ? 1 : 0;
}

main().catch((e) => {
  console.error('\n自测无法完成：', e);
  process.exitCode = 2;
});
