/* ─────────────────────────────────────────────────────────────────────────────
   Auto-Monitor — frontend application logic
   ──────────────────────────────────────────────────────────────────────────── */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  apiKey:          localStorage.getItem('poc_gemini_key')      || '',
  model:           localStorage.getItem('poc_gemini_model')    || 'gemma-4-31b-it',
  groundingModel:  localStorage.getItem('poc_grounding_model') || 'gemini-flash-latest',
  monitors:     [],   // { crawlerId, name, description, createdAt, hasError }
  activeDashId: null,
  generating:   false,
};

// ── DOM references ────────────────────────────────────────────────────────────
const el = (id) => document.getElementById(id);

const dom = {
  apiKeyInput:    el('apiKeyInput'),
  saveKeyBtn:     el('saveKeyBtn'),
  keyStatus:      el('keyStatus'),
  modelInput:     el('modelInput'),
  groundingInput: el('groundingInput'),
  newMonitorBtn:  el('newMonitorBtn'),
  monitorList:    el('monitorList'),
  messages:       el('messages'),
  msgInput:       el('msgInput'),
  sendBtn:        el('sendBtn'),
  main:           el('main'),
  chatSection:    el('chatSection'),
  dashSection:    el('dashSection'),
  dashTabs:       el('dashTabs'),
  dashFrame:      el('dashFrame'),
  collapseDash:   el('collapseDash'),
};

// ── Boot ──────────────────────────────────────────────────────────────────────
function init() {
  // Restore saved key
  if (state.apiKey) {
    dom.apiKeyInput.value = state.apiKey;
    showKeyStatus('ok', 'Key loaded from storage');
  }

  // Restore saved model
  dom.modelInput.value = state.model;
  dom.groundingInput.value = state.groundingModel;

  // Buttons
  dom.saveKeyBtn    .addEventListener('click',   saveApiKey);
  dom.newMonitorBtn .addEventListener('click',   focusInput);
  dom.sendBtn       .addEventListener('click',   onSend);
  dom.collapseDash  .addEventListener('click',   collapseDashboard);

  // API key: save on Enter
  dom.apiKeyInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveApiKey());

  // Model: persist on change/blur
  dom.modelInput.addEventListener('change', saveModel);
  dom.modelInput.addEventListener('blur',   saveModel);

  // Grounding model: persist on change/blur
  dom.groundingInput.addEventListener('change', saveModel);
  dom.groundingInput.addEventListener('blur',   saveModel);

  // Input auto-grow + Enter-to-send
  dom.msgInput.addEventListener('input',   onInputChange);
  dom.msgInput.addEventListener('keydown', onInputKeyDown);

  // Suggestion chips
  document.querySelectorAll('.suggestion').forEach((btn) =>
    btn.addEventListener('click', () => {
      dom.msgInput.value = btn.textContent.trim();
      onInputChange();
      dom.msgInput.focus();
    })
  );

  updateSendBtn();
}

// ── API key ───────────────────────────────────────────────────────────────────
function saveApiKey() {
  const key = dom.apiKeyInput.value.trim();
  if (!key) { showKeyStatus('error', 'Enter a key first'); return; }
  state.apiKey = key;
  localStorage.setItem('poc_gemini_key', key);
  showKeyStatus('ok', 'Saved ✓');
  updateSendBtn();
}

// ── Model ─────────────────────────────────────────────────────────────────────
function saveModel() {
  const m = dom.modelInput.value.trim();
  state.model = m || 'gemma-4-31b-it';
  dom.modelInput.value = state.model;   // normalise empty → default
  localStorage.setItem('poc_gemini_model', state.model);

  const g = dom.groundingInput.value.trim();
  state.groundingModel = g || 'gemini-flash-latest';
  dom.groundingInput.value = state.groundingModel;   // normalise empty → default
  localStorage.setItem('poc_grounding_model', state.groundingModel);
}

function showKeyStatus(type, text) {
  dom.keyStatus.textContent = text;
  dom.keyStatus.className = `key-status ${type}`;
  dom.keyStatus.classList.remove('hidden');
  if (type === 'ok') setTimeout(() => dom.keyStatus.classList.add('hidden'), 3000);
}

// ── Input helpers ─────────────────────────────────────────────────────────────
function onInputChange() {
  dom.msgInput.style.height = 'auto';
  dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 180) + 'px';
  updateSendBtn();
}

function onInputKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!dom.sendBtn.disabled) onSend();
  }
}

function updateSendBtn() {
  const ready = !!state.apiKey && dom.msgInput.value.trim().length > 0 && !state.generating;
  dom.sendBtn.disabled = !ready;
}

function focusInput() {
  dom.msgInput.focus();
}

