import { spawn } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSensitivePath, redactSecrets } from '../lib/secrets.js';
import {
  SourceError,
  type CodeSource,
  type FileSlice,
  type SearchMatch,
  type SearchOptions,
} from './types.js';

/** Build output, dependencies and tool caches: never useful for locating source. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.vercel',
  '.netlify',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
  'vendor',
  '__pycache__',
  '.venv',
]);

/** Data folders directly under `wp-content/`: user uploads, caches, backups — never theme/plugin source. */
export const WP_CONTENT_IGNORED = new Set([
  'uploads',
  'cache',
  'upgrade',
  'upgrade-temp-backup',
  'ai1wm-backups',
  'updraft',
  'wflogs',
  'backup',
  'backups',
]);

const SKIP_FILE =
  /(\.min\.(js|css)|\.map|\.lock|-lock\.(json|yaml)|\.(png|jpe?g|gif|webp|avif|ico|svgz|bmp|tiff?|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|br|7z|rar|exe|dll|so|dylib|wasm|psd|ai|sketch|fig))$/i;

const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const MAX_READ_LINES = 300;
const MAX_READ_CHARS = 40_000;
const MAX_LINE_CHARS = 240;
const MAX_WALK_FILES = 50_000;

/** Minimal glob → RegExp: supports **, *, ?, {a,b}. Patterns without "/" match the basename. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re +=
          '(?:' +
          glob
            .slice(i + 1, end)
            .split(',')
            .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
            .join('|') +
          ')';
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return glob.includes('/') ? new RegExp(`^${re}$`) : new RegExp(`(?:^|/)${re}$`);
}

const truncateLine = (s: string) => {
  const t = s.replace(/\s+$/, '');
  return t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS) + '…' : t;
};

export class LocalSource implements CodeSource {
  private realRoot?: string;

  constructor(
    readonly root: string,
    readonly label: string = root,
    private readonly rgPath: string = process.env.RG_PATH ?? 'rg',
  ) {}

  private async getRoot(): Promise<string> {
    this.realRoot ??= await realpath(this.root);
    return this.realRoot;
  }

  /** Resolves a user/LLM-supplied relative path, refusing anything outside the root (incl. via symlinks). */
  async resolvePath(rel = '.'): Promise<{ abs: string; rel: string }> {
    const root = await this.getRoot();
    const cleaned = (isAbsolute(rel) ? relative(root, rel) : rel).replace(/\\/g, '/') || '.';
    const abs = resolve(root, cleaned);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new SourceError(`Not found: ${cleaned}`);
    }
    if (real !== root && !real.startsWith(root + sep))
      throw new SourceError(`Path is outside the project: ${cleaned}`);
    const relPath = relative(root, real).split(sep).join('/') || '.';
    return { abs: real, rel: relPath };
  }

  async readText(file: string, maxBytes: number): Promise<string | null> {
    try {
      const { abs, rel } = await this.resolvePath(file);
      if (isSensitivePath(rel)) return null;
      const info = await stat(abs);
      if (!info.isFile() || info.size > maxBytes) return null;
      return await readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  async exists(file: string): Promise<boolean> {
    try {
      const { abs, rel } = await this.resolvePath(file);
      return !isSensitivePath(rel) && (await stat(abs)).isFile();
    } catch {
      return false;
    }
  }

  private async *walk(dirAbs: string, root: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = join(dirAbs, e.name);
      if (e.isDirectory()) {
        const wpData = basename(dirAbs) === 'wp-content' && WP_CONTENT_IGNORED.has(e.name);
        if (!IGNORED_DIRS.has(e.name) && !wpData) yield* this.walk(abs, root);
      } else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join('/');
        if (!isSensitivePath(rel)) yield rel;
      }
      // Symlinks are skipped while walking (they could point outside the root).
    }
  }

  async listFiles(dir = '.', glob?: string, limit = 300) {
    const root = await this.getRoot();
    const { abs } = await this.resolvePath(dir);
    const re = glob ? globToRegExp(glob) : undefined;
    const files: string[] = [];
    let truncated = false;
    let seen = 0;
    for await (const rel of this.walk(abs, root)) {
      if (++seen > MAX_WALK_FILES) {
        truncated = true;
        break;
      }
      if (re && !re.test(rel)) continue;
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      files.push(rel);
    }
    return { files, truncated };
  }

  async search(query: string, opts: SearchOptions = {}) {
    if (!query.trim()) throw new SourceError('Empty search query');
    const max = Math.min(opts.maxResults ?? 40, 200);
    const { abs } = await this.resolvePath(opts.path ?? '.');
    try {
      return await this.searchWithRipgrep(query, abs, opts, max);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return this.searchWithNode(query, abs, opts, max);
    }
  }

  private async searchWithRipgrep(query: string, dirAbs: string, opts: SearchOptions, max: number) {
    const root = await this.getRoot();
    const args = ['--json', '--max-filesize', '1M', '--max-count', '20', '--no-follow'];
    if (!opts.regex) args.push('--fixed-strings');
    args.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case');
    for (const d of IGNORED_DIRS) args.push('--glob', `!${d}/`);
    for (const d of WP_CONTENT_IGNORED) {
      args.push('--glob', `!**/wp-content/${d}/**`);
      if (basename(root) === 'wp-content') args.push('--glob', `!/${d}/**`);
    }
    args.push('--glob', '!*.min.{js,css}', '--glob', '!*.map', '--glob', '!*lock*');
    if (opts.glob) args.push('--glob', opts.glob);
    args.push('--', query, dirAbs);

    return new Promise<{ matches: SearchMatch[]; truncated: boolean }>((resolvePromise, reject) => {
      const child = spawn(this.rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const matches: SearchMatch[] = [];
      let truncated = false;
      let buf = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.includes('"type":"match"')) continue;
          const evt = JSON.parse(line) as {
            data: { path: { text?: string }; line_number: number; lines: { text?: string } };
          };
          const file = relative(root, evt.data.path.text ?? '')
            .split(sep)
            .join('/');
          if (isSensitivePath(file)) continue;
          if (matches.length >= max) {
            truncated = true;
            child.kill();
            return;
          }
          matches.push({
            file,
            line: evt.data.line_number,
            text: redactSecrets(truncateLine(evt.data.lines.text ?? '')),
          });
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // 0 = matches, 1 = no matches, null = killed after enough results.
        if (code === 0 || code === 1 || code === null || truncated) resolvePromise({ matches, truncated });
        else reject(new SourceError(`Search failed: ${stderr.trim().split('\n')[0] ?? `rg exited ${code}`}`));
      });
    });
  }

  private async searchWithNode(query: string, dirAbs: string, opts: SearchOptions, max: number) {
    const root = await this.getRoot();
    let re: RegExp;
    try {
      const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(src, opts.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new SourceError(`Invalid regex: ${(err as Error).message}`);
    }
    const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
    const matches: SearchMatch[] = [];
    let seen = 0;
    for await (const rel of this.walk(dirAbs, root)) {
      if (++seen > MAX_WALK_FILES) return { matches, truncated: true };
      if (SKIP_FILE.test(rel) || (globRe && !globRe.test(rel))) continue;
      const abs = join(root, rel);
      if ((await stat(abs)).size > MAX_SEARCH_FILE_BYTES) continue;
      const text = await readFile(abs, 'utf8');
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      let perFile = 0;
      for (let i = 0; i < lines.length && perFile < 20; i++) {
        const line = lines[i]!;
        if (line.length > 5000 || !re.test(line)) continue;
        if (matches.length >= max) return { matches, truncated: true };
        matches.push({ file: rel, line: i + 1, text: redactSecrets(truncateLine(line)) });
        perFile++;
      }
    }
    return { matches, truncated: false };
  }

  async readFile(file: string, startLine = 1, endLine?: number): Promise<FileSlice> {
    const { abs, rel } = await this.resolvePath(file);
    if (isSensitivePath(rel)) throw new SourceError(`Refusing to read sensitive file: ${rel}`);
    const info = await stat(abs);
    if (!info.isFile()) throw new SourceError(`Not a file: ${rel}`);
    if (info.size > MAX_READ_FILE_BYTES) throw new SourceError(`File too large to read: ${rel}`);

    const fh = await open(abs, 'r');
    let text: string;
    try {
      text = await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
    if (text.includes('\0')) throw new SourceError(`Binary file: ${rel}`);

    const lines = text.split('\n');
    const start = Math.max(1, Math.min(startLine, lines.length));
    const wanted = Math.min(lines.length, Math.max(start, endLine ?? start + 199));
    let end = Math.min(wanted, start + MAX_READ_LINES - 1);
    const width = String(end).length;
    let content = '';
    for (let n = start; n <= end; n++) {
      const row = `${String(n).padStart(width)}| ${truncateLine(lines[n - 1] ?? '')}\n`;
      if (content.length + row.length > MAX_READ_CHARS) {
        end = n - 1;
        break;
      }
      content += row;
    }
    return {
      file: rel,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: redactSecrets(content),
      truncated: end < wanted,
    };
  }
}
