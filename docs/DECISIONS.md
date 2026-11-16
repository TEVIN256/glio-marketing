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
