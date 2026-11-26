# Backlog

Builds agreed or proposed but not started. Newest decisions first within each section.
When an item is built, move its outcome to `DECISIONS.md` (ADR) and `RUNBOOK.md`, and delete it here.

## Next

### Break-even ROAS on the dashboard

- Show a break-even line or marker on the ROAS tile and in the campaign table.
- Break-even ROAS = 1 ÷ gross margin.
- **Needs from the owner:** each client's approximate gross margin (a client setting, owners and managers edit).

## Later

- **Report and figure views in the audit log.** Only client dashboards write `client.viewed` today (COMPLIANCE.md:
  "Partial").
- **Disconnect TikTok from inside GLIO**, including token revocation at TikTok (`/oauth2/revoke_token/`).
  - Deleting a client removes GLIO's data and the Vault token.
  - TikTok-side revocation is still manual.
- **Workspace and user-account deletion.** Currently on request by email (COMPLIANCE.md).
- **Other purchase values:**
  - in-app: `total_purchase_value`
  - TikTok Shop: `total_onsite_shopping_value`
  - Only website purchases are fetched now (ADR-031).
- **TikTok Reporting API v2.0.** v1.3 has no announced end date. When it gets one, move the report calls behind the
  same connector interface (ADR-028).
- **More channels:** Snapchat, Meta, Google Ads. The connector interface is ready; each needs its own platform app
  review.
