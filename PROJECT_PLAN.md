# Project Plan: CWV Agent — AI Core Web Vitals Diagnostic & Fix Agent

## 1. Goal

Build an AI agent that investigates a website's Core Web Vitals like a performance engineer would:
**measure → diagnose → locate → fix → verify**.

Used two ways:
1. **Internal tool** to fix my own website.
2. **Client service** — deliver audits and fixes so client sites pass Core Web Vitals (LCP, INP, CLS) at p75.

The agent finds the exact cause of a failing metric, explains it, and where safe, writes the fix and proves it worked with before/after measurements.

---

## 2. Key Decisions

| Decision | Choice | Why |
|---|---|---|
| Language | **Node.js + TypeScript** | Lighthouse, Puppeteer and `web-vitals` are JS-native; clients' code is JS/TS; one language end to end |
| Agent framework | **Plain LLM SDK tool-calling loop** (no LangChain in v1) | ~50 lines, full control, easy to debug. Revisit Vercel AI SDK / LangGraph.js only if needed (pause/resume, human approval mid-run) |
| LLM | **Gemini** via `@google/genai`, behind a small provider interface | Can swap to Claude/OpenAI later without touching the agent |
| Main measurement | **PageSpeed Insights API** | No Chrome to run, matches what clients see on pagespeed.web.dev, includes CrUX data |
| Field data | **CrUX API** + own **`web-vitals` RUM** | CrUX = what Google ranks on; RUM = exact element/phase/script, and the only good INP source |
| Local browser (Lighthouse/Puppeteer) | **Later phase only** | Needed for verifying fixes on preview/staging/localhost, and deep inspection |
| RAG | **Not in v1** — curated markdown playbook in the system prompt | CWV best practices fit in a few thousand tokens. Later: `pgvector` in Postgres if a large fix library grows |
| Database | **Postgres** + Drizzle (or Prisma) | Projects, runs, telemetry, memory in one place |
| Background jobs | **BullMQ + Redis** | PSI runs and agent investigations take 30s–minutes |
| Repo access | Local `fs` + ripgrep; **GitHub App** (not personal tokens) for client repos | Safer, scoped, revocable |

---

## 3. Data Sources & Order of Trust

| Source | Gives | Available | Trust for diagnosis |
|---|---|---|---|
| **web-vitals RUM (attribution build)** | Exact LCP element + phase split, INP interaction target + long-animation-frame scripts, CLS shift element, TTFB breakdown | After install + traffic | 1st (most precise) |
| **PSI API (Lighthouse lab)** | LCP element, render-blocking resources, unused JS/CSS, image sizes, TBT, opportunities | Immediately, any public URL | 2nd (strong clues) |
| **CrUX API / CrUX History API** | p75 LCP/INP/CLS per URL/origin, phone vs desktop, trends | Only sites with enough traffic | The score we must pass |

Notes:
- Lab tests (PSI) **cannot measure INP** — they give TBT as a proxy. RUM is required for real INP diagnosis.
- CrUX is a **28-day rolling window** → fixes take up to ~4 weeks to fully show in Search Console. Must be in client expectations.
- Small sites may have **no CrUX data** → our RUM p75 becomes their field data.

---

## 4. Architecture

```
            ┌──────────────── CLI (diagnose <url>) ────────────────┐
            │                                                      │
 Dashboard ─┤──> Express API ──> BullMQ job ──> Agent Runner ──────┤
 (later)    │                                   │                  │
            │                         LLM (Gemini, tool calling)   │
            │                                   │                  │
            │        ┌──────────── Tools ───────┴──────────┐       │
            │        │ measure: run_pagespeed, get_crux,   │       │
            │        │          get_crux_history, get_rum  │       │
            │        │ inspect: fetch_html, (inspect_element)│     │
            │        │ code:    list_files, search_code,   │       │
            │        │          read_file                  │       │
            │        │ act:     propose_patch, verify      │       │
            │        │ memory:  get_site_memory            │       │
            │        └─────────────────────────────────────┘       │
            │                                                      │
 RUM script on client sites ──beacon──> /api/rum ──> Postgres <────┘
```

