const API = {
  health: '/api/health',
  loadDataset: '/api/dataset/load',
  datasetStatus: '/api/dataset/status',
  searchPersonas: '/api/personas/search',
  analyze: '/api/analyze',
  simulate: '/api/simulate',
  report: '/api/report'
};

const state = {
  backendOnline: false,
  datasetLoaded: false,
  datasetMeta: null,
  filteredTotal: null,
  busy: false,
  lastReport: null
};

const $ = id => document.getElementById(id);

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function valueOf(id) {
  const el = $(id);
  return el ? el.value.trim() : '';
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setHTML(id, value) {
  const el = $(id);
  if (el) el.innerHTML = value;
}

function showMessage(messages, tone = 'error') {
  const box = $('validation-errors');
  if (!box) return;
  const list = Array.isArray(messages) ? messages : [messages];
  box.className = tone === 'success' ? 'validation-errors success-msg' : 'validation-errors';
  box.innerHTML = list.map(m => `<div>${escapeHTML(m)}</div>`).join('');
  box.classList.remove('hidden');
}

function clearMessage() {
  const box = $('validation-errors');
  if (!box) return;
  box.classList.add('hidden');
  box.innerHTML = '';
}

function buttonBusy(button, label) {
  if (!button) return;
  button.dataset.original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="loading-inline"><span class="spinner"></span>${escapeHTML(label)}</span>`;
}

function buttonReady(button) {
  if (!button) return;
  button.disabled = false;
  if (button.dataset.original) {
    button.innerHTML = button.dataset.original;
    delete button.dataset.original;
  }
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch (_) { data = { error: text }; }
  }
  if (!response.ok) {
    const err = new Error(data.error || data.errors?.join(' ') || `Request failed with ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

function normalizeMeta(meta = {}) {
  const total = Number(meta.total_personas ?? meta.persona_count ?? 0) || 0;
  const parquetFiles = Number(meta.parquet_files ?? meta.parquetFiles ?? 3) || 3;
  const areaValues = Object.keys(meta.area_distribution || {});
  return {
    loaded: Boolean(meta.loaded || total > 0),
    total,
    splits: meta.splits_text || meta.split || 'train',
    parquetFiles,
    source: meta.source || 'NVIDIA / HuggingFace',
    departments: Array.isArray(meta.departments) ? meta.departments : [],
    municipalities: Array.isArray(meta.municipalities) ? meta.municipalities : [],
    educationLevels: Array.isArray(meta.education_levels) ? meta.education_levels : [],
    occupations: Array.isArray(meta.occupations) ? meta.occupations : [],
    areas: areaValues.length ? areaValues : ['Urban', 'Rural']
  };
}

function updateHealth(status) {
  const dot = $('health-dot');
  if (!dot) return;
  dot.classList.remove('ok', 'error');
  if (status === 'ok') dot.classList.add('ok');
  if (status === 'error') dot.classList.add('error');
}

function updateDataset(metaInput) {
  const meta = normalizeMeta(metaInput);
  state.datasetMeta = meta;
  state.datasetLoaded = Boolean(meta.loaded);
  setText('dataset-status-value', state.datasetLoaded ? 'Connected' : 'Standby');
  setText('dataset-personas-value', String(meta.total));
  setText('dataset-source-value', meta.source);
  setText('dataset-splits-value', Array.isArray(meta.splits) ? meta.splits.join(', ') : meta.splits);
  setText('dataset-parquet-value', String(meta.parquetFiles));
  setText('rail-personas-count', String(meta.total));
  setText('rail-status-label', state.backendOnline ? 'Connected' : 'Offline');
  const datasetPanel = $('dataset-section');
  if (datasetPanel) datasetPanel.classList.toggle('loaded', state.datasetLoaded);
  const loadButton = $('btn-load');
  if (loadButton && state.datasetLoaded) loadButton.textContent = 'Reload Dataset';
  populateFilters(meta);
}

function fillSelect(id, values, keepCurrent = true) {
  const select = $(id);
  if (!select) return;
  const current = keepCurrent ? select.value : '';
  const clean = [...new Set((values || []).filter(Boolean).map(v => String(v).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All</option>' + clean.slice(0, 120).map(v => `<option value="${escapeHTML(v)}">${escapeHTML(v)}</option>`).join('');
  if (current && clean.includes(current)) select.value = current;
}

function populateFilters(meta) {
  fillSelect('f-dept', meta.departments);
  fillSelect('f-muni', meta.municipalities);
  fillSelect('f-area', meta.areas);
  fillSelect('f-edu', meta.educationLevels);
  fillSelect('f-occ', meta.occupations);
}

function ageRange(value) {
  if (!value) return {};
  if (value === '60+') return { minAge: 60 };
  const parts = value.split('-').map(p => Number(p));
  return { minAge: parts[0], maxAge: parts[1] };
}

function currentFilters() {
  const ages = ageRange(valueOf('f-age'));
  return {
    department: valueOf('f-dept'),
    municipality: valueOf('f-muni'),
    area: valueOf('f-area'),
    education_level: valueOf('f-edu'),
    occupation: valueOf('f-occ'),
    minAge: ages.minAge || undefined,
    maxAge: ages.maxAge || undefined
  };
}

function hasActiveFilters(filters) {
  return Object.values(filters).some(v => v !== undefined && v !== '');
}

async function checkHealth() {
  try {
    const data = await requestJSON(API.health);
    state.backendOnline = data.status === 'ok';
    updateHealth('ok');
    setText('rail-status-label', 'Connected');
    if (data.cache_loaded) {
      updateDataset({ loaded: true, total_personas: data.persona_count || 0 });
      await refreshDatasetStatus();
    }
  } catch (_) {
    state.backendOnline = false;
    updateHealth('error');
    setText('rail-status-label', 'Offline');
    setText('dataset-status-value', 'Offline');
  }
}

async function refreshDatasetStatus() {
  try {
    const data = await requestJSON(API.datasetStatus);
    if (data.loaded) {
      updateDataset(data);
      setText('filter-context', `${normalizeMeta(data).total} personas available for filtered analysis.`);
      return true;
    }
    state.datasetLoaded = false;
    setText('filter-context', 'Load the dataset to activate real persona filters.');
    return false;
  } catch (_) {
    return false;
  }
}

async function loadDataset(options = {}) {
  const button = $('btn-load');
  const silent = Boolean(options.silent);
  if (!silent) {
    clearMessage();
    buttonBusy(button, 'Loading dataset');
  }
  try {
    const data = await requestJSON(API.loadDataset, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'progressive', batchSize: 100, maxRows: 5000 })
    });
    updateHealth('ok');
    state.backendOnline = true;
    updateDataset(data);
    setText('filter-context', `${normalizeMeta(data).total} personas connected. Filters now refine the analysis lens.`);
    if (!silent) showMessage('Dataset connected and ready for simulation.', 'success');
    return data;
  } catch (err) {
    updateHealth('error');
    const message = err.data?.error || err.message || 'Dataset route unavailable.';
    if (!silent) showMessage(message);
    throw err;
  } finally {
    if (!silent) buttonReady(button);
  }
}

async function applyFilters() {
  const filters = currentFilters();
  if (!state.datasetLoaded) {
    setText('filter-context', 'Load the dataset to activate real persona filters.');
    return;
  }
  if (!hasActiveFilters(filters)) {
    state.filteredTotal = null;
    const total = state.datasetMeta?.total || 0;
    setText('filter-context', `${total} personas available for broad analysis.`);
    return;
  }
  try {
    const data = await requestJSON(API.searchPersonas, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...filters, limit: 80 })
    });
    state.filteredTotal = Number(data.total || 0);
    const noun = state.filteredTotal === 1 ? 'persona matches' : 'personas match';
    setText('filter-context', `${state.filteredTotal} ${noun} the active lens.`);
  } catch (err) {
    setText('filter-context', err.data?.error || 'Filters could not be applied yet.');
  }
}

