/**
 * Split a production JS chunk into its bundler modules (Turbopack / webpack) without a JS parser, and pull
 * minification-proof string anchors (UI text, class names, routes, messages) out of each module so they can be
 * matched against linked source code.
 */

export interface ChunkModule {
  id: string;
  start: number;
  end: number;
}

/** Module factory markers: Turbopack `,12345,(e,t,n)=>{` / `,12345,e=>{` and webpack `12345:function(e,t,n){` / `12345:(e,t,n)=>{`. */
const MARKERS: Array<[string, RegExp]> = [
  ['turbopack', /[,[](\d{2,7}),(?:\((?:[\w$]{1,3}(?:,[\w$]{1,3}){0,3})?\)|[\w$]{1,3})=>\{/g],
  [
    'webpack',
    /[{,](\d{1,7}|"[^"]{1,200}"):(?:function\s*\([\w$,]{0,20}\)|\([\w$,]{0,20}\)=>|[\w$]{1,3}=>)\s*\{/g,
  ],
];

export function segmentModules(code: string): { bundler: string; modules: ChunkModule[] } {
  for (const [bundler, re] of MARKERS) {
    const starts = [...code.matchAll(re)].map((m) => ({ id: m[1]!.replace(/"/g, ''), start: m.index! + 1 }));
    if (starts.length >= 2) {
      return {
        bundler,
        modules: starts.map((s, i) => ({
          id: s.id,
          start: s.start,
          end: starts[i + 1]?.start ?? code.length,
        })),
      };
    }
  }
  return { bundler: 'unknown', modules: [{ id: '(whole file)', start: 0, end: code.length }] };
}

/** Strings every app/library contains: useless as anchors. */
const COMMON =
  /^(use strict|function|object|undefined|string|number|boolean|symbol|bigint|default|prototype|children|className|stylesheet|script|hidden|select|textarea|button|submit|keydown|keyup|keypress|pointer\w*|mouse\w*|focus\w*|touch\w*|scroll\w*|resize|change|input|click|toggle|pending|fulfilled|rejected|invalid|content|display|position|absolute|relative|transform|transition|opacity|aria-[\w-]+|data-[\w-]+|application\/json|text\/[\w-]+|dangerouslySetInnerHTML|defaultValue|__esModule|__NEXT_ERROR_CODE|component|http:\/\/www\.w3\.org\/[\w/.]+)$/i;

/** How likely a literal is unique to the app's own source (UI copy, class lists, routes beat single words). */
function distinctiveness(s: string): number {
  let score = Math.min(s.length, 40) / 10;
  if (/\s/.test(s)) score += 3; // UI text / class lists
  if (/[-_/:#.]/.test(s)) score += 2; // kebab classes, routes, keys
  if (/[a-z][A-Z]/.test(s)) score += 1; // camelCase keys
  return score;
}

export function anchorsOf(text: string, max = 12): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]){5,80})\1/g)) {
    const s = m[2]!.trim();
    if (
      s.length < 5 ||
      !/[A-Za-z]{3}/.test(s) ||
      COMMON.test(s) ||
      /^https?:\/\//.test(s) ||
      /^[\d\s.,%-]+$/.test(s)
    )
      continue;
    if (/\$\{|^\W|[{}<>;=]/.test(s)) continue; // template expressions, code-like strings
    seen.add(s);
  }
  return [...seen].sort((a, b) => distinctiveness(b) - distinctiveness(a)).slice(0, max);
}
