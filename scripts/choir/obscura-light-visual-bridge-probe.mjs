#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const obscura = path.resolve(args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-source/target/release/obscura');
const url = args.url || process.env.OBSCURA_BRIDGE_URL || 'https://example.com';
const outDir = path.resolve(args.out || process.env.OBSCURA_LIGHT_VISUAL_BRIDGE_DIR || path.join('/tmp', 'obscura-test', `light-visual-bridge-${Date.now()}`));

fs.mkdirSync(outDir, { recursive: true });

const started = Date.now();
const summaryPath = path.join(outDir, 'summary.json');
const htmlPath = path.join(outDir, 'obscura-dom.html');
const pdfPath = path.join(outDir, 'weasyprint-render.pdf');
const screenshotPath = path.join(outDir, 'weasyprint-render.png');
const videoPath = path.join(outDir, 'weasyprint-render.webm');
const checks = [];

for (const binary of ['weasyprint', 'magick', 'ffmpeg']) {
  const found = commandExists(binary);
  record(`${binary}_available`, found, {
    command: binary,
  });
}

const extracted = extractDOM();
record('obscura_dom_extracted', extracted.ok, {
  url,
  exitCode: extracted.exitCode,
  error: extracted.error,
  stdoutHead: extracted.stdoutHead,
  stderrHead: extracted.stderrHead,
  htmlBytes: extracted.html.length,
});

let pdfBytes = 0;
let screenshotBytes = 0;
let videoBytes = 0;
let videoFrame = { ok: false, error: 'renderer did not run' };

if (extracted.ok) {
  fs.writeFileSync(htmlPath, withBaseHref(extracted.html, url), 'utf8');
  const rendered = renderWithWeasyPrint();
  pdfBytes = rendered.pdfBytes;
  screenshotBytes = rendered.screenshotBytes;
  videoBytes = rendered.videoBytes;
  videoFrame = rendered.videoFrame;
  record('weasyprint_pdf_created', rendered.pdfOK, {
    renderer: 'weasyprint',
    pdfPath,
    bytes: pdfBytes,
    stderrHead: rendered.weasyprintStderr,
  });
  record('imagemagick_screenshot_created', rendered.screenshotOK, {
    renderer: 'imagemagick',
    screenshotPath,
    bytes: screenshotBytes,
    stderrHead: rendered.magickStderr,
  });
  record('ffmpeg_static_video_created', rendered.videoOK, {
    renderer: 'ffmpeg',
    videoPath,
    bytes: videoBytes,
    frame: videoFrame,
    note: 'Static-video fallback from the rendered page image. This is useful artifact evidence, not interaction recording parity.',
  });
}

const bridgeUsable = checks.every((check) => check.status === 'pass');
const summary = {
  objective: 'Probe whether Obscura-acquired DOM can be rendered to screenshot/video without Playwright or a full browser renderer.',
  obscuraPath: obscura,
  url,
  outDir,
  htmlPath,
  pdfPath,
  screenshotPath,
  videoPath,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  nativeObscuraVisual: false,
  externalRenderer: 'weasyprint-imagemagick-ffmpeg',
  bridgeUsable,
  notAFullPlaywrightReplacement: true,
  limitations: [
    'No browser JS runs after Obscura DOM extraction.',
    'CSS/layout fidelity is WeasyPrint fidelity, not Chromium/WebKit fidelity.',
    'Video is a static artifact generated from the rendered page image, not a live interaction recording.',
  ],
  checks,
};

fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  summaryPath,
  bridgeUsable,
  nativeObscuraVisual: false,
  notAFullPlaywrightReplacement: true,
  externalRenderer: summary.externalRenderer,
  checks: Object.fromEntries(checks.map((check) => [check.name, check.status])),
  artifacts: {
    htmlPath,
    pdfPath,
    screenshotPath,
    videoPath,
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

function renderWithWeasyPrint() {
  const weasy = spawnSync('weasyprint', [htmlPath, pdfPath], {
    encoding: 'utf8',
    timeout: 45_000,
  });
  const pdfOK = !weasy.error && weasy.status === 0 && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000;

  let magick = { status: null, stderr: '', error: null };
  if (pdfOK) {
    magick = spawnSync('magick', [
      '-density',
      '144',
      `${pdfPath}[0]`,
      '-background',
      'white',
      '-alpha',
      'remove',
      screenshotPath,
    ], {
      encoding: 'utf8',
      timeout: 45_000,
    });
  }
  const screenshotOK = !magick.error && magick.status === 0 && fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 1000;

  let ffmpeg = { status: null, stderr: '', error: null };
  if (screenshotOK) {
    ffmpeg = spawnSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-loop',
      '1',
      '-i',
      screenshotPath,
      '-t',
      '1',
      '-vf',
      'format=yuv420p',
      videoPath,
    ], {
      encoding: 'utf8',
      timeout: 45_000,
    });
  }
  const videoFrame = fs.existsSync(videoPath)
    ? analyzeFirstVideoFrame(videoPath)
    : { ok: false, error: 'no video file' };
  const videoBytes = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;

  return {
    pdfOK,
    pdfBytes: fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0,
    screenshotOK,
    screenshotBytes: fs.existsSync(screenshotPath) ? fs.statSync(screenshotPath).size : 0,
    videoOK: !ffmpeg.error && ffmpeg.status === 0 && videoBytes > 1000 && (videoFrame.ok ? videoFrame.visuallyNonBlank : true),
    videoBytes,
    videoFrame,
    weasyprintStderr: String(weasy.stderr || weasy.error?.message || '').slice(0, 500),
    magickStderr: String(magick.stderr || magick.error?.message || '').slice(0, 500),
  };
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
  if (ffmpeg.error) {
    return {
      ok: false,
      error: ffmpeg.error.message,
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

function commandExists(binary) {
  const result = spawnSync('sh', ['-lc', `command -v ${shellQuote(binary)} >/dev/null 2>&1`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return result.status === 0;
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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