// ── Send / generate ───────────────────────────────────────────────────────────
async function onSend() {
  const text = dom.msgInput.value.trim();
  if (!text || state.generating) return;

  hideWelcome();
  appendUserMsg(text);

  // Reset input
  dom.msgInput.value = '';
  dom.msgInput.style.height = 'auto';

  state.generating = true;
  updateSendBtn();

  const thinkingId = appendThinking();

  try {
    const res = await fetch('/api/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ apiKey: state.apiKey, description: text, model: state.model, groundingModel: state.groundingModel }),
    });

    const data = await res.json();
    removeThinking(thinkingId);

    if (!res.ok) {
      appendErrorMsg(data.error || `Server error (${res.status})`);
      return;
    }

    // Render the success card
    appendCrawlerCard(data);

    // Register in sidebar
    state.monitors.unshift({
      crawlerId:   data.crawlerId,
      name:        data.name,
      description: data.description,
      createdAt:   new Date().toISOString(),
      hasError:    !data.verified,
    });
    renderMonitorList();

    // Auto-open the dashboard
    openDashboard(data.crawlerId, data.name);

  } catch (err) {
    removeThinking(thinkingId);
    appendErrorMsg('Network error: ' + err.message);
  } finally {
    state.generating = false;
    updateSendBtn();
  }
}

// ── Message builders ──────────────────────────────────────────────────────────
function hideWelcome() {
  const w = el('welcomeScreen');
  if (w) w.remove();
}

function appendUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `
    <div class="msg-avatar">U</div>
    <div class="msg-body">
      <div class="msg-bubble">${esc(text)}</div>
    </div>`;
  dom.messages.appendChild(div);
  scrollBottom();
}

function appendThinking() {
  const id = 'think-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.id = id;
  div.innerHTML = `
    <div class="msg-avatar">${aiIcon()}</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div class="thinking-wrap">
          <div class="thinking-dots">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
          </div>
          <span class="thinking-label">Generating &amp; verifying crawler… this can take up to a minute.</span>
        </div>
      </div>
    </div>`;
  dom.messages.appendChild(div);
  scrollBottom();
  return id;
}

function removeThinking(id) {
  const el2 = el(id);
  if (el2) el2.remove();
}

function appendErrorMsg(msg) {
  const div = document.createElement('div');
  div.className = 'msg msg-ai msg-error';
  div.innerHTML = `
    <div class="msg-avatar">${aiIcon()}</div>
    <div class="msg-body">
      <div class="msg-bubble">${esc(msg)}</div>
    </div>`;
  dom.messages.appendChild(div);
  scrollBottom();
}

