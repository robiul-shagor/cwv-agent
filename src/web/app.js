// CWV Agent web UI. Vanilla JS, no build step.
// All report content is rendered with textContent (never innerHTML): findings can quote untrusted page content.

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder: h('div', { class: 'x' }, 'text', child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const TOOL_LABELS = {
  run_pagespeed: 'PageSpeed Insights lab test',
  get_crux: 'Chrome UX Report field data',
  get_crux_history: 'CrUX weekly trend',
  fetch_html: 'HTML inspection',
  check_field_factors: 'Caching & bfcache check',
  inspect_platform: 'Platform & plugin detection',
  simulate_session: 'Simulated user session',
  get_rum: 'Real-user monitoring (RUM)',
  inspect_script: 'Map script to source',
  prepare_source: 'Prepare source code',
  list_files: 'List project files',
  search_code: 'Search code',
  read_file: 'Read file',
  submit_report: 'Final report',
};

const RATING_LABEL = {
  good: 'Good',
  'needs-improvement': 'Needs improvement',
  poor: 'Poor',
  unknown: 'Unknown',
};
const STATUS_SOURCE = {
  'field-url': 'Real-user data (this URL)',
  'field-origin': 'Real-user data (whole site)',
  lab: 'Lab test only',
};
const ASSESSMENT_RATING = { passed: 'good', failed: 'poor', 'no-data': 'unknown' };
const ASSESSMENT_LABEL = { passed: 'Passed', failed: 'Failed', 'no-data': 'No data' };
const ASSESSMENT_SCOPE = { url: 'this URL', origin: 'whole site', none: 'no field data' };
const METRIC_NAMES = { LCP: 'Loading', INP: 'Interactivity', CLS: 'Visual stability' };
const FIX_TYPE = { auto: 'Code fix', recommend: 'Recommendation', platform: 'Platform settings' };

const els = {
  form: $('#run-form'),
  url: $('#url'),
  source: $('#source'),
  runBtn: $('#run-btn'),
  formError: $('#form-error'),
  progress: $('#progress'),
  progressTarget: $('#progress-target'),
  steps: $('#steps'),
  elapsed: $('#elapsed'),
  cancelBtn: $('#cancel-btn'),
  report: $('#report'),
  historyList: $('#history-list'),
  historyEmpty: $('#history-empty'),
  historyRefresh: $('#history-refresh'),
};

let current = { runId: null, source: null, timer: null, startedAt: 0, pendingEl: null };

async function api(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function showError(message) {
  els.formError.textContent = message;
  els.formError.hidden = !message;
}

function setBusy(busy) {
  els.runBtn.disabled = busy;
  els.runBtn.textContent = busy ? 'Running…' : 'Run diagnosis';
  els.cancelBtn.hidden = !busy;
}

// ── Live progress ────────────────────────────────────────────────────────────

function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  if (input.source) parts.push(input.source);
  if (input.query) parts.push(`"${input.query}"${input.glob ? ` in ${input.glob}` : ''}`);
  if (input.file)
    parts.push(
      `${input.file}${input.startLine ? `:${input.startLine}${input.endLine ? `-${input.endLine}` : ''}` : ''}`,
    );
  if (!input.query && !input.file && input.path && input.path !== '.') parts.push(input.path);
  if (!input.query && input.glob) parts.push(input.glob);
  if (input.url) parts.push(input.url);
  if (input.strategy || input.device) parts.push(input.strategy ?? input.device);
  if (input.scope) parts.push(`scope: ${input.scope}`);
  if (input.weeks) parts.push(`${input.weeks} weeks`);
  return parts.join(' · ');
}

function setPending(text) {
  current.pendingEl?.remove();
  current.pendingEl = h(
    'li',
    { class: 'step' },
    h('span', { class: 'step-icon pending', 'aria-hidden': 'true' }),
    h('div', {}, h('div', { class: 'step-title' }, text)),
    h('span'),
  );
  els.steps.append(current.pendingEl);
}

function addStep(step) {
  current.pendingEl?.remove();
  current.pendingEl = null;
  const failed = Boolean(step.error);
  let title;
  let detail;
  let icon;
  if (step.kind === 'llm') {
    title = 'Agent reasoning';
    detail = `${step.note ?? ''}${step.tokens ? ` · ${step.tokens.toLocaleString()} tokens` : ''}`;
    icon = h('span', { class: 'step-icon llm', 'aria-hidden': 'true' }, 'AI');
  } else {
    title = TOOL_LABELS[step.toolName] ?? step.toolName;
    detail = step.kind === 'report' ? step.note : (step.note ?? describeInput(step.input));
    icon = h(
      'span',
      { class: `step-icon${failed ? ' err' : ''}`, 'aria-hidden': 'true' },
      failed ? '!' : '✓',
    );
  }
  els.steps.append(
    h(
      'li',
      { class: 'step' },
      icon,
      h(
        'div',
        {},
        h('div', { class: 'step-title' }, title),
        detail ? h('div', { class: 'step-detail' }, detail) : null,
        failed ? h('div', { class: 'step-error' }, step.error) : null,
      ),
      h('span', { class: 'step-time' }, fmtMs(step.durationMs)),
    ),
  );
  // What happens next: after the model asks for tools they run; after tools the model thinks again.
  if (step.kind === 'setup' && failed) return;
  if (step.kind === 'llm' && step.note?.startsWith('Requested')) setPending('Running tools…');
  else if (step.kind !== 'report' || failed) setPending('Agent is analysing the evidence…');
}

function startTimer() {
  clearInterval(current.timer);
  current.timer = setInterval(() => {
    els.elapsed.textContent = `${Math.round((Date.now() - current.startedAt) / 1000)}s`;
  }, 500);
}

function stopRun() {
  clearInterval(current.timer);
  current.source?.close();
  current.source = null;
  current.pendingEl?.remove();
  current.pendingEl = null;
  setBusy(false);
}

function watchRun(run) {
  current.runId = run.id;
  current.startedAt = Date.parse(run.startedAt) || Date.now();
  els.progress.hidden = false;
  els.report.hidden = true;
  els.steps.replaceChildren();
  els.progressTarget.textContent = `${run.url} · ${run.device}`;
  setBusy(run.status === 'running');
  startTimer();
  setPending(run.sourceSpec ? 'Preparing source code…' : 'Agent is planning the investigation…');

  const source = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/events`);
  current.source = source;
  source.addEventListener('step', (e) => addStep(JSON.parse(e.data).step));
  source.addEventListener('done', (e) => {
    const { outcome } = JSON.parse(e.data);
    stopRun();
    els.elapsed.textContent = fmtMs(outcome.durationMs);
    if (outcome.status === 'completed' && outcome.report) {
      renderReport(outcome.report, outcome.reportName, outcome);
      setUrlParam('report', outcome.reportName);
      loadHistory(outcome.reportName);
    } else {
      renderFailure(outcome);
    }
  });
  source.onerror = () => {
    // EventSource reconnects automatically; the server replays steps, so just reset the list.
    if (source.readyState === EventSource.CONNECTING) els.steps.replaceChildren();
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

function ratingEl(rating, label) {
  return h(
    'span',
    { class: `metric-rating r-${rating}` },
    h('span', { class: 'dot' }),
    label ?? RATING_LABEL[rating] ?? rating,
  );
}

function renderFinding(f, i) {
  const loc = f.location ?? {};
  const where = [
    loc.file ? h('code', {}, `${loc.file}${loc.line ? `:${loc.line}` : ''}`) : null,
    loc.selector ? h('code', {}, loc.selector) : null,
    loc.resourceUrl ? h('code', {}, loc.resourceUrl) : null,
    loc.owner ? h('span', { class: 'chip' }, loc.owner) : null,
    loc.origin ? h('span', { class: 'chip' }, `from ${loc.origin}`) : null,
  ].filter(Boolean);

  return h(
    'article',
    { class: `finding sev-${f.severity}` },
    h(
      'div',
      { class: 'finding-top' },
      h('span', { class: 'badge metric-badge' }, f.metric),
      h('span', { class: `badge sev-${f.severity}` }, `${f.severity} severity`),
      h('span', { class: 'badge' }, `${f.confidence} confidence`),
      h('span', { class: 'badge' }, FIX_TYPE[f.fixType] ?? f.fixType),
    ),
    h('h3', {}, `${i + 1}. ${f.rootCause}`),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Fix'),
      h('dd', {}, f.fix),
      h('dt', {}, 'Expected impact'),
      h('dd', {}, f.expectedImpact),
      where.length
        ? [h('dt', {}, 'Location'), h('dd', {}, ...where.flatMap((w, j) => (j ? [' ', w] : [w])))]
        : null,
    ),
    h(
      'details',
      { class: 'evidence' },
      h('summary', {}, `Evidence (${f.evidence.length})`),
      h(
        'ul',
        {},
        f.evidence.map((e) => h('li', {}, e)),
      ),
    ),
    f.patch
      ? [
          h('div', { class: 'patch-label' }, 'Suggested change (not applied)'),
          h('pre', { class: 'patch' }, f.patch),
        ]
      : null,
  );
}

function renderReport(report, name, meta) {
  const downloads = name
    ? h(
        'div',
        { class: 'downloads' },
        h(
          'a',
          { class: 'btn btn-ghost btn-link', href: `/api/reports/${encodeURIComponent(name)}.md` },
          'Markdown',
        ),
        h(
          'a',
          { class: 'btn btn-ghost btn-link', href: `/api/reports/${encodeURIComponent(name)}.json` },
          'JSON',
        ),
      )
    : null;

  const chips = [
    report.device,
    STATUS_SOURCE[report.statusSource] ?? report.statusSource,
    meta?.source ? `Source: ${meta.source}` : 'No source linked',
    meta?.toolCalls !== undefined ? `${meta.toolCalls} tool calls` : null,
    meta?.usage
      ? `${meta.usage.totalTokens.toLocaleString()} tokens` +
        (meta.usage.cachedInputTokens ? ` (${meta.usage.cachedInputTokens.toLocaleString()} cached)` : '')
      : null,
  ].filter(Boolean);

  const sections = [
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'report-head' },
        h(
          'div',
          {},
          h('h2', { class: 'card-title' }, 'Diagnosis'),
          h('div', { class: 'report-url' }, report.url),
          h(
            'div',
            { class: 'chips' },
            chips.map((c) => h('span', { class: 'chip' }, c)),
          ),
        ),
        downloads,
      ),
      h('p', { class: 'summary' }, report.summary),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'section-title' }, 'Core Web Vitals status'),
      report.assessment
        ? h(
            'p',
            { class: 'assessment' },
            h('strong', {}, `Google assessment (${ASSESSMENT_SCOPE[report.assessment.scope]}): `),
            ratingEl(ASSESSMENT_RATING[report.assessment.result], ASSESSMENT_LABEL[report.assessment.result]),
            report.assessment.failing?.length
              ? h('span', { class: 'muted' }, `failing ${report.assessment.failing.join(', ')}`)
              : null,
          )
        : null,
      h(
        'div',
        { class: 'metrics' },
        ['LCP', 'INP', 'CLS'].map((m) =>
          h(
            'div',
            { class: 'metric' },
            h('div', { class: 'metric-name' }, `${m} `, h('span', {}, `· ${METRIC_NAMES[m]}`)),
            ratingEl(report.status[m]),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'section-title' }, `Findings (${report.findings.length})`),
      report.findings.length
        ? h('div', { class: 'findings' }, report.findings.map(renderFinding))
        : h('p', { class: 'muted' }, 'No actionable findings.'),
    ),
  ];

  if (report.labFieldGap?.length) {
    sections.splice(
      2,
      0,
      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'section-title' }, 'Why lab and real users disagree'),
        h(
          'ul',
          { class: 'list' },
          report.labFieldGap.map((g) =>
            h('li', {}, h('strong', {}, `${g.metric}: `), `${g.lab} vs ${g.field}. ${g.explanation}`),
          ),
        ),
      ),
    );
  }
  if (report.labIntegrity && report.labIntegrity.verdict !== 'trustworthy') {
    const label = report.labIntegrity.verdict === 'gamed' ? 'Gamed' : 'Suspicious';
    sections.splice(
      2,
      0,
      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'section-title' }, 'Is the PageSpeed score real?'),
        h('p', {}, h('strong', {}, `${label}: `), report.labIntegrity.explanation),
      ),
    );
  }
  if (report.notInCode?.length) sections.push(listSection('Outside the codebase', report.notInCode));
  if (report.nextSteps?.length) sections.push(listSection('Next steps to confirm', report.nextSteps));
  sections.push(renderRumCard(report));
  if (report.dataGaps?.length) sections.push(listSection('Data gaps', report.dataGaps));
  sections.push(
    h(
      'p',
      { class: 'muted footnote' },
      'Field data (CrUX) is a 28-day rolling window: improvements take up to ~4 weeks to show in Search Console. No fix has been verified yet.',
    ),
  );

  els.report.replaceChildren(...sections);
  els.report.hidden = false;
}

function listSection(title, items) {
  return h(
    'section',
    { class: 'card' },
    h('h2', { class: 'section-title' }, title),
    h(
      'ul',
      { class: 'list' },
      items.map((n) => h('li', {}, n)),
    ),
  );
}

function renderFailure(outcome) {
  els.report.replaceChildren(
    h(
      'section',
      { class: 'card' },
      h(
        'h2',
        { class: 'section-title' },
        outcome.status === 'cancelled' ? 'Diagnosis cancelled' : 'Diagnosis failed',
      ),
      h('div', { class: 'alert' }, outcome.error ?? 'Unknown error'),
    ),
  );
  els.report.hidden = false;
}

// ── RUM install guide ────────────────────────────────────────────────────────

const RUM_PLATFORMS = {
  html: 'HTML',
  wordpress: 'WordPress',
  shopify: 'Shopify',
  nextjs: 'Next.js',
  gtm: 'Tag Manager',
};

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'pk_live_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function copyButton(getText) {
  const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select & copy manually';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1800);
  });
  return btn;
}

function codeBlock(text) {
  return h(
    'div',
    { class: 'code-block' },
    h(
      'div',
      { class: 'code-actions' },
      copyButton(() => text),
    ),
    h('pre', { class: 'patch' }, text),
  );
}

function rumSnippets(s, key) {
  const tag = `<script async src="${s.scriptUrl}"\n  data-endpoint="${s.endpoint}"\n  data-key="${key}"\n  data-sample-rate="1"></script>`;
  const config = `window.cwvRumConfig = { endpoint: "${s.endpoint}", key: "${key}" };`;
  return {
    html: {
      steps: ['Paste this into the <head> of every page (or your shared layout / header template).'],
      code: tag,
    },
    wordpress: {
      steps: [
        'Easiest: install the free "WPCode" plugin → Code Snippets → Add Snippet → "HTML Snippet".',
        'Paste the code, set Location to "Site Wide Header", activate and save.',
        'Or in a child theme’s functions.php, use the PHP version below. Purge your cache plugin afterwards.',
      ],
      code: `<?php\nadd_action('wp_head', function () { ?>\n  ${tag.replace(/\n/g, '\n  ')}\n<?php }, 1);`,
    },
    shopify: {
      steps: [
        'Admin → Online Store → Themes → … → Edit code.',
        'Open layout/theme.liquid and paste the code just before </head>. Save.',
      ],
      code: tag,
    },
    nextjs: {
      steps: [
        'App Router: add both <Script> tags to app/layout.tsx (inside <body>).',
        'Pages Router: add them to pages/_document.tsx (beforeInteractive only works there). Redeploy.',
      ],
      code: `import Script from 'next/script';\n\n<Script id="cwv-rum-config" strategy="beforeInteractive">\n  {\`${config}\`}\n</Script>\n<Script src="${s.scriptUrl}" strategy="afterInteractive" />`,
    },
    gtm: {
      steps: [
        'Tags → New → Tag type "Custom HTML". Paste the code.',
        'Trigger: "Initialization - All Pages" (or "All Pages"). Save, then Submit/Publish the container.',
      ],
      code: `<script>\n  ${config}\n</script>\n<script async src="${s.scriptUrl}"></script>`,
    },
  };
}

