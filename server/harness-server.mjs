import http from 'http';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { UI_DIR, CONTRACT_FILE } from './paths.mjs';

// ── Load .env (zero-dependency) ──
try {
  const envPath = path.join(import.meta.dirname || '.', '..', '.env');
  const envLines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file — rely on shell env */ }
import { listScenarioFiles, runScenario, readContract, loadCapabilityManifest, scenarioCapabilityMatches } from './run-pipeline.mjs';
import { liveEnvReady } from './adapter-live.mjs';
import { resolveExportRoot } from './paths.mjs';
import { loadLiveHandlers } from './adapter-live.mjs';

// ── Transcript parser ──
function parseTranscript(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n');
  const messages = [];
  let currentRole = null, currentContent = [];

  for (const line of lines) {
    const match = line.match(/^(Bot|Supplier|bot|supplier)\s*[:：]\s*(.*)/i);
    if (match) {
      if (currentRole) {
        messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
      }
      currentRole = match[1].toLowerCase();
      currentContent = [match[2]];
    } else if (currentRole) {
      currentContent.push(line);
    }
  }
  if (currentRole) {
    messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
  }
  // If no pattern matched, return the whole thing as a single message
  if (!messages.length && text.trim()) {
    messages.push({ role: 'system', content: text.trim() });
  }
  return messages;
}

// ── Translation cache ──
const translationCache = new Map();

const PORT = Number(process.env.SOURCY_HARNESS_PORT || process.env.PORT || 8799);
const HOST = process.env.SOURCY_HARNESS_HOST || '127.0.0.1';
const URL_PARSE_HOST = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function staticFile(urlPath, res) {
  const rel = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\//, '');
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(UI_DIR, normalized);
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _parseError: true };
  }
}


// ── Interactive chat session state ──
const chatSessions = new Map();

