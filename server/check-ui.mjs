import fs from 'fs/promises';
import path from 'path';
import { UI_DIR } from './paths.mjs';

const REQUIRED = [
  'id="sr-select"',
  'id="status-filter"',
  'id="supplier-filter"',
  'id="page-dashboard"',
  'id="page-smoke"',
  'id="page-evals"',
  'id="page-conversations"',
  'id="page-goals"',
  'id="page-structured"',
  'id="page-insert"',
  'id="page-benchmark"',
  'id="dash-header"',
  'id="dash-kpis"',
  'id="dash-heatmap"',
  'id="smoke-list"',
  'id="smoke-save"',
  'id="eval-categories"',
  'id="conv-messages"',
  'id="goals-list"',
  'id="structured-table"',
  'id="insert-convo"',
  'id="bench-banner"',
  'id="interactive-chat-send"',
  'id="pg-chat-send"',
];

async function main() {
  const htmlPath = path.join(UI_DIR, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  console.log('--- check-ui: index.html ---');
  for (const token of REQUIRED) {
    const ok = html.includes(token);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${token}`);
    if (!ok) throw new Error(`Missing ${token}`);
  }
  const jsPath = path.join(UI_DIR, 'harness-app.js');
  await fs.readFile(jsPath, 'utf8');
  console.log('  PASS - harness-app.js present');
  console.log('\\n--- check-ui: summary ---');
  console.log('Required UI elements: PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
