# INP playbook

PSI cannot measure INP (TBT is only a proxy). Field INP comes from CrUX (p75) and RUM; `simulate_session` measures INP of real simulated taps.

## High input delay (main thread busy when the user interacts)
- Evidence: high TBT, `bootup-time`, `mainthread-work-breakdown`, long tasks, heavy third parties (tag managers, chat widgets,
  A/B testing, ads), large hydration bundles.
- Fix: defer/remove third parties, load widgets on interaction, code-split, reduce hydration (islands/server components),
  break up long tasks (`scheduler.yield()` / `setTimeout` chunks).

## High processing time (slow event handlers)
- Causes: heavy synchronous handler work, large framework re-renders, synchronous storage/layout reads in handlers.
- Fix: yield before non-urgent work, debounce, memoise/narrow re-renders, move work to a Web Worker, optimistic UI.
- Needs RUM attribution (interaction target + LoAF scripts) for precise location — say so in data gaps.

## High presentation delay
- Causes: very large DOM (`dom-size` > ~1,500 nodes), layout thrashing, expensive style recalculation, big client-rendered updates.
- Fix: reduce DOM size, `content-visibility: auto` for off-screen sections, avoid forced synchronous layout.

## Field INP attribution
- `get_rum` → `inp.topInteractions`: "click on <target>", share of bad visits, median phases, `duringLoad`, and the
  longest script (URL, owner, invoker) — name these in the finding.
- `simulate_session` → `inp.interactions`: the simulated taps (consent, menu, widgets) with phases and the scripts that
  ran (long-animation-frame attribution). A consent "Accept" firing all tags synchronously is a classic INP cause.
- High input delay + `duringLoad` → main thread busy during load (TBT causes). High processing → the handler itself.
  High presentation → large DOM / re-render after the handler.

