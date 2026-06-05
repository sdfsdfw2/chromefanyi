// ─── 消息路由 ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'aifetch') {
    handleAIfetch(req).then(sendResponse).catch(() => sendResponse({ tr: null }));
    return true; // 保持通道
  }
  // 进度消息：从 content.js 转发给 popup（通过 tab 广播）
  if (req.action === 'progress' && sender.tab?.id) {
    chrome.runtime.sendMessage({ action: 'progress', done: req.done, total: req.total }).catch(() => {});
  }
});

// ─── AI 翻译 ───────────────────────────────────────────────────────────────
async function handleAIfetch(req) {
  const { texts, from, to, config } = req;
  if (!config?.apiKey) return { tr: null };
  if (!texts?.length) return { tr: [] };

  let endpoint = (config.endpoint || 'https://api.siliconflow.cn/v1/chat/completions')
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/+$/, '');
  endpoint += '/chat/completions';

  const fromHint = from && from !== 'auto' ? ` from ${from}` : '';
  const body = JSON.stringify({
    model: config.model || 'tencent/Hunyuan-MT-7B',
    messages: [
      {
        role: 'system',
        content: `You are a professional translator. Translate each text${fromHint} to ${to}.\nReturn ONLY a JSON array of translated strings, same length as input.\nExample input: ["Hello","World"]\nExample output: ["你好","世界"]\nNo markdown, no explanation, no extra text.`,
      },
      { role: 'user', content: JSON.stringify(texts) },
    ],
    temperature: 0,
    max_tokens: 4096,
    stream: false,
  });

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('[WuTranslator] AI API error:', res.status, errText.slice(0, 200));
      return { tr: null };
    }

    const raw = await res.text();
    const content = extractContent(raw);
    if (!content) {
      console.warn('[WuTranslator] empty content, raw:', raw.slice(0, 200));
      return { tr: null };
    }
    const parsed = parseTranslation(content, texts.length);
    if (!parsed) console.warn('[WuTranslator] parse failed, content:', content.slice(0, 300));
    return { tr: parsed };
  } catch (e) {
    console.warn('[WuTranslator] AI fetch error:', e.message);
    return { tr: null };
  }
}

// ─── 提取响应内容 ──────────────────────────────────────────────────────────
function extractContent(raw) {
  if (!raw?.trim()) return null;
  let t = raw.trim().replace(/^\uFEFF/, '').trim();

  // SSE 流式响应
  if (t.startsWith('data:') || t.includes('\ndata:')) {
    let full = '';
    for (const line of t.split('\n')) {
      const s = line.trim();
      if (!s || s === 'data: [DONE]' || !s.startsWith('data:')) continue;
      const j = s.slice(5).trim();
      if (!j || j === '[DONE]') continue;
      try {
        const c = JSON.parse(j);
        full += c.choices?.[0]?.delta?.content
          || c.choices?.[0]?.message?.content
          || c.choices?.[0]?.text
          || '';
      } catch {}
    }
    if (full.trim()) return full.trim();
  }

  // 标准 JSON 响应
  if (t.startsWith('{')) {
    try {
      const d = JSON.parse(t);
      const c = d.choices?.[0]?.message?.content
        || d.choices?.[0]?.text
        || d.response
        || d.content
        || d.translation
        || d.result
        || d.output
        || d.message?.content
        || d.text;
      if (c) return String(c).trim();
    } catch {}
  }

  return t || null;
}

// ─── 解析翻译结果（宽松模式）─────────────────────────────────────────────
function parseTranslation(content, count) {
  if (!content) return null;

  const tryParse = s => {
    try {
      const d = JSON.parse(s);
      if (!Array.isArray(d) || d.length === 0) return null;
      const cleaned = d.map(x => (x == null ? '' : String(x).trim()));
      // 精确匹配
      if (cleaned.length === count) return cleaned;
      // AI 多返回了几条 → 取前 count 条
      if (cleaned.length > count) return cleaned.slice(0, count);
      // AI 少返回（漏译）→ 只要超过一半就接受，缺的位置填 null（调用方跳过）
      if (cleaned.length >= Math.ceil(count * 0.5)) {
        const result = new Array(count).fill(null);
        cleaned.forEach((v, i) => { result[i] = v; });
        return result;
      }
    } catch {}
    return null;
  };

  // 1. 直接解析
  let r = tryParse(content);
  if (r) return r;

  // 2. 从 markdown 代码块中提取
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { r = tryParse(m[1].trim()); if (r) return r; }

  // 3. 宽松匹配最外层 JSON 数组
  const m2 = content.match(/(\[[\s\S]*\])/);
  if (m2) { r = tryParse(m2[1]); if (r) return r; }

  // 4. 逐行查找 JSON 数组
  for (const line of content.split('\n')) {
    const l = line.trim();
    if (l.startsWith('[')) { r = tryParse(l); if (r) return r; }
  }

  return null;
}
