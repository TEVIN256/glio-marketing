# Glio

Arabic-first AI ad operations for Saudi businesses and the agencies that serve them. Connect TikTok, share a post, set a goal and budget, approve the plan once, and Glio's agents run it within that budget and report back. TikTok first; Snapchat, Meta and Google follow one at a time.

## Status

- **M1 (done): skeleton and tenancy.** Workspaces (business or agency), clients, team roles, ad accounts, server-only credentials, approval requests and an append-only audit log, with row-level security on every table. Applied to the Supabase project (Frankfurt).
- **M5 part 2 (built): web app.** Arabic-first (RTL) sign-up/login, workspaces, clients, client dashboard with report generation, stored reports, and a provenance page for every figure showing the original platform responses. Demo mode loads synthetic TikTok numbers.
- **M5 part 1 (built, on synthetic data): reports and Arabic AI commentary.** Per-client report snapshots (figures with exact values, Arabic/English display and raw-payload provenance) and a Claude-written Arabic + English summary whose every number is validated against the figures, with retry and a deterministic template fallback. 
- **M3 (built, on synthetic data): reconciliation.** After a sync, Glio's stored totals are compared with TikTok's own account totals for the same dates; drift above 0.5% is flagged, every check is stored (append-only) and logged.
- **M2 (built, on synthetic data): TikTok connector and sync.** Daily campaign reports fetched page by page with retries, raw responses archived immutably with a fingerprint, metrics upserted idempotently in minor units. No live TikTok call yet: the API details are marked `TODO(verify)` until TikTok approves the developer app. No app UI yet.

## Layout

```
apps/web/              Next.js web app (Arabic-first, server-rendered)
supabase/migrations/   schema (plain SQL, applied in order)
packages/core/         money (exact minor units), canonical JSON hashing, UTC date helpers
packages/connectors/   platform connector interface + TikTok (read-only)
packages/sync/         sync engine (pagination, retries, raw archive, idempotent upserts) + reconciliation
packages/reports/      report figures, formatting, commentary validator, Claude commentary, snapshots
packages/db/test/      database tests (tenancy gate) + Supabase auth shim for local runs
docs/                  DECISIONS.md, RUNBOOK.md, COMPLIANCE.md
.github/workflows/     CI: type check + tests against a throwaway Postgres
```

## Getting started

See [docs/RUNBOOK.md](docs/RUNBOOK.md).
