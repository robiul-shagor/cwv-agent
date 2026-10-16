import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSensitivePath, redactSecrets } from '../src/lib/secrets.js';
import { globToRegExp, LocalSource } from '../src/source/local.js';
import { parseSourceSpec, resolveSource } from '../src/source/index.js';
import { listFiles, readFileTool, searchCode } from '../src/tools/code.js';
import { ToolError } from '../src/tools/types.js';
import { ctx } from './helpers.js';

let root: string;
let outside: string;

const HERO = `import Image from 'next/image';
import styles from './Hero.module.css';

export function Hero() {
  return (
    <section className={styles.homeHeader__content}>
      <div className="hero-title-main">
        <Image src="/img/hero-banner.webp" alt="" fill loading="lazy" />
      </div>
    </section>
  );
}
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cwv-src-test-'));
  outside = await mkdtemp(join(tmpdir(), 'cwv-outside-'));
  await mkdir(join(root, 'src/components'), { recursive: true });
  await mkdir(join(root, 'node_modules/lib'), { recursive: true });
  await mkdir(join(root, '.next/static'), { recursive: true });
  await writeFile(join(root, 'src/components/Hero.tsx'), HERO);
  await writeFile(
    join(root, 'src/components/Hero.module.css'),
    '.homeHeader__content { min-height: 60vh; }\n',
  );
  await writeFile(
    join(root, 'src/config.ts'),
    'export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";\n',
  );
  await writeFile(join(root, 'node_modules/lib/index.js'), 'hero-title-main');
  await writeFile(join(root, '.next/static/chunk.js'), 'hero-title-main');
  await writeFile(join(root, '.env'), 'SECRET=hero-title-main\n');
  await writeFile(join(root, '.env.example'), 'SECRET=\n');
  await writeFile(join(root, 'server.pem'), 'hero-title-main');
  await writeFile(join(outside, 'secret.txt'), 'outside-secret');
  await symlink(outside, join(root, 'escape'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('secrets', () => {
  it('flags sensitive files but allows env examples', () => {
    for (const p of [
      '.env',
      'apps/web/.env.local',
      '.npmrc',
      'certs/server.pem',
      'id_rsa',
      'wp-config.php',
      'config/credentials.json',
      'backup/site-2026.sql',
      'db.sql.gz',
      'wp-content/debug.log',
      'wp-content/ai1wm-backups/site.wpress',
      'wp-content/updraft/index.html',
    ])
      expect(isSensitivePath(p), p).toBe(true);
    for (const p of [
      '.env.example',
      'src/env.ts',
      'src/secrets.ts',
      'README.md',
      'src/debug.ts',
      'wp-content/themes/x/functions.php',
    ])
      expect(isSensitivePath(p), p).toBe(false);
  });

  it('masks secret-looking values', () => {
    const out = redactSecrets(
      'key = "sk-abcdefghijklmnopqrstuvwxyz123456"\nconst password = "hunter2hunter2"\npostgres://u:p4ss@db/x\nghp_' +
        'a'.repeat(36),
    );
    expect(out).not.toMatch(/sk-abc|hunter2|p4ss|ghp_a/);
    expect(out).toContain('password = "[REDACTED]"');
  });
});

describe('globToRegExp', () => {
  it('matches basenames, ** and braces', () => {
    expect(globToRegExp('*.tsx').test('src/components/Hero.tsx')).toBe(true);
    expect(globToRegExp('*.{css,scss}').test('a/b.scss')).toBe(true);
    expect(globToRegExp('**/components/**').test('src/components/Hero.tsx')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe.each([
  ['ripgrep', process.env.RG_PATH ?? 'rg'],
  ['node fallback', 'definitely-not-installed-rg'],
])('LocalSource search (%s)', (_name, rg) => {
  it('finds code, skips deps/build/secrets, masks secrets', async () => {
    const src = new LocalSource(root, root, rg);
    const { matches } = await src.search('hero-title-main');
    expect(matches).toEqual([
      { file: 'src/components/Hero.tsx', line: 7, text: '      <div className="hero-title-main">' },
    ]);
    const secret = await src.search('apiKey');
    expect(secret.matches[0]?.text).toBe('export const apiKey = "[REDACTED]";');
    const re = await src.search('loading=["\']lazy', { regex: true, glob: '*.tsx' });
    expect(re.matches.map((m) => `${m.file}:${m.line}`)).toEqual(['src/components/Hero.tsx:8']);
  });
});

describe('LocalSource', () => {
  const src = () => new LocalSource(root);

  it('lists project files only', async () => {
    const { files } = await src().listFiles();
    expect(files).toEqual([
      '.env.example',
      'src/components/Hero.module.css',
      'src/components/Hero.tsx',
      'src/config.ts',
    ]);
    expect((await src().listFiles('.', '*.css')).files).toEqual(['src/components/Hero.module.css']);
  });

  it('reads numbered line ranges', async () => {
    const slice = await src().readFile('src/components/Hero.tsx', 6, 8);
    expect(slice).toMatchObject({
      file: 'src/components/Hero.tsx',
      startLine: 6,
      endLine: 8,
      totalLines: 13,
      truncated: false,
    });
    expect(slice.content.split('\n')[2]).toBe(
      '8|         <Image src="/img/hero-banner.webp" alt="" fill loading="lazy" />',
    );
  });

  it('refuses traversal, symlink escapes and secret files', async () => {
    await expect(src().readFile('../etc/passwd')).rejects.toThrow();
    await expect(src().readFile('escape/secret.txt')).rejects.toThrow(/outside the project/);
    await expect(src().readFile('.env')).rejects.toThrow(/sensitive/);
    await expect(src().readFile('server.pem')).rejects.toThrow(/sensitive/);
    expect(await src().exists('.env')).toBe(false);
    expect(await src().exists('src/components/Hero.tsx')).toBe(true);
  });
});

describe('code tools', () => {
  it('require a linked source', async () => {
    await expect(
      searchCode.execute({ query: 'x', regex: false, caseSensitive: false, maxResults: 5 }, ctx()),
    ).rejects.toThrow(ToolError);
  });

  it('expose list/search/read through the tool context', async () => {
    const c = ctx({ source: new LocalSource(root) });
    const list = (await listFiles.execute({ path: 'src', limit: 10 }, c)) as { files: string[] };
    expect(list.files).toContain('src/components/Hero.tsx');
    const found = (await searchCode.execute(
      { query: 'homeHeader__content', regex: false, caseSensitive: false, maxResults: 10 },
      c,
    )) as {
      matches: unknown[];
    };
    expect(found.matches).toHaveLength(2);
    await expect(readFileTool.execute({ file: '.env', startLine: 1 }, c)).rejects.toThrow(ToolError);
  });
});

describe('parseSourceSpec / resolveSource', () => {
  it('parses GitHub forms and local paths', () => {
    expect(parseSourceSpec('https://github.com/vercel/next.js')).toEqual({
      kind: 'github',
      owner: 'vercel',
      repo: 'next.js',
    });
    expect(parseSourceSpec('https://github.com/owner/site/tree/feature/cwv')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'site',
      ref: 'feature/cwv',
    });
    expect(parseSourceSpec('github.com/owner/site.git#main')).toMatchObject({ repo: 'site', ref: 'main' });
    expect(parseSourceSpec('git@github.com:owner/site.git')).toMatchObject({ owner: 'owner', repo: 'site' });
    expect(parseSourceSpec('owner/site#abc1234')).toMatchObject({ ref: 'abc1234' });
    expect(parseSourceSpec(root)).toEqual({ kind: 'local', path: root });
    expect(() => parseSourceSpec('/no/such/folder')).toThrow(/not found/);
    expect(() => parseSourceSpec('owner/site#../../x')).toThrow(/Invalid/);
    expect(() => parseSourceSpec('https://github.com/own;er/x')).toThrow(/Invalid/);
  });

  it('resolves a local git checkout with branch/commit/dirty info', async () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const r = await resolveSource(root);
    expect(r.info).toMatchObject({ kind: 'local', branch: 'main' });
    expect(r.info.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.info.dirtyFiles).toBeGreaterThan(0);
    expect(r.source.label).toContain('git main@');
  });
});

describe.each([
  ['ripgrep', process.env.RG_PATH ?? 'rg'],
  ['node fallback', 'definitely-not-installed-rg'],
])('LocalSource on a WordPress site (%s)', (_name, rg) => {
  let site: string;

  beforeAll(async () => {
    site = await mkdtemp(join(tmpdir(), 'cwv-wp-test-'));
    for (const d of ['themes/acme', 'plugins/slider', 'uploads/2026', 'cache/min', 'ai1wm-backups'])
      await mkdir(join(site, 'wp-content', d), { recursive: true });
    await writeFile(join(site, 'wp-config.php'), "define('DB_PASSWORD', 'x'); // hero-slider");
    await writeFile(join(site, 'wp-content/themes/acme/header.php'), '<div class="hero-slider">');
    await writeFile(join(site, 'wp-content/plugins/slider/slider.php'), "wp_enqueue_script('hero-slider');");
    await writeFile(join(site, 'wp-content/uploads/2026/x.js'), 'hero-slider');
    await writeFile(join(site, 'wp-content/cache/min/all.js'), 'hero-slider');
    await writeFile(join(site, 'wp-content/ai1wm-backups/x.txt'), 'hero-slider');
    await writeFile(join(site, 'wp-content/debug.log'), 'hero-slider');
  });

  afterAll(() => rm(site, { recursive: true, force: true }));

  it('searches theme/plugin code but skips uploads, caches, backups, logs and wp-config', async () => {
    for (const [dir, prefix] of [
      [site, 'wp-content/'],
      [join(site, 'wp-content'), ''],
    ] as const) {
      const { matches } = await new LocalSource(dir, dir, rg).search('hero-slider');
      expect(matches.map((m) => m.file).sort()).toEqual([
        `${prefix}plugins/slider/slider.php`,
        `${prefix}themes/acme/header.php`,
      ]);
    }
    const { files } = await new LocalSource(site).listFiles();
    expect(files).toEqual(['wp-content/plugins/slider/slider.php', 'wp-content/themes/acme/header.php']);
  });
});
