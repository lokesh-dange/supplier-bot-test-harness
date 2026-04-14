import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HARNESS_ROOT = path.resolve(__dirname, '..');
export const SCENARIOS_DIR = path.join(HARNESS_ROOT, 'scenarios');
export const CONTRACT_FILE = path.join(HARNESS_ROOT, 'contracts', 'harness-contract.json');
export const UI_DIR = path.join(HARNESS_ROOT, 'ui');

export const DEFAULT_EXPORT_ROOT = path.resolve(HARNESS_ROOT, '..', 'supplier-bot', 'export');

export function resolveExportRoot() {
  const raw = process.env.SUPPLIER_BOT_EXPORT_PATH;
  return raw ? path.resolve(raw) : DEFAULT_EXPORT_ROOT;
}