function clearFilters() {
  ['f-dept', 'f-muni', 'f-area', 'f-edu', 'f-occ', 'f-age'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });
  applyFilters();
}

function validateForm() {
  const errors = [];
  if (valueOf('startupIdea').length < 20) errors.push('Startup idea needs at least 20 characters.');
  if (valueOf('targetCustomer').length < 5) errors.push('Target customer is required.');
  if (!valueOf('price')) errors.push('Price is required.');
  if (errors.length) { showMessage(errors); return false; }
  clearMessage();
  return true;
}

function payload() {
  return {
    startupIdea: valueOf('startupIdea'),
    location: valueOf('location') || 'El Salvador',
    targetCustomer: valueOf('targetCustomer'),
    price: valueOf('price'),
    industry: valueOf('industry') || 'Not specified',
    channels: '',
    competitors: '',
    filters: currentFilters()
  };
}

function verdictLabel(verdict) {
  const v = String(verdict || '').toUpperCase().trim();
  if (v === 'BUILD') return 'Build Now';
  if (v === 'NARROW') return 'Narrow the Target';
  if (v === 'TEST') return 'Test Before Building';
  if (v === 'KILL') return 'Kill This Idea';
  return verdict || 'Analyzing';
}

function verdictColor(verdict) {
  const v = String(verdict || '').toUpperCase().trim();
  if (v === 'BUILD') return 'var(--green)';
  if (v === 'NARROW') return 'var(--warning)';
  if (v === 'TEST') return 'var(--cyan)';
  if (v === 'KILL') return 'var(--pink)';
  return 'var(--text)';
}