function renderRumGuide(s, body) {
  const key = s.key ?? randomKey();
  const snippets = rumSnippets(s, key);
  let platform = 'html';
  const platformBody = h('div', { class: 'guide-platform' });
  const showPlatform = () => {
    const p = snippets[platform];
    platformBody.replaceChildren(
      h(
        'ol',
        { class: 'list' },
        p.steps.map((t) => h('li', {}, t)),
      ),
      codeBlock(p.code),
    );
  };
  const tabs = h(
    'div',
    { class: 'segmented wrap', role: 'radiogroup', 'aria-label': 'Platform' },
    Object.entries(RUM_PLATFORMS).map(([id, label]) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: `rum-platform-${s.host}`,
          value: id,
          checked: id === platform,
          onchange: () => {
            platform = id;
            showPlatform();
          },
        }),
        h('span', {}, label),
      ),
    ),
  );
  showPlatform();

  const steps = [];
  // 1. Project key
  steps.push(
    h(
      'li',
      {},
      h('strong', {}, 'Project key. '),
      s.key
        ? ['This site already has a key: ', h('code', {}, s.key), '.']
        : [
            `No key is configured for ${s.host}. Add this line to the agent's .env and restart the server (keys are public, not secrets):`,
            codeBlock(`RUM_KEYS=${key}=${s.host}`),
          ],
    ),
  );
  // 2. Reachable collector
  steps.push(
    h(
      'li',
      {},
      h('strong', {}, 'Make this server reachable by visitors. '),
      s.reachable && s.https
        ? ['Visitors will send data to ', h('code', {}, s.collectorUrl), '.']
        : [
            h(
              'span',
              { class: 'guide-warn' },
              `This agent runs at ${s.collectorUrl}, which ${s.reachable ? 'is not HTTPS' : "your visitors' browsers can't reach"}. `,
            ),
            'Deploy it on a server with HTTPS, or for a quick test start a tunnel and put its HTTPS address in .env as RUM_PUBLIC_URL, then restart:',
            codeBlock(`cloudflared tunnel --url http://localhost:${new URL(s.collectorUrl).port || 80}`),
          ],
    ),
  );
  // 3. Snippet
  steps.push(
    h(
      'li',
      {},
      h('strong', {}, 'Add the script to the site. '),
      'Choose where the site is built:',
      tabs,
      platformBody,
    ),
  );
  // 4. Consent
  steps.push(
    h(
      'li',
      {},
      h('strong', {}, 'Cookie consent (if the site asks for it). '),
      'The script sets no cookies and strips query strings. If you still want it to wait for consent, add ',
      h('code', {}, 'data-consent="required"'),
      ' to the tag (or consentRequired: true in cwvRumConfig) and call this when the visitor accepts:',
      codeBlock('window.cwvRum && window.cwvRum.consent();'),
    ),
  );
  // 5. Verify
  steps.push(
    h(
      'li',
      {},
      h('strong', {}, 'Check it works. '),
      'Open the site in a browser, browse a page or two, then press "Check status" above. Re-run the diagnosis after a few days (at least ~50 visits per metric) to get real-user attribution.',
    ),
  );
  body.replaceChildren(h('ol', { class: 'list guide-steps' }, steps));
}

