#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(args.source || process.env.OBSCURA_SOURCE || '/tmp/obscura-source');
const summaryPath = args.summary ? path.resolve(args.summary) : '';
const outDir = path.resolve(args.out || process.env.OBSCURA_INVENTORY_DIR || path.join('/tmp', 'obscura-test', `source-inventory-${Date.now()}`));
const outPath = path.join(outDir, 'summary.json');

const domainsDir = path.join(sourceRoot, 'crates', 'obscura-cdp', 'src', 'domains');
const dispatchPath = path.join(sourceRoot, 'crates', 'obscura-cdp', 'src', 'dispatch.rs');

fs.mkdirSync(outDir, { recursive: true });

const implementedMethods = discoverImplementedMethods(domainsDir, dispatchPath);
const auditSummary = summaryPath && fs.existsSync(summaryPath)
  ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  : null;
const resultStatuses = new Map((auditSummary?.results || []).map((result) => [result.name, result.status]));
const coverage = buildCoverage(implementedMethods, resultStatuses);

const report = {
  objective: 'Inventory Obscura CDP source surface and compare it with Choir audit probes',
  sourceRoot,
  summaryPath: auditSummary ? summaryPath : null,
  outDir,
  generatedAt: new Date().toISOString(),
  implementedMethodCount: implementedMethods.length,
  coveredMethodCount: coverage.methods.filter((method) => method.coverage === 'covered').length,
  partialMethodCount: coverage.methods.filter((method) => method.coverage === 'partial').length,
  uncoveredMethodCount: coverage.methods.filter((method) => method.coverage === 'uncovered').length,
  surfaceFullyProbed: coverage.methods.every((method) => method.coverage !== 'uncovered'),
  implementedDomains: [...new Set(implementedMethods.map((method) => method.domain))].sort(),
  methods: coverage.methods,
  criticalAbsentSurface: coverage.criticalAbsentSurface,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  summaryPath: outPath,
  implementedMethodCount: report.implementedMethodCount,
  coveredMethodCount: report.coveredMethodCount,
  partialMethodCount: report.partialMethodCount,
  uncoveredMethodCount: report.uncoveredMethodCount,
  surfaceFullyProbed: report.surfaceFullyProbed,
  criticalAbsentSurface: report.criticalAbsentSurface,
}, null, 2));

process.exit(report.surfaceFullyProbed ? 0 : 1);

function discoverImplementedMethods(domainDirectory, dispatchFile) {
  if (!fs.existsSync(domainDirectory)) {
    throw new Error(`Obscura domains directory not found: ${domainDirectory}`);
  }

  const methods = [];
  for (const fileName of fs.readdirSync(domainDirectory).sort()) {
    if (!fileName.endsWith('.rs') || fileName === 'mod.rs') continue;
    const domain = domainNameFromFile(fileName);
    const filePath = path.join(domainDirectory, fileName);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^ {8}"([A-Za-z][A-Za-z0-9]*)"\s*=>/);
      if (!match) continue;
      methods.push({
        domain,
        method: `${domain}.${match[1]}`,
        source: path.relative(sourceRoot, filePath),
        line: index + 1,
      });
    }
  }

  for (const domain of discoverNoopDomains(dispatchFile)) {
    methods.push({
      domain,
      method: `${domain}.enable`,
      source: path.relative(sourceRoot, dispatchFile),
      line: null,
      noOp: true,
    });
  }

  return methods.sort((left, right) => left.method.localeCompare(right.method));
}

function discoverNoopDomains(dispatchFile) {
  if (!fs.existsSync(dispatchFile)) return [];
  const source = fs.readFileSync(dispatchFile, 'utf8');
  const noopBlock = source.match(/"Emulation"\s*\| "Log"[\s\S]*?\| "Audits"\s*=>/);
  if (!noopBlock) return [];
  return [...noopBlock[0].matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]).sort();
}

function domainNameFromFile(fileName) {
  const stem = fileName.replace(/\.rs$/, '');
  if (stem === 'dom') return 'DOM';
  if (stem === 'lp') return 'LP';
  return stem[0].toUpperCase() + stem.slice(1);
}

