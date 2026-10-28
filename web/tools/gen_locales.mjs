/**
 * gen_locales.mjs —— 从 JS 词典生成 `locales/<lang>/main.json`
 *
 * 为什么不手写 JSON：`/api/i18n` 只认 `custom_nodes/<插件>/locales/<lang>/*.json`，
 * 而前端在接口失败时必须能用内置词典兜底。两份文案只能有一个来源，
 * 否则必然漂移。所以：**JS 词典是唯一来源，JSON 是生成物**。
 *
 *   node web/tools/gen_locales.mjs          生成/覆盖 locales/en|zh/main.json
 *   node web/tools/gen_locales.mjs --check  只校验，不一致则退出码 1（CI/自测用）
 *
 * 生成结构为 `{ "promptLibrary": { ...词典... } }`——必须带命名空间，
 * 因为后端会把所有插件的 main.json 递归合并到同一个语言对象里（会撞键）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EN } from '../probe/i18n-en.mjs';
import { ZH } from '../probe/i18n-zh.mjs';
import { NS } from '../probe/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const DICTS = { en: EN, zh: ZH };

function payload(dict) {
  return { [NS]: dict };
}

export function buildAll() {
  const out = {};
  for (const [lang, dict] of Object.entries(DICTS)) {
    out[lang] = JSON.stringify(payload(dict), null, 2) + '\n';
  }
  return out;
}

function targetPath(lang) {
  return path.join(ROOT, 'locales', lang, 'main.json');
}

export function checkAll() {
  const built = buildAll();
  const drifted = [];
  for (const [lang, text] of Object.entries(built)) {
    const file = targetPath(lang);
    let onDisk = null;
    try { onDisk = fs.readFileSync(file, 'utf8'); } catch (e) { onDisk = null; }
    if (onDisk !== text) drifted.push(lang);
  }
  return drifted;
}

function main() {
  const check = process.argv.includes('--check');
  const built = buildAll();
  if (check) {
    const drifted = [];
    for (const [lang, text] of Object.entries(built)) {
      const file = targetPath(lang);
      let onDisk = null;
      try { onDisk = fs.readFileSync(file, 'utf8'); } catch (e) { onDisk = null; }
      if (onDisk !== text) drifted.push(path.relative(ROOT, file) || lang);
    }
    if (drifted.length) {
      console.error(`[gen_locales] 以下文件与 JS 词典不一致，请重新生成：\n  ${drifted.join('\n  ')}`);
      process.exit(1);
    }
    console.log('[gen_locales] OK：locales/*/main.json 与词典一致');
    return;
  }
  for (const [lang, text] of Object.entries(built)) {
    const file = targetPath(lang);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    console.log(`[gen_locales] wrote ${path.relative(ROOT, file)} (${text.length} bytes)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
