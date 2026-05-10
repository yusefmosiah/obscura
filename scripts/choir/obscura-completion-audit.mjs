#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const parityPath = args.paritySummary ? path.resolve(args.paritySummary) : '';
const sourceInventoryPath = args.sourceInventory ? path.resolve(args.sourceInventory) : '';
const linuxSmokePath = args.linuxSmoke ? path.resolve(args.linuxSmoke) : '';
const obscuraSourcePath = args.obscuraSource ? path.resolve(args.obscuraSource) : '';
const visualPrimitivesPath = args.visualPrimitives ? path.resolve(args.visualPrimitives) : '';
const externalVisualBridgePath = args.externalVisualBridge ? path.resolve(args.externalVisualBridge) : '';
const lightVisualBridgePath = args.lightVisualBridge ? path.resolve(args.lightVisualBridge) : '';
const productVisualBridgePath = args.productVisualBridge ? path.resolve(args.productVisualBridge) : '';

if (!parityPath || !sourceInventoryPath) {
  console.error('Usage: node scripts/obscura-completion-audit.mjs --parity-summary /path/to/summary.json --source-inventory /path/to/summary.json [--linux-smoke /path/to/summary.json] [--obscura-source /path/to/source] [--visual-primitives /path/to/summary.json] [--external-visual-bridge /path/to/summary.json] [--light-visual-bridge /path/to/summary.json] [--product-visual-bridge /path/to/summary.json]');
  process.exit(2);
}

const parity = readJSON(parityPath, 'parity summary');
const sourceInventory = readJSON(sourceInventoryPath, 'source inventory summary');
const linuxSmoke = linuxSmokePath ? readJSON(linuxSmokePath, 'Linux smoke summary') : null;
const visualRenderer = obscuraSourcePath ? inspectVisualRendererSupport(obscuraSourcePath) : null;
const visualPrimitives = visualPrimitivesPath ? readJSON(visualPrimitivesPath, 'visual primitives summary') : null;
const externalVisualBridge = externalVisualBridgePath ? readJSON(externalVisualBridgePath, 'external visual bridge summary') : null;
const lightVisualBridge = lightVisualBridgePath ? readJSON(lightVisualBridgePath, 'light visual bridge summary') : null;
const productVisualBridge = productVisualBridgePath ? readJSON(productVisualBridgePath, 'product visual bridge summary') : null;
const visualEvidence = {
  source: visualRenderer,
  primitives: visualPrimitives ? visualPrimitivesEvidence(visualPrimitives) : null,
};
const fallbackEvidence = {
  externalVisualBridge: externalVisualBridge ? externalVisualBridgeEvidence(externalVisualBridge) : null,
  lightVisualBridge: lightVisualBridge ? lightVisualBridgeEvidence(lightVisualBridge) : null,
  productVisualBridge: productVisualBridge ? productVisualBridgeEvidence(productVisualBridge) : null,
};

const parityBlock = parity.playwrightParity || {};
const requirements = Array.isArray(parityBlock.requirements) ? parityBlock.requirements : [];
const requirementStatus = new Map(requirements.map((requirement) => [requirement.id, requirement.status]));
const resultStatus = new Map((Array.isArray(parity.results) ? parity.results : []).map((result) => [result.name, result.status]));

