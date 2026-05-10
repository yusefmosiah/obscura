#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const obscuraPath = args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-test/obscura';
const baseURL = args.baseURL || process.env.CHOIR_DEPLOYED_BASE_URL || 'https://draft.choir-ip.com';
const outDir = path.resolve(
  args.out || process.env.OBSCURA_AUDIT_DIR || `test-results/obscura-capability-audit-${Date.now()}`,
);
let authStatePath = args.authState || process.env.OBSCURA_AUTH_STATE || '';
const createAuthState = args.createAuthState || process.env.OBSCURA_CREATE_AUTH_STATE || false;
const runProductFlow = Boolean(args.productFlow || process.env.OBSCURA_RUN_PRODUCT_FLOW);

fs.mkdirSync(outDir, { recursive: true });

const results = [];

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function record(name, status, details = {}) {
  results.push({ name, status, ...details });
  const suffix = details.error || details.note || '';
  console.log(`${status.toUpperCase()} ${name}${suffix ? `: ${suffix}` : ''}`);
}

function runCommand(argv, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command: argv.join(' '),
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message || result.error) : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    elapsed_ms: Date.now() - startedAt,
  };
}

async function waitForJSON(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Keep waiting.
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

class CDPClient {
  constructor(url) {
    this.url = url;
    this.nextID = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message || 'CDP error'} ${JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result || {});
        }
        return;
      }
      this.events.push(message);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionID = '', timeoutMs = 20_000) {
    const id = this.nextID;
    this.nextID += 1;
    const payload = { id, method, params };
    if (sessionID) payload.sessionId = sessionID;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async waitForEvent(method, predicate = () => true, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    while (Date.now() < deadline) {
      while (cursor < this.events.length) {
        const event = this.events[cursor];
        cursor += 1;
        if (event.method === method && predicate(event)) return event;
      }
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${method}`);
  }

  close() {
    this.ws?.close();
  }
}

async function withObscuraServer(fn, options = {}) {
  const port = 19_000 + Math.floor(Math.random() * 5000);
  const logPath = path.join(outDir, options.logName || 'obscura-serve.log');
  const log = fs.openSync(logPath, 'w');
  const proc = spawn(obscuraPath, [
    'serve',
    '--port',
    String(port),
    '--workers',
    String(options.workers || 1),
    ...(options.args || []),
  ], {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      OBSCURA_ALLOW_PRIVATE_NETWORK: '1',
    },
  });

  try {
    const version = await waitForJSON(`http://127.0.0.1:${port}/json/version`);
    return await fn({ port, version, logPath });
  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    if (!proc.killed) proc.kill('SIGKILL');
    fs.closeSync(log);
  }
}

async function setupCDPPage(version) {
  const cdp = new CDPClient(version.webSocketDebuggerUrl);
  await cdp.open();
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionID = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionID);
  await cdp.send('Runtime.enable', {}, sessionID);
  await cdp.send('Network.enable', {}, sessionID);
  return { cdp, sessionID, targetID: target.targetId };
}

async function runCDPTest(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, 'fail', { error: String(error.message || error) });
  }
}

async function withLocalHTTPServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function analyzeFirstVideoFrame(videoPath) {
  const ffmpeg = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ], {
    encoding: null,
    maxBuffer: 5 * 1024 * 1024,
  });

  if (ffmpeg.error) {
    return { ok: false, error: ffmpeg.error.message };
  }
  if (ffmpeg.status !== 0) {
    return {
      ok: false,
      error: String(ffmpeg.stderr || '').slice(0, 500) || `ffmpeg exited ${ffmpeg.status}`,
    };
  }

  const bytes = ffmpeg.stdout || Buffer.alloc(0);
  if (bytes.length === 0) {
    return { ok: false, error: 'ffmpeg produced no frame bytes' };
  }

  let min = 255;
  let max = 0;
  let sum = 0;
  const unique = new Set();
  for (const value of bytes) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    if (unique.size < 1000) unique.add(value);
  }

  return {
    ok: true,
    bytes: bytes.length,
    avg: sum / bytes.length,
    min,
    max,
    uniqueSample: unique.size,
    visuallyNonBlank: (max - min) > 10 && unique.size > 10,
  };
}