function scoreFromAnalysis(analysis) {
  const s = Number(analysis?.viability_score);
  if (!isNaN(s) && s > 0) return Math.max(0, Math.min(100, Math.round(s)));
  const v = String(analysis?.verdict || '').toUpperCase();
  if (v === 'BUILD') return 78;
  if (v === 'NARROW') return 62;
  if (v === 'TEST') return 52;
  if (v === 'KILL') return 34;
  return 50;
}

function renderList(id, items) {
  setHTML(id, (items || []).slice(0, 5).map(item => `<li>${escapeHTML(item)}</li>`).join(''));
}

function firstValue(values, fallback) {
  return values.find(value => value !== undefined && value !== null && String(value).trim()) || fallback;
}

function compactText(value, fallback) {
  const text = String(value || fallback || '').trim();
  return text.length > 58 ? `${text.slice(0, 55)}...` : text;
}

function renderReturnedIntelligence(a, pre, personaCount, score) {
  const bestSegment = a.best_segments?.[0]?.segment;
  const locationMatch = pre.location_match_count !== undefined && pre.persona_count
    ? `${pre.location_match_count}/${pre.persona_count} location match`
    : firstValue([a.location_strategy?.strongest_location, a.market_size?.addressable_segment], 'Strongest areas');
  const pricing = firstValue([
    a.pricing?.judgment,
    a.pricing_judgment,
    a.pricing_analysis?.verdict,
    a.pricing_analysis?.recommended_range
  ], 'Pricing judgment');
  const objection = firstValue([
    a.main_objections?.[0]?.objection,
    a.top_risks?.[0],
    a.channel_assessment?.channel_risks?.[0]
  ], 'Adoption friction');
  const message = firstValue([
    a.positioning?.best_landing_page_headline,
    a.positioning?.better_positioning,
    a.competitive_position?.differentiation_opportunity
  ], 'Positioning cue');
  const plan = firstValue([
    a.seven_day_validation_plan?.[0]?.action,
    a.validation_steps?.[0],
    a.go_to_market?.first_10_customers_strategy
  ], '7-day test path');

  setText('return-verdict', compactText(verdictLabel(a.verdict), 'Kill, test, narrow, or build'));
  setText('return-score', `${score}/100 viability`);
  setText('return-segment', compactText(bestSegment, 'Best-fit profiles'));
  setText('return-location', compactText(locationMatch, 'Strongest areas'));
  setText('return-pricing', compactText(pricing, 'Pricing judgment'));
  setText('return-objections', compactText(objection, 'Key objections'));
  setText('return-message', compactText(message, 'Best message angle'));
  setText('return-plan', compactText(plan || `${personaCount || 0} personas analyzed`, '7-day test path'));
}

