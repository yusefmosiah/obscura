# Choir Obscura Patch Report

Date: 2026-05-10

Branch: `choir/playwright-parity-audit-2026-05-10`

Fork target: `https://github.com/yusefmosiah/obscura`

Upstream base: `h4ckf0r0day/obscura@85739d3f6ab76e16ce71477ed5844f6bcaee80e0`

## Executive Summary

This branch preserves the local patch stack used to make Obscura duplicate the Playwright surface required by Choir's current QA workflow.

The result is useful, but it should not be treated as an upstream-ready monolith. The patch stack mixes generally useful browser/CDP compatibility work with Choir-specific audit pressure. Before submitting upstream PRs, split the work into small pieces and judge each one against Obscura's likely product vision.

Latest evidence:

- Full audit manifest: `/tmp/obscura-test/full-audit-pdf-complete-1778402200/manifest.json`
- Completion audit: `achieved: true`
- Capability audit: `71` pass, `0` fail
- Source inventory: `76` covered, `0` partial, `0` uncovered
- Product flow: authenticated `draft.choir-ip.com` prompt bar to VText passed

## What Changed

The patch touches 38 files after running `cargo fmt`:

```text
Cargo.lock
crates/obscura-browser/src/context.rs
crates/obscura-browser/src/lib.rs
crates/obscura-browser/src/page.rs
crates/obscura-cdp/Cargo.toml
crates/obscura-cdp/src/dispatch.rs
crates/obscura-cdp/src/domains/accessibility.rs
crates/obscura-cdp/src/domains/browser.rs
crates/obscura-cdp/src/domains/dom.rs
crates/obscura-cdp/src/domains/fetch.rs
crates/obscura-cdp/src/domains/input.rs
crates/obscura-cdp/src/domains/mod.rs
crates/obscura-cdp/src/domains/network.rs
crates/obscura-cdp/src/domains/page.rs
crates/obscura-cdp/src/domains/runtime.rs
crates/obscura-cdp/src/domains/storage.rs
crates/obscura-cdp/src/domains/target.rs
crates/obscura-cdp/src/lib.rs
crates/obscura-cdp/src/server.rs
crates/obscura-cdp/tests/concurrent_navigations.rs
crates/obscura-cli/src/main.rs
crates/obscura-cli/src/worker.rs
crates/obscura-dom/src/lib.rs
crates/obscura-dom/src/selector.rs
crates/obscura-dom/src/serialize.rs
crates/obscura-dom/src/tree.rs
crates/obscura-dom/src/tree_sink.rs
crates/obscura-js/js/bootstrap.js
crates/obscura-js/src/lib.rs
crates/obscura-js/src/module_loader.rs
crates/obscura-js/src/ops.rs
crates/obscura-js/src/runtime.rs
crates/obscura-net/src/blocklist.rs
crates/obscura-net/src/client.rs
crates/obscura-net/src/cookies.rs
crates/obscura-net/src/lib.rs
crates/obscura-net/src/robots.rs
crates/obscura-net/src/wreq_client.rs
```

Diff size at preservation time:

```text
38 files changed, 2717 insertions(+), 1044 deletions(-)
```

## Change Inventory

### CLI Contract Parity

Purpose: make documented and expected CLI flags behave consistently.

Changes:

- Propagate global `--user-agent` into `fetch`.
- Accept `serve --obey-robots` at the serve subcommand level.
- Keep fetch/scrape/help/output/user-agent/stealth/networkidle behavior covered by the audit.

Upstream alignment: likely good. These are conventional CLI contract fixes and should be easy to review separately.

### External Module Execution

Purpose: make deployed Vite/Svelte apps hydrate.

Changes:

- Load and evaluate actual external ES module bodies instead of evaluating an empty root module.
- Avoid repeated-module evaluation panics when the same deployed module URL is evaluated across repeated navigations.

Upstream alignment: likely good. This appears to be core browser correctness rather than Choir-specific behavior.

### Runtime Console Events

Purpose: support Playwright/Puppeteer-style console observation.

Changes:

- Capture JS `console.*` calls.
- Drain console messages through CDP.
- Emit `Runtime.consoleAPICalled`.

Upstream alignment: likely good. Console events are normal CDP behavior and useful outside Choir.

### CDP Compatibility Basics

Purpose: prevent common CDP clients from failing during initialization and lifecycle operations.

Changes:

- Implement `Schema.getDomains` with the accepted Obscura surface.
- Make `Browser.close` acknowledge before the connection closes.
- Accept common no-op initialization domains.
- Improve target/session metadata and lifecycle event behavior.

Upstream alignment: likely good, but schema contents should be kept honest. Avoid claiming methods are fully implemented when they are accepted stubs.

### Main-Document Fetch Interception

Purpose: make request interception useful for product tests and controlled navigation.

Changes:

- Let main-document navigation pause through `Fetch.requestPaused`.
- Support `Fetch.fulfillRequest` for fulfilled navigation HTML.
- Clear interception state correctly on `Fetch.disable`.
- Ensure preload scripts run early enough to observe app fetches.

Upstream alignment: likely good. This is useful CDP compatibility. The implementation should be reviewed for state-machine correctness.

### DOM Mutation And Input

Purpose: make modern app hydration and basic interaction work.

Changes:

- Fix DOM insertion and replacement bridges.
- Improve element lookup and synthetic coordinate hit-testing.
- Make `Input.dispatchMouseEvent` drive the selected target.
- Preserve keyboard input behavior.

Upstream alignment: mixed but probably valuable. Obscura is not a full layout engine, so input behavior should be documented as deterministic DOM hit-testing, not visual hit-testing.