function rumStatusChip(s) {
  if (s.samples.pageViews > 0)
    return h(
      'span',
      { class: 'metric-rating r-good' },
      h('span', { class: 'dot' }),
      `Collecting · ${s.samples.pageViews.toLocaleString()} page views (28 days)`,
    );
  if (s.samples.metrics > 0)
    return h(
      'span',
      { class: 'metric-rating r-needs-improvement' },
      h('span', { class: 'dot' }),
      'Receiving data',
    );
  return h('span', { class: 'metric-rating r-unknown' }, h('span', { class: 'dot' }), 'Not installed yet');
}

function renderRumCard(report) {
  const wantsRum = [...(report.nextSteps ?? []), ...(report.dataGaps ?? [])].some((t) =>
    /\bRUM\b|real[- ]user/i.test(t),
  );
  const status = h('div', { class: 'guide-status muted' }, 'Checking…');
  const body = h('div', { class: 'guide-body', hidden: !wantsRum });
  const toggle = h(
    'button',
    { class: 'btn btn-ghost btn-sm', type: 'button' },
    wantsRum ? 'Hide guide' : 'How to install',
  );
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? 'How to install' : 'Hide guide';
  });
  const refresh = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Check status');

  const load = async () => {
    status.textContent = 'Checking…';
    try {
      const s = await api(`/api/rum/setup?url=${encodeURIComponent(report.url)}`);
      status.replaceChildren(rumStatusChip(s));
      if (!body.dataset.rendered) {
        renderRumGuide(s, body);
        body.dataset.rendered = '1';
      }
    } catch (err) {
      status.textContent = `Could not load RUM status: ${err.message}`;
    }
  };
  refresh.addEventListener('click', load);
  void load();

  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'guide-head' },
      h('h2', { class: 'section-title' }, 'Real-user monitoring (RUM)'),
      h('div', { class: 'guide-actions' }, refresh, toggle),
    ),
    h(
      'p',
      { class: 'muted' },
      'A small script (~8 KB) on your site reports which element shifts, which click is slow and why, from real visitors — the evidence CrUX does not give. Once data arrives, the next diagnosis uses it automatically.',
    ),
    status,
    body,
  );
}

