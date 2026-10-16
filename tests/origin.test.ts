import { describe, expect, it } from 'vitest';
import { chunkRole, OriginResolver, packageFromPath } from '../src/lib/origin.js';
import type { CodeSource, SearchMatch, SearchOptions } from '../src/source/types.js';

/** In-memory project: files + a literal/regex search over them. */
function fakeSource(files: Record<string, string>): CodeSource {
  return {
    label: 'fake',
    listFiles: async () => ({ files: Object.keys(files), truncated: false }),
    exists: async (f) => f in files,
    readText: async (f) => files[f] ?? null,
    readFile: async () => {
      throw new Error('unused');
    },
    search: async (query: string, opts: SearchOptions = {}) => {
      const re = opts.regex ? new RegExp(query) : undefined;
      const matches: SearchMatch[] = [];
      for (const [file, text] of Object.entries(files)) {
        if (opts.path && !file.startsWith(`${opts.path}/`)) continue;
        if (!opts.path && file.startsWith('node_modules/')) continue;
        text.split('\n').forEach((l, i) => {
          if (re ? re.test(l) : l.includes(query)) matches.push({ file, line: i + 1, text: l });
        });
      }
      return { matches, truncated: false };
    },
  };
}

const PKG = `{
  "name": "site",
  "dependencies": {
    "gsap": "^3.15.0",
    "next": "16.2.12",
    "react-dom": "^19.2.0"
  }
}`;

const project = fakeSource({
  'package.json': PKG,
  'next.config.js': `optimizePackageImports: ['gsap']`,
  'src/pages/index.tsx': 'export default function Home() {}',
  'src/pages/blog/[slug].tsx': 'export default function Post() {}',
  'src/components/Hero.tsx': `import gsap from 'gsap';\nimport x from "gsap/ScrollTrigger";`,
  'node_modules/gsap/package.json': '{"version":"3.15.0"}',
  'node_modules/gsap/dist/gsap.js':
    'throw "GSAP target not found. https://gsap.com"; "Invalid property tween"',
  'node_modules/react-dom/package.json': '{"version":"19.2.4"}',
  'node_modules/next/package.json': '{"version":"16.2.12"}',
  'node_modules/next/dist/compiled/react-dom/package.json': '{"version":"19.3.0-canary"}',
});

describe('origin', () => {
  it('names Next.js chunk roles and the route file a route chunk was built from', async () => {
    const base = 'https://a.com/_next/static/chunks';
    expect((await chunkRole(`${base}/framework-711ef29bc66f648c.js`))?.packages).toContain('react-dom');
    expect((await chunkRole(`${base}/pages/index-4dec5f38a88fd0cd.js`, project))?.routeFile).toBe(
      'src/pages/index.tsx',
    );
    expect((await chunkRole(`${base}/pages/blog/%5Bslug%5D-4dec5f38a88fd0cd.js`, project))?.routeFile).toBe(
      'src/pages/blog/[slug].tsx',
    );
    expect((await chunkRole(`${base}/4287-a272a3aa76a4ed4e.js`))?.role).toMatch(/Shared/);
    expect(await chunkRole('https://a.com/assets/app.js')).toBeUndefined();
  });

  it('reads package names from node_modules paths, incl. Next.js vendored copies', () => {
    expect(packageFromPath('node_modules/@apollo/client/core/index.js')).toEqual({ name: '@apollo/client' });
    expect(packageFromPath('node_modules/a/node_modules/b/x.js')).toEqual({ name: 'b' });
    expect(packageFromPath('node_modules/next/dist/compiled/react-dom-experimental/cjs/x.js')).toEqual({
      name: 'react-dom',
      vendoredBy: 'next',
    });
  });

  it('describes a dependency: installed version, package.json line, importing files', async () => {
    const o = await new OriginResolver(project).dependency('gsap');
    expect(o).toMatchObject({
      kind: 'dependency',
      package: 'gsap',
      version: '3.15.0',
      declared: 'package.json:4 (dependencies "^3.15.0")',
      importedBy: ['src/components/Hero.tsx:1'],
    });
    const rd = await new OriginResolver(project).dependency('react-dom');
    expect(rd.version).toBe('19.2.4');
    expect(rd.importedBy).toBeUndefined();
    expect(rd.note).toMatch(/driven by your components/);
    const vendored = await new OriginResolver(project).dependency('react-dom', 'next');
    expect(vendored.declared).toMatch(/bundled inside next@16\.2\.12.*package\.json:5/);
    expect((await new OriginResolver(project).dependency('hotjar')).declared).toMatch(
      /not in package\.json or node_modules/,
    );
  });

  it('finds the package that contains a module from its string anchors', async () => {
    const o = await new OriginResolver(project).matchDependency([
      'GSAP target not found.',
      'Invalid property tween',
    ]);
    expect(o).toMatchObject({ package: 'gsap', confidence: 'medium', version: '3.15.0' });
    expect(await new OriginResolver(project).matchDependency(['nowhere at all'])).toBeUndefined();
  });

  it('maps source-map paths to repository files or dependencies', async () => {
    const r = new OriginResolver(project);
    expect(await r.fromSourceMapPath('webpack://_N_E/./src/components/Hero.tsx', 12)).toEqual({
      kind: 'repository',
      file: 'src/components/Hero.tsx',
      line: 12,
    });
    expect((await r.fromSourceMapPath('webpack://_N_E/../node_modules/gsap/dist/gsap.js')).package).toBe(
      'gsap',
    );
    expect((await r.fromSourceMapPath('webpack://_N_E/./index.tsx')).kind).toBe('unknown');
  });
});