function drawDeptChart(canvasId, deptData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !deptData || !deptData.length) return;

  const parent = canvas.parentElement;
  const W = parent ? Math.max(360, parent.clientWidth - 4) : 600;
  const rows = Math.min(deptData.length, 14);
  const ROW_H = 24;
  const GAP = 7;
  const PAD_L = 136;
  const PAD_R = 56;
  const PAD_T = 16;
  const PAD_B = 38;
  const H = PAD_T + rows * (ROW_H + GAP) + PAD_B;

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const cW = W - PAD_L - PAD_R;

  ctx.fillStyle = '#061426';
  ctx.fillRect(0, 0, W, H);

  const C_ADOPT = '#00e5ff';
  const C_ABANDON = '#778399';
  const C_REJECT = 'rgba(212, 91, 145, 0.85)';

  deptData.slice(0, rows).forEach((d, i) => {
    const y = PAD_T + i * (ROW_H + GAP);
    ctx.fillStyle = '#b8c2d4';
    ctx.font = '12px "Barlow Condensed", Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(d.department).slice(0, 22), PAD_L - 8, y + ROW_H / 2 + 4);

    const aW = (d.adopt_rate / 100) * cW;
    const abW = (d.abandon_rate / 100) * cW;
    const rW = (d.reject_rate / 100) * cW;

    ctx.fillStyle = C_ADOPT;
    ctx.fillRect(PAD_L, y, aW, ROW_H);
    ctx.fillStyle = C_ABANDON;
    ctx.fillRect(PAD_L + aW, y, abW, ROW_H);
    ctx.fillStyle = C_REJECT;
    ctx.fillRect(PAD_L + aW + abW, y, rW, ROW_H);

    if (d.adopt_rate > 7) {
      ctx.fillStyle = '#021018';
      ctx.font = 'bold 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${d.adopt_rate}%`, PAD_L + 5, y + ROW_H / 2 + 4);
    }
    ctx.fillStyle = '#7d8799';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`n=${d.total}`, PAD_L + cW + 6, y + ROW_H / 2 + 4);
  });

  const lY = H - PAD_B + 14;
  const legend = [
    { color: C_ADOPT, label: 'Would use it' },
    { color: C_ABANDON, label: 'Try then abandon' },
    { color: C_REJECT, label: 'Would not use' }
  ];
  let lx = PAD_L;
  ctx.textAlign = 'left';
  legend.forEach(item => {
    ctx.fillStyle = item.color;
    ctx.fillRect(lx, lY, 10, 10);
    ctx.fillStyle = '#7d8799';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillText(item.label, lx + 14, lY + 9);
    lx += item.label.length * 6.5 + 22;
  });
}

function renderSimulation(data) {
  const section = $('simulation-section');
  if (section) section.classList.remove('hidden');

  setText('sim-title', `${data.total_simulated} personas simulated`);
  setText('sim-state', 'Complete');

  const adoptBar = $('funnel-adopt-bar');
  const abandonBar = $('funnel-abandon-bar');
  const rejectBar = $('funnel-reject-bar');
  if (adoptBar) adoptBar.style.width = `${data.adopt_rate}%`;
  if (abandonBar) abandonBar.style.width = `${data.abandon_rate}%`;
  if (rejectBar) rejectBar.style.width = `${data.reject_rate}%`;

  setText('adopt-pct', `${data.adopt_rate}%`);
  setText('adopt-count', String(data.adopt_count));
  setText('abandon-pct', `${data.abandon_rate}%`);
  setText('abandon-count', String(data.try_then_abandon_count));
  setText('reject-pct', `${data.reject_rate}%`);
  setText('reject-count', String(data.reject_count));

  setTimeout(() => drawDeptChart('dept-chart', data.department_breakdown || []), 80);

  const ageContainer = $('age-breakdown');
  if (ageContainer && data.age_breakdown) {
    ageContainer.innerHTML = data.age_breakdown
      .filter(a => a.total > 0)
      .map(a => `<div class="breakdown-row">
        <span class="br-label">${escapeHTML(a.group)}</span>
        <div class="br-track">
          <div class="br-seg seg-adopt" style="width:${a.adopt_rate}%"></div>
          <div class="br-seg seg-abandon" style="width:${a.abandon_rate}%"></div>
          <div class="br-seg seg-reject" style="width:${a.reject_rate}%"></div>
        </div>
        <span class="br-rate">${a.adopt_rate}%</span>
        <span class="br-n">n=${a.total}</span>
      </div>`).join('');
  }

  const areaContainer = $('area-breakdown');
  if (areaContainer && data.area_breakdown) {
    areaContainer.innerHTML = data.area_breakdown
      .filter(a => a.total > 0)
      .map(a => `<div class="breakdown-row">
        <span class="br-label">${escapeHTML(a.area)}</span>
        <div class="br-track">
          <div class="br-seg seg-adopt" style="width:${a.adopt_rate}%"></div>
          <div class="br-seg seg-abandon" style="width:${a.abandon_rate}%"></div>
          <div class="br-seg seg-reject" style="width:${a.reject_rate}%"></div>
        </div>
        <span class="br-rate">${a.adopt_rate}%</span>
        <span class="br-n">n=${a.total}</span>
      </div>`).join('');
  }

  renderChannelPreference(data.area_breakdown);
}