// ── History ──────────────────────────────────────────────────────────────────

async function loadHistory(activeName) {
  try {
    const items = await api('/api/reports');
    els.historyEmpty.hidden = items.length > 0;
    els.historyList.replaceChildren(
      ...items.map((item) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: 'history-item',
              type: 'button',
              'aria-current': item.name === activeName ? 'true' : 'false',
              title: item.summary,
              onclick: () => openReport(item.name),
            },
            h('span', { class: 'history-url' }, item.url.replace(/^https?:\/\//, '')),
            h(
              'span',
              { class: 'history-meta' },
              h(
                'span',
                {
                  class: 'history-dots',
                  'aria-label': `LCP ${item.status.LCP}, INP ${item.status.INP}, CLS ${item.status.CLS}`,
                },
                ['LCP', 'INP', 'CLS'].map((m) =>
                  h('span', { class: `dot r-${item.status[m]}`, title: `${m}: ${item.status[m]}` }),
                ),
              ),
              h('span', {}, item.device),
              h('span', {}, new Date(item.createdAt).toLocaleString()),
            ),
          ),
        ),
      ),
    );
  } catch (err) {
    els.historyEmpty.hidden = false;
    els.historyEmpty.textContent = `Could not load reports: ${err.message}`;
  }
}

async function openReport(name) {
  if (current.source) return; // don't replace a live run
  try {
    const report = await api(`/api/reports/${encodeURIComponent(name)}`);
    els.progress.hidden = true;
    renderReport(report, name, report.meta);
    setUrlParam('report', name);
    loadHistory(name);
    els.report.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
  }
}

