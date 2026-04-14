# Sourcy Supplier Bot — Evaluation Harness

Interactive evaluation dashboard for the Sourcy supplier-bot pipeline. Renders real eval run results, lets you inspect every pipeline stage per turn, and fork conversations to test alternative inputs.

## Quick Start

```bash
cd workdir/test-harness
npm run check   # verify fixtures + UI integrity
npm start       # http://127.0.0.1:8799/
```

Custom port: `PORT=8802 npm start`

## What This Does

**8 pages** matching the team's evaluation workflow:

| Page | What it shows |
|------|---------------|
| **Dashboard** | KPIs, supplier funnel, score heatmap across 14 eval dimensions |
| **Smoke Tests** | Pass/fail status for 8 integration smoke tests |
| **Evals** | Eval dimension breakdown by category (Core Quality, Conv. Mgmt, Edge Cases) |
| **Conversations** | Real transcripts from eval runs — 8 scored (v1) + 13 unscored (v2) |
| **Playground** | **Pipeline Inspector** — turn-by-turn view with fork & re-run |
| **Goals** | Goal coverage template and per-case goal completion |
| **Structured Output** | Extracted supplier cards from eval runs |
| **Benchmark** | Comparison against Nelson baseline |

## Pipeline Inspector (Playground)

The core interactive feature. Pick any of the 21 eval cases and see:

```
Context Panel (editable)
├── SR: product, quantity, specs, price, customization
├── Goals: tier 1/2 with achieved/missed status
└── Cross-Supplier Context: {{CONTEXT}} injection for negotiation testing

Turn Timeline
├── T0 (bot opening): 你好，看到你们的不锈钢保温杯...
├── T1 [⑂ Fork]: supplier → bot exchange, with eval annotations
├── T2 [⑂ Fork]: supplier → bot exchange
└── T3 [⑂ Fork]: E10:fail E1:partial — Bot did not respond

Eval Results (14 dimensions) + Supplier Card (structured output)
```

**Fork from any turn:** click "⑂ Fork here" to:
- See prior conversation as faded chat bubbles (context)
- See the original turn's messages and eval annotations
- Edit SR fields, goals, and cross-supplier context above
- Type alternative supplier messages to test different bot behavior

## Data Sources

All data comes from formal eval runs, not generated on the fly:

| Source | Path | Contents |
|--------|------|----------|
| Benchmark cases (v1) | `supplier-bot/benchmark/cases/media-escalation-scheduler-v1.json` | 8 cases with SR, goals, history |
| Benchmark cases (v2) | `supplier-bot/benchmark/cases/media-escalation-scheduler-v2.json` | 13 additional cases |
| Benchmark results | `supplier-bot/benchmark/results/baseline-dyn-v3-final-2026-03-31.json` | Scores + full 14-dimension eval per case |
| Seed data | `fixtures/seed-eval-data.json` | Pre-computed: turns, pipeline traces, supplier cards, annotations |

## Modes

| Mode | When | What happens |
|------|------|--------------|
| **Simulated** (default) | No env vars needed | Bot replies use pattern-matched Chinese templates |
| **Live** | `SUPPLIER_BOT_HARNESS_LIVE=1` + `GEMINI_API_KEY` | Bot replies go through real Gemini pipeline |

The Playground shows a mode banner (green = live, amber = demo) so you always know which mode is active.

## Cross-Supplier Context Testing

The pipeline supports a `{{CONTEXT}}` injection that feeds cross-supplier intelligence into the bot's prompt. In all 8 scored eval runs, this was empty ("No cross-supplier context yet") — which is why S1 (negotiation) was `attempted: false` across all cases.

To test negotiation behavior:
1. Go to Playground → pick a case
2. Fork at the turn after a price quote
3. Add context: "Supplier B quoted ¥2.5/unit for 2000pcs"
4. Send a supplier message with a price
5. See the bot use that context (in live mode) or see the negotiation indicator (in demo mode)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` / `SOURCY_HARNESS_PORT` | `8799` | Server port |
| `SOURCY_HARNESS_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for Docker/deploy) |
| `SUPPLIER_BOT_HARNESS_LIVE` | unset | Set to `1` for live Gemini pipeline |
| `GEMINI_API_KEY` | unset | Required for live mode |
| `SUPPLIER_BOT_EXPORT_PATH` | `../supplier-bot/export` | Path to pipeline export modules |

## Deploy

**Local (recommended for eval):**
```bash
npm start
```

**Docker:**
```bash
docker build -t sourcy-harness .
docker run --rm -p 8799:8799 sourcy-harness
```

**Render:** use included `render.yaml` (Docker web service, free plan).

## Checks

```bash
npm run check          # runtime + UI checks
npm run check:runtime  # contract, scenarios, fixtures
npm run check:ui       # required HTML elements
```

## Files

```
server/
  harness-server.mjs      # HTTP server + API endpoints
  adapter-simulated.mjs   # Simulated bot (Chinese reply templates)
  adapter-live.mjs        # Live Gemini pipeline adapter
  run-pipeline.mjs        # Scenario runner
  check-runtime.mjs       # Runtime contract checks
  check-ui.mjs            # UI element checks
ui/
  index.html              # 8-page dashboard HTML
  harness-app.js          # Frontend logic (pipeline inspector, fork, rendering)
  styles.css              # Styling
fixtures/
  seed-eval-data.json     # 21 eval cases with turns, traces, supplier cards
  capability-manifest.json
  sample-conversations.json
scenarios/                # Scenario pack JSON files
contracts/                # Integration contract spec
Dockerfile, render.yaml   # Deploy scaffolding
```