function renderChannelPreference(areaBreakdown) {
  const container = $('channel-breakdown');
  if (!container) return;
  const areas = (areaBreakdown || []).filter(a => a.total > 0);
  const totalAll = areas.reduce((sum, a) => sum + a.total, 0);
  if (!totalAll) return;

  const isUrban = name => /urban/i.test(name);
  const urbanTotal = areas.filter(a => isUrban(a.area)).reduce((s, a) => s + a.total, 0);
  const ruralTotal = totalAll - urbanTotal;

  const channels = [
    { label: 'Digital-first', share: Math.round((urbanTotal / totalAll) * 100), note: 'urban reach' },
    { label: 'Physical-first', share: Math.round((ruralTotal / totalAll) * 100), note: 'rural reach' }
  ];

  container.innerHTML = channels.map(c => `<div class="breakdown-row">
    <span class="br-label">${escapeHTML(c.label)}</span>
    <div class="br-track">
      <div class="br-seg seg-single" style="width:${c.share}%"></div>
    </div>
    <span class="br-rate">${c.share}%</span>
    <span class="br-n">${escapeHTML(c.note)}</span>
  </div>`).join('');
}

function renderFullAnalysis(a, pre, personaCount) {
  const section = $('full-analysis-section');
  if (!section) return;
  section.classList.remove('hidden');

  const scoreNames = {
    pain_intensity: 'Pain Intensity',
    willingness_to_pay: 'Willingness to Pay',
    customer_access: 'Customer Access',
    frequency_or_urgency: 'Frequency / Urgency',
    local_fit: 'Local Fit',
    trust_barrier: 'Trust Barrier',
    competition_pressure: 'Competition Pressure',
    message_clarity: 'Message Clarity'
  };
  const sb = a.score_breakdown || {};
  setHTML('score-breakdown-grid', Object.entries(scoreNames).map(([key, name]) => {
    const m = sb[key] || {};
    const sc = Number(m.score) || 0;
    const pct = Math.min(100, sc * 10);
    const color = sc >= 7 ? 'var(--green)' : sc >= 5 ? 'var(--warning)' : 'var(--pink)';
    return `<div class="sc-card">
      <div class="sc-name">${escapeHTML(name)}</div>
      <div class="sc-val" style="color:${color}">${sc}<span class="sc-denom">/10</span></div>
      <div class="sc-track"><div class="sc-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="sc-reason">${escapeHTML(m.reason || '')}</div>
    </div>`;
  }).join(''));

  const bestSegs = (a.best_segments || []).slice(0, 4);
  setHTML('best-segments-list', bestSegs.map(seg => `<div class="seg-card">
    <strong>${escapeHTML(seg.segment || '')}</strong>
    <p>${escapeHTML(seg.why || '')}</p>
    ${seg.best_message ? `<span class="seg-msg">"${escapeHTML(seg.best_message)}"</span>` : ''}
  </div>`).join(''));

  const worstSegs = (a.worst_segments || []).slice(0, 3);
  setHTML('worst-segments-list', worstSegs.map(seg => `<div class="seg-card seg-danger">
    <strong>${escapeHTML(seg.segment || '')}</strong>
    <p>${escapeHTML(seg.why_not || seg.kill_reason || '')}</p>
  </div>`).join(''));

  const objections = (a.main_objections || []).slice(0, 5);
  setHTML('objections-list', objections.map(o => `<div class="objection-card">
    <div class="obj-text">"${escapeHTML(o.objection || '')}"</div>
    <div class="obj-meta">
      <span>Said by: ${escapeHTML(o.who_would_say_it || '—')}</span>
      ${o.how_to_test_it ? `<span>Test: ${escapeHTML(o.how_to_test_it)}</span>` : ''}
    </div>
  </div>`).join(''));

  const pr = a.pricing_judgment || {};
  setHTML('pricing-block', `
    ${pr.price_reaction ? `<div class="fact-row"><span>Reaction</span><strong>${escapeHTML(pr.price_reaction)}</strong></div>` : ''}
    ${pr.too_expensive_for ? `<div class="fact-row danger-row"><span>Too expensive for</span><strong>${escapeHTML(pr.too_expensive_for)}</strong></div>` : ''}
    ${pr.acceptable_for ? `<div class="fact-row ok-row"><span>Acceptable for</span><strong>${escapeHTML(pr.acceptable_for)}</strong></div>` : ''}
    ${pr.suggested_test_price ? `<div class="fact-row hi-row"><span>Suggested test price</span><strong>${escapeHTML(pr.suggested_test_price)}</strong></div>` : ''}
    ${pr.reason ? `<p class="fact-note">${escapeHTML(pr.reason)}</p>` : ''}
  `);

  const pos = a.positioning || {};
  setHTML('positioning-block', `
    ${pos.bad_positioning ? `<div class="fact-row danger-row"><span>Avoid</span><strong>${escapeHTML(pos.bad_positioning)}</strong></div>` : ''}
    ${pos.better_positioning ? `<div class="fact-row"><span>Better</span><strong>${escapeHTML(pos.better_positioning)}</strong></div>` : ''}
    ${pos.best_landing_page_headline ? `<div class="fact-row hi-row"><span>Headline</span><strong>"${escapeHTML(pos.best_landing_page_headline)}"</strong></div>` : ''}
    ${pos.trust_proof_needed ? `<p class="fact-note">${escapeHTML(pos.trust_proof_needed)}</p>` : ''}
  `);

  const gtm = a.go_to_market || {};
  setHTML('gtm-block', `
    ${gtm.best_channel ? `<div class="fact-row hi-row"><span>Best channel</span><strong>${escapeHTML(gtm.best_channel)}</strong></div>` : ''}
    ${gtm.worst_channel ? `<div class="fact-row danger-row"><span>Avoid</span><strong>${escapeHTML(gtm.worst_channel)}</strong></div>` : ''}
    ${gtm.first_10_customers_strategy ? `<div class="fact-row"><span>First 10 customers</span><strong>${escapeHTML(gtm.first_10_customers_strategy)}</strong></div>` : ''}
    ${gtm.sales_script_angle ? `<div class="fact-row"><span>Sales angle</span><strong>${escapeHTML(gtm.sales_script_angle)}</strong></div>` : ''}
  `);

  const kill = (a.kill_criteria || []).slice(0, 5);
  setHTML('kill-criteria-list', kill.map(k => `<div class="kill-card">
    <span class="kill-x">✕</span>
    <div>
      <strong>${escapeHTML(k.condition || '')}</strong>
      <p>${escapeHTML(k.why_it_kills_the_idea || '')}</p>
    </div>
  </div>`).join(''));

  const plan = (a.seven_day_validation_plan || []).slice(0, 7);
  setHTML('seven-day-plan', plan.map(step => `<div class="plan-step">
    <span class="plan-day">Day ${escapeHTML(String(step.day || ''))}</span>
    <div class="plan-content">
      <strong>${escapeHTML(step.action || '')}</strong>
      <div class="plan-metrics">
        <span class="m-pass">✓ ${escapeHTML(step.success_metric || '')}</span>
        <span class="m-fail">✗ ${escapeHTML(step.failure_metric || '')}</span>
      </div>
    </div>
  </div>`).join(''));

  setText('final-advice', a.final_brutal_advice || '');
}

