#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const args = parseArgs(process.argv.slice(2));
const obscura = path.resolve(args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-source/target/release/obscura');
const url = args.url || process.env.OBSCURA_BRIDGE_URL || 'https://example.com';
const outDir = path.resolve(args.out || process.env.OBSCURA_EXTERNAL_VISUAL_BRIDGE_DIR || path.join('/tmp', 'obscura-test', `external-visual-bridge-${Date.now()}`));

fs.mkdirSync(outDir, { recursive: true });

const started = Date.now();
const summaryPath = path.join(outDir, 'summary.json');
const htmlPath = path.join(outDir, 'obscura-dom.html');
const screenshotPath = path.join(outDir, 'external-renderer-screenshot.png');
const videoDir = path.join(outDir, 'external-renderer-video');
fs.mkdirSync(videoDir, { recursive: true });

const checks = [];

const extracted = extractDOM();
record('obscura_dom_extracted', extracted.ok, {
  url,
  exitCode: extracted.exitCode,
  error: extracted.error,
  stdoutHead: extracted.stdoutHead,
  stderrHead: extracted.stderrHead,
  htmlBytes: extracted.html.length,
});

let screenshotBytes = 0;
let videoPath = '';
let videoFrame = { ok: false, error: 'renderer did not run' };

if (extracted.ok) {
  fs.writeFileSync(htmlPath, withBaseHref(extracted.html, url), 'utf8');
  const rendered = await renderExternally();
  screenshotBytes = rendered.screenshotBytes;
  videoPath = rendered.videoPath;
  videoFrame = rendered.videoFrame;
  record('external_renderer_screenshot_created', rendered.screenshotOK, {
    renderer: 'playwright-chromium',
    screenshotPath,
    bytes: screenshotBytes,
  });
  record('external_renderer_video_created', rendered.videoOK, {
    renderer: 'playwright-chromium',
    videoPath,
    bytes: rendered.videoBytes,
    frame: videoFrame,
  });
}

const bridgeUsable = checks.every((check) => check.status === 'pass');
const summary = {
  objective: 'Probe whether Obscura-acquired DOM can be handed to an external renderer for honest visual artifacts.',
  obscuraPath: obscura,
  url,
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

process.exit(bridgeUsable ? 0 : 1);

function extractDOM() {
  const expression = 'document.documentElement && document.documentElement.outerHTML';
  const result = spawnSync(obscura, ['fetch', url, '--eval', expression, '--quiet'], {
    encoding: 'utf8',
    timeout: 45_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const html = stdout.trim();
  return {
    ok: !result.error && result.status === 0 && /<html[\s>]/i.test(html),
    html,
    exitCode: result.status ?? null,
    error: result.error ? result.error.message : null,
    stdoutHead: stdout.slice(0, 500),
    stderrHead: stderr.slice(0, 500),
  };
}

async function renderExternally() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 960, height: 640 },
    recordVideo: { dir: videoDir, size: { width: 960, height: 640 } },
  });
  const page = await context.newPage();
  try {
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 20_000 });
    await page.addStyleTag({
      content: `
        html, body { min-height: 100%; }
        body::before {
          content: "OBSCURA EXTERNAL VISUAL BRIDGE";
          position: fixed;
          top: 16px;
          left: 16px;
          z-index: 2147483647;
          padding: 12px 16px;
          background: rgb(0, 96, 72);
          color: white;
          font: 700 22px sans-serif;
          border: 4px solid rgb(255, 186, 73);
        }
      `,
    });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.evaluate(() => {
      document.body.style.transition = 'background 200ms linear';
      document.body.style.background = 'rgb(12, 24, 48)';
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

function withBaseHref(html, baseURL) {
  const base = `<base href="${escapeHTML(baseURL)}">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  }
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
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
    maxBuffer: 50 * 1024 * 1024,
  });
  if (ffmpeg.error) {
    return {
      ok: false,
      error: ffmpeg.error.message,
      note: 'ffmpeg unavailable; file-size evidence remains, but frame analysis did not run.',
    };
  }
  if (ffmpeg.status !== 0 || !ffmpeg.stdout?.length) {
    return {
      ok: false,
      error: String(ffmpeg.stderr || ''),
    };
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

function record(name, passed, details = {}) {
  checks.push({
    name,
    status: passed ? 'pass' : 'fail',
    ...details,
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
