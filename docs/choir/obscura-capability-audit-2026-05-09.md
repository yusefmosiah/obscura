# Obscura Capability Audit

Date: 2026-05-09

Latest update: 2026-05-10

Objective: determine whether Obscura can duplicate the Playwright QA surface we need for Choir, including reusable auth, screenshots, video, deployed draft QA, and broad CDP/CLI surface coverage.

## Decision

Patched Obscura now passes the local completion gate as a Playwright replacement candidate for the audited Choir surface.

This is not clean upstream Obscura. The passing result depends on the local patch stack in `/tmp/obscura-source`, including Vite module execution, CDP event fixes, DOM/input fixes, request interception, reusable auth support, private-network test access, WebAuthn initialization acknowledgement, and a DOM-to-WeasyPrint/ImageMagick visual bridge for PDF/screenshot/screencast.

## Latest Passing Audit

Command:

```sh
cd frontend
npm run obscura:full-audit -- \
  --obscura /tmp/obscura-source/target/release/obscura \
  --base-url https://draft.choir-ip.com \
  --auth-state playwright/.auth/draft-choir-ip-com.storage.json \
  --out /tmp/obscura-test/full-audit-pdf-complete-1778402200 \
  --product-flow
```

Result:

- Manifest: `/tmp/obscura-test/full-audit-pdf-complete-1778402200/manifest.json`
- Completion audit: `achieved: true`
- Manifest status: `ok: true`
- Capability audit: `71` pass, `0` fail
- Source inventory: `76` covered, `0` partial, `0` uncovered
- Product flow: authenticated `draft.choir-ip.com` prompt bar submitted, VText opened, marker preserved

## Requirement Checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| Auth caching | Pass | `auth:setup` creates/reuses Playwright `storageState`; Obscura loads cookies and `/auth/session` succeeds. |
| Screenshots | Pass | `cdp_page_capture_screenshot` and `playwright_cdp_screenshot` pass. |
| Video | Pass | `cdp_screencast_video_primitives` and `playwright_cdp_video_nonblank` pass. |
| PDF | Pass | `cdp_page_print_to_pdf` passes through the same DOM-to-WeasyPrint path. |
| Local/dev URLs | Pass | Audit launches Obscura with `OBSCURA_ALLOW_PRIVATE_NETWORK=1`; private-network access remains opt-in. |
| WebAuthn init | Pass | `WebAuthn.enable` is accepted. This is initialization parity, not a full virtual-authenticator implementation. |
| Draft staging product flow | Pass | Optional product-flow probe hits real `POST /api/prompt-bar` and opens the resulting VText. |
| Core browser control | Pass | Navigation, DOM, Runtime, console events, cookies/storage, Fetch interception, keyboard, and mouse probes pass. |
| CLI surface | Pass | Fetch/scrape/help/output/user-agent/stealth/networkidle probes pass. |
| Source-surface coverage | Pass | Every implemented/accepted CDP method found by the inventory has direct passing evidence. |

## Important Caveats

- Clean upstream still does not provide this result. The local source tree is patched.
- The visual path is not a native browser layout engine. It serializes Obscura DOM and renders with WeasyPrint/ImageMagick; this is useful evidence, but lower fidelity than Chromium/WebKit.
- WebAuthn support is only enough for CDP initialization. We still rely on Playwright to create passkey-backed auth state, then reuse that state from Obscura.
- The product-flow probe is intentionally narrow. It proves prompt bar to VText creation on staging, not deep research/coding quality.
- Linux x86_64/NixOS packaging still needs a proper Nix path. Earlier Node B smoke passed under `steam-run`, but production should use a real package, `nix-ld`, or source/Nix build.

## Current Use

Use Obscura for:

- authenticated draft product-flow probes,
- lightweight server-side Browser app experiments,
- extraction/acquisition rungs,
- nonvisual CDP/DOM/runtime automation,
- visual smoke artifacts where WeasyPrint-level fidelity is acceptable.

Keep Playwright available until the patched Obscura runtime is packaged reproducibly and we decide whether WeasyPrint-level visual fidelity is sufficient for each QA class.