function renderAnalysis(result) {
  const a = result?.analysis || {};
  const pre = result?.preAnalysis || {};
  const personaCount = result?.persona_count || 0;
  const score = scoreFromAnalysis(a);

  const verdictEl = $('verdict-value');
  if (verdictEl) {
    verdictEl.textContent = verdictLabel(a.verdict);
    verdictEl.style.color = verdictColor(a.verdict);
  }
  setText('verdict-explanation', a.one_sentence_truth || a.why_this_verdict || '');
  setText('score-value', String(score));
  setText('analysis-state', 'Complete');
  setText('score-delta', personaCount ? `${personaCount} personas analyzed` : '');

  const ring = $('score-ring');
  if (ring) ring.style.setProperty('--score', score);

  renderExecutiveSummary(a, pre, personaCount, score);
  renderInsights(a, pre);
  renderReturnedIntelligence(a, pre, personaCount, score);
  renderFullAnalysis(a, pre, personaCount);
}

function renderExecutiveSummary(a, pre, personaCount, score) {
  const truth = a.one_sentence_truth || a.why_this_verdict;
  const verdict = verdictLabel(a.verdict);
  if (!truth) return;
  const scope = personaCount ? ` Based on ${personaCount} simulated personas` : '';
  const segment = a.best_segments?.[0]?.segment;
  const segLine = segment ? `, with the strongest pull from ${segment.toLowerCase()}` : '';
  setText('exec-summary', `${verdict} — ${truth}${scope}${segLine}.`);
}

