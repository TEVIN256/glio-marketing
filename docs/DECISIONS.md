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
