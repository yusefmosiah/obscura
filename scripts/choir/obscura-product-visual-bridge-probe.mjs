#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const args = parseArgs(process.argv.slice(2));
const obscura = path.resolve(args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-source/target/release/obscura');
const baseURL = args.baseUrl || process.env.CHOIR_DEPLOYED_BASE_URL || 'https://draft.choir-ip.com';
const authState = path.resolve(
  args.authState ||
    process.env.CHOIR_AUTH_STATE ||
    path.join('playwright', '.auth', `${new URL(baseURL).hostname.replaceAll('.', '-')}.storage.json`),
);
const outDir = path.resolve(
  args.out ||
    process.env.OBSCURA_PRODUCT_VISUAL_BRIDGE_DIR ||
    path.join('/tmp', 'obscura-test', `product-visual-bridge-${Date.now()}`),
);

fs.mkdirSync(outDir, { recursive: true });

const started = Date.now();
const summaryPath = path.join(outDir, 'summary.json');
const htmlPath = path.join(outDir, 'obscura-product-dom.html');
const screenshotPath = path.join(outDir, 'product-visual-bridge.png');
const videoDir = path.join(outDir, 'product-visual-bridge-video');
fs.mkdirSync(videoDir, { recursive: true });

const checks = [];
let productState = null;
let videoPath = '';
let videoFrame = { ok: false, error: 'renderer did not run' };

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

  close() {
    this.ws?.close();
  }
}

try {
  const auth = ensureAuthState();
  record('auth_state_ready', auth.ok, auth);

  if (auth.ok) {
    productState = await driveProductAndExtractDOM();
    record('obscura_product_flow_exported_dom', productState.ok, {
      marker: productState.marker,
      promptStatus: productState.promptStatus,
      vtextCount: productState.vtextCount,
      editorHasMarker: productState.editorHasMarker,
      htmlBytes: productState.html?.length || 0,
      error: productState.error || '',
    });
  }

  if (productState?.ok) {
    fs.writeFileSync(htmlPath, withBaseHref(productState.html, baseURL), 'utf8');
    const rendered = await renderExternally();
    videoPath = rendered.videoPath;
    videoFrame = rendered.videoFrame;
    record('external_renderer_screenshot_created', rendered.screenshotOK, {
      renderer: 'playwright-chromium',
      screenshotPath,
      bytes: rendered.screenshotBytes,
    });
    record('external_renderer_video_created', rendered.videoOK, {
      renderer: 'playwright-chromium',
      videoPath,
      bytes: rendered.videoBytes,
      frame: videoFrame,
      note: 'Fallback video from externally rendered Obscura-exported product DOM. This is not native Obscura screencast parity.',
    });
  }
} catch (error) {
  record('probe_unhandled_error', false, {
    error: String(error?.stack || error?.message || error),
  });
}

const bridgeUsable = checks.every((check) => check.status === 'pass');
const summary = {
  objective: 'Use Obscura to drive the deployed prompt-bar/VText flow, export the actual product DOM, and create fallback visual artifacts from that state.',
  baseURL,
  obscuraPath: obscura,
  authState,
  outDir,
  htmlPath,
  screenshotPath,
  videoPath: videoPath || null,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  nativeObscuraVisual: false,
  externalRenderer: 'playwright-chromium',
  bridgeUsable,
  notAFullPlaywrightReplacement: true,
  limitations: [
    'Obscura drives the authenticated product flow and exports DOM state.',
    'Playwright Chromium renders the exported static DOM for screenshot/video artifacts.',
    'The video is fallback visual evidence, not native Page.startScreencast output from Obscura.',
  ],
  productState: productState ? {
    marker: productState.marker,
    promptStatus: productState.promptStatus,
    vtextCount: productState.vtextCount,
    editorHasMarker: productState.editorHasMarker,
    editorTextHead: productState.editorTextHead,
  } : null,
  checks,
};

fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  summaryPath,
  bridgeUsable,
  nativeObscuraVisual: false,
  notAFullPlaywrightReplacement: true,
  checks: Object.fromEntries(checks.map((check) => [check.name, check.status])),
  artifacts: {
    htmlPath,
    screenshotPath,
    videoPath: videoPath || null,
  },
}, null, 2));

process.exitCode = bridgeUsable ? 0 : 1;

