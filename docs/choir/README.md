# Choir Audit Material

Date: 2026-05-10

This directory preserves the Choir-specific Obscura evaluation material that was
originally accumulated in the Choir repo and `/tmp/obscura-test`.

This is not an upstream-ready contribution bundle. Treat it as evidence and
working context for deciding which pieces should later become small, focused
Obscura PRs.

## Contents

- `obscura-capability-audit-2026-05-09.md` records the latest Choir capability
  audit result.
- `obscura-upstream-blockers-2026-05-10.md` summarizes the remaining upstream
  gaps and caveats.
- `obscura-upstream-issue-bundle-2026-05-10.md` groups the local fixes into
  potential upstream issue/PR areas.
- `patches/` contains patch fragments generated during the Obscura audit pass.
- `../../scripts/choir/` contains the Choir-side audit harness scripts.
- `artifacts/full-audit-pdf-complete-1778402200/` contains sanitized JSON
  summaries from the latest full audit. Large temporary videos, screenshots,
  PDFs, logs, raw auth state, and other bulky or sensitive artifacts were not
  committed.

## Important Caveats

- The scripts are Choir integration harnesses, not generic Obscura examples.
- Some scripts assume a Choir frontend checkout, `@playwright/test`, and a
  reachable `draft.choir-ip.com` deployment.
- The sanitized JSON artifacts redact emails, user IDs, and local auth-state
  paths. They preserve counts, status, command shape, and capability evidence.
- The patch fragments are for review. The canonical code state is the branch
  itself.

