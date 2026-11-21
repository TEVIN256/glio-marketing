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