function ensureAuthState() {
  const result = spawnSync(process.execPath, [
    'scripts/setup-auth-state.mjs',
    '--base-url',
    baseURL,
    '--out',
    authState,
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0 && fs.existsSync(authState),
    command: `${process.execPath} scripts/setup-auth-state.mjs --base-url ${baseURL} --out ${authState}`,
    exitCode: result.status,
    error: result.error ? result.error.message : '',
    stdoutTail: String(result.stdout || '').slice(-2000),
    stderrTail: String(result.stderr || '').slice(-2000),
  };
}

async function driveProductAndExtractDOM() {
  return withObscuraServer(async ({ version, logPath }) => {
    const page = await setupCDPPage(version);
    try {
      const { cdp, sessionID } = page;
      const seeded = await seedAuthCookies(cdp, sessionID);
      await cdp.send('Fetch.disable', {}, sessionID).catch(() => {});
      await cdp.send('Page.navigate', { url: baseURL }, sessionID);

      const ready = await waitForPromptInput(cdp, sessionID);
      if (!ready?.hasPromptInput) {
        return {
          ok: false,
          error: 'prompt input did not materialize',
          logPath,
          authSeed: seeded,
          ready,
        };
      }

      const marker = `OBSCURA_PRODUCT_VISUAL_${Date.now()}`;
      const prompt = `Draft a short VText note that preserves the marker ${marker}.`;
      await cdp.send('Runtime.evaluate', {
        expression: buildPromptSubmitScript(prompt, marker),
        returnByValue: true,
      }, sessionID);

      const finalState = await waitForVTextMarker(cdp, sessionID);
      const promptPost = finalState?.promptPosts?.[0] || null;
      const html = finalState?.editorHasMarker ? await exportProductHTML(cdp, sessionID) : '';
      const ok = finalState?.started === true &&
        !finalState?.error &&
        promptPost?.status === 202 &&
        finalState?.vtextCount > 0 &&
        finalState?.editorHasMarker === true &&
        /<html[\s>]/i.test(html);

      return {
        ok,
        marker,
        prompt,
        promptStatus: promptPost?.status || null,
        vtextCount: finalState?.vtextCount || 0,
        editorHasMarker: Boolean(finalState?.editorHasMarker),
        editorTextHead: finalState?.editorTextHead || '',
        html,
        logPath,
        authSeed: seeded,
        finalState: {
          ...finalState,
        },
      };
    } finally {
      page.cdp.close();
    }
  });
}

async function waitForPromptInput(cdp, sessionID) {
  let state = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: `async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          hasPromptInput: Boolean(document.querySelector('[data-prompt-input]')),
          hasDesktop: Boolean(document.querySelector('[data-desktop]')),
          readyState: document.readyState,
          bodyText: (document.body?.innerText || document.body?.textContent || '').slice(0, 500)
        };
      }`,
      returnByValue: true,
      awaitPromise: true,
    }, sessionID);
    state = response.result?.value || null;
    if (state?.hasPromptInput) break;
  }
  return state;
}

async function waitForVTextMarker(cdp, sessionID) {
  let state = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: `async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const flow = window.__choirObscuraProductVisualFlow || {};
        const editors = Array.from(document.querySelectorAll('[data-vtext-app] [data-vtext-editor-area]'));
        const editorTexts = editors.map((editor) => editor?.innerText || editor?.textContent || '');
        const matchingEditorText = editorTexts.find((text) => text.includes(flow.marker || '')) || '';
        const firstEditorText = editorTexts[0] || '';
        return {
          ...flow,
          vtextCount: document.querySelectorAll('[data-vtext-app]').length,
          editorHasMarker: Boolean(matchingEditorText),
          editorTextHead: (matchingEditorText || firstEditorText).slice(0, 1000),
          promptPosts: (flow.fetches || []).filter((entry) => entry.path === '/api/prompt-bar' && entry.method === 'POST'),
          bodyTextHead: (document.body?.innerText || document.body?.textContent || '').slice(0, 1000)
        };
      }`,
      returnByValue: true,
      awaitPromise: true,
    }, sessionID);
    state = response.result?.value || {
      error: response.exceptionDetails ? JSON.stringify(response.exceptionDetails).slice(0, 1000) : 'missing Runtime result value',
    };
    if (state?.editorHasMarker && state?.vtextCount > 0) break;
  }
  return state;
}

