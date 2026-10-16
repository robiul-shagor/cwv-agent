import { z } from 'zod';
import { truncate } from '../lib/cwv.js';
import { anchorsOf, segmentModules } from '../lib/chunks.js';
import { chunkRole, isPackageName, OriginResolver, type Origin } from '../lib/origin.js';
import { offsetToLineCol, packageOf, SourceMapReader, type RawSourceMap } from '../lib/sourcemap.js';
import type { CodeSource } from '../source/types.js';
import { normalizeUrl } from '../lib/url.js';
import { fetchFailure, fetchPage } from './fetchHtml.js';
import { memo, ToolError, type Tool, type ToolContext } from './types.js';

const Input = z.object({
  url: z
    .string()
    .min(1)
    .describe('Absolute URL of the JavaScript file (e.g. a hashed bundle chunk from PSI or the session)'),
  charPosition: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset of the slow code in the file (`charPosition` from simulate_session scripts)'),
  functionName: z.string().max(100).optional().describe('Function name reported for the slow script, if any'),
});
type Input = z.infer<typeof Input>;

const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_MAP_BYTES = 40 * 1024 * 1024;

function snippet(content: string | undefined, line: number, around = 6) {
  if (!content) return undefined;
  const lines = content.split('\n');
  const from = Math.max(1, line - around);
  const to = Math.min(lines.length, line + around);
  return lines
    .slice(from - 1, to)
    .map(
      (l, i) => `${String(from + i).padStart(5)}${from + i === line ? ' >' : '  '} ${truncate(l, 200) ?? ''}`,
    )
    .join('\n');
}

/** `/*! lib v1.2 *\/` license banners name the libraries bundled into a chunk even without a source map. */
function banners(code: string) {
  const out = new Set<string>();
  for (const m of code.matchAll(/\/\*[!*]\s*([^\n*]{3,80})/g)) {
    const t = m[1]!.trim();
    if (/v?\d+\.\d+|license|@/i.test(t)) out.add(t);
    if (out.size >= 12) break;
  }
  return [...out];
}

