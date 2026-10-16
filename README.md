# CWV Agent

AI agent that diagnoses Core Web Vitals (LCP, INP, CLS) like a performance engineer: it measures with
PageSpeed Insights + CrUX, inspects the HTML, and returns an evidence-backed, schema-validated report.
See `PROJECT_PLAN.md` for the roadmap (currently Phase 1).

## Setup

```bash
npm install
cp .env.example .env   # then fill in LLM_API_KEY and GOOGLE_API_KEY
```

`GOOGLE_API_KEY` needs the **PageSpeed Insights API** and **Chrome UX Report API** enabled in Google Cloud.

## Usage

```bash
npm run diagnose -- https://example.com --device mobile
npm run diagnose -- example.com -d desktop --json
```

- Report (markdown) is printed to stdout; logs go to stderr.
- `reports/` — markdown + JSON report per run.
- `runs/` — full step-by-step audit log of every LLM turn and tool call (secrets redacted).

Exit codes: `0` success, `1` run failed, `2` usage/config error.

## Linking source code (find the exact file & line)

Give the agent the site's code and it adds a **locate** step: it turns PSI/HTML evidence (selectors, class names, image /
script / font file names, visible text) into code searches, reads the matching files, and reports `file:line` with a
code-level fix and, for contained changes, a suggested diff (never applied).

```bash
npm run diagnose -- https://example.com --source ~/Projects/example-site          # local folder
npm run diagnose -- https://example.com --source https://github.com/owner/repo    # GitHub (default branch)
npm run diagnose -- https://example.com --source owner/repo#feature-branch        # branch, tag or commit
```

In the web UI use the **Source code** field (remembered per site).

- Tools: `list_files`, `search_code` (ripgrep, pure-Node fallback), `read_file` — read-only, confined to the source root
  (no `..` or symlink escapes); `node_modules`, build output and VCS dirs are skipped.
- Secrets are never read: `.env*` (except examples), keys/certs, `.npmrc`, `wp-config.php`, credential files; secret-looking
  values in code are masked before reaching the LLM.
- GitHub repos are shallow-cloned to a temp dir and deleted after the run. Private repos need `GITHUB_TOKEN`
  (fine-grained, *Contents: read-only*); the token is passed via git env config, never in URLs or argv.
- Cited files/lines are verified against the source before a report is accepted.
- The code should match what is deployed; if the agent can't find the live page's selectors/text it says so in
  *Data gaps* instead of guessing. Linking code adds up to 15 tool calls to the budget.

## Web UI

```bash
npm run dev     # watch mode → http://localhost:3000
npm start       # same, without file watching
```

Enter a URL, pick mobile/desktop, and watch the investigation live (each LLM turn and tool call is streamed),
then read the report: CWV status, findings with fix/impact/evidence, data gaps, and Markdown/JSON downloads.
Past reports (from `reports/`) are listed on the right.

- One diagnosis at a time (PSI quota + LLM cost); a second request gets `409`.
- Binds to `127.0.0.1` by default (`HOST`/`PORT` in `.env`). It has no authentication — don't expose it publicly yet.
- Rejects cross-origin POSTs and unexpected `Host` headers (DNS rebinding); strict CSP; only public URLs are accepted.

API: `POST /api/runs {url, device}` · `GET /api/runs/:id` · `GET /api/runs/:id/events` (SSE) ·
`POST /api/runs/:id/cancel` · `GET /api/reports` · `GET /api/reports/:name[.md|.json]`.

## RUM client (real-user monitoring)

A small browser script (`src/rum-client/`) built on `web-vitals/attribution`. It reports LCP, INP, CLS, FCP and TTFB
with attribution: LCP element + phases, INP interaction target + slowest script, CLS shift source, TTFB breakdown.

```bash
npm run build:rum   # → dist/rum/cwv-rum.js (~7.6 KB gzip, budget 8 KB)
```

Install on a site:

```html
<script async src="https://your-cdn/cwv-rum.js"
  data-endpoint="https://your-collector/api/rum"
  data-key="pk_project_key"
  data-sample-rate="0.5"
  data-consent="required"></script>
```

