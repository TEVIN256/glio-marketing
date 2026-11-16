# Glio

Arabic-first AI ad operations for Saudi businesses and the agencies that serve them. Connect TikTok, share a post, set a goal and budget, approve the plan once, and Glio's agents run it within that budget and report back. TikTok first; Snapchat, Meta and Google follow one at a time.

## Status

- **M1 (done): skeleton and tenancy.** Workspaces (business or agency), clients, team roles, ad accounts, server-only credentials, approval requests and an append-only audit log, with row-level security on every table. Applied to the Supabase project (Frankfurt).
- **M2 (built, on synthetic data): TikTok connector and sync.** Daily campaign reports fetched page by page with retries, raw responses archived immutably with a fingerprint, metrics upserted idempotently in minor units. No live TikTok call yet: the API details are marked `TODO(verify)` until TikTok approves the developer app. No app UI yet.

## Layout

```
supabase/migrations/   schema (plain SQL, applied in order)
packages/core/         money (exact minor units), canonical JSON hashing, UTC date helpers
packages/connectors/   platform connector interface + TikTok (read-only)
packages/sync/         sync engine: pagination, retries, raw archive, idempotent metric upserts
packages/db/test/      database tests (tenancy gate) + Supabase auth shim for local runs
docs/                  DECISIONS.md, RUNBOOK.md, COMPLIANCE.md
.github/workflows/     CI: type check + tests against a throwaway Postgres
```

## Getting started

See [docs/RUNBOOK.md](docs/RUNBOOK.md).
