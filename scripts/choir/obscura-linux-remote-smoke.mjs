#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const host = args.host || process.env.OBSCURA_REMOTE_HOST || 'node-b';
const tarball = path.resolve(args.tarball || process.env.OBSCURA_LINUX_TARBALL || '/tmp/obscura-test/obscura-x86_64-linux.tar.gz');
const outDir = path.resolve(args.out || process.env.OBSCURA_LINUX_REMOTE_SMOKE_DIR || path.join('/tmp', 'obscura-test', `linux-remote-smoke-${Date.now()}`));
const remoteDir = args.remoteDir || `/tmp/obscura-linux-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runnerPrefix = args.runnerPrefix || process.env.OBSCURA_REMOTE_RUNNER_PREFIX || '';
const summaryPath = path.join(outDir, 'summary.json');

fs.mkdirSync(outDir, { recursive: true });

const summary = {
  objective: 'Remote Linux x86_64 Obscura release smoke test for Choir microVM viability',
  host,
  tarball,
  remoteDir,
  runnerPrefix,
  outDir,
  localPlatform: os.platform(),
  localArch: os.arch(),
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
    counts: summary.summary,
  }, null, 2));
  process.exit(exitCode);
}

if (!fs.existsSync(tarball)) {
  record({ name: 'tarball_present', status: 'fail', note: `Missing tarball: ${tarball}` });
  finish(1);
}
record({ name: 'tarball_present', status: 'pass', bytes: fs.statSync(tarball).size });

let failed = false;

const prepare = run('prepare_remote_tmp', [
  'ssh',
  '-o',
  'BatchMode=yes',
  host,
  `rm -rf ${shellQuote(remoteDir)} && mkdir -p ${shellQuote(remoteDir)}`,
]);
record(commandCheck('prepare_remote_tmp', prepare));
failed ||= prepare.status !== 0;

if (!failed) {
  const copy = run('copy_tarball', [
    'scp',
    '-q',
    tarball,
    `${host}:${remoteDir}/obscura-x86_64-linux.tar.gz`,
  ]);
  record(commandCheck('copy_tarball', copy));
  failed ||= copy.status !== 0;
}

if (!failed) {
  const remoteScript = `
set -eu
cd ${shellQuote(remoteDir)}
tar -xzf obscura-x86_64-linux.tar.gz
chmod +x obscura obscura-worker 2>/dev/null || true
run_obscura() {
  ${runnerPrefix ? `${runnerPrefix} ./obscura` : './obscura'} "$@"
}
printf 'platform=%s\\n' "$(uname -s)"
printf 'arch=%s\\n' "$(uname -m)"
printf 'help_start\\n'
run_obscura --help | sed -n '1,12p'
printf 'help_end\\n'
printf 'fetch_title_start\\n'
run_obscura fetch https://example.com --eval document.title --quiet
printf 'fetch_title_end\\n'
printf 'fetch_text_start\\n'
run_obscura fetch https://example.com --dump text --quiet | sed -n '1,8p'
printf 'fetch_text_end\\n'
printf 'serve_start\\n'
port=$((19000 + ($$ % 1000)))
run_obscura serve --port "$port" --workers 1 > serve.log 2>&1 &
serve_pid=$!
serve_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS "http://127.0.0.1:$port/json/version" > serve-version.json; then
    serve_ok=1
    break
  fi
  sleep 1
done
if [ "$serve_ok" -ne 1 ]; then
  printf 'serve_failed\\n'
  sed -n '1,80p' serve.log || true
  kill "$serve_pid" 2>/dev/null || true
  wait "$serve_pid" 2>/dev/null || true
  exit 1
fi
sed -n '1,8p' serve-version.json
kill "$serve_pid" 2>/dev/null || true
wait "$serve_pid" 2>/dev/null || true
printf 'serve_json_version_ok\\n'
`;
  const smoke = run('remote_obscura_smoke', [
    'ssh',
    '-o',
    'BatchMode=yes',
    host,
    'sh',
    '-s',
  ], { input: remoteScript });
  const stdout = smoke.stdout || '';
  record({
    ...commandCheck('remote_obscura_smoke', smoke),
    platform: matchValue(stdout, /^platform=(.+)$/m),
    arch: matchValue(stdout, /^arch=(.+)$/m),
    titleOK: /Example Domain/.test(stdout),
    serveOK: /serve_json_version_ok/.test(stdout),
    stdoutHead: stdout.slice(0, 2000),
  });
  failed ||= smoke.status !== 0 || !/arch=x86_64/.test(stdout) || !/Example Domain/.test(stdout) || !/serve_json_version_ok/.test(stdout);
}

const cleanup = run('cleanup_remote_tmp', [
  'ssh',
  '-o',
  'BatchMode=yes',
  host,
  `rm -rf ${shellQuote(remoteDir)}`,
]);
record(commandCheck('cleanup_remote_tmp', cleanup));

finish(failed ? 1 : 0);

function run(label, argv, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    input: options.input || undefined,
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    label,
    command: argv.join(' '),
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    elapsedMs: Date.now() - startedAt,
  };
}

function commandCheck(name, result) {
  return {
    name,
    status: !result.error && result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status,
    signal: result.signal,
    error: result.error,
    stderrHead: result.stderr.slice(0, 1000),
    elapsedMs: result.elapsedMs,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function matchValue(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : null;
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
