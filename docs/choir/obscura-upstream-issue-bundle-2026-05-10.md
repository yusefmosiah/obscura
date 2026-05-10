# Obscura Upstream Issue Bundle

Date: 2026-05-10

Purpose: upstream-ready summary of the local patches required for Choir's Obscura Playwright-parity proof.

## Latest Evidence

Patched local source:

- Source: `/tmp/obscura-source`
- Binary: `/tmp/obscura-source/target/release/obscura`
- Audit manifest: `/tmp/obscura-test/full-audit-pdf-complete-1778402200/manifest.json`
- Completion audit: `achieved: true`
- Capability audit: `71` pass, `0` fail
- Source inventory: `76` covered, `0` partial, `0` uncovered

## Patch Areas

1. External module execution.

   Obscura fetched deployed Vite module scripts but evaluated an empty root module body. The local patch loads the actual external module source.

2. Repeat module evaluation.

   Repeated navigations against the same deployed module URL could panic with an already-evaluated module. The local patch gives top-level entrypoints unique specifiers while preserving source URL provenance.

3. Runtime console events.

   Console output is drained from the JS runtime and emitted as `Runtime.consoleAPICalled`.

4. CLI parity.

   Global `--user-agent` reaches `fetch`, and `serve --obey-robots` is accepted.

5. Main-document Fetch interception.

   Navigation requests can pause through `Fetch.requestPaused`, then materialize fulfilled HTML through `Fetch.fulfillRequest`.

6. Schema and Browser lifecycle.

   `Schema.getDomains` returns Obscura's accepted surface, and `Browser.close` acknowledges before closing.

7. Preload timing and Fetch disable.

   `Page.addScriptToEvaluateOnNewDocument` runs before page scripts, and `Fetch.disable` clears runtime/page interception state.

8. DOM insertion and mouse input.

   `insertBefore`/`replaceChild` bridge bugs are fixed, coordinate hit-testing is deterministic enough for simple controls, and mouse events drive the selected target.

9. Visual output.

   `Page.printToPDF`, `Page.captureScreenshot`, `Page.startScreencast`, `Page.screencastFrameAck`, and `Page.stopScreencast` are implemented through DOM serialization plus WeasyPrint/ImageMagick-rendered frames. Playwright `page.screenshot()` and `recordVideo` over CDP now pass the nonblank artifact checks.

10. Private-network test access.

   The default SSRF/private-IP guard remains, but `OBSCURA_ALLOW_PRIVATE_NETWORK=1` allows localhost/dev-server QA.

11. WebAuthn initialization.

   `WebAuthn.enable` is acknowledged so CDP clients do not fail initialization. This is not a full virtual-authenticator implementation.

## Non-Negotiable Caveats

- Do not claim clean upstream parity from this evidence. The passing result is from the patched local source tree.
- Do not treat WebAuthn init acknowledgement as passkey ceremony support.
- Do not treat WeasyPrint/ImageMagick output as pixel-identical browser rendering.
- Do not remove Playwright from the toolchain until Obscura packaging and fidelity decisions are made deliberately.

## Repro

```sh
cd /Users/wiz/go-choir/frontend
npm run obscura:full-audit -- \
  --obscura /tmp/obscura-source/target/release/obscura \
  --base-url https://draft.choir-ip.com \
  --auth-state playwright/.auth/draft-choir-ip-com.storage.json \
  --out /tmp/obscura-test/full-audit-pdf-complete-1778402200 \
  --product-flow
```

Expected patched result: zero exit with `ok: true` in the manifest.
