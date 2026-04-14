const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function api(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _raw: t }; }
}

let evalData = null;
let convos = [];
let scenarios = [];
let capabilities = null;
let currentPage = 'dashboard';
let globalLang = 'cn';
let activeSrFilter = 'all';
const translationCache = new Map();

// ── Language helper ──
function L(cn, en) { return globalLang === 'en' && en ? en : (cn || ''); }

async function translateText(text) {
  if (!text || /^[\x00-\x7F]*$/.test(text)) return text; // already ASCII
  if (translationCache.has(text)) return translationCache.get(text);
  try {
    const r = await api('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [text] }),
    });
    const t = r.translations?.[0] || text;
    translationCache.set(text, t);
    return t;
  } catch { return text; }
}

async function translateTexts(texts) {
  const needed = texts.filter(t => t && !/^[\x00-\x7F]*$/.test(t) && !translationCache.has(t));
  if (needed.length) {
    try {
      const r = await api('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: needed }),
      });
      (r.translations || []).forEach((t, i) => translationCache.set(needed[i], t));
    } catch { /* fallback to originals */ }
  }
  return texts.map(t => translationCache.get(t) || t);
}

// ── SR filter helper ──
function filteredSuppliers() {
  if (!evalData) return [];
  if (activeSrFilter === 'all') return evalData.suppliers;
  return evalData.suppliers.filter(s => (s._sr || evalData.sr.id) === activeSrFilter);
}

// ── Navigation ──

function showPage(name) {
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('is-active');
    p.style.removeProperty('display');
  });
  const el = $(`page-${name}`);
  if (el) { el.classList.add('is-active'); }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('is-active', b.dataset.page === name));
}

document.querySelector('.sidebar__nav').addEventListener('click', e => {
  const btn = e.target.closest('.nav-btn');
  if (btn) showPage(btn.dataset.page);
});

// ── Dashboard ──