### Agent loop

1. Load context: project config, site memory (past findings/fixes), CWV playbook.
2. LLM decides the next tool call → we run it → return a **compact summary** of the result.
3. Repeat until the LLM returns a final structured report, or a limit is hit.
4. Save every step (tool, input, output summary, LLM reasoning) to `run_steps`.

**Limits:** max ~20 tool calls per run, max token budget per run, timeout per tool.

**Important:** never pass raw PSI JSON (huge) to the LLM. Each tool returns a trimmed, structured summary (metrics, LCP element, top opportunities with savings, top render-blocking resources, etc.).

---

## 5. Tools Specification

Every tool: `name`, `description` (written for the LLM), `inputSchema` (zod), `execute()`, returns compact JSON.

| Tool | Input | Returns | Phase |
|---|---|---|---|
| `run_pagespeed` | url, strategy (mobile/desktop) | Lab metrics (LCP, CLS, TBT, FCP, SI, TTFB), LCP element + its phase breakdown, top opportunities/diagnostics with savings, render-blocking resources, large images, third-party summary, plus CrUX field data from the same response | 1 |
| `get_crux` | url or origin, formFactor | p75 LCP/INP/CLS/TTFB/FCP + good/NI/poor distribution, or "no data" | 1 |
| `get_crux_history` | url or origin, formFactor | Weekly p75 trend per metric | 1 |
| `fetch_html` | url | Trimmed `<head>` (preloads, scripts, styles, fonts order), script tags list, img tags near top, meta viewport | 1 |
| `get_site_memory` | projectId | Summary of past findings, fixes, results | 2 |
| `get_rum` | url/route, metric, days | p75 per metric, top LCP elements + phase averages, top slow INP targets + top blocking scripts, top CLS shift sources; sample counts by device | 3 |
| `list_files` | path, glob | File tree (filtered: no node_modules/.git/build) | 4 |
| `search_code` | query (string/regex), path | Matches with file + line + snippet (ripgrep) | 4 |
| `read_file` | path, line range | File content (truncated if large) | 4 |
| `propose_patch` | path, unified diff, reason | Applies to a new branch only, returns result | 5 |
| `verify` | url (live or preview), runs (default 3) | Median before/after per metric | 5 |
| `inspect_element` | url, selector | Element size, attributes, computed styles, visibility (Puppeteer) | 5 |

---

## 6. Agent Output (Final Report Schema)

```json
{
  "url": "https://example.com/product/123",
  "device": "mobile",
  "summary": "LCP fails (4.1s p75) mainly due to late-discovered hero image.",
  "status": { "LCP": "poor", "INP": "good", "CLS": "needs-improvement" },
  "findings": [
    {
      "metric": "LCP",
      "severity": "high",
      "rootCause": "Hero image is lazy-loaded and has no fetchpriority, so it is discovered late.",
      "evidence": [
        "RUM: resourceLoadDelay p75 1800ms on img.main-banner",
        "PSI: LCP element is img.main-banner, 'Largest Contentful Paint image was lazily loaded'"
      ],
      "location": { "file": "src/components/Hero.tsx", "line": 42 },
      "fixType": "auto",
      "fix": "Remove loading=lazy, add fetchpriority=high and explicit width/height.",
      "patch": "<unified diff or null>",
      "expectedImpact": "LCP -1.0 to -1.5s",
      "confidence": "high"
    }
  ],
  "notInCode": [
    "TTFB p75 is 900ms — server/CDN caching needed (recommendation only)"
  ],
  "verification": null
}
```

`fixType`:
- **auto** — safe, contained code changes → patch + PR
- **recommend** — server, CDN, caching, third-party removal, large refactors → precise instructions for a human
- **platform** — no repo (WordPress/Shopify/Webflow) → step-by-step settings/plugin/theme instructions

---

## 7. CWV Playbook (System Prompt Knowledge)

Store as markdown in `src/agent/playbook/`, loaded into the system prompt. Organized by metric → phase → cause → evidence → fix.

