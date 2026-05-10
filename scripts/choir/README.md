# Choir Obscura Audit Scripts

These scripts were migrated from `go-choir/frontend/scripts` so the Obscura
fork preserves the audit harness next to the patched browser implementation.

They are not normal Obscura CLI examples. Most of them assume a Choir frontend
checkout, Playwright dev dependencies, and sometimes a live
`https://draft.choir-ip.com` deployment.

Use them as regression/evidence tools while reviewing this branch. If any part
belongs upstream, extract a minimal Obscura-native test or example rather than
submitting these Choir-specific scripts directly.

