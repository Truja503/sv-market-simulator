require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) {}

const PORT = parseInt(process.env.PORT || '3001', 10);
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'personas-cache.json');
const META_FILE = path.join(DATA_DIR, 'dataset-meta.json');
const MODEL = 'claude-sonnet-4-6';

const HF_ROWS = (offset, len) =>
  `https://datasets-server.huggingface.co/rows?dataset=nvidia%2FNemotron-Personas-El-Salvador&config=default&split=train&offset=${offset}&length=${len}`;
const HF_SPLITS = 'https://datasets-server.huggingface.co/splits?dataset=nvidia%2FNemotron-Personas-El-Salvador';
const HF_PARQUET = 'https://huggingface.co/api/datasets/nvidia/Nemotron-Personas-El-Salvador/parquet/default/train';

const KEEP_FIELDS = [
  'uuid','persona','professional_persona','sports_persona','arts_persona',
  'travel_persona','culinary_persona','family_persona','cultural_background',
  'skills_and_expertise','skills_and_expertise_list',
  'hobbies_and_interests','hobbies_and_interests_list',
  'career_goals_and_ambitions','sex','age','languages_spoken',
  'marital_status','household_type','education_level','occupation',
  'area','municipality','department','country'
];

const SYSTEM_PROMPT = `You are a brutal startup market analyst for El Salvador.
You kill weak ideas early.
You do not motivate founders blindly.
You separate evidence from fantasy.
Use synthetic personas as simulated research, not proof of real demand.
Every claim must connect to selected persona evidence, pricing, channel access, segment fit, or validation logic.
Avoid generic startup advice.
Return valid JSON only.`;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname)));

function s(v) {
  return (v !== null && v !== undefined) ? String(v) : '';
}

function normalizeRow(raw) {
  const src = (raw && raw.row) ? raw.row : (raw || {});
  const p = {};
  for (const k of KEEP_FIELDS) {
    const v = src[k];
    if (v !== null && v !== undefined && v !== '') p[k] = v;
  }
  return p;
}

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return []; }
}

function writeCache(personas) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(personas));
}

function readMeta() {
  if (!fs.existsSync(META_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (_) { return null; }
}

function writeMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function computeStats(personas) {
  const departments = [...new Set(personas.map(p => p.department).filter(Boolean))];
  const municipalities = [...new Set(personas.map(p => p.municipality).filter(Boolean))];
  const educationLevels = [...new Set(personas.map(p => p.education_level).filter(Boolean))];
  const occupations = [...new Set(personas.map(p => p.occupation).filter(Boolean))];
  const areaDist = {};
  personas.forEach(p => {
    if (p.area) areaDist[p.area] = (areaDist[p.area] || 0) + 1;
  });
  const ages = personas.map(p => parseInt(p.age)).filter(a => !isNaN(a));
  const ageRange = ages.length
    ? { min: Math.min(...ages), max: Math.max(...ages), avg: Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) }
    : null;
  return { departments, municipalities, education_levels: educationLevels, occupations, area_distribution: areaDist, age_range: ageRange };
}

async function fetchSafe(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchRowsBatch(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchSafe(url, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 600));
    }
  }
}

function scorePersona(p, input) {
  let score = 0;
  const { location, targetCustomer, filters } = input;

  if (location) {
    const loc = location.toLowerCase();
    const dept = s(p.department).toLowerCase();
    const muni = s(p.municipality).toLowerCase();
    if (dept && (dept.includes(loc) || loc.includes(dept))) score += 30;
    else if (muni && (muni.includes(loc) || loc.includes(muni))) score += 20;
  }

  if (targetCustomer) {
    const words = targetCustomer.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const fields = [
      [p.occupation, 22], [p.professional_persona, 16], [p.persona, 12],
      [p.education_level, 9], [p.hobbies_and_interests, 13], [p.skills_and_expertise, 13],
      [p.career_goals_and_ambitions, 11], [p.cultural_background, 7],
      [p.family_persona, 5], [p.travel_persona, 5], [p.culinary_persona, 4]
    ];
    for (const word of words) {
      for (const [field, weight] of fields) {
        if (field && s(field).toLowerCase().includes(word)) score += weight;
      }
    }
  }

  if (filters) {
    const f = filters;
    if (f.department && s(p.department).toLowerCase().includes(s(f.department).toLowerCase())) score += 15;
    if (f.municipality && s(p.municipality).toLowerCase().includes(s(f.municipality).toLowerCase())) score += 12;
    if (f.area && s(p.area).toLowerCase() === s(f.area).toLowerCase()) score += 10;
    if (f.education_level && s(p.education_level).toLowerCase().includes(s(f.education_level).toLowerCase())) score += 9;
    if (f.occupation && s(p.occupation).toLowerCase().includes(s(f.occupation).toLowerCase())) score += 12;
    if (f.minAge || f.maxAge) {
      const age = parseInt(p.age);
      if (!isNaN(age)) {
        if (f.minAge && age >= parseInt(f.minAge)) score += 5;
        if (f.maxAge && age <= parseInt(f.maxAge)) score += 5;
      }
    }
  }

  return score;
}

