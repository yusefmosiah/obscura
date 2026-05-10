# Obscura Upstream Blockers

Date: 2026-05-10

Purpose: concise status for what blocks clean upstream Obscura from replacing Playwright for Choir QA.

## Current Status

The local patched Obscura build passes Choir's full audit:

- Full audit manifest: `/tmp/obscura-test/full-audit-pdf-complete-1778402200/manifest.json`
- Completion audit: `achieved: true`
- Capability audit: `71` pass, `0` fail
- Source inventory: `76` covered, `0` partial, `0` uncovered

Clean upstream is still not equivalent to the patched build. The blockers below are upstream gaps or packaging decisions, not blockers in the local proof.

## Upstream Gaps Closed Locally

- External ES modules: fixed locally so Vite/Svelte bundles execute instead of loading an empty module body.
- Repeated module evaluation: fixed locally so repeated deployed bundle evaluation does not panic the Deno module map.
- Runtime console events: fixed locally so `Runtime.consoleAPICalled` fires.
- CLI parity: fixed locally for global/user-agent propagation and `serve --obey-robots`.
- Main-document Fetch interception: fixed locally for `Fetch.requestPaused` and `Fetch.fulfillRequest` on navigation.
- Schema and Browser close: fixed locally for `Schema.getDomains` and reliable `Browser.close` response flushing.
- Preload timing and `Fetch.disable`: fixed locally for product fetch tracing and stale interception cleanup.
- DOM insertion and coordinate mouse: fixed locally for deployed desktop hydration and click probes.
- Screenshot/video/PDF: fixed locally through DOM serialization plus WeasyPrint/ImageMagick frame production.
- Private localhost/dev access: fixed locally through opt-in `OBSCURA_ALLOW_PRIVATE_NETWORK=1`.
- WebAuthn init: fixed locally as a no-op CDP initialization acknowledgement.

## Remaining Engineering Caveats

### Visual Fidelity

The passing screenshot/video/PDF path is not a native browser renderer. It serializes Obscura's DOM and renders with WeasyPrint/ImageMagick.

This is acceptable for some smoke artifacts and extraction previews. It is not equivalent to Chromium/WebKit layout fidelity for detailed visual QA.

### Auth Bootstrap

Obscura can reuse cached auth state. It does not yet replace Playwright's passkey virtual-authenticator setup.

Current flow:

```sh
cd frontend
npm run auth:setup -- \
  --base-url https://draft.choir-ip.com \
  --out playwright/.auth/draft-choir-ip-com.storage.json
```

Then Obscura consumes that storage state during audits.

### NixOS Packaging

The Linux x86_64 release binary can run on Node B under a temporary FHS wrapper, but production should not depend on `steam-run`.

Preferred next steps:

- package Obscura with Nix,
- enable/use `nix-ld`, or
- build from source inside the target microVM image.

## Repro Command

```sh
cd frontend
npm run obscura:full-audit -- \
  --obscura /tmp/obscura-source/target/release/obscura \
  --base-url https://draft.choir-ip.com \
  --auth-state playwright/.auth/draft-choir-ip-com.storage.json \
  --out /tmp/obscura-test/full-audit-pdf-complete-1778402200 \
  --product-flow
```

Expected patched result: zero exit, manifest `ok: true`, completion audit `achieved: true`.