function renderInsights(a, pre) {
  const dash = '[no signal returned]';
  const objection = a.main_objections?.[0]?.objection;
  const pricing = a.pricing_judgment || {};
  const pricingNote = pricing.price_reaction || pricing.suggested_test_price
    ? [pricing.price_reaction, pricing.suggested_test_price ? `Test at ${pricing.suggested_test_price}` : '']
      .filter(Boolean).join(' · ')
    : null;
  const fitNote = a.best_segments?.[0]
    ? `${a.best_segments[0].segment}${a.best_segments[0].why ? ` — ${a.best_segments[0].why}` : ''}`
    : null;
  const next = a.next_experiment?.name
    || a.seven_day_validation_plan?.[0]?.action;
  const impact = a.why_this_verdict || a.go_to_market?.first_10_customers_strategy;

  setText('insight-key-signal', a.one_sentence_truth || a.why_this_verdict || dash);
  setText('insight-friction', objection || dash);
  setText('insight-pricing', pricingNote || dash);
  setText('insight-fit', fitNote || dash);
  setText('insight-test', next || dash);
  setText('insight-impact', impact || dash);
}

function renderAnalysisError(err) {
  setText('analysis-state', 'Needs input');
  const message = err.data?.errors?.join(' ') || err.data?.error || err.message || 'Simulation could not be generated.';
  setText('verdict-value', 'Waiting for Signal');
  setText('verdict-explanation', message);
  setText('return-verdict', 'Needs input');
  setText('return-score', 'Waiting for score');
  setText('return-objections', compactText(message, 'Input required'));
}

function reportProjectName(idea, industry) {
  const text = String(idea || '').trim();
  if (!text) return '[Project / Initiative]';
  const firstClause = text.split(/[.,—–-]/)[0].trim();
  const name = firstClause.length > 52 ? `${firstClause.slice(0, 49)}...` : firstClause;
  return industry && industry !== 'Not specified' ? `${name} · ${industry}` : name;
}

