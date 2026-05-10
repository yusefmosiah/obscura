#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const baseURL = args.baseUrl || process.env.CHOIR_DEPLOYED_BASE_URL || 'https://draft.choir-ip.com';
const obscura = args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-source/target/release/obscura';
const sourceRoot = args.source || process.env.OBSCURA_SOURCE || '/tmp/obscura-source';
const linuxSmoke = args.linuxSmoke || process.env.OBSCURA_LINUX_SMOKE || '';
const authState = path.resolve(
  args.authState ||
    process.env.CHOIR_AUTH_STATE ||
    path.join('playwright', '.auth', `${new URL(baseURL).hostname.replaceAll('.', '-')}.storage.json`),
);
const outDir = path.resolve(
  args.out ||
    process.env.OBSCURA_FULL_AUDIT_DIR ||
    path.join('/tmp', 'obscura-test', `full-audit-${Date.now()}`),
);

fs.mkdirSync(outDir, { recursive: true });

const manifest = {
  objective: 'Full Obscura audit: auth caching, Playwright-parity probes, product flow, source surface, visual primitives, and aggregate completion gate.',
  baseURL,
  obscura,
  sourceRoot,
  linuxSmoke: linuxSmoke || null,
  authState,
  outDir,
  startedAt: new Date().toISOString(),
  steps: [],
  artifacts: {},
};

const setupStatus = runStep('auth_setup', [
  process.execPath,
  'scripts/setup-auth-state.mjs',
  '--base-url',
  baseURL,
  '--out',
  authState,
  ...(args.forceAuth ? ['--force'] : []),
  ...(args.email ? ['--email', args.email] : []),
]);

const auditDir = path.join(outDir, 'capability-audit');
const auditStatus = runStep('capability_audit', [
  process.execPath,
  'scripts/obscura-capability-audit.mjs',
  '--obscura',
  obscura,
  '--base-url',
  baseURL,
  '--auth-state',
  authState,
  '--out',
  auditDir,
  '--product-flow',
]);
const auditSummary = path.join(auditDir, 'summary.json');
manifest.artifacts.paritySummary = auditSummary;

const sourceInventoryDir = path.join(outDir, 'source-inventory');
const sourceInventoryStatus = runStep('source_inventory', [
  process.execPath,
  'scripts/obscura-source-inventory.mjs',
  '--source',
  sourceRoot,
  '--summary',
  auditSummary,
  '--out',
  sourceInventoryDir,
]);
const sourceInventorySummary = path.join(sourceInventoryDir, 'summary.json');
manifest.artifacts.sourceInventory = sourceInventorySummary;

const visualPrimitivesDir = path.join(outDir, 'visual-primitives');
const visualPrimitivesStatus = runStep('visual_primitives', [
  process.execPath,
  'scripts/obscura-visual-primitives-probe.mjs',
  '--obscura',
  obscura,
  '--out',
  visualPrimitivesDir,
]);
const visualPrimitivesSummary = path.join(visualPrimitivesDir, 'summary.json');
manifest.artifacts.visualPrimitives = visualPrimitivesSummary;

let externalVisualBridgeStatus = null;
let externalVisualBridgeSummary = null;
if (!args.skipExternalVisualBridge) {
  const externalVisualBridgeDir = path.join(outDir, 'external-visual-bridge');
  externalVisualBridgeStatus = runStep('external_visual_bridge', [
    process.execPath,
    'scripts/obscura-external-visual-bridge-probe.mjs',
    '--obscura',
    obscura,
    '--url',
    args.bridgeUrl || 'https://example.com',
    '--out',
    externalVisualBridgeDir,
  ]);
  externalVisualBridgeSummary = path.join(externalVisualBridgeDir, 'summary.json');
  manifest.artifacts.externalVisualBridge = externalVisualBridgeSummary;
}

let lightVisualBridgeStatus = null;
let lightVisualBridgeSummary = null;
if (!args.skipLightVisualBridge) {
  const lightVisualBridgeDir = path.join(outDir, 'light-visual-bridge');
  lightVisualBridgeStatus = runStep('light_visual_bridge', [
    process.execPath,
    'scripts/obscura-light-visual-bridge-probe.mjs',
    '--obscura',
    obscura,
    '--url',
    args.bridgeUrl || 'https://example.com',
    '--out',
    lightVisualBridgeDir,
  ]);
  lightVisualBridgeSummary = path.join(lightVisualBridgeDir, 'summary.json');
  manifest.artifacts.lightVisualBridge = lightVisualBridgeSummary;
}

