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

## Report emails (M6)

- Sender: Resend, from `GLIO Reports <reports@glioagency.org>`, replies to info@glioagency.org. The glioagency.org domain must show **Verified** in Resend (its DKIM `resend._domainkey` and `send` records are already in Cloudflare).
- Vercel variables: `RESEND_API_KEY` (**Secret**), `CRON_SECRET` (**Secret**, long random letters and digits). Optional: `REPORTS_FROM`, `REPORTS_REPLY_TO`, `APP_URL`.
- Daily job: `apps/web/vercel.json` → `/api/cron/daily` at 05:00 UTC (08:00 Riyadh): refresh connected TikTok accounts (last 7 days), GLIO suggestions, then scheduled report emails (ADR-020). Check runs under Vercel → project → Settings → Cron Jobs, and the logs for `daily_job` events.
- Per client: client page → "Email reports" (recipients, frequency, weekday, language) and "Email the chosen period's report now". The last 5 deliveries are listed there; all of them are in `report_deliveries`.
- **First report email: 2026-11-22**, manual send (synthetic demo data), from reports@glioagency.org, delivered to a Gmail inbox (not spam). `RESEND_API_KEY` is a send-only key restricted to glioagency.org ("GLIO production" in Resend). Resend's "Forge" upgrade banner was left alone; check what DNS changes it needs before activating.
- Unsubscribe (ADR-026): every report email has its own link at the bottom (`/u/<secret>`, a page with one button) and a one-click `List-Unsubscribe` header (mail apps' own Unsubscribe button POSTs to `/api/unsubscribe/<secret>`). Unsubscribed addresses are listed on the client page and skipped by every send; only the person can subscribe again, from the same link. Audit: `report.unsubscribed` (via page or one-click), `report.resubscribed`.
- Error codes: `RESEND_NOT_CONFIGURED`, `RESEND_401` (bad key), `RESEND_403`/`RESEND_422` (domain not verified or bad address), `NO_RECIPIENTS`, `REFRESH_<code>` (TikTok sync failed before a scheduled send; retried the next day).

## Team and invitations

- Workspace → Team (sidebar): members and roles; owners invite by email (manager, analyst, client viewer for one client), change roles, remove members, cancel invites.
- The invite link is valid 7 days and works only for the invited email (sign in or sign up with it). Without `RESEND_API_KEY` the owner copies the link shown after inviting.
- Audit: `member.invited`, `member.invite_revoked`, `member.joined`, `member.role_changed`, `member.removed`.

## Approval notifications

- Emails to each owner/manager when requests wait for approval: after "Check for suggestions now", after someone proposes a change (not to the proposer), and in the daily job. Each request is announced once (`notified_at`). Needs `RESEND_API_KEY`.
- Each person turns it on/off per workspace on the Approvals page (stored in `notification_settings`; no row = on).
- Logs: `approvals_notified` / `approvals_notify_failed` events; audit `approval.notified`.

## GLIO suggestions (rules v1)

- Daily (step 2 of `/api/cron/daily`) and on demand (Approvals → "Check for suggestions now", owners/managers). Proposals only: they appear on the Approvals page as "GLIO suggestion" and run only after an owner/manager approves, through the same executor and safety limits.
- Rules on the last 7 complete days (Asia/Riyadh): pause a campaign that spent at least SAR 300 with no conversions; lower the daily budget 20% when cost per conversion is at least 1.5x the client's (3+ conversions); raise it 20% (capped by the safety limits) when at most 0.7x (10+ conversions). CPA rules need at least two campaigns with conversions. Defaults in `DEFAULT_RULES` (`packages/sync/src/suggestions.ts`).
- Per client (client page → "GLIO suggestions for this client", owners/managers): on/off and every threshold below; no settings row = these defaults (ADR-023).
- Not repeated while a request is open for the campaign, or for 7 days after a decision on a suggestion for it. Suggestions expire after 72 hours.
- Demo data: campaigns C (no conversions), D (strong) and E (expensive) trigger the three rules.

## Sign-in emails (Supabase Auth through Resend)

Sign-up confirmation and password reset emails are sent by Supabase Auth through Resend's SMTP, from glioagency.org, with GLIO's own Arabic + English templates (ADR-025). Without this, Supabase's built-in sender allows only a few emails per hour and sends from a Supabase address.

1. Resend → API Keys → create a key named "Supabase Auth SMTP", permission **Sending access**, domain **glioagency.org**. Paste it only into Supabase (step 2), never in chat or code. A separate key from the Vercel one, so either can be revoked alone.
2. Supabase → Authentication → Emails → **SMTP Settings** → enable custom SMTP: sender email `no-reply@glioagency.org`, sender name `GLIO`, host `smtp.resend.com`, port `465`, username `resend`, password = the key from step 1.
3. Supabase → Authentication → URL Configuration: Site URL exactly `https://www.glioagency.org` (no trailing slash); the templates build their links from it.
4. Supabase → Authentication → Emails → Templates:
   - **Confirm signup**: subject `تأكيد بريدك في GLIO · Confirm your GLIO email`, body = `supabase/templates/confirm-signup.html`.
   - **Reset password**: subject `إعادة تعيين كلمة المرور في GLIO · Reset your GLIO password`, body = `supabase/templates/reset-password.html`.
5. Supabase → Authentication → Rate Limits: with custom SMTP the email limit starts at 30 per hour; raise it if needed.

**Live since 2026-11-24**: custom SMTP and both templates set in Supabase; a password reset was tested end to end (email from no-reply@glioagency.org, link opened, new password set).

Links go to `/auth/confirm?token_hash=…&type=email|recovery`: a page with one button (so link-scanning email security tools can't use the token first) that verifies it on the server. They work in any browser or device, unlike the old `/auth/callback?code=…` links (kept for emails already sent). Logs: `email_link_failed` events. Resend → Emails lists every message sent.

## Report share links

- Report page → "Share this report" (owners/managers): a read-only link valid 7, 30 or 90 days, shown once after creating it; the table lists every link with its views and a Revoke button. Report emails carry their own 30-day link (marked "from email" in the table).
- The link opens `/s/<secret>` without a GLIO account. Expired, revoked or wrong links show "This link isn't available."
- Audit: `report.shared`, `report.share_revoked`. Views are counted in `report_shares.view_count` / `last_viewed_at`.

## System check (Diagnostics page)

Owners open **https://www.glioagency.org/diagnostics**. It checks, live and without showing any secret value: required settings present (and the TikTok app id / secret format), the database at the latest migration (tables, functions, policy count `EXPECTED_POLICIES` in `apps/web/lib/system-check.ts`, which must be raised with each migration that adds policies), row-level security on every table, a Vault write → read → delete round trip (what connecting TikTok does), TikTok's API reachable, and failures recorded in the last 7 days (syncs, report emails, approved changes, syncs stuck running). Run it after every deploy that changes settings or migrations, and before connecting a client. Logs it can't see: Vercel → Logs (`daily_job`, `tiktok_*`, `*_failed` events).

## Profitability (break-even ROAS)

- Client page → "Profitability" (owners/managers): enter the client's approximate gross margin (%). GLIO shows break-even ROAS (100 ÷ margin), the period's ROAS, and an estimated gross profit after ad spend (TikTok-credited purchase value × margin − spend). The ROAS tile says "Break-even X · above/below break-even"; each campaign's ROAS is marked ▲ (above) or ▼ (below). Audit: `client.margin_updated`. ADR-035.

## Data retention and client deletion

- **Delete a client** (owners): client page → "Delete client" at the bottom → type the client's name → "Delete client and all its data". Removes everything with that client's id (ad accounts, tokens in Vault, synced data, reports, share links, email schedule and log, unsubscribes, approvals, settings, client viewers). Audit: `client.deleted` with the name and record counts. Logs: `client_deleted` / `client_delete_failed`. Nothing changes in the TikTok account; to also cut GLIO's access there, the advertiser removes the app in TikTok.
- **Retention purge**: step 5 of `/api/cron/daily` calls `purge_expired_data()` (migration 0013): invitations 90 days after accepted/cancelled/expired, report delivery rows after 24 months. Result in the `daily_job` log as `purged`.
- Not deleted: the audit log (append-only). Whole workspace or user account deletion: on request (info@glioagency.org) until built.

## TikTok Marketing API app

- Developer account on the TikTok for Business developer portal (business-api.tiktok.com/portal), signed in with info@glioagency.org. Developer registration submitted 2026-11-22 (company: the legal name on the CR, website https://www.glioagency.org, location Saudi Arabia, region EMEA, services: Campaign Management, Reporting, Ad Measurement, Accounts).
- App **GLIO** (Marketing API) submitted 2026-11-22, status **Pending** (TikTok says up to 3 days).
  - Advertiser redirect URL: `https://www.glioagency.org/integrations/tiktok/callback` (must match exactly, with `www`).
  - Scopes: Ad account management, Ads management, Reporting. Nothing else; request more (e.g. Pixel management) only with a reason.
- **2026-11-24: developer profile rejected** (fields: Account type, Company Name, Company Website): "your company name doesn't match your email domain or company website". Fix: the website now names the legal entity next to the brand (footer, about, privacy, terms) with the CR number (ADR-027); then Update Application on the profile with the Description below, and resubmit the app once the profile is approved.
  - **2026-11-24 resubmitted:** profile as **Technology Company** (company name = legal name, website https://www.glioagency.org, location Saudi Arabia, region EMEA), with a "how we use TikTok data" description; then the **GLIO** app resubmitted (app description under 500 characters; scopes Ad account management, Ads management, Reporting): status **Pending**.
  - **2026-11-25 app rejected:** "description doesn't align with your scope of permission" (all permissions of three groups had been requested). **Resubmitted the same day, Pending**, with only what GLIO calls (select v1.3 in the portal's version dropdown to see the v1.3 API lists):
    - Ad account management → Ad account information → **Read ad account information** (`/advertiser/info/`; `/oauth2/advertiser/get/` comes with the group)
    - Ads management → Campaign → **Read campaigns** and **Create and update campaigns** (no update-only item exists; GLIO never creates campaigns)
    - Reporting → **Consolidated report** (contains `/report/integrated/get/` in v1.3; not "Ad insight report")
    - App description (495/500): "GLIO (glioagency.org, Sutoor AlMustaqbaliyya Agency for Commercial Services, CR 7042386917) lets advertisers connect their TikTok ad accounts. We use /oauth2/advertiser/get/ and /advertiser/info/ to list accounts; /report/integrated/get/ for daily campaign reports in dashboards and emailed reports; /campaign/get/, /campaign/status/update/ and /campaign/update/ to pause/enable a campaign or change its daily budget, only after the advertiser approves each change. GLIO never creates campaigns."
    - **2026-11-25: app APPROVED** (status Approved, Online). App ID 7712114410013065224 (not secret). The Secret stays only in the TikTok portal and Vercel.
  - **2026-11-25: first real connection** (owner's own ad account, 1 account): OAuth → first 30-day sync → reconciliation "Matches the platform". A first attempt failed with "request expired" (the 10-minute OAuth window; now 30 minutes).
  - **2026-11-25: verified against TikTok Ads Manager** (same account, 26 Oct – 24 Nov 2026, Campaign table total, deleted/paused campaigns included): spend matched to the halala and cost per conversion matched exactly. Ads Manager shows purchase value / ROAS, which GLIO does not fetch yet (ROAS shows "Not provided by platform").
  - **2026-11-26: first real change through GLIO** (owner's account): a daily-budget change on a paused campaign was proposed, approved and executed via `/campaign/update/`, checked in Ads Manager, then undone through GLIO and checked again. Reported OK by the owner.
  - **2026-11-25: `GLIO_DEMO_MODE` turned off in production** (real client data present; the "Load demo data" buttons are gone).
  - **2026-11-26: TikTok answer for a period with no ads confirmed** (10–25 Sep 2026, owner's account): one account-totals row with spend "0.00" and impressions "0"; reconciliation "Matches the platform". Quiet days appear as zero rows per campaign.
  - Lesson for other platforms: request only the permissions the code calls, and name each API and its purpose in the description.
  - Profile description used for the first resubmission attempt: "GLIO (glioagency.org) is the trading name of Sutoor AlMustaqbaliyya Agency for Commercial Services, Commercial Registration 7042386917, Kingdom of Saudi Arabia. The legal name, brand and CR number are shown together in the footer of glioagency.org and in its privacy policy. Our email domain is glioagency.org. We are a digital marketing agency that manages TikTok advertising for Saudi businesses; our platform at glioagency.org reads reporting data and, only after a client's approval, changes campaign status or budgets on the ad accounts our clients authorise."
- After approval the portal shows the **App ID** and **Secret**. Put them in Vercel as `TIKTOK_APP_ID` (Config) and `TIKTOK_APP_SECRET` (**Secret**); never in chat, code or logs.
- **Connection flow (built 2026-11-22, ADR-016):** client page → "Connect TikTok" → TikTok authorization → `/integrations/tiktok/callback` → accounts attached to the client, token in Supabase Vault → **the last 30 days are synced right away** (ADR-030; if that fails the accounts stay connected and the page says why) → the daily job keeps the last 7 days fresh; "Sync TikTok data" syncs any other period.
- **Disconnect (ADR-034):** TikTok accounts card → "Disconnect" (owners/managers) → confirm. The account stays (status disconnected, history and reports kept); its credential is removed; open change requests are cancelled; the token is revoked at TikTok (`/oauth2/revoke_token/`) and deleted from Vault unless another connected account shares it. "Connect TikTok" again reactivates it. Audit `ad_account.disconnected` (metadata `token`: revoked / kept_shared / revoke_failed). To delete the data too, delete the client.
- **Several ad accounts on one TikTok login (ADR-032):** after TikTok's approval, GLIO shows "Choose the ad accounts": accounts already on this client are ticked, accounts on another client can't be chosen, nothing is attached until "Connect the chosen accounts". The choice expires after 30 minutes (the daily job deletes expired ones and their tokens). One authorised account is attached directly. Logs: `tiktok_connect_cancelled`.
- **Today so far (ADR-033):** a provisional panel at the top of the client page (clients with a connected, non-demo TikTok account). Opening the page refreshes today from TikTok when the stored figures are older than 10 minutes (bounded to 8 s; the rest finishes in the background); "Refresh" forces it (at most once a minute); the page re-renders itself every 10 minutes while open. Per campaign: spend, purchase value, ROAS, conversions, clicks for the day so far; per hour: spend, clicks, conversions (TikTok has no hourly purchase value), with yesterday's hours (fetched once after midnight) as a dashed line. Stored in `metric_intraday` + `sync_runs` kind `intraday`; never in reports, emails, share links or reconciliation. Purged after 14 days with their raw responses. Logs: `intraday_refresh_failed`; Diagnostics lists "Today refreshes" failures separately.
- **What the client page shows before figures exist:** not connected → "Connect TikTok"; connected but never synced → "Sync this period"; synced but no activity in the period → "No ad activity", with the last sync time. Each connected account shows its last sync time, or the last failure with its hint. Logs: `tiktok_first_sync_failed`.
- **Before the first real connection:**
  1. Check Vault in the Supabase SQL editor: `select exists (select 1 from pg_extension where extname = 'supabase_vault') as vault_on;` expect `true`. If `false`, enable it under Database → Extensions (supabase_vault). **Checked 2026-11-22 on the Frankfurt project: `true`.**
  2. Add `TIKTOK_APP_ID` (Config) and `TIKTOK_APP_SECRET` (Secret) in Vercel, then redeploy.
  3. Connect one real account, sync a short period, and compare the dashboard with TikTok Ads Manager (spend, impressions, clicks, conversions per day; the reconciliation badge should say "Matches the platform"). The API details were checked against TikTok's docs on 2026-11-24 (ADR-028); the two remaining `TODO(verify)` items in `packages/connectors/src/tiktok/api.ts` (totals row for an inactive range, advertiser/info id limit) are settled on this first account.
- TikTok error codes: `tiktok_40001`/`40102`/`40104`/`40105`/`40106` = authorisation expired or revoked (connect again); `tiktok_40016`/`40100`/`40133`/`5xxxx`/`60001` = throttled or TikTok down (retried, then try later); `tiktok_40119` = developer and advertiser not the same company.
- **Purchase value and ROAS (ADR-031):** the sync also fetches `total_complete_payment_rate` (Ads Manager "Purchase value (website)") and, only for the archive, `complete_payment_roas`. ROAS = purchase value / spend. Rows synced before 2026-11-25 have no purchase value: until those days are synced again, ROAS for a period that includes them shows "Not provided by platform for some days". Fix: client page → choose the period → "Sync TikTok data" (note: it syncs the dates on screen; after this change, "Last 90 days" → Sync once). Tiles then say "Missing for some days: sync this period" instead of "Not provided".
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

### Diagnostic for 20261122000001_report_emails

```sql
select
  to_regclass('public.report_schedules') is not null
    and to_regclass('public.report_deliveries') is not null                                  as m6_tables,      -- expect true
  (select bool_and(rowsecurity) from pg_tables where schemaname = 'public'
     and tablename in ('report_schedules', 'report_deliveries'))                            as m6_rls_on,      -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                            as policies,       -- expect 31
  (select count(*) from pg_trigger where tgname like 'report_deliveries_no_%')             as log_triggers;   -- expect 3
```

### Diagnostic for 20261122000002_approvals

```sql
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'approval_requests'
     and column_name in ('ad_account_id', 'before_state', 'after_state', 'undo_of', 'expires_at'))      as new_columns,      -- expect 5
  to_regclass('public.client_guardrails') is not null                                                    as guardrails_table, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                         as policies,         -- expect 34
  has_function_privilege('authenticated', 'public.decide_approval(uuid, boolean, text)', 'execute')
    and not has_table_privilege('authenticated', 'public.approval_requests', 'update')                  as decisions_locked; -- expect true
```

### Diagnostic for 20261123000001_notifications

```sql
select
  exists (select 1 from information_schema.columns where table_schema = 'public'
          and table_name = 'approval_requests' and column_name = 'notified_at')               as notified_column,  -- expect true
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'notification_settings') as settings_rls, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                as policies;         -- expect 38
```

### Diagnostic for 20261123000002_invitations

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'invitations')     as invitations_rls,  -- expect true
  to_regprocedure('public.accept_invitation(text)') is not null
    and to_regprocedure('public.invitation_preview(text)') is not null                             as functions,        -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                    as policies,         -- expect 41
  not has_table_privilege('authenticated', 'public.invitations', 'delete')                           as no_delete;        -- expect true
```

### Diagnostic for 20261124000001_suggestion_settings

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'suggestion_settings') as settings_rls, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                         as policies;     -- expect 45
```

### Diagnostic for 20261124000002_report_shares

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'report_shares') as shares_rls, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                   as policies;   -- expect 48
```

### Diagnostic for 20261124000003_report_unsubscribes

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'report_unsubscribes') as unsub_rls,   -- expect true
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'report_deliveries'
          and column_name = 'unsubscribe_token_hash')                                                    as token_column, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                         as policies;     -- expect 49
```

### Diagnostic for 20261124000004_retention

```sql
select
  exists (select 1 from pg_proc where proname = 'purge_expired_data')               as purge_fn,          -- expect true
  has_table_privilege('service_role', 'public.report_deliveries', 'DELETE')           as server_can_delete, -- expect false
  (select count(*) from pg_policies where schemaname = 'public')                      as policies;          -- expect 49
```

### Diagnostic for 20261125000001_purchase_value

```sql
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'metric_daily'
          and column_name = 'purchase_value_minor')                                               as value_column, -- expect true
  (select pg_get_constraintdef(oid) like '%purchase_value%' from pg_constraint
    where conname = 'reconciliation_checks_metric_check')                                         as recon_metric, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                  as policies;     -- expect 49
```

### Diagnostic for 20261126000001_pending_connections

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'pending_ad_connections') as pending_rls,   -- expect true
  has_table_privilege('authenticated', 'public.pending_ad_connections', 'SELECT')                           as users_can_read, -- expect false
  (select count(*) from pg_policies where schemaname = 'public')                                            as policies;       -- expect 49
```

### Diagnostic for 20261126000002_intraday

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'metric_intraday')   as intraday_rls,  -- expect true
  (select pg_get_constraintdef(oid) like '%intraday%' from pg_constraint
    where conname = 'sync_runs_kind_check')                                                            as intraday_kind, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                       as policies;      -- expect 50
```

### Diagnostic for 20261127000001_client_economics

```sql
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'client_economics') as economics_rls, -- expect true
  (select count(*) from pg_policies where schemaname = 'public')                                      as policies;      -- expect 54
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
| "glio marketing", Frankfurt, current | 20261122000001_report_emails | 2026-11-22 | SQL editor (statements as in the file, comments omitted) | true / true / 31 / 3 ✔ |
| "glio marketing", Frankfurt, current | 20261122000002_approvals | 2026-11-22 | SQL editor (statements as in the file, comments omitted) | 5 / true / 34 / true ✔ |
| "glio marketing", Frankfurt, current | 20261123000001_notifications | 2026-11-23 | SQL editor (statements as in the file, comments omitted) | true / true / 38 ✔ |
| "glio marketing", Frankfurt, current | 20261123000002_invitations | 2026-11-23 | SQL editor (statements as in the file, comments omitted) | true / true / 41 / true ✔ |
| "glio marketing", Frankfurt, current | 20261124000001_suggestion_settings | 2026-11-24 | SQL editor (statements as in the file, comments omitted) | true / 45 ✔ |
| "glio marketing", Frankfurt, current | 20261124000002_report_shares | 2026-11-24 | SQL editor (statements as in the file, comments omitted) | true / 48 ✔ |
| "glio marketing", Frankfurt, current | 20261124000003_report_unsubscribes | 2026-11-24 | SQL editor (statements as in the file, comments omitted) | true / true / 49 ✔ |
| "glio marketing", Frankfurt, current | 20261124000004_retention | 2026-11-24 | SQL editor (statements as in the file, comments omitted) | true / false / 49 ✔ |
| "glio marketing", Frankfurt, current | 20261125000001_purchase_value | 2026-11-25 | SQL editor (statements as in the file, comments omitted) | true / true / 49 ✔ |
| "glio marketing", Frankfurt, current | 20261126000001_pending_connections | 2026-11-26 | SQL editor (statements as in the file, comments omitted) | true / false / 49 ✔ |
| "glio marketing", Frankfurt, current | 20261126000002_intraday | 2026-11-26 | SQL editor (statements as in the file, comments omitted) | true / true / 50 ✔ |
| "glio marketing", Frankfurt, current | 20261127000001_client_economics | 2026-11-26 | SQL editor (statements as in the file, comments omitted) | true / 54 ✔ |
| "glio marketing", Tokyo (`ap-northeast-1`), **retired**, to be deleted | 20261116000001_tenancy | 2026-11-16 | SQL editor | 7 / true / 20 / 3 ✔ |

Frankfurt project created with "Automatically expose new tables" off and "Enable automatic RLS" on (ADR-007).

Migrations applied through the SQL editor are not recorded in the Supabase CLI's migration history. If we switch to `supabase db push` later, first mark these as applied with `supabase migration repair --status applied <version>` (check the CLI docs at that time) so they are not run twice.

## AI commentary (Claude)

Report commentary uses Claude (`claude-opus-5-5` by default) through `ClaudeCommentaryModel`. The server needs `ANTHROPIC_API_KEY` in its environment. Without a configured model, reports use the deterministic template. Tests never call the API.

## Secrets

Never commit keys. Supabase keys and platform credentials are configured per environment, never pasted into chat or code.
