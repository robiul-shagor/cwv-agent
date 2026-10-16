import { createProvider } from '../agent/llm/index.js';
import { ConfigError, loadDotEnv, parseEnv, secretValues } from '../config/env.js';
import { createLogger, registerSecrets } from '../lib/logger.js';
import { parseRumKeys, RumStore } from '../rum/store.js';
import { RunManager } from './runManager.js';
import { createApp } from './server.js';

loadDotEnv();
let env;
try {
  env = parseEnv();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\nSee .env.example.\n`);
    process.exit(2);
  }
  throw err;
}
registerSecrets(secretValues(env));
const logger = createLogger(env.LOG_LEVEL);
if (!env.GOOGLE_API_KEY) logger.warn('GOOGLE_API_KEY is not set: CrUX tools are disabled');

const runs = new RunManager({
  provider: createProvider(env),
  logger,
  googleApiKey: env.GOOGLE_API_KEY,
  chromePath: env.CHROME_PATH,
  rumDataDir: env.RUM_DATA_DIR,
  githubToken: env.GITHUB_TOKEN,
  limits: {
    maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    maxTotalTokens: env.AGENT_MAX_TOTAL_TOKENS,
    toolTimeoutMs: env.TOOL_TIMEOUT_MS,
  },
});

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(env.HOST);
const rumKeys = parseRumKeys(env.RUM_KEYS);
if (rumKeys.size) logger.info('RUM collector enabled', { projects: rumKeys.size, dataDir: env.RUM_DATA_DIR });
const app = createApp({
  runs,
  logger,
  rum: { keys: rumKeys, store: new RumStore(env.RUM_DATA_DIR), publicUrl: env.RUM_PUBLIC_URL },
  // When bound to loopback, only accept requests addressed to localhost (DNS-rebinding protection).
  allowedHosts: loopback ? [`localhost:${env.PORT}`, `127.0.0.1:${env.PORT}`, `[::1]:${env.PORT}`] : [],
});

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info(
    `CWV Agent UI running at http://${env.HOST === '127.0.0.1' ? 'localhost' : env.HOST}:${env.PORT}`,
  );
});
server.on('error', (err) => {
  logger.error(`Server failed to start: ${err.message}`);
  process.exit(1);
});

const shutdown = () => {
  logger.info('Shutting down');
  runs.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