async function exportProductHTML(cdp, sessionID) {
  const response = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelectorAll('script').forEach((script) => script.remove());
      document.querySelector('#obscura-product-visual-bridge-style')?.remove();
      const style = document.createElement('style');
      style.id = 'obscura-product-visual-bridge-style';
      style.textContent = [
        'body::before {',
        '  content: "OBSCURA PRODUCT VISUAL BRIDGE";',
        '  position: fixed;',
        '  top: 12px;',
        '  left: 12px;',
        '  z-index: 2147483647;',
        '  padding: 10px 14px;',
        '  border: 3px solid #ffba49;',
        '  border-radius: 10px;',
        '  background: #064e3b;',
        '  color: white;',
        '  font: 700 18px sans-serif;',
        '}'
      ].join('\\n');
      (document.head || document.documentElement).appendChild(style);
      return '<!doctype html>\\n' + document.documentElement.outerHTML;
    })()`,
    returnByValue: true,
  }, sessionID);
  return response.result?.value || response.result?.description || '';
}

function buildPromptSubmitScript(prompt, marker) {
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    const prompt = ${JSON.stringify(prompt)};
    window.__choirObscuraProductVisualFlow = {
      marker,
      prompt,
      fetches: [],
      error: '',
      started: false
    };

    const previousFetch = window.fetch && window.fetch.__choirOriginalFetch
      ? window.fetch.__choirOriginalFetch
      : window.fetch;
    if (typeof previousFetch !== 'function') {
      window.__choirObscuraProductVisualFlow.error = 'fetch unavailable';
      return window.__choirObscuraProductVisualFlow;
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
      window.__choirObscuraProductVisualFlow.fetches.push(entry);
      try {
        const response = await previousFetch.call(this, input, init);
        entry.status = response.status;
        entry.ok = response.ok;
        if (absoluteURL.pathname.startsWith('/api/prompt-bar')) {
          entry.body = await response.clone().json().catch(() => null);
          if (entry.body?.submission_id) {
            window.__choirObscuraProductVisualFlow.submissionId = entry.body.submission_id;
          }
          if (entry.body?.decision) {
            window.__choirObscuraProductVisualFlow.decision = entry.body.decision;
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
      window.__choirObscuraProductVisualFlow.error = 'missing [data-prompt-input]';
      return window.__choirObscuraProductVisualFlow;
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
    window.__choirObscuraProductVisualFlow.started = true;
    return window.__choirObscuraProductVisualFlow;
  })()`;
}

async function renderExternally() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 860 } },
  });
  const page = await context.newPage();
  try {
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 20_000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.evaluate(() => {
      document.body.style.transition = 'filter 250ms ease';
      document.body.style.filter = 'brightness(1.12)';
    });
    await page.waitForTimeout(500);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const foundVideo = fs.readdirSync(videoDir).find((name) => name.endsWith('.webm'));
  const resolvedVideoPath = foundVideo ? path.join(videoDir, foundVideo) : '';
  const frame = resolvedVideoPath ? analyzeFirstVideoFrame(resolvedVideoPath) : { ok: false, error: 'no video file' };
  const videoBytes = resolvedVideoPath && fs.existsSync(resolvedVideoPath) ? fs.statSync(resolvedVideoPath).size : 0;
  return {
    screenshotOK: fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 1000,
    screenshotBytes: fs.existsSync(screenshotPath) ? fs.statSync(screenshotPath).size : 0,
    videoOK: videoBytes > 1000 && (frame.ok ? frame.visuallyNonBlank : true),
    videoPath: resolvedVideoPath,
    videoBytes,
    videoFrame: frame,
  };
}

function readAuthCookies() {
  const state = JSON.parse(fs.readFileSync(authState, 'utf8'));
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

async function seedAuthCookies(cdp, sessionID) {
  const cookies = readAuthCookies();
  if (cookies.length === 0) return { cookieCount: 0 };
  await cdp.send('Network.clearBrowserCookies', {}, sessionID).catch(() => {});
  await cdp.send('Network.setCookies', { cookies }, sessionID);
  return { cookieCount: cookies.length };
}

async function withObscuraServer(fn) {
  const port = 19_000 + Math.floor(Math.random() * 5000);
  const logPath = path.join(outDir, 'obscura-product-visual-bridge.log');
  const log = fs.openSync(logPath, 'w');
  const proc = spawn(obscura, ['serve', '--port', String(port), '--workers', '1'], {
    stdio: ['ignore', log, log],
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

function analyzeFirstVideoFrame(pathname) {
  const ffmpeg = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    pathname,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ], {
    encoding: null,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (ffmpeg.error) return { ok: false, error: ffmpeg.error.message };
  if (ffmpeg.status !== 0 || !ffmpeg.stdout?.length) {
    return { ok: false, error: String(ffmpeg.stderr || '') };
  }

  let min = 255;
  let max = 0;
  let sum = 0;
  for (const value of ffmpeg.stdout) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const avg = sum / ffmpeg.stdout.length;
  return {
    ok: true,
    min,
    max,
    avg,
    visuallyNonBlank: max - min > 20,
  };
}

function withBaseHref(html, baseURL) {
  const base = `<base href="${escapeHTML(baseURL)}">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  }
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
}

function record(name, passed, details = {}) {
  checks.push({
    name,
    ...details,
    status: passed ? 'pass' : 'fail',
  });
}

function escapeHTML(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function parseArgs(argv) {
  const parsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsedArgs[key] = true;
      continue;
    }
    parsedArgs[key] = next;
    index += 1;
  }
  return parsedArgs;
}
