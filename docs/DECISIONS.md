# Decisions

One short record per decision: context, decision, consequence. Newest last.

## ADR-001 Start with TikTok, one channel at a time

**Context.** Glio will cover TikTok, Snapchat, Meta, Google Ads (incl. YouTube) and Google Business Profile. TikTok is the founding agency's biggest channel and has a medium-difficulty API review (~1–2 weeks).
**Decision.** Build and prove the full flow on TikTok first. Add Snapchat, then Meta, then Google, then Business Profile, each only after the previous one passes its real-data tests.
**Consequence.** Every platform sits behind one `Connector` interface so later channels don't change the core. Meta Business Verification starts early in the background because WhatsApp depends on it.

## ADR-002 Supabase (Postgres + Auth + RLS) as the system of record

**Context.** We need Postgres, email/magic-link login with 2FA for owners, and tenancy enforced by the database. The founder already runs Supabase for another product.
**Decision.** Use one dedicated Supabase project for Glio. Tenancy is enforced with row-level security on every table, using `auth.uid()` and membership helpers (`is_member`, `has_ws_role`, `can_see_client`).
**Consequence.** Schema lives in `supabase/migrations/` as plain, reviewed SQL. Tests run the same migrations against plain Postgres using a small shim of Supabase's `auth` schema (`packages/db/test/supabase-shim.sql`), so CI never touches the real project.

## ADR-003 One engine for businesses and agencies

**Context.** Glio serves business owners directly (self-serve) and agencies managing many clients.
**Decision.** A `workspace` has `kind = 'business' | 'agency'`. A business workspace is an agency with one client (created automatically). Roles: owner, manager, analyst, client_viewer.
**Consequence.** No separate code path per customer type; screens differ by `kind` and role. Inviting an agency into a business workspace is a later feature (guest membership) and fits this model.

## ADR-004 Approvals and audit log exist from day one

**Context.** Glio will change live ad spend. Trust and liability require that nothing executes without approval, and that every action is traceable.
**Decision.** `approval_requests` and an append-only `audit_log` ship in the first migration. Updates, deletes and truncates on `audit_log` are blocked by trigger for every role, including the server.
**Consequence.** Write actions in later stages plug into an existing approval path. Purging old audit entries for retention will need a dedicated, logged procedure.

## ADR-005 Platform credentials are server-only

**Context.** TikTok and other platform tokens grant control of real ad accounts.
**Decision.** Tokens are stored in a secret store; the database keeps only a reference in `ad_account_credentials`, a table with RLS enabled, no policies and no grants to signed-in users.
**Consequence.** Only server code using the service role can resolve credentials. Tokens are never logged and never sent to the AI.

## ADR-006 Glio never generates images or video, and never holds ad money

**Context.** Platforms already give creative generation away; handling ad spend would make Glio a payments business.
**Decision.** Glio writes text only (copy, plans, summaries). Creatives come from the business. Ad spend is charged by the platform to the business's own card.
**Consequence.** No creative-generation dependencies. Glio's own subscription billing is separate and must be ZATCA-compliant.

## ADR-007 Explicit grants only; Supabase's automatic table exposure stays off

**Context.** Supabase can grant API roles access to every new table automatically. That makes access depend on a dashboard setting instead of reviewed SQL.
**Decision.** Projects are created with "Automatically expose new tables" off and "Enable automatic RLS" on. Every grant Glio relies on, including for the server role, is written in a migration. The test shim mirrors this (no default privileges).
**Consequence.** A table someone forgets to grant fails loudly in tests instead of being silently exposed.

## ADR-008 Raw payloads are the evidence; metrics are derived and upserted

