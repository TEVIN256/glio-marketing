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
| Platform tokens never stored in the database, logs or error messages | Implemented in sync and connector, tested. **Production secret store not chosen yet** |
| Audit entry for every read of client data | Planned |
| Data retention policy | Planned |
| Client data deletion endpoint | Planned. Deleting an ad account or workspace cascades to its synced data (sync runs, raw payloads, metrics; tested); audit entries are retained by design |
| Consent records for WhatsApp marketing messages | Planned (with WhatsApp) |

## ZATCA (e-invoicing)

| Item | Status |
|---|---|
| Glio's own subscription invoices | Planned via a ZATCA-certified provider; no payment flow built |
| Agency client invoices | Glio will only track and remind; invoices stay in the agency's accounting tool |

## Money

- Glio never holds ad spend; the platform charges the business's own card.
- Amounts are stored in minor units (halalas for SAR) as integers; conversion from platform decimals is exact and a value that would need rounding is rejected (tested). Each ad account keeps its own currency; no currency conversion.

## Localisation and accessibility

| Item | Status |
|---|---|
| Arabic-first, right-to-left UI | Planned (UI not built yet). Workspace default locale is `ar` |
| Asia/Riyadh default timezone, Hijri display option | Timezone default implemented; Hijri planned |
| WCAG AA, keyboard navigation, Arabic screen-reader labels | Planned |
