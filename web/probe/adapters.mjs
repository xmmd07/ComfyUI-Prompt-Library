/**
 * adapters.mjs —— 节点文本读取规则表（纯数据 + 纯函数，无 DOM、无 app 依赖）
 *
 * 设计目的：把"某类节点从哪里取文本、怎么取"集中在一个文件里，
 * 以后要适配新模型时，只需在本文件新增条目（或新增一个适配器块），
 * 不必改动 resolver / panel。
 */

/** 这些类型是"连线型"输入（不可能作为控件存在），用于把 object_info 的输入列表过滤成控件列表 */
export const SOCKET_TYPES = new Set([
  'CLIP', 'MODEL', 'VAE', 'IMAGE', 'LATENT', 'CONDITIONING', 'MASK', 'SIGMAS', 'NOISE',
  'GUIDER', 'SAMPLER', 'SCHEDULER', 'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'CONTROL_NET',
  'STYLE_MODEL', 'GLIGEN', 'UPSCALE_MODEL', 'AUDIO', 'VIDEO', 'WEBCAM', '3D', 'FILE_3D',
  'LIGHT', 'LATENT_UPSCALE', '*', 'COMBO', 'COMFY_AUTOGROW_V3', 'COMFY_MATCHTYPE_V3',
  'COMFY_DYNAMICCOMBO_V3', 'T8_LLM_PROVIDER_CONFIG', 'BASIC_PIPE', 'SAMPLER_CUSTOM'
]);

/** 采样链入口：节点上有这些输入口，就认为它是一条"采样链"（positive 指向文本编码结果） */
export const CHAIN_ROOT_INPUTS = ['positive'];
/** 中转输入口：有些采样器不直接吃 positive，而是先吃 guider（如 SamplerCustomAdvanced） */
export const CHAIN_HOP_INPUTS = ['guider'];
/** 沿 conditioning 向上游追踪时，允许穿过的输入口名 */
export const CONDUIT_INPUTS = ['conditioning', 'conditioning_1', 'positive', 'input', 'samples_and_conditioning'];

/**
 * 文本编码器（采样链的"目标节点"）：类名 → 保存文本的控件/输入口名列表。
 * 顺序即显示顺序；带 `role` 的字段用于标注正向/负向。
 */
export const ENCODER_FIELDS = {
  'CLIPTextEncode':                 ['text'],
  'CLIPTextEncodeControlnet':       ['text'],
  'CLIPTextEncodeSDXL':             ['text_g', 'text_l'],
  'CLIPTextEncodeSD3':              ['text'],
  'CLIPTextEncodeFlux':             ['clip_l', 't5xxl'],
  'CLIPTextEncodeFluxUnguided':     ['clip_l', 't5xxl'],
  'CLIPTextEncodeHiDream':          ['clip_l', 't5xxl', 'llama'],
  'CLIPTextEncodeHunyuanDiT':       ['clip_l', 'mt5xl'],
  'CLIPTextEncodeLumina2':          ['system_prompt', 'user_prompt'],
  'CLIPTextEncodePixArtAlpha':      ['text'],
  'CLIPTextEncodeKandinsky5':       ['clip_l', 'qwen25_7b'],
  'TextEncodeQwenImage21':          ['prompt', 'negative_prompt'],
  'TextEncodeQwenImageEdit':        ['prompt'],
  'TextEncodeQwenImageEditPlus':    ['prompt'],
  'TextEncodeKrea2OstrisEdit':      ['prompt'],
  'TextEncodeBooguEdit':            ['prompt'],
  'TextEncodeJoyImageEdit':         ['prompt'],
  'TextEncodeMageFlowEdit':         ['prompt'],
  'TextEncodeZImageOmni':           ['prompt'],
  'TextEncodeHunyuanVideo_ImageToVideo': ['prompt'],
  'TextEncodeAceStepAudio':         ['tags', 'lyrics'],
  'TextEncodeAceStepAudio1.5':      ['tags', 'lyrics'],
  'EditTextEncode_EditUtils':       ['prompt'],
  'QwenEditTextEncode_EditUtils':   ['prompt'],
  'Krea2EditTextEncode_EditUtils':  ['prompt'],
  'Flux2KleinEditTextEncode_EditUtils': ['prompt'],
  'BooguEditTextEncode_EditUtils':  ['prompt'],
  'WeiLinPromptUIWithoutLora':      ['positive'],
  'Power Prompt (rgthree)':         ['prompt'],
  'Power Prompt - Simple (rgthree)': ['prompt'],
  'SDXL Power Prompt - Positive (rgthree)': ['prompt_g', 'prompt_l'],
  'Krea2PromptWeight':              ['text'],
  'WanVideoTextEncode':             ['positive_prompt', 'negative_prompt'],
  'WanVideoTextEncodeSingle':       ['prompt'],
  'MiniMaxMusic3TextEncode':        ['prompt']
};

/** 类名里出现这些片段，就按"文本编码器"对待（通用兜底，会标注为通用规则命中） */
export const ENCODER_NAME_HINTS = ['textencode', 'cliptextencode'];