**Context.** Every number Glio shows must trace to what the platform returned, and re-running a sync must never duplicate or drift.
**Decision.** Each API page is stored unchanged in `raw_platform_payloads` with a SHA-256 of its canonical JSON (keys sorted). The fingerprint excludes fields that change on every call without the data changing (TikTok's `request_id`), so identical data is stored once per account. Raw rows are immutable; they disappear only through the ad-account cascade (account or workspace deletion). `metric_daily` rows are upserted on `(ad_account_id, level, entity_id, date)` and point at their raw payload; unchanged rows are not rewritten. Metrics are written in one transaction only after every page succeeded. Money is converted to minor units exactly and a value needing rounding fails the sync. `NULL` means "not provided by platform".
**Consequence.** Re-runs are provably idempotent (M2 gate). Restated data (late conversions) updates only the affected rows, and the older raw version remains as history. Raw storage grows only when data actually changes.

## ADR-009 TikTok connector built before API access, details isolated

**Context.** TikTok API access isn't approved yet, and the API details used come from memory of v1.3 while TikTok now also documents v2.0.
**Decision.** Every TikTok-specific detail (URLs, parameter and metric names, limits, error codes) lives in `packages/connectors/src/tiktok/api.ts`, marked `TODO(verify)`. The connector is tested against synthetic fixtures through an injected HTTP layer. Retries happen only for errors the connector marks transient (HTTP 429/5xx for now).
**Consequence.** Switching to the verified API is a change to one file and the fixtures. No live TikTok call has been made yet; nothing here is proven against the real API.

## ADR-010 Platform tokens live in a secret store, not the database

**Context.** The database stores only `secret_ref`.
**Decision.** A `SecretStore` interface resolves refs to tokens. Only an in-memory implementation exists, for tests. The production store (Supabase Vault or a KMS-backed store) is chosen before the first real TikTok account is connected.
**Consequence.** Tokens never reach tables, logs or sync error messages (tested); the production store is an open item.

## ADR-011 Reconciliation: our stored totals vs the platform's own totals

**Context.** Reported numbers must tie to platform totals; drift must be visible, not discovered by a client.
**Decision.** After a successful sync, `reconcile()` asks the platform for account-level totals over the sync run's dates (split and summed if longer than one request allows), archives that response, and compares it with the sum of the stored campaign rows: spend (minor units), impressions, clicks, conversions (scaled by 10^4). Drift = |ours − theirs| / theirs in parts per million, decided with exact integer arithmetic; flagged when strictly greater than the threshold (default 5,000 ppm = 0.5%). Missing values are "not comparable", never zero; "platform reports 0 / no activity but Glio stored some" is always flagged. One row per metric goes to the append-only `reconciliation_checks`, and a structured log event is emitted (`warn` on drift, `error` on failure, never credentials). `reconciliation_latest` (security_invoker view) gives the UI the newest result per metric.
**Consequence.** Every check is provable after the fact: both numbers, the threshold used and the platform response are stored. Comparing campaign-level sums to account totals can legitimately differ (e.g. deleted campaigns, late attribution); that is what the flag is for. Thresholds per client and alerting (WhatsApp/email) come later.

## ADR-012 Reports are snapshots of figures with provenance

**Context.** We must be able to prove what a client saw on a given date, and a reviewer must be able to go from any figure to the platform response behind it.
**Decision.** A report is a list of figures (id, exact value or explicit reason it has none, English and Arabic display text, raw payload ids). Base figures are sums of `metric_daily`; derived figures (CTR, CPC, CPA) are computed from exact integers, with only their display rounded half-up and the exact numerator/denominator kept. ROAS is "not provided" until a revenue source is connected. Display formatting is our own deterministic code (no ICU), with Western or Arabic-Indic digits per report. `report_snapshots` stores the full report JSON and its SHA-256; snapshots and commentary are permanent records.
**Consequence.** Any stored report can be re-verified later against the raw payloads it cites (the M5 gate does exactly that). Changing formatting or metrics later creates different snapshots; old ones stay as they were shown.

## ADR-013 AI commentary: figures in, validated text out, template as the floor

**Context.** The AI must never produce or alter a number, and must say when data is missing.
**Decision.** Claude (`claude-opus-5-5`, structured JSON output with Arabic and English fields, effort `medium`) receives only the period, channels and figures with their display text: no raw payloads, credentials or client names. Every number in its output (after normalising Arabic-Indic digits, Arabic separators and bidi marks) must appear exactly in a figure display or the period dates; numbers written as words are rejected. On failure: one retry with a stricter instruction naming the offending numbers, then a deterministic template. Missing metrics are always stated by a code-generated sentence, not left to the model. Every attempt (including rejected output and errors), the exact input and its hash, the prompt version and the prompt's hash are stored in `ai_commentary`. Server-side refusal fallbacks are not enabled: a refusal falls through to the retry and then the template.
**Consequence.** The worst case is a plainer, template-written summary, never a wrong number. The validator can't judge whether a correct number is described correctly (e.g. attributing clicks to the wrong channel); the prompt and review address that, not the validator. Sending figures to the Claude API means aggregated metrics leave the Kingdom (see COMPLIANCE.md).

## ADR-014 Web app: Next.js server rendering, reads as the user, writes behind a permission check

**Context.** The first usable screens: sign-up/login, workspaces, clients, the client dashboard, stored reports, and figure provenance, Arabic-first.
**Decision.** Next.js 16 App Router, every page server-rendered with `<html dir="rtl" lang="ar">` (English via a cookie), styles using only logical CSS properties. Supabase Auth (email + password, email confirmation) through `@supabase/ssr`; `proxy.ts` refreshes the session and sends signed-out visitors to /login. **All page reads use the Supabase client as the signed-in user**, so row-level security decides what is shown. Server-only writes (report snapshots, demo syncs) use a direct Postgres connection (`DATABASE_URL`, server-only) and are allowed only after `clientAccess()` confirms the user's role under RLS. Numbers and dates inside text are wrapped in direction-isolated spans so Arabic layout can't reorder them. Shared packages import their own files with `.ts` extensions (`moduleResolution: Bundler`) so the same source runs in Vitest and in Next's bundler.
**Consequence.** A bug in a page can't show another workspace's data, because the database refuses it. The server-privileged connection is the sensitive part: every new use must be preceded by a permission check. 2FA for owners, magic links, the client portal's white-label branding and expiring share links are still to come.

## ADR-015 Company website and the app share one domain and one deployment

**Context.** TikTok's developer registration (and later Meta, Snapchat, Google) needs a company website on the company domain with a privacy policy and terms, and the OAuth redirect URL must be on that domain. The owner's company is Sutoor AlMustaqbaliyya Agency for Commercial Services, trade name Glio Agency, domain `glioagency.org` (previously a Shopify store).
**Decision.** The same Next.js app serves the public website and the product. `/` is the public home page; `/privacy` and `/terms` are public; the signed-in workspace list moved from `/` to `/app`. `isPublicPath()` in `proxy.ts` is the single list of public paths (exact or followed by `/`, so `/privacy-x` is not public). Company facts live in `COMPANY` in `lib/site.ts`; a null field is not shown. **The public brand is "Glio" only**: by the owner's choice the legal entity name is not shown anywhere on the site (kept in `COMPANY` for platform applications), contact is email only (no phone), and the CR number is shown (tested). Site text is Arabic-first with English, same structure in both (tested). DNS for `glioagency.org` moved to Cloudflare (DNS-only records, no proxy) on 2026-11-21; the registration stays at Shopify until it is transferred.
**Consequence.** One deployment, one certificate, one cookie domain; the TikTok redirect URL can be `https://glioagency.org/...`. Policy text is written to match what is built today and must change when the product does (new providers, data, retention). It has not had a legal review. Not naming the legal entity on the privacy policy may fall short of PDPL's requirement to identify the controller, and platform reviewers may expect the site to match the registered company; revisit if either is raised.

**Update (2026-11-21): one blended site.** glioagency.org already had a Shopify agency site ("GLIO": services, free audit, waitlist). The owner chose to blend it with the platform: the public site now sells three agency services (paid ads management, tracking + data setup, SEO + visibility; store building dropped) alongside the Glio platform, in the old site's dark blue style. Pages are split into route groups, `app/(site)` (dark public site with its own header/footer) and `app/(app)` (light product UI); URLs are unchanged. The main call to action is "Ask for a demo" as an email to info@glioagency.org with a prefilled subject and body: no form and no new table until we decide where leads live (a lead table would need a migration reviewed first, and has no workspace). The Shopify site stays on glioagency.org until the owner approves the new one; then the domain moves to Vercel in one step.

## ADR-016 Connecting TikTok: OAuth state cookie, tokens in Supabase Vault

**Context.** Advertisers connect their own TikTok ad accounts. The access token must never reach the browser, logs, our tables or the AI, and tenancy rules must hold.
**Decision.** "Connect TikTok" (owners/managers, checked under RLS) creates a random state, keeps it with the workspace and client in a 10-minute httpOnly, SameSite=Lax cookie scoped to `/integrations/tiktok`, and sends the user to TikTok's authorization page. The callback (`/integrations/tiktok/callback`, a route handler) requires the returned state to equal the cookie's (constant-time compare), re-checks the user's role, exchanges the auth code server-side, lists the advertisers the token can use (rejecting advertiser IDs that arrive as imprecise JSON numbers), and calls `connectAdAccounts()`. That stores the token in **Supabase Vault** (`VaultSecretStore`: `vault.create_secret` / `vault.decrypted_secrets`, via the server's database role; ref `vault:glio/tiktok/<uuid>`), attaches each account to the client (`status = active`), never moves an account already attached to another client in the workspace, audits every connection (`ad_account.connected`), stores nothing if nothing can connect, and deletes a replaced token once nothing references it. "Sync TikTok data" runs the existing sync and reconciliation for the client's connected accounts. No migration was needed.
**Consequence.** Tokens are encrypted at rest by Supabase and readable only with the server's database credentials (DATABASE_URL), which therefore protect both data and tokens. Vault lives in the same Frankfurt project (data residency question unchanged, see COMPLIANCE.md). Tests use a plain-table stand-in for the Vault interface (no encryption), so Vault itself must be checked in the real project (RUNBOOK). The TikTok endpoints remain `TODO(verify)` until the first real connection.

