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

## Run the web app

```bash
cp apps/web/.env.example apps/web/.env.local
```

Fill in `apps/web/.env.local` (see the comments in the file), then:

```bash
pnpm --filter @glio/web dev
```

Open http://localhost:3000. `/` is the public company website (with `/privacy` and `/terms`); the product starts at `/app`. Arabic is the default; the button in the top bar switches to English.

**Supabase Auth settings** (Authentication → URL Configuration in the Supabase dashboard):
- Site URL: the app's address (http://localhost:3000 locally, the real domain later).
- Redirect URLs: add `<site-url>/auth/callback`, which email confirmation links return to.

**Demo data:** with `GLIO_DEMO_MODE=1`, an owner or manager sees "Load demo data (synthetic)" on a client page. It attaches a fake TikTok account (`demo-advertiser-001`) and syncs obviously fake numbers for the chosen period, so the dashboard can be tried before TikTok API access. Turn it off (`GLIO_DEMO_MODE=0`) before real clients use the app.

## Production deployment (Vercel)

- Project: Vercel team GLIO MARKETING, project `glio-marketing`, Hobby plan, deploys `main` automatically on every push.
- Root Directory: `apps/web`. URL: https://glio-marketing.vercel.app
- Function region: Frankfurt (`fra1`), next to the Supabase database.
- Environment variables (Production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Config), `GLIO_DEMO_MODE=1` (Config), `DATABASE_URL` (Secret, Supabase **transaction pooler**, port 6543). Changing a variable needs a redeploy.
- Supabase Auth: Site URL `https://glio-marketing.vercel.app`; redirect URL `https://glio-marketing.vercel.app/auth/callback`.
- **Diagnostics:** signed-in workspace owners can open `/diagnostics` to check `DATABASE_URL` from inside Vercel (user, host, port, password length and character classes, live connection test). It never shows secret values.
- **Lesson from setup:** use the **Transaction pooler** string (port 6543) and a letters-and-digits password. `28P01` means wrong password; "client password must be a string" means the password part is missing. After editing a variable, delete-and-recreate if the old value persists, then redeploy.
- First end-to-end report on production: 2026-11-18 (synthetic demo data), reconciliation "ok".
- The Vercel "Supabase" integration is deliberately not used: the app connects to our own Frankfurt project with the migrations in this repo.

## Company domain (glioagency.org)

- **Registrar:** bought through Shopify (Tucows). Keep auto-renew on and don't cancel Shopify until the registration has been transferred out (planned: Cloudflare Registrar).
- **DNS:** Cloudflare (Free plan), nameservers `jasper.ns.cloudflare.com` and `wren.ns.cloudflare.com`, set in Shopify (Settings → Domains → glioagency.org → Nameservers) on 2026-11-21. All records are **DNS only** (grey cloud). DNSSEC was off at the time of the move.
- **Email (Google Workspace) records, never remove:** MX `@` → `1 smtp.google.com`; TXT `google._domainkey` (DKIM); TXT `@` `google-site-verification=…`; CNAME `lux76ui4abpo` → `gv-3aytjlepuizq5r.dv.googlehosted.com`; TXT `@` `v=spf1 include:_spf.google.com ~all` (added at the move; there was no SPF before). Resend: TXT `resend._domainkey`, TXT `send` (`v=spf1 include:amazonses.com ~all`).
- **Undo:** in Shopify, "Restore Shopify nameservers" (the old ones were `ns-cloud-b1`–`b4.googledomains.com`).
- **Check from anywhere:** `https://dns.google/resolve?name=glioagency.org&type=NS` (and `type=MX`, `type=TXT`, `name=google._domainkey.glioagency.org&type=TXT`).
- **Website (live since 2026-11-21):** `www.glioagency.org` is the main address, served by the Vercel project `glio-marketing`; `glioagency.org` redirects there (308). Cloudflare records: CNAME `@` and CNAME `www` → the `…vercel-dns-017.com` value shown in Vercel → Settings → Domains (DNS only). The Shopify A/AAAA/www records were removed; the old Shopify store and its theme repository are untouched. **Still to do:** Supabase Auth → Site URL `https://www.glioagency.org`, add redirect URL `https://www.glioagency.org/auth/callback` (keep the vercel.app ones).
- **DMARC:** TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:…@dmarc-reports.cloudflare.net` (Cloudflare DMARC Management, monitor only). After a few weeks of reports showing only Google Workspace and Resend, move to `p=quarantine`.

## TikTok Marketing API app

- Developer account on the TikTok for Business developer portal (business-api.tiktok.com/portal), signed in with info@glioagency.org. Developer registration submitted 2026-11-22 (company: the legal name on the CR, website https://www.glioagency.org, location Saudi Arabia, region EMEA, services: Campaign Management, Reporting, Ad Measurement, Accounts).
- App **GLIO** (Marketing API) submitted 2026-11-22, status **Pending** (TikTok says up to 3 days).
  - Advertiser redirect URL: `https://www.glioagency.org/integrations/tiktok/callback` (must match exactly, with `www`).
  - Scopes: Ad account management, Ads management, Reporting. Nothing else; request more (e.g. Pixel management) only with a reason.