function getChatSession(sessionId) {
  if (!chatSessions.has(sessionId)) {
    chatSessions.set(sessionId, {
      history: [],
      sr: { product: 'Interactive test', quantity: 'n/a', specs: 'Live input from Lokesh', customization: 'n/a', price: 'n/a' },
      goals: [],
      contextText: '',
      turnIndex: 0,
    });
  }
  return chatSessions.get(sessionId);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${URL_PARSE_HOST}:${PORT}`);
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    const exportRoot = resolveExportRoot();
    const live = loadLiveHandlers(exportRoot);
    const env = liveEnvReady();
    let adapterMode = 'simulated';
    if (env.ok && live.ok) adapterMode = 'live_ready';
    else if (process.env.SUPPLIER_BOT_HARNESS_LIVE === '1' || process.env.SUPPLIER_BOT_HARNESS_LIVE === 'true') {
      adapterMode = 'live_unavailable';
    }
    json(res, 200, {
      ok: true,
      harnessVersion: '0.1.0',
      adapterMode,
      exportRoot,
      liveImportOk: live.ok,
      liveEnvOk: env.ok,
      port: PORT,
      bindHost: HOST,
    });
    return;
  }

  if (pathname === '/api/contract' && req.method === 'GET') {
    try {
      const contract = await readContract();
      json(res, 200, { contract });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/scenarios' && req.method === 'GET') {
    try {
      const scenarios = await listScenarioFiles();
      json(res, 200, { scenarios });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/capabilities' && req.method === 'GET') {
    try {
      const loaded = await loadCapabilityManifest();
      if (!loaded.ok) {
        json(res, 500, { error: loaded.error || 'manifest invalid' });
        return;
      }
      const manifest = loaded.manifest;
      const scenarios = await listScenarioFiles();
      const scenarioIndex = {};
      for (const s of scenarios) {
        scenarioIndex[s.id] = scenarioCapabilityMatches(manifest, s.id).map((c) => ({
          trackerRow: c.trackerRow,
          module: c.module,
          demoStatus: c.demoStatus,
          proofMode: c.proofMode,
        }));
      }
      json(res, 200, { manifest, scenarioIndex });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    if (body._parseError) {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const scenarioId = body.scenarioId;
    if (!scenarioId || typeof scenarioId !== 'string') {
      json(res, 400, { error: 'scenarioId required' });
      return;
    }
    try {
      const result = await runScenario({ scenarioId });
      json(res, 200, result);
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }



  if (pathname === '/api/eval-data' && req.method === 'GET') {
    try {
      const seedPath = path.join(import.meta.dirname || '.', '..', 'fixtures', 'seed-eval-data.json');
      const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));

      // Merge inserts into suppliers
      let inserts = [];
      try {
        const insertsPath = path.join(import.meta.dirname || '.', '..', 'fixtures', 'inserts.json');
        inserts = JSON.parse(await fs.readFile(insertsPath, 'utf8'));
      } catch { /* no inserts yet */ }

      for (const ins of inserts) {
        const transcript = parseTranscript(ins.conversation || '');
        let score = 0, max = 0;
        const dimensions = {};
        if (ins.scores) {
          for (const [k, v] of Object.entries(ins.scores)) {
            dimensions[k] = v.score;
            if (v.score === 'pass') { score += 1; max += 1; }
            else if (v.score === 'partial') { score += 0.5; max += 1; }
            else if (v.score === 'fail') { max += 1; }
          }
        }
        seed.suppliers.push({
          id: ins.supplierId || `#ins-${Date.now()}`,
          caseId: `insert-${ins.supplierId}-${ins.insertedAt?.slice(0,10) || 'unknown'}`,
          name: ins.supplierName || ins.supplierId,
          name_en: ins.supplierName || ins.supplierId,
          displayName: ins.supplierName || ins.supplierId,
          displayName_en: ins.supplierName || ins.supplierId,
          status: ins.status || 'completed',
          score, max,
          percent: max > 0 ? Math.round(score / max * 100) : 0,
          category: 'inserted',
          dimensions,
          sr: { product: ins.supplierName || ins.supplierId, product_en: ins.supplierName || ins.supplierId },
          goals: [],
          transcript,
          evalSummary: ins.scores ? `Auto-scored via Gemini (${Object.keys(ins.scores).length} dims)` : '',
          notes: `Inserted ${ins.insertedAt || ''}`,
          _isInsert: true,
          _sr: ins.sr || seed.sr.id,
        });
      }

      json(res, 200, seed);
    } catch (e) {
      json(res, 500, { error: 'Failed to load eval data: ' + e.message });
    }
    return;
  }

  if (pathname === '/api/conversations' && req.method === 'GET') {
    try {
      const convosPath = path.join(import.meta.dirname || '.', '..', 'fixtures', 'sample-conversations.json');
      const convos = JSON.parse(await fs.readFile(convosPath, 'utf8'));
      json(res, 200, { conversations: convos });
    } catch (e) {
      json(res, 200, { conversations: [] });
    }
    return;
  }

  if (pathname === '/api/smoke-tests' && req.method === 'POST') {
    const body = await readBody(req);
    const tests = body.tests;
    if (!Array.isArray(tests)) { json(res, 400, { error: 'tests array required' }); return; }
    const seedPath = path.join(import.meta.dirname || '.', '..', 'fixtures', 'seed-eval-data.json');
    try {
      const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
      seed.smokeTests = tests;
      await fs.writeFile(seedPath, JSON.stringify(seed, null, 2));
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }


  if (pathname === '/api/insert' && req.method === 'POST') {
    const body = await readBody(req);
    if (body._parseError) { json(res, 400, { error: 'Invalid JSON body' }); return; }
    const insertsPath = path.join(import.meta.dirname || '.', '..', 'fixtures', 'inserts.json');
    let inserts = [];
    try { inserts = JSON.parse(await fs.readFile(insertsPath, 'utf8')); } catch { inserts = []; }
    inserts.push({ ...body, insertedAt: new Date().toISOString() });
    await fs.writeFile(insertsPath, JSON.stringify(inserts, null, 2));
    json(res, 200, { ok: true, count: inserts.length });
    return;
  }

  if (pathname === '/api/chat/status' && req.method === 'GET') {
    const { loadLiveHandlers, liveEnvReady } = await import('./adapter-live.mjs');
    const exportRoot = resolveExportRoot();
    const live = loadLiveHandlers(exportRoot);
    const env = liveEnvReady();
    const wantLive = env.ok && live.ok && (process.env.SUPPLIER_BOT_HARNESS_LIVE === '1' || process.env.SUPPLIER_BOT_HARNESS_LIVE === 'true');
    json(res, 200, {
      mode: wantLive ? 'live' : 'simulated',
      geminiKey: !!process.env.GEMINI_API_KEY,
      liveEnvReady: env.ok,
      liveHandlers: live.ok,
      harnessLive: process.env.SUPPLIER_BOT_HARNESS_LIVE,
    });
    return;
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    if (body._parseError) { json(res, 400, { error: 'Invalid JSON body' }); return; }
    const message = String(body.message || '').trim();
    if (!message) { json(res, 400, { error: 'message required' }); return; }
    const sessionId = String(body.sessionId || 'default');
    const session = getChatSession(sessionId);

    if (body.sr && typeof body.sr === 'object') {
      session.sr = { ...session.sr, ...body.sr };
    }
    if (Array.isArray(body.goals) && body.goals.length) {
      session.goals = body.goals;
    }
    if (typeof body.contextText === 'string') {
      session.contextText = body.contextText;
    }

    // Pre-fill history if this is a fork initialization
    if (Array.isArray(body.prefillHistory) && body.prefillHistory.length && session.history.length === 0) {
      session.history = body.prefillHistory;
      session.turnIndex = body.prefillHistory.filter(m => m.role === 'supplier').length;
    }

    // Skip the __init__ sentinel — it's just for loading context
    if (message === '__init__') {
      json(res, 200, { reply: null, status: 'initialized', adapterMode: 'prefill', turnIndex: session.turnIndex });
      return;
    }

    session.history.push({ role: 'supplier', content: message });

    const { handleIncomingMessageSim } = await import('./adapter-simulated.mjs');
    const { loadLiveHandlers, liveEnvReady } = await import('./adapter-live.mjs');
    const exportRoot = resolveExportRoot();
    const live = loadLiveHandlers(exportRoot);
    const env = liveEnvReady();
    const wantLive = env.ok && live.ok && (process.env.SUPPLIER_BOT_HARNESS_LIVE === '1' || process.env.SUPPLIER_BOT_HARNESS_LIVE === 'true');

    let reply, toolCalls, status, adapterMode;
    const ctx = { supplierTurnIndex: session.turnIndex, totalSupplierTurns: 999 };

    if (wantLive && live.mod) {
      try {
        const r = await live.mod.handleIncomingMessage({
          sr: session.sr,
          goals: session.goals,
          history: session.history,
          contextText: session.contextText || null,
        });
        reply = r.reply || r.text || '';
        toolCalls = r.toolCalls || [];
        status = r.status || 'continue';
        adapterMode = 'live';
        if (reply) session.history.push({ role: 'bot', content: reply });
      } catch (e) {
        const r = await handleIncomingMessageSim({ sr: session.sr, goals: session.goals, history: session.history, contextText: session.contextText || '' }, ctx);
        reply = r.reply; toolCalls = r.toolCalls; status = r.status;
        adapterMode = 'simulated';
      }
    } else {
      const r = await handleIncomingMessageSim({ sr: session.sr, goals: session.goals, history: session.history, contextText: session.contextText || '' }, ctx);
      reply = r.reply; toolCalls = r.toolCalls; status = r.status;
      adapterMode = 'simulated';
    }

    session.turnIndex += 1;

    json(res, 200, {
      sessionId,
      adapterMode,
      reply,
      toolCalls: toolCalls || [],
      status,
      contextInjected: !!(session.contextText?.trim()),
      history: session.history,
      turnIndex: session.turnIndex,
    });
    return;
  }

  if (pathname === '/api/chat/reset' && req.method === 'POST') {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || 'default');
    chatSessions.delete(sessionId);
    json(res, 200, { ok: true, sessionId });
    return;
  }

  // ── Translate via Gemini ──
  if (pathname === '/api/translate' && req.method === 'POST') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { json(res, 400, { error: 'GEMINI_API_KEY not set.' }); return; }
    const body = await readBody(req);
    const texts = body.texts;
    if (!Array.isArray(texts) || !texts.length) { json(res, 400, { error: 'texts array required' }); return; }

    // Check cache first
    const needed = [];
    const neededIdx = [];
    const results = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      if (translationCache.has(texts[i])) {
        results[i] = translationCache.get(texts[i]);
      } else {
        needed.push(texts[i]);
        neededIdx.push(i);
      }
    }

    if (needed.length) {
      try {
        const prompt = `Translate the following Chinese texts to English. Return ONLY a JSON array of translated strings in the same order. Keep translations natural and concise.\n\n${JSON.stringify(needed)}`;
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
            }),
          }
        );
        if (geminiRes.ok) {
          const data = await geminiRes.json();
          const translated = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
          for (let i = 0; i < needed.length; i++) {
            const t = translated[i] || needed[i];
            translationCache.set(needed[i], t);
            results[neededIdx[i]] = t;
          }
        } else {
          // Fallback: return originals
          for (let i = 0; i < needed.length; i++) results[neededIdx[i]] = needed[i];
        }
      } catch {
        for (let i = 0; i < needed.length; i++) results[neededIdx[i]] = needed[i];
      }
    }

    json(res, 200, { translations: results });
    return;
  }

  // ── Auto-score via Gemini LLM judge ──
  if (pathname === '/api/auto-score' && req.method === 'POST') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      json(res, 400, { error: 'GEMINI_API_KEY not set. Add it to .env and restart.' });
      return;
    }
    const body = await readBody(req);
    if (body._parseError) { json(res, 400, { error: 'Invalid JSON body' }); return; }
    const conversation = String(body.conversation || '').trim();
    if (!conversation) { json(res, 400, { error: 'conversation required' }); return; }

    const seedPath = path.join(import.meta.dirname || '.', '..', 'fixtures', 'seed-eval-data.json');
    let dims;
    try {
      const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
      dims = seed.evalDimensions;
    } catch (e) {
      json(res, 500, { error: 'Failed to load eval dimensions: ' + e.message });
      return;
    }

    const dimList = Object.entries(dims).map(([k, v]) => `- ${k} (${v.name}, category: ${v.category})`).join('\n');

    const prompt = `You are an eval judge for a supplier-bot conversation system. Score the following conversation on each eval dimension.

## Eval Dimensions
${dimList}

## Conversation Transcript
${conversation}

## Instructions
For each dimension, return a JSON object with:
- "score": one of "pass", "partial", "fail", or "n/a"
- "notes": brief explanation (1 sentence)

If the dimension doesn't apply to this conversation, score "n/a".

Return ONLY a JSON object mapping dimension keys to score objects. Example:
{"E1": {"score": "pass", "notes": "All goals addressed"}, "E2": {"score": "partial", "notes": "Two questions in turn 3"}}`;

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
        }
      );
      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        json(res, 502, { error: `Gemini API error (${geminiRes.status}): ${errText}` });
        return;
      }
      const geminiData = await geminiRes.json();
      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const scores = JSON.parse(text);
      json(res, 200, { scores });
    } catch (e) {
      json(res, 500, { error: 'Auto-score failed: ' + e.message });
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    json(res, 404, { error: 'Unknown API route' });
    return;
  }

  await staticFile(pathname, res);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : HOST;
  const browse = HOST === '0.0.0.0' ? `http://127.0.0.1:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Sourcy supplier test harness listening on ${displayHost}:${PORT}`);
  console.log(`UI: ${browse}/  | contract: ${CONTRACT_FILE}`);
});
