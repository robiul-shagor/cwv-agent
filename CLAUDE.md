# CLAUDE.md

## Project
CWV Agent — an AI agent that diagnoses and fixes Core Web Vitals (LCP, INP, CLS) issues.
Full plan: see `PROJECT_PLAN.md`. Build phase by phase; do not jump ahead.

## Current phase
Phase 0 → Phase 1: TypeScript setup, LLM provider, tools (`run_pagespeed`, `get_crux`, `get_crux_history`, `fetch_html`), agent loop, `diagnose` CLI.

## Stack
- Node.js + TypeScript (ESM), run with `tsx`, tests with Vitest
- LLM: OpenAI-compatible LLM proxy (model `gpt-6-luna`) behind the `src/agent/llm/` provider interface (no direct Gemini SDK)
- Validation: zod (tool inputs + final report)
- No LangChain / no vector DB in v1

## Conventions
- Each tool lives in `src/tools/`, exports `{ name, description, inputSchema, execute }`, and is registered in `src/tools/index.ts`.
- Tools return **compact, LLM-friendly JSON summaries** — never raw API responses (PSI JSON is huge).
- Agent loop enforces max tool calls (~20) and logs every step.
- Secrets from `.env` only; never log or send them to the LLM.
- Code tools (`src/tools/code.ts`) are read-only and go through `CodeSource` (`src/source/`), which confines paths and blocks secret files — never read files directly.
- Code-modifying tools (later phases) write only to new branches.

## Environment (see `.env.example`)
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (proxy model id is `gpt-6-luna`, not `openai/gpt-6-luna`)
- `GOOGLE_API_KEY` (PageSpeed Insights API + Chrome UX Report API enabled)
- `GITHUB_TOKEN` (optional, read-only, for private repos linked as source)
- `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_TOTAL_TOKENS`, `TOOL_TIMEOUT_MS`, `LOG_LEVEL`

## Commands
- `npm run dev` → web UI at http://localhost:3000 (Express + static `src/web/`, live progress via SSE)
- `npm run diagnose -- <url> [--device mobile|desktop] [--source <folder|github repo>]`
- `npm test` · `npm run check` (typecheck + lint + tests + RUM build)
- `npm run build:rum` → `dist/rum/cwv-rum.js`; collector `POST /api/rum` (enabled by `RUM_KEYS`, JSONL in `RUM_DATA_DIR` until Postgres) + `get_rum` tool
- `simulate_session` needs Google Chrome (or `CHROME_PATH`); `playwright-core` is pinned, no bundled browsers
- `src/rum-client/index.ts` is browser code (checked with `tsconfig.rum.json`); keep shared logic DOM-free in `payload.ts`/`reporter.ts`