- After approval the portal shows the **App ID** and **Secret**. Put them in Vercel as `TIKTOK_APP_ID` (Config) and `TIKTOK_APP_SECRET` (**Secret**); never in chat, code or logs.
- **Connection flow (built 2026-11-22, ADR-016):** client page → "Connect TikTok" → TikTok authorization → `/integrations/tiktok/callback` → accounts attached to the client, token in Supabase Vault → "Sync TikTok data" (uses the period form) → reports as before.
- **Before the first real connection:**
  1. Check Vault in the Supabase SQL editor: `select exists (select 1 from pg_extension where extname = 'supabase_vault') as vault_on;` expect `true`. If `false`, enable it under Database → Extensions (supabase_vault).
  2. Add `TIKTOK_APP_ID` (Config) and `TIKTOK_APP_SECRET` (Secret) in Vercel, then redeploy.
  3. Connect one real account, sync a short period, and compare the dashboard with TikTok Ads Manager. Then resolve every `TODO(verify)` in `packages/connectors/src/tiktok/api.ts` and replace the fixtures with an anonymised real response.
- Error codes on the client page: `TIKTOK_NOT_CONFIGURED` (Vercel variables missing), `TIKTOK_CANCELLED` (not approved on TikTok), `TIKTOK_NO_ACCOUNTS`, `3F000` / `42883` (Vault not enabled), `tiktok_<n>` (TikTok API error code).

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

### Diagnostic for 20261120000001_reports_and_commentary

```sql
select
  to_regclass('public.ai_commentary') is not null
    and to_regclass('public.report_snapshots') is not null                                   as m5_tables,        -- expect true
  (select bool_and(rowsecurity) from pg_tables where schemaname = 'public'
     and tablename in ('ai_commentary', 'report_snapshots'))                                as m5_rls_on,        -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                            as policies,         -- expect 26
  (select count(*) from pg_trigger
     where tgname like 'ai_commentary_no_%' or tgname like 'report_snapshots_no_%')        as record_triggers;  -- expect 6
```

## Migration log

Supabase org GLIO MARKETING, free plan.

| Project | Migration | Applied | How | Diagnostic |
|---|---|---|---|---|
| "glio marketing", **Frankfurt (`eu-central-1`)**, current | 20261116000001_tenancy | 2026-11-16 | SQL editor | combined check below ✔ |
| "glio marketing", Frankfurt, current | 20261117000001_service_role_grants | 2026-11-16 | SQL editor | 7 / true / 20 / 3 / true / true ✔ |
| "glio marketing", Frankfurt, current | 20261118000001_sync_and_metrics | 2026-11-16 | SQL editor (statements as in the file, comments omitted) | 3 / true / 23 / 3 / true ✔ |
| "glio marketing", Frankfurt, current | 20261119000001_reconciliation | 2026-11-16 | SQL editor (statements as in the file, comments omitted) | true / true / 24 / 3 / true ✔ |
| "glio marketing", Frankfurt, current | 20261120000001_reports_and_commentary | 2026-11-17 | SQL editor | true / true / 26 / 6 ✔ |
| "glio marketing", Tokyo (`ap-northeast-1`), **retired**, to be deleted | 20261116000001_tenancy | 2026-11-16 | SQL editor | 7 / true / 20 / 3 ✔ |

Frankfurt project created with "Automatically expose new tables" off and "Enable automatic RLS" on (ADR-007).

Migrations applied through the SQL editor are not recorded in the Supabase CLI's migration history. If we switch to `supabase db push` later, first mark these as applied with `supabase migration repair --status applied <version>` (check the CLI docs at that time) so they are not run twice.

## AI commentary (Claude)

Report commentary uses Claude (`claude-opus-5-5` by default) through `ClaudeCommentaryModel`. The server needs `ANTHROPIC_API_KEY` in its environment. Without a configured model, reports use the deterministic template. Tests never call the API.

## Secrets

Never commit keys. Supabase keys and platform credentials are configured per environment, never pasted into chat or code.