/** Runtime fingerprints of common libraries: identify bundled code without a source map. */
const LIBRARY_SIGNATURES: Array<[RegExp, string, string?]> = [
  [
    /__sentry_wrapped__|sentry\.javascript|__SENTRY__/,
    '@sentry/browser',
    'wraps event handlers: time includes the wrapped handler — use the LoAF invoker to find it',
  ],
  [
    /__reactFiber\$|__reactProps\$|__reactContainer\$|scheduleUpdateOnFiber|Minified React error #/,
    'react-dom',
    'React rendering/hydration: driven by your components, not written in them',
  ],
  [
    /__NEXT_DATA__|__next_f|next-router-state-tree|__NEXT_P|next-route-announcer|Next\.js-route-change|__NEXT_ERROR_CODE/,
    'next',
    'Next.js runtime/router',
  ],
  [/__vue_app__|__VUE__|_vnode|createVNode/, 'vue'],
  [
    /ngZone|ɵcmp|zone\.js|__zone_symbol__/,
    '@angular/core + zone.js',
    'zone.js patches events: change detection after every event',
  ],
  [/jQuery|fn\.jquery|\$\.fn/, 'jquery'],
  [/__lodash_hash_undefined__|lodash/, 'lodash'],
  [/isMoment|moment\.(locale|tz)/, 'moment', 'large; replace with date-fns/dayjs/Intl'],
  [/swiper-wrapper|new Swiper/, 'swiper', 'slider init on load'],
  [/slick-slide|slick-track/, 'slick-carousel'],
  [/GreenSock|gsap\./, 'gsap'],
  [/framer-motion|motionValue/, 'framer-motion'],
  [/data-styled|styled-components/, 'styled-components', 'runtime CSS-in-JS: style recalculation on render'],
  [/@emotion|emotion-cache|css-[a-z0-9]+-/, '@emotion', 'runtime CSS-in-JS'],
  [/core-js|__core-js_shared__/, 'core-js', 'polyfills: ship modern JS to modern browsers'],
  [/DD_RUM|datadog/, '@datadog/browser-rum'],
  [/posthog/, 'posthog-js'],
  [/LogRocket|logrocket/, 'logrocket', 'session replay: heavy DOM observation'],
  [/hotjar|_hjSettings/, 'hotjar'],
  [/mapboxgl|leaflet|L\.map\(/, 'maps (mapbox/leaflet)'],
  [/elementorFrontend/, 'elementor frontend'],
  [/wp\.hooks|wp\.i18n/, 'WordPress core JS'],
];

function librariesIn(code: string) {
  return LIBRARY_SIGNATURES.filter(([re]) => re.test(code)).map(([, name, hint]) =>
    hint ? `${name} (${hint})` : name,
  );
}

async function loadMap(scriptUrl: string, code: string, headers: Record<string, string>, ctx: ToolContext) {
  const ref =
    headers.sourcemap ??
    headers['x-sourcemap'] ??
    code.slice(-2000).match(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m)?.[1];
  const tried: string[] = [];
  if (ref?.startsWith('data:')) {
    const b64 = ref.match(/;base64,(.*)$/)?.[1];
    if (b64)
      return { map: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as RawSourceMap, from: 'inline' };
  }
  const candidates = [
    ...new Set([ref ? new URL(ref, scriptUrl).toString() : undefined, `${scriptUrl.split(/[?#]/)[0]}.map`]),
  ].filter((u): u is string => !!u);
  for (const u of candidates) {
    tried.push(u);
    try {
      const res = await fetchPage(u, 'desktop', ctx, MAX_MAP_BYTES);
      if (res.status !== 200 || res.truncated || !res.html.trimStart().startsWith('{')) continue;
      const map = JSON.parse(res.html) as RawSourceMap;
      if (map.version === 3 && Array.isArray(map.sources)) return { map, from: u };
    } catch {
      // not available: try the next candidate
    }
  }
  return { map: undefined, tried, referenced: !!ref };
}

/** Build output folders where a local production build of the linked source keeps this chunk + its map. */
const LOCAL_BUILD_DIRS = [
  '.next/static/chunks',
  'out/_next/static/chunks',
  'dist/assets',
  'dist',
  'build/static/js',
  '.output/public/_nuxt',
];

/** Exact mapping when the linked folder holds the same build (identical chunk) with source maps. */
async function loadLocalBuildMap(scriptUrl: string, code: string, source: CodeSource) {
  const base = new URL(scriptUrl).pathname.split('/').pop() ?? '';
  for (const dir of LOCAL_BUILD_DIRS) {
    const local = await source.readText(`${dir}/${base}`, MAX_SCRIPT_BYTES);
    if (local === null) continue;
    if (local !== code)
      return {
        map: undefined,
        note: `Local build ${dir}/${base} differs from the deployed file (different commit or build).`,
      };
    const ref = local.slice(-2000).match(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m)?.[1];
    for (const m of [ref && !ref.startsWith('data:') ? `${dir}/${ref}` : undefined, `${dir}/${base}.map`]) {
      if (!m) continue;
      const text = await source.readText(m, MAX_MAP_BYTES);
      if (!text) continue;
      try {
        const map = JSON.parse(text) as RawSourceMap;
        if (map.version === 3) return { map, from: `local build ${m}` };
      } catch {
        /* not a map */
      }
    }
    return {
      map: undefined,
      note: `Local build ${dir}/${base} matches the deployed file but has no source map (enable production source maps and rebuild).`,
    };
  }
  return { map: undefined };
}

const share = (n: number, total: number) => Math.round((n / (total || 1)) * 100) + '%';

/** Modules of a bundled chunk with the library each one belongs to (fingerprints), largest first. */
function analyzeModules(code: string) {
  const { bundler, modules } = segmentModules(code);
  const info = modules.map((m) => {
    const lib = LIBRARY_SIGNATURES.find(([re]) => re.test(code.slice(m.start, m.end)));
    return { ...m, bytes: m.end - m.start, library: lib?.[1] };
  });
  const libBytes = new Map<string, number>();
  for (const m of info)
    libBytes.set(
      m.library ?? '(unidentified: app code or other libs)',
      (libBytes.get(m.library ?? '(unidentified: app code or other libs)') ?? 0) + m.bytes,
    );
  return {
    bundler,
    info,
    summary: {
      bundler,
      modules: info.length,
      byLibrary: [...libBytes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([library, b]) => ({ library, share: share(b, code.length) })),
    },
  };
}

/**
 * Content matching against the linked source: string anchors that survive minification (UI text, class names,
 * routes, messages) are searched in the project; rare matches weigh more. Returns the most likely source file per
 * module, and for the slow position its module + file + line.
 */
async function matchChunkToSource(
  code: string,
  mods: ReturnType<typeof analyzeModules>['info'],
  source: CodeSource,
  charPosition?: number,
  maxSearches = 60,
) {
  const hits = new Map<string, Map<string, number>>(); // anchor → file → first line
  let searches = 0;
  const lookup = async (a: string) => {
    if (hits.has(a) || searches >= maxSearches) return;
    searches++;
    const { matches } = await source
      .search(a, { caseSensitive: true, maxResults: 30 })
      .catch(() => ({ matches: [] }));
    const files = new Map<string, number>();
    for (const m of matches) if (!files.has(m.file)) files.set(m.file, m.line);
    hits.set(a, files);
  };
  const best = async (anchors: string[]) => {
    for (const a of anchors) await lookup(a);
    const scores = new Map<string, { score: number; anchors: string[]; line: number }>();
    for (const a of anchors) {
      const files = hits.get(a);
      if (!files?.size || files.size > 6) continue; // no match, or too common to discriminate
      for (const [file, line] of files) {
        const e = scores.get(file) ?? { score: 0, anchors: [], line };
        e.score += 1 / files.size;
        e.anchors.push(a);
        scores.set(file, e);
      }
    }
    const top = [...scores.entries()].sort((x, y) => y[1].score - x[1].score)[0];
    if (!top) return undefined;
    const [file, e] = top;
    const confidence = e.anchors.length >= 3 ? 'high' : e.anchors.length === 2 ? 'medium' : 'low';
    return {
      file,
      line: e.line,
      confidence,
      matchedAnchors: e.anchors.slice(0, 4),
      anchorsTried: anchors.length,
    };
  };

  const target =
    charPosition !== undefined
      ? mods.find((m) => charPosition >= m.start && charPosition < m.end)
      : undefined;
  let slowCode: Record<string, unknown> | undefined;
  if (target) {
    // Anchors closest to the slow position first, then the rest of its module.
    const near = anchorsOf(
      code.slice(Math.max(target.start, charPosition! - 1500), Math.min(target.end, charPosition! + 1500)),
      8,
    );
    const rest = anchorsOf(code.slice(target.start, target.end), 12).filter((a) => !near.includes(a));
    const match = target.library ? undefined : await best([...near, ...rest].slice(0, 14));
    slowCode = {
      moduleId: target.id,
      moduleBytes: target.bytes,
      library: target.library,
      source: match,
      note: target.library
        ? `The slow code is inside ${target.library} (library code): find the app component/handler that triggers it (interaction target, LoAF invoker).`
        : match
          ? undefined
          : 'No distinctive strings of this module were found in the linked source (other library, generated code, or source differs from the deployed build).',
    };
  }

  const appModules = mods
    .filter((m) => !m.library && m !== target && m.bytes >= 80)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);
  const modules = [];
  for (const m of appModules) {
    const match = await best(anchorsOf(code.slice(m.start, m.end), 6));
    if (match) modules.push({ moduleId: m.id, bytes: m.bytes, ...match });
  }
  return { searches, slowCode, matchedModules: modules };
}