function renderDashboard() {
  if (!evalData) return;
  const sr = evalData.sr;
  const suppliers = filteredSuppliers();
  suppliers.forEach(s => {
    if (!s.displayName) s.displayName = s.sr?.product || s.name || s.caseId;
    if (!s.displayName_en) s.displayName_en = s.sr?.product_en || s.name_en || s.caseId;
  });
  const bench = evalData.benchmark;

  $('dash-header').innerHTML = `
    <div class="sr-header__id">${activeSrFilter === 'all' ? 'All Sourcing Requests' : esc(activeSrFilter)}</div>
    <div class="sr-header__detail">${esc(sr.product)} &middot; ${esc(sr.platform)} &middot; ${esc(sr.dateRange)}</div>
  `;

  const scored = suppliers.filter(s => s.score > 0).length;
  const scoredList = suppliers.filter(s => s.score > 0);
  const avg = scoredList.length ? (scoredList.reduce((a,s) => a + s.percent, 0) / scoredList.length).toFixed(1) : 0;
  const passing = Number(avg) >= bench.passThreshold;

  $('dash-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-card__label">Suppliers</div><div class="kpi-card__value">${suppliers.length}</div></div>
    <div class="kpi-card"><div class="kpi-card__label">Scored</div><div class="kpi-card__value">${scored}/${suppliers.length}</div></div>
    <div class="kpi-card"><div class="kpi-card__label">Avg Score</div><div class="kpi-card__value">${avg}%</div></div>
    <div class="kpi-card"><div class="kpi-card__label">Status</div><div class="kpi-card__value ${passing ? 'kpi-card__value--ok' : 'kpi-card__value--danger'}">${passing ? 'PASS' : 'FAIL'}</div></div>
  `;

  const statuses = ['completed','replied','messaged','stalled','pending'];
  const counts = {};
  statuses.forEach(s => counts[s] = suppliers.filter(x => x.status === s).length);
  $('dash-funnel').innerHTML = `<h3>Supplier Funnel</h3><div class="funnel-row">${
    statuses.map(s => `<div class="funnel-stage"><div class="funnel-stage__count">${counts[s]}</div><div class="funnel-stage__label">${esc(s)}</div><div class="funnel-stage__pct">${suppliers.length ? Math.round(counts[s]/suppliers.length*100) : 0}%</div></div>`).join('')
  }</div>`;

  const dims = Object.keys(evalData.evalDimensions);
  const coreQ = dims.filter(d => evalData.evalDimensions[d].category === 'Core Quality');
  const convM = dims.filter(d => evalData.evalDimensions[d].category === 'Conversation Management');
  const edgeH = dims.filter(d => evalData.evalDimensions[d].category === 'Edge Case Handling');
  const groups = [
    { label: 'Core Quality', dims: coreQ },
    { label: 'Conv. Mgmt', dims: convM },
    { label: 'Edge Cases', dims: edgeH },
  ];

  let heatHtml = '<h3>Score Heatmap</h3><div class="table-wrap"><table class="heatmap-table"><thead><tr><th>Supplier</th>';
  groups.forEach(g => { g.dims.forEach(d => { heatHtml += `<th title="${esc(evalData.evalDimensions[d].name)}">${esc(d)}</th>`; }); });
  heatHtml += '<th>%</th></tr></thead><tbody>';
  scoredList.forEach(s => {
    const supplierLabel = L(s.sr?.product, s.sr?.product_en) || s.caseId;
    heatHtml += `<tr><td style="text-align:left;font-weight:600" title="${esc(s.caseId)}">${esc(supplierLabel)}${s._isInsert ? ' <span style="color:#8b5cf6;font-size:0.8em">(inserted)</span>' : ''}</td>`;
    groups.forEach(g => { g.dims.forEach(d => {
      const v = (s.dimensions || {})[d] || 'n/a';
      const cls = v === 'pass' ? 'score-pass' : v === 'partial' ? 'score-partial' : v === 'fail' ? 'score-fail' : 'score-na';
      const label = v === 'pass' ? 'P' : v === 'partial' ? 'Pa' : v === 'fail' ? 'F' : v === 'n/a' ? '—' : v;
      heatHtml += `<td class="${cls}">${label}</td>`;
    }); });
    heatHtml += `<td style="font-weight:600">${s.percent}%</td></tr>`;
  });
  heatHtml += '</tbody></table></div>';
  $('dash-heatmap').innerHTML = heatHtml;

  $('sidebar-footer').innerHTML = `Avg: ${avg}% &middot; ${passing ? 'PASS' : 'FAIL'} | ${scored}/${suppliers.length} scored`;

  populateSupplierFilter(suppliers);
}

function populateSupplierFilter(suppliers) {
  const sel = $('supplier-filter');
  sel.innerHTML = '<option value="all">All suppliers</option>' +
    suppliers.map(s => {
      const name = L(s.displayName || s.name, s.displayName_en || s.name_en) || '';
      return `<option value="${esc(s.id)}">${esc(s.id)} ${esc(name)}</option>`;
    }).join('');
}

// ── Smoke Tests ──

function renderSmokeTests() {
  if (!evalData) return;
  const tests = evalData.smokeTests || [];
  const allPass = tests.every(t => t.status === 'pass');
  const anyFail = tests.some(t => t.status === 'fail');
  const cls = allPass ? 'verdict-badge--pass' : anyFail ? 'verdict-badge--fail' : 'verdict-badge--pending';
  const label = allPass ? 'PASS' : anyFail ? 'FAIL' : 'PENDING';
  $('smoke-verdict').className = `verdict-badge ${cls}`;
  $('smoke-verdict').textContent = label;

  $('smoke-list').innerHTML = tests.map((t, i) => `
    <div class="smoke-item">
      <div class="smoke-item__id">${esc(t.id)}</div>
      <div class="smoke-item__desc"><strong>${esc(t.name)}</strong><br/><span class="muted">${esc(t.description)}</span></div>
      <select data-smoke-idx="${i}">
        <option value="pass" ${t.status==='pass'?'selected':''}>Pass</option>
        <option value="partial" ${t.status==='partial'?'selected':''}>Partial</option>
        <option value="fail" ${t.status==='fail'?'selected':''}>Fail</option>
      </select>
      <input type="text" data-smoke-note-idx="${i}" value="${esc(t.notes || '')}" placeholder="Notes..." />
    </div>
  `).join('');
}

$('smoke-save').addEventListener('click', async () => {
  const tests = (evalData?.smokeTests || []).map((t, i) => {
    const sel = document.querySelector(`[data-smoke-idx="${i}"]`);
    const note = document.querySelector(`[data-smoke-note-idx="${i}"]`);
    return { ...t, status: sel?.value || t.status, notes: note?.value || '' };
  });
  await api('/api/smoke-tests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tests }),
  });
  evalData.smokeTests = tests;
  renderSmokeTests();
  alert('Saved.');
});

// ── Evals ──

function renderEvals() {
  if (!evalData) return;
  const dims = evalData.evalDimensions;
  const suppliers = filteredSuppliers();
  const categories = {};
  Object.entries(dims).forEach(([k, v]) => {
    if (!categories[v.category]) categories[v.category] = [];
    categories[v.category].push({ key: k, ...v });
  });

  let catHtml = '';
  let dimHtml = '';
  Object.entries(categories).forEach(([cat, dimList]) => {
    let total = 0, count = 0;
    dimList.forEach(d => {
      suppliers.forEach(s => {
        const v = (s.dimensions || {})[d.key];
        if (v === 'pass') { total += 1; count++; }
        else if (v === 'partial') { total += 0.5; count++; }
        else if (v === 'fail') { count++; }
      });
    });
    const pct = count ? Math.round(total / count * 100) : 0;
    const color = pct >= 80 ? 'kpi-card__value--ok' : pct >= 50 ? 'kpi-card__value--warn' : 'kpi-card__value--danger';
    catHtml += `<div class="eval-cat-card"><div class="eval-cat-card__pct ${color}">${pct}%</div><div class="eval-cat-card__label">${esc(cat)}</div></div>`;

    dimHtml += `<details ${cat === 'Core Quality' ? 'open' : ''}><summary>${esc(cat)}</summary>`;
    dimList.forEach(d => {
      let dTotal = 0, dCount = 0;
      suppliers.forEach(s => {
        const v = (s.dimensions || {})[d.key];
        if (v === 'pass') { dTotal += 1; dCount++; }
        else if (v === 'partial') { dTotal += 0.5; dCount++; }
        else if (v === 'fail') { dCount++; }
      });
      const dPct = dCount ? (dTotal / dCount) : 0;
      const fillCls = dPct >= 0.8 ? 'eval-dim-row__fill--ok' : dPct >= 0.5 ? 'eval-dim-row__fill--warn' : 'eval-dim-row__fill--danger';
      dimHtml += `<div class="eval-dim-row">
        <div class="eval-dim-row__label">${esc(d.key)} ${esc(d.name)}</div>
        <div class="eval-dim-row__bar"><div class="eval-dim-row__fill ${fillCls}" style="width:${Math.round(dPct*100)}%"></div></div>
        <div class="eval-dim-row__score">${dPct.toFixed(2)}</div>
      </div>`;
    });
    dimHtml += '</details>';
  });

  $('eval-categories').innerHTML = catHtml;
  $('eval-dimensions').innerHTML = dimHtml;
}

// ── Conversations ──

function renderConversations() {
  const sel = $('conv-supplier-select');
  const allSuppliers = evalData?.suppliers || [];
  const suppliers = filteredSuppliers();
  const scored = suppliers.filter(s => s.score > 0);
  const unscored = suppliers.filter(s => s.score === 0);
  const allSources = [
    ...scored.map((s) => {
      const origIdx = allSuppliers.indexOf(s);
      const name = L(s.sr?.product, s.sr?.product_en) || s.caseId;
      return { id: `bench-${origIdx}`, label: `${name} — ${s.percent}% (${s.score}/${s.max})`, type: 'bench', idx: origIdx };
    }),
    ...unscored.map((s) => {
      const origIdx = allSuppliers.indexOf(s);
      const name = L(s.sr?.product, s.sr?.product_en) || s.caseId;
      return { id: `bench-${origIdx}`, label: `${name} (v2, not scored)`, type: 'bench', idx: origIdx };
    }),
    ...convos.map((c, i) => ({ id: `real-${i}`, label: `${c.supplier} — real conversation (${c.turnCount} turns)`, type: 'real', idx: i })),
  ];
  sel.innerHTML = allSources.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  if (allSources.length) loadConversation(allSources[0].id);
}

let currentConvSourceId = null;

async function loadConversation(sourceId) {
  currentConvSourceId = sourceId;
  const container = $('conv-messages');
  const statsEl = $('conv-stats');
  const translateBtn = $('conv-translate-btn');

  if (sourceId.startsWith('real-')) {
    const idx = parseInt(sourceId.split('-')[1]);
    const c = convos[idx];
    if (!c) { container.innerHTML = '<p class="muted">No data.</p>'; return; }
    statsEl.innerHTML = `<span class="badge badge--completed">${esc(c.supplier)}</span> <span>${c.turnCount} turns</span>`;
    container.innerHTML = (c.messages || []).map(m => {
      const text = globalLang === 'en' && m.content_translated ? m.content_translated : m.content;
      const cls = m.role === 'bot' ? 'chat-msg--bot' : 'chat-msg--supplier';
      return `<div class="chat-msg ${cls}"><div class="chat-msg__role">${esc(m.role)}</div>${esc(text)}</div>`;
    }).join('');
    if (translateBtn) translateBtn.style.display = 'none';
  } else if (sourceId.startsWith('bench-')) {
    const idx = parseInt(sourceId.split('-')[1]);
    const s = evalData.suppliers[idx];
    if (!s) { container.innerHTML = '<p class="muted">No data.</p>'; return; }

    const transcript = s.transcript || [];
    if (!transcript.length) {
      container.innerHTML = '<p class="muted">No transcript available for this case.</p>';
      const name = L(s.displayName || s.name, s.displayName_en || s.name_en);
      statsEl.innerHTML = `<span class="badge badge--${s.status}">${esc(s.status)}</span> ${esc(name)}`;
      if (translateBtn) translateBtn.style.display = 'none';
      return;
    }

    const scored = s.score > 0;
    const productLabel = L(s.sr?.product, s.sr?.product_en) || '?';
    statsEl.innerHTML = `<span class="badge badge--${s.status}">${esc(s.status)}</span> ` +
      (scored ? `Score: ${s.percent}% (${s.score}/${s.max}) &middot; ` : '<span class="muted">Not yet scored</span> &middot; ') +
      `${transcript.length} messages &middot; Product: ${esc(productLabel)}`;

    container.innerHTML = transcript.map(m => {
      const role = m.role || 'unknown';
      const cls = role === 'bot' ? 'chat-msg--bot' : role === 'supplier' ? 'chat-msg--supplier' : 'chat-msg--system';
      const text = globalLang === 'en' && m.content_translated ? m.content_translated : (m.content || '');
      return `<div class="chat-msg ${cls}"><div class="chat-msg__role">${esc(role)}</div><span class="msg-text">${esc(text)}</span></div>`;
    }).join('');

    if (s.evalSummary) {
      container.innerHTML += `<div class="chat-msg chat-msg--system"><div class="chat-msg__role">eval summary</div>${esc(s.evalSummary)}</div>`;
    }

    // Show translate button if there's Chinese content and we're in English mode
    const hasChinese = transcript.some(m => m.content && !/^[\x00-\x7F]*$/.test(m.content));
    const hasTranslations = transcript.some(m => m.content_translated);
    if (translateBtn) {
      translateBtn.style.display = (globalLang === 'en' && hasChinese && !hasTranslations) ? 'inline-block' : 'none';
    }
  }
}




$('conv-supplier-select').addEventListener('change', e => { loadConversation(e.target.value); });

// Translate button for bench transcripts
$('conv-translate-btn')?.addEventListener('click', async () => {
  const btn = $('conv-translate-btn');
  if (!currentConvSourceId?.startsWith('bench-')) return;
  const idx = parseInt(currentConvSourceId.split('-')[1]);
  const s = evalData.suppliers[idx];
  if (!s?.transcript?.length) return;

  btn.textContent = 'Translating...';
  btn.disabled = true;
  const supplierTexts = s.transcript.filter(m => m.role === 'supplier' && m.content && !/^[\x00-\x7F]*$/.test(m.content)).map(m => m.content);
  await translateTexts(supplierTexts);

  // Apply translations back
  s.transcript.forEach(m => {
    if (m.role === 'supplier' && m.content && translationCache.has(m.content)) {
      m.content_translated = translationCache.get(m.content);
    }
  });

  btn.textContent = 'Translate to English';
  btn.disabled = false;
  loadConversation(currentConvSourceId);
});

// ── Goals ──

function renderGoals() {
  if (!evalData) return;
  const goals = evalData.goals || [];
  const tier1 = goals.filter(g => g.tier === 1);
  const tier2 = goals.filter(g => g.tier === 2);

  $('goals-summary').innerHTML = `
    <h3>Goals for This SR</h3>
    <p>${tier1.length} Tier 1 (core) + ${tier2.length} Tier 2 (conditional) = ${goals.length} total</p>
    <p class="muted">Turn budget: min(${goals.length}+4, 14) = ${Math.min(goals.length+4, 14)} | Pass: &le;${Math.min(goals.length+4, 14)-2}</p>
  `;

  $('goals-list').innerHTML = goals.map(g => `
    <div class="goal-item">
      <div class="goal-item__tier tier-${g.tier}">T${g.tier}</div>
      <div><strong>${esc(L(g.name, g.name_en))}</strong><br/><span class="goal-item__question">${esc(L(g.question_cn, g.question_en))}</span></div>
      <div class="goal-item__field">${esc(g.field)}</div>
      <div class="muted">${esc(g.id)}</div>
    </div>
  `).join('');

  const suppliers = filteredSuppliers();
  let covHtml = '<table class="data-table"><thead><tr><th>Goal</th>';
  suppliers.forEach(s => { covHtml += `<th>${esc(s.id)}</th>`; });
  covHtml += '</tr></thead><tbody>';
  goals.forEach(g => {
    covHtml += `<tr><td>${esc(L(g.name, g.name_en))}</td>`;
    suppliers.forEach(s => {
      const achieved = s.percent >= 70;
      covHtml += `<td class="${achieved ? 'conf-high' : 'conf-low'}">${achieved ? '✓' : '—'}</td>`;
    });
    covHtml += '</tr>';
  });
  covHtml += '</tbody></table>';
  $('goals-coverage').innerHTML = covHtml;
}

// ── Structured Output ──

function renderStructured() {
  if (!evalData) return;
  const suppliers = filteredSuppliers();
  $('structured-table').insertAdjacentHTML('beforebegin',
    '<div class="warning-banner">Placeholder data — extraction results shown below are estimated from overall scores, not actual per-field extraction. Real extraction data will be connected when the live pipeline is enabled.</div>');
  const fields = [
    { name: 'MOQ', db: 'product_variants.moq' },
    { name: 'Unit Price', db: 'product_variants.unit_price' },
    { name: 'Lead Time', db: 'product_variants.lead_time' },
    { name: 'Sample Terms', db: 'sample.terms' },
    { name: 'Packing', db: 'packaging.description' },
    { name: 'Tooling', db: 'tooling.cost' },
    { name: 'Artwork', db: 'artwork.requirements' },
    { name: 'Color/Finish', db: 'product_variants.color_finish' },
    { name: 'Customization', db: 'product_variants.customization' },
    { name: 'Certification', db: 'certification.type' },
    { name: 'Material', db: 'material.spec' },
    { name: 'Shipping', db: 'shipping.method' },
    { name: 'Payment', db: 'payment.terms' },
    { name: 'Size/Variant', db: 'product_variants.size' },
  ];

  let html = '<table class="data-table"><thead><tr><th>Field</th><th>DB Target</th>';
  suppliers.slice(0, 6).forEach(s => { html += `<th>${esc(s.id)}</th>`; });
  html += '</tr></thead><tbody>';
  fields.forEach(f => {
    html += `<tr><td>${esc(f.name)}</td><td class="muted" style="font-family:monospace;font-size:0.75rem">${esc(f.db)}</td>`;
    suppliers.slice(0, 6).forEach(s => {
      const conf = s.percent >= 80 ? 'high' : s.percent >= 60 ? 'medium' : 'low';
      const val = s.percent >= 50 ? 'Extracted' : '—';
      html += `<td><span class="conf-${conf}">${val}</span></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  $('structured-table').innerHTML = html;

  $('quotation-readiness').innerHTML = suppliers.slice(0, 6).map(s => {
    const ready = s.percent >= 80;
    return `<div class="readiness-card">${esc(s.id)}: <strong class="${ready ? 'conf-high' : 'conf-medium'}">${ready ? 'Yes' : 'Partially'}</strong></div>`;
  }).join('');
}

// ── Insert ──

$('insert-convo').addEventListener('input', () => {
  $('insert-gemini-eval').disabled = !$('insert-convo').value.trim();
});

$('insert-gemini-eval').addEventListener('click', async () => {
  const convo = $('insert-convo').value.trim();
  if (!convo) { alert('Paste a conversation transcript first.'); return; }
  const btn = $('insert-gemini-eval');
  const origText = btn.textContent;
  btn.textContent = 'Scoring...';
  btn.disabled = true;
  try {
    const result = await api('/api/auto-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation: convo }),
    });
    const scores = result.scores || {};
    // Populate manual score fields
    const items = $('insert-manual-scores').querySelectorAll('.smoke-item');
    items.forEach(item => {
      const dimId = item.querySelector('.smoke-item__id')?.textContent?.trim();
      if (dimId && scores[dimId]) {
        const sel = item.querySelector('select');
        const input = item.querySelector('input[type="text"]');
        if (sel) sel.value = scores[dimId].score || 'n/a';
        if (input) input.value = scores[dimId].notes || '';
      }
    });
    btn.textContent = 'Scored \u2713';
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
  } catch (e) {
    alert('Auto-score failed: ' + e.message);
    btn.textContent = origText;
    btn.disabled = false;
  }
});

