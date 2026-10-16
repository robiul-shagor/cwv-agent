/* eslint-disable @typescript-eslint/no-explicit-any -- loose access into summarised JSON */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { anchorsOf, segmentModules } from '../src/lib/chunks.js';
import type * as UrlModule from '../src/lib/url.js';
import { LocalSource } from '../src/source/local.js';
import { inspectScript } from '../src/tools/script.js';
import { ctx } from './helpers.js';

vi.mock('../src/lib/url.js', async (orig) => ({
  ...(await orig<typeof UrlModule>()),
  assertPublicUrl: vi.fn(),
}));

/** Turbopack-style production chunk: a react-dom module + two app modules (minified). */
const REACT = 'function rd(){throw Error("Minified React error #"+418)}' + 'var q=1;'.repeat(400);
const BOOKING =
  'let a="Book a free consultation",b="booking-form__submit",c="Please choose a date first";' +
  'function f(e){let t=0;for(let n=0;n<1e5;n++)t+=n;return{label:a,cls:b,err:c,t}}';
const TESTIMONIALS = 'let x="What our clients say",y="testimonial-card__quote";function g(){return[x,y]}';
const CHUNK =
  '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,' +
  `57647,(e,t,n)=>{${REACT}},` +
  `22688,e=>{"use strict";${BOOKING}},` +
  `40011,(e,t)=>{"use strict";${TESTIMONIALS}}]);`;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cwv-chunk-src-'));
  await mkdir(join(root, 'src/components'), { recursive: true });
  await writeFile(
    join(root, 'src/components/BookingForm.tsx'),
    `export function BookingForm() {
  const total = useHeavyTotal();
  return (
    <form>
      <button className="booking-form__submit">Book a free consultation</button>
      <p role="alert">{'Please choose a date first'}</p>
    </form>
  );
}
`,
  );
  await writeFile(
    join(root, 'src/components/Testimonials.tsx'),
    `export const Testimonials = () => <section><h2>What our clients say</h2><blockquote className="testimonial-card__quote" /></section>;\n`,
  );
  await writeFile(
    join(root, 'src/components/Footer.tsx'),
    `export const Footer = () => <footer>Book a call</footer>;\n`,
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));

const serve = (files: Record<string, string>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: URL) => {
      const body = files[String(u)];
      return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { status: 200 });
    }),
  );

describe('chunk segmentation', () => {
  it('splits Turbopack and webpack chunks into modules and extracts anchors', () => {
    const t = segmentModules(CHUNK);
    expect(t.bundler).toBe('turbopack');
    expect(t.modules.map((m) => m.id)).toEqual(['57647', '22688', '40011']);
    const w = segmentModules(
      '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1],{1234:function(e,t,n){a()},5678:(e,t,n)=>{b()}}]);',
    );
    expect(w).toMatchObject({ bundler: 'webpack', modules: [{ id: '1234' }, { id: '5678' }] });
    expect(anchorsOf(BOOKING)).toEqual([
      'Please choose a date first',
      'Book a free consultation',
      'booking-form__submit',
    ]);
  });
});

describe('inspect_script with linked source', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the slow position in a hashed chunk to the project file and line by content', async () => {
    const url = 'https://six2eight.example/_next/static/chunks/2yulwpsbeuaps.js';
    serve({ [url]: CHUNK });
    const pos = CHUNK.indexOf('for(let n=0');
    const r = (await inspectScript.execute(
      { url, charPosition: pos },
      ctx({ source: new LocalSource(root) }),
    )) as any;
    expect(r.modules).toMatchObject({ bundler: 'turbopack', modules: 3 });
    expect(r.modules.byLibrary[0]).toMatchObject({ library: 'react-dom' });
    expect(r.sourceMatch.slowCode).toMatchObject({
      moduleId: '22688',
      source: { file: 'src/components/BookingForm.tsx', confidence: 'high' },
    });
    expect(r.sourceMatch.slowCode.source.matchedAnchors).toContain('Book a free consultation');
    expect(r.sourceMatch.matchedModules).toEqual([
      expect.objectContaining({
        moduleId: '40011',
        file: 'src/components/Testimonials.tsx',
        confidence: 'medium',
      }),
    ]);
  });

  it('says when the slow code is library code', async () => {
    const url = 'https://six2eight.example/_next/static/chunks/aaa.js';
    serve({ [url]: CHUNK });
    const r = (await inspectScript.execute(
      { url, charPosition: CHUNK.indexOf('Minified React') },
      ctx({ source: new LocalSource(root) }),
    )) as any;
    expect(r.sourceMatch.slowCode).toMatchObject({ moduleId: '57647', library: 'react-dom' });
    expect(r.sourceMatch.slowCode.note).toMatch(/inside react-dom/);
  });

  it('uses an identical local build with source maps for an exact mapping', async () => {
    const out = await build({
      stdin: {
        contents: 'export function onBook(){ document.title = "booked now"; }\nonBook();',
        sourcefile: 'src/book.ts',
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      minify: true,
      sourcemap: 'external',
      sourcesContent: true,
      write: false,
      outfile: join(root, '.next/static/chunks/zz9.js'),
    });
    const js = out.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    const map = out.outputFiles.find((f) => f.path.endsWith('.map'))!.text;
    await mkdir(join(root, '.next/static/chunks'), { recursive: true });
    await writeFile(join(root, '.next/static/chunks/zz9.js'), js);
    await writeFile(join(root, '.next/static/chunks/zz9.js.map'), map);
    const url = 'https://six2eight.example/_next/static/chunks/zz9.js';
    serve({ [url]: js }); // no public map
    const r = (await inspectScript.execute(
      { url, charPosition: js.indexOf('booked now') },
      ctx({ source: new LocalSource(root) }),
    )) as any;
    expect(r.sourceMap).toMatchObject({ found: true, from: 'local build .next/static/chunks/zz9.js.map' });
    expect(r.slowCode).toMatchObject({ source: 'src/book.ts', line: 1 });
  });
});
