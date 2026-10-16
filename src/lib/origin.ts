/**
 * Where built (minified, hashed) code comes from in the linked project: a repository file, or a dependency
 * (package@version, where package.json declares it, which repo files import it), plus the role of the chunk itself
 * from its bundler file name (Next.js framework/main/webpack/route chunks).
 */
import type { CodeSource } from '../source/types.js';

export interface Origin {
  kind: 'repository' | 'dependency' | 'unknown';
  file?: string;
  line?: number;
  package?: string;
  /** Installed version (node_modules), else the declared range. */
  version?: string;
  /** `package.json:<line> (dependencies "^1.2.0")`, or how it gets in when not declared directly. */
  declared?: string;
  /** Repo files that import the package (the code that pulls it into the bundle). */
  importedBy?: string[];
  confidence?: 'high' | 'medium' | 'low';
  matchedAnchors?: string[];
  note?: string;
}

export const isPackageName = (s: string) => /^(@[\w.-]+\/)?[\w.-]+$/.test(s);

/** Packages every component uses implicitly: listing importers is noise. */
const RUNTIME_PACKAGES = new Set(['react', 'react-dom', 'scheduler', 'next', 'react-is']);
const CONFIG_FILE = /(^|\/)([^/]*\.config\.[cm]?[jt]s|package\.json)$/;
const CODE_GLOB = '*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}';
const ROUTE_EXTS = ['tsx', 'ts', 'jsx', 'js', 'mdx'];
const HASH = /[-.][0-9a-f]{8,}$/i;

const NEXT_ROLES: Array<[RegExp, string, string[]]> = [
  [/^framework$/, 'Next.js framework chunk: the React runtime', ['react', 'react-dom', 'scheduler']],
  [/^main(-app)?$/, 'Next.js client runtime (router, hydration bootstrap)', ['next']],
  [/^webpack$/, 'webpack runtime (chunk loading)', ['next']],
  [/^polyfills$/, 'Next.js polyfills (legacy browsers only)', ['next']],
];

export interface ChunkRole {
  role: string;
  packages?: string[];
  /** Route the chunk belongs to (Next.js pages/app chunks). */
  route?: string;
  routeFile?: string;
}

/** Role of a chunk from its URL, and the route file it was built from when the name carries the route. */
export async function chunkRole(url: string, source?: CodeSource): Promise<ChunkRole | undefined> {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
  const next = path.match(/\/_next\/static\/chunks\/(.+)\.js$/);
  if (!next) return undefined;
  const name = next[1]!.replace(HASH, '');
  for (const [re, role, packages] of NEXT_ROLES) if (re.test(name)) return { role, packages };

  const route = name.match(/^(pages|app)\/(.+)$/);
  if (!route)
    return { role: 'Shared or lazily loaded (dynamic import) chunk: modules used by several routes' };
  const [, dir, rest] = route;
  const result: ChunkRole = { role: `Route chunk for ${dir}/${rest}`, route: `${dir}/${rest}` };
  if (source) {
    const bases = dir === 'pages' ? [rest, `${rest}/index`] : [rest!];
    for (const prefix of ['src/', ''])
      for (const base of bases)
        for (const ext of ROUTE_EXTS) {
          const file = `${prefix}${dir}/${base}.${ext}`;
          if (!result.routeFile && (await source.exists(file))) result.routeFile = file;
        }
  }
  return result;
}

/** Package name from a node_modules path; Next's vendored copies (next/dist/compiled/x) count as x. */
export function packageFromPath(file: string): { name: string; vendoredBy?: string } | undefined {
  const vendored = file.match(/node_modules\/next\/dist\/compiled\/((?:@[^/]+\/)?[^/]+)/);
  if (vendored) return { name: vendored[1]!.replace(/-experimental$/, ''), vendoredBy: 'next' };
  const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/);
  return m ? { name: m[1]! } : undefined;
}

interface Manifest {
  text: string;
  lines: string[];
}

export class OriginResolver {
  private manifest?: Promise<Manifest | null>;
  private readonly depCache = new Map<string, Promise<Origin>>();
  private depSearches = 0;

  constructor(
    private readonly source: CodeSource,
    private readonly maxDepSearches = 16,
  ) {}

  private loadManifest(): Promise<Manifest | null> {
    this.manifest ??= this.source
      .readText('package.json', 1024 * 1024)
      .then((text) => (text ? { text, lines: text.split('\n') } : null));
    return this.manifest;
  }

  /** package@version, where package.json declares it, and which repo files import it. */
  dependency(name: string, vendoredBy?: string): Promise<Origin> {
    const key = `${name}|${vendoredBy ?? ''}`;
    let hit = this.depCache.get(key);
    if (!hit) {
      hit = this.describeDependency(name, vendoredBy);
      this.depCache.set(key, hit);
    }
    return hit;
  }

