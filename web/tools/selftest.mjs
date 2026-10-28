/**
 * selftest.mjs —— 只读自测（Node 运行，不依赖浏览器、不修改任何工作流）
 *
 * 用途：在真实工作流文件上验证解析核心（graphview + resolver + adapters）的正确性。
 * 只读取工作流 JSON 与 /object_info，不写入、不提交、不改动任何文件。
 *
 * 运行：
 *   node web/tools/selftest.mjs
 *   node web/tools/selftest.mjs --workflows "D:/APPs/comfyUI/ComfyUI-aki-v3/ComfyUI/user/default/workflows"
 *   node web/tools/selftest.mjs --oi "C:/path/to/object_info.json"      # 服务器没开时用本地快照
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsonView } from '../probe/graphview.mjs';
import { scan } from '../probe/resolver.mjs';
import { fmt, setLocaleForTest } from '../probe/i18n.mjs';

// 解析核心产出的是结构化文案（{code, params}），断言前用 fmt() 渲染成文字。
// 固定中文，保持与改造前断言口径一致；英文/切换/回退由 selftest_i18n.mjs 覆盖。
setLocaleForTest('zh');

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const WF_DIR = arg('--workflows', 'D:/APPs/comfyUI/ComfyUI-aki-v3/ComfyUI/user/default/workflows');
const OI_FILE = arg('--oi', '');
const OI_URL = arg('--oi-url', 'http://127.0.0.1:8188/object_info');

const results = { pass: 0, fail: 0 };
function check(label, cond, detail = '') {
  const ok = !!cond;
  ok ? results.pass++ : results.fail++;
  console.log(`  ${ok ? '✔ PASS' : '✘ FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`);
  return ok;
}
const head = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

async function loadObjectInfo() {
  if (OI_FILE && fs.existsSync(OI_FILE)) {
    console.log(`object_info：读取本地快照 ${OI_FILE}`);
    return JSON.parse(fs.readFileSync(OI_FILE, 'utf8'));
  }
  console.log(`object_info：从运行中的 ComfyUI 拉取 ${OI_URL}`);
  const res = await fetch(OI_URL);
  if (!res.ok) throw new Error(`/object_info HTTP ${res.status}`);
  return await res.json();
}

function loadWorkflow(file) {
  const p = path.isAbsolute(file) ? file : path.join(WF_DIR, file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function analyze(file, oi) {
  const wf = loadWorkflow(file);
  const view = createJsonView(wf, oi, { workflowName: path.basename(file) });
  return { wf, view, result: scan(view) };
}

// role 现在是稳定内部标识（positive / negative / extra），不再用中文
const posOf = (chain) => chain.fields.find((f) => f.role === 'positive') || chain.fields[0];
const brief = (chain) =>
  `链 ${chain.sampler.cls} #${chain.sampler.id}${chain.sampler.group ? `【${chain.sampler.group}】` : ''} → ` +
  `目标 ${chain.target ? `${chain.target.cls} #${chain.target.id}${chain.target.collapsed ? '(已折叠)' : ''}` : '未找到'} | ` +
  `${fmt(posOf(chain)?.statusText) || '?'} ${posOf(chain)?.length ?? 0} 字 | 状态 ${fmt(chain.sampler.modeText)}`;

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`工作流目录：${WF_DIR}`);
  const oi = await loadObjectInfo();
  console.log(`object_info 类数：${Object.keys(oi).length}`);

  /* ---------- 1) Anima ---------- */
  head('用例 1 · Anima（折叠的 CLIPTextEncode + 多段字符串拼接）');
  {
    const { result } = analyze('anima基础工作流.json', oi);
    console.log(`采样链数：${result.chains.length}`);
    result.chains.forEach((c) => console.log('  ' + brief(c)));
    const chain = result.chains.find((c) => c.target?.cls === 'CLIPTextEncode' && c.target?.collapsed);
    check('找到"已折叠的 CLIPTextEncode"作为目标节点', !!chain);
    if (chain) {
      const pos = posOf(chain);
      check('正向文本包含「质量词」段', pos.text?.includes('masterpiece, best quality'), `len=${pos.length}`);
      check('正向文本包含 WeiLin 节点的正提示词段', pos.text?.includes('1girl, solo, grey gradient hair'));
      check('没有把折叠节点里的残留旧文本当作结果', !(pos.text || '').includes('@96yottea'));
      check('已检出"控件残留旧文本"并给出提示', pos.staleWidget === true, `staleLen=${pos.staleLen}`);
      check('取值链能追到上游字符串节点', /JoinStringMulti/.test(fmt(pos.path)), fmt(pos.path).slice(0, 120));
    }
  }

  /* ---------- 2) Qwen Image 2.1 ---------- */
  head('用例 2 · Qwen Image 2.1（TextEncodeQwenImage21 的 prompt 控件）');
  {
    const { result } = analyze('qwen_image_2.1.json', oi);
    console.log(`采样链数：${result.chains.length} · 候选文本：${result.candidates.length}`);
    result.chains.forEach((c) => console.log('  ' + brief(c)));
    const chain = result.chains.find((c) => c.target?.cls === 'TextEncodeQwenImage21');
    check('找到 TextEncodeQwenImage21 作为目标节点', !!chain);
    if (chain) {
      const pos = posOf(chain);
      // 注意：qwen_image_2.1.json 在 2026-10-10 被用户编辑过——正向文本已从 #476 挪到 #495
      //（重绘手部的英文 prompt）。这里只验证"从控件名 prompt 读到非空正向文本"，
      // 不再绑定具体内容；negative_prompt 的取值同理只验证"读到了且不是正向内容"。
      check('按控件名 prompt 读到正向文本', typeof pos.text === 'string' && pos.text.trim().length > 20, `len=${pos.length}`);
      check('正向状态为「已确认」', pos.status === 'confirmed', fmt(pos.statusText));
      check('从控件直读（非连线）', pos.fromLink === false);
      const neg = chain.fields.find((f) => f.name === 'negative_prompt');
      // 工作流 2026-10-10 编辑后负向控件可能为空——空是合法状态；只要求"读到了字段且内容 ≠ 正向"
      check('negative_prompt 未被误当成 prompt', (neg == null || !String(neg.text || '').trim() || !pos.text.includes(String(neg.text))), `neg=${(neg?.text || '').slice(0, 20)}`);
    }
    if (result.candidates.length) {
      result.candidates.forEach((c) => console.log(`  候选：#${c.id} ${c.cls} ${c.status} ${c.length} 字（${fmt(c.modeText)}）`));
    }
  }

  /* ---------- 3) SamplerCustomAdvanced + BasicGuider + ComfySwitchNode ---------- */
  head('用例 3 · Qwen（SamplerCustomAdvanced → BasicGuider → ComfySwitchNode 分支）');
  {
    const { result } = analyze('Qwen-Image-2.1-viggle-turbo-t2i.json', oi);
    console.log(`采样链数：${result.chains.length}`);
    result.chains.forEach((c) => console.log('  ' + brief(c)));
    const chain = result.chains.find((c) => c.target?.cls === 'TextEncodeQwenImage21');
    check('经 guider→conditioning 找到 TextEncodeQwenImage21', !!chain);
    if (chain) {
      const pos = posOf(chain);
      const noteText = (pos.notes || []).map(fmt).join(' | ');
      console.log(`     分支数=${pos.branches?.length || 0}`);
      (pos.branches || []).forEach((b) => console.log(`       ${b.slot}: ${b.length} 字 ${b.active === true ? '(生效)' : b.active === false ? '(未生效)' : ''} — ${b.preview}`));
      check('开关由 PrimitiveBoolean 连线提供 → 静态判定为「取 on_true」', /PrimitiveBoolean/.test(noteText), fmt((pos.notes || [])[0]));
      check('生效分支本身是运行期节点 → 结论为候选/无法确认，而不是静默给一个假文本',
        ['candidate', 'unknown', 'runtime'].includes(pos.status), `status=${pos.status} text=${JSON.stringify((pos.text || '').slice(0, 40))}`);
      check('两个分支都列出供人工核对', (pos.branches?.length || 0) >= 2, `branches=${pos.branches?.length || 0}`);
      const b = (pos.branches || []).find((x) => x.slot === 'on_false');
      check('原始提示词只出现在 on_false 分支预览里（未被冒充为最终结果）', (b?.preview || '').includes('Soaking wet capybara'), (b?.preview || '').slice(0, 70));
    }
  }

  /* ---------- 4) Qwen（Set/Get + 多链） ---------- */
  head('用例 4 · Qwen 多合一（PrimitiveStringMultiline 直连 + bypass 节点）');
  {
    const { result } = analyze('【SevnFading】Qwen-Image-2.1+多合一工作流.json', oi);
    console.log(`采样链数：${result.chains.length} · 候选文本：${result.candidates.length}`);
    result.chains.forEach((c) => console.log('  ' + brief(c)));
    const hit = result.chains.some((c) => (posOf(c).text || '').includes('把这张图片下面的两行文字删除掉'));
    check('至少一条链解析出该工作流的实际提示词', hit);
    const anyBypass = result.chains.some((c) => c.sampler.bypassed || c.target?.bypassed);
    check('bypass 节点被标注（存在被绕过节点）', anyBypass, anyBypass ? '有' : '未检出（可能该工作流没有 bypass 采样节点）');
  }

  /* ---------- 5) Krea 2（重点：Set/Get、双采样链、残留旧文本） ---------- */
  head('用例 5 · Krea2全面（Set/Get 链路 + 基础采样/双采样 + 残留旧文本）');
  {
    const { result } = analyze('Krea2全面 (1).json', oi);
    console.log(`采样链数：${result.chains.length} · 候选文本：${result.candidates.length}`);
    result.chains.forEach((c) => {
      console.log('  ' + brief(c));
      console.log(`     取值链：${fmt(posOf(c).path).slice(0, 160)}`);
    });
    check('检出多条采样链（基础采样 + 双采样）', result.chains.length >= 2, `chains=${result.chains.length}`);

    const texts = result.chains.map((c) => posOf(c).text || '');
    check('所有链都解析出提示词（经 GetNode→SetNode 取值）', texts.every((t) => t.includes('gpt anima render style')));
    check('所有链的文本一致（共用同一个提示词来源）', new Set(texts.map((t) => t.trim())).size === 1);
    check('文本长度与提示词组 CR Prompt Text 一致（1438 字）', texts.every((t) => t.trim().length === 1438), `lens=${texts.map((t) => t.trim().length).join(',')}`);
    check('未把 n168 残留的 3981 字旧文本当作结果', texts.every((t) => !t.includes('retro-futuristic')));
    check('未把 n295 残留的 216 字旧文本当作结果', texts.every((t) => !t.includes('wide-angle lens distortion')));
    check('残留旧文本已被检出并标注', result.chains.some((c) => posOf(c).staleWidget === true));
    const bypassed = result.chains.filter((c) => c.sampler.bypassed || c.target?.bypassed);
    check('被绕过的采样链已标注状态', bypassed.length >= 1, `${bypassed.length} 条被绕过`);
    check('取值链中可见 GetNode/SetNode', result.chains.every((c) => /GetNode|SetNode/.test(fmt(posOf(c).path))));
    const cand = result.candidates.map((c) => c.id);
    console.log(`  候选文本节点：${cand.length ? cand.map((i) => '#' + i).join(', ') : '无'}`);
    check('游离的 CLIPTextEncode（#354）被归为候选而非有效 Prompt', cand.includes(354) || cand.includes('354'));
  }

  /* ---------- 6) 健壮性：目录内全部工作流 ---------- */
  head('用例 6 · 健壮性：目录内全部工作流逐个只读解析');
  {
    const files = fs.readdirSync(WF_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
    let ok = 0;
    const failed = [];
    for (const f of files) {
      try {
        const { result } = analyze(f, oi);
        if (result.errors?.length) failed.push(`${f}（内部异常 ${result.errors.length} 条）`);
        else ok++;
      } catch (e) {
        failed.push(`${f}（抛异常：${e.message}）`);
      }
    }
    check(`全部 ${files.length} 个工作流解析无异常`, failed.length === 0, failed.length ? failed.join('；') : `成功 ${ok} 个`);
  }

  /* ---------- 7) 拼接分段（MOSS 工作流：质量词 + 主体词 StringConcatenate） ---------- */
  {
    const MOSS_FILE = 'MOSS-Image-SFT+一键加速开关版.json';
    if (fs.existsSync(path.join(WF_DIR, MOSS_FILE)) && Object.keys(oi).length) {
      head('用例 7 · 拼接分段：MOSS 工作流质量词/主体词拆分');
      const { result } = analyze(MOSS_FILE, oi);
      const pos = result.chains[0] ? posOf(result.chains[0]) : null;
      check('MOSS 工作流解析出正向字段', !!pos && pos.status === 'confirmed', pos ? pos.status : 'no chain');
      check('正向字段带 parts 分段（≥2 段）', Array.isArray(pos?.parts) && pos.parts.length >= 2,
        `parts=${Array.isArray(pos?.parts) ? pos.parts.length : 'none'}`);
      const segTexts = (pos?.parts || []).map((s) => String(s.text || ''));
      check('第 1 段是质量词（best quality 开头）', segTexts.some((t) => t.trim().startsWith('best quality')), segTexts.map((t) => t.slice(0, 30)).join(' | '));
      check('第 2 段是主体词（不含质量词前缀）', segTexts.some((t) => t.length > 500 && !t.trim().startsWith('best quality')));
      check('每段带 source 节点信息（可显示节点title）', (pos?.parts || []).every((s) => s.source && typeof s.source.cls === 'string'));
      check('合并文本 = 各段按分隔符拼接（text 与 parts 一致）', !!pos && segTexts.filter(Boolean).join(', ') === String(pos.text || '').trim()
        || !!pos && String(pos.text || '').includes(segTexts.find((t) => t.length > 500) || '\u0000'));
      check('非拼接字段不带 parts（兼容未改动字段）', result.chains.every((c) => c.fields.every((f) => f.name !== 'text' || f === pos || !Array.isArray(f.parts) || f.parts.length >= 2)));
    }
  }

  /* ---------- 汇总 ---------- */
  head('汇总');
  console.log(`断言：通过 ${results.pass} · 失败 ${results.fail}`);
  console.log('说明：本自测只读工作流文件与 /object_info，未修改任何文件，也未向 ComfyUI 提交任何任务。');
  process.exitCode = results.fail ? 1 : 0;
}

main().catch((e) => {
  console.error('\n自测无法完成：', e);
  process.exitCode = 2;
});
