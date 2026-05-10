#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const obscura = path.resolve(args.obscura || process.env.OBSCURA_BIN || '/tmp/obscura-source/target/release/obscura');
const outDir = path.resolve(args.out || process.env.OBSCURA_VISUAL_PROBE_DIR || path.join('/tmp', 'obscura-test', `visual-primitives-${Date.now()}`));
const summaryPath = path.join(outDir, 'summary.json');

fs.mkdirSync(outDir, { recursive: true });

const htmlPath = path.join(outDir, 'visual-primitives.html');
fs.writeFileSync(htmlPath, `<!doctype html>
<html>
  <head>
    <style>
      #stylesheet-box {
        position: absolute;
        left: 33px;
        top: 44px;
        width: 155px;
        height: 66px;
        background: rgb(0, 128, 0);
      }
    </style>
  </head>
  <body>
    <div id="inline-box" style="position:absolute;left:10px;top:20px;width:123px;height:45px;background:rgb(255,0,0);color:white">Hello</div>
    <div id="stylesheet-box">Styled by stylesheet</div>
    <canvas id="c" width="10" height="10"></canvas>
  </body>
</html>`, 'utf8');

const evalSource = `(() => {
  const inline = document.querySelector('#inline-box');
  const sheet = document.querySelector('#stylesheet-box');
  const canvas = document.querySelector('#c');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(255,0,0)';
  ctx.fillRect(0, 0, 10, 10);
  const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
  };
  const computed = (el) => {
    const s = getComputedStyle(el);
    return {
      background: s.background,
      backgroundColor: s.backgroundColor,
      color: s.color,
      position: s.position,
      width: s.width,
      height: s.height,
      left: s.left,
      top: s.top,
    };
  };
  return JSON.stringify({
    inlineRect: rect(inline),
    stylesheetRect: rect(sheet),
    inlineComputed: computed(inline),
    stylesheetComputed: computed(sheet),
    offset: {
      inlineWidth: inline.offsetWidth,
      inlineHeight: inline.offsetHeight,
      stylesheetWidth: sheet.offsetWidth,
      stylesheetHeight: sheet.offsetHeight,
    },
    styleSheetsLength: document.styleSheets.length,
    canvasPixel: pixel,
    canvasDataUrlHead: canvas.toDataURL().slice(0, 80),
  });
})()`;

const started = Date.now();
const result = spawnSync(obscura, ['fetch', pathToFileURL(htmlPath).href, '--eval', evalSource, '--quiet'], {
  encoding: 'utf8',
  timeout: 30_000,
});

const parsed = parseObscuraJSON(result.stdout || '');
const checks = [];

record('obscura_fetch_eval_runs', !result.error && result.status === 0 && !!parsed, {
  exitCode: result.status ?? null,
  error: result.error ? result.error.message : null,
  stdoutHead: String(result.stdout || '').slice(0, 500),
  stderrHead: String(result.stderr || '').slice(0, 500),
});

const canvasPixelsWork = sameArray(parsed?.canvasPixel, [255, 0, 0, 255]);
record('canvas_2d_pixels_work', canvasPixelsWork, {
  canvasPixel: parsed?.canvasPixel || null,
  canvasDataUrlHead: parsed?.canvasDataUrlHead || '',
});

const inlineLayoutReflectsCSS = approx(parsed?.inlineRect?.left, 10) &&
  approx(parsed?.inlineRect?.top, 20) &&
  approx(parsed?.inlineRect?.width, 123) &&
  approx(parsed?.inlineRect?.height, 45);
record('inline_style_layout_reflects_css', inlineLayoutReflectsCSS, {
  inlineRect: parsed?.inlineRect || null,
  expected: { left: 10, top: 20, width: 123, height: 45 },
});

const inlineComputedReflectsCSS = /255,\s*0,\s*0|red/i.test(`${parsed?.inlineComputed?.backgroundColor || ''} ${parsed?.inlineComputed?.background || ''}`);
record('inline_computed_style_reflects_css', inlineComputedReflectsCSS, {
  inlineComputed: parsed?.inlineComputed || null,
});

const stylesheetRulesAvailable = Number(parsed?.styleSheetsLength || 0) > 0;
record('stylesheet_rules_available', stylesheetRulesAvailable, {
  styleSheetsLength: parsed?.styleSheetsLength ?? null,
  stylesheetComputed: parsed?.stylesheetComputed || null,
});

const stylesheetLayoutReflectsCSS = approx(parsed?.stylesheetRect?.left, 33) &&
  approx(parsed?.stylesheetRect?.top, 44) &&
  approx(parsed?.stylesheetRect?.width, 155) &&
  approx(parsed?.stylesheetRect?.height, 66);
record('stylesheet_layout_reflects_css', stylesheetLayoutReflectsCSS, {
  stylesheetRect: parsed?.stylesheetRect || null,
  expected: { left: 33, top: 44, width: 155, height: 66 },
});

const visualScreenshotPolyfillViable = canvasPixelsWork &&
  inlineLayoutReflectsCSS &&
  inlineComputedReflectsCSS &&
  stylesheetRulesAvailable &&
  stylesheetLayoutReflectsCSS;

const summary = {
  objective: 'Probe whether Obscura has enough in-page visual primitives for a trustworthy screenshot polyfill.',
  obscuraPath: obscura,
  outDir,
  htmlPath,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  raw: parsed,
  checks,
  visualScreenshotPolyfillViable,
  ok: visualScreenshotPolyfillViable,
};

fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({
  summaryPath,
  ok: summary.ok,
  visualScreenshotPolyfillViable,
  checks: Object.fromEntries(checks.map((check) => [check.name, check.status])),
}, null, 2));

process.exit(visualScreenshotPolyfillViable ? 0 : 1);

function record(name, passed, details = {}) {
  checks.push({
    name,
    status: passed ? 'pass' : 'fail',
    ...details,
  });
}

function parseObscuraJSON(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const line = trimmed.split(/\r?\n/).reverse().find((candidate) => candidate.trim().startsWith('{'));
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

function approx(actual, expected) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= 1;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
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