const checklist = [
  item(
    'auth-caching',
    'Set up auth once and reuse it from Obscura.',
    requirementStatus.get('auth-caching') === 'pass',
    {
      evidence: requirementStatus.get('auth-caching') || 'missing',
      artifact: parityPath,
    },
  ),
  item(
    'screenshots',
    'Duplicate Playwright screenshot capture.',
    requirementStatus.get('screenshots') === 'pass' &&
      (visualRenderer ? visualRenderer.captureScreenshotDispatch === true : true),
    {
      evidence: requirementStatus.get('screenshots') || 'missing',
      rendererEvidence: visualEvidence,
      artifact: parityPath,
    },
  ),
  item(
    'video',
    'Duplicate Playwright video/screencast evidence.',
    requirementStatus.get('video') === 'pass' &&
      (visualRenderer ? visualRenderer.startScreencastDispatch === true : true),
    {
      evidence: requirementStatus.get('video') || 'missing',
      rendererEvidence: visualEvidence,
      artifact: parityPath,
    },
  ),
  item(
    'staging-product-qa',
    'Drive deployed staging product flows on draft.choir-ip.com.',
    requirementStatus.get('deployed-staging-qa') === 'pass' &&
      resultStatus.get('draft_prompt_bar_vtext_flow') === 'pass',
    {
      evidence: {
        deployedStagingQa: requirementStatus.get('deployed-staging-qa') || 'missing',
        draftPromptBarVTextFlow: resultStatus.get('draft_prompt_bar_vtext_flow') || 'missing',
      },
      artifact: parityPath,
    },
  ),
  item(
    'core-browser-control',
    'Cover core browser control needed by Playwright-style tests.',
    ['browser-navigation-dom-runtime', 'browser-input', 'request-interception'].every((id) => requirementStatus.get(id) === 'pass'),
    {
      evidence: Object.fromEntries(['browser-navigation-dom-runtime', 'browser-input', 'request-interception'].map((id) => [id, requirementStatus.get(id) || 'missing'])),
      artifact: parityPath,
    },
  ),
  item(
    'cli-surface',
    'Cover documented Obscura CLI fetch/scrape behavior.',
    requirementStatus.get('cli-surface') === 'pass',
    {
      evidence: requirementStatus.get('cli-surface') || 'missing',
      artifact: parityPath,
    },
  ),
  item(
    'source-surface-coverage',
    'Probe every implemented/accepted CDP method found in Obscura source.',
    sourceInventory.surfaceFullyProbed === true,
    {
      evidence: {
        implementedMethodCount: sourceInventory.implementedMethodCount,
        coveredMethodCount: sourceInventory.coveredMethodCount,
        partialMethodCount: sourceInventory.partialMethodCount,
        uncoveredMethodCount: sourceInventory.uncoveredMethodCount,
      },
      artifact: sourceInventoryPath,
    },
  ),
];

if (linuxSmoke) {
  const linuxEvidence = linuxSmokeEvidence(linuxSmoke);
  checklist.push(item(
    'linux-x86-64-smoke',
    'Run the Obscura release binary on a Linux x86_64 target comparable to Choir microVMs, including CLI fetch and CDP server startup.',
    linuxEvidence.pass,
    {
      evidence: linuxEvidence.evidence,
      artifact: linuxSmokePath,
    },
  ));
}

