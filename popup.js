const DEFAULT_SETTINGS = {
  from: 'auto',
  to: 'zh-CN',
  engine: 'google',
   openaiEndpoint: 'https://api.siliconflow.cn/v1/chat/completions',
  openaiApiKey: '',
   openaiModel: 'tencent/Hunyuan-MT-7B',
};

let currentHost = '';
let currentTabId = null;
// 当前弹窗对应 tab 的翻译状态（直接从 content.js 查询，不依赖 storage.local）
let isTranslated = false;

// ─── 初始化 ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const tab = await getActiveTab();
  if (tab?.url) {
    try { currentHost = new URL(tab.url).hostname; } catch {}
    currentTabId = tab.id;
  }
  document.getElementById('currentDomain').textContent = currentHost || '—';

  const settings = await loadSettings();
  applySettings(settings);
  setupEventListeners();

  // 从 content.js 直接查询当前tab的真实翻译状态
  isTranslated = await queryTabTranslated();
  updateButtons();

  // 自动翻译开关状态
  const { autoTranslateDomains = [] } = await chrome.storage.sync.get({ autoTranslateDomains: [] });
  document.getElementById('autoToggle').checked = autoTranslateDomains.includes(currentHost);
});

// ─── Tab 状态查询（直接与 content.js 通信，不依赖 storage.local）───────────
async function queryTabTranslated() {
  if (!currentTabId) return false;
  try {
    const state = await chrome.tabs.sendMessage(currentTabId, { action: 'getState' });
    return !!state?.translated;
  } catch {
    return false;
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function loadSettings() {
  try {
    return await chrome.storage.sync.get(DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings) {
  const syncKeys = ['from', 'to', 'engine', 'openaiEndpoint', 'openaiApiKey', 'openaiModel'];
  const syncData = {};
  for (const key of syncKeys) {
    if (key in settings) syncData[key] = settings[key];
  }
  await chrome.storage.sync.set(syncData);
}

function applySettings(settings) {
  document.getElementById('fromLang').value = settings.from;
  document.getElementById('toLang').value = settings.to;
  const radio = document.querySelector(`input[name="engine"][value="${settings.engine}"]`);
  if (radio) radio.checked = true;
  document.getElementById('openaiEndpoint').value = settings.openaiEndpoint;
  document.getElementById('openaiApiKey').value = settings.openaiApiKey;
  document.getElementById('openaiModel').value = settings.openaiModel;
  showConfigSection(settings.engine);
}

function showConfigSection(engine) {
  document.getElementById('googleConfig').style.display = engine === 'google' ? 'block' : 'none';
  document.getElementById('openaiConfig').style.display = engine === 'openai' ? 'block' : 'none';
}

function getCurrentSettings() {
  return {
    from: document.getElementById('fromLang').value,
    to: document.getElementById('toLang').value,
    engine: document.querySelector('input[name="engine"]:checked')?.value || 'google',
    openaiEndpoint: document.getElementById('openaiEndpoint').value.trim(),
    openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
    openaiModel: document.getElementById('openaiModel').value.trim(),
  };
}

// ─── 按钮状态（只读内存变量，不依赖 storage）──────────────────────────────
function updateButtons() {
  const btn = document.getElementById('translateBtn');
  const restoreBtn = document.getElementById('restoreBtn');
  btn.textContent = isTranslated ? '重新翻译' : '翻译页面';
  restoreBtn.disabled = !isTranslated;
  restoreBtn.style.opacity = isTranslated ? '1' : '0.4';
}

// ─── 状态提示 ────────────────────────────────────────────────────────────────
function setStatus(text, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = 'status status-' + type;
}

function setProgress(done, total) {
  if (!total) return;
  const pct = Math.round(done / total * 100);
  setStatus(`翻译中… ${pct}% (${done}/${total})`, 'progress');
}

// ─── 验证设置 ────────────────────────────────────────────────────────────────
function validateSettings(settings) {
  if (settings.engine === 'openai') {
    if (!settings.openaiEndpoint) return '请输入 API Endpoint';
    if (!settings.openaiApiKey) return '请输入 API Key';
    if (!settings.openaiModel) return '请输入模型名称';
  }
  return null;
}

// ─── 翻译 ────────────────────────────────────────────────────────────────────
async function doTranslate() {
  if (!currentTabId) { setStatus('无法获取当前页面', 'error'); return; }
  const settings = getCurrentSettings();
  const err = validateSettings(settings);
  if (err) { setStatus(err, 'error'); return; }

  const btn = document.getElementById('translateBtn');
  btn.disabled = true;
  setStatus('正在翻译…', 'progress');

  try {
    const resp = await chrome.tabs.sendMessage(currentTabId, { action: 'translate', settings });
    if (resp?.error === 'busy') {
      setStatus('正在翻译中，请稍候…', 'info');
    } else if (resp?.ok) {
      isTranslated = true;
      const cnt = resp.count || 0;
      setStatus(cnt > 0 ? `翻译完成，共 ${cnt} 处` : '翻译完成（未发现可翻译内容）', 'success');
      updateButtons();
    } else {
      setStatus('翻译失败，请检查设置', 'error');
    }
  } catch (e) {
    if (e.message?.includes('Receiving end does not exist')) {
      setStatus('请刷新页面后再试（content script 未加载）', 'error');
    } else {
      setStatus(`翻译出错: ${e.message}`, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

// ─── 恢复 ────────────────────────────────────────────────────────────────────
async function doRestore() {
  if (!currentTabId) return;
  try {
    await chrome.tabs.sendMessage(currentTabId, { action: 'restore' });
    isTranslated = false;
    setStatus('已恢复原文', 'info');
    updateButtons();
  } catch {
    setStatus('恢复失败', 'error');
  }
}

// ─── 事件绑定 ────────────────────────────────────────────────────────────────
function setupEventListeners() {
  document.querySelectorAll('input[name="engine"]').forEach(radio => {
    radio.addEventListener('change', () => {
      showConfigSection(radio.value);
      saveSettings(getCurrentSettings());
    });
  });

  ['fromLang','toLang','openaiEndpoint','openaiApiKey','openaiModel'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => saveSettings(getCurrentSettings()));
  });

  document.getElementById('translateBtn').addEventListener('click', doTranslate);
  document.getElementById('restoreBtn').addEventListener('click', doRestore);

  document.getElementById('autoToggle').addEventListener('change', async () => {
    const on = document.getElementById('autoToggle').checked;
    const { autoTranslateDomains = [] } = await chrome.storage.sync.get({ autoTranslateDomains: [] });

    if (on) {
      if (!autoTranslateDomains.includes(currentHost)) {
        autoTranslateDomains.push(currentHost);
        await chrome.storage.sync.set({ autoTranslateDomains });
      }
      const settings = getCurrentSettings();
      const err = validateSettings(settings);
      if (err) { setStatus(err, 'error'); return; }
      setStatus('已开启自动翻译', 'info');
      doTranslate();
    } else {
      const idx = autoTranslateDomains.indexOf(currentHost);
      if (idx >= 0) {
        autoTranslateDomains.splice(idx, 1);
        await chrome.storage.sync.set({ autoTranslateDomains });
      }
      doRestore();
      setStatus('已关闭自动翻译', 'info');
    }
  });
}

// ─── 监听来自 content.js 的进度消息 ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') {
    setProgress(msg.done, msg.total);
  }
});