function appendCrawlerCard({ crawlerId, name, description, code, verified, attempts, verifyReason, verifyNote, initialData, grounded, sources }) {
  const itemCount = countTopItems(initialData);
  const statusClass = verified ? 'ok' : 'warn';
  const badge = verified
    ? `<span class="verify-badge ok">✓ Verified working</span>`
    : `<span class="verify-badge warn">⚠ Unverified (${esc(verifyReason || 'failed')})</span>`;

  const groundedBadge = grounded
    ? `<span class="verify-badge grounded">⌖ Grounded</span>`
    : '';

  const statusText = verified
    ? `${verifyNote || 'Verified working.'}${itemCount ? ` (${itemCount} item${itemCount === 1 ? '' : 's'})` : ''}`
    : (verifyNote || 'Could not verify the crawler.');

  const attemptsText = attempts > 1
    ? `<div class="crawler-card-attempts">Auto-retried ${attempts} time${attempts === 1 ? '' : 's'} to get working data.</div>`
    : '';

  const srcList = Array.isArray(sources) ? sources.filter(s => s && s.uri) : [];
  const sourcesText = srcList.length
    ? `<div class="crawler-card-sources"><span class="sources-label">Sources</span>${
        srcList.slice(0, 5).map(s =>
          `<a href="${escAttr(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.uri)}</a>`
        ).join('')
      }</div>`
    : '';

  const codeBlockId = `code-${crawlerId}`;

  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.innerHTML = `
    <div class="msg-avatar">${aiIcon()}</div>
    <div class="msg-body">
      <div class="crawler-card">
        <div class="crawler-card-header">
          <div class="crawler-card-pulse ${verified ? '' : 'warn'}"></div>
          <div class="crawler-card-name">${esc(name)}</div>
          ${badge}
          ${groundedBadge}
        </div>
        <div class="crawler-card-desc">${esc(description)}</div>
        <div class="crawler-card-status ${statusClass}">${esc(statusText)}</div>
        ${attemptsText}
        ${sourcesText}
        <div class="crawler-card-actions">
          <button class="btn-view-dash" data-id="${crawlerId}" data-name="${escAttr(name)}">
            View Dashboard
          </button>
          <button class="btn-view-code" data-code-id="${codeBlockId}">
            View Code
          </button>
        </div>
      </div>
      <div id="${codeBlockId}" class="code-block hidden">
        <div class="code-block-header">
          <span>crawler.js — generated &amp; verified by the agent</span>
        </div>
        <pre>${esc(code || '// No code available')}</pre>
      </div>
    </div>`;

  div.querySelector('.btn-view-dash').addEventListener('click', (e) => {
    const { id: cid, name: cname } = e.currentTarget.dataset;
    openDashboard(cid, cname);
  });

  div.querySelector('.btn-view-code').addEventListener('click', (e) => {
    const target = el(e.currentTarget.dataset.codeId);
    if (target) target.classList.toggle('hidden');
  });

  dom.messages.appendChild(div);
  scrollBottom();
}

function countTopItems(data) {
  if (!data || typeof data !== 'object') return 0;
  for (const val of Object.values(data)) {
    if (Array.isArray(val)) return val.length;
  }
  return Object.keys(data).length;
}

// ── Dashboard panel ───────────────────────────────────────────────────────────
function openDashboard(crawlerId, name) {
  // Show the panel
  dom.dashSection.classList.remove('hidden');
  dom.main.classList.add('split');

  // Create tab if not already there
  const existing = dom.dashTabs.querySelector(`[data-id="${crawlerId}"]`);
  if (!existing) {
    const tab = document.createElement('button');
    tab.className = 'dash-tab';
    tab.dataset.id = crawlerId;
    tab.innerHTML = `<span class="dash-tab-dot"></span><span>${esc(name)}</span>`;
    tab.addEventListener('click', () => activateTab(crawlerId));
    dom.dashTabs.appendChild(tab);
  }

  activateTab(crawlerId);
}

function activateTab(crawlerId) {
  state.activeDashId = crawlerId;

  // Highlight active tab
  dom.dashTabs.querySelectorAll('.dash-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.id === crawlerId)
  );

  // Highlight active sidebar item
  document.querySelectorAll('.monitor-item').forEach((item) =>
    item.classList.toggle('active', item.dataset.id === crawlerId)
  );

  // Load iframe
  dom.dashFrame.src = `/dashboard/${crawlerId}`;
}

function collapseDashboard() {
  dom.dashSection.classList.add('hidden');
  dom.main.classList.remove('split');
  state.activeDashId = null;

  // Deactivate all sidebar items
  document.querySelectorAll('.monitor-item').forEach((item) =>
    item.classList.remove('active')
  );
}

// ── Sidebar monitor list ──────────────────────────────────────────────────────
function renderMonitorList() {
  if (state.monitors.length === 0) {
    dom.monitorList.innerHTML = '<div class="empty-list">No monitors yet</div>';
    return;
  }

  dom.monitorList.innerHTML = '';

  for (const m of state.monitors) {
    const item = document.createElement('div');
    item.className = `monitor-item${m.crawlerId === state.activeDashId ? ' active' : ''}`;
    item.dataset.id = m.crawlerId;

    item.innerHTML = `
      <div class="monitor-dot ${m.hasError ? 'error' : 'ok'}"></div>
      <div class="monitor-info">
        <div class="monitor-name">${esc(m.name)}</div>
        <div class="monitor-meta">${relTime(m.createdAt)}</div>
      </div>
      <button class="monitor-del" title="Delete monitor" data-id="${m.crawlerId}">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>`;

    item.addEventListener('click', (e) => {
      if (!e.target.closest('.monitor-del')) openDashboard(m.crawlerId, m.name);
    });

    item.querySelector('.monitor-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMonitor(m.crawlerId);
    });

    dom.monitorList.appendChild(item);
  }
}

async function deleteMonitor(crawlerId) {
  try {
    await fetch(`/api/crawlers/${crawlerId}`, { method: 'DELETE' });
  } catch { /* ignore network errors on delete */ }

  state.monitors = state.monitors.filter((m) => m.crawlerId !== crawlerId);

  // Remove dashboard tab
  const tab = dom.dashTabs.querySelector(`[data-id="${crawlerId}"]`);
  if (tab) tab.remove();

  // Collapse or switch to another tab
  if (state.activeDashId === crawlerId) {
    const nextTab = dom.dashTabs.querySelector('.dash-tab');
    if (nextTab) {
      activateTab(nextTab.dataset.id);
    } else {
      collapseDashboard();
    }
  }

  renderMonitorList();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function scrollBottom() {
  requestAnimationFrame(() => { dom.messages.scrollTop = dom.messages.scrollHeight; });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function aiIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