let productVisualBridgeStatus = null;
let productVisualBridgeSummary = null;
if (!args.skipProductVisualBridge) {
  const productVisualBridgeDir = path.join(outDir, 'product-visual-bridge');
  productVisualBridgeStatus = runStep('product_visual_bridge', [
    process.execPath,
    'scripts/obscura-product-visual-bridge-probe.mjs',
    '--obscura',
    obscura,
    '--base-url',
    baseURL,
    '--auth-state',
    authState,
    '--out',
    productVisualBridgeDir,
  ]);
  productVisualBridgeSummary = path.join(productVisualBridgeDir, 'summary.json');
  manifest.artifacts.productVisualBridge = productVisualBridgeSummary;
}

const completionDir = path.join(outDir, 'completion-audit');
fs.mkdirSync(completionDir, { recursive: true });
const completionSummary = path.join(completionDir, 'summary.json');
const completionArgs = [
  process.execPath,
  'scripts/obscura-completion-audit.mjs',
  '--parity-summary',
  auditSummary,
  '--source-inventory',
  sourceInventorySummary,
  '--obscura-source',
  sourceRoot,
  '--visual-primitives',
  visualPrimitivesSummary,
];
if (linuxSmoke) completionArgs.push('--linux-smoke', linuxSmoke);
if (externalVisualBridgeSummary) completionArgs.push('--external-visual-bridge', externalVisualBridgeSummary);
if (lightVisualBridgeSummary) completionArgs.push('--light-visual-bridge', lightVisualBridgeSummary);
if (productVisualBridgeSummary) completionArgs.push('--product-visual-bridge', productVisualBridgeSummary);
const completionStatus = runStep('completion_audit', completionArgs, { stdoutPath: completionSummary });
manifest.artifacts.completionAudit = completionSummary;

manifest.finishedAt = new Date().toISOString();
manifest.exitCodes = {
  setupStatus,
  auditStatus,
  sourceInventoryStatus,
  visualPrimitivesStatus,
  externalVisualBridgeStatus,
  lightVisualBridgeStatus,
  productVisualBridgeStatus,
  completionStatus,
};
manifest.ok = completionStatus === 0;
manifest.expectedCurrentBlockers = completionStatus === 0 ? [] : readBlockingItems(completionSummary);
manifest.blockingItems = manifest.expectedCurrentBlockers;

const manifestPath = path.join(outDir, 'manifest.json');
manifest.artifacts.manifest = manifestPath;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  manifestPath,
  ok: manifest.ok,
  exitCodes: manifest.exitCodes,
  blockingItems: manifest.expectedCurrentBlockers,
  artifacts: manifest.artifacts,
}, null, 2));

process.exitCode = manifest.ok ? 0 : 1;

function runStep(name, command, options = {}) {
  console.log(`\n==> ${name}`);
  console.log(command.join(' '));
  const result = spawnSync(command[0], command.slice(1), {
    encoding: options.stdoutPath ? 'utf8' : undefined,
    stdio: options.stdoutPath ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });

  if (options.stdoutPath) {
    fs.writeFileSync(options.stdoutPath, result.stdout || '', 'utf8');
    if (result.stdout) process.stdout.write(result.stdout);
  }

  const status = result.error ? 1 : (result.status ?? 1);
  manifest.steps.push({
    name,
    command,
    status,
    stdoutPath: options.stdoutPath || null,
    error: result.error ? result.error.message : null,
  });
  return status;
}

function readBlockingItems(completionPath) {
  if (!fs.existsSync(completionPath)) return ['completion-audit-missing'];
  const raw = fs.readFileSync(completionPath, 'utf8');
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return ['completion-audit-unparseable'];
  try {
    const parsed = JSON.parse(raw.slice(jsonStart));
    return Array.isArray(parsed.blockingItems) ? parsed.blockingItems : ['completion-audit-no-blocking-items'];
  } catch {
    return ['completion-audit-unparseable'];
  }
}

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