function diverseSubset(pool, limit) {
  if (pool.length <= limit) return pool;
  const groups = {};
  for (const p of pool) {
    const k = p.department || p.area || 'unknown';
    if (!groups[k]) groups[k] = [];
    groups[k].push(p);
  }
  const keys = Object.keys(groups);
  const result = [];
  let i = 0;
  while (result.length < limit) {
    let added = false;
    for (const k of keys) {
      if (result.length >= limit) break;
      if (i < groups[k].length) { result.push(groups[k][i]); added = true; }
    }
    if (!added) break;
    i++;
  }
  return result;
}

function selectPersonas(all, input, targetCount) {
  const scored = all.map(p => ({ p, s: scorePersona(p, input) }));
  scored.sort((a, b) => b.s - a.s);
  const topCount = Math.floor(targetCount * 0.7);
  const top = scored.slice(0, topCount).map(x => x.p);
  const rest = scored.slice(topCount).map(x => x.p);
  return [...top, ...diverseSubset(rest, targetCount - top.length)].slice(0, targetCount);
}

function countDist(arr, key, limit = 10) {
  const counts = {};
  for (const item of arr) {
    const v = s(item[key]) || 'unknown';
    counts[v] = (counts[v] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

function topTokens(arr, key, limit = 8) {
  const counts = {};
  for (const item of arr) {
    if (!item[key]) continue;
    s(item[key]).split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(t => t.length > 3).forEach(t => {
      counts[t] = (counts[t] || 0) + 1;
    });
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

function buildPreAnalysis(selected, allCached, input) {
  const total = selected.length;

  let locationMatchCount = 0;
  if (input.location) {
    const loc = input.location.toLowerCase();
    locationMatchCount = selected.filter(p =>
      s(p.department).toLowerCase().includes(loc) || s(p.municipality).toLowerCase().includes(loc)
    ).length;
  }

  const ageGroups = { '18-24': 0, '25-34': 0, '35-44': 0, '45-54': 0, '55+': 0, unknown: 0 };
  selected.forEach(p => {
    const age = parseInt(p.age);
    if (isNaN(age)) { ageGroups.unknown++; return; }
    if (age < 25) ageGroups['18-24']++;
    else if (age < 35) ageGroups['25-34']++;
    else if (age < 45) ageGroups['35-44']++;
    else if (age < 55) ageGroups['45-54']++;
    else ageGroups['55+']++;
  });

  let highPay = 0, highFriction = 0, highTrust = 0, digital = 0;

  for (const p of selected) {
    const edu = s(p.education_level).toLowerCase();
    const area = s(p.area).toLowerCase();
    const occ = s(p.occupation).toLowerCase();
    const interests = s(p.hobbies_and_interests).toLowerCase();
    const age = parseInt(p.age);

    if (edu.includes('univers') || edu.includes('licenc') || edu.includes('maestr') || edu.includes('doctor') ||
        area.includes('urban') ||
        occ.includes('gerente') || occ.includes('director') || occ.includes('ingenier') ||
        occ.includes('manager') || occ.includes('ejecutiv') || occ.includes('profesional')) highPay++;

    if (edu.includes('primar') || edu.includes('basic') || area.includes('rural') || (!isNaN(age) && age > 54)) highFriction++;

    if (area.includes('rural') || edu.includes('primar') || (!isNaN(age) && age > 49)) highTrust++;

    if (area.includes('urban') || occ.includes('tecnolog') || occ.includes('informatic') ||
        interests.includes('tecnolog') || interests.includes('internet') || interests.includes('social media')) digital++;
  }

  const pR = highPay / total, fR = highFriction / total, tR = highTrust / total, dR = digital / total;

  return {
    total_cached_personas: allCached.length,
    selected_persona_count: total,
    location_match_count: locationMatchCount,
    department_distribution: countDist(selected, 'department'),
    municipality_distribution: countDist(selected, 'municipality', 8),
    urban_rural_distribution: countDist(selected, 'area', 5),
    age_group_distribution: ageGroups,
    education_distribution: countDist(selected, 'education_level'),
    occupation_distribution: countDist(selected, 'occupation', 10),
    top_skills: topTokens(selected, 'skills_and_expertise'),
    top_interests: topTokens(selected, 'hobbies_and_interests'),
    ability_to_pay_proxy: pR > 0.5 ? 'HIGH' : pR > 0.3 ? 'MODERATE' : 'LOW',
    adoption_friction_proxy: fR > 0.5 ? 'HIGH' : fR > 0.25 ? 'MEDIUM' : 'LOW',
    trust_friction_proxy: tR > 0.45 ? 'HIGH' : tR > 0.25 ? 'MEDIUM' : 'LOW',
    channel_fit_proxy: dR > 0.55 ? 'DIGITAL' : dR > 0.3 ? 'MIXED' : 'PHYSICAL'
  };
}

function buildUserMessage(input, pre, sample) {
  const brief = `## Startup Brief
Product/Idea: ${input.startupIdea}
Location Target: ${input.location || 'Not specified'}
Target Customer: ${input.targetCustomer}
Price: ${input.price}
Industry: ${input.industry || 'Not specified'}
Channels: ${input.channels || 'Not specified'}
Competitors: ${input.competitors || 'Not specified'}`;

  const summary = `## Pre-Analysis (${pre.selected_persona_count} personas selected from ${pre.total_cached_personas} cached)
Location matches: ${pre.location_match_count}
Ability-to-pay proxy: ${pre.ability_to_pay_proxy}
Adoption friction proxy: ${pre.adoption_friction_proxy}
Trust friction proxy: ${pre.trust_friction_proxy}
Channel fit proxy: ${pre.channel_fit_proxy}
Department distribution: ${JSON.stringify(pre.department_distribution)}
Urban/Rural: ${JSON.stringify(pre.urban_rural_distribution)}
Age groups: ${JSON.stringify(pre.age_group_distribution)}
Education: ${JSON.stringify(pre.education_distribution)}
Occupations: ${JSON.stringify(pre.occupation_distribution)}
Top interests: ${JSON.stringify(pre.top_interests)}
Top skills: ${JSON.stringify(pre.top_skills)}`;

  const personaLines = sample.map((p, i) =>
    `P${i + 1} | age=${p.age || '?'} sex=${p.sex || '?'} | dept=${p.department || '?'} muni=${p.municipality || '?'} area=${p.area || '?'} | edu=${p.education_level || '?'} occ=${p.occupation || '?'} | interests=${s(p.hobbies_and_interests).slice(0, 80)} | skills=${s(p.skills_and_expertise).slice(0, 60)} | bio=${s(p.persona).slice(0, 120)}`
  ).join('\n');

  const schema = `## Return ONLY this JSON structure. No text before or after.
{
  "verdict": "KILL|TEST|NARROW|BUILD",
  "viability_score": 0,
  "confidence": "LOW|MEDIUM|HIGH",
  "one_sentence_truth": "",
  "why_this_verdict": "",
  "score_breakdown": {
    "pain_intensity": {"score": 0, "reason": ""},
    "willingness_to_pay": {"score": 0, "reason": ""},
    "customer_access": {"score": 0, "reason": ""},
    "frequency_or_urgency": {"score": 0, "reason": ""},
    "local_fit": {"score": 0, "reason": ""},
    "trust_barrier": {"score": 0, "reason": ""},
    "competition_pressure": {"score": 0, "reason": ""},
    "message_clarity": {"score": 0, "reason": ""}
  },
  "best_segments": [{"segment":"","why":"","evidence_from_personas":"","estimated_objection":"","best_message":""}],
  "worst_segments": [{"segment":"","why_not":"","kill_reason":""}],
  "strongest_locations": [{"location":"","reason":"","confidence":""}],
  "main_objections": [{"objection":"","who_would_say_it":"","how_to_test_it":""}],
  "pricing_judgment": {"price_reaction":"","too_expensive_for":"","acceptable_for":"","suggested_test_price":"","reason":""},
  "positioning": {"bad_positioning":"","better_positioning":"","best_landing_page_headline":"","trust_proof_needed":""},
  "go_to_market": {"best_channel":"","worst_channel":"","first_10_customers_strategy":"","sales_script_angle":""},
  "kill_criteria": [{"condition":"","why_it_kills_the_idea":""}],
  "seven_day_validation_plan": [{"day":1,"action":"","success_metric":"","failure_metric":""}],
  "next_experiment": {"name":"","cost":"","time_required":"","success_threshold":"","failure_threshold":""},
  "final_brutal_advice": ""
}
Scoring: viability_score 0-100. KILL<45. TEST 45-64. NARROW when too broad but one segment works. BUILD>=75 only with strong evidence.`;

  return [brief, summary, `## Persona Sample (${sample.length})`, personaLines, schema].join('\n\n');
}

function parseClaudeJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw Object.assign(new Error('No JSON found in Claude response'), { raw: text });
  try { return JSON.parse(match[0]); }
  catch (e) { throw Object.assign(new Error(`JSON parse failed: ${e.message}`), { raw: text }); }
}

async function callClaude(input, preAnalysis, selectedPersonas) {
  const sample = selectedPersonas.slice(0, 35);
  const userMessage = buildUserMessage(input, preAnalysis, sample);

  if (Anthropic) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });
    return parseClaudeJSON(msg.content[0].text);
  }

  const body = JSON.stringify({
    model: MODEL, max_tokens: 8192, system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text;
          if (!text) throw new Error('No text content in response');
          resolve(parseClaudeJSON(text));
        } catch (e) { reject(Object.assign(e, { raw: data })); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.get('/api/health', (req, res) => {
  const cache = readCache();
  res.json({ status: 'ok', cache_loaded: cache.length > 0, persona_count: cache.length, model: MODEL, timestamp: new Date().toISOString() });
});

app.get('/api/dataset/splits', async (req, res) => {
  try { res.json(await (await fetchSafe(HF_SPLITS)).json()); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/dataset/parquet', async (req, res) => {
  try { res.json(await (await fetchSafe(HF_PARQUET)).json()); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/dataset/load', async (req, res) => {
  const mode = req.body.mode || 'progressive';
  const batchSize = Math.min(parseInt(req.body.batchSize || 100, 10), 100);
  const maxRows = parseInt(req.body.maxRows || 5000, 10);

  let personas = [];
  let lastOffset = 0;
  const startedAt = new Date().toISOString();

  if (mode === 'progressive') {
    const existingMeta = readMeta();
    if (existingMeta && !existingMeta.completed && existingMeta.lastOffset > 0) {
      personas = readCache();
      lastOffset = existingMeta.lastOffset;
    }
  }

  let completed = false;
  let batchCount = 0;

  while (personas.length < maxRows) {
    const remaining = maxRows - personas.length;
    const fetchLen = Math.min(batchSize, remaining);

    let batchData;
    try {
      batchData = await fetchRowsBatch(HF_ROWS(lastOffset, fetchLen), 3);
    } catch (err) {
      const partial = { ...computeStats(personas), loadedRows: personas.length, lastOffset, completed: false, startedAt, updatedAt: new Date().toISOString(), source: 'nvidia/Nemotron-Personas-El-Salvador', split: 'train', loaded: personas.length > 0, total_personas: personas.length };
      writeMeta(partial);
      writeCache(personas);
      return res.status(502).json({ error: `Batch fetch failed at offset ${lastOffset}: ${err.message}`, partial });
    }

    const rows = (batchData.rows || []).map(r => normalizeRow(r)).filter(p => Object.keys(p).length > 0);

    if (!rows.length) { completed = true; break; }

    personas.push(...rows);
    lastOffset += rows.length;
    batchCount++;

    const metaNow = { ...computeStats(personas), loadedRows: personas.length, lastOffset, completed: false, startedAt, updatedAt: new Date().toISOString(), source: 'nvidia/Nemotron-Personas-El-Salvador', split: 'train', loaded: true, total_personas: personas.length };
    writeMeta(metaNow);

    if (batchCount % 10 === 0) writeCache(personas);

    if (rows.length < fetchLen) { completed = true; break; }

    await new Promise(r => setTimeout(r, 150));
  }

  writeCache(personas);
  const finalMeta = { ...computeStats(personas), loadedRows: personas.length, lastOffset, completed, startedAt, updatedAt: new Date().toISOString(), source: 'nvidia/Nemotron-Personas-El-Salvador', split: 'train', loaded: true, total_personas: personas.length };
  writeMeta(finalMeta);

  res.json(finalMeta);
});

app.get('/api/dataset/status', (req, res) => {
  const meta = readMeta();
  if (!meta || !fs.existsSync(CACHE_FILE)) {
    return res.json({ loaded: false, message: 'Dataset not loaded. Use Load Dataset first.' });
  }
  const cache = readCache();
  res.json({ loaded: cache.length > 0, total_personas: cache.length, ...meta });
});

app.post('/api/personas/search', (req, res) => {
  const personas = readCache();
  if (!personas.length) return res.status(400).json({ error: 'Dataset cache is empty. Load dataset first.' });

  const { department, municipality, area, education_level, occupation, minAge, maxAge, limit = 120 } = req.body;
  const hasFilters = department || municipality || area || education_level || occupation || minAge || maxAge;

  if (!hasFilters) {
    return res.json({ personas: diverseSubset(personas, parseInt(limit, 10)), total: personas.length, filtered: false });
  }

  const filtered = personas.filter(p => {
    if (department && !s(p.department).toLowerCase().includes(s(department).toLowerCase())) return false;
    if (municipality && !s(p.municipality).toLowerCase().includes(s(municipality).toLowerCase())) return false;
    if (area && s(p.area).toLowerCase() !== s(area).toLowerCase()) return false;
    if (education_level && !s(p.education_level).toLowerCase().includes(s(education_level).toLowerCase())) return false;
    if (occupation && !s(p.occupation).toLowerCase().includes(s(occupation).toLowerCase())) return false;
    if (minAge || maxAge) {
      const age = parseInt(p.age);
      if (isNaN(age)) return false;
      if (minAge && age < parseInt(minAge)) return false;
      if (maxAge && age > parseInt(maxAge)) return false;
    }
    return true;
  });

  res.json({ personas: filtered.slice(0, parseInt(limit, 10)), total: filtered.length, filtered: true });
});

app.post('/api/analyze', async (req, res) => {
  const { startupIdea, location, targetCustomer, price, industry, channels, competitors, filters = {} } = req.body;

  const errors = [];
  if (!startupIdea || startupIdea.trim().length < 20)
    errors.push('Startup idea is too vague. Describe what you build, for whom, and what problem it solves (min 20 chars).');
  if (!price || !price.trim())
    errors.push('Price is required. Specify a number or range.');
  if (!targetCustomer || targetCustomer.trim().length < 5)
    errors.push('Target customer is required. Be specific about who buys this.');
  if (errors.length) return res.status(400).json({ errors });

  const allPersonas = readCache();
  if (!allPersonas.length)
    return res.status(400).json({ error: 'Dataset cache is empty. Load dataset first.' });

  const input = { startupIdea, location, targetCustomer, price, industry, channels, competitors, filters };
  const targetCount = Math.min(120, Math.max(80, Math.floor(allPersonas.length * 0.08)));
  const selected = selectPersonas(allPersonas, input, targetCount);
  const preAnalysis = buildPreAnalysis(selected, allPersonas, input);

  try {
    const analysis = await callClaude(input, preAnalysis, selected);
    res.json({ analysis, preAnalysis, persona_count: selected.length });
  } catch (err) {
    res.status(500).json({ error: err.message, raw: err.raw || null });
  }
});

app.post('/api/simulate', (req, res) => {
  const { startupIdea, targetCustomer, price, location, industry, channels, competitors, filters = {} } = req.body;
  if (!startupIdea || !targetCustomer || !price)
    return res.status(400).json({ error: 'startupIdea, targetCustomer and price are required.' });

  const allPersonas = readCache();
  if (!allPersonas.length)
    return res.status(400).json({ error: 'Dataset cache is empty. Load dataset first.' });

  const input = { startupIdea, location, targetCustomer, price, industry, channels, competitors, filters };
  const pool = selectPersonas(allPersonas, input, Math.min(500, allPersonas.length));
  const rawScores = pool.map(p => scorePersona(p, input));
  const minS = Math.min(...rawScores);
  const maxS = Math.max(...rawScores);
  const range = maxS - minS || 1;

  const outcomes = pool.map((p, i) => {
    const norm = Math.round(((rawScores[i] - minS) / range) * 100);
    let outcome;
    if (norm >= 65) outcome = 'adopt';
    else if (norm >= 32) outcome = 'try_then_abandon';
    else outcome = 'reject';
    let reason = '';
    if (outcome !== 'adopt') {
      const edu = s(p.education_level).toLowerCase();
      const area = s(p.area).toLowerCase();
      const age = parseInt(p.age);
      const priceVal = parseFloat(String(price).replace(/[^0-9.]/g, ''));
      if (area === 'rural') reason = 'Limited digital infrastructure in rural area';
      else if (edu.includes('primar') || edu.includes('bás')) reason = 'Low technology adoption in this education profile';
      else if (!isNaN(age) && age > 55) reason = 'Older demographic — higher trust barrier';
      else if (!isNaN(priceVal) && priceVal > 15) reason = 'Price-to-income ratio unfavorable for this segment';
      else reason = 'Below-average segment fit for target criteria';
    }
    return { department: p.department || 'Unknown', area: p.area || 'Unknown', age: parseInt(p.age) || null, education_level: p.education_level || 'Unknown', occupation: p.occupation || 'Unknown', sex: p.sex || 'Unknown', outcome, score: norm, reason };
  });

  const adopt = outcomes.filter(r => r.outcome === 'adopt');
  const tryAbandon = outcomes.filter(r => r.outcome === 'try_then_abandon');
  const reject = outcomes.filter(r => r.outcome === 'reject');
  const total = outcomes.length;

  const deptMap = {};
  outcomes.forEach(r => {
    const k = r.department;
    if (!deptMap[k]) deptMap[k] = { department: k, adopt: 0, try_then_abandon: 0, reject: 0, total: 0 };
    deptMap[k][r.outcome]++;
    deptMap[k].total++;
  });
  const deptBreakdown = Object.values(deptMap)
    .map(d => ({ department: d.department, adopt_rate: Math.round((d.adopt / d.total) * 100), abandon_rate: Math.round((d.try_then_abandon / d.total) * 100), reject_rate: Math.round((d.reject / d.total) * 100), adopt_count: d.adopt, total: d.total }))
    .sort((a, b) => b.adopt_rate - a.adopt_rate);

  const ageGroups = ['18-24', '25-34', '35-44', '45-54', '55+'];
  const ageMap = Object.fromEntries(ageGroups.map(g => [g, { adopt: 0, try_then_abandon: 0, reject: 0, total: 0 }]));
  outcomes.forEach(r => {
    const age = r.age;
    let g = '55+';
    if (age && age < 25) g = '18-24';
    else if (age && age < 35) g = '25-34';
    else if (age && age < 45) g = '35-44';
    else if (age && age < 55) g = '45-54';
    ageMap[g].total++;
    ageMap[g][r.outcome]++;
  });
  const ageBreakdown = ageGroups.map(g => ({ group: g, adopt_rate: ageMap[g].total ? Math.round((ageMap[g].adopt / ageMap[g].total) * 100) : 0, abandon_rate: ageMap[g].total ? Math.round((ageMap[g].try_then_abandon / ageMap[g].total) * 100) : 0, reject_rate: ageMap[g].total ? Math.round((ageMap[g].reject / ageMap[g].total) * 100) : 0, total: ageMap[g].total }));

  const areaMap = {};
  outcomes.forEach(r => {
    const k = r.area;
    if (!areaMap[k]) areaMap[k] = { area: k, adopt: 0, try_then_abandon: 0, reject: 0, total: 0 };
    areaMap[k].total++;
    areaMap[k][r.outcome]++;
  });
  const areaBreakdown = Object.values(areaMap).map(d => ({ area: d.area, adopt_rate: Math.round((d.adopt / d.total) * 100), abandon_rate: Math.round((d.try_then_abandon / d.total) * 100), reject_rate: Math.round((d.reject / d.total) * 100), total: d.total }));

  res.json({
    total_simulated: total,
    adopt_count: adopt.length,
    try_then_abandon_count: tryAbandon.length,
    reject_count: reject.length,
    adopt_rate: Math.round((adopt.length / total) * 100),
    abandon_rate: Math.round((tryAbandon.length / total) * 100),
    reject_rate: Math.round((reject.length / total) * 100),
    department_breakdown: deptBreakdown,
    age_breakdown: ageBreakdown,
    area_breakdown: areaBreakdown,
    sample_adopters: adopt.slice(0, 3).map(r => ({ dept: r.department, area: r.area, edu: r.education_level, occ: r.occupation })),
    sample_abandoners: tryAbandon.slice(0, 3).map(r => ({ dept: r.department, area: r.area, edu: r.education_level, occ: r.occupation, reason: r.reason })),
    sample_rejecters: reject.slice(0, 3).map(r => ({ dept: r.department, area: r.area, edu: r.education_level, occ: r.occupation, reason: r.reason }))
  });
});

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function barRow(label, adopt, abandon, reject, n) {
  return `<div class="row">
    <span class="rl">${esc(label)}</span>
    <div class="track">
      <i class="s-a" style="width:${adopt}%"></i>
      <i class="s-b" style="width:${abandon}%"></i>
      <i class="s-r" style="width:${reject}%"></i>
    </div>
    <span class="rr">${adopt}%</span>
    <span class="rn">n=${n}</span>
  </div>`;
}

function factRows(pairs) {
  return pairs.filter(p => p[1]).map(p =>
    `<div class="fact"><span>${esc(p[0])}</span><strong>${esc(p[1])}</strong></div>`
  ).join('');
}

function buildReportHTML(payload) {
  const input = payload.input || {};
  const a = payload.analysis || {};
  const sim = payload.simulation || {};
  const pre = payload.preAnalysis || {};
  const chart = typeof payload.chartImage === 'string' && payload.chartImage.startsWith('data:image') ? payload.chartImage : null;

  const verdictMap = { BUILD: 'Build Now', NARROW: 'Narrow the Target', TEST: 'Test Before Building', KILL: 'Kill This Idea' };
  const vKey = String(a.verdict || '').toUpperCase().trim();
  const verdict = verdictMap[vKey] || (a.verdict || 'Analysis');
  const score = Math.max(0, Math.min(100, Math.round(Number(a.viability_score) || 0)));

  const scoreNames = {
    pain_intensity: 'Pain Intensity', willingness_to_pay: 'Willingness to Pay',
    customer_access: 'Customer Access', frequency_or_urgency: 'Frequency / Urgency',
    local_fit: 'Local Fit', trust_barrier: 'Trust Barrier',
    competition_pressure: 'Competition Pressure', message_clarity: 'Message Clarity'
  };
  const sb = a.score_breakdown || {};
  const scoreCards = Object.entries(scoreNames).map(([k, name]) => {
    const m = sb[k] || {};
    const sc = Number(m.score) || 0;
    return `<div class="sc">
      <div class="sc-n">${esc(name)}</div>
      <div class="sc-v">${sc}<small>/10</small></div>
      <div class="sc-t"><i style="width:${Math.min(100, sc * 10)}%"></i></div>
      <div class="sc-r">${esc(m.reason || '')}</div>
    </div>`;
  }).join('');

  const bestSegs = (a.best_segments || []).slice(0, 4).map(s =>
    `<div class="seg"><strong>${esc(s.segment || '')}</strong><p>${esc(s.why || '')}</p>${s.best_message ? `<em>"${esc(s.best_message)}"</em>` : ''}</div>`
  ).join('') || '<p class="muted">—</p>';

  const worstSegs = (a.worst_segments || []).slice(0, 3).map(s =>
    `<div class="seg bad"><strong>${esc(s.segment || '')}</strong><p>${esc(s.why_not || s.kill_reason || '')}</p></div>`
  ).join('') || '<p class="muted">—</p>';

  const objections = (a.main_objections || []).slice(0, 5).map(o =>
    `<div class="obj"><div class="oq">"${esc(o.objection || '')}"</div><div class="om">Said by: ${esc(o.who_would_say_it || '—')}${o.how_to_test_it ? ' · Test: ' + esc(o.how_to_test_it) : ''}</div></div>`
  ).join('') || '<p class="muted">—</p>';

  const pr = a.pricing_judgment || {};
  const pricing = factRows([
    ['Reaction', pr.price_reaction], ['Too expensive for', pr.too_expensive_for],
    ['Acceptable for', pr.acceptable_for], ['Suggested test price', pr.suggested_test_price], ['Reason', pr.reason]
  ]) || '<p class="muted">—</p>';

  const pos = a.positioning || {};
  const positioning = factRows([
    ['Avoid', pos.bad_positioning], ['Better', pos.better_positioning],
    ['Headline', pos.best_landing_page_headline], ['Trust proof', pos.trust_proof_needed]
  ]) || '<p class="muted">—</p>';

  const gtm = a.go_to_market || {};
  const gtmHtml = factRows([
    ['Best channel', gtm.best_channel], ['Avoid channel', gtm.worst_channel],
    ['First 10 customers', gtm.first_10_customers_strategy], ['Sales angle', gtm.sales_script_angle]
  ]) || '<p class="muted">—</p>';

  const kill = (a.kill_criteria || []).slice(0, 5).map(k =>
    `<div class="kill"><strong>✕ ${esc(k.condition || '')}</strong><p>${esc(k.why_it_kills_the_idea || '')}</p></div>`
  ).join('') || '<p class="muted">—</p>';

  const plan = (a.seven_day_validation_plan || []).slice(0, 7).map(s =>
    `<div class="plan"><span>Day ${esc(s.day || '')}</span><div><strong>${esc(s.action || '')}</strong><div class="pm"><em class="ok">✓ ${esc(s.success_metric || '')}</em> <em class="no">✗ ${esc(s.failure_metric || '')}</em></div></div></div>`
  ).join('') || '<p class="muted">—</p>';

  const ageBars = (sim.age_breakdown || []).filter(x => x.total > 0)
    .map(x => barRow(x.group, x.adopt_rate, x.abandon_rate, x.reject_rate, x.total)).join('');
  const areaBars = (sim.area_breakdown || []).filter(x => x.total > 0)
    .map(x => barRow(x.area, x.adopt_rate, x.abandon_rate, x.reject_rate, x.total)).join('');
  const deptBars = (sim.department_breakdown || []).slice(0, 14)
    .map(x => barRow(x.department, x.adopt_rate, x.abandon_rate, x.reject_rate, x.total)).join('');

  const execSummary = a.one_sentence_truth
    ? `${verdict} — ${a.one_sentence_truth}${payload.persona_count ? ` Based on ${payload.persona_count} simulated personas.` : ''}`
    : (a.why_this_verdict || '—');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>AI Simulation Report — ${esc(input.startupIdea ? String(input.startupIdea).slice(0, 40) : 'SV Market Simulator')}</title>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #16202e; font-size: 11px; line-height: 1.5; }
h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; color: #0386a3; margin: 22px 0 9px; border-bottom: 1px solid #d6e0ec; padding-bottom: 5px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0386a3; padding-bottom: 14px; }
.kick { font-size: 10px; text-transform: uppercase; letter-spacing: 0.16em; color: #0386a3; }
.sub { color: #5a6b80; font-size: 12px; margin-top: 2px; }
.meta { text-align: right; font-size: 10px; color: #5a6b80; }
.meta div { margin-bottom: 3px; }
.meta strong { color: #16202e; }
.vbar { display: flex; gap: 18px; align-items: center; margin: 16px 0; padding: 14px 16px; background: #f1f6fb; border-radius: 8px; border: 1px solid #dde7f1; }
.score { font-size: 38px; font-weight: 700; color: #0386a3; line-height: 1; }
.score small { font-size: 13px; color: #8392a5; font-weight: 400; }
.verdict { font-size: 20px; font-weight: 700; }
.verdict.BUILD { color: #128a5e; } .verdict.NARROW { color: #b9842b; } .verdict.TEST { color: #0386a3; } .verdict.KILL { color: #c0426f; }
.exec { font-size: 13px; line-height: 1.6; color: #2a3a4e; }
.m3 { display: flex; gap: 12px; margin-top: 8px; }
.m3 .m { flex: 1; border: 1px solid #dde7f1; border-radius: 7px; padding: 11px 13px; }
.m strong { display: block; font-size: 26px; font-weight: 700; line-height: 1; }
.m.a strong { color: #0386a3; } .m.r strong { color: #c0426f; } .m.b strong { color: #6b7a8d; }
.m span { font-size: 10px; color: #5a6b80; } .m small { display: block; text-transform: uppercase; font-size: 9px; letter-spacing: 0.08em; color: #8392a5; margin-top: 3px; }
.chartimg { width: 100%; border: 1px solid #dde7f1; border-radius: 7px; margin-top: 6px; }
.bars { display: flex; flex-direction: column; gap: 6px; }
.row { display: grid; grid-template-columns: 92px 1fr 30px 34px; gap: 8px; align-items: center; }
.rl { font-size: 10px; color: #3a4a5e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.track { display: flex; height: 9px; background: #eef3f8; border-radius: 5px; overflow: hidden; }
.track i { height: 100%; } .s-a { background: #0386a3; } .s-b { background: #95a3b5; } .s-r { background: #d07398; }
.rr { font-size: 10px; font-weight: 700; color: #0386a3; text-align: right; } .rn { font-size: 9px; color: #8392a5; text-align: right; }
.scg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.sc { border: 1px solid #dde7f1; border-radius: 7px; padding: 9px 10px; }
.sc-n { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #8392a5; }
.sc-v { font-size: 24px; font-weight: 700; color: #16202e; } .sc-v small { font-size: 10px; color: #8392a5; font-weight: 400; }
.sc-t { height: 3px; background: #eef3f8; border-radius: 3px; overflow: hidden; margin: 4px 0; } .sc-t i { display: block; height: 100%; background: #0386a3; }
.sc-r { font-size: 9px; color: #6b7a8d; line-height: 1.4; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.seg, .obj, .kill { border: 1px solid #dde7f1; border-left: 3px solid #0386a3; border-radius: 6px; padding: 8px 11px; margin-bottom: 7px; }
.seg.bad { border-left-color: #c0426f; } .kill { border-left-color: #c0426f; background: #fdf3f7; }
.seg strong, .kill strong { font-size: 11px; } .seg p, .kill p, .obj .om { font-size: 10px; color: #5a6b80; }
.seg em { font-size: 10px; color: #0386a3; font-style: italic; }
.obj .oq { font-size: 12px; color: #16202e; margin-bottom: 3px; }
.fact { border: 1px solid #dde7f1; border-radius: 6px; padding: 7px 10px; margin-bottom: 6px; }
.fact span { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #8392a5; } .fact strong { font-size: 11px; font-weight: 500; }
.plan { display: grid; grid-template-columns: 46px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid #eef3f8; }
.plan span { font-size: 10px; font-weight: 700; color: #0386a3; text-transform: uppercase; }
.plan strong { font-size: 11px; font-weight: 500; } .pm { margin-top: 2px; } .pm .ok { color: #128a5e; font-style: normal; font-size: 10px; } .pm .no { color: #c0426f; font-style: normal; font-size: 10px; }
.takeaway { background: #eef8fb; border: 1px solid #b9e3ee; border-left: 4px solid #0386a3; border-radius: 8px; padding: 14px 18px; font-size: 14px; font-style: italic; color: #1c2b3c; }
.muted { color: #8392a5; }
.avoid-break { break-inside: avoid; page-break-inside: avoid; }
.foot { margin-top: 20px; padding-top: 8px; border-top: 1px solid #d6e0ec; font-size: 9px; color: #8392a5; }
</style></head>
<body onload="setTimeout(function(){window.print();},350)">
  <div class="head">
    <div>
      <div class="kick">AI-Generated Analysis</div>
      <h1>AI Simulation Report</h1>
      <div class="sub">Market Intelligence Report — El Salvador</div>
    </div>
    <div class="meta">
      <div>Project<br><strong>${esc(payload.projectName || (input.startupIdea ? String(input.startupIdea).slice(0, 48) : '—'))}</strong></div>
      <div>Date<br><strong>${esc(payload.date || '')}</strong></div>
      <div>Target Market<br><strong>${esc([input.targetCustomer, input.location].filter(Boolean).join(' · ') || '—')}</strong></div>
      <div>Source<br><strong>NVIDIA Nemotron · El Salvador</strong></div>
    </div>
  </div>

  <div class="vbar avoid-break">
    <div class="score">${score || '__'}<small>/100</small></div>
    <div>
      <div class="verdict ${esc(vKey)}">${esc(verdict)}</div>
      <div class="sub">${esc(a.one_sentence_truth || a.why_this_verdict || '')}</div>
    </div>
  </div>

  <h2>Executive Summary</h2>
  <p class="exec">${esc(execSummary)}</p>

  <h2>Persona Simulation${sim.total_simulated ? ' · ' + sim.total_simulated + ' personas' : ''}</h2>
  <div class="m3 avoid-break">
    <div class="m a"><strong>${sim.adopt_rate != null ? sim.adopt_rate + '%' : '__%'}</strong><span>${sim.adopt_count != null ? sim.adopt_count + ' personas' : '—'}</span><small>Would use it</small></div>
    <div class="m b"><strong>${sim.abandon_rate != null ? sim.abandon_rate + '%' : '__%'}</strong><span>${sim.try_then_abandon_count != null ? sim.try_then_abandon_count + ' personas' : '—'}</span><small>Try then abandon</small></div>
    <div class="m r"><strong>${sim.reject_rate != null ? sim.reject_rate + '%' : '__%'}</strong><span>${sim.reject_count != null ? sim.reject_count + ' personas' : '—'}</span><small>Would not use</small></div>
  </div>

  <h2>Adoption Viability by Department</h2>
  ${chart ? `<img class="chartimg" src="${chart}" alt="Department chart">` : `<div class="bars avoid-break">${deptBars || '<p class="muted">—</p>'}</div>`}

  <div class="two">
    <div><h2>Adoption by Age Group</h2><div class="bars">${ageBars || '<p class="muted">—</p>'}</div></div>
    <div><h2>Urban vs Rural</h2><div class="bars">${areaBars || '<p class="muted">—</p>'}</div></div>
  </div>

  <h2>Score Breakdown — 8 Dimensions (0–10)</h2>
  <div class="scg avoid-break">${scoreCards}</div>

  <div class="two">
    <div><h2>Best Segments</h2>${bestSegs}</div>
    <div><h2>Worst Segments</h2>${worstSegs}</div>
  </div>

  <h2>Main Objections</h2>
  ${objections}

  <div class="two">
    <div><h2>Pricing Judgment</h2>${pricing}</div>
    <div><h2>Positioning</h2>${positioning}</div>
  </div>

  <h2>Go-To-Market</h2>
  ${gtmHtml}

  <h2>Kill Criteria</h2>
  ${kill}

  <h2>7-Day Validation Plan</h2>
  <div class="avoid-break">${plan}</div>

  <h2>Key Takeaway</h2>
  <div class="takeaway">${esc(a.final_brutal_advice || '—')}</div>

  <div class="foot">Synthetic personas simulate behavior — they are not proof of real market demand. Generated by SV Market Simulator.</div>
</body></html>`;
}

app.post('/api/report', (req, res) => {
  try {
    const html = buildReportHTML(req.body || {});
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`SV Market Simulator → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[WARN] ANTHROPIC_API_KEY not set in .env');
});
