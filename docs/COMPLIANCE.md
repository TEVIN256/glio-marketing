# Compliance posture

What is implemented, and what is not yet. Keep this honest: "planned" means not built.

## PDPL (Saudi Personal Data Protection Law)

| Item | Status |
|---|---|
| Role: business/agency = controller, Glio = processor | **Assumed; needs a legal opinion** |
| Hosting region | Development project being moved from Tokyo to a European region (closer to KSA). **No region is in Saudi Arabia**: acceptable for synthetic test data only; a residency decision under PDPL is required before real customer data. Must move to a paid plan before real customer data |
| Tenant isolation enforced by the database (RLS on every table) | Implemented (migration 0001), tested |
| Platform credentials kept server-only | Implemented (migration 0001), tested |
| Append-only audit log | Implemented (migration 0001), tested |
| Audit entry for every read of client data | Planned |
| Data retention policy | Planned |
| Client data deletion endpoint | Planned. Deleting a workspace cascades to its data; audit entries are retained by design |
| Consent records for WhatsApp marketing messages | Planned (with WhatsApp) |

## ZATCA (e-invoicing)

| Item | Status |
|---|---|
| Glio's own subscription invoices | Planned via a ZATCA-certified provider; no payment flow built |
| Agency client invoices | Glio will only track and remind; invoices stay in the agency's accounting tool |

## Money

- Glio never holds ad spend; the platform charges the business's own card.
- Amounts will be stored in minor units (halalas); default currency SAR.

## Localisation and accessibility

| Item | Status |
|---|---|
| Arabic-first, right-to-left UI | Planned (UI not built yet). Workspace default locale is `ar` |
| Asia/Riyadh default timezone, Hijri display option | Timezone default implemented; Hijri planned |
| WCAG AA, keyboard navigation, Arabic screen-reader labels | Planned |