- **LCP**
  - High TTFB → server, caching, CDN, redirects
  - High resource load delay → lazy-loaded LCP image, no preload, image injected by JS, CSS background image, low fetchpriority
  - High resource load duration → oversized image, wrong format, no responsive `srcset`, no CDN
  - High render delay → render-blocking CSS/JS, web fonts blocking text, client-side rendering, A/B test scripts hiding content
- **INP**
  - High input delay → long tasks during load, heavy third-party scripts, hydration
  - High processing time → heavy event handlers, sync work, large re-renders → yield to main thread, debounce, move work off main thread
  - High presentation delay → large DOM, layout thrashing, expensive style recalcs
- **CLS**
  - Images/iframes/ads without dimensions, late-injected banners, web fonts swapping, animations of layout properties
- **Framework-specific notes** — Next.js (`next/image` priority, `next/font`, server components), React, Vue/Nuxt, WordPress, Shopify

Rules for the agent (in system prompt):
- Always cite evidence for each finding.
- Prefer the most precise source (RUM > PSI > CrUX).
- Never claim a fix works without `verify`.
- Classify every fix as auto / recommend / platform.

---

## 8. Database Schema (Postgres)

| Table | Key fields |
|---|---|
| `projects` | id, name, domain, platform (custom/wordpress/shopify/other), source_type (none/local/github), source_ref, rum_key, created_at |
| `pages` | id, project_id, url, route_pattern, priority |
| `runs` | id, project_id, page_id, status, trigger (manual/scheduled/alert), started_at, finished_at, report_json, tokens_used, cost_estimate |
| `run_steps` | id, run_id, step_no, tool_name, input_json, output_summary_json, llm_reasoning, duration_ms |
| `findings` | id, run_id, metric, severity, root_cause, fix_type, location, status (open/fixed/ignored) |
| `fixes` | id, finding_id, patch, branch, pr_url, before_json, after_json, verified |
| `crux_snapshots` | id, page_id or origin, form_factor, date, p75 metrics json |
| `rum_events` | id, project_id, url, metric, value, rating, attribution_json, device, connection, created_at (sampled; partition/retention ~90 days) |
| `rum_daily` | project_id, url, metric, device, date, p75, count, top_attribution_json |
| `site_memory` | project_id, summary_text, updated_at |

---

## 9. Folder Structure

```
cwv-agent/
├── CLAUDE.md
├── PROJECT_PLAN.md
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── agent/
│   │   ├── loop.ts              # tool-calling loop, limits, step logging
│   │   ├── llm/                 # provider interface + gemini.ts
│   │   ├── prompts/system.md
│   │   ├── playbook/            # lcp.md, inp.md, cls.md, frameworks/*.md
│   │   └── report.ts            # final report schema (zod) + validation
│   ├── tools/
│   │   ├── index.ts             # registry
│   │   ├── pagespeed.ts
│   │   ├── crux.ts
│   │   ├── fetchHtml.ts
│   │   ├── rum.ts
│   │   ├── memory.ts
│   │   ├── code/                # listFiles, searchCode, readFile (local + github)
│   │   └── act/                 # proposePatch, verify, inspectElement
│   ├── api/                     # Express server + routes
│   ├── jobs/                    # BullMQ queues + workers
│   ├── db/                      # schema + migrations
│   ├── reports/                 # render report → markdown/HTML for clients
│   ├── rum-client/              # browser script using web-vitals/attribution
│   └── cli/diagnose.ts
└── tests/
```

---

## 10. Phased Build Plan

### Phase 0 — Setup (Day 1)
- Node + TypeScript project, ESLint/Prettier, `tsx` for running, Vitest.
- `.env`: `GEMINI_API_KEY`, `GOOGLE_API_KEY` (PSI + CrUX, enable both APIs in Google Cloud), later `DATABASE_URL`, `REDIS_URL`, GitHub App keys.
- LLM provider interface + Gemini implementation.

### Phase 1 — Agent + Measurement CLI (Week 1–2)
- Tools: `run_pagespeed`, `get_crux`, `get_crux_history`, `fetch_html` with compact summaries.
- Agent loop with step/token limits and step logging (to JSON file for now).
- System prompt + CWV playbook v1.
- Final report validated with zod; render to markdown.
- CLI: `npm run diagnose -- https://mysite.com --device mobile`