/**
 * Where each part of the chunk comes from in the linked project — repository file or dependency
 * (package@version, package.json line, importing files) — and where the slow position comes from.
 */
async function chunkOrigin(
  code: string,
  mods: ReturnType<typeof analyzeModules>['info'],
  match: Awaited<ReturnType<typeof matchChunkToSource>>,
  resolver: OriginResolver,
  charPosition?: number,
) {
  const parts = new Map<string, Origin & { bytes: number }>();
  const add = (key: string, origin: Origin, bytes: number) => {
    const e = parts.get(key);
    if (e) e.bytes += bytes;
    else parts.set(key, { ...origin, bytes });
  };
  const repoModules = new Map(match.matchedModules.map((m) => [m.moduleId, m]));
  const unidentified: typeof mods = [];
  for (const m of mods) {
    const repo = repoModules.get(m.id);
    if (m.library && isPackageName(m.library)) add(m.library, await resolver.dependency(m.library), m.bytes);
    else if (repo)
      add(
        repo.file,
        {
          kind: 'repository',
          file: repo.file,
          line: repo.line,
          confidence: repo.confidence as Origin['confidence'],
        },
        m.bytes,
      );
    else if (!m.library && m.bytes >= 500) unidentified.push(m);
  }
  for (const m of unidentified.sort((a, b) => b.bytes - a.bytes).slice(0, 4)) {
    const dep = await resolver.matchDependency(anchorsOf(code.slice(m.start, m.end), 4));
    if (dep?.package) add(dep.package, dep, m.bytes);
  }
  const attributed = [...parts.values()].reduce((n, p) => n + p.bytes, 0);

  let slowCode: Origin | undefined;
  const target = match.slowCode as
    { library?: string; source?: { file: string; line: number; confidence: string } } | undefined;
  if (target?.library && isPackageName(target.library)) slowCode = await resolver.dependency(target.library);
  else if (target?.source)
    slowCode = {
      kind: 'repository',
      file: target.source.file,
      line: target.source.line,
      confidence: target.source.confidence as Origin['confidence'],
    };
  else if (target && charPosition !== undefined)
    slowCode = (await resolver.matchDependency(
      anchorsOf(code.slice(Math.max(0, charPosition - 1500), charPosition + 1500), 5),
    )) ?? {
      kind: 'unknown',
      note: 'Not found in the repository or node_modules: generated code or a different build.',
    };

  return {
    parts: [...parts.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8)
      .map(({ bytes, ...o }) => ({ share: share(bytes, code.length), ...o })),
    unattributedShare: share(code.length - attributed, code.length),
    slowCode,
  };
}

