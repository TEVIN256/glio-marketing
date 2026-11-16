# Glio

Arabic-first AI ad operations for Saudi businesses and the agencies that serve them. Connect TikTok, share a post, set a goal and budget, approve the plan once, and Glio's agents run it within that budget and report back. TikTok first; Snapchat, Meta and Google follow one at a time.

## Status

**M1: skeleton and tenancy.** The database foundation is in place and tested: workspaces (business or agency), clients, team roles, ad accounts, server-only credentials, approval requests and an append-only audit log, with row-level security on every table. No app UI or TikTok connection yet.

## Layout

```
supabase/migrations/   schema (plain SQL, applied in order)
packages/db/test/      database tests (tenancy gate) + Supabase auth shim for local runs
docs/                  DECISIONS.md, RUNBOOK.md, COMPLIANCE.md
.github/workflows/     CI: type check + tests against a throwaway Postgres
```

## Getting started

See [docs/RUNBOOK.md](docs/RUNBOOK.md).
