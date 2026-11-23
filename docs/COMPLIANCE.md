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
| Advertiser consent for ad account access | Each advertiser authorises their own accounts on TikTok's OAuth page; connections are audited (`ad_account.connected`). Disconnect / token revocation from inside GLIO: **planned** |
| Audit entry for every read of client data | Partial: viewing a client dashboard writes `client.viewed`; report and figure pages not yet |
| Public privacy policy and terms (glioagency.org/privacy, /terms), Arabic and English | Published text written to match what is built (data collected, TikTok data use, AI, providers, rights). **Not legally reviewed.** The legal entity name is not shown (owner's choice: brand "Glio", CR number shown, email contact); a lawyer should confirm whether PDPL requires naming the controller. Must be updated whenever providers, data or retention change |
| Report email recipients (people's email addresses, per client) | Stored in `report_schedules` (RLS: the client's team reads, owners/managers edit); every email logged in `report_deliveries` (no email body stored, only the snapshot id). Emails say why the person receives them and how to stop. A one-click unsubscribe link is **planned** |
| Automated suggestions | Deterministic rules propose changes with the evidence attached; they never execute; audited as agent actions |
| Changes to ad campaigns | Only after an owner/manager approves (database-enforced decision function), executed by one audited executor with per-client safety limits, before/after state stored, undo for 30 days |
| Data retention policy | Planned (the published policy says "while the account is active or as required by law") |
| Client data deletion endpoint | Planned. Deleting an ad account or workspace cascades to its synced data (sync runs, raw payloads, metrics; tested); audit entries are retained by design |
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