function setUrlParam(key, value) {
  const url = new URL(location.href);
  url.search = '';
  if (value) url.searchParams.set(key, value);
  history.replaceState(null, '', url);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const url = els.url.value.trim();
  if (!url) {
    showError('Enter a page URL to diagnose.');
    els.url.focus();
    return;
  }
  const device = new FormData(els.form).get('device');
  const source = els.source.value.trim() || undefined;
  rememberSource(url, source);
  setBusy(true);
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ url, device, source }) });
    setUrlParam('run', run.id);
    watchRun(run);
  } catch (err) {
    setBusy(false);
    showError(err.message);
  }
});

els.cancelBtn.addEventListener('click', async () => {
  if (!current.runId) return;
  els.cancelBtn.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(current.runId)}/cancel`, { method: 'POST' });
  } catch (err) {
    showError(err.message);
  } finally {
    els.cancelBtn.disabled = false;
  }
});

els.historyRefresh.addEventListener('click', () => loadHistory());

// Remember the source used for each site (per browser) so it is pre-filled next time.
function siteKey(url) {
  try {
    return 'cwv-source:' + new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
}
function rememberSource(url, source) {
  const key = siteKey(url);
  try {
    if (key && source) localStorage.setItem(key, source);
  } catch {
    /* storage unavailable */
  }
}
els.url.addEventListener('change', () => {
  const key = siteKey(els.url.value.trim());
  try {
    const saved = key && localStorage.getItem(key);
    if (saved && !els.source.value) els.source.value = saved;
  } catch {
    /* storage unavailable */
  }
});

async function init() {
  setBusy(false);
  const params = new URLSearchParams(location.search);
  loadHistory(params.get('report'));
  const runId = params.get('run');
  const reportName = params.get('report');
  if (runId) {
    try {
      const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
      els.url.value = run.url;
      els.source.value = run.sourceSpec ?? '';
      watchRun(run);
    } catch {
      setUrlParam(null);
    }
  } else if (reportName) {
    openReport(reportName);
  }
}

init();
