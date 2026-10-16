import { parseArgs } from 'node:util';
import { runAgent } from '../agent/loop.js';
import { createProvider } from '../agent/llm/index.js';
import { saveReportFiles, saveRunLog } from '../agent/runLog.js';
import { ConfigError, loadDotEnv, parseEnv, secretValues } from '../config/env.js';
import { createLogger, registerSecrets } from '../lib/logger.js';
import { normalizeUrl, UnsafeUrlError } from '../lib/url.js';
import { CODE_TOOL_CALL_BONUS, resolveSource, SourceError, type ResolvedSource } from '../source/index.js';
import { toolsFor } from '../tools/index.js';

const USAGE = `Usage: npm run diagnose -- <url> [options]

Options:
  -d, --device <mobile|desktop>  Device to diagnose (default: mobile)
  -s, --source <path|repo>       Link source code: local folder or GitHub repo
                                 (e.g. ~/Projects/site, https://github.com/owner/repo, owner/repo#branch)
  -o, --out <dir>                Directory for report files (default: reports)
      --json                     Print the JSON report to stdout instead of markdown
      --max-tool-calls <n>       Override AGENT_MAX_TOOL_CALLS
  -h, --help                     Show this help
`;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        device: { type: 'string', short: 'd', default: 'mobile' },
        out: { type: 'string', short: 'o', default: 'reports' },
        json: { type: 'boolean', default: false },
        'max-tool-calls': { type: 'string' },
        source: { type: 'string', short: 's' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.device !== 'mobile' && values.device !== 'desktop') {
    process.stderr.write(`--device must be "mobile" or "desktop"\n`);
    return 2;
  }
  const device = values.device;

  let url: string;
  try {
    url = normalizeUrl(positionals[0]!).toString();
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  loadDotEnv();
  let env;
  try {
    env = parseEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee .env.example.\n`);
      return 2;
    }
    throw err;
  }
  registerSecrets(secretValues(env));
  const logger = createLogger(env.LOG_LEVEL);
  if (!env.GOOGLE_API_KEY) {
    logger.warn('GOOGLE_API_KEY is not set: CrUX tools are disabled and PSI uses the shared anonymous quota');
  }

  const maxToolCalls = values['max-tool-calls'] ? Number(values['max-tool-calls']) : env.AGENT_MAX_TOOL_CALLS;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1) {
    process.stderr.write('--max-tool-calls must be a positive integer\n');
    return 2;
  }

  const controller = new AbortController();
  const onSignal = () => {
    logger.warn('Interrupted — stopping run');
    controller.abort(new Error('Interrupted by user'));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let linked: ResolvedSource | undefined;
  if (values.source) {
    try {
      logger.info('Preparing source code', { source: values.source });
      linked = await resolveSource(values.source, {
        githubToken: env.GITHUB_TOKEN,
        signal: controller.signal,
      });
      logger.info('Source linked', { source: linked.info.label });
    } catch (err) {
      if (err instanceof SourceError) {
        process.stderr.write(`${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  const provider = createProvider(env);
  logger.info('Starting diagnosis', { url, device, provider: provider.name, model: provider.model });

  const run = await runAgent({
    url,
    device,
    provider,
    tools: toolsFor({ code: !!linked }),
    source: linked?.source,
    logger,
    googleApiKey: env.GOOGLE_API_KEY,
    chromePath: env.CHROME_PATH,
    rumDataDir: env.RUM_DATA_DIR,
    signal: controller.signal,
    limits: {
      maxToolCalls: maxToolCalls + (linked ? CODE_TOOL_CALL_BONUS : 0),
      maxTotalTokens: env.AGENT_MAX_TOTAL_TOKENS,
      toolTimeoutMs: env.TOOL_TIMEOUT_MS,
    },
  });

  await linked?.cleanup();
  const runLogPath = await saveRunLog(run);
  logger.info('Run log saved', { path: runLogPath, toolCalls: run.toolCalls, tokens: run.usage.totalTokens });

  if (run.status !== 'completed' || !run.report) {
    logger.error(`Diagnosis failed: ${run.error ?? 'unknown error'}`);
    return 1;
  }

  const { markdown, mdPath, jsonPath } = await saveReportFiles({ ...run, report: run.report }, values.out!);
  logger.info('Report saved', { markdown: mdPath, json: jsonPath });

  process.stdout.write(values.json ? JSON.stringify(run.report, null, 2) + '\n' : markdown);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
