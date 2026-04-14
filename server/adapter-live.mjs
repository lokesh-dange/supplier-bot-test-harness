import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

export function loadLiveHandlers(exportRoot) {
  const entry = path.join(exportRoot, 'pipeline', 'handle-incoming-message.js');
  try {
    const mod = require(entry);
    if (typeof mod.handleIncomingMessage !== 'function' || typeof mod.handleConversationEnd !== 'function') {
      return { ok: false, error: 'handle-incoming-message.js missing exports', exportRoot, entry };
    }
    return { ok: true, mod, exportRoot, entry };
  } catch (e) {
    return { ok: false, error: e.message, exportRoot, entry };
  }
}

export function liveEnvReady() {
  if (process.env.SUPPLIER_BOT_HARNESS_LIVE !== '1' && process.env.SUPPLIER_BOT_HARNESS_LIVE !== 'true') {
    return { ok: false, reason: 'Set SUPPLIER_BOT_HARNESS_LIVE=1 to opt into live export + Gemini calls.' };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, reason: 'GEMINI_API_KEY required for live supplier-bot export (see export/pipeline/llm.js).' };
  }
  return { ok: true };
}
