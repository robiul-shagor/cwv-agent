/** Bundles the RUM client into a single minified IIFE for client sites: dist/rum/cwv-rum.js */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const OUT = 'dist/rum/cwv-rum.js';
/** Gzipped size budget: the script must stay cheap for the sites it measures. */
const BUDGET_GZIP_BYTES = 8 * 1024;

await build({
  entryPoints: ['src/rum-client/index.ts'],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'], // every browser that can report INP/LCP supports ES2020
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
});

const code = readFileSync(OUT);
const gz = gzipSync(code).length;
console.log(`${OUT}: ${(code.length / 1024).toFixed(1)} KB (${(gz / 1024).toFixed(1)} KB gzip)`);
if (gz > BUDGET_GZIP_BYTES) {
  console.error(`RUM bundle exceeds the ${BUDGET_GZIP_BYTES / 1024} KB gzip budget`);
  process.exit(1);
}