/**
 * 字符串生产者：类名 → 取文本的规则。
 * kind 取值：
 *   literal     —— 值就在某个控件里（field）
 *   passthrough —— 本身也是编码器，文本取自它的某个字段（field）
 *   join        —— 拼接 N 段（JoinStringMulti）
 *   concat      —— 拼接固定两段（StringConcatenate）
 *   switch      —— 条件分支（ComfySwitchNode）
 *   get         —— Set/Get 虚拟节点（GetNode）
 *   runtime     —— 运行期由模型生成，静态读不到
 *   unknown     —— 未登记，交给通用兜底
 */
export const PRODUCERS = {
  'PrimitiveString':          { kind: 'literal', field: 'value' },
  'PrimitiveStringMultiline': { kind: 'literal', field: 'value' },
  'StringConstant':           { kind: 'literal', field: 'string' },
  'StringConstantMultiline':  { kind: 'literal', field: 'string' },
  'CR Prompt Text':           { kind: 'literal', field: 'prompt' },
  'CR Prompt List':           { kind: 'literal', field: 'multiline_text' },
  'CR Combine Prompt':        { kind: 'concat', parts: ['part1', 'part2', 'part3', 'part4'], delim: 'separator' },
  'Power Prompt (rgthree)':   { kind: 'literal', field: 'prompt' },
  'Power Prompt - Simple (rgthree)': { kind: 'literal', field: 'prompt' },
  'WeiLinPromptUIWithoutLora': { kind: 'literal', field: 'positive' },
  'CLIPTextEncode':           { kind: 'passthrough', field: 'text' },
  'Krea2PromptWeight':        { kind: 'passthrough', field: 'text' },
  'JoinStringMulti':          { kind: 'join' },
  'JoinStrings':              { kind: 'join' },
  'StringConcatenate':        { kind: 'concat', parts: ['string_a', 'string_b'], delim: 'delimiter' },
  'StringConcatenate (Advanced)': { kind: 'concat', parts: ['string_a', 'string_b'], delim: 'delimiter' },
  'ComfySwitchNode':          { kind: 'switch' },
  'GetNode':                  { kind: 'get' },
  'TextGenerate':             { kind: 'runtime', why: '由 CLIP/LLM 在运行期生成' },
  'QwenImage21PromptEnhancerT8': { kind: 'runtime', why: '由提示词增强节点在运行期生成' },
  'QwenPERewriteT8':          { kind: 'runtime', why: '由提示词重写节点在运行期生成' },
  'MiniMaxH3PromptEnhancerT8': { kind: 'runtime', why: '由提示词增强节点在运行期生成' },
  'JsonExtractString':        { kind: 'runtime', why: '运行期从 JSON 中提取' },
  'StringFormat':             { kind: 'runtime', why: '运行期格式化' },
  'RegexExtract':             { kind: 'runtime', why: '运行期正则提取' }
};

/** Set/Get 虚拟节点的类名（前端虚拟节点，不在 /object_info 里） */
export const SET_CLASSES = ['SetNode', 'Set', 'SetNode (rgthree)', 'SetNode (KJNodes)'];
export const GET_CLASSES = ['GetNode', 'Get', 'GetNode (rgthree)', 'GetNode (KJNodes)'];

/** 判断某个类名是否应被当作"文本编码器（采样链目标）" */
export function isEncoderClass(cls, widgetNames) {
  if (!cls) return false;
  if (ENCODER_FIELDS[cls]) return true;
  // 已登记的"字符串生产者"（CR Prompt Text / PrimitiveString …）不算编码器
  if (PRODUCERS[cls]) return false;
  const lower = String(cls).toLowerCase();
  if (ENCODER_NAME_HINTS.some((h) => lower.includes(h))) return true;
  // 名字不像编码器时，只有明确带 prompt 控件的节点才认（避免误判）
  const wn = widgetNames || [];
  return lower.includes('prompt') && wn.includes('prompt');
}

/** 取编码器的文本字段；未登记则按控件名推断 */
export function encoderFields(cls, widgetNames) {
  if (ENCODER_FIELDS[cls]) return { fields: ENCODER_FIELDS[cls].slice(), generic: false };
  const wn = (widgetNames || []).filter((n) => ['prompt', 'text', 'text_g', 'text_l', 'positive', 'clip_l', 't5xxl', 'positive_prompt', 'negative_prompt'].includes(n));
  return { fields: wn, generic: true };
}

/** 取字符串生产者规则；未登记则返回 null（交给通用兜底） */
export function producerRule(cls) {
  return PRODUCERS[cls] || null;
}

/** 检测动态提示符（通配符），命中时实际执行文本可能与字面不同 */
export function wildcardNote(text) {
  const s = String(text || '');
  const notes = [];
  if (/\{[^{}\n]{1,200}\|[^{}\n]{0,200}\}/.test(s)) notes.push('含通配符 {a|b}，实际执行文本可能与显示不同');
  if (/__[A-Za-z0-9_\-]{1,64}__/.test(s)) notes.push('含通配符 __name__，实际执行文本可能与显示不同');
  if (/\[[^\[\]\n]{1,60}:[^\[\]\n]{1,20}\]/.test(s)) notes.push('含 (词:权重) 形式，属正常提示词权重语法');
  return notes;
}

/** 状态码 → 中文标签（面板与自测共用） */
export const MODE_TEXT = { 0: '正常', 1: '按事件', 2: '静音(mute)', 4: '绕过(bypass)' };
