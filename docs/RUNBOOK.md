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

### Diagnostic for 20261117000001_service_role_grants

```sql
select
  has_table_privilege('service_role', 'public.ad_account_credentials', 'select')
    and has_table_privilege('service_role', 'public.audit_log', 'insert')
    and not has_table_privilege('service_role', 'public.audit_log', 'delete')  as server_grants_ok,  -- expect true
  not has_table_privilege('anon', 'public.clients', 'select')
    and not has_table_privilege('authenticated', 'public.ad_account_credentials', 'select') as locked_down;  -- expect true
```

### Diagnostic for 20261118000001_sync_and_metrics

```sql
select
  (select count(*) from pg_tables where schemaname = 'public'
     and tablename in ('sync_runs','raw_platform_payloads','metric_daily'))                 as m2_tables,       -- expect 3
  (select bool_and(rowsecurity) from pg_tables where schemaname = 'public'
     and tablename in ('sync_runs','raw_platform_payloads','metric_daily'))                 as m2_rls_on,       -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                            as policies,        -- expect 23
  (select count(*) from pg_trigger where tgname like 'raw_payloads_no_%')                  as raw_triggers,    -- expect 3
  has_table_privilege('authenticated', 'public.metric_daily', 'select')
    and not has_table_privilege('authenticated', 'public.metric_daily', 'insert')
    and has_table_privilege('service_role', 'public.metric_daily', 'insert')               as metrics_server_write_only; -- expect true
```

### Diagnostic for 20261119000001_reconciliation

```sql
select
  to_regclass('public.reconciliation_checks') is not null
    and to_regclass('public.reconciliation_latest') is not null                                   as m3_objects,     -- expect true
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'reconciliation_checks') as m3_rls_on, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                   as policies,       -- expect 24
  (select count(*) from pg_trigger where tgname like 'reconciliation_checks_no_%')               as log_triggers,   -- expect 3
  (select coalesce(array_to_string(reloptions, ','), '') like '%security_invoker=true%'
     from pg_class where oid = 'public.reconciliation_latest'::regclass)                          as view_uses_rls;  -- expect true
```

## Migration log

Supabase org GLIO MARKETING, free plan.

| Project | Migration | Applied | How | Diagnostic |
|---|---|---|---|---|
| "glio marketing", **Frankfurt (`eu-central-1`)**, current | 20261116000001_tenancy | 2026-11-16 | SQL editor | combined check below ✔ |
| "glio marketing", Frankfurt, current | 20261117000001_service_role_grants | 2026-11-16 | SQL editor | 7 / true / 20 / 3 / true / true ✔ |
| "glio marketing", Frankfurt, current | 20261118000001_sync_and_metrics | 2026-11-16 | SQL editor (statements as in the file, comments omitted) | 3 / true / 23 / 3 / true ✔ |
| "glio marketing", Frankfurt, current | 20261119000001_reconciliation | pending owner review | | |
| "glio marketing", Tokyo (`ap-northeast-1`), **retired**, to be deleted | 20261116000001_tenancy | 2026-11-16 | SQL editor | 7 / true / 20 / 3 ✔ |

Frankfurt project created with "Automatically expose new tables" off and "Enable automatic RLS" on (ADR-007).

Migrations applied through the SQL editor are not recorded in the Supabase CLI's migration history. If we switch to `supabase db push` later, first mark these as applied with `supabase migration repair --status applied <version>` (check the CLI docs at that time) so they are not run twice.

## Secrets

Never commit keys. Supabase keys and platform credentials are configured per environment, never pasted into chat or code.
