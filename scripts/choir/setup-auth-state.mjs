#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const args = parseArgs(process.argv.slice(2));
const baseURL = args.baseUrl || process.env.CHOIR_DEPLOYED_BASE_URL || 'https://draft.choir-ip.com';
const defaultStatePath = path.join('playwright', '.auth', `${new URL(baseURL).hostname.replaceAll('.', '-')}.storage.json`);
const statePath = path.resolve(args.out || process.env.CHOIR_AUTH_STATE || defaultStatePath);
const metaPath = path.resolve(process.env.CHOIR_AUTH_META || statePath.replace(/\.json$/i, '.meta.json'));
const lockPath = path.resolve(process.env.CHOIR_AUTH_LOCK || `${statePath}.lock`);
const force = Boolean(args.force || process.env.CHOIR_AUTH_FORCE);
const email = args.email || process.env.CHOIR_AUTH_EMAIL || `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const lockTimeoutMs = Number(process.env.CHOIR_AUTH_LOCK_TIMEOUT_MS || args.lockTimeoutMs || 30_000);

const helpersRoot = path.resolve('tests', 'helpers');
const [{ registerPasskey, getSession }, { setupVirtualAuthenticator, removeVirtualAuthenticator }] = await Promise.all([
  import(pathToFileURL(path.join(helpersRoot, 'auth.js')).href),
  import(pathToFileURL(path.join(helpersRoot, 'webauthn.js')).href),
]);

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

async function validateExistingState({ ignoreForce = false } = {}) {
  if ((force && !ignoreForce) || !fs.existsSync(statePath)) return false;

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();
  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const session = await getSession(page, baseURL);
    if (!session.authenticated) return false;

    await context.storageState({ path: statePath });
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ email: session.user?.email || null, baseURL, user: session.user || null }, null, 2),
      'utf8',
    );
    console.log(JSON.stringify({
      ok: true,
      reused: true,
      baseURL,
      statePath,
      metaPath,
      user: session.user || null,
    }, null, 2));
    return true;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReusableState() {
  const deadline = Date.now() + lockTimeoutMs;
  while (Date.now() < deadline) {
    if (await validateExistingState({ ignoreForce: true })) return true;
    await sleep(250);
  }
  return false;
}

async function createState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const { client, authenticatorId } = await setupVirtualAuthenticator(page);

  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await registerPasskey(page, email, baseURL);
    await page.locator('[data-desktop], [data-shell]').first().waitFor({
      state: 'visible',
      timeout: 45_000,
    }).catch(() => {});

    const session = await getSession(page, baseURL);
    if (!session.authenticated) {
      throw new Error('passkey registration completed but /auth/session is not authenticated');
    }

    await context.storageState({ path: statePath });
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ email, baseURL, user: session.user || null }, null, 2),
      'utf8',
    );
    console.log(JSON.stringify({
      ok: true,
      reused: false,
      baseURL,
      statePath,
      metaPath,
      email,
      user: session.user || null,
    }, null, 2));
  } finally {
    await removeVirtualAuthenticator(client, authenticatorId).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (!(await validateExistingState())) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    if (await waitForReusableState()) process.exit(0);
    throw new Error(`timed out waiting for shared auth state lock: ${lockPath}`);
  }

  try {
    if (!(await validateExistingState())) {
      await createState();
    }
  } finally {
    if (lockFd !== null) {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
    }
  }
}
