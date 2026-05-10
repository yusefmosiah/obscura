#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const baseURL = args.baseUrl || process.env.CHOIR_DEPLOYED_BASE_URL || 'https://draft.choir-ip.com';
const obscura = args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-test/obscura';
const authState = path.resolve(
  args.authState ||
    process.env.CHOIR_AUTH_STATE ||
    path.join('playwright', '.auth', `${new URL(baseURL).hostname.replaceAll('.', '-')}.storage.json`),
);
const outDir = path.resolve(
  args.out ||
    process.env.OBSCURA_AUDIT_DIR ||
    path.join('/tmp', 'obscura-test', `repo-audit-parity-${Date.now()}`),
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function run(label, argv) {
  console.log(`\n==> ${label}`);
  console.log(argv.join(' '));
  const result = spawnSync(argv[0], argv.slice(1), {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const setupArgs = [
  process.execPath,
  'scripts/setup-auth-state.mjs',
  '--base-url',
  baseURL,
  '--out',
  authState,
];
if (args.forceAuth) setupArgs.push('--force');
if (args.email) setupArgs.push('--email', args.email);

const setupStatus = run('Refresh Playwright auth state', setupArgs);
if (setupStatus !== 0) process.exit(setupStatus);

const auditStatus = run('Run Obscura Playwright-parity audit', [
  process.execPath,
  'scripts/obscura-capability-audit.mjs',
  '--obscura',
  obscura,
  '--base-url',
  baseURL,
  '--auth-state',
  authState,
  '--out',
  outDir,
]);

console.log(`\nObscura parity audit artifacts: ${outDir}`);
process.exit(auditStatus);