async function inspectScriptCode(
  input: Input,
  code: string,
  headers: Record<string, string>,
  ctx: ToolContext,
) {
  let loaded: { map?: RawSourceMap; from?: string; tried?: string[]; referenced?: boolean; note?: string } =
    await loadMap(input.url, code, headers, ctx);
  let localNote: string | undefined;
  if (!loaded.map && ctx.source) {
    const local = await loadLocalBuildMap(input.url, code, ctx.source);
    if (local.map) loaded = local;
    else localNote = local.note;
  }
  const result: Record<string, unknown> = {
    url: input.url,
    bytes: code.length,
    chunk: await chunkRole(input.url, ctx.source),
  };
  const resolver = ctx.source ? new OriginResolver(ctx.source) : undefined;

  if (loaded.map) {
    let reader: SourceMapReader;
    try {
      reader = new SourceMapReader(loaded.map);
    } catch (err) {
      return { ...result, sourceMap: { found: true, from: loaded.from, error: (err as Error).message } };
    }
    const comp = reader.composition(code);
    const total = comp.reduce((n, c) => n + c.bytes, 0) || 1;
    const pkgs = new Map<string, number>();
    for (const c of comp) {
      const p = packageOf(c.source) ?? '(first-party)';
      pkgs.set(p, (pkgs.get(p) ?? 0) + c.bytes);
    }
    result.sourceMap = { found: true, from: loaded.from, sources: reader.sourceCount };
    result.composition = {
      byPackage: [...pkgs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pkg, b]) => ({ package: pkg, share: Math.round((b / total) * 100) + '%' })),
      largestSources: comp
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 10)
        .map((c) => ({ source: c.source, share: Math.round((c.bytes / total) * 100) + '%' })),
    };
    if (input.charPosition !== undefined) {
      const { line, col } = offsetToLineCol(code, input.charPosition);
      const orig = reader.originalPosition(line, col);
      result.slowCode = orig
        ? {
            source: orig.source,
            line: orig.line,
            column: orig.column,
            name: orig.name ?? input.functionName,
            package: packageOf(orig.source),
            origin: resolver ? await resolver.fromSourceMapPath(orig.source, orig.line) : undefined,
            snippet: snippet(orig.content, orig.line),
          }
        : { note: 'Position is not covered by the source map (generated/runtime code).' };
    }
    return result;
  }

  result.sourceMap = {
    found: false,
    tried: loaded.tried,
    localBuild: localNote,
    note: loaded.referenced
      ? 'The file references a source map but it is not publicly reachable (likely uploaded only to an error tracker).'
      : 'No source map published. To map exactly: enable production source maps (e.g. Next.js productionBrowserSourceMaps, ' +
        'Vite build.sourcemap) or link the source / run a bundle analyzer.',
  };
  result.bundledLibraries = [...new Set([...banners(code), ...librariesIn(code)])].slice(0, 15);
  const mods = analyzeModules(code);
  result.modules = mods.summary;
  if (input.charPosition !== undefined) {
    const p = Math.min(input.charPosition, code.length);
    const near = librariesIn(code.slice(Math.max(0, p - 3000), p + 3000));
    result.slowCode = {
      likelyLibrary: near.length ? near : undefined,
      excerpt: truncate(code.slice(Math.max(0, p - 300), p + 300).replace(/\s+/g, ' '), 600),
      searchAnchors: anchorsOf(code.slice(Math.max(0, p - 1500), p + 1500), 10),
    };
  }
  if (ctx.source) {
    // Linked source: find which project files this build chunk (and the slow position) came from.
    const match = await matchChunkToSource(code, mods.info, ctx.source, input.charPosition);
    result.sourceMatch = {
      method:
        'content matching: minification-proof strings of each bundled module searched in the linked source',
      ...match,
    };
    result.origin = await chunkOrigin(code, mods.info, match, resolver!, input.charPosition);
  } else if (input.charPosition !== undefined) {
    (result.slowCode as Record<string, unknown>).note =
      'Link the source code to map this to a project file (content matching), or search these anchors with search_code.';
  }
  return result;
}

