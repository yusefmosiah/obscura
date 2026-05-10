#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const obscura = path.resolve(args.obscura || process.env.OBSCURA_LINUX_BIN || '/tmp/obscura-test/linux-x86_64/obscura');
const outDir = path.resolve(args.out || process.env.OBSCURA_LINUX_SMOKE_DIR || path.join('/tmp', 'obscura-test', `linux-smoke-${Date.now()}`));
const summaryPath = path.join(outDir, 'summary.json');
const platform = os.platform();
const arch = os.arch();

fs.mkdirSync(outDir, { recursive: true });

const summary = {
  objective: 'Linux x86_64 Obscura release smoke test for Choir microVM viability',
  obscuraPath: obscura,
  outDir,
  platform,
  arch,
  startedAt: new Date().toISOString(),
  checks: [],
};

function record(check) {
  summary.checks.push(check);
}

function finish(exitCode) {
  summary.finishedAt = new Date().toISOString();
  summary.summary = summary.checks.reduce((counts, check) => {
    counts[check.status] = (counts[check.status] || 0) + 1;
    return counts;
  }, {});
  summary.ok = exitCode === 0;
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({
    summaryPath,
    ok: summary.ok,
    platform,
    arch,
    counts: summary.summary,
  }, null, 2));
  process.exit(exitCode);
}

if (platform !== 'linux' || arch !== 'x64') {
  record({
    name: 'linux_x86_64_runtime',
    status: 'skip',
    note: 'Run this script inside a Linux x86_64 Choir microVM or equivalent host.',
  });
  finish(2);
}

if (!fs.existsSync(obscura)) {
  record({
    name: 'obscura_binary_present',
    status: 'fail',
    note: `Missing Obscura binary: ${obscura}`,
  });
  finish(1);
}

runCheck('obscura_binary_executable', [obscura, '--help'], ({ status, stdout, stderr, elapsedMs }) => ({
  name: 'obscura_binary_executable',
  status,
  elapsedMs,
  stdoutHead: stdout.slice(0, 500),
  stderrHead: stderr.slice(0, 500),
}));

runCheck('fetch_example_title', [obscura, 'fetch', 'https://example.com', '--eval', 'document.title', '--quiet'], ({ status, stdout, stderr, elapsedMs }) => ({
  name: 'fetch_example_title',
  status: status === 'pass' && stdout.includes('Example Domain') ? 'pass' : 'fail',
  elapsedMs,
  stdoutHead: stdout.slice(0, 500),
  stderrHead: stderr.slice(0, 500),
}));

runCheck('fetch_text_dump', [obscura, 'fetch', 'https://example.com', '--dump', 'text', '--quiet'], ({ status, stdout, stderr, elapsedMs }) => ({
  name: 'fetch_text_dump',
  status: status === 'pass' && stdout.includes('Example Domain') ? 'pass' : 'fail',
  elapsedMs,
  stdoutHead: stdout.slice(0, 500),
  stderrHead: stderr.slice(0, 500),
}));

await runServeCheck();

const hasFailure = summary.checks.some((check) => check.status === 'fail');
finish(hasFailure ? 1 : 0);

function runCheck(name, command, buildRecord) {
  const started = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const elapsedMs = Date.now() - started;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const status = !result.error && result.status === 0 ? 'pass' : 'fail';
  record(buildRecord({
    name,
    status,
    stdout,
    stderr,
    elapsedMs,
    exitCode: result.status ?? null,
    error: result.error ? result.error.message : null,
  }));
}

async function runServeCheck() {
  const started = Date.now();
  const port = 19_000 + Math.floor(Math.random() * 1000);
  const logPath = path.join(outDir, 'obscura-serve.log');
  const log = fs.openSync(logPath, 'w');
  const proc = spawn(obscura, ['serve', '--port', String(port), '--workers', '1'], {
    stdio: ['ignore', log, log],
  });

  try {
    let version = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          version = await response.json();
          break;
        }
      } catch {
        // Keep polling until the server binds or the deadline expires.
      }
      await sleep(1000);
    }

    record({
      name: 'serve_json_version',
      status: version?.webSocketDebuggerUrl ? 'pass' : 'fail',
      elapsedMs: Date.now() - started,
      version: version || null,
      logPath,
    });
  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    if (!proc.killed) proc.kill('SIGKILL');
    fs.closeSync(log);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
