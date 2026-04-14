import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { SCENARIOS_DIR, CONTRACT_FILE, HARNESS_ROOT, resolveExportRoot } from './paths.mjs';

const MANIFEST_FILE = path.join(HARNESS_ROOT, 'fixtures', 'capability-manifest.json');
import { handleIncomingMessageSim, handleConversationEndSim } from './adapter-simulated.mjs';
import { loadLiveHandlers, liveEnvReady } from './adapter-live.mjs';

function readJsonSafe(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse);
}

/**
 * @returns {Promise<{ok: boolean, manifest?: any, error?: string}>}
 */
export async function loadCapabilityManifest() {
  try {
    const manifest = await readJsonSafe(MANIFEST_FILE);
    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, error: 'manifest: not an object' };
    }
    if (manifest.version !== 1) {
      return { ok: false, error: 'manifest: version must be 1' };
    }
    if (!Array.isArray(manifest.capabilities)) {
      return { ok: false, error: 'manifest: capabilities must be an array' };
    }
    for (const cap of manifest.capabilities) {
      if (!cap || typeof cap !== 'object') return { ok: false, error: 'manifest: capability entry invalid' };
      if (!Number.isFinite(Number(cap.trackerRow))) return { ok: false, error: 'manifest: trackerRow invalid' };
      if (!cap.module || !cap.detail) return { ok: false, error: 'manifest: module/detail required' };
      if (!cap.trackerStatus) return { ok: false, error: 'manifest: trackerStatus required' };
      if (!cap.demoStatus) return { ok: false, error: 'manifest: demoStatus required' };
      if (!cap.proofMode) return { ok: false, error: 'manifest: proofMode required' };
      if (!Array.isArray(cap.scenarioIds)) return { ok: false, error: 'manifest: scenarioIds must be an array' };
      if (!('whatLokeshCanTest' in cap)) return { ok: false, error: 'manifest: whatLokeshCanTest required' };
      if (!('blockingReason' in cap)) return { ok: false, error: 'manifest: blockingReason key required' };
    }
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, error: `manifest read failed: ${e.message}` };
  }
}

/**
 * @param {any} manifest
 * @returns {Record<string, any[]>}
 */
export function scenarioCapabilityMatches(manifest, scenarioId) {
  const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  return caps.filter((c) => Array.isArray(c.scenarioIds) && c.scenarioIds.includes(scenarioId));
}

/**
 * @param {unknown} data
 * @returns {object[]}
 */
function scenariosFromFileData(data) {
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === 'object');
  }
  if (data && typeof data === 'object') {
    return [data];
  }
  return [];
}

function inferScenarioFamily(id, filename) {
  const source = `${id} ${filename}`.toLowerCase();
  if (source.includes('media')) return 'media';
  if (source.includes('scheduler')) return 'scheduler';
  if (source.includes('silence')) return 'silence';
  if (source.includes('escalation')) return 'escalation';
  if (source.includes('negotiation')) return 'negotiation';
  if (source.includes('goalgen')) return 'goals';
  if (source.includes('context')) return 'context';
  return 'uncategorized';
}

function summarizeScenarioListItem(item, filename, full) {
  const id = item.id || filename.replace(/\.json$/i, '');
  const harnessDemo = item.harnessDemo && typeof item.harnessDemo === 'object' ? item.harnessDemo : {};
  const harness = item.harness && typeof item.harness === 'object' ? item.harness : {};
  return {
    id,
    filename,
    title: item.title || item.id || filename,
    path: full,
    family: item.family || inferScenarioFamily(id, filename),
    tags: Array.isArray(item.tags) ? item.tags : [],
    trackerRows: Array.isArray(harnessDemo.trackerRows) ? harnessDemo.trackerRows : [],
    proves: Array.isArray(harnessDemo.proves) ? harnessDemo.proves : [],
    doesNotProve: Array.isArray(harnessDemo.doesNotProve) ? harnessDemo.doesNotProve : [],
    focus: harness.focus || null,
    mode: harness.mode || (Array.isArray(item.timeline) ? 'synthetic_timeline' : 'scenario_v1'),
    hasContextText: Boolean(item.contextText),
    expectations: item.expectations || null,
    provenance: item.provenance || null,
  };
}