export const inspectScript: Tool<Input> = {
  name: 'inspect_script',
  description:
    'Map a (minified, hashed) JavaScript file back to its source. Finds the production source map (sourceMappingURL, ' +
    'SourceMap header or <url>.map); with `charPosition` (from simulate_session scripts) returns the original file, line, ' +
    'function and a code snippet of the slow code; always returns bundle composition (share per package and per source ' +
    'file). Without a public map it also checks a matching local build in the linked source, splits the chunk into its ' +
    'bundler modules with the library each belongs to, and — when source is linked — content-matches each module (and ' +
    'the slow position) to the project file + line it came from. With linked source, `origin` says where every part of ' +
    'the chunk and the slow code comes from: `repository` (file:line) or `dependency` (package@installed version, the ' +
    'package.json line declaring it, the repo files importing it); `chunk` names the chunk role (Next.js framework/main/' +
    'route chunk → its route file). Use it to turn "hashed chunk" into an exact source file/function or package.',
  inputSchema: Input,
  async execute(input, ctx) {
    return memo(ctx, `script:${input.url}:${input.charPosition ?? ''}`, async () => {
      try {
        const res = await fetchPage(normalizeUrl(input.url).toString(), 'desktop', ctx, MAX_SCRIPT_BYTES);
        if (res.status !== 200) throw new ToolError(`Script returned HTTP ${res.status}`);
        return await inspectScriptCode({ ...input, url: res.finalUrl }, res.html, res.headers, ctx);
      } catch (err) {
        fetchFailure(err, 'script');
      }
    });
  },
};
