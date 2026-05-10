#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const summaryPath = args.summary ? path.resolve(args.summary) : '';

if (!summaryPath) {
  console.error('Usage: node scripts/check-obscura-parity.mjs --summary /path/to/summary.json');
  process.exit(2);
}

if (!fs.existsSync(summaryPath)) {
  console.error(`Obscura parity summary does not exist: ${summaryPath}`);
  process.exit(2);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const parity = summary.playwrightParity;

if (!parity || !Array.isArray(parity.requirements)) {
  console.error(`Summary does not contain a playwrightParity requirements block: ${summaryPath}`);
  process.exit(2);
}

const blocking = parity.requirements.filter((requirement) => requirement.status !== 'pass');
const substrateChecks = new Set([
  'auth-caching',
  'browser-navigation-dom-runtime',
  'network-storage',
  'cli-surface',
]);
const substrateUseful = parity.requirements.some((requirement) => (
  substrateChecks.has(requirement.id) && ['pass', 'partial'].includes(requirement.status)
));

const report = {
  summaryPath,
  objective: parity.objective,
  achieved: Boolean(parity.achieved),
  exitCode: parity.achieved ? 0 : 1,
  recommendedMode: parity.achieved
    ? 'playwright-replacement'
    : (substrateUseful ? 'extraction-and-browser-substrate-only' : 'do-not-use'),
  counts: summary.summary || {},
  blockingRequirements: blocking.map((requirement) => ({
    id: requirement.id,
    status: requirement.status,
    failedChecks: Object.entries(requirement.checks || {})
      .filter(([, status]) => status !== 'pass')
      .map(([name, status]) => ({ name, status })),
  })),
};

console.log(JSON.stringify(report, null, 2));

process.exit(parity.achieved ? 0 : 1);

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