function buildCoverage(methods, resultStatuses) {
  const map = new Map([
    ['Accessibility.enable', ['cdp_accessibility_get_full_ax_tree']],
    ['Accessibility.getFullAXTree', ['cdp_accessibility_get_full_ax_tree']],
    ['Audits.enable', ['cdp_noop_domains_enable']],
    ['Browser.getVersion', ['cdp_browser_get_version']],
    ['Browser.close', ['cdp_browser_close_noop']],
    ['Browser.getWindowBounds', ['cdp_browser_window_download_methods']],
    ['Browser.getWindowForTarget', ['cdp_browser_window_download_methods']],
    ['Browser.setDownloadBehavior', ['cdp_browser_window_download_methods']],
    ['Browser.setWindowBounds', ['cdp_browser_window_download_methods']],
    ['CSS.enable', ['cdp_noop_domains_enable']],
    ['Debugger.enable', ['cdp_noop_domains_enable']],
    ['DOM.describeNode', ['cdp_dom_describe_box_and_mutation_stubs']],
    ['DOM.enable', ['cdp_dom_query']],
    ['DOM.getBoxModel', ['cdp_dom_describe_box_and_mutation_stubs']],
    ['DOM.getDocument', ['cdp_dom_query']],
    ['DOM.getOuterHTML', ['cdp_dom_query']],
    ['DOM.querySelector', ['cdp_dom_query']],
    ['DOM.querySelectorAll', ['cdp_dom_query_all_resolve_node']],
    ['DOM.removeNode', ['cdp_dom_describe_box_and_mutation_stubs']],
    ['DOM.resolveNode', ['cdp_dom_query_all_resolve_node']],
    ['DOM.setAttributeValue', ['cdp_dom_describe_box_and_mutation_stubs']],
    ['Emulation.enable', ['cdp_noop_domains_enable']],
    ['Emulation.setDeviceMetricsOverride', ['cdp_noop_domains_enable']],
    ['Fetch.continueRequest', ['cdp_fetch_lifecycle_methods']],
    ['Fetch.disable', ['cdp_fetch_lifecycle_methods']],
    ['Fetch.enable', ['cdp_fetch_fulfill_request']],
    ['Fetch.failRequest', ['cdp_fetch_lifecycle_methods']],
    ['Fetch.fulfillRequest', ['cdp_fetch_fulfill_request']],
    ['Fetch.getResponseBody', ['cdp_fetch_lifecycle_methods']],
    ['HeapProfiler.enable', ['cdp_noop_domains_enable']],
    ['Input.dispatchKeyEvent', ['cdp_input_dispatch_key_event']],
    ['Input.dispatchMouseEvent', ['cdp_input_dispatch_mouse_event']],
    ['Input.dispatchTouchEvent', ['cdp_input_touch_ignore_stubs']],
    ['Input.setIgnoreInputEvents', ['cdp_input_touch_ignore_stubs']],
    ['Inspector.enable', ['cdp_noop_domains_enable']],
    ['LP.getMarkdown', ['cdp_lp_get_markdown']],
    ['Log.enable', ['cdp_noop_domains_enable']],
    ['Network.clearBrowserCookies', ['cdp_network_cookie_helpers']],
    ['Network.enable', ['cdp_network_request_response_events']],
    ['Network.getCookies', ['cdp_network_cookie_helpers']],
    ['Network.setCacheDisabled', ['cdp_network_cookie_helpers']],
    ['Network.setCookies', ['cdp_cookie_set_get', 'cdp_storage_set_get_delete_cookies']],
    ['Network.setExtraHTTPHeaders', ['cdp_network_headers_and_user_agent']],
    ['Network.setRequestInterception', ['cdp_network_cookie_helpers']],
    ['Network.setUserAgentOverride', ['cdp_network_headers_and_user_agent']],
    ['Overlay.enable', ['cdp_noop_domains_enable']],
    ['Page.addScriptToEvaluateOnNewDocument', ['cdp_page_add_script_on_new_document', 'cdp_page_layout_history_isolated_world_scripts']],
    ['Page.captureScreenshot', ['cdp_page_capture_screenshot', 'playwright_cdp_screenshot']],
    ['Page.createIsolatedWorld', ['cdp_page_layout_history_isolated_world_scripts']],
    ['Page.enable', ['cdp_navigation_runtime_eval']],
    ['Page.getFrameTree', ['cdp_page_get_frame_tree']],
    ['Page.getLayoutMetrics', ['cdp_page_layout_history_isolated_world_scripts']],
    ['Page.getNavigationHistory', ['cdp_page_layout_history_isolated_world_scripts']],
    ['Page.navigate', ['cdp_navigation_runtime_eval']],
    ['Page.printToPDF', ['cdp_page_print_to_pdf']],
    ['Page.removeScriptToEvaluateOnNewDocument', ['cdp_page_layout_history_isolated_world_scripts']],
    ['Page.screencastFrameAck', ['playwright_cdp_video_nonblank']],
    ['Page.setInterceptFileChooserDialog', ['cdp_page_layout_history_isolated_world_scripts']],
    ['Page.setLifecycleEventsEnabled', ['cdp_page_lifecycle_events']],
    ['Page.startScreencast', ['cdp_screencast_video_primitives', 'playwright_cdp_video_nonblank']],
    ['Page.stopScreencast', ['cdp_screencast_video_primitives', 'playwright_cdp_video_nonblank']],
    ['Performance.enable', ['cdp_noop_domains_enable']],
    ['Profiler.enable', ['cdp_noop_domains_enable']],
    ['Runtime.addBinding', ['cdp_runtime_add_binding']],
    ['Runtime.callFunctionOn', ['cdp_runtime_call_function_get_properties']],
    ['Runtime.discardConsoleEntries', ['cdp_runtime_release_exception_helpers']],
    ['Runtime.enable', ['cdp_navigation_runtime_eval']],
    ['Runtime.evaluate', ['cdp_navigation_runtime_eval']],
    ['Runtime.getExceptionDetails', ['cdp_runtime_release_exception_helpers']],
    ['Runtime.getProperties', ['cdp_runtime_call_function_get_properties']],
    ['Runtime.releaseObject', ['cdp_runtime_release_exception_helpers']],
    ['Runtime.releaseObjectGroup', ['cdp_runtime_release_exception_helpers']],
    ['Runtime.runIfWaitingForDebugger', ['cdp_runtime_release_exception_helpers']],
    ['Schema.getDomains', ['cdp_schema_get_domains']],
    ['Security.enable', ['cdp_noop_domains_enable']],
    ['ServiceWorker.enable', ['cdp_noop_domains_enable']],
    ['Storage.deleteCookies', ['cdp_storage_set_get_delete_cookies']],
    ['Storage.getCookies', ['cdp_storage_set_get_delete_cookies']],
    ['Storage.setCookies', ['cdp_storage_set_get_delete_cookies']],
    ['Target.attachToBrowserTarget', ['cdp_target_metadata_autodiscovery']],
    ['Target.attachToTarget', ['cdp_target_metadata_autodiscovery']],
    ['Target.closeTarget', ['cdp_target_browser_context_create_dispose']],
    ['Target.createBrowserContext', ['cdp_target_browser_context_create_dispose']],
    ['Target.createTarget', ['cdp_target_browser_context_create_dispose']],
    ['Target.disposeBrowserContext', ['cdp_target_browser_context_create_dispose']],
    ['Target.getBrowserContexts', ['cdp_target_metadata_autodiscovery']],
    ['Target.getTargetInfo', ['cdp_target_metadata_autodiscovery']],
    ['Target.getTargets', ['cdp_target_get_targets']],
    ['Target.setAutoAttach', ['cdp_target_metadata_autodiscovery']],
    ['Target.setDiscoverTargets', ['cdp_target_metadata_autodiscovery']],
    ['WebAuthn.enable', ['cdp_webauthn_domain']],
  ]);

  const methodCoverage = methods.map((method) => {
    const checks = map.get(method.method) || [];
    const statuses = checks.map((check) => ({ check, status: resultStatuses.get(check) || 'missing' }));
    let coverage = 'uncovered';
    if (statuses.length > 0 && statuses.every((status) => status.status === 'pass')) coverage = 'covered';
    if (statuses.some((status) => ['pass', 'fail'].includes(status.status)) && coverage !== 'covered') coverage = 'partial';
    return {
      ...method,
      coverage,
      checks: statuses,
    };
  });

  return {
    methods: methodCoverage,
    criticalAbsentSurface: [
      {
        method: 'Page.captureScreenshot',
        requirement: 'Playwright screenshots',
        observedCheck: resultStatuses.get('cdp_page_capture_screenshot') || 'missing',
      },
      {
        method: 'Page.startScreencast',
        requirement: 'Playwright video/screencast',
        observedCheck: resultStatuses.get('cdp_screencast_video_primitives') || 'missing',
      },
      {
        method: 'WebAuthn.enable',
        requirement: 'Passkey auth setup',
        observedCheck: resultStatuses.get('cdp_webauthn_domain') || 'missing',
      },
      {
        method: 'Schema.getDomains',
        requirement: 'CDP self-inventory',
        observedCheck: resultStatuses.get('cdp_schema_get_domains') || 'missing',
      },
    ],
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