**Done when:** running it on my own site produces a correct, evidence-backed diagnosis I agree with.

### Phase 2 — Persistence, Memory, API, Jobs (Week 3)
- Postgres + schema (projects, pages, runs, run_steps, findings, crux_snapshots, site_memory).
- `get_site_memory` tool; update memory summary after each run.
- Express API: create project, add pages, start run, get run/report.
- BullMQ worker runs the agent; scheduled daily CrUX snapshots.
- Client-facing report export (HTML/PDF).

**Done when:** I can onboard a client site via API, run a diagnosis in the background, and download a report.

### Phase 3 — RUM (Week 4)
- `rum-client`: small script using `web-vitals/attribution`, sends via `navigator.sendBeacon`, sampling rate, project key, consent hook.
- `POST /api/rum` endpoint: validate, rate-limit, store in `rum_events`.
- Daily aggregation → `rum_daily` (p75 + top attribution per URL/metric/device).
- `get_rum` tool for the agent.

**Done when:** RUM is installed on my site and the agent uses RUM evidence (especially INP) in its findings.

### Phase 4 — Code Access & Locate (Week 5)
- Local mode: `list_files`, `search_code` (ripgrep), `read_file`, ignoring node_modules/.git/build dirs.
- GitHub mode: GitHub App install flow, same tools via Octokit (tree, contents, code search or clone to temp dir).
- Agent locates the source of findings by searching selectors, class names, image filenames, script URLs.

**Done when:** for my own site, findings include the correct file and line.

### Phase 5 — Fix & Verify (Week 6–7)
- `propose_patch`: apply diff on a new branch only; open PR in GitHub mode.
- Local Lighthouse + Puppeteer runner for previews/staging/localhost; `inspect_element`.
- `verify`: median of 3+ runs, before vs after; PR description includes evidence + before/after.
- Rule: no PR without measured improvement → otherwise report as recommendation.
- Optional human-approval step before PR.

**Done when:** the agent opens a PR on my site that measurably improves a metric.

### Phase 6 — Dashboard & Multi-Client (Week 8+)
- Next.js/React dashboard: projects, CrUX vs RUM split view (red/yellow/green), runs, step timeline, findings, diff viewer, PR links.
- Alerts when a metric crosses thresholds → auto-run the agent.
- Per-client report branding.

### Phase 7 — Hardening
- Cost tracking per run, caching of PSI results, retries/backoff on API limits.
- Security: secrets encryption, GitHub App least-privilege scopes, RUM endpoint abuse protection.
- Evaluation set: a folder of known-bad test pages with expected findings, to check agent quality when changing prompts/models.

---

## 11. Guardrails

- Read-only by default; writes only to new branches, never main/production.
- Max tool calls and token budget per run.
- Never send secrets or full `.env` files to the LLM (filter in `read_file`).
- No unverified fix claims.
- Every run fully logged (becomes the audit trail and client report).

---

## 12. Service Delivery Notes

- **Day 1 for a new client:** PSI + CrUX diagnosis → report (works with no install).
- **Then:** install RUM script (needs client approval + privacy/consent note), collect 1–2 weeks of data for INP.
- **Fix:** auto PRs for code fixes; instructions for server/CDN/platform fixes.
- **Expectations:** CrUX is a 28-day rolling window; "passing" in Search Console lags fixes by up to ~4 weeks. Show RUM before/after in the meantime.
- Platforms: custom JS/TS (full automation), WordPress/Shopify/Webflow (diagnosis + instructions).

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| LLM wrong diagnosis | Evidence required per finding, playbook, verify step, evaluation set |
| Broken client site from a patch | Branch + PR only, verification, human approval |
| PSI rate limits / variance | Caching, median of multiple runs, local Lighthouse fallback |
| No CrUX data for small sites | Use own RUM as field data |
| LLM cost | Compact tool summaries, step limits, cost tracking per run |
| Client privacy (RUM) | Sampling, no personal data, consent hook |