## ADR-017 Emailed reports: snapshot first, one email per recipient, logged, sent once

**Context.** Clients should receive their report by email on a schedule, in Arabic first, without anyone being able to claim the email said something the dashboard didn't.
**Decision.** Per-client `report_schedules` (off / weekly on a chosen ISO weekday covering the previous 7 days / monthly on the 1st covering the previous month; language; up to 20 recipients, validated in the app and by a database check). A delivery first creates a normal report snapshot (permanent, same figures and validated commentary as the dashboard), then renders the email ONLY from it (`renderReportEmail`: no number is computed there; everything HTML-escaped; Arabic right-to-left with isolated numbers) and sends one email per recipient (recipients never see each other) through Resend's HTTP API (no SDK; `Idempotency-Key` per snapshot and recipient). Every attempt goes to the permanent `report_deliveries` log (server-only writes); a unique index makes a scheduled report "sent" at most once per client, period and recipient. A daily Vercel Cron (`/api/cron/reports`, 05:00 UTC = 08:00 Riyadh, protected by `CRON_SECRET`) refreshes the client's TikTok data, then sends what is due; missed or failed sends are retried for two more days. A failed refresh sends nothing and is logged. Owners and managers edit schedules (RLS) and can "send now" for the chosen period.
**Consequence.** What a client received can be shown exactly (snapshot + delivery row). Recipient addresses are personal data held per client (see COMPLIANCE.md). The email's "open in GLIO" link only works for people with a GLIO account; expiring share links for external recipients are not built yet. Vercel Hobby runs crons once a day and a function for at most 60 s, which bounds how many clients one run can serve.


