/* eslint-disable @typescript-eslint/no-explicit-any -- loose access into summarised JSON */
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as UrlModule from '../src/lib/url.js';
import { cleanSource, decodeMappings, offsetToLineCol, packageOf } from '../src/lib/sourcemap.js';
import { inspectScript } from '../src/tools/script.js';
import { ctx } from './helpers.js';

vi.mock('../src/lib/url.js', async (orig) => ({
  ...(await orig<typeof UrlModule>()),
  assertPublicUrl: vi.fn(),
}));

/** A real minified bundle + source map: first-party module importing a "node_modules" package. */
let code = '';
let map = '';
beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `import { heavy } from './node_modules/slowlib/index.js';
export function onAcceptClick(items) {
  let total = 0;
  for (const item of items) total += heavy(item);
  document.title = 'accepted ' + total;
  return total;
}
onAcceptClick([1, 2, 3]);`,
      resolveDir: '/proj',
      sourcefile: 'src/consent/AcceptButton.ts',
      loader: 'ts',
    },
    plugins: [
      {
        name: 'virtual',
        setup(b) {
          b.onResolve({ filter: /slowlib/ }, () => ({
            path: '/proj/node_modules/slowlib/index.js',
            namespace: 'v',
          }));
          b.onLoad({ filter: /.*/, namespace: 'v' }, () => ({
            contents:
              '/*! slowlib v2.1.0 | MIT */\nexport function heavy(x) { let s = 0; for (let i = 0; i < 1e3; i++) s += Math.sqrt(x * i); return s; }',
            loader: 'js',
          }));
        },
      },
    ],
    bundle: true,
    minify: true,
    format: 'esm',
    sourcemap: 'external',
    sourcesContent: true,
    write: false,
    outfile: '/proj/dist/chunk-a1b2c3.js',
    legalComments: 'inline',
  });
  map = out.outputFiles.find((f) => f.path.endsWith('.map'))!.text;
  code = out.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
});

const serve = (files: Record<string, string>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: URL) => {
      const body = files[String(u)];
      return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { status: 200 });
    }),
  );

describe('source map reader', () => {
  it('decodes VLQ mappings and helpers', () => {
    expect(decodeMappings('AAAA,CAAC;AACA')).toEqual([
      [
        { col: 0, src: 0, line: 0, ocol: 0 },
        { col: 1, src: 0, line: 0, ocol: 1 },
      ],
      [{ col: 0, src: 0, line: 1, ocol: 1 }],
    ]);
    expect(offsetToLineCol('ab\ncd\nef', 7)).toEqual({ line: 2, col: 1 });
    expect(cleanSource('webpack://_N_E/./src/app/page.tsx?abc')).toBe('src/app/page.tsx');
    expect(cleanSource('../../node_modules/react-dom/cjs/x.js')).toBe('node_modules/react-dom/cjs/x.js');
    expect(packageOf('node_modules/@scope/pkg/x.js')).toBe('@scope/pkg');
  });
});

describe('inspect_script', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps a char position to the original file/function and reports composition', async () => {
    const url = 'https://example.com/_next/static/chunks/chunk-a1b2c3.js';
    serve({ [url]: code, [`${url}.map`]: map });
    const pos = code.indexOf('accepted');
    const r = (await inspectScript.execute({ url, charPosition: pos }, ctx())) as any;
    expect(r.sourceMap).toMatchObject({ found: true, sources: 2 });
    expect(r.slowCode).toMatchObject({ source: 'src/consent/AcceptButton.ts', line: 5 });
    expect(r.slowCode.snippet).toContain("5 > document.title = 'accepted ' + total;");
    expect(r.composition.byPackage.map((p: any) => p.package).sort()).toEqual(['(first-party)', 'slowlib']);
  });

  it('falls back to library banners and search anchors without a source map', async () => {
    const url = 'https://example.com/assets/app.9f8e7d.js';
    serve({ [url]: code.replace(/\/\/# sourceMappingURL=.*$/m, '') });
    const r = (await inspectScript.execute({ url, charPosition: code.indexOf('accepted') }, ctx())) as any;
    expect(r.sourceMap.found).toBe(false);
    expect(r.bundledLibraries.join(' ')).toContain('slowlib v2.1.0');
    expect(r.slowCode.searchAnchors).toContain('accepted');
    expect(r.slowCode.excerpt).toContain('accepted');
  });

  it('fingerprints well-known libraries around the slow code without a source map', async () => {
    const url = 'https://example.com/_next/static/chunks/14xnqq.js';
    const chunk =
      'var a=1;' + 'x'.repeat(5000) + 'function n(e){let t=e.__sentry_wrapped__;return t}' + 'y'.repeat(100);
    serve({ [url]: chunk });
    const r = (await inspectScript.execute({ url, charPosition: chunk.indexOf('function n') }, ctx())) as any;
    expect(r.slowCode.likelyLibrary[0]).toMatch(/^@sentry\/browser \(wraps event handlers/);
    expect(r.bundledLibraries[0]).toMatch(/^@sentry\/browser/);
  });
});