  private async describeDependency(name: string, vendoredBy?: string): Promise<Origin> {
    const origin: Origin = { kind: 'dependency', package: name };
    const manifest = await this.loadManifest();
    const installed = await this.installedVersion(
      vendoredBy ? `node_modules/${vendoredBy}/dist/compiled/${name}` : `node_modules/${name}`,
    );
    const declaredAt = (pkg: string) => {
      if (!manifest) return undefined;
      const i = manifest.lines.findIndex((l) => l.includes(`"${pkg}":`));
      if (i < 0) return undefined;
      const section = manifest.lines
        .slice(0, i)
        .reverse()
        .find((l) => /"(dev|peer|optional)?[dD]ependencies"\s*:/.test(l))
        ?.match(/"(\w+)"/)?.[1];
      const range = manifest.lines[i]!.match(/:\s*"([^"]+)"/)?.[1];
      return { line: i + 1, section, range };
    };
    if (vendoredBy) {
      const host = declaredAt(vendoredBy);
      const hostVersion = await this.installedVersion(`node_modules/${vendoredBy}`);
      origin.version = installed;
      origin.declared =
        `bundled inside ${vendoredBy}${hostVersion ? `@${hostVersion}` : ''} (node_modules/${vendoredBy}/dist/compiled/${name})` +
        (host ? `, declared at package.json:${host.line}` : '');
    } else {
      const own = declaredAt(name);
      origin.version = installed ?? own?.range;
      origin.declared = own
        ? `package.json:${own.line} (${own.section ?? 'dependencies'} "${own.range}")`
        : installed
          ? 'not in package.json: a transitive dependency of another package'
          : 'not in package.json or node_modules: loaded by a third-party/CDN script, or node_modules is not installed';
    }
    if (RUNTIME_PACKAGES.has(name)) {
      origin.note =
        'Framework runtime: time here is driven by your components (render/hydration work), not written in this package.';
    } else {
      origin.importedBy = await this.importers(name);
      if (!origin.importedBy.length) origin.importedBy = undefined;
    }
    return origin;
  }

  private async installedVersion(dir: string): Promise<string | undefined> {
    const text = await this.source.readText(`${dir}/package.json`, 256 * 1024);
    try {
      return text ? ((JSON.parse(text) as { version?: string }).version ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  private async importers(name: string): Promise<string[]> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const { matches } = await this.source
      .search(`['"]${escaped}(/[^'"]*)?['"]`, {
        regex: true,
        caseSensitive: true,
        glob: CODE_GLOB,
        maxResults: 60,
      })
      .catch(() => ({ matches: [] }));
    const files = new Map<string, number>();
    for (const m of matches) if (!CONFIG_FILE.test(m.file) && !files.has(m.file)) files.set(m.file, m.line); // config ≠ importer
    return [...files].slice(0, 8).map(([file, line]) => `${file}:${line}`);
  }

  /**
   * Which installed package contains these minification-proof strings: searched in node_modules (bundles ship
   * the package's own literals). Packages declared in package.json win ties over dev tools that vendor copies.
   */
  async matchDependency(anchors: string[]): Promise<Origin | undefined> {
    const manifest = await this.loadManifest();
    const scores = new Map<string, { score: number; anchors: string[]; vendoredBy?: string }>();
    for (const a of anchors) {
      if (this.depSearches >= this.maxDepSearches) break;
      this.depSearches++;
      const { matches } = await this.source
        .search(a, { path: 'node_modules', glob: '*.{js,mjs,cjs}', caseSensitive: true, maxResults: 40 })
        .catch(() => ({ matches: [] }));
      const pkgs = new Map<string, string | undefined>();
      for (const m of matches) {
        const p = packageFromPath(m.file);
        if (p && !pkgs.has(p.name)) pkgs.set(p.name, p.vendoredBy);
      }
      if (!pkgs.size || pkgs.size > 5) continue; // no match, or too common to discriminate
      for (const [name, vendoredBy] of pkgs) {
        const e = scores.get(name) ?? { score: 0, anchors: [], vendoredBy };
        e.score += 1 / pkgs.size;
        e.anchors.push(a);
        scores.set(name, e);
      }
    }
    const declared = (n: string) => (manifest?.text.includes(`"${n}":`) ? 0.5 : 0);
    const top = [...scores.entries()].sort(
      (x, y) => y[1].score + declared(y[0]) - (x[1].score + declared(x[0])),
    )[0];
    if (!top) return undefined;
    const [name, e] = top;
    return {
      ...(await this.dependency(name, e.vendoredBy)),
      confidence: e.anchors.length >= 3 ? 'high' : e.anchors.length === 2 ? 'medium' : 'low',
      matchedAnchors: e.anchors.slice(0, 4),
    };
  }

  /** Source-map path (webpack://_N_E/./src/x.tsx, ../node_modules/pkg/…) → repository file or dependency. */
  async fromSourceMapPath(mapSource: string, line?: number): Promise<Origin> {
    const p = packageFromPath(mapSource);
    if (p) return this.dependency(p.name, p.vendoredBy);
    const rel = mapSource
      .replace(/^[a-z]+:\/\/[^/]*\//i, '')
      .replace(/^(\.\.?\/)+/, '')
      .replace(/^\.\//, '');
    // Strip leading build-only folders, but never down to a bare file name (too ambiguous).
    for (
      let parts = rel.split('/');
      parts.length >= Math.min(2, rel.split('/').length);
      parts = parts.slice(1)
    ) {
      const file = parts.join('/');
      if (await this.source.exists(file)) return { kind: 'repository', file, line };
    }
    return {
      kind: 'unknown',
      note: `${mapSource} is not in the linked source (generated code, or source differs)`,
    };
  }
}
