/**
 * minidom.mjs —— 极简 DOM 垫片（仅供 Node 自测使用，不参与插件运行）
 *
 * 目的：在没有浏览器的情况下，把 panel.mjs / favorites.mjs 的渲染与交互逻辑真实跑一遍，
 * 并对渲染出来的 DOM 做断言。只实现这些模块实际用到的那部分 API。
 */

class ClassList {
  constructor(el) { this.el = el; }
  get _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  _apply(s) { this.el.className = [...s].join(' '); }
  add(...c) { const s = this._set; c.forEach((x) => s.add(x)); this._apply(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._apply(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const s = this._set;
    const has = s.has(c);
    const want = force === undefined ? !has : !!force;
    if (want) s.add(c); else s.delete(c);
    this._apply(s);
    return want;
  }
}

class TextNode {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.id = '';
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.value = '';
    this.listeners = {};
    this.classList = new ClassList(this);
  }

  get childNodes() { return this.children; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) { return this.attributes[name] ?? null; }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, ev = {}) {
    const event = { type, stopPropagation() {}, preventDefault() {}, ...ev };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }

  click() { return this.dispatch('click'); }
  select() {}
  focus() {}
  blur() {}

  get textContent() {
    let out = '';
    for (const c of this.children) out += c.textContent;
    return out;
  }

  set textContent(v) {
    this.children = [];
    if (v !== '' && v != null) this.appendChild(new TextNode(v));
  }

  get innerText() { return this.textContent; }

  /* ---- 选择器（仅支持 tag / .class / #id，以及用空格表示的"后代"） ---- */
  _matches(token) {
    if (token === '*') return true;
    const parts = token.split(/(?=[.#])/).filter(Boolean);
    for (const p of parts) {
      if (p.startsWith('.')) { if (!this.classList.contains(p.slice(1))) return false; }
      else if (p.startsWith('#')) { if (this.id !== p.slice(1)) return false; }
      else if (this.tagName !== p.toUpperCase()) return false;
    }
    return true;
  }

  _all(acc = []) {
    for (const c of this.children) {
      if (c.nodeType === 1) { acc.push(c); c._all(acc); }
    }
    return acc;
  }

  querySelectorAll(selector) {
    const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const g of groups) {
      const chain = g.split(/\s+/).filter(Boolean);
      let pool = this._all();
      let matched = [];
      for (let i = 0; i < chain.length; i++) {
        matched = pool.filter((el) => el._matches(chain[i]));
        if (i === chain.length - 1) break;
        pool = matched.flatMap((el) => el._all());
      }
      for (const m of matched) if (!out.includes(m)) out.push(m);
    }
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class Document {
  constructor() {
    this.head = new Element('head');
    this.body = new Element('body');
  }
  createElement(tag) { return new Element(tag); }
  createTextNode(text) { return new TextNode(text); }
  getElementById(id) {
    return this.body.querySelectorAll(`#${id}`)[0] || this.head.querySelectorAll(`#${id}`)[0] || null;
  }
  querySelector(sel) { return this.body.querySelector(sel) || this.head.querySelector(sel); }
  querySelectorAll(sel) { return [...this.head.querySelectorAll(sel), ...this.body.querySelectorAll(sel)]; }
}

/** 安装到全局，并返回可清理的还原函数 */
export function installMinidom() {
  const prev = {
    document: globalThis.document,
    navigator: globalThis.navigator,
    URL: globalThis.URL
  };
  const doc = new Document();
  globalThis.document = doc;
  const copied = [];
  const nav = { clipboard: { writeText: async (t) => { copied.push(String(t)); } } };
  try {
    // Node 21+ 自带只读的 navigator，这里整体替换成垫片
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  } catch (e) {
    globalThis.navigator = nav;
  }
  // 让"下载导出"在 Node 里安全退化（URL.createObjectURL 不存在）
  globalThis.URL = globalThis.URL || {};
  return {
    document: doc,
    copied,
    restore() {
      globalThis.document = prev.document;
      if (prev.navigator === undefined) delete globalThis.navigator;
      else globalThis.navigator = prev.navigator;
    }
  };
}

export { Element, TextNode, Document };