async function runPlaywrightOverCDPTests(version) {
  const { chromium } = await import('@playwright/test');

  async function connect() {
    return chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 10_000 });
  }

  await runCDPTest('playwright_cdp_connect_navigate_eval', async () => {
    const browser = await connect();
    try {
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 20_000 });
      const title = await page.evaluate(() => document.title);
      record('playwright_cdp_connect_navigate_eval', title === 'Example Domain' ? 'pass' : 'fail', {
        title,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  });

  await runCDPTest('playwright_cdp_screenshot', async () => {
    const browser = await connect();
    const screenshotPath = path.join(outDir, 'playwright-over-obscura-screenshot.png');
    try {
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 20_000 });
      await page.screenshot({ path: screenshotPath, timeout: 10_000 });
      record('playwright_cdp_screenshot', fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 1000 ? 'pass' : 'fail', {
        screenshotPath,
        bytes: fs.existsSync(screenshotPath) ? fs.statSync(screenshotPath).size : 0,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  });

  await runCDPTest('playwright_cdp_video_nonblank', async () => {
    const browser = await connect();
    const videoDir = path.join(outDir, 'playwright-over-obscura-video');
    fs.rmSync(videoDir, { recursive: true, force: true });
    fs.mkdirSync(videoDir, { recursive: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 640, height: 480 },
        recordVideo: { dir: videoDir, size: { width: 640, height: 480 } },
      });
      const page = await context.newPage();
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 20_000 });
      await page.evaluate(() => {
        document.body.style.background = 'rgb(0, 128, 0)';
        document.body.innerHTML = '<main style="font-size:72px;color:white;padding:64px">OBSCURA VIDEO PROBE</main>';
      });
      await sleep(1000);
      const video = page.video?.();
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      const videoPath = video ? await video.path().catch(() => '') : '';
      const fallbackPath = fs.existsSync(videoDir)
        ? fs.readdirSync(videoDir).find((name) => name.endsWith('.webm'))
        : '';
      const resolvedPath = videoPath || (fallbackPath ? path.join(videoDir, fallbackPath) : '');
      const frame = resolvedPath && fs.existsSync(resolvedPath)
        ? analyzeFirstVideoFrame(resolvedPath)
        : { ok: false, error: 'no webm produced' };
      record('playwright_cdp_video_nonblank', frame.ok && frame.visuallyNonBlank ? 'pass' : 'fail', {
        videoPath: resolvedPath || null,
        bytes: resolvedPath && fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0,
        frame,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

function readAuthCookies() {
  if (!authStatePath) return [];
  const state = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
  return (state.cookies || []).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
}

function refreshAuthState(reason) {
  if (!authStatePath) {
    return {
      refreshed: false,
      reason,
      error: 'no auth state path configured',
    };
  }
  if (!fs.existsSync(path.resolve('scripts/setup-auth-state.mjs'))) {
    return {
      refreshed: false,
      reason,
      error: 'scripts/setup-auth-state.mjs not found from current working directory',
    };
  }

  const result = runCommand([
    process.execPath,
    'scripts/setup-auth-state.mjs',
    '--base-url',
    baseURL,
    '--out',
    authStatePath,
    '--force',
  ], { timeout: 120_000 });
  return {
    refreshed: result.status === 0,
    reason,
    command: result.command,
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout_tail: result.stdout.slice(-2000),
    stderr_tail: result.stderr.slice(-2000),
  };
}

async function seedAuthCookies(cdp, sessionID) {
  const cookies = readAuthCookies();
  if (cookies.length === 0) return { cookieCount: 0 };
  await cdp.send('Network.clearBrowserCookies', {}, sessionID).catch(() => {});
  await cdp.send('Network.setCookies', { cookies }, sessionID);
  return { cookieCount: cookies.length };
}

async function createPlaywrightAuthState() {
  const outputPath = typeof createAuthState === 'string'
    ? path.resolve(createAuthState)
    : path.join(outDir, 'playwright-auth-state.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const [{ chromium }, webauthn, auth] = await Promise.all([
    import('@playwright/test'),
    import(pathToFileURL(path.resolve('tests/helpers/webauthn.js')).href),
    import(pathToFileURL(path.resolve('tests/helpers/auth.js')).href),
  ]);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const { client, authenticatorId } = await webauthn.setupVirtualAuthenticator(page);
  const email = `obscura-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await auth.registerPasskey(page, email, baseURL);
    await page.locator('[data-desktop]').waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
    await context.storageState({ path: outputPath });
    authStatePath = outputPath;
    record('playwright_create_auth_state', 'pass', { email, authStatePath });
  } catch (error) {
    record('playwright_create_auth_state', 'fail', { email, error: String(error.message || error) });
  } finally {
    await webauthn.removeVirtualAuthenticator(client, authenticatorId).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const metadata = {
    objective: 'Obscura capability audit for Playwright parity, auth caching, screenshots, video, and browser surface',
    obscuraPath,
    baseURL,
    authStatePath: authStatePath || null,
    outDir,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date().toISOString(),
  };

  if (createAuthState) {
    await createPlaywrightAuthState();
    metadata.authStatePath = authStatePath || null;
  }

  if (authStatePath) {
    const exists = fs.existsSync(authStatePath);
    record('auth_state_file_present', exists ? 'pass' : 'fail', {
      authStatePath,
      note: exists ? 'using supplied or generated Playwright storageState' : 'auth-state path does not exist',
    });
  }

  if (!fs.existsSync(obscuraPath)) {
    record('obscura_binary_present', 'fail', { path: obscuraPath });
    return finish(metadata, 1);
  }
  record('obscura_binary_present', 'pass', {
    path: obscuraPath,
    size: fs.statSync(obscuraPath).size,
  });

  const help = runCommand([obscuraPath, '--help'], { timeout: 10_000 });
  record('cli_help', help.status === 0 ? 'pass' : 'fail', {
    elapsed_ms: help.elapsed_ms,
    stdout_head: help.stdout.slice(0, 500),
    stderr_head: help.stderr.slice(0, 500),
  });

  for (const command of ['fetch', 'serve', 'scrape']) {
    const commandHelp = runCommand([obscuraPath, command, '--help'], { timeout: 10_000 });
    record(`cli_${command}_help`, commandHelp.status === 0 ? 'pass' : 'fail', {
      elapsed_ms: commandHelp.elapsed_ms,
      stdout_head: commandHelp.stdout.slice(0, 800),
      stderr_head: commandHelp.stderr.slice(0, 500),
    });
  }

  const fetchTitle = runCommand([obscuraPath, 'fetch', 'https://example.com', '--eval', 'document.title']);
  record('cli_fetch_eval_title', fetchTitle.status === 0 && /Example Domain/.test(fetchTitle.stdout) ? 'pass' : 'fail', {
    elapsed_ms: fetchTitle.elapsed_ms,
    status_code: fetchTitle.status,
    signal: fetchTitle.signal,
    stdout_head: fetchTitle.stdout.slice(0, 500),
    stderr_head: fetchTitle.stderr.slice(0, 500),
  });

  const fetchText = runCommand([obscuraPath, 'fetch', 'https://example.com', '--dump', 'text', '--quiet']);
  record('cli_fetch_dump_text_stdout', fetchText.status === 0 && /Example Domain/.test(fetchText.stdout) ? 'pass' : 'fail', {
    elapsed_ms: fetchText.elapsed_ms,
    bytes: Buffer.byteLength(fetchText.stdout),
    stdout_head: fetchText.stdout.slice(0, 500),
    stderr_head: fetchText.stderr.slice(0, 500),
  });

  const fetchOutput = runCommand([
    obscuraPath,
    'fetch',
    'https://example.com',
    '--dump',
    'text',
    '--output',
    path.join(outDir, 'example-text.txt'),
  ]);
  record('cli_fetch_output_file_flag', fetchOutput.status === 0 ? 'pass' : 'fail', {
    note: fetchOutput.status === 0 ? '' : 'README-style --output is not accepted by the tested binary',
    elapsed_ms: fetchOutput.elapsed_ms,
    status_code: fetchOutput.status,
    stderr_head: fetchOutput.stderr.slice(0, 500),
  });

  const fetchShortOutput = runCommand([
    obscuraPath,
    'fetch',
    'https://example.com',
    '--dump',
    'text',
    '-o',
    path.join(outDir, 'example-short-output.txt'),
  ]);
  record('cli_fetch_output_short_flag', fetchShortOutput.status === 0 ? 'pass' : 'fail', {
    note: fetchShortOutput.status === 0 ? '' : 'short -o output flag is not accepted by the tested binary',
    elapsed_ms: fetchShortOutput.elapsed_ms,
    status_code: fetchShortOutput.status,
    stderr_head: fetchShortOutput.stderr.slice(0, 500),
  });

  const fetchUserAgent = runCommand([
    obscuraPath,
    'fetch',
    'https://httpbin.org/user-agent',
    '--user-agent',
    'ChoirObscuraFetch/1.0',
    '--dump',
    'text',
    '--quiet',
  ]);
  record('cli_fetch_user_agent_flag', fetchUserAgent.status === 0 && /ChoirObscuraFetch\/1\.0/.test(fetchUserAgent.stdout) ? 'pass' : 'fail', {
    elapsed_ms: fetchUserAgent.elapsed_ms,
    status_code: fetchUserAgent.status,
    stdout_head: fetchUserAgent.stdout.slice(0, 500),
    stderr_head: fetchUserAgent.stderr.slice(0, 500),
  });

  const globalFetchUserAgent = runCommand([
    obscuraPath,
    '--user-agent',
    'ChoirObscuraGlobal/1.0',
    'fetch',
    'https://httpbin.org/user-agent',
    '--dump',
    'text',
    '--quiet',
  ]);
  record('cli_global_user_agent_applies_to_fetch', globalFetchUserAgent.status === 0 && /ChoirObscuraGlobal\/1\.0/.test(globalFetchUserAgent.stdout) ? 'pass' : 'fail', {
    note: globalFetchUserAgent.status === 0 ? 'top-level --user-agent is accepted but does not affect fetch in the tested binary' : '',
    elapsed_ms: globalFetchUserAgent.elapsed_ms,
    status_code: globalFetchUserAgent.status,
    stdout_head: globalFetchUserAgent.stdout.slice(0, 500),
    stderr_head: globalFetchUserAgent.stderr.slice(0, 500),
  });

  const serveObeyRobots = runCommand([obscuraPath, 'serve', '--obey-robots', '--help']);
  record('cli_serve_obey_robots_flag', serveObeyRobots.status === 0 ? 'pass' : 'fail', {
    note: serveObeyRobots.status === 0 ? '' : 'README-style serve --obey-robots is rejected; the tested binary exposes --obey-robots only as a top-level flag',
    elapsed_ms: serveObeyRobots.elapsed_ms,
    status_code: serveObeyRobots.status,
    stdout_head: serveObeyRobots.stdout.slice(0, 500),
    stderr_head: serveObeyRobots.stderr.slice(0, 500),
  });

  const fetchLinks = runCommand([obscuraPath, 'fetch', 'https://example.com', '--dump', 'links']);
  record('cli_fetch_dump_links', fetchLinks.status === 0 && /iana\.org/.test(fetchLinks.stdout) ? 'pass' : 'fail', {
    elapsed_ms: fetchLinks.elapsed_ms,
    stdout_head: fetchLinks.stdout.slice(0, 500),
  });

  const fetchSelector = runCommand([
    obscuraPath,
    'fetch',
    'https://example.com',
    '--selector',
    'h1',
    '--eval',
    'document.querySelector("h1")?.textContent',
  ]);
  record('cli_fetch_selector_eval', fetchSelector.status === 0 && /Example Domain/.test(fetchSelector.stdout) ? 'pass' : 'fail', {
    elapsed_ms: fetchSelector.elapsed_ms,
    stdout_head: fetchSelector.stdout.slice(0, 500),
  });

  const fetchStealth = runCommand([
    obscuraPath,
    'fetch',
    'https://example.com',
    '--stealth',
    '--eval',
    'navigator.webdriver === undefined',
  ]);
  record('cli_fetch_stealth_eval', fetchStealth.status === 0 ? 'pass' : 'fail', {
    elapsed_ms: fetchStealth.elapsed_ms,
    stdout_head: fetchStealth.stdout.slice(0, 500),
    stderr_head: fetchStealth.stderr.slice(0, 500),
  });

  const fetchNetworkIdle = runCommand([
    obscuraPath,
    'fetch',
    'https://example.com',
    '--wait-until',
    'networkidle0',
    '--eval',
    'document.title',
  ]);
  record('cli_fetch_wait_until_networkidle0', fetchNetworkIdle.status === 0 && /Example Domain/.test(fetchNetworkIdle.stdout) ? 'pass' : 'fail', {
    elapsed_ms: fetchNetworkIdle.elapsed_ms,
    stdout_head: fetchNetworkIdle.stdout.slice(0, 500),
    stderr_head: fetchNetworkIdle.stderr.slice(0, 500),
  });

  const scrape = runCommand([
    obscuraPath,
    'scrape',
    'https://example.com',
    'https://www.iana.org/domains/reserved',
    '--concurrency',
    '2',
    '--eval',
    'document.title',
    '--format',
    'json',
  ], { timeout: 45_000 });
  record('cli_scrape_parallel_eval', scrape.status === 0 && /Example Domain|IANA/.test(scrape.stdout) ? 'pass' : 'fail', {
    elapsed_ms: scrape.elapsed_ms,
    stdout_head: scrape.stdout.slice(0, 1000),
    stderr_head: scrape.stderr.slice(0, 500),
  });

  await withObscuraServer(async ({ version, logPath }) => {
    record('cdp_json_version', 'pass', { version, logPath });
    const serverURL = new URL(version.webSocketDebuggerUrl);
    const serverOrigin = `http://${serverURL.host}`;
    const jsonList = await waitForJSON(`${serverOrigin}/json/list`);
    const jsonProtocol = await waitForJSON(`${serverOrigin}/json/protocol`);
    fs.writeFileSync(path.join(outDir, 'obscura-http-surface.json'), `${JSON.stringify({
      version,
      list: jsonList,
      protocol: jsonProtocol,
    }, null, 2)}\n`, 'utf8');
    record('cdp_http_json_list', Array.isArray(jsonList) ? 'pass' : 'fail', {
      target_count: Array.isArray(jsonList) ? jsonList.length : 0,
    });
    record('cdp_http_json_protocol', jsonProtocol?.version?.major ? 'pass' : 'fail', {
      protocol: jsonProtocol,
    });

    const { cdp, sessionID, targetID } = await setupCDPPage(version);
    try {
      await runCDPTest('cdp_browser_get_version', async () => {
        const browserVersion = await cdp.send('Browser.getVersion');
        record('cdp_browser_get_version', browserVersion.product || browserVersion.userAgent ? 'pass' : 'fail', browserVersion);
      });

      await runCDPTest('cdp_browser_window_download_methods', async () => {
        const windowForTarget = await cdp.send('Browser.getWindowForTarget', { targetId: targetID });
        const bounds = await cdp.send('Browser.getWindowBounds', { windowId: windowForTarget.windowId || 1 });
        await cdp.send('Browser.setWindowBounds', {
          windowId: windowForTarget.windowId || 1,
          bounds: { width: 1024, height: 768 },
        });
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });
        record('cdp_browser_window_download_methods', windowForTarget.windowId && (windowForTarget.bounds?.width || bounds.bounds?.width) ? 'pass' : 'fail', {
          windowForTarget,
          bounds,
          note: bounds.bounds?.width ? '' : 'Browser.getWindowBounds returned an empty object; Browser.getWindowForTarget returned static bounds',
        });
      });

      await runCDPTest('cdp_target_get_targets', async () => {
        const targets = await cdp.send('Target.getTargets');
        record('cdp_target_get_targets', Array.isArray(targets.targetInfos) ? 'pass' : 'fail', {
          target_count: targets.targetInfos?.length || 0,
        });
      });

      await runCDPTest('cdp_target_metadata_autodiscovery', async () => {
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        await cdp.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        const browserSession = await cdp.send('Target.attachToBrowserTarget');
        const contexts = await cdp.send('Target.getBrowserContexts');
        const info = await cdp.send('Target.getTargetInfo', { targetId: targetID });
        record('cdp_target_metadata_autodiscovery', browserSession.sessionId && Array.isArray(contexts.browserContextIds) && info.targetInfo?.targetId === targetID ? 'pass' : 'fail', {
          browserSession,
          contexts,
          info,
        });
      });

      await runCDPTest('cdp_target_browser_context_create_dispose', async () => {
        const created = await cdp.send('Target.createBrowserContext');
        const child = await cdp.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: created.browserContextId,
        });
        const closed = await cdp.send('Target.closeTarget', { targetId: child.targetId });
        await cdp.send('Target.disposeBrowserContext', { browserContextId: created.browserContextId });
        record('cdp_target_browser_context_create_dispose', created.browserContextId && child.targetId && closed.success !== false ? 'pass' : 'fail', {
          browserContextId: created.browserContextId,
          targetId: child.targetId,
          closeResult: closed,
        });
      });

      await runCDPTest('cdp_schema_get_domains', async () => {
        const schema = await cdp.send('Schema.getDomains');
        record('cdp_schema_get_domains', Array.isArray(schema.domains) ? 'pass' : 'fail', {
          domain_count: schema.domains?.length || 0,
          domains: (schema.domains || []).map((domain) => domain.name).slice(0, 50),
        });
      });

      await runCDPTest('cdp_noop_domains_enable', async () => {
        const methods = [
          'Audits.enable',
          'CSS.enable',
          'Debugger.enable',
          'Emulation.setDeviceMetricsOverride',
          'HeapProfiler.enable',
          'Inspector.enable',
          'Log.enable',
          'Overlay.enable',
          'Performance.enable',
          'Profiler.enable',
          'Security.enable',
          'ServiceWorker.enable',
        ];
        const outcomes = [];
        for (const method of methods) {
          try {
            await cdp.send(method, {}, sessionID);
            outcomes.push({ method, status: 'pass' });
          } catch (error) {
            outcomes.push({ method, status: 'fail', error: String(error.message || error) });
          }
        }
        record('cdp_noop_domains_enable', outcomes.every((outcome) => outcome.status === 'pass') ? 'pass' : 'fail', {
          outcomes,
        });
      });

      await runCDPTest('cdp_navigation_runtime_eval', async () => {
        await cdp.send('Page.navigate', { url: 'https://example.com' }, sessionID);
        await sleep(2000);
        const title = await cdp.send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        }, sessionID);
        const body = await cdp.send('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText',
          returnByValue: true,
        }, sessionID);
        record(
          'cdp_navigation_runtime_eval',
          /Example Domain/.test(title.result?.value || '') && /Example Domain/.test(body.result?.value || '') ? 'pass' : 'fail',
          { title: title.result?.value, body_head: String(body.result?.value || '').slice(0, 200) },
        );
      });

      await runCDPTest('cdp_network_request_response_events', async () => {
        cdp.events = [];
        await cdp.send('Page.navigate', { url: 'https://example.com?network-events=1' }, sessionID);
        await sleep(3000);
        const requests = cdp.events.filter((event) => event.method === 'Network.requestWillBeSent');
        const responses = cdp.events.filter((event) => event.method === 'Network.responseReceived');
        record('cdp_network_request_response_events', requests.length > 0 && responses.length > 0 ? 'pass' : 'fail', {
          request_count: requests.length,
          response_count: responses.length,
          request_urls: requests.map((event) => event.params?.request?.url).filter(Boolean).slice(0, 10),
          response_urls: responses.map((event) => event.params?.response?.url).filter(Boolean).slice(0, 10),
        });
      });

      await runCDPTest('cdp_runtime_console_events', async () => {
        cdp.events = [];
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            console.log('choir-obscura-console-log');
            console.error('choir-obscura-console-error');
            return true;
          })()`,
          returnByValue: true,
        }, sessionID);
        await sleep(500);
        const consoleEvents = cdp.events.filter((event) => event.method === 'Runtime.consoleAPICalled');
        const eventText = JSON.stringify(consoleEvents);
        record('cdp_runtime_console_events', /choir-obscura-console-log/.test(eventText) && /choir-obscura-console-error/.test(eventText) ? 'pass' : 'fail', {
          event_count: consoleEvents.length,
          events: consoleEvents.slice(0, 5),
        });
      });

      await runCDPTest('cdp_inline_module_script_execution', async () => {
        const modulePath = path.join(outDir, 'module-probe.html');
        const html = '<!doctype html><div id="app">empty</div><script type="module">document.querySelector("#app").textContent = "module ok"; window.__choirModuleRan = true;</script>';
        fs.writeFileSync(modulePath, html, 'utf8');
        await cdp.send('Page.navigate', {
          url: pathToFileURL(modulePath).href,
        }, sessionID);
        await sleep(2000);
        const result = await cdp.send('Runtime.evaluate', {
          expression: `({
            moduleRan: window.__choirModuleRan === true,
            appText: document.querySelector('#app')?.textContent || '',
            bodyText: document.body?.innerText || ''
          })`,
          returnByValue: true,
        }, sessionID);
        const value = result.result?.value || {};
        record('cdp_inline_module_script_execution', value.moduleRan && value.appText === 'module ok' ? 'pass' : 'fail', value);
      });

      await runCDPTest('cdp_external_module_script_execution', async () => {
        const modulePath = path.join(outDir, 'external-module-probe.html');
        const moduleSource = [
          'document.querySelector("#app").textContent = "external module ok";',
          'window.__choirExternalModuleRan = true;',
        ].join(' ');
        const encodedModule = Buffer.from(moduleSource).toString('base64');
        const moduleURL = `https://httpbin.org/base64/${encodeURIComponent(encodedModule)}`;
        const html = `<!doctype html><div id="app">empty</div><script type="module" src="${moduleURL}"></script>`;
        fs.writeFileSync(modulePath, html, 'utf8');
        await cdp.send('Page.navigate', {
          url: pathToFileURL(modulePath).href,
        }, sessionID);
        await sleep(2000);
        const result = await cdp.send('Runtime.evaluate', {
          expression: `({
            moduleRan: window.__choirExternalModuleRan === true,
            appText: document.querySelector('#app')?.textContent || '',
            bodyText: document.body?.innerText || ''
          })`,
          returnByValue: true,
        }, sessionID);
        const value = result.result?.value || {};
        record('cdp_external_module_script_execution', value.moduleRan && value.appText === 'external module ok' ? 'pass' : 'fail', {
          ...value,
          moduleURL,
          note: 'External module scripts must execute for Vite/Svelte bundles; upstream Obscura logs external modules as loaded while evaluating empty root module code.',
        });
      });

      await runCDPTest('cdp_accessibility_get_full_ax_tree', async () => {
        await cdp.send('Accessibility.enable', {}, sessionID);
        await cdp.send('Page.navigate', { url: 'https://example.com?accessibility=1' }, sessionID);
        await sleep(2000);
        const tree = await cdp.send('Accessibility.getFullAXTree', {}, sessionID);
        const nodes = tree.nodes || [];
        const roles = nodes.map((node) => node.role?.value || node.role).filter(Boolean).slice(0, 30);
        const names = nodes.map((node) => node.name?.value || node.name).filter(Boolean).slice(0, 30);
        record('cdp_accessibility_get_full_ax_tree', nodes.length > 0 ? 'pass' : 'fail', {
          node_count: nodes.length,
          roles,
          names,
        });
      });

      await runCDPTest('cdp_page_get_frame_tree', async () => {
        const frameTree = await cdp.send('Page.getFrameTree', {}, sessionID);
        record('cdp_page_get_frame_tree', !!frameTree.frameTree?.frame?.id ? 'pass' : 'fail', {
          frameTree,
        });
      });

      await runCDPTest('cdp_page_layout_history_isolated_world_scripts', async () => {
        const frameTree = await cdp.send('Page.getFrameTree', {}, sessionID);
        const frameID = frameTree.frameTree?.frame?.id;
        const isolated = await cdp.send('Page.createIsolatedWorld', {
          frameId: frameID,
          worldName: 'choirAuditWorld',
          grantUniveralAccess: true,
        }, sessionID);
        const script = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: 'window.__removedPreloadProbe = 1;',
        }, sessionID);
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: script.identifier,
        }, sessionID);
        await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionID);
        const layout = await cdp.send('Page.getLayoutMetrics', {}, sessionID);
        const history = await cdp.send('Page.getNavigationHistory', {}, sessionID);
        record('cdp_page_layout_history_isolated_world_scripts', isolated.executionContextId && layout.layoutViewport?.clientWidth && Array.isArray(history.entries) ? 'pass' : 'fail', {
          isolated,
          layout,
          history,
        });
      });

      await runCDPTest('cdp_page_lifecycle_events', async () => {
        cdp.events = [];
        await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionID);
        await cdp.send('Page.navigate', { url: 'https://example.com?lifecycle=1' }, sessionID);
        await sleep(3000);
        const lifecycleEvents = cdp.events.filter((event) => event.method === 'Page.lifecycleEvent');
        record('cdp_page_lifecycle_events', lifecycleEvents.length > 0 ? 'pass' : 'fail', {
          event_count: lifecycleEvents.length,
          event_names: lifecycleEvents.map((event) => event.params?.name).filter(Boolean).slice(0, 20),
        });
      });

      await runCDPTest('cdp_page_add_script_on_new_document', async () => {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: 'window.__obscuraPreload = 42;',
        }, sessionID);
        await cdp.send('Page.navigate', { url: 'https://example.com?preload=1' }, sessionID);
        await sleep(2000);
        const value = await cdp.send('Runtime.evaluate', {
          expression: 'window.__obscuraPreload',
          returnByValue: true,
        }, sessionID);
        record('cdp_page_add_script_on_new_document', value.result?.value === 42 ? 'pass' : 'fail', {
          value: value.result?.value,
        });
      });

      await runCDPTest('cdp_dom_query', async () => {
        const document = await cdp.send('DOM.getDocument', { depth: 1 }, sessionID);
        const h1 = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'h1' }, sessionID);
        const html = await cdp.send('DOM.getOuterHTML', { nodeId: h1.nodeId }, sessionID);
        record('cdp_dom_query', /Example Domain/.test(html.outerHTML || '') ? 'pass' : 'fail', {
          outerHTML: html.outerHTML,
        });
      });

      await runCDPTest('cdp_dom_query_all_resolve_node', async () => {
        await cdp.send('Page.navigate', { url: 'https://example.com' }, sessionID);
        await sleep(2000);
        const document = await cdp.send('DOM.getDocument', { depth: 2 }, sessionID);
        const paragraphs = await cdp.send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector: 'p' }, sessionID);
        const resolved = await cdp.send('DOM.resolveNode', { nodeId: paragraphs.nodeIds?.[0] }, sessionID);
        record('cdp_dom_query_all_resolve_node', (paragraphs.nodeIds || []).length > 0 && !!resolved.object?.objectId ? 'pass' : 'fail', {
          count: paragraphs.nodeIds?.length || 0,
          object: resolved.object,
        });
      });

      await runCDPTest('cdp_runtime_call_function_get_properties', async () => {
        const object = await cdp.send('Runtime.evaluate', {
          expression: '({ a: 2, b: 3 })',
        }, sessionID);
        const sum = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.result?.objectId,
          functionDeclaration: 'function () { return this.a + this.b; }',
          returnByValue: true,
        }, sessionID);
        const properties = await cdp.send('Runtime.getProperties', {
          objectId: object.result?.objectId,
          ownProperties: true,
        }, sessionID);
        record('cdp_runtime_call_function_get_properties', sum.result?.value === 5 && Array.isArray(properties.result) ? 'pass' : 'fail', {
          sum: sum.result?.value,
          property_count: properties.result?.length || 0,
        });
      });

      await runCDPTest('cdp_runtime_add_binding', async () => {
        await cdp.send('Runtime.addBinding', { name: 'choirAuditBinding' }, sessionID);
        record('cdp_runtime_add_binding', 'pass');
      });

      await runCDPTest('cdp_runtime_release_exception_helpers', async () => {
        const object = await cdp.send('Runtime.evaluate', {
          expression: '({ releaseProbe: true })',
        }, sessionID);
        const objectID = object.result?.objectId;
        if (objectID) await cdp.send('Runtime.releaseObject', { objectId: objectID }, sessionID);
        await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'default' }, sessionID);
        const exceptionDetails = await cdp.send('Runtime.getExceptionDetails', {}, sessionID);
        await cdp.send('Runtime.discardConsoleEntries', {}, sessionID);
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionID);
        record('cdp_runtime_release_exception_helpers', exceptionDetails.exceptionDetails === null ? 'pass' : 'fail', {
          hadObjectID: Boolean(objectID),
          exceptionDetails,
        });
      });

      await runCDPTest('cdp_dom_describe_box_and_mutation_stubs', async () => {
        await cdp.send('Page.navigate', { url: 'https://example.com?dom-inventory=1' }, sessionID);
        await sleep(2000);
        const document = await cdp.send('DOM.getDocument', { depth: 2 }, sessionID);
        const h1 = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'h1' }, sessionID);
        const described = await cdp.send('DOM.describeNode', { nodeId: h1.nodeId, depth: 1 }, sessionID);
        const box = await cdp.send('DOM.getBoxModel', { nodeId: h1.nodeId }, sessionID);
        await cdp.send('DOM.setAttributeValue', { nodeId: h1.nodeId, name: 'data-obscura', value: 'ok' }, sessionID);
        await cdp.send('DOM.removeNode', { nodeId: 0 }, sessionID);
        record('cdp_dom_describe_box_and_mutation_stubs', described.node?.nodeName === 'H1' && box.model?.width > 0 ? 'pass' : 'fail', {
          described: described.node,
          box,
          note: 'setAttributeValue/removeNode are accepted no-op stubs in current Obscura',
        });
      });

      await runCDPTest('cdp_cookie_set_get', async () => {
        await cdp.send('Network.setCookies', {
          cookies: [{ name: 'obscura_audit', value: 'ok', domain: 'httpbin.org', path: '/', secure: true, httpOnly: true }],
        }, sessionID);
        await cdp.send('Page.navigate', { url: 'https://httpbin.org/cookies' }, sessionID);
        await sleep(3000);
        const body = await cdp.send('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText',
          returnByValue: true,
        }, sessionID);
        record('cdp_cookie_set_get', /obscura_audit/.test(body.result?.value || '') ? 'pass' : 'fail', {
          body_head: String(body.result?.value || '').slice(0, 500),
        });
      });

      await runCDPTest('cdp_network_cookie_helpers', async () => {
        await cdp.send('Network.setCookies', {
          cookies: [{ name: 'network_cookie_probe', value: 'ok', domain: 'example.com', path: '/', secure: true }],
        }, sessionID);
        const before = await cdp.send('Network.getCookies', {}, sessionID);
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionID);
        await cdp.send('Network.setRequestInterception', { patterns: [] }, sessionID);
        await cdp.send('Network.clearBrowserCookies', {}, sessionID);
        const after = await cdp.send('Network.getCookies', {}, sessionID);
        const hadCookie = (before.cookies || []).some((cookie) => cookie.name === 'network_cookie_probe');
        const removedCookie = !(after.cookies || []).some((cookie) => cookie.name === 'network_cookie_probe');
        record('cdp_network_cookie_helpers', hadCookie && removedCookie ? 'pass' : 'fail', {
          before_count: before.cookies?.length || 0,
          after_count: after.cookies?.length || 0,
          hadCookie,
          removedCookie,
          note: 'setCacheDisabled/setRequestInterception are accepted stubs; Fetch interception is tested separately',
        });
      });

      await runCDPTest('cdp_network_headers_and_user_agent', async () => {
        await cdp.send('Network.setUserAgentOverride', {
          userAgent: 'ChoirObscuraAudit/1.0',
        }, sessionID);
        await cdp.send('Network.setExtraHTTPHeaders', {
          headers: { 'X-Choir-Obscura-Audit': 'yes' },
        }, sessionID);
        await cdp.send('Page.navigate', { url: 'https://httpbin.org/headers' }, sessionID);
        await sleep(3000);
        const body = await cdp.send('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText',
          returnByValue: true,
        }, sessionID);
        const headerBody = body.result?.value || '';
        record('cdp_network_headers_and_user_agent', headerBody.includes('ChoirObscuraAudit/1.0') && /X-Choir-Obscura-Audit/i.test(headerBody) ? 'pass' : 'fail', {
          body_head: String(body.result?.value || '').slice(0, 1000),
        });
      });

      await runCDPTest('cdp_storage_set_get_delete_cookies', async () => {
        await cdp.send('Storage.setCookies', {
          cookies: [{ name: 'storage_cookie', value: 'ok', domain: 'example.com', path: '/', secure: true }],
        }, sessionID);
        const before = await cdp.send('Storage.getCookies', {}, sessionID);
        await cdp.send('Storage.deleteCookies', { name: 'storage_cookie', domain: 'example.com', path: '/' }, sessionID);
        const after = await cdp.send('Storage.getCookies', {}, sessionID);
        const hadCookie = (before.cookies || []).some((cookie) => cookie.name === 'storage_cookie');
        const removedCookie = !(after.cookies || []).some((cookie) => cookie.name === 'storage_cookie');
        record('cdp_storage_set_get_delete_cookies', hadCookie && removedCookie ? 'pass' : 'fail', {
          before_count: before.cookies?.length || 0,
          after_count: after.cookies?.length || 0,
          hadCookie,
          removedCookie,
        });
      });

      await runCDPTest('cdp_fetch_fulfill_request', async () => {
        await cdp.send('Fetch.enable', {
          patterns: [{ urlPattern: '*example.com/intercept*' }],
        }, sessionID);
        const navigation = cdp
          .send('Page.navigate', { url: 'https://example.com/intercept-audit' }, sessionID)
          .catch((error) => error);
        const paused = await cdp.waitForEvent('Fetch.requestPaused', () => true, 10_000);
        await cdp.send('Fetch.fulfillRequest', {
          requestId: paused.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from('<!doctype html><title>Intercepted</title><h1>Intercepted by Obscura</h1>').toString('base64'),
        }, sessionID);
        await navigation;
        await sleep(1000);
        const title = await cdp.send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        }, sessionID);
        await cdp.send('Fetch.disable', {}, sessionID).catch(() => {});
        record('cdp_fetch_fulfill_request', title.result?.value === 'Intercepted' ? 'pass' : 'fail', {
          title: title.result?.value,
        });
      });

      await runCDPTest('cdp_fetch_lifecycle_methods', async () => {
        await cdp.send('Fetch.enable', {
          patterns: [{ urlPattern: '*example.com/fetch-lifecycle*' }],
        }, sessionID);
        const body = await cdp.send('Fetch.getResponseBody', {
          requestId: 'missing-request-id',
        }, sessionID);
        await cdp.send('Fetch.continueRequest', {
          requestId: 'missing-request-id',
        }, sessionID);
        await cdp.send('Fetch.failRequest', {
          requestId: 'missing-request-id',
          errorReason: 'Failed',
        }, sessionID);
        await cdp.send('Fetch.disable', {}, sessionID);
        record('cdp_fetch_lifecycle_methods', body.base64Encoded === false ? 'pass' : 'fail', {
          body,
          note: 'These calls prove method acceptance only; real paused-request interception is tested separately.',
        });
      });

      await runCDPTest('cdp_form_submit_redirect_cookie_flow', async () => {
        await cdp.send('Page.navigate', { url: 'https://httpbin.org/forms/post' }, sessionID);
        await sleep(3000);
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const form = document.querySelector('form');
            if (!form) return 'no-form';
            form.querySelector('[name="custname"]').value = 'Choir Obscura';
            form.querySelector('[name="comments"]').value = 'form submit audit';
            form.submit();
            return 'submitted';
          })()`,
          returnByValue: true,
        }, sessionID);
        await sleep(5000);
        const body = await cdp.send('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText',
          returnByValue: true,
        }, sessionID);
        record('cdp_form_submit_redirect_cookie_flow', /Choir Obscura|form submit audit/.test(body.result?.value || '') ? 'pass' : 'fail', {
          body_head: String(body.result?.value || '').slice(0, 1000),
        });
      });

      await runCDPTest('cdp_lp_get_markdown', async () => {
        await cdp.send('Page.navigate', { url: 'https://example.com' }, sessionID);
        await sleep(2000);
        const markdown = await cdp.send('LP.getMarkdown', {}, sessionID);
        record('cdp_lp_get_markdown', /Example Domain/.test(markdown.markdown || '') ? 'pass' : 'fail', {
          markdown_head: String(markdown.markdown || JSON.stringify(markdown)).slice(0, 500),
        });
      });

      await runCDPTest('cdp_page_print_to_pdf', async () => {
        await cdp.send('Page.navigate', { url: 'https://example.com?pdf=1' }, sessionID);
        await sleep(2000);
        const pdf = await cdp.send('Page.printToPDF', {}, sessionID);
        const pdfPath = path.join(outDir, 'obscura-cdp-print.pdf');
        fs.writeFileSync(pdfPath, Buffer.from(pdf.data || '', 'base64'));
        record('cdp_page_print_to_pdf', fs.statSync(pdfPath).size > 1000 ? 'pass' : 'fail', {
          pdfPath,
          bytes: fs.statSync(pdfPath).size,
        });
      });

      await runCDPTest('cdp_page_capture_screenshot', async () => {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionID);
        const screenshotPath = path.join(outDir, 'obscura-cdp-screenshot.png');
        fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data || '', 'base64'));
        record('cdp_page_capture_screenshot', fs.statSync(screenshotPath).size > 1000 ? 'pass' : 'fail', {
          screenshotPath,
        });
      });

      await runCDPTest('cdp_screencast_video_primitives', async () => {
        cdp.events = [];
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80 }, sessionID);
        await sleep(1500);
        const frames = cdp.events.filter((event) => event.method === 'Page.screencastFrame');
        await cdp.send('Page.stopScreencast', {}, sessionID).catch(() => {});
        record('cdp_screencast_video_primitives', frames.length > 0 ? 'pass' : 'fail', {
          frame_count: frames.length,
        });
      });

      await runCDPTest('cdp_input_dispatch_key_event', async () => {
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            document.body.innerHTML = '<input id="x"><pre id="out"></pre>';
            const x = document.querySelector('#x');
            x.focus();
            x.addEventListener('input', () => document.querySelector('#out').textContent = x.value);
            return document.activeElement.id;
          })()`,
          returnByValue: true,
        }, sessionID);
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'A',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
        }, sessionID);
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'char',
          key: 'a',
          text: 'a',
          unmodifiedText: 'a',
        }, sessionID);
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'A',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
        }, sessionID);
        const value = await cdp.send('Runtime.evaluate', {
          expression: 'document.querySelector("#x").value',
          returnByValue: true,
        }, sessionID);
        record('cdp_input_dispatch_key_event', value.result?.value === 'a' ? 'pass' : 'fail', {
          value: value.result?.value,
        });
      });

      await runCDPTest('cdp_input_dispatch_mouse_event', async () => {
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            document.body.innerHTML = '<button id="b" style="position:absolute;left:0;top:0;width:160px;height:80px">Click</button><pre id="out"></pre>';
            document.querySelector('#b').addEventListener('click', () => document.querySelector('#out').textContent = 'clicked');
            return true;
          })()`,
          returnByValue: true,
        }, sessionID);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: 20,
          y: 20,
          button: 'left',
          clickCount: 1,
        }, sessionID);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: 20,
          y: 20,
          button: 'left',
          clickCount: 1,
        }, sessionID);
        const value = await cdp.send('Runtime.evaluate', {
          expression: 'document.querySelector("#out").textContent',
          returnByValue: true,
        }, sessionID);
        record('cdp_input_dispatch_mouse_event', value.result?.value === 'clicked' ? 'pass' : 'fail', {
          value: value.result?.value,
        });
      });

      await runCDPTest('cdp_input_touch_ignore_stubs', async () => {
        await cdp.send('Input.setIgnoreInputEvents', { ignore: true }, sessionID);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [] }, sessionID);
        await cdp.send('Input.setIgnoreInputEvents', { ignore: false }, sessionID);
        record('cdp_input_touch_ignore_stubs', 'pass', {
          note: 'touch/ignore methods are accepted stubs in current Obscura',
        });
      });

      await runCDPTest('cdp_web_storage_via_runtime', async () => {
        await cdp.send('Page.navigate', { url: 'https://example.com?storage=1' }, sessionID);
        await sleep(2000);
        const value = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            localStorage.setItem('choir-local', 'ok');
            sessionStorage.setItem('choir-session', 'ok');
            return localStorage.getItem('choir-local') + ':' + sessionStorage.getItem('choir-session');
          })()`,
          returnByValue: true,
        }, sessionID);
        record('cdp_web_storage_via_runtime', value.result?.value === 'ok:ok' ? 'pass' : 'fail', {
          value: value.result?.value,
        });
      });

      await runCDPTest('cdp_private_localhost_navigation', async () => {
        await withLocalHTTPServer((request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><title>Local Audit</title><main>local obscura ok</main>');
        }, async (origin) => {
          await cdp.send('Page.navigate', { url: `${origin}/private-local-audit` }, sessionID);
          await sleep(2000);
          const body = await cdp.send('Runtime.evaluate', {
            expression: 'document.body && document.body.innerText',
            returnByValue: true,
          }, sessionID);
          record('cdp_private_localhost_navigation', /local obscura ok/.test(body.result?.value || '') ? 'pass' : 'fail', {
            origin,
            body_head: String(body.result?.value || '').slice(0, 500),
          });
        });
      });

      await runCDPTest('cdp_webauthn_domain', async () => {
        await cdp.send('WebAuthn.enable', {}, sessionID);
        record('cdp_webauthn_domain', 'pass');
      });

      await runCDPTest('cdp_auth_state_reuse', async () => {
        if (readAuthCookies().length === 0) {
          record('cdp_auth_state_reuse', 'skip', { note: 'pass --auth-state <playwright-storage-state.json> to test auth reuse' });
          return;
        }
        const authSessionURL = `${baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL}/auth/session`;

        async function checkAuthSession() {
          const seeded = await seedAuthCookies(cdp, sessionID);
          await cdp.send('Page.navigate', { url: authSessionURL }, sessionID);
          await sleep(2000);
          const body = await cdp.send('Runtime.evaluate', {
            expression: 'document.body && document.body.innerText',
            returnByValue: true,
          }, sessionID);
          return {
            seeded,
            authenticated: /"authenticated":true/.test(body.result?.value || ''),
            body_head: String(body.result?.value || '').slice(0, 500),
          };
        }

        const first = await checkAuthSession();
        let refresh = null;
        let second = null;
        if (!first.authenticated) {
          refresh = refreshAuthState('cdp_auth_state_reuse returned unauthenticated');
          if (refresh.refreshed) {
            second = await checkAuthSession();
          }
        }
        const passed = first.authenticated || second?.authenticated === true;
        record('cdp_auth_state_reuse', passed ? 'pass' : 'fail', {
          attempts: second ? [first, second] : [first],
          refresh,
        });
      });

      await runCDPTest('draft_spa_hydration', async () => {
        cdp.events = [];
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => {
            window.__choirObscuraErrors = [];
            const serializeTarget = (target) => {
              if (!target || !target.tagName) return null;
              return {
                tagName: target.tagName,
                type: target.type || '',
                src: target.src || '',
                href: target.href || '',
              };
            };
            window.addEventListener('error', (event) => {
              window.__choirObscuraErrors.push({
                kind: 'error',
                message: event.message || '',
                filename: event.filename || '',
                lineno: event.lineno || 0,
                colno: event.colno || 0,
                target: serializeTarget(event.target),
              });
            }, true);
            window.addEventListener('unhandledrejection', (event) => {
              window.__choirObscuraErrors.push({
                kind: 'unhandledrejection',
                reason: String(event.reason && (event.reason.stack || event.reason.message || event.reason)),
              });
            });
            window.__choirObscuraFetches = [];
            const originalFetch = window.fetch;
            window.fetch = function(input, init) {
              const url = typeof input === 'string' ? input : String(input?.url || input);
              const entry = {
                url,
                method: init?.method || 'GET',
                credentials: init?.credentials || '',
                status: null,
                ok: null,
                error: '',
              };
              window.__choirObscuraFetches.push(entry);
              return originalFetch.call(this, input, init).then((response) => {
                entry.status = response.status;
                entry.ok = response.ok;
                return response;
              }).catch((error) => {
                entry.error = String(error && (error.stack || error.message || error));
                throw error;
              });
            };
          })();`,
        }, sessionID);
        await cdp.send('Page.navigate', { url: baseURL }, sessionID);
        await sleep(8000);
        const hydration = await cdp.send('Runtime.evaluate', {
          expression: `({
            location: location.href,
            readyState: document.readyState,
            appHTML: document.querySelector('#app')?.innerHTML?.slice(0, 500) || '',
            hasDesktop: !!document.querySelector('[data-desktop]'),
            hasAuthEntry: !!document.querySelector('[data-auth-entry]'),
            bodyText: document.body?.innerText?.slice(0, 500) || '',
            title: document.title || '',
            scripts: Array.from(document.scripts).map((script) => ({
              type: script.type || '',
              src: script.src || '',
              defer: script.defer,
              async: script.async,
              textHead: script.src ? '' : script.textContent.slice(0, 120),
            })),
            modulePreloadLinks: Array.from(document.querySelectorAll('link[rel="modulepreload"]')).map((link) => link.href),
            stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((link) => link.href),
            errors: window.__choirObscuraErrors || [],
            fetches: window.__choirObscuraFetches || [],
            resources: performance.getEntriesByType('resource').map((entry) => ({
              name: entry.name,
              initiatorType: entry.initiatorType,
              duration: entry.duration,
              transferSize: entry.transferSize,
              encodedBodySize: entry.encodedBodySize,
              decodedBodySize: entry.decodedBodySize,
            })).slice(0, 30)
          })`,
          returnByValue: true,
        }, sessionID);
        const value = hydration.result?.value || {};
        const requests = cdp.events.filter((event) => event.method === 'Network.requestWillBeSent');
        const responses = cdp.events.filter((event) => event.method === 'Network.responseReceived');
        const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
        record('draft_spa_hydration', value.hasDesktop || value.hasAuthEntry ? 'pass' : 'fail', {
          ...value,
          appMounted: value.appHTML.length > 0,
          note: 'Passing staging QA requires product UI, not merely a non-empty loading shell.',
        });
        const result = results[results.length - 1];
        result.request_count = requests.length;
        result.response_count = responses.length;
        result.exception_count = exceptions.length;
        result.exceptions = exceptions.slice(0, 10);
        result.request_urls = requests.map((event) => event.params?.request?.url).filter(Boolean).slice(0, 30);
        result.responses = responses.map((event) => ({
          url: event.params?.response?.url,
          status: event.params?.response?.status,
          mimeType: event.params?.response?.mimeType,
        })).filter((response) => response.url).slice(0, 30);
      });

      if (runProductFlow) {
        await withObscuraServer(async ({ version: productVersion, logPath: productLogPath }) => {
          record('draft_prompt_bar_vtext_flow_server', 'pass', {
            version: productVersion,
            logPath: productLogPath,
            note: 'Product flow runs in an isolated Obscura process because repeated Vite module evaluation can panic the current Obscura runtime.',
          });
        await runCDPTest('draft_prompt_bar_vtext_flow', async () => {
          const productPage = await setupCDPPage(productVersion);
          try {
            const cdp = productPage.cdp;
            const sessionID = productPage.sessionID;

            async function navigateToAuthedDesktop() {
              const seeded = await seedAuthCookies(cdp, sessionID);
              await cdp.send('Fetch.disable', {}, sessionID).catch(() => {});
              await cdp.send('Page.navigate', { url: baseURL }, sessionID);
              let promptReadyState = null;
              for (let attempt = 0; attempt < 240; attempt += 1) {
                const ready = await cdp.send('Runtime.callFunctionOn', {
                  functionDeclaration: `async () => {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    const input = document.querySelector('[data-prompt-input]');
                    const desktop = document.querySelector('[data-desktop]');
                    return {
                      hasPromptInput: Boolean(input),
                      hasDesktop: Boolean(desktop),
                      readyState: document.readyState,
                      bodyText: (document.body?.innerText || document.body?.textContent || '').slice(0, 500),
                      bottomBarHTML: (document.querySelector('[data-bottom-bar]')?.outerHTML || '').slice(0, 1000),
                    };
                  }`,
                  returnByValue: true,
                  awaitPromise: true,
                }, sessionID);
                promptReadyState = ready.result?.value || null;
                if (promptReadyState?.hasPromptInput) break;
              }
              return { seeded, promptReadyState };
            }

          let authAttempt = await navigateToAuthedDesktop();
          let refresh = null;
          if (!authAttempt.promptReadyState?.hasPromptInput && readAuthCookies().length > 0) {
            refresh = refreshAuthState('draft_prompt_bar_vtext_flow did not reach authenticated desktop');
            if (refresh.refreshed) {
              authAttempt = await navigateToAuthedDesktop();
            }
          }
          const promptReadyState = {
            ...authAttempt.promptReadyState,
            authSeed: authAttempt.seeded,
            authRefresh: refresh,
          };
          const marker = `OBSCURA_PROMPT_BAR_${Date.now()}`;
          const prompt = `Draft a short VText note that preserves the marker ${marker}.`;
          await cdp.send('Runtime.evaluate', {
            expression: `(() => {
              const marker = ${JSON.stringify(marker)};
              const prompt = ${JSON.stringify(prompt)};
              const promptReadyState = ${JSON.stringify(promptReadyState)};
              window.__choirObscuraPromptFlow = {
                marker,
                prompt,
                fetches: [],
                error: '',
                started: false,
                promptReadyState
              };

              const previousFetch = window.fetch && window.fetch.__choirOriginalFetch
                ? window.fetch.__choirOriginalFetch
                : window.fetch;
              if (typeof previousFetch !== 'function') {
                window.__choirObscuraPromptFlow.error = 'fetch unavailable';
                return window.__choirObscuraPromptFlow;
              }

              const wrappedFetch = async function(input, init) {
                const method = String(init?.method || input?.method || 'GET').toUpperCase();
                const rawURL = typeof input === 'string' ? input : String(input?.url || input);
                const absoluteURL = new URL(rawURL, location.href);
                const entry = {
                  url: absoluteURL.href,
                  path: absoluteURL.pathname,
                  method,
                  status: null,
                  ok: null,
                  body: null,
                  error: ''
                };
                window.__choirObscuraPromptFlow.fetches.push(entry);
                try {
                  const response = await previousFetch.call(this, input, init);
                  entry.status = response.status;
                  entry.ok = response.ok;
                  if (absoluteURL.pathname.startsWith('/api/prompt-bar')) {
                    entry.body = await response.clone().json().catch(() => null);
                    if (entry.body?.submission_id) {
                      window.__choirObscuraPromptFlow.submissionId = entry.body.submission_id;
                    }
                    if (entry.body?.decision) {
                      window.__choirObscuraPromptFlow.decision = entry.body.decision;
                    }
                  }
                  return response;
                } catch (error) {
                  entry.error = String(error && (error.stack || error.message || error));
                  throw error;
                }
              };
              wrappedFetch.__choirOriginalFetch = previousFetch;
              window.fetch = wrappedFetch;

              const input = document.querySelector('[data-prompt-input]');
              if (!input) {
                window.__choirObscuraPromptFlow.error = 'missing [data-prompt-input]';
                return window.__choirObscuraPromptFlow;
              }
              input.focus();
              input.value = prompt;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
              }));
              window.__choirObscuraPromptFlow.started = true;
              return window.__choirObscuraPromptFlow;
            })()`,
            returnByValue: true,
          }, sessionID);

          let finalState = null;
          for (let attempt = 0; attempt < 600; attempt += 1) {
            const state = await cdp.send('Runtime.callFunctionOn', {
              functionDeclaration: `async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                const flow = window.__choirObscuraPromptFlow || {};
                const editors = Array.from(document.querySelectorAll('[data-vtext-app] [data-vtext-editor-area]'));
                const editorTexts = editors.map((editor) => editor?.innerText || editor?.textContent || '');
                const matchingEditorText = editorTexts.find((text) => text.includes(flow.marker || '')) || '';
                const firstEditorText = editorTexts[0] || '';
                return {
                  ...flow,
                  vtextCount: document.querySelectorAll('[data-vtext-app]').length,
                  editorText: (matchingEditorText || firstEditorText).slice(0, 1000),
                  editorTexts: editorTexts.map((text) => text.slice(0, 500)),
                  editorHasMarker: Boolean(matchingEditorText),
                  hasBadControlText: /Conductor framing|Use this vtext|User request:|Current requirements:|Grounding status:/i.test(matchingEditorText || firstEditorText),
                  promptPosts: (flow.fetches || []).filter((entry) => entry.path === '/api/prompt-bar' && entry.method === 'POST'),
                  promptStatusPolls: (flow.fetches || []).filter((entry) => entry.path && entry.path.startsWith('/api/prompt-bar/submissions/')),
                  windowTitle: document.querySelector('[data-window-titlebar]')?.textContent?.trim() || ''
                };
              }`,
              returnByValue: true,
              awaitPromise: true,
            }, sessionID);
            finalState = state.result?.value || null;
            if (finalState?.editorHasMarker && finalState?.vtextCount > 0) break;
          }

          const promptPost = finalState?.promptPosts?.[0] || null;
          const passed = finalState?.started === true &&
            !finalState?.error &&
            promptPost?.status === 202 &&
            finalState?.vtextCount > 0 &&
            finalState?.editorHasMarker === true &&
            finalState?.hasBadControlText === false;

          record('draft_prompt_bar_vtext_flow', passed ? 'pass' : 'fail', {
            marker,
            prompt,
            state: finalState,
            note: 'Optional live product-flow probe; enable with --product-flow or OBSCURA_RUN_PRODUCT_FLOW=1.',
          });
          } finally {
            productPage.cdp.close();
          }
        });
        }, {
          logName: 'obscura-product-flow.log',
        });
      } else {
        record('draft_prompt_bar_vtext_flow', 'skip', {
          note: 'Skipped by default to avoid live product/LLM side effects. Enable with --product-flow or OBSCURA_RUN_PRODUCT_FLOW=1.',
        });
      }
    } finally {
      cdp.close();
    }

    await runPlaywrightOverCDPTests(version);
  });

  await withObscuraServer(async ({ version, logPath }) => {
    record('cdp_serve_user_agent_stealth_server', 'pass', { version, logPath });
    const { cdp, sessionID } = await setupCDPPage(version);
    try {
      await runCDPTest('cdp_serve_user_agent_stealth_effect', async () => {
        await cdp.send('Page.navigate', { url: 'https://httpbin.org/user-agent' }, sessionID);
        await sleep(3000);
        const body = await cdp.send('Runtime.evaluate', {
          expression: 'document.body && document.body.innerText',
          returnByValue: true,
        }, sessionID);
        record('cdp_serve_user_agent_stealth_effect', /ChoirObscuraServe\/1\.0/.test(body.result?.value || '') ? 'pass' : 'fail', {
          body_head: String(body.result?.value || '').slice(0, 500),
        });
      });
    } finally {
      cdp.close();
    }
  }, {
    logName: 'obscura-serve-user-agent.log',
    args: ['--user-agent', 'ChoirObscuraServe/1.0', '--stealth'],
  });

  await withObscuraServer(async ({ version, logPath }) => {
    const cdp = new CDPClient(version.webSocketDebuggerUrl);
    await cdp.open();
    try {
      await runCDPTest('cdp_browser_close_noop', async () => {
        const result = await cdp.send('Browser.close', {}, '', 2_000);
        record('cdp_browser_close_noop', typeof result === 'object' ? 'pass' : 'fail', {
          result,
          note: 'Browser.close is isolated because it may close or stall the connection in current Obscura.',
        });
      });
    } finally {
      cdp.close();
    }
  }, {
    logName: 'obscura-browser-close.log',
  });

  return finish(metadata, 0);
}

function finish(metadata, defaultExitCode) {
  metadata.finishedAt = new Date().toISOString();
  metadata.results = results;
  metadata.summary = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  metadata.playwrightParity = buildPlaywrightParityChecklist(results);
  metadata.success = !results.some((result) => result.status === 'fail');

  const summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(`SUMMARY ${summaryPath}`);
  console.log(JSON.stringify(metadata.summary));

  process.exitCode = metadata.success ? defaultExitCode : 1;
}

function buildPlaywrightParityChecklist(auditResults) {
  const statusByName = new Map(auditResults.map((result) => [result.name, result.status]));
  const statusOf = (name) => statusByName.get(name) || 'missing';
  const anyFail = (names) => names.some((name) => ['fail', 'missing'].includes(statusOf(name)));
  const item = (id, requirement, evidence, requiredChecks, options = {}) => {
    let status = 'pass';
    if (anyFail(requiredChecks)) status = options.partialOnFail ? 'partial' : 'fail';
    if (options.forceStatus) status = options.forceStatus;
    return {
      id,
      requirement,
      status,
      evidence,
      checks: Object.fromEntries(requiredChecks.map((name) => [name, statusOf(name)])),
      blocking: status !== 'pass',
    };
  };

  const requirements = [
    (() => {
      const authSetupChecks = ['playwright_create_auth_state', 'auth_state_file_present'];
      const hasAuthSetup = authSetupChecks.some((name) => statusOf(name) === 'pass');
      const hasAuthReuse = statusOf('cdp_auth_state_reuse') === 'pass';
      return {
        id: 'auth-caching',
        requirement: 'Set up auth once and reuse it from Obscura.',
        status: hasAuthSetup && hasAuthReuse ? 'pass' : 'fail',
        evidence: 'Playwright creates or supplies a passkey-backed storage state, then Obscura loads cookies through CDP and calls /auth/session.',
        checks: {
          playwright_create_auth_state: statusOf('playwright_create_auth_state'),
          auth_state_file_present: statusOf('auth_state_file_present'),
          cdp_auth_state_reuse: statusOf('cdp_auth_state_reuse'),
        },
        blocking: !(hasAuthSetup && hasAuthReuse),
      };
    })(),
    item(
      'passkey-webauthn',
      'Replace Playwright WebAuthn virtual-authenticator passkey setup.',
      'Obscura would need the CDP WebAuthn domain or equivalent passkey automation.',
      ['cdp_webauthn_domain'],
    ),
    item(
      'screenshots',
      'Capture Playwright-equivalent screenshots.',
      'Playwright uses Page.captureScreenshot under CDP.',
      ['cdp_page_capture_screenshot', 'playwright_cdp_screenshot'],
    ),
    item(
      'video',
      'Capture Playwright-equivalent video or screencast evidence.',
      'A usable replacement needs Page.startScreencast or another nonblank visual video path.',
      ['cdp_screencast_video_primitives', 'playwright_cdp_video_nonblank'],
    ),
    item(
      'deployed-staging-qa',
      'QA draft.choir-ip.com product flows from Obscura.',
      'Hydration is necessary but not sufficient; full product QA also needs a prompt-bar to VText flow proof.',
      ['draft_spa_hydration', 'draft_prompt_bar_vtext_flow'],
    ),
    item(
      'browser-navigation-dom-runtime',
      'Cover core navigation, DOM, and Runtime automation.',
      'These are the minimum nonvisual browser-control primitives.',
      [
        'playwright_cdp_connect_navigate_eval',
        'cdp_navigation_runtime_eval',
        'cdp_page_get_frame_tree',
        'cdp_page_layout_history_isolated_world_scripts',
        'cdp_page_lifecycle_events',
        'cdp_dom_query',
        'cdp_dom_query_all_resolve_node',
        'cdp_dom_describe_box_and_mutation_stubs',
        'cdp_runtime_call_function_get_properties',
        'cdp_runtime_release_exception_helpers',
        'cdp_runtime_console_events',
        'cdp_inline_module_script_execution',
        'cdp_external_module_script_execution',
      ],
    ),
    item(
      'browser-input',
      'Cover keyboard and mouse interaction.',
      'Playwright product tests depend on both typed input and pointer/click interaction.',
      ['cdp_input_dispatch_key_event', 'cdp_input_dispatch_mouse_event', 'cdp_input_touch_ignore_stubs'],
      { partialOnFail: true },
    ),
    item(
      'network-storage',
      'Cover network headers, cookies, and browser storage.',
      'This is needed for authenticated product testing and browser-app sessions.',
      [
        'cdp_cookie_set_get',
        'cdp_network_cookie_helpers',
        'cdp_network_headers_and_user_agent',
        'cdp_network_request_response_events',
        'cdp_storage_set_get_delete_cookies',
        'cdp_web_storage_via_runtime',
      ],
    ),
    item(
      'request-interception',
      'Cover request interception and response fulfillment.',
      'Playwright-style route mocking and controlled network tests require Fetch.requestPaused/fulfillRequest.',
      ['cdp_fetch_fulfill_request'],
    ),
    item(
      'cli-surface',
      'Cover Obscura CLI fetch/scrape surface.',
      'The CLI should support documented fetch/eval/text/links/selector/stealth/networkidle/scrape/output behavior.',
      [
        'cli_fetch_eval_title',
        'cli_fetch_help',
        'cli_fetch_dump_text_stdout',
        'cli_fetch_dump_links',
        'cli_fetch_selector_eval',
        'cli_fetch_stealth_eval',
        'cli_fetch_wait_until_networkidle0',
        'cli_serve_help',
        'cli_scrape_parallel_eval',
        'cli_scrape_help',
        'cli_fetch_output_file_flag',
        'cli_fetch_output_short_flag',
        'cli_fetch_user_agent_flag',
        'cli_global_user_agent_applies_to_fetch',
        'cli_serve_obey_robots_flag',
      ],
      { partialOnFail: true },
    ),
    item(
      'cdp-surface-inventory',
      'Inventory the Obscura CDP/HTTP surface.',
      'The audit records /json/version, /json/list, /json/protocol, and method-level probes.',
      [
        'cdp_json_version',
        'cdp_http_json_list',
        'cdp_http_json_protocol',
        'cdp_schema_get_domains',
        'cdp_noop_domains_enable',
        'cdp_browser_close_noop',
        'cdp_browser_window_download_methods',
        'cdp_target_metadata_autodiscovery',
        'cdp_accessibility_get_full_ax_tree',
        'cdp_fetch_lifecycle_methods',
        'cdp_page_print_to_pdf',
        'cdp_private_localhost_navigation',
        'cdp_serve_user_agent_stealth_server',
        'cdp_serve_user_agent_stealth_effect',
      ],
      { partialOnFail: true },
    ),
  ];

  return {
    objective: 'Duplicate full Playwright functionality with Obscura, including auth caching, screenshots, video, and broad surface coverage.',
    achieved: requirements.every((requirement) => requirement.status === 'pass'),
    requirements,
    blockingRequirements: requirements.filter((requirement) => requirement.status !== 'pass').map((requirement) => requirement.id),
    passedChecks: auditResults.filter((result) => result.status === 'pass').map((result) => result.name),
    failedChecks: auditResults.filter((result) => result.status === 'fail').map((result) => result.name),
  };
}

main().catch((error) => {
  record('audit_harness', 'fail', { error: String(error.stack || error) });
  finish({
    obscuraPath,
    baseURL,
    authStatePath: authStatePath || null,
    outDir,
    startedAt: new Date().toISOString(),
  }, 1);
});