$('insert-save').addEventListener('click', async () => {
  const scores = {};
  $('insert-manual-scores').querySelectorAll('.smoke-item').forEach(item => {
    const dim = item.dataset.dim;
    const sel = item.querySelector('select');
    const input = item.querySelector('input[type="text"]');
    if (dim && sel && sel.value !== 'n/a') {
      scores[dim] = { score: sel.value, notes: input?.value || '' };
    }
  });
  const data = {
    sr: $('insert-sr').value,
    supplierId: $('insert-supplier-id').value,
    supplierName: $('insert-supplier-name').value,
    status: $('insert-status').value,
    date: $('insert-date').value,
    msgCount: $('insert-msg-count').value,
    goalsTotal: $('insert-goals-total').value,
    goalsAchieved: $('insert-goals-achieved').value,
    conversation: $('insert-convo').value,
    scores: Object.keys(scores).length ? scores : undefined,
  };
  if (!data.conversation.trim()) { alert('Please paste a conversation transcript first.'); return; }
  try {
    const result = await api('/api/insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    $('insert-save').textContent = 'Saved \u2713';
    setTimeout(() => { $('insert-save').textContent = 'Save'; }, 2000);
    // Reload eval data to show inserted conversation on dashboard
    const freshData = await api('/api/eval-data');
    evalData = freshData;
    reRenderAll();
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
});

function renderInsertManualScores() {
  if (!evalData) return;
  const dims = evalData.evalDimensions;
  $('insert-manual-scores').innerHTML = Object.entries(dims).map(([k, v]) => `
    <div class="smoke-item" data-dim="${esc(k)}" style="margin-bottom:6px">
      <div class="smoke-item__id">${esc(k)}</div>
      <div class="smoke-item__desc">${esc(v.name)}<br/><span class="muted">${esc(v.category)}</span></div>
      <select><option value="pass">Pass</option><option value="partial">Partial</option><option value="fail">Fail</option><option value="n/a" selected>N/A</option></select>
      <input type="text" placeholder="Notes..." />
    </div>
  `).join('');
}

// ── Benchmark ──

function renderBenchmark() {
  if (!evalData) return;
  const bench = evalData.benchmark;
  const nelson = evalData.nelsonBaseline;
  const diff = (bench.currentAvg - nelson.avgScore).toFixed(1);
  const ahead = diff >= 0;

  $('bench-banner').innerHTML = `
    <div class="bench-banner__title">${esc(bench.currentSR)} ${bench.currentAvg}% vs ${esc(nelson.label)} ${nelson.avgScore}% &mdash; ${ahead ? '+' : ''}${diff}pp ${ahead ? 'ahead' : 'behind'}</div>
    <div class="bench-banner__detail">Pass: ${bench.passCount}/${bench.caseCount} cases | Threshold: ${bench.passThreshold}%</div>
  `;

  const funnel = nelson.funnel;
  $('bench-funnel').innerHTML = `<h3>Nelson Baseline Funnel (${nelson.totalConversations} conversations)</h3>
    <div class="funnel-row">${Object.entries(funnel).map(([k, v]) => `
      <div class="funnel-stage"><div class="funnel-stage__count">${v.count}</div><div class="funnel-stage__label">${esc(k)}</div><div class="funnel-stage__pct">${v.percent}%</div></div>
    `).join('')}</div>`;

  const dist = nelson.scoreDistribution || [];
  const maxCount = Math.max(...dist.map(d => d.count), 1);
  $('bench-distribution').innerHTML = `<h3>Score Distribution (Nelson Baseline)</h3>` +
    dist.map(d => `<div class="dist-bar-row">
      <div class="dist-bar-row__label">${esc(d.band)}</div>
      <div class="dist-bar-row__bar"><div class="dist-bar-row__fill" style="width:${Math.round(d.count/maxCount*100)}%"></div></div>
      <div class="dist-bar-row__count">${d.count}</div>
    </div>`).join('');

  $('bench-comparison').innerHTML = '';
}

// ── Interactive Chat ──

function wireChat(inputId, sendId, resetId, messagesId) {
  const input = $(inputId);
  const sendBtn = $(sendId);
  const resetBtn = $(resetId);
  const container = $(messagesId);
  if (!input || !sendBtn || !container) return;

  let sessionId = 'session-' + Date.now();

  function msgHtml(role, text, toolCalls) {
    const cls = role === 'supplier' ? 'chat-msg--supplier' : role === 'bot' ? 'chat-msg--bot' : 'chat-msg--system';
    const tools = (toolCalls || []).map(tc =>
      `<div class="chat-tool"><strong>${esc(tc.name)}</strong>: ${esc(JSON.stringify(tc.args || {}).slice(0, 200))}</div>`
    ).join('');
    return `<div class="chat-msg ${cls}"><div class="chat-msg__role">${esc(role)}</div><div>${esc(text)}</div>${tools}</div>`;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    container.innerHTML += msgHtml('supplier', text);
    container.scrollTop = container.scrollHeight;
    sendBtn.disabled = true;
    sendBtn.textContent = '...';
    try {
      const res = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      });
      container.innerHTML += msgHtml('bot', res.reply || '(no reply)', res.toolCalls);
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      container.innerHTML += msgHtml('system', 'Error: ' + e.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      input.focus();
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await api('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
      sessionId = 'session-' + Date.now();
      container.innerHTML = '<p class="muted">Chat reset. Type a new supplier message.</p>';
    });
  }
}

// ── Re-render all + global controls ──

function reRenderAll() {
  renderDashboard();
  renderSmokeTests();
  renderEvals();
  renderConversations();
  renderGoals();
  renderStructured();
  renderInsertManualScores();
  renderBenchmark();
  populateSrFilter();
  populateInsertSrSuggestions();
  // Re-render playground case selector and reload current case
  if (window._populatePgCases) {
    window._populatePgCases();
    const pgCaseSel = $('pg-case-select');
    if (pgCaseSel && pgCaseSel.value) {
      pgCaseSel.dispatchEvent(new Event('change'));
    }
  }
}

function populateSrFilter() {
  const sel = $('sr-select');
  const srIds = new Set();
  srIds.add(evalData?.sr?.id || 'SR-3937');
  (evalData?.suppliers || []).forEach(s => { if (s._sr) srIds.add(s._sr); });
  sel.innerHTML = '<option value="all">All SRs</option>' +
    [...srIds].map(id => `<option value="${esc(id)}" ${id === activeSrFilter ? 'selected' : ''}>${esc(id)}</option>`).join('');
}

function populateInsertSrSuggestions() {
  const dl = $('sr-suggestions');
  if (!dl) return;
  const srIds = new Set();
  srIds.add(evalData?.sr?.id || 'SR-3937');
  (evalData?.suppliers || []).forEach(s => { if (s._sr) srIds.add(s._sr); });
  dl.innerHTML = [...srIds].map(id => `<option value="${esc(id)}">`).join('');
}

// Global language toggle
document.querySelectorAll('input[name="global-lang"]').forEach(r => r.addEventListener('change', (e) => {
  globalLang = e.target.value;
  reRenderAll();
}));

// SR filter
$('sr-select').addEventListener('change', (e) => {
  activeSrFilter = e.target.value;
  reRenderAll();
});

// ── Boot ──

const [evalRes, convRes, scenRes, capRes] = await Promise.all([
  api('/api/eval-data'),
  api('/api/conversations'),
  api('/api/scenarios'),
  api('/api/capabilities'),
]);

evalData = evalRes;
convos = convRes.conversations || [];
scenarios = scenRes.scenarios || [];
capabilities = capRes;

renderDashboard();
renderSmokeTests();
renderEvals();
renderConversations();
renderGoals();
renderStructured();
renderInsertManualScores();
renderBenchmark();
populateSrFilter();
populateInsertSrSuggestions();
wireChat('interactive-chat-input', 'interactive-chat-send', 'interactive-chat-reset', 'interactive-chat-messages');

showPage('dashboard');


// ── Playground chat with custom SR/goals ──

(function wirePlayground() {
  const caseSel = $('pg-case-select');
  const timeline = $('pg-timeline');
  const forkZone = $('pg-fork-zone');
  const banner = $('pg-mode-banner');
  if (!caseSel || !timeline) return;

  let currentCase = null;
  let forkSessionId = null;
  let forkTurnIndex = -1;

  // Mode detection
  fetch('/api/chat/status').then(r => r.json()).then(s => {
    if (s.mode === 'live') {
      banner.innerHTML = '<span style="color:#16a34a;font-weight:600">&#9679; Live Mode</span> — Forked turns run through the real Gemini pipeline.';
      banner.style.cssText = 'background:#f0fdf4;border:1px solid #bbf7d0;padding:10px 14px;border-radius:6px;font-size:0.9em';
    } else {
      banner.innerHTML = '<span style="color:#ca8a04;font-weight:600">&#9679; Demo Mode</span> — Forked turns use simulated responses. Set <code>GEMINI_API_KEY</code> + <code>SUPPLIER_BOT_HARNESS_LIVE=1</code> for real pipeline.';
      banner.style.cssText = 'background:#fefce8;border:1px solid #fde68a;padding:10px 14px;border-radius:6px;font-size:0.9em';
    }
  }).catch(() => {});

  // Populate case selector
  const suppliers = evalData?.suppliers || [];
  window._populatePgCases = function() {
    const filtered = filteredSuppliers();
    caseSel.innerHTML = filtered.map((s) => {
      const origIdx = suppliers.indexOf(s);
      const label = L(s.sr?.product, s.sr?.product_en) || s.caseId;
      const scored = s.score > 0 ? ` — ${s.percent}% (${s.score}/${s.max})` : ' (not scored)';
      return `<option value="${origIdx}">${esc(label)}${scored}</option>`;
    }).join('');
  };
  window._populatePgCases();

  function loadCase(idx) {
    const s = suppliers[idx];
    if (!s) return;
    currentCase = s;
    closeFork();

    // Context bar
    const sr = s.sr || {};
    $('pg-product').value = L(sr.product, sr.product_en) || '';
    $('pg-quantity').value = sr.quantity || '';
    $('pg-specs').value = L(sr.specs, sr.specs_en) || '';
    $('pg-price').value = sr.price || '';
    $('pg-custom').value = L(sr.customization, sr.customization_en) || '';
    $('pg-ctx-summary').textContent = `${L(sr.product, sr.product_en) || '?'} · ${sr.quantity || '?'} · ${s.goals?.length || 0} goals · ${s.turns?.length || 0} turns`;

    // Goal chips
    const gc = s.pipelineTrace?.goalCompletion || {};
    const achieved = new Set([...(gc.tier1_achieved || []), ...(gc.tier2_achieved || [])]);
    const missed = new Set([...(gc.tier1_missed || []), ...(gc.tier2_missed || [])]);
    const goalsEl = $('pg-goals-chips');
    goalsEl.innerHTML = (s.goals || []).map(g => {
      const status = achieved.has(g.id) ? 'achieved' : missed.has(g.id) ? 'missed' : 'pending';
      const icon = status === 'achieved' ? '✓' : status === 'missed' ? '✗' : '·';
      return `<span class="goal-chip goal-chip--${status}" title="Tier ${g.tier || '?'}">${icon} ${esc(L(g.name, g.name_en))}</span>`;
    }).join('');

    // Populate editable goals
    const goalsEdit = $('pg-goals-edit');
    if (goalsEdit) goalsEdit.value = (s.goals || []).map(g => `${g.id} — ${L(g.name, g.name_en)} — T${g.tier || 1}`).join('\n');

    // Context field — default empty (matches eval runs where no cross-supplier context was injected)
    const ctxEl = $('pg-context');
    if (ctxEl) ctxEl.value = '';

    // Turn timeline
    renderTimeline(s);

    // Eval + output
    renderEvalPanel(s);
  }

  function renderTimeline(s) {
    const turns = s.turns || [];
    timeline.innerHTML = turns.map((t, ti) => {
      let body = '';

      // Supplier inputs
      for (const msg of t.supplierInputs) {
        const translated = (globalLang === 'en' && t._supplierInputs_en) ? t._supplierInputs_en[t.supplierInputs.indexOf(msg)] : null;
        const text = translated || msg;
        body += `<div class="turn-msg"><span class="turn-msg__role turn-msg__role--supplier">supplier</span><span class="turn-msg__content">${esc(text)}</span></div>`;
      }

      // Bot response
      if (t.botResponse) {
        body += `<div class="turn-msg"><span class="turn-msg__role turn-msg__role--bot">bot</span><span class="turn-msg__content">${esc(t.botResponse)}</span></div>`;
      } else if (t.type === 'exchange') {
        body += `<div class="turn-msg--no-response">⚠ Bot did not respond</div>`;
      }

      // Annotations
      const annHtml = t.annotations.map(a => {
        const cls = a.verdict === 'pass' ? 'pass' : a.verdict === 'fail' ? 'fail' : 'partial';
        return `<span class="turn-annotation turn-annotation--${cls}" title="${esc(a.note || '')}">${esc(a.dim)}: ${esc(a.verdict)}</span>`;
      }).join('');

      const forkBtn = t.type === 'exchange' ? `<button class="turn-card__fork-btn" data-turn="${ti}">⑂ Fork here</button>` : '';
      const typeLabel = t.type === 'bot_opening' ? 'opening' : `turn`;

      return `<div class="turn-card" data-turn-index="${ti}">
        <div class="turn-card__header">
          <span class="turn-card__index">T${ti}</span>
          <span class="turn-card__type">${typeLabel}</span>
          <div class="turn-card__annotations">${annHtml}</div>
          ${forkBtn}
        </div>
        <div class="turn-card__body">${body}</div>
      </div>`;
    }).join('');
  }

  function renderEvalPanel(s) {
    const trace = s.pipelineTrace || {};
    const dims = evalData?.evalDimensions || {};
    const dimMap = {
      'E1': 'goalCompletion', 'E2': 'oneQuestion', 'E3': 'turnEfficiency', 'E4': 'noHallucination',
      'E5': 'extractability', 'E6': 'autoResponse', 'E7': 'naturalness', 'E8': 'rejectionRecovery',
      'E9': 'customization', 'E10': 'imageRead', 'E11': 'imageSend', 'E12': 'escalation',
      'E13': 'scheduler', 'E14': 'continuation',
    };
    let evalHtml = '<div class="eval-dim-grid">';
    for (const [key, traceKey] of Object.entries(dimMap)) {
      const dim = dims[key] || {};
      const d = trace[traceKey] || {};
      const verdict = d.verdict || d.score;
      if (verdict === undefined) { evalHtml += `<div class="eval-dim-card"><div class="eval-dim-card__head"><span class="eval-dim-card__name">${esc(key)}: ${esc(dim.name || '')}</span><span class="eval-dim-card__verdict eval-dim-card__verdict--na">—</span></div></div>`; continue; }
      const vClass = typeof verdict === 'string' ? (verdict === 'pass' ? 'pass' : verdict === 'partial' ? 'partial' : verdict === 'fail' ? 'fail' : 'na') : (verdict >= 0.8 ? 'pass' : verdict >= 0.4 ? 'partial' : 'fail');
      const vLabel = typeof verdict === 'number' ? (verdict * 100).toFixed(0) + '%' : verdict;
      evalHtml += `<div class="eval-dim-card"><div class="eval-dim-card__head"><span class="eval-dim-card__name">${esc(key)}: ${esc(dim.name || '')}</span><span class="eval-dim-card__verdict eval-dim-card__verdict--${vClass}">${esc(vLabel)}</span></div>`;
      if (d.notes) evalHtml += `<div class="eval-dim-card__notes">${esc(d.notes)}</div>`;
      evalHtml += '</div>';
    }
    evalHtml += '</div>';
    $('pg-eval-grid').innerHTML = evalHtml;

    const badge = $('pg-eval-badge');
    if (badge) {
      badge.textContent = s.score > 0 ? `${s.percent}%` : '—';
      badge.className = 'pipeline-stage__badge pipeline-stage__badge--' + (s.percent >= 75 ? 'pass' : s.percent >= 50 ? 'partial' : s.score > 0 ? 'fail' : 'info');
    }

    $('pg-eval-summary').innerHTML = s.evalSummary ? esc(s.evalSummary) : '<span class="muted">Not scored yet.</span>';

    const card = s.supplierCard || {};
    const cardKeys = Object.keys(card);
    $('pg-output-card').innerHTML = cardKeys.length
      ? '<table class="supplier-card-table">' + cardKeys.map(k => `<tr><th>${esc(k)}</th><td>${esc(String(card[k] ?? '—'))}</td></tr>`).join('') + '</table>'
      : '<p class="muted">No structured output for this case.</p>';
  }

  // Fork from a specific turn
  function startFork(turnIndex) {
    if (!currentCase) return;
    const turns = currentCase.turns || [];
    forkTurnIndex = turnIndex;
    forkSessionId = 'fork-' + Date.now();

    fetch('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: forkSessionId }) });

    document.querySelectorAll('.turn-card').forEach(c => c.classList.remove('is-fork-point'));
    const forkCard = document.querySelector(`.turn-card[data-turn-index="${turnIndex}"]`);
    if (forkCard) forkCard.classList.add('is-fork-point');

    // Build history up to fork point
    const historyBeforeFork = [];
    for (let i = 0; i < turnIndex; i++) {
      const t = turns[i];
      for (const msg of t.supplierInputs) historyBeforeFork.push({ role: 'supplier', content: msg });
      if (t.botResponse) historyBeforeFork.push({ role: 'bot', content: t.botResponse });
    }

    const forkMsgs = $('pg-fork-messages');
    const originalTurn = turns[turnIndex];

    // Render prior turns as chat bubbles for context
    let html = '<div class="fork-context-label">Prior conversation (T0–T' + (turnIndex - 1) + '):</div>';
    for (const m of historyBeforeFork) {
      const cls = m.role === 'bot' ? 'chat-msg--bot' : 'chat-msg--supplier';
      html += `<div class="chat-msg ${cls} chat-msg--faded"><div class="chat-msg__role">${esc(m.role)}</div>${esc(m.content)}</div>`;
    }

    // Show the original turn being forked — as individual bubbles
    html += `<div class="fork-divider">&#9548; Original Turn ${turnIndex} (fork point):</div>`;
    for (const msg of originalTurn.supplierInputs) {
      html += `<div class="chat-msg chat-msg--supplier"><div class="chat-msg__role">supplier</div>${esc(msg)}</div>`;
    }
    if (originalTurn.botResponse) {
      html += `<div class="chat-msg chat-msg--bot"><div class="chat-msg__role">bot</div>${esc(originalTurn.botResponse)}</div>`;
    } else {
      html += `<div class="chat-msg chat-msg--system"><div class="chat-msg__role">system</div>Bot did not respond at this turn.</div>`;
    }

    // Annotations
    for (const a of (originalTurn.annotations || [])) {
      const cls = a.verdict === 'pass' ? 'pass' : a.verdict === 'fail' ? 'fail' : 'partial';
      html += `<div class="chat-msg chat-msg--system"><div class="chat-msg__role">${esc(a.dim)}</div><span class="turn-annotation turn-annotation--${cls}">${esc(a.verdict)}</span> ${esc(a.note || '')}</div>`;
    }

    html += `<div class="fork-divider">&#9548; Your fork starts here — change any input above (SR, goals) and type below:</div>`;
    forkMsgs.innerHTML = html;

    // Highlight context panel as editable for fork
    document.querySelector('.pipeline-context')?.classList.add('is-fork-active');
    document.querySelector('.pipeline-context')?.setAttribute('open', '');

    forkZone.style.display = 'block';
    $('pg-fork-label').textContent = `Fork at Turn ${turnIndex} — edit SR/goals above, then type alternative supplier messages`;
    $('pg-chat-input').focus();
    forkZone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Pre-load history
    const sr = { product: $('pg-product').value, quantity: $('pg-quantity').value, specs: $('pg-specs').value, price: $('pg-price').value, customization: $('pg-custom').value };
    const goalsText = $('pg-goals-edit')?.value || '';
    const goals = goalsText.split('\n').filter(Boolean).map(l => { const p = l.split('—').map(s => s.trim()); return { id: p[0], name: p[1] || p[0], tier: parseInt(p[2]?.replace('T','')) || 1 }; });
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '__init__', sessionId: forkSessionId, sr, goals, contextText: $('pg-context')?.value || '', prefillHistory: historyBeforeFork }),
    }).catch(() => {});
  }

  function closeFork() {
    forkZone.style.display = 'none';
    document.querySelector('.pipeline-context')?.classList.remove('is-fork-active');
    forkTurnIndex = -1;
    forkSessionId = null;
    document.querySelectorAll('.turn-card').forEach(c => c.classList.remove('is-fork-point'));
  }

  function addForkMsg(role, content, extra) {
    const forkMsgs = $('pg-fork-messages');
    const cls = role === 'bot' ? 'chat-msg--bot' : role === 'supplier' ? 'chat-msg--supplier' : 'chat-msg--system';
    let html = `<div class="chat-msg ${cls}"><div class="chat-msg__role">${esc(role)}</div>${esc(content)}`;
    if (extra?.toolCalls?.length) {
      html += '<div style="margin-top:4px;font-size:0.85em;color:#666">';
      extra.toolCalls.forEach(tc => { html += `<div>🔧 ${esc(tc.name || '?')}(${esc(JSON.stringify(tc.args || {}))})</div>`; });
      html += '</div>';
    }
    html += '</div>';
    forkMsgs.innerHTML += html;
    forkMsgs.scrollTop = forkMsgs.scrollHeight;
  }

  async function sendForkMsg() {
    const input = $('pg-chat-input');
    const text = input.value.trim();
    if (!text || !forkSessionId) return;
    input.value = '';
    addForkMsg('supplier', text);

    const sendBtn = $('pg-chat-send');
    sendBtn.disabled = true; sendBtn.textContent = '…';
    try {
      const sr = { product: $('pg-product').value, quantity: $('pg-quantity').value, specs: $('pg-specs').value, price: $('pg-price').value, customization: $('pg-custom').value };
      const goalsText = $('pg-goals-edit')?.value || '';
      const goals = goalsText.split('\n').filter(Boolean).map(l => { const p = l.split('—').map(s => s.trim()); return { id: p[0], name: p[1] || p[0], tier: parseInt(p[2]?.replace('T','')) || 1 }; });
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: forkSessionId, sr, goals, contextText: $('pg-context')?.value || '' }),
      });
      const data = await r.json();
      if (data.reply) {
        const tag = data.adapterMode === 'live' ? '' : ' [demo]';
        addForkMsg('bot', data.reply + tag, { toolCalls: data.toolCalls });
        if (data.contextInjected) {
          addForkMsg('system', '↑ Cross-supplier context was injected into this turn.');
        }
      }
    } catch (e) { addForkMsg('system', 'Error: ' + e.message); }
    sendBtn.disabled = false; sendBtn.textContent = 'Send';
  }

  // Event: click fork button on a turn
  timeline.addEventListener('click', e => {
    const btn = e.target.closest('.turn-card__fork-btn');
    if (btn) startFork(parseInt(btn.dataset.turn));
  });

  // Event: send in fork zone
  $('pg-chat-send')?.addEventListener('click', sendForkMsg);
  $('pg-chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendForkMsg(); });
  $('pg-fork-cancel')?.addEventListener('click', closeFork);

  // Event: case change
  caseSel.addEventListener('change', () => loadCase(parseInt(caseSel.value)));

  // Event: translate timeline
  $('pg-translate-btn')?.addEventListener('click', async () => {
    if (!currentCase) return;
    const btn = $('pg-translate-btn');
    const turns = currentCase.turns || [];

    // Collect all Chinese supplier messages
    const allTexts = [];
    const textMap = []; // [{turnIdx, msgIdx}]
    turns.forEach((t, ti) => {
      (t.supplierInputs || []).forEach((msg, mi) => {
        if (msg && !/^[\x00-\x7F]*$/.test(msg)) {
          allTexts.push(msg);
          textMap.push({ ti, mi });
        }
      });
    });

    if (!allTexts.length) { btn.textContent = 'Nothing to translate'; setTimeout(() => { btn.textContent = 'Translate to English'; }, 1500); return; }

    btn.textContent = `Translating ${allTexts.length} messages...`;
    btn.disabled = true;

    const translated = await translateTexts(allTexts);

    // Store translations on the turn objects
    textMap.forEach(({ ti, mi }, i) => {
      const t = turns[ti];
      if (!t._supplierInputs_en) t._supplierInputs_en = [...t.supplierInputs];
      t._supplierInputs_en[mi] = translationCache.get(allTexts[i]) || allTexts[i];
    });

    btn.textContent = 'Translated!';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Translate to English'; }, 1500);

    // Re-render the timeline with translations
    renderTimeline(currentCase);
  });

  // Init
  if (suppliers.length) loadCase(0);
})();
