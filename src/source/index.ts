import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redact } from '../lib/logger.js';
import { LocalSource } from './local.js';
import { SourceError, type CodeSource, type SourceInfo } from './types.js';

export * from './types.js';

/** Extra tool calls granted when code is linked (locating needs search + read per finding). */
export const CODE_TOOL_CALL_BONUS = 15;
export { LocalSource } from './local.js';

export type SourceSpec =
  { kind: 'local'; path: string } | { kind: 'github'; owner: string; repo: string; ref?: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^(?!.*\.\.)(?!-)[A-Za-z0-9._/-]{1,200}$/;

function githubSpec(owner: string, repo: string, ref?: string): SourceSpec {
  repo = repo.replace(/\.git$/, '');
  if (!OWNER.test(owner) || !REPO.test(repo))
    throw new SourceError(`Invalid GitHub repository: ${owner}/${repo}`);
  if (ref !== undefined && !REF.test(ref)) throw new SourceError(`Invalid branch/tag/commit: ${ref}`);
  return { kind: 'github', owner, repo, ...(ref ? { ref } : {}) };
}

/**
 * Accepts a local folder or a GitHub repository:
 *   ~/Projects/site · ./site · /abs/path
 *   https://github.com/owner/repo · https://github.com/owner/repo/tree/branch · github.com/owner/repo
 *   owner/repo · owner/repo#branch · git@github.com:owner/repo.git
 */
export function parseSourceSpec(input: string): SourceSpec {
  const raw = input.trim();
  if (!raw) throw new SourceError('Source is empty');

  const url =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^\s#?]+))?\/?(?:#(\S+))?$/i.exec(
      raw,
    );
  if (url) return githubSpec(url[1]!, url[2]!, url[3] ?? url[4]);
  const ssh = /^git@github\.com:([^/\s]+)\/([^\s#]+?)(?:\.git)?(?:#(\S+))?$/i.exec(raw);
  if (ssh) return githubSpec(ssh[1]!, ssh[2]!, ssh[3]);

  const path = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
  if (existsSync(path)) return { kind: 'local', path: resolve(path) };

  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:#(\S+))?$/.exec(raw);
  if (short) return githubSpec(short[1]!, short[2]!, short[3]);

  throw new SourceError(`Source not found: "${raw}" is neither an existing folder nor a GitHub repository`);
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? 30_000,
        signal: opts.signal,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolvePromise(String(stdout).trim());
      },
    );
  });
}

async function gitInfo(dir: string): Promise<Pick<SourceInfo, 'commit' | 'branch' | 'dirtyFiles'>> {
  try {
    const [commit, branch, status] = await Promise.all([
      run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 5000 }),
      run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 }),
      run('git', ['-C', dir, 'status', '--porcelain'], { timeoutMs: 10_000 }),
    ]);
    return { commit, branch, dirtyFiles: status ? status.split('\n').length : 0 };
  } catch {
    return {}; // not a git checkout
  }
}

export interface ResolvedSource {
  source: CodeSource;
  info: SourceInfo;
  /** Removes temporary clones. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

export interface ResolveOptions {
  githubToken?: string;
  signal?: AbortSignal;
  /** Where GitHub repos are cloned (default: OS temp dir). */
  cloneDir?: string;
}

async function cloneGithub(
  spec: Extract<SourceSpec, { kind: 'github' }>,
  opts: ResolveOptions,
): Promise<ResolvedSource> {
  const dir = await mkdtemp(join(opts.cloneDir ?? tmpdir(), 'cwv-src-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GCM_INTERACTIVE: 'never',
  };
  if (opts.githubToken) {
    // Passed via env-config so the token never appears in argv, the remote URL or .git/config.
    const basic = Buffer.from(`x-access-token:${opts.githubToken}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  const remote = `https://github.com/${spec.owner}/${spec.repo}.git`;
  const isSha = spec.ref !== undefined && /^[0-9a-f]{7,40}$/i.test(spec.ref);
  const gitOpts = { env, timeoutMs: 180_000, signal: opts.signal };

  try {
    if (isSha) {
      await run('git', ['init', '--quiet', dir], gitOpts);
      await run('git', ['-C', dir, 'remote', 'add', 'origin', remote], gitOpts);
      await run('git', ['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin', spec.ref!], gitOpts);
      await run('git', ['-C', dir, 'checkout', '--quiet', 'FETCH_HEAD'], gitOpts);
    } else {
      const args = ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags'];
      if (spec.ref) args.push('--branch', spec.ref);
      await run('git', [...args, '--', remote, dir], gitOpts);
    }
  } catch (err) {
    await cleanup();
    const stderr = redact(String((err as { stderr?: string }).stderr ?? (err as Error).message));
    if (/not found|could not read username|authentication failed|403/i.test(stderr)) {
      throw new SourceError(
        `Cannot access github.com/${spec.owner}/${spec.repo}: repository not found or private` +
          (opts.githubToken ? ' (check GITHUB_TOKEN permissions)' : ' (set GITHUB_TOKEN for private repos)'),
      );
    }
    if (/remote branch .* not found|couldn't find remote ref/i.test(stderr)) {
      throw new SourceError(`Branch/tag "${spec.ref}" not found in ${spec.owner}/${spec.repo}`);
    }
    throw new SourceError(`git clone failed: ${stderr.split('\n')[0] ?? 'unknown error'}`);
  }

  const git = await gitInfo(dir);
  const repo = `${spec.owner}/${spec.repo}`;
  const label = `github.com/${repo}@${spec.ref ?? git.branch ?? 'default'}${git.commit ? ` (${git.commit})` : ''}`;
  return {
    source: new LocalSource(dir, label),
    info: { kind: 'github', label, root: dir, repo, ref: spec.ref, commit: git.commit, branch: git.branch },
    cleanup,
  };
}

export async function resolveSource(input: string, opts: ResolveOptions = {}): Promise<ResolvedSource> {
  const spec = parseSourceSpec(input);
  if (spec.kind === 'github') return cloneGithub(spec, opts);

  const info = await stat(spec.path).catch(() => null);
  if (!info?.isDirectory()) throw new SourceError(`Not a folder: ${spec.path}`);
  const git = await gitInfo(spec.path);
  const label = `${spec.path}${git.branch ? ` (git ${git.branch}@${git.commit}${git.dirtyFiles ? `, ${git.dirtyFiles} uncommitted changes` : ''})` : ''}`;
  return {
    source: new LocalSource(spec.path, label),
    info: { kind: 'local', label, root: spec.path, ...git },
    cleanup: async () => {},
  };
}