### Network, Cookies, Robots, And Blocklist Plumbing

Purpose: support authenticated sessions and audit coverage.

Changes:

- Improve cookie/storage behavior used by CDP auth-state reuse.
- Adjust network/private-host validation paths.
- Add opt-in private-network access through `OBSCURA_ALLOW_PRIVATE_NETWORK=1`.
- Touch robots/blocklist modules as part of cleanup and integration.

Upstream alignment: mixed. Private-network access should remain explicitly opt-in because the default SSRF guard is correct for public scraping.

### WebAuthn Initialization

Purpose: let CDP clients initialize flows that expect the WebAuthn domain.

Changes:

- Accept `WebAuthn.enable` as a no-op acknowledgement.

Upstream alignment: questionable. This is useful for client compatibility, but it is not real virtual-authenticator support. If submitted upstream, the PR should be explicit that this is initialization compatibility only.

### PDF, Screenshot, And Screencast Bridge

Purpose: satisfy Playwright-style visual artifact requirements.

Changes:

- Implement `Page.printToPDF`.
- Implement `Page.captureScreenshot`.
- Implement `Page.startScreencast`, `Page.screencastFrameAck`, and `Page.stopScreencast`.
- Serialize Obscura's DOM, inject a visible marker, render with WeasyPrint/ImageMagick, and produce frame data for CDP clients.
- Support Playwright `page.screenshot()` and `recordVideo` over CDP with nonblank artifacts.

Upstream alignment: uncertain. This is the most controversial change. It is useful, but it is not a native browser renderer and should not be presented as full Chromium/WebKit visual fidelity. It may fit Obscura if framed as an optional evidence renderer, not a full layout engine.

## Audit Results

Command:

```sh
cd /Users/wiz/go-choir/frontend
npm run obscura:full-audit -- \
  --obscura /tmp/obscura-source/target/release/obscura \
  --base-url https://draft.choir-ip.com \
  --auth-state playwright/.auth/draft-choir-ip-com.storage.json \
  --out /tmp/obscura-test/full-audit-pdf-complete-1778402200 \
  --product-flow
```

Manifest summary:

```json
{
  "ok": true,
  "blockingItems": [],
  "exitCodes": {
    "setupStatus": 0,
    "auditStatus": 0,
    "sourceInventoryStatus": 0,
    "visualPrimitivesStatus": 1,
    "externalVisualBridgeStatus": 0,
    "lightVisualBridgeStatus": 0,
    "productVisualBridgeStatus": 0,
    "completionStatus": 0
  }
}
```

Completion checklist:

| Requirement | Result |
| --- | --- |
| Set up auth once and reuse it from Obscura | Pass |
| Duplicate Playwright screenshot capture | Pass |
| Duplicate Playwright video/screencast evidence | Pass |
| Drive deployed staging product flows on `draft.choir-ip.com` | Pass |
| Cover core browser control needed by Playwright-style tests | Pass |
| Cover documented Obscura CLI fetch/scrape behavior | Pass |
| Probe every implemented/accepted CDP method found in Obscura source | Pass |

## What This Proves

This branch proves that Obscura can be made to drive the currently required Choir QA loop:

- reuse cached auth,
- hit staging,
- submit the prompt bar,
- observe VText creation,
- execute modern Vite/Svelte app code,
- produce screenshot and video artifacts,
- provide enough CDP/CLI surface to satisfy the audit.

It also proves the audit harness can detect important false positives: earlier versions had blank video, stale source-inventory mapping, and product-flow gaps.

## What This Does Not Prove

This branch does not prove:

- clean upstream Obscura already supports this surface,
- WebAuthn/passkey ceremony is implemented,
- WeasyPrint/ImageMagick visual output is pixel-equivalent to Chromium,
- all Playwright tests can be blindly ported without semantic review,
- the patch stack is shaped correctly for upstream maintainers.

## Upstream PR Strategy

Do not submit this branch as one PR.

Recommended PR sequence:

1. CLI flag parity.
2. External ES module execution.
3. Repeat module evaluation safety.
4. Runtime console events.
5. `Schema.getDomains`, `Browser.close`, and initialization compatibility.
6. Main-document Fetch interception and preload timing.
7. DOM insertion and coordinate mouse input.
8. Private-network opt-in.
9. WebAuthn initialization acknowledgement, only if maintainers want no-op compatibility.
10. PDF/screenshot/screencast bridge, only after discussing whether an external renderer fits Obscura's vision.

## Alignment Assessment

Likely aligned with Obscura:

- real external module execution,
- console events,
- request interception,
- CLI contract fixes,
- target/session/schema compatibility,
- cookie/storage robustness,
- DOM mutation correctness.

Possibly aligned, but needs careful framing:

- coordinate hit-testing without a layout engine,
- private-network escape hatch,
- no-op WebAuthn compatibility,
- WeasyPrint-backed visual artifacts.

Likely not aligned if framed incorrectly:

- claiming full visual fidelity,
- treating no-op WebAuthn as passkey support,
- turning Obscura into a Chrome clone rather than a lightweight automation/extraction engine,
- merging Choir-specific test pressure into upstream without decomposition.

## Recommended Next Step

Keep this branch pushed as a preservation branch on the fork. Review the diff manually before opening any PRs.

Choir-specific audit material migrated after the initial preservation commit now lives under `docs/choir/` and `scripts/choir/`. Treat that material as evidence for review and future PR decomposition, not as proposed upstream source.

If upstream engagement looks worthwhile, open issues first or submit the least controversial PRs first: CLI parity, external module execution, and console events.
