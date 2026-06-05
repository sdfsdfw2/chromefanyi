(function () {
  'use strict';

  // ─── 防重复注入 ─────────────────────────────────────────────────────────────
  if (window.__wuTranslatorLoaded) return;
  window.__wuTranslatorLoaded = true;

  // ─── 常量 ───────────────────────────────────────────────────────────────────
  const EXCLUDED_TAGS = new Set([
    'SCRIPT','STYLE','SVG','PATH','TEXTAREA','INPUT','SELECT',
    'OPTION','CODE','PRE','SAMP','CANVAS','VIDEO','AUDIO',
    'NOSCRIPT','IFRAME','OBJECT','EMBED','HEAD','META','LINK',
  ]);
  const CODE_CLASS_RE = /code|syntax|hljs|language-|chroma|highlight|linenumbers|line-numbers/i;
  const ATTR_KEYS     = ['title','placeholder','aria-label','alt'];
  const RE_MODEL_ID   = /^[a-z0-9_-]+\/[a-z0-9_.:-]+$/i;
  const RE_URL        = /^https?:\/\//i;
  const RE_CODE_KW    = /^(import|export|const|let|var|function|class|return|if|else|for|while|switch|try|catch|throw|async|await|console)\b/;
  const RE_PURE_NUM   = /^[\d,.%\s\-+/]+$/;

  const LANG_MAP = {
    'auto':'Auto','zh-CN':'Simplified Chinese','zh-TW':'Traditional Chinese',
    'en':'English','ja':'Japanese','ko':'Korean','fr':'French','de':'German',
    'es':'Spanish','ru':'Russian','it':'Italian','pt':'Portuguese',
    'ar':'Arabic','th':'Thai','vi':'Vietnamese','id':'Indonesian',
  };

  // ─── 翻译缓存（原文 → 译文）————这是解决虚拟滚动还原的关键──────────────────
  // 用 Map 而非 WeakMap，因为 key 是字符串（原始文本），生命周期等于整个会话
  const TRANS_CACHE = new Map();   // text → translatedText
  const PENDING_MAP = new Map();   // text → Promise<string|null>（正在请求中）

  // ─── 全局状态 ────────────────────────────────────────────────────────────────
  const STATE = {
    active:     false,    // 是否已开启翻译
    settings:   null,
    observer:   null,
    debounceTimer: null,
    // 增量扫描队列：收集待处理的根节点
    pendingRoots: new Set(),
    scanBusy: false,
  };

  // ─── CSS ─────────────────────────────────────────────────────────────────────
  let cssInjected = false;
  function injectCSS() {
    if (cssInjected) return;
    cssInjected = true;
    const s = document.createElement('style');
    s.id = 'wu-style';
    s.textContent = `
      ._wu_t {
        cursor: pointer;
        position: relative;
        border-bottom: 1px dotted transparent;
        transition: background .15s, border-color .15s;
      }
      ._wu_t:hover {
        background: rgba(74,108,247,.1);
        border-radius: 3px;
        border-bottom-color: rgba(74,108,247,.5);
      }
      ._wu_t[data-o]:hover::after {
        content: attr(data-o);
        position: fixed;
        bottom: 12px; left: 12px; right: 12px;
        max-width: 520px;
        padding: 7px 12px;
        font-size: 12px; line-height: 1.55;
        color: #fff;
        background: rgba(18,18,28,.93);
        border-radius: 7px;
        white-space: pre-wrap; word-break: break-all;
        z-index: 2147483647; pointer-events: none;
        box-shadow: 0 4px 18px rgba(0,0,0,.45);
        backdrop-filter: blur(6px);
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ─── 代码/排除检测（带 WeakMap 缓存）────────────────────────────────────────
  const _codeCache = new WeakMap();
  function isCode(el) {
    if (!el || el === document.documentElement) return false;
    if (_codeCache.has(el)) return _codeCache.get(el);
    let r = false;
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const tag = cur.tagName;
      if (tag && EXCLUDED_TAGS.has(tag)) { r = true; break; }
      if (cur.getAttribute('translate') === 'no') { r = true; break; }
      if (cur.hasAttribute('data-no-translate')) { r = true; break; }
      if (cur.classList) {
        for (const c of cur.classList) {
          if (CODE_CLASS_RE.test(c) || c.startsWith('token') || c === 'linenumber') { r = true; break; }
        }
        if (r) break;
      }
      cur = cur.parentElement;
    }
    _codeCache.set(el, r);
    return r;
  }

  // ─── 文本过滤 ────────────────────────────────────────────────────────────────
  function skipText(raw) {
    if (!raw) return true;
    const s = raw.trim();
    if (s.length < 2) return true;
    if (RE_PURE_NUM.test(s)) return true;
    if (RE_URL.test(s) || RE_MODEL_ID.test(s) || RE_CODE_KW.test(s)) return true;
    if (/^[.#@][\w-]/.test(s) || /^[A-Z_]{3,}$/.test(s)) return true;
    if (s.startsWith('--') || s.startsWith('var(')) return true;
    if (s.includes('{') && s.includes('}')) return true;
    const letters = (s.match(/[a-zA-Z\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || '').length;
    if (letters < 1) return true;
    const sym = (s.match(/[{}[\]()*;<>\/\\|`~@#$^=+]/g) || '').length;
    if (s.length > 5 && sym > letters * 1.5) return true;
    return false;
  }

  function okAttr(v) {
    return v && v.length >= 2 && v.length <= 500 &&
      !RE_URL.test(v) && !RE_MODEL_ID.test(v) && !RE_PURE_NUM.test(v);
  }

  // ─── 收集文本节点 ────────────────────────────────────────────────────────────
  function collectTextNodes(root) {
    const items = [];
    const walker = document.createTreeWalker(
      root || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          const par = n.parentElement;
          if (!par) return NodeFilter.FILTER_REJECT;
          // 已是翻译 span 内部 → 跳过
          if (par.dataset && par.dataset.wuT) return NodeFilter.FILTER_REJECT;
          // 祖先是翻译 span → 跳过
          if (par.closest && par.closest('[data-wu-t]')) return NodeFilter.FILTER_REJECT;
          if (isCode(par)) return NodeFilter.FILTER_REJECT;
          if (skipText(n.textContent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let n;
    while ((n = walker.nextNode())) {
      items.push({ type: 'text', node: n, text: n.textContent.trim() });
    }
    return items;
  }

  function collectAttrs(root) {
    const items = [];
    const scope = root || document;
    
    const els = [];
    if (scope.nodeType === 1) els.push(scope); // Element Node
    if (scope.querySelectorAll) {
      const descendants = scope.querySelectorAll('*');
      for (let i = 0; i < descendants.length; i++) {
        els.push(descendants[i]);
      }
    }

    for (const el of els) {
      if (!el.tagName || EXCLUDED_TAGS.has(el.tagName) || isCode(el)) continue;
      if (el.closest && (el.closest('[data-no-translate]') || el.closest('[translate="no"]'))) continue;
      for (const a of ATTR_KEYS) {
        const v = el.getAttribute(a);
        // 已翻译：有 data-orig-* 属性 → 跳过
        if (el.hasAttribute(a + '-orig')) continue;
        if (okAttr(v)) items.push({ type: 'attr', el, attr: a, text: v });
      }
    }
    return items;
  }

  function collectAll(root) {
    return [...collectTextNodes(root), ...collectAttrs(root)];
  }

  // ─── 应用单条翻译（立即写入DOM）─────────────────────────────────────────────
  function applyTextNode(node, orig, tr) {
    if (!tr || tr === orig) return false;
    const par = node.parentElement;
    if (!par) return false;
    // 已在翻译容器内 → 跳过
    if (par.dataset && par.dataset.wuT) return false;
    try {
      const span = document.createElement('span');
      span.className = '_wu_t';
      span.dataset.wuT = '1';      // 标识符，供 TreeWalker 过滤
      span.dataset.o   = orig;
      span.textContent = tr;
      par.replaceChild(span, node);
      return true;
    } catch { return false; }
  }

  function applyAttr(el, attr, orig, tr) {
    if (!tr || tr === orig) return;
    try {
      el.setAttribute(attr + '-orig', orig);
      el.setAttribute(attr, tr);
    } catch {}
  }

  // ─── 缓存优先的翻译函数 ──────────────────────────────────────────────────────
  // 对一批文本：先同步应用缓存命中的，再异步请求未缓存的
  async function translateItemsWithCache(items, settings) {
    if (!items.length) return;

    const textItems = items.filter(i => i.type === 'text');
    const attrItems = items.filter(i => i.type === 'attr');

    // ① 同步阶段：立即应用已缓存的翻译（无需等待网络！）
    const uncachedText = [];
    const uncachedAttr = [];

    for (const item of textItems) {
      if (!item.node.isConnected) continue;
      const cached = TRANS_CACHE.get(item.text);
      if (cached) {
        applyTextNode(item.node, item.text, cached);
      } else if (PENDING_MAP.has(item.text)) {
        // 已有请求在飞 → 复用 Promise
        uncachedText.push(item);
      } else {
        uncachedText.push(item);
      }
    }

    for (const item of attrItems) {
      const cached = TRANS_CACHE.get(item.text);
      if (cached) {
        applyAttr(item.el, item.attr, item.text, cached);
      } else {
        uncachedAttr.push(item);
      }
    }

    // ② 异步阶段：批量获取未缓存的
    if (!uncachedText.length && !uncachedAttr.length) return;

    // 根据节点在视口中的位置进行优先级排序，优先翻译可见区域
    const vh = window.innerHeight;
    function getScore(item) {
      const el = item.node ? item.node.parentElement : item.el;
      if (!el || !el.getBoundingClientRect) return 99999;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0) return Math.abs(rect.bottom) + 10000; // 屏幕上方
      if (rect.top > vh) return rect.top + 10000; // 屏幕下方
      return rect.top; // 屏幕内，按从上到下排序
    }

    const allUncachedItems = [...uncachedText, ...uncachedAttr];
    allUncachedItems.sort((a, b) => getScore(a) - getScore(b));

    const allUncached = [...new Set(allUncachedItems.map(i => i.text))];

    // 去掉已有 PENDING 的
    const toFetch = allUncached.filter(t => !PENDING_MAP.has(t));

    if (toFetch.length) {
      await fetchAndCache(toFetch, settings);
    }

    // 等待所有涉及的 PENDING
    const allPending = allUncached
      .filter(t => PENDING_MAP.has(t))
      .map(t => PENDING_MAP.get(t));
    if (allPending.length) await Promise.allSettled(allPending);

    // ③ 应用结果（此时缓存已填充）
    for (const item of uncachedText) {
      if (!item.node.isConnected) continue;
      // 再次检查节点是否已被翻译（可能上面的并发请求已处理）
      const par = item.node.parentElement;
      if (!par || (par.dataset && par.dataset.wuT)) continue;
      const tr = TRANS_CACHE.get(item.text);
      if (tr) applyTextNode(item.node, item.text, tr);
    }
    for (const item of uncachedAttr) {
      if (item.el.hasAttribute(item.attr + '-orig')) continue;
      const tr = TRANS_CACHE.get(item.text);
      if (tr) applyAttr(item.el, item.attr, item.text, tr);
    }
  }

  // ─── 网络请求层（填充 TRANS_CACHE）──────────────────────────────────────────────
  async function fetchAndCache(texts, settings) {
    if (!texts.length) return;
    const unique = [...new Set(texts)];

    if (settings.engine === 'google') {
      // 每批最多 60 条，并发发出（每条内部已是合并请求）
      const BATCH = 60;
      const batches = [];
      for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));
      // 并发所有批次（每批内部已是单个 HTTP 请求）
      await Promise.allSettled(batches.map(batch => fetchGoogleBatch(batch, settings)));

    } else if (settings.engine === 'openai') {
      const BATCH = 25;  // 增加到 25 条
      const ep = (settings.openaiEndpoint || 'https://api.siliconflow.cn/v1/chat/completions')
        .replace(/\/chat\/completions\/?$/i,'').replace(/\/+$/,'');
      const cfg = { endpoint: ep, apiKey: settings.openaiApiKey, model: settings.openaiModel };
      const target = LANG_MAP[settings.to] || settings.to;
      const batches = [];
      for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));
      // 并发数提升到 5
      await runWithConcurrency(5, batches, batch => fetchOpenAIBatch(batch, settings.from, target, cfg));
    }
  }

  // Google 合并批量请求（核心优化）──────────────────────────────
  // 把 N 条文本合并成 1 个 HTTP 请求，此为提速关键。
  // 用段落分隔符 §§§ ，Google 通常不翻译该字符且保留换行。
  const G_SEP = '\n§§§\n';
  const G_SEP_RE = /\n§§§\n/g;

  async function fetchGoogleBatch(texts, settings) {
    // 过滤已缓存/已请求
    const toFetch = texts.filter(t => !TRANS_CACHE.has(t) && !PENDING_MAP.has(t));
    if (!toFetch.length) return;

    // 注册 PENDING_MAP（防并发重复请求）
    let resolveAll;
    const batchP = new Promise(r => { resolveAll = r; });
    toFetch.forEach(t => PENDING_MAP.set(t, batchP));

    try {
      // 尝试合并请求
      const results = await _fetchGoogleMerged(toFetch, settings.from, settings.to);
      toFetch.forEach((t, i) => {
        PENDING_MAP.delete(t);
        const tr = results[i];
        if (tr && tr !== t) TRANS_CACHE.set(t, tr);
      });
      resolveAll(results);
    } catch {
      // 合并失败（分隔符被翻译等）→ 退化为逐条并发请求
      toFetch.forEach(t => PENDING_MAP.delete(t));
      resolveAll(null);
      await Promise.allSettled(toFetch.map(async t => {
        const tr = await fetchGoogleSingle(t, settings.from, settings.to);
        if (tr && tr !== t) TRANS_CACHE.set(t, tr);
      }));
    }
  }

  // 将多条文本合并成单个请求，返回与输入等长的译文数组
  async function _fetchGoogleMerged(texts, from, to) {
    // 如果文本总字数超过限制，拆分子批
    const MAX_CHARS = 4000;
    const totalLen = texts.reduce((s, t) => s + t.length, 0);
    if (totalLen > MAX_CHARS && texts.length > 1) {
      const half = Math.ceil(texts.length / 2);
      const [r1, r2] = await Promise.all([
        _fetchGoogleMerged(texts.slice(0, half), from, to),
        _fetchGoogleMerged(texts.slice(half), from, to),
      ]);
      return [...r1, ...r2];
    }

    const joined = texts.join(G_SEP);
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', from);
    url.searchParams.set('tl', to);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', joined);

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    // 拼合所有分段，再按分隔符切割
    const fullTr = (d[0] || []).map(x => x[0] || '').join('');
    const parts  = fullTr.split(G_SEP_RE);

    if (parts.length !== texts.length) {
      // 分隔符被改变 → 抛出让调用方退化
      throw new Error(`sep mismatch: expected ${texts.length}, got ${parts.length}`);
    }
    return parts.map(p => p.trim());
  }

  // 单条回退用
  async function fetchGoogleSingle(text, from, to) {
    try {
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.searchParams.set('client','gtx');
      url.searchParams.set('sl', from);
      url.searchParams.set('tl', to);
      url.searchParams.set('dt','t');
      url.searchParams.set('q', text);
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const d = await res.json();
      return (d[0] || []).map(x => x[0] || '').join('').trim() || null;
    } catch { return null; }
  }

  async function fetchOpenAIBatch(texts, from, target, cfg, _retry = false) {
    // ① 发请求前，把所有文本注册到 PENDING_MAP，防止并发重复请求
    const myTexts = texts.filter(t => {
      if (PENDING_MAP.has(t)) return false;  // 已有飞行中请求，跳过
      if (TRANS_CACHE.has(t)) return false;  // 已缓存，跳过
      return true;
    });
    if (!myTexts.length) return;

    // 创建统一的 promise，所有 myTexts 共享
    let resolveAll;
    const batchPromise = new Promise(res => { resolveAll = res; });
    myTexts.forEach(t => PENDING_MAP.set(t, batchPromise));

    try {
      const r = await chrome.runtime.sendMessage({
        action: 'aifetch', texts: myTexts, from, to: target, config: cfg
      });

      if (r?.tr && Array.isArray(r.tr) && r.tr.length > 0) {
        // 成功：写入缓存，清除 PENDING
        r.tr.forEach((tr, i) => {
          const orig = myTexts[i];
          if (tr && tr !== orig) TRANS_CACHE.set(orig, tr);
        });
        myTexts.forEach(t => PENDING_MAP.delete(t));
        resolveAll(r.tr);
        return r.tr;
      }

      // AI 返回空或格式错误 → 如果还没重试过，拆半再试
      if (!_retry && myTexts.length > 1) {
        myTexts.forEach(t => PENDING_MAP.delete(t));
        resolveAll(null);
        const half = Math.ceil(myTexts.length / 2);
        await Promise.allSettled([
          fetchOpenAIBatch(myTexts.slice(0, half), from, target, cfg, true),
          fetchOpenAIBatch(myTexts.slice(half),    from, target, cfg, true),
        ]);
        return;
      }
    } catch (e) {
      console.warn('[WuTranslator] OpenAI fetch error:', e?.message);
    }

    // 彻底失败：清除 PENDING
    myTexts.forEach(t => PENDING_MAP.delete(t));
    resolveAll(null);
  }

  // 限并发执行器
  async function runWithConcurrency(limit, tasks, fn) {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const task = queue.shift();
        if (task) await fn(task).catch(() => {});
      }
    });
    await Promise.allSettled(workers);
  }

  // ─── 全页翻译入口 ────────────────────────────────────────────────────────────
  async function translatePage(settings) {
    STATE.settings = settings;
    STATE.active   = true;
    injectCSS();

    // 必须在异步请求前启动监听，否则会漏掉网络请求期间 SPA 框架动态渲染的节点（如下方内容区）
    startObserver();

    const items = collectAll();
    await translateItemsWithCache(items, settings);

    return { ok: true, count: items.length };
  }

  // ─── MutationObserver（增量翻译） ────────────────────────────────────────────
  function startObserver() {
    stopObserver();
    if (!STATE.settings) return;

    STATE.observer = new MutationObserver(mutations => {
      if (!STATE.active || !STATE.settings) return;

      for (const mut of mutations) {
        if (mut.type === 'characterData') {
          const par = mut.target.parentElement;
          if (par && !(par.dataset && par.dataset.wuT)) {
            STATE.pendingRoots.add(par);
          }
        } else if (mut.type === 'childList') {
          for (const node of mut.addedNodes) {
            if (node.nodeType === 1) {
              // 跳过我们自己插入的翻译 span
              if (node.dataset && node.dataset.wuT) continue;
              STATE.pendingRoots.add(node);
            } else if (node.nodeType === 3) {
              // 文本节点：把父元素加入待扫描集合
              const par = node.parentElement;
              if (par && !(par.dataset && par.dataset.wuT)) {
                STATE.pendingRoots.add(par);
              }
            }
          }
        } else if (mut.type === 'attributes') {
          const node = mut.target;
          if (node.dataset && node.dataset.wuT) continue;
          STATE.pendingRoots.add(node);
        }
      }

      if (STATE.pendingRoots.size === 0) return;

      // 先同步从缓存快速应用（让用户尽快看到翻译）
      flushFromCache();

      // 再 debounce 处理需要网络的部分
      if (!STATE.debounceTimer) {
        STATE.debounceTimer = setTimeout(flushPendingRoots, 300);
      }
    });

    STATE.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTR_KEYS,
    });
  }

  function stopObserver() {
    if (STATE.observer) { STATE.observer.disconnect(); STATE.observer = null; }
    if (STATE.debounceTimer) { clearTimeout(STATE.debounceTimer); STATE.debounceTimer = null; }
  }

  // 同步：从缓存立刻翻译 pendingRoots 中命中缓存的节点
  function flushFromCache() {
    if (!TRANS_CACHE.size) return;
    for (const root of STATE.pendingRoots) {
      if (!root || !root.isConnected) continue;
      
      const textNodes = collectTextNodes(root);
      for (const item of textNodes) {
        const cached = TRANS_CACHE.get(item.text);
        if (cached) applyTextNode(item.node, item.text, cached);
      }
      
      const attrs = collectAttrs(root);
      for (const item of attrs) {
        if (item.el.hasAttribute(item.attr + '-orig')) continue;
        const cached = TRANS_CACHE.get(item.text);
        if (cached) applyAttr(item.el, item.attr, item.text, cached);
      }
    }
  }

  // 异步：处理 pendingRoots 中需要网络请求的节点
  async function flushPendingRoots() {
    STATE.debounceTimer = null;
    if (STATE.scanBusy || !STATE.settings) return;
    STATE.scanBusy = true;

    const roots = [...STATE.pendingRoots];
    STATE.pendingRoots.clear();

    try {
      const items = [];
      for (const root of roots) {
        if (!root || !root.isConnected) continue;
        items.push(...collectAll(root));
      }
      // 过滤掉已缓存的（已被 flushFromCache 同步处理）
      const uncached = items.filter(i =>
        i.type === 'text'
          ? !TRANS_CACHE.has(i.text)
          : !TRANS_CACHE.has(i.text) && !i.el.hasAttribute(i.attr + '-orig')
      );
      if (uncached.length) await translateItemsWithCache(uncached, STATE.settings);
    } finally {
      STATE.scanBusy = false;
      // 如果期间又有新节点进来，继续处理
      if (STATE.pendingRoots.size > 0) {
        flushFromCache();
        STATE.debounceTimer = setTimeout(flushPendingRoots, 200);
      }
    }
  }

  // ─── 恢复原文 ────────────────────────────────────────────────────────────────
  function restore() {
    stopObserver();

    for (const span of document.querySelectorAll('._wu_t')) {
      const orig = span.dataset.o;
      if (orig !== undefined) {
        try { span.parentNode.replaceChild(document.createTextNode(orig), span); } catch {}
      }
    }

    // 恢复属性
    for (const el of document.querySelectorAll('*')) {
      for (const a of ATTR_KEYS) {
        const orig = el.getAttribute(a + '-orig');
        if (orig !== null) {
          try { el.setAttribute(a, orig); el.removeAttribute(a + '-orig'); } catch {}
        }
      }
    }

    // 重置状态（注意：保留 TRANS_CACHE，重新翻译时直接命中！）
    STATE.active   = false;
    STATE.settings = null;
    STATE.pendingRoots.clear();
    STATE.scanBusy = false;

    const s = document.getElementById('wu-style');
    if (s) s.remove();
    cssInjected = false;

    window.__wuTranslatorLoaded = false;
  }

  // ─── 消息监听 ────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((req, _, send) => {
    if (req.action === 'translate') {
      if (STATE.active) restore();
      window.__wuTranslatorLoaded = true;
      injectCSS();
      translatePage(req.settings).then(r => send(r || { ok: true }));
      return true;
    }
    if (req.action === 'restore') {
      restore();
      send({ ok: true });
    }
    if (req.action === 'getState') {
      send({ translated: STATE.active });
    }
  });

  // ─── SPA 路由监听 ─────────────────────────────────────────────────────────────
  function patchHistory() {
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    
    let routeChangeTimer = null;
    const handleRouteChange = () => {
      if (STATE.active && STATE.settings) {
        if (routeChangeTimer) clearTimeout(routeChangeTimer);
        // 给框架一点渲染时间，然后触发全页扫描
        routeChangeTimer = setTimeout(() => {
          translatePage(STATE.settings).catch(() => {});
        }, 800);
      }
    };

    history.pushState = function() {
      const res = originalPush.apply(this, arguments);
      handleRouteChange();
      return res;
    };

    history.replaceState = function() {
      const res = originalReplace.apply(this, arguments);
      handleRouteChange();
      return res;
    };

    window.addEventListener('popstate', handleRouteChange);
  }

  // ─── 自动翻译 ────────────────────────────────────────────────────────────────
  chrome.storage.sync.get([
    'autoTranslateDomains','from','to','engine',
    'openaiEndpoint','openaiApiKey','openaiModel',
  ]).then(d => {
    patchHistory(); // 启动路由监听
    if (!d.autoTranslateDomains?.includes(location.hostname)) return;
    const s = {
      from: d.from || 'auto',
      to:   d.to   || 'zh-CN',
      engine: d.engine || 'google',
      openaiEndpoint: d.openaiEndpoint || 'https://api.siliconflow.cn/v1/chat/completions',
      openaiApiKey:   d.openaiApiKey   || '',
      openaiModel:    d.openaiModel    || 'tencent/Hunyuan-MT-7B',
    };
    const go = () => translatePage(s);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', go, { once: true });
    } else {
      setTimeout(go, 150);
    }
  });

})();