## ADR-018 App redesign: navy sidebar, live dashboard computed like reports

**Context.** The product pages were plain prototypes; the owner wanted a finished look matching the website. Chosen direction: navy sidebar + light content area.
**Decision.** Route groups: `(app)` gets a navy sidebar (workspaces and their clients, read under RLS; language; sign out) and a light content area; sign-in moved to `(auth)` with a brand panel. The client dashboard has date presets (7/14/30/90 days, this month, last month, ending yesterday in Asia/Riyadh) and a custom range in one row; KPI tiles with the exact change vs the previous period of equal length (bigint rationals, rounded only for display; "good/bad" per metric, always shown with an arrow and text, never colour alone; spend is neutral); a single-series daily chart (SVG, no chart library, GLIO blue validated for contrast, hover crosshair + tooltip with the exact value, keyboard arrows, days without stored data drawn as gaps not zeros, a table view); and a campaigns table with share of spend. These live numbers are computed from `metric_daily` with the SAME `loadChannelTotals` + `buildReport` code as reports, after the RLS check, so a dashboard and a report for the same period agree. Report snapshots remain the permanent record (print/PDF from the browser).
**Consequence.** No new dependencies. The dashboard reads with the server connection after `clientAccess()`; any new section must keep that order. A design preview (local only, not committed) renders the same components against a synthetic local database for visual review.

