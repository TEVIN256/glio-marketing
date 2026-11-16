# Runbook

## Requirements

- Node 22 (`.nvmrc`) and pnpm (`corepack enable`)
- A local Postgres 16 for tests (Docker or installed)

## Install

```bash
pnpm install
```

## Run the tests

The tests create and drop throwaway databases, so point them at a **local** Postgres, never at Supabase (the harness refuses Supabase hosts).

Start Postgres with Docker:

```bash
docker run -d --name glio-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 postgres:16
```

Then:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm test
```

```bash
pnpm typecheck
```

## Apply migrations to Supabase

Migrations live in `supabase/migrations/` and are applied in filename order. They are **not** applied automatically by merging.

1. Review the SQL.
2. Apply it with the Supabase CLI (`supabase db push`) or by pasting it into the Supabase SQL editor.
3. Run the diagnostic below and confirm the expected result. "Success. No rows returned" only means the statement ran; the diagnostic proves the schema changed.

### Diagnostic for 20261116000001_tenancy

```sql
select
  (select count(*) from pg_tables where schemaname = 'public'
     and tablename in ('workspaces','clients','memberships','ad_accounts',
                       'ad_account_credentials','approval_requests','audit_log')) as tables,      -- expect 7
  (select bool_and(rowsecurity) from pg_tables where schemaname = 'public'
     and tablename in ('workspaces','clients','memberships','ad_accounts',
                       'ad_account_credentials','approval_requests','audit_log')) as rls_on,      -- expect true
  (select count(*) from pg_policies where schemaname = 'public') as policies,                    -- expect 20
  (select count(*) from pg_trigger where tgname like 'audit_log_no_%') as audit_triggers;        -- expect 3
```

## Migration log (Supabase project "glio marketing", org GLIO MARKETING, free plan)

| Migration | Applied | How | Diagnostic |
|---|---|---|---|
| 20261116000001_tenancy | 2026-11-16 | Pasted into the SQL editor | 7 / true / 20 / 3 ✔ |

Migrations applied through the SQL editor are not recorded in the Supabase CLI's migration history. If we switch to `supabase db push` later, first mark these as applied with `supabase migration repair --status applied <version>` (check the CLI docs at that time) so they are not run twice.

## Secrets

Never commit keys. Supabase keys and platform credentials are configured per environment, never pasted into chat or code.