export async function listScenarioFiles() {
  let names = [];
  try {
    names = await fs.readdir(SCENARIOS_DIR);
  } catch {
    return [];
  }
  const jsonFiles = names.filter((n) => n.endsWith('.json'));
  const out = [];
  for (const filename of jsonFiles) {
    const full = path.join(SCENARIOS_DIR, filename);
    try {
      const data = await readJsonSafe(full);
      const items = scenariosFromFileData(data);
      if (!items.length) {
        out.push({
          id: filename.replace(/\.json$/i, ''),
          filename,
          title: filename,
          path: full,
          family: null,
          tags: [],
          trackerRows: [],
          proves: [],
          doesNotProve: [],
          focus: null,
          mode: null,
          hasContextText: false,
          expectations: null,
          provenance: null,
        });
        continue;
      }
      for (const item of items) {
        out.push(summarizeScenarioListItem(item, filename, full));
      }
    } catch {
      out.push({
        id: filename.replace(/\.json$/i, ''),
        filename,
        title: filename,
        path: full,
        family: null,
        tags: [],
        trackerRows: [],
        proves: [],
        doesNotProve: [],
        focus: null,
        mode: null,
        hasContextText: false,
        expectations: null,
        provenance: null,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadScenarioById(scenarioId) {
  let names = [];
  try {
    names = await fs.readdir(SCENARIOS_DIR);
  } catch {
    names = [];
  }
  const jsonFiles = names.filter((n) => n.endsWith('.json'));
  for (const filename of jsonFiles) {
    const full = path.join(SCENARIOS_DIR, filename);
    let data;
    try {
      data = await readJsonSafe(full);
    } catch {
      continue;
    }
    for (const item of scenariosFromFileData(data)) {
      const id = item.id || filename.replace(/\.json$/i, '');
      if (id === scenarioId) return item;
    }
  }
  const direct = path.join(SCENARIOS_DIR, `${scenarioId}.json`);
  try {
    const data = await readJsonSafe(direct);
    const items = scenariosFromFileData(data);
    const hit = items.find((x) => (x.id || '') === scenarioId);
    if (hit) return hit;
    if (items.length === 1 && !scenarioId.includes('/')) return items[0];
  } catch {
    // fall through
  }
  throw new Error(`Scenario not found: ${scenarioId}`);
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function defaultSrFromScenario(scenario) {
  const t = scenario.title || scenario.id || 'Replay scenario';
  return {
    product: t,
    quantity: 'n/a',
    specs: 'fixture replay',
    customization: 'n/a',
    price: 'n/a',
  };
}

function inferSrFromBotText(text) {
  const s = (text || '').trim();
  if (!s) return null;
  return {
    product: s.slice(0, 200),
    quantity: 'n/a',
    specs: 'inferred from first bot message in replay',
    customization: 'n/a',
    price: 'n/a',
  };
}

function mapFixtureRowToMessage(row) {
  const h = row.harness || {};
  const role = h.role || (row.sent_by === 'bot' ? 'bot' : 'supplier');
  const content = String(h.body || row.content_translated || row.content || '');
  const urls = Array.isArray(h.mediaUrls) && h.mediaUrls.length ? h.mediaUrls : null;
  const images = urls || (Array.isArray(row.images) ? row.images : []);
  const msg = { role, content };
  if (images && images.length) msg.images = images;
  return msg;
}

async function normalizeHarnessScenario1(scenario) {
  const id = scenario.id || 'unnamed-scenario';
  const title = scenario.title || id;
  const harness = scenario.harness || {};
  const mode = harness.mode;

  if (mode === 'conversation_replay') {
    const rel = harness.fixturePath || 'fixtures/conversation-threads.sample.json';
    const fixtureAbs = path.isAbsolute(rel) ? rel : path.join(HARNESS_ROOT, rel);
    const bundle = await readJsonSafe(fixtureAbs);
    const convKey = String(harness.conversationId || scenario.provenance?.conversation_id || '');
    const thread = bundle[convKey];
    if (!Array.isArray(thread) || !thread.length) {
      throw new Error(
        `conversation_replay: no messages for conversationId "${convKey}" in ${fixtureAbs}`,
      );
    }
    const sorted = [...thread].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const mapped = sorted.map(mapFixtureRowToMessage);
    const firstSupplierIdx = mapped.findIndex((m) => m.role === 'supplier');
    if (firstSupplierIdx === -1) {
      throw new Error(`conversation_replay: thread "${convKey}" has no supplier messages`);
    }
    const initialHistory = mapped.slice(0, firstSupplierIdx);
    const sequence = [];
    for (let i = firstSupplierIdx; i < mapped.length; i += 1) {
      const m = mapped[i];
      if (m.role !== 'supplier') continue;
      const step = { type: 'message', role: 'supplier', content: m.content || '' };
      if (m.images && m.images.length) step.images = m.images;
      sequence.push(step);
    }
    if (!sequence.length) {
      throw new Error(`conversation_replay: no supplier steps derived for "${convKey}"`);
    }
    const firstBot = mapped.find((m) => m.role === 'bot' && m.content?.trim());
    const sr = inferSrFromBotText(firstBot?.content) || defaultSrFromScenario(scenario);
    const interpretationNote = scenario.interpretation?.noOverclaim
      ? String(scenario.interpretation.noOverclaim)
      : 'Replay uses supplier-side fixture text; simulated bot replies are not historical production text.';
    initialHistory.unshift({
      role: 'system',
      content: `[harness] conversation_replay ${convKey}: ${interpretationNote}`,
    });
    const out = {
      version: 1,
      id,
      title,
      sr,
      goals: [],
      initialHistory,
      sequence,
      options: { runConversationEnd: true, livePipeline: false },
    };
    if (scenario.contextText) out.contextText = String(scenario.contextText);
    if (scenario.harnessDemo) out.harnessDemo = clone(scenario.harnessDemo);
    return out;
  }

  if (mode === 'synthetic_timeline') {
    const tl = Array.isArray(scenario.timeline) ? [...scenario.timeline] : [];
    tl.sort((a, b) => Number(a.offsetMin) - Number(b.offsetMin));
    const mapped = tl.map((ev) => {
      const role = ev.actor === 'bot' ? 'bot' : 'supplier';
      const content = String(ev.text || '');
      return { role, content };
    });
    const firstSupplierIdx = mapped.findIndex((m) => m.role === 'supplier');
    if (firstSupplierIdx === -1) {
      throw new Error(`synthetic_timeline: scenario "${id}" has no supplier timeline messages`);
    }
    const initialHistory = mapped.slice(0, firstSupplierIdx);
    const sequence = [];
    for (let i = firstSupplierIdx; i < mapped.length; i += 1) {
      const m = mapped[i];
      if (m.role !== 'supplier') continue;
      sequence.push({ type: 'message', role: 'supplier', content: m.content || '' });
    }
    initialHistory.unshift({
      role: 'system',
      content:
        '[harness] synthetic_timeline: scheduler-shaped authoring. Inter-actor timing is metadata-only; handleIncomingMessage runs in supplier-step order with simulated bot replies.',
    });
    const out = {
      version: 1,
      id,
      title,
      sr: defaultSrFromScenario(scenario),
      goals: [],
      initialHistory,
      sequence,
      options: { runConversationEnd: true, livePipeline: false },
    };
    if (scenario.contextText) out.contextText = String(scenario.contextText);
    if (scenario.harnessDemo) out.harnessDemo = clone(scenario.harnessDemo);
    return out;
  }

  throw new Error(
    `Unsupported harness.mode "${mode || '(missing)'}" for schemaVersion harness-scenario/1 (scenario "${id}")`,
  );
}

async function toRunnableScenarioV1(raw) {
  if (raw && raw.version === 1 && raw.sr && Array.isArray(raw.sequence)) {
    return clone(raw);
  }
  if (raw && raw.schemaVersion === 'harness-scenario/1') {
    return normalizeHarnessScenario1(raw);
  }
  throw new Error(
    `Unsupported scenario schema (need version: 1 + sr + sequence, or schemaVersion: harness-scenario/1). id=${raw?.id || '(unknown)'}`,
  );
}

function collectMediaFromMessage(msg, provenance) {
  const items = [];
  const push = (kind, ref, label) => {
    if (!ref) return;
    const url = typeof ref === 'string' ? ref : ref.url || ref.href;
    if (!url) return;
    items.push({
      kind,
      url,
      mimeType: ref.mimeType || ref.contentType,
      label: label || ref.label || ref.filename,
      provenance,
    });
  };
  if (msg.media && Array.isArray(msg.media)) {
    for (const m of msg.media) push(m.kind || 'url', m.url || m, m.label);
  }
  if (Array.isArray(msg.images)) {
    for (const u of msg.images) push('image', u, 'images[]');
  }
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) push('file', a, 'attachments[]');
  }
  return items;
}

function isSchedulerish(tc) {
  const n = (tc.name || '').toLowerCase();
  return (
    n.includes('timing') ||
    n.includes('schedule') ||
    n.includes('follow') ||
    n.includes('defer')
  );
}

/**
 * @param {{ scenario?: object, scenarioId?: string }} params
 */
export async function runScenario(params) {
  const runId = crypto.randomUUID();
  const raw = params.scenario ? clone(params.scenario) : await loadScenarioById(params.scenarioId);
  const scenario = await toRunnableScenarioV1(raw);

  const scenarioWantsLive = scenario.options?.livePipeline === true;
  const envWantsLive =
    process.env.SUPPLIER_BOT_HARNESS_LIVE === '1' || process.env.SUPPLIER_BOT_HARNESS_LIVE === 'true';
  const wantLive = scenarioWantsLive || envWantsLive;

  const exportRoot = resolveExportRoot();
  let adapterMode = 'simulated';
  let liveMod = null;
  const warnings = [];
  const simulatedLayers = ['adapter-simulated.mjs'];

  if (wantLive) {
    const env = liveEnvReady();
    const loaded = loadLiveHandlers(exportRoot);
    if (env.ok && loaded.ok) {
      adapterMode = 'live';
      liveMod = loaded.mod;
      simulatedLayers.length = 0;
    } else {
      adapterMode = 'live_unavailable';
      if (!env.ok) warnings.push(env.reason);
      if (!loaded.ok) warnings.push(`Live import failed: ${loaded.error}`);
    }
  }

  const sr = scenario.sr;
  const goals = scenario.goals === undefined ? null : scenario.goals;
  const history = clone(scenario.initialHistory || []);
  const botToolTrace = [];
  const turns = [];
  const mediaIndex = [];
  const sequence = Array.isArray(scenario.sequence) ? scenario.sequence : [];

  const supplierSteps = sequence.filter((s) => s.type === 'message' && s.role === 'supplier');
  const totalSupplierTurns = supplierSteps.length;

  let supplierTurnIndex = 0;
  let stepIdx = 0;

  for (const step of sequence) {
    stepIdx += 1;
    if (step.type === 'annotation') continue;
    if (step.type !== 'message' || step.role !== 'supplier') {
      warnings.push(`Skipped unknown sequence step at index ${stepIdx}`);
      continue;
    }
    const msg = {
      role: 'supplier',
      content: step.content || '',
    };
    if (step.media) msg.media = step.media;
    if (step.images) msg.images = step.images;
    if (step.attachments) msg.attachments = step.attachments;
    history.push(msg);
    for (const m of collectMediaFromMessage(msg, 'scenario_message')) {
      mediaIndex.push({ ...m, step: supplierTurnIndex });
    }

    const ctx = { supplierTurnIndex, totalSupplierTurns };
    let reply;
    let toolCalls;
    let status;

    if (adapterMode === 'live' && liveMod) {
      try {
        const r = await liveMod.handleIncomingMessage({
          sr,
          goals,
          history,
          contextText: scenario.contextText,
          backend: scenario.options?.backend,
          promptPath: scenario.options?.promptPath,
        });
        reply = r.reply;
        toolCalls = r.toolCalls || [];
        status = r.status;
        const __snap = [...r.history];
        history.length = 0;
        history.push(...__snap);
      } catch (e) {
        warnings.push(`Live handleIncomingMessage error: ${e.message}`);
        const r = await handleIncomingMessageSim({ sr, goals, history }, ctx);
        reply = r.reply;
        toolCalls = r.toolCalls;
        status = r.status;
        const __snap = [...r.history];
        history.length = 0;
        history.push(...__snap);
        simulatedLayers.push('fallback-after-live-error');
        adapterMode = 'live_unavailable';
      }
    } else {
      const r = await handleIncomingMessageSim({ sr, goals, history }, ctx);
      reply = r.reply;
      toolCalls = r.toolCalls;
      status = r.status;
      const __snap = [...r.history];
      history.length = 0;
      history.push(...__snap);
    }

    for (const tc of toolCalls) {
      botToolTrace.push({ turn: supplierTurnIndex + 1, step: stepIdx, ...tc });
    }

    const schedHints = toolCalls.filter(isSchedulerish);
    turns.push({
      index: supplierTurnIndex,
      reply,
      status,
      toolCalls,
      noSend: !reply,
      schedulerHints: schedHints,
    });

    supplierTurnIndex += 1;
  }

  let conversationEnd = null;
  const runEnd = scenario.options?.runConversationEnd !== false;
  if (runEnd) {
    if (adapterMode === 'live' && liveMod) {
      try {
        conversationEnd = await liveMod.handleConversationEnd({
          sr,
          goals: goals || [],
          history,
          botToolTrace,
          sendToBrain: !!scenario.options?.sendToBrain,
        });
      } catch (e) {
        warnings.push(`Live handleConversationEnd error: ${e.message}`);
        conversationEnd = await handleConversationEndSim({
          sr,
          goals,
          history,
          botToolTrace,
        });
        simulatedLayers.push('conversationEnd-simulated-after-live-error');
      }
    } else {
      conversationEnd = await handleConversationEndSim({
        sr,
        goals,
        history,
        botToolTrace,
      });
      if (adapterMode !== 'live' || simulatedLayers.length) {
        simulatedLayers.push('conversationEnd-simulated');
      }
    }
  }

  const endTools = conversationEnd?.toolCalls || [];
  const schedulerView = {
    emittedToolCalls: endTools.filter(isSchedulerish),
    notes: [
      'Production: Sourcy cron executes scheduled follow-ups; this harness only displays emitted tool payloads.',
      adapterMode === 'simulated' || simulatedLayers.length
        ? 'Some layers may be simulated — see provenance.simulatedLayers.'
        : 'Live adapter used for pipeline calls.',
    ],
    sourcyExecution: 'Cron-side trigger execution is owned by Sourcy, not this harness.',
  };

  const manifestLoad = await loadCapabilityManifest();
  const capabilityCoverage = manifestLoad.ok
    ? scenarioCapabilityMatches(manifestLoad.manifest, scenario.id).map((c) => ({
        trackerRow: c.trackerRow,
        module: c.module,
        demoStatus: c.demoStatus,
        proofMode: c.proofMode,
        scenarioIds: Array.isArray(c.scenarioIds) ? [...c.scenarioIds] : [],
        blockingReason: c.blockingReason ?? null,
      }))
    : [{ trackerRow: null, module: 'Capability manifest', demoStatus: 'blocked', proofMode: 'blocked', scenarioIds: [], blockingReason: manifestLoad.error || 'manifest unavailable' }];

  const inputsView = {
    scenarioId: scenario.id,
    sr,
    goals,
    contextText: scenario.contextText || null,
    harnessDemo: scenario.harnessDemo || null,
  };

  return {
    runId,
    scenarioId: scenario.id,
    adapterMode,
    transcript: history,
    turns,
    mediaIndex,
    schedulerView,
    conversationEnd,
    inputsView,
    capabilityCoverage,
    provenance: {
      simulatedLayers: [...new Set(simulatedLayers)],
      liveExportPath: wantLive ? exportRoot : null,
      warnings,
      contractFile: CONTRACT_FILE,
      capabilityManifestOk: manifestLoad.ok,
      capabilityManifestError: manifestLoad.ok ? null : manifestLoad.error || null,
    },
  };
}

export async function readContract() {
  return readJsonSafe(CONTRACT_FILE);
}