const achieved = parityBlock.achieved === true && checklist.every((entry) => entry.status === 'pass');
const report = {
  objective: 'Use Obscura to duplicate full Playwright functionality, including auth caching, screenshots, video, and broad surface coverage.',
  achieved,
  recommendedMode: achieved ? 'playwright-replacement' : 'extraction-and-browser-substrate-only',
  paritySummary: parityPath,
  sourceInventory: sourceInventoryPath,
  linuxSmoke: linuxSmokePath || null,
  obscuraSource: obscuraSourcePath || null,
  visualPrimitives: visualPrimitivesPath || null,
  externalVisualBridge: externalVisualBridgePath || null,
  lightVisualBridge: lightVisualBridgePath || null,
  productVisualBridge: productVisualBridgePath || null,
  fallbackEvidence,
  checklist,
  blockingItems: checklist.filter((entry) => entry.status !== 'pass').map((entry) => entry.id),
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = achieved ? 0 : 1;

function item(id, requirement, passed, details = {}) {
  return {
    id,
    requirement,
    status: passed ? 'pass' : 'fail',
    ...details,
  };
}

function readJSON(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing ${label}: ${filePath}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function linuxSmokeEvidence(smoke) {
  const remote = Array.isArray(smoke.checks)
    ? smoke.checks.find((check) => check.name === 'remote_obscura_smoke')
    : null;

  if (remote) {
    const pass = smoke.ok === true &&
      remote.status === 'pass' &&
      remote.platform === 'Linux' &&
      remote.arch === 'x86_64' &&
      remote.titleOK === true &&
      remote.serveOK === true;
    return {
      pass,
      evidence: {
        host: smoke.host || null,
        remoteDir: smoke.remoteDir || null,
        runnerPrefix: smoke.runnerPrefix || null,
        summary: smoke.summary,
        remoteSmoke: {
          status: remote.status,
          platform: remote.platform,
          arch: remote.arch,
          titleOK: remote.titleOK,
          serveOK: remote.serveOK,
        },
      },
    };
  }

  const checks = Array.isArray(smoke.checks)
    ? Object.fromEntries(smoke.checks.map((check) => [check.name, check.status]))
    : {};
  const pass = smoke.ok === true &&
    smoke.platform === 'linux' &&
    smoke.arch === 'x64' &&
    checks.obscura_binary_executable === 'pass' &&
    checks.fetch_example_title === 'pass' &&
    checks.fetch_text_dump === 'pass' &&
    checks.serve_json_version === 'pass';
  return {
    pass,
    evidence: {
      platform: smoke.platform,
      arch: smoke.arch,
      summary: smoke.summary,
      checks,
    },
  };
}

function inspectVisualRendererSupport(sourcePath) {
  const pageDomainPath = path.join(sourcePath, 'crates/obscura-cdp/src/domains/page.rs');
  if (!fs.existsSync(pageDomainPath)) {
    return {
      sourcePath,
      pageDomainPath,
      sourceFound: false,
      error: 'page domain source not found',
    };
  }

  const pageSource = fs.readFileSync(pageDomainPath, 'utf8');
  return {
    sourcePath,
    pageDomainPath,
    sourceFound: true,
    captureScreenshotDispatch: /"captureScreenshot"\s*=>/.test(pageSource),
    startScreencastDispatch: /"startScreencast"\s*=>/.test(pageSource),
    stopScreencastDispatch: /"stopScreencast"\s*=>/.test(pageSource),
    printToPDFDispatch: /"printToPDF"\s*=>/.test(pageSource),
    noVisualLayoutEngineMarker: /no visual layout engine/i.test(pageSource),
    screenshotCommentMarker: /screenshot/i.test(pageSource),
  };
}

function visualPrimitivesEvidence(summary) {
  const checkStatuses = Array.isArray(summary.checks)
    ? Object.fromEntries(summary.checks.map((check) => [check.name, check.status]))
    : {};
  return {
    summaryPath: visualPrimitivesPath,
    ok: summary.ok === true,
    visualScreenshotPolyfillViable: summary.visualScreenshotPolyfillViable === true,
    checks: checkStatuses,
  };
}

function externalVisualBridgeEvidence(summary) {
  const checkStatuses = Array.isArray(summary.checks)
    ? Object.fromEntries(summary.checks.map((check) => [check.name, check.status]))
    : {};
  return {
    summaryPath: externalVisualBridgePath,
    bridgeUsable: summary.bridgeUsable === true,
    nativeObscuraVisual: summary.nativeObscuraVisual === true,
    notAFullPlaywrightReplacement: summary.notAFullPlaywrightReplacement === true,
    externalRenderer: summary.externalRenderer || null,
    screenshotPath: summary.screenshotPath || null,
    videoPath: summary.videoPath || null,
    checks: checkStatuses,
    note: 'Fallback evidence only. This does not satisfy native Obscura screenshot/video parity.',
  };
}

function lightVisualBridgeEvidence(summary) {
  const checkStatuses = Array.isArray(summary.checks)
    ? Object.fromEntries(summary.checks.map((check) => [check.name, check.status]))
    : {};
  return {
    summaryPath: lightVisualBridgePath,
    bridgeUsable: summary.bridgeUsable === true,
    nativeObscuraVisual: summary.nativeObscuraVisual === true,
    notAFullPlaywrightReplacement: summary.notAFullPlaywrightReplacement === true,
    externalRenderer: summary.externalRenderer || null,
    screenshotPath: summary.screenshotPath || null,
    videoPath: summary.videoPath || null,
    checks: checkStatuses,
    limitations: summary.limitations || [],
    note: 'Light fallback evidence only. This avoids Playwright but still does not satisfy native Obscura screenshot/video parity.',
  };
}

function productVisualBridgeEvidence(summary) {
  const checkStatuses = Array.isArray(summary.checks)
    ? Object.fromEntries(summary.checks.map((check) => [check.name, check.status]))
    : {};
  return {
    summaryPath: productVisualBridgePath,
    bridgeUsable: summary.bridgeUsable === true,
    nativeObscuraVisual: summary.nativeObscuraVisual === true,
    notAFullPlaywrightReplacement: summary.notAFullPlaywrightReplacement === true,
    externalRenderer: summary.externalRenderer || null,
    screenshotPath: summary.screenshotPath || null,
    videoPath: summary.videoPath || null,
    productState: summary.productState || null,
    checks: checkStatuses,
    limitations: summary.limitations || [],
    note: 'Product fallback evidence only. Obscura drives the real product flow and exports DOM, but screenshot/video rendering is external and does not satisfy native Obscura visual parity.',
  };
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