function reportDate() {
  try {
    return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function renderReportMeta(body) {
  setText('report-project-name', reportProjectName(body.startupIdea, body.industry));
  setText('report-date', reportDate());
  const market = [body.targetCustomer, body.location].filter(Boolean).join(' · ');
  setText('report-target-market', market || '[Market / Segment]');
  const total = state.datasetMeta?.total;
  setText('report-source', total
    ? `NVIDIA Nemotron · El Salvador (${total.toLocaleString()} personas)`
    : 'NVIDIA Nemotron · El Salvador');
}

async function runAnalysis(event) {
  if (event) event.preventDefault();
  if (state.busy) return;
  if (!validateForm()) return;

  const button = $('btn-analyze');
  state.busy = true;
  buttonBusy(button, 'Simulating market');
  setText('analysis-state', 'Running');
  clearMessage();

  const simSection = $('simulation-section');
  if (simSection) {
    simSection.classList.remove('hidden');
    setText('sim-title', 'Running persona simulation...');
    setText('sim-state', 'Running');
  }
  const fullSection = $('full-analysis-section');
  if (fullSection) fullSection.classList.add('hidden');

  try {
    if (!state.datasetLoaded) {
      setText('analysis-state', 'Loading dataset');
      await loadDataset({ silent: true });
    }
    const body = payload();
    renderReportMeta(body);
    const [analysisResult, simulationResult] = await Promise.allSettled([
      requestJSON(API.analyze, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
      requestJSON(API.simulate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    ]);

    if (analysisResult.status === 'fulfilled') {
      renderAnalysis(analysisResult.value);
    } else {
      renderAnalysisError(analysisResult.reason);
    }

    if (simulationResult.status === 'fulfilled') {
      renderSimulation(simulationResult.value);
    } else {
      setText('sim-state', 'Error');
      setText('sim-title', simulationResult.reason?.message || 'Simulation failed');
    }

    if (analysisResult.status === 'fulfilled') {
      state.lastReport = {
        input: body,
        analysis: analysisResult.value.analysis || {},
        preAnalysis: analysisResult.value.preAnalysis || {},
        persona_count: analysisResult.value.persona_count || 0,
        simulation: simulationResult.status === 'fulfilled' ? simulationResult.value : {},
        projectName: reportProjectName(body.startupIdea, body.industry),
        date: reportDate()
      };
      const pdfBtn = $('btn-download-pdf');
      if (pdfBtn) pdfBtn.classList.remove('hidden');
      showMessage('Market simulation complete. You can now download the PDF report.', 'success');
    }
  } catch (err) {
    renderAnalysisError(err);
    showMessage(err.data?.errors || err.data?.error || err.message || 'Simulation failed.');
  } finally {
    state.busy = false;
    buttonReady(button);
  }
}

async function downloadReportPdf() {
  if (!state.lastReport) {
    showMessage('Run a simulation first, then download the PDF.');
    return;
  }
  const button = $('btn-download-pdf');
  buttonBusy(button, 'Building PDF');
  try {
    let chartImage = null;
    const canvas = $('dept-chart');
    if (canvas && canvas.width > 0) {
      try { chartImage = canvas.toDataURL('image/png'); } catch (_) { chartImage = null; }
    }
    const res = await fetch(API.report, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state.lastReport, chartImage })
    });
    if (!res.ok) throw new Error(`Report request failed (${res.status})`);
    const html = await res.text();
    const win = window.open('', '_blank');
    if (!win) {
      showMessage('Allow pop-ups to open the printable PDF report.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    showMessage(err.message || 'Could not generate the PDF report.');
  } finally {
    buttonReady(button);
  }
}

function bindEvents() {
  const form = $('startup-form');
  if (form) form.addEventListener('submit', runAnalysis);
  const loadButton = $('btn-load');
  if (loadButton) loadButton.addEventListener('click', () => loadDataset());
  const pdfButton = $('btn-download-pdf');
  if (pdfButton) pdfButton.addEventListener('click', downloadReportPdf);
  const clearButton = $('btn-clear-filters');
  if (clearButton) clearButton.addEventListener('click', clearFilters);
  ['f-dept', 'f-muni', 'f-area', 'f-edu', 'f-occ', 'f-age'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', applyFilters);
  });
}

bindEvents();
checkHealth().then(refreshDatasetStatus);