| Attribute | Default | Purpose |
|---|---|---|
| `data-endpoint` | — (required) | Collector URL; receives `POST` beacons (`text/plain` JSON, no CORS preflight) |
| `data-key` | — (required) | Public project key (not a secret) |
| `data-sample-rate` | `1` | Fraction of page views measured (decided once per view) |
| `data-consent` | off | `required` → nothing is sent until `window.cwvRum.consent()` is called |
| `data-keep-query` | none | Comma-separated query params to keep; all others are stripped from URLs |
| `data-debug` | `false` | Log metrics to the console |

Or set `window.cwvRumConfig = { endpoint, key, sampleRate, consentRequired, keepQueryParams, debug }` before the
script loads (tag managers). API: `window.cwvRum.consent()`, `.revokeConsent()`, `.flush()`.

Privacy: no cookies or identifiers, query strings/fragments stripped, no data sent before consent when required.
The payload contract is `src/rum-client/schema.ts` (zod). A metric can be re-sent with an updated value (same `id`);
the collector keeps the latest per id.

### Collector (`POST /api/rum`) and `get_rum`

```bash
# .env — public project key → allowed site hosts (subdomains and www. included)
RUM_KEYS=pk_live_abc123=example.com
RUM_DATA_DIR=data/rum
```

`npm run dev` then also serves the script at `/rum/cwv-rum.js` and accepts beacons at `/api/rum` (cross-site
`text/plain`, validated against the schema, project key and site host, rate-limited per IP). Beacons are stored as
JSONL per site and day (`data/rum/<site>/<YYYY-MM-DD>.jsonl`, 90-day retention) until the Postgres phase.
The collector must be reachable from real visitors (public host/HTTPS, `HOST=0.0.0.0` behind a reverse proxy).

The agent's `get_rum` tool turns this into p75 per device plus attribution CrUX lacks: shifting elements (during vs
after load), slow interactions with phases and the blocking script + owner, LCP elements with subpart medians,
navigation types and worst pages. Allow a few days / a few hundred page views before trusting the p75s.

## Simulated sessions (`simulate_session`)

Real Chrome (installed Google Chrome, or `CHROME_PATH`) driven by `playwright-core`, mobile profile with 4× CPU
slowdown + slow 4G: load → 4 s idle → accept consent → scroll to the bottom → menu → accordions/tabs → navigate away
and back. Every layout shift is attributed to the step, the moved element and the likely cause (DOM inserted/resized
just before); every interaction gets phases and the scripts that ran (long-animation-frame attribution); the
back/forward cache is tested for real (Chrome's not-restored reasons). All requests are limited to public hosts.

## Development

```bash
npm run check      # typecheck (node + browser) + lint + tests + RUM build
npm run format
```

## Layout

| Path | Purpose |
|---|---|
| `src/agent/loop.ts` | Tool-calling loop: budgets (tool calls, tokens, timeouts), validation, step logging |
| `src/agent/llm/` | Provider interface + OpenAI-compatible provider (LLM proxy) |
| `src/agent/report.ts` | Final report zod schema + markdown renderer |
| `src/agent/prompts/`, `src/agent/playbook/` | System prompt + CWV playbook |
| `src/tools/` | `run_pagespeed`, `get_crux`, `get_crux_history`, `fetch_html`, `check_field_factors`, `inspect_platform`, `simulate_session`, `get_rum` (compact LLM-friendly summaries) |
| `src/browser/` | Chrome session driver, in-page instrumentation, session analysis |
| `src/rum/` | RUM JSONL store + aggregation (p75, attribution) |
| `src/cli/diagnose.ts` | CLI entry point |
| `src/api/` | Express server: run manager (live runs + SSE), reports API, security middleware |
| `src/source/` | Code sources: local folder + GitHub shallow clone (`CodeSource` interface) |
| `src/tools/code.ts` | `list_files`, `search_code`, `read_file` |
| `src/web/` | Web UI (static HTML/CSS/vanilla JS, no build step) |
| `src/rum-client/` | Browser RUM script (`index.ts`), DOM-free payload/reporter logic, server payload schema |
| `scripts/build-rum.ts` | esbuild bundle + size budget for the RUM script |

## Safety

- Secrets come only from `.env`, are validated at startup and redacted from logs/run files; they are never sent to the LLM.
- `fetch_html` blocks private/loopback/link-local targets (including via redirects) and caps response size.
- Page content is treated as untrusted data in the prompt.