## ADR-019 Approvals: one executor, guardrails, before/after state, undo

**Context.** Firm rule 3: no platform write without approval, through one executor that enforces budget caps, saves the before-state and supports undo.
**Decision.** Owners, managers and analysts propose campaign changes (pause, turn on, daily budget) as `approval_requests` rows under RLS (pending, as themselves, no execution fields). Users can no longer update requests: owners/managers decide only through `decide_approval()` (SECURITY DEFINER: role, visibility, status and expiry checked; audited). "Approve and apply" then calls `executeApproval()`, the ONLY code that writes to a platform: it claims the request (approved -> executing under a row lock, so it can't run twice), reads the campaign's current state from the platform, enforces `client_guardrails` (maximum daily budget; maximum increase per change, default 50%), writes, reads the after-state, stores both, and audits success or failure. Undo (owners/managers, 30 days) creates a new approved request restoring the stored before-state (the increase cap does not apply to a restore; the maximum budget does), locked against double clicks, and marks the original `undone`. The demo account uses a writer that sends nothing and carries state from the last executed change. TikTok campaign endpoints are `TODO(verify)` like the reporting ones.
**Consequence.** Every platform change has a who/why/when/before/after record and an undo path. AI agents and rules will create requests through the same table (`requested_by_agent`); nothing they propose runs without a human decision. Execution happens in the request that approves it (no queue yet); a long platform outage leaves the request `failed` with its error, to be proposed again.

## ADR-020 GLIO suggestions: deterministic rules that only propose

**Context.** The "AI agents" promise: GLIO should notice what needs doing and prepare it, while firm rule 3 (no action without approval) and rule 2 (numbers are never invented) hold.
**Decision.** Rules v1 (`suggestForClient`, agent `glio-rules/v1`) read the last 7 complete days of stored campaign metrics and insert `approval_requests` with `requested_by_agent`, never executing. Three rules: pause on spend with zero conversions; cut the daily budget 20% on high cost per conversion vs the client's; raise it 20% (capped by the client's safety limits, and marked when limited) on low cost per conversion. Comparisons are exact integer cross-multiplications; campaigns with any day missing spend or conversions are not judged. The current state (running? daily budget?) is read from the platform through the same `campaignAccess()` the executor uses. Every number goes into `payload.evidence`; the reason is rendered from it in Arabic or English (an English copy is kept in `reason`). No repeat while a request is open, or for 7 days after a decision; 72-hour expiry; every suggestion audited (`approval.suggested`, actor `agent`). Runs daily inside the single daily cron (Vercel Hobby limits cron jobs; renamed `/api/cron/reports` -> `/api/cron/daily`: refresh, suggest, report) and on demand from the Approvals page. Demo data gained campaigns C/D/E to exercise the rules.
**Consequence.** Suggestions are explainable and checkable; an LLM may later phrase or prioritise them but never supply their numbers. The thresholds are global defaults for now (per-client settings later). Everything runs in one 60-second function on the Hobby plan, which bounds how many clients one run can serve.

