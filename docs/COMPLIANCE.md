# Compliance posture

What is implemented, and what is not yet. Keep this honest: "planned" means not built.

## PDPL (Saudi Personal Data Protection Law)

| Item | Status |
|---|---|
| Role: business/agency = controller, Glio = processor | **Assumed; needs a legal opinion** |
| Hosting region | Development project in **Frankfurt (`eu-central-1`)**, free plan. **Not in Saudi Arabia**: acceptable for synthetic test data only; a residency decision under PDPL (and a paid plan) is required before real customer data |
| Tenant isolation enforced by the database (RLS on every table) | Implemented (migration 0001), tested |
| Platform credentials kept server-only | Implemented (migration 0001), tested |
| Append-only audit log | Implemented (migration 0001), tested |
| Raw platform responses stored unchanged as evidence for every number | Implemented (migration 0003), immutable, tested |
| Reconciliation of stored totals against platform totals, drift > 0.5% flagged and logged | Implemented (migration 0004), checks append-only, tested on synthetic data |
| Proof of what a client was shown (report snapshots + commentary, permanent) | Implemented (migration 0005), tested |
| AI commentary data sent outside KSA | **Aggregated figures and the reporting period only** go to the Claude API (no client or account names, no raw payloads, no credentials). Whether this is acceptable under PDPL is part of the pending legal opinion. Without an API key configured, no data is sent and the template is used |
| Platform tokens never stored in application tables, logs or error messages | Implemented and tested. Tokens are stored encrypted in **Supabase Vault** (same Frankfurt project), referenced by `secret_ref`; replaced tokens are deleted (ADR-016) |
| Advertiser consent for ad account access | Each advertiser authorises their own accounts on TikTok's OAuth page; when several accounts are authorised, the owner/manager chooses which ones to attach (others are never stored; their token is deleted if unused); connections are audited (`ad_account.connected`). Owners/managers disconnect an account from inside GLIO, which revokes the token at TikTok when no other connected account shares it (ADR-034) |
| Audit entry for every read of client data | Implemented (ADR-036): client dashboard `client.viewed`, report page `report.viewed`, figure source page `figure.viewed`, share-link opens `report.share_viewed` (which link and when; no IP or device). Owners/managers read it on the Activity page; the log is append-only |
| Public privacy policy and terms (glioagency.org/privacy, /terms), Arabic and English | Published text written to match what is built (data collected, TikTok data use, AI, providers, rights). **Not legally reviewed.** Since 2026-11-24 the legal entity is named next to the brand (footer, about, privacy and terms intros) with the CR number, so platform reviews (TikTok rejected a profile whose company name didn't match the site) and readers can identify the controller; contact is email only. Must be updated whenever providers, data or retention change |
| Report email recipients (people's email addresses, per client) | Stored in `report_schedules` (RLS: the client's team reads, owners/managers edit); every email logged in `report_deliveries` (no email body stored, only the snapshot id). Emails say why the person receives them. Each email has its own unsubscribe link and a one-click `List-Unsubscribe` header (RFC 8058); unsubscribes are honoured on every send, listed to the team, audited, and only the person can undo them |
| Team access | Owners invite by email; invite links store only a hash, expire in 7 days and only work for the invited (confirmed) email; joins, role changes and removals audited |
| Approval notification emails | Only to owners/managers of the workspace, one email per person, opt-out per workspace on the Approvals page; content limited to the pending changes and their reasons |
| Report share links (reports readable without an account) | Read-only, one snapshot per link, expire (max 366 days, default 30), revocable by owners/managers; only a hash of the secret is stored; pages are `noindex` and send no referrer; creation and revocation audited; views counted without IP or device |
| Automated suggestions | Deterministic rules propose changes with the evidence attached; they never execute; audited as agent actions |
| Changes to ad campaigns | Only after an owner/manager approves (database-enforced decision function), executed by one audited executor with per-client safety limits, before/after state stored, undo for 30 days |
| Data retention policy | Implemented (migration 0013, ADR-029) and published in the privacy policy: client data kept while the client exists; invitations deleted 90 days after closing; report delivery log (recipient emails) deleted after 24 months; unsubscribes kept while the client exists; the daily job runs the purge. The audit log is never deleted (append-only); its retention period still needs a legal opinion. Provider backups may hold deleted data for a limited time |
| Client data deletion | Implemented (ADR-029): owners delete a client from its page (typed name to confirm); every row with the client's id is removed in one transaction (tested over all tables), its platform tokens are deleted from Vault, and the audit log records the deletion (name and counts only). Owners delete a whole workspace (Team page, typed name) and every user deletes their own account (Your account page, typed email; blocked while sole owner of a workspace); tokens are revoked at TikTok and deleted from Vault; history keeps only the former member's bare id (ADR-037) |
| Consent records for WhatsApp marketing messages | Planned (with WhatsApp) |

## ZATCA (e-invoicing)

| Item | Status |
|---|---|
| Glio's own subscription invoices | Planned via a ZATCA-certified provider; no payment flow built |
| Agency client invoices | Glio will only track and remind; invoices stay in the agency's accounting tool |

## Authentication

| Item | Status |
|---|---|
| Email + password sign-up with email confirmation | Implemented (Supabase Auth) |
| Two-factor authentication for owners | Planned |
| Session cookies refreshed server-side; signed-out users redirected | Implemented |

## Money

- Glio never holds ad spend; the platform charges the business's own card.
- Amounts are stored in minor units (halalas for SAR) as integers; conversion from platform decimals is exact and a value that would need rounding is rejected (tested). Each ad account keeps its own currency; no currency conversion.

## Localisation and accessibility

| Item | Status |
|---|---|
| Arabic-first, right-to-left UI | Implemented for login, workspaces, clients, dashboard, reports and figure detail (server-rendered RTL, logical CSS, isolated numbers) |
| Asia/Riyadh default timezone, Hijri display option | Timezone default implemented; Hijri planned |
| WCAG AA, keyboard navigation, Arabic screen-reader labels | Partial: AA colour contrast, visible focus outlines, labelled form fields and figure links; no formal audit yet |
